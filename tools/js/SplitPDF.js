/* =====================================================================
 * SplitPDF.js — PDFTools split module
 * Memory-efficient client-side PDF splitting + app-like workspace UI.
 * Theme: violet brand mark in the workspace header (matches SplitPDF.html);
 *        blue action elements (Split button, downloads, totals).
 * Modes:
 *   • Extract pages: one PDF per comma-separated entry, plus Merge & download.
 *   • Split every N: single PDF, or ZIP when multiple parts.
 * Depends on (auto-loaded if missing):
 *   - pdf-lib  (PDF manipulation)
 *   - JSZip    (ZIP bundling)
 *   - lucide   (icons, expected on host page)
 * ===================================================================== */
(function () {
  'use strict';

  const PDFLIB_CDN = 'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js';
  const JSZIP_CDN  = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
  const STYLE_ID   = 'split-pdf-styles';

  // Violet brand mark (matches SplitPDF.html header/footer accents)
  const BRAND = '#8B5CF6';

  const state = {
    file: null,
    mode: 'extract',
    rangeInput: '',
    everyN: 1,
    isProcessing: false,
    root: null,
    onBack: null,
    cleanup: [],
    statusTimer: null,
    splitResult: null,
  };

  /* ------------------------------ utils ------------------------------ */
  const uid = () => Math.random().toString(36).slice(2, 10);

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (bytes >= 1024 && i < u.length - 1) { bytes /= 1024; i++; }
    return bytes.toFixed(bytes < 10 && i > 0 ? 1 : 0) + ' ' + u[i];
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
    ));
  }

  function sanitizeFilename(name) {
    return String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim();
  }

  function refreshIcons() {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });
  }

  async function ensureLibs() {
    if (!window.PDFLib) await loadScript(PDFLIB_CDN);
    if (!window.JSZip)  await loadScript(JSZIP_CDN);
  }

  function releaseSplitResult() {
    const r = state.splitResult;
    if (!r) return;

    if (r.url) { try { URL.revokeObjectURL(r.url); } catch (e) {} }

    if (Array.isArray(r.files)) {
      for (let i = 0; i < r.files.length; i++) {
        const f = r.files[i];
        if (!f) continue;
        if (f.url) { try { URL.revokeObjectURL(f.url); } catch (e) {} }
        f.bytes = null;
      }
    }

    state.splitResult = null;
  }

  function releaseSourceFile() {
    if (state.file) state.file.file = null;
  }

  /* ---------------------------- file logic --------------------------- */
  async function readPdfInfo(file) {
    let buf = null;
    let doc = null;
    try {
      buf = await file.arrayBuffer();
      doc = await window.PDFLib.PDFDocument.load(buf, { ignoreEncryption: true });
      return { pageCount: doc.getPageCount(), error: null };
    } catch (err) {
      return { pageCount: null, error: 'Unreadable or encrypted' };
    } finally {
      doc = null;
      buf = null;
    }
  }

  async function addFile(fileList) {
    const f = Array.from(fileList || []).find(x =>
      x.type === 'application/pdf' || /\.pdf$/i.test(x.name)
    );
    if (!f) {
      if (fileList && fileList.length) showToast('Only PDF files are supported.', 'error');
      return;
    }

    releaseSplitResult();
    releaseSourceFile();

    state.file = {
      file: f, name: f.name, size: f.size,
      pageCount: null, loading: true, error: null,
    };
    state.rangeInput = '';
    state.everyN = 1;

    renderUploadedFile();
    updatePreview();
    updateBottomBar();

    const info = await readPdfInfo(f);
    if (!state.file) return;

    state.file.pageCount = info.pageCount;
    state.file.error = info.error;
    state.file.loading = false;

    renderUploadedFile();
    updatePreview();
    updateBottomBar();
  }

  function removeFile() {
    releaseSplitResult();
    releaseSourceFile();
    state.file = null;
    state.rangeInput = '';
    state.everyN = 1;
    renderUploadedFile();
    updatePreview();
    updateBottomBar();
  }

  /* --------------------------- range parser -------------------------- */
  function parseRanges(input, maxPage) {
    const raw = String(input || '').trim();
    if (!raw) return { chunks: [], error: null, empty: true };

    const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (!parts.length) return { chunks: [], error: null, empty: true };

    const chunks = [];
    for (const part of parts) {
      if (/^\d+$/.test(part)) {
        const p = parseInt(part, 10);
        if (p < 1 || p > maxPage) return { error: `Page ${p} is out of range (1–${maxPage})` };
        chunks.push({ pages: [p], label: String(p) });
      } else {
        const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
        if (!m) return { error: `Invalid entry: "${part}"` };
        const a = parseInt(m[1], 10);
        const b = parseInt(m[2], 10);
        if (a < 1 || b > maxPage) return { error: `Range ${part} is out of bounds (1–${maxPage})` };
        if (a > b) return { error: `Range ${part}: start must be ≤ end` };
        const pages = [];
        for (let i = a; i <= b; i++) pages.push(i);
        chunks.push({ pages, label: part.replace(/\s+/g, '') });
      }
    }

    return { chunks, error: null, empty: false };
  }

  function totalPagesInChunks(chunks) {
    return chunks.reduce((sum, c) => sum + c.pages.length, 0);
  }

  /* ------------------------------ split ------------------------------ */
  async function performSplit() {
    if (state.isProcessing || !state.file || state.file.error) return;

    state.isProcessing = true;
    updateBottomBar();
    showToast('Processing…', 'info', 0);

    let buf = null;
    let src = null;

    try {
      buf = await state.file.file.arrayBuffer();
      src = await window.PDFLib.PDFDocument.load(buf, { ignoreEncryption: true });
      buf = null;

      const total = src.getPageCount();
      const baseName = (state.file.name || 'file').replace(/\.pdf$/i, '');

      if (state.mode === 'extract') {
        const parsed = parseRanges(state.rangeInput, total);
        if (parsed.error || !parsed.chunks.length) {
          throw new Error(parsed.error || 'Enter pages to extract');
        }

        const files = [];
        let totalSize = 0;
        let totalPgs = 0;

        for (let i = 0; i < parsed.chunks.length; i++) {
          const chunk = parsed.chunks[i];

          let out = await window.PDFLib.PDFDocument.create();
          const idx = chunk.pages.map(p => p - 1);
          const copied = await out.copyPages(src, idx);
          copied.forEach(p => out.addPage(p));
          const bytes = await out.save();
          out = null;

          files.push({
            id: uid(),
            fileName: `${baseName}-${chunk.label}`,
            bytes,
            url: null,
            pages: chunk.pages,
            pageCount: chunk.pages.length,
            size: bytes.byteLength,
          });

          totalSize += bytes.byteLength;
          totalPgs += chunk.pages.length;

          await new Promise(r => setTimeout(r, 0));
        }

        releaseSplitResult();
        state.splitResult = {
          kind: 'multi',
          files,
          totalPages: totalPgs,
          totalSize,
          sourceName: baseName,
        };

        src = null;
        state.isProcessing = false;
        showToast(null);
        showSuccess();
        return;
      }

      const n = Math.max(1, Math.min(total, parseInt(state.everyN, 10) || 1));
      const totalChunks = Math.ceil(total / n);

      if (totalChunks === 1) {
        let out = await window.PDFLib.PDFDocument.create();
        const idx = [];
        for (let i = 0; i < total; i++) idx.push(i);
        const copied = await out.copyPages(src, idx);
        copied.forEach(p => out.addPage(p));
        const bytes = await out.save();
        out = null;

        src = null;

        const blob = new Blob([bytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);

        releaseSplitResult();
        state.splitResult = {
          kind: 'pdf',
          blob, url,
          fileName: `${baseName}-split.pdf`,
          fileCount: 1,
          totalPages: total,
          totalSize: bytes.byteLength,
        };
      } else {
        const zip = new window.JSZip();
        let chunkIndex = 0;

        for (let start = 0; start < total; start += n) {
          const end = Math.min(start + n, total);
          let out = await window.PDFLib.PDFDocument.create();
          const idx = [];
          for (let i = start; i < end; i++) idx.push(i);
          const copied = await out.copyPages(src, idx);
          copied.forEach(p => out.addPage(p));
          const bytes = await out.save();
          out = null;

          const fileName = `${baseName}-part-${String(chunkIndex + 1).padStart(2, '0')}.pdf`;
          zip.file(fileName, bytes);
          chunkIndex++;

          await new Promise(r => setTimeout(r, 0));
        }

        src = null;

        const blob = await zip.generateAsync({
          type: 'blob',
          compression: 'STORE',
        });
        const url = URL.createObjectURL(blob);

        releaseSplitResult();
        state.splitResult = {
          kind: 'zip',
          blob, url,
          fileName: `${baseName}-split.zip`,
          fileCount: totalChunks,
          totalPages: total,
          totalSize: blob.size,
        };
      }

      state.isProcessing = false;
      showToast(null);
      showSuccess();
    } catch (err) {
      console.error('[SplitPDF]', err);
      buf = null;
      src = null;
      state.isProcessing = false;
      showToast(err.message || 'Split failed', 'error');
      updateBottomBar();
    }
  }

  /* --------------------------- success view -------------------------- */
  function showSuccess() {
    const root = state.root;
    if (!root || !state.splitResult) return;

    const workWs    = root.querySelector('[data-work-workspace]');
    const successWs = root.querySelector('[data-success-workspace]');
    const bottomBar = root.querySelector('[data-bottom-bar]');

    if (workWs)    workWs.classList.add('hidden');
    if (bottomBar) bottomBar.classList.add('hidden');

    if (successWs) {
      successWs.classList.remove('hidden');
      successWs.innerHTML = successHtml();
    }

    refreshIcons();
    window.scrollTo(0, 0);
  }

  function successHtml() {
    const r = state.splitResult;
    if (r.kind === 'multi') return multiSuccessHtml(r);
    return singleSuccessHtml(r);
  }

  function multiSuccessHtml(r) {
    const fileRowsHtml = r.files.map((file, index) => `
      <div class="rounded-xl border border-gray-100 bg-white p-3">
        <div class="flex items-center gap-2">
          <span class="text-[13px] font-bold text-gray-900 w-4 text-center shrink-0">${index + 1}</span>

          <div class="flex min-w-0 flex-1 items-center border-b border-dashed border-gray-300 focus-within:border-blue-500 transition pb-0.5">
            <input type="text" data-filename data-file-id="${file.id}"
                   value="${escapeHtml(file.fileName)}"
                   maxlength="80" spellcheck="false" autocomplete="off"
                   class="min-w-0 flex-1 bg-transparent text-[13px] font-semibold text-gray-900 outline-none" />
            <span class="shrink-0 text-[12px] font-semibold text-gray-500">.pdf</span>
          </div>

          <button type="button" data-download-one="${file.id}" aria-label="Download"
                  class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-blue-50 text-blue-600 transition hover:bg-blue-600 hover:text-white active:scale-95">
            <i data-lucide="download" style="width:14px;height:14px;"></i>
          </button>
        </div>

        <p class="mt-1.5 pl-6 text-[11px] text-gray-900">
          ${file.pageCount} page${file.pageCount !== 1 ? 's' : ''} · ${formatBytes(file.size)}
        </p>
      </div>
    `).join('');

    return `
      <div class="w-full flex items-center gap-3 mb-6">
        <div class="w-10 h-10 bg-green-500 rounded-xl flex items-center justify-center shrink-0 shadow-sm">
          <i data-lucide="check" class="text-white" style="width:22px;height:22px;" stroke-width="3"></i>
        </div>
        <h2 class="text-xl font-extrabold text-gray-900 tracking-tight">Pages Extracted 🎉</h2>
      </div>

      <p class="text-[13px] text-gray-900 mb-6">
        ${r.totalPages} page${r.totalPages !== 1 ? 's' : ''} across ${r.files.length} file${r.files.length !== 1 ? 's' : ''}
      </p>

      <div class="w-full mb-6">
        <div class="mb-2 flex items-center justify-between">
          <label class="text-[12px] font-bold uppercase tracking-wider text-gray-900">Files</label>
          <span class="text-[11px] text-gray-700">Tap a name to rename</span>
        </div>
        <div class="space-y-2">${fileRowsHtml}</div>
      </div>

      <div class="w-full flex flex-col gap-2.5">
        <button type="button" data-merge-download
                class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2 transition active:scale-[0.98] text-[14px] shadow-sm">
          <i data-lucide="files" style="width:18px;height:18px;"></i>
          Merge &amp; download as PDF
        </button>
      </div>

      <button type="button" data-start-over
              class="w-full mt-3 bg-white border border-gray-300 hover:border-gray-400 text-gray-700 font-bold py-3 rounded-xl flex items-center justify-center gap-2 transition active:scale-[0.98] text-[14px]">
        <i data-lucide="refresh-cw" style="width:16px;height:16px;"></i>
        Start Over
      </button>
    `;
  }

  function singleSuccessHtml(r) {
    const isZip = r.kind === 'zip';
    const ext   = isZip ? 'zip' : 'pdf';
    const baseName = r.fileName.replace(/\.(pdf|zip)$/i, '');

    const cards = [];
    if (isZip) {
      cards.push({ label: 'Files', value: r.fileCount });
      cards.push({ label: 'Pages', value: r.totalPages });
    } else {
      cards.push({ label: 'Pages', value: r.totalPages });
    }
    cards.push({ label: 'Size', value: formatBytes(r.totalSize) });

    const gridCols = cards.length === 3 ? 'grid-cols-3' : 'grid-cols-2';

    const cardsHtml = cards.map(c => `
      <div class="bg-gray-50 rounded-xl p-3.5 border border-gray-100 text-center">
        <p class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">${c.label}</p>
        <p class="text-[16px] font-extrabold text-gray-900 mt-1">${c.value}</p>
      </div>
    `).join('');

    return `
      <div class="w-full flex items-center gap-3 mb-6">
        <div class="w-10 h-10 bg-green-500 rounded-xl flex items-center justify-center shrink-0 shadow-sm">
          <i data-lucide="check" class="text-white" style="width:22px;height:22px;" stroke-width="3"></i>
        </div>
        <h2 class="text-xl font-extrabold text-gray-900 tracking-tight">Split Successfully 🎉</h2>
      </div>

      <div class="w-full mb-8">
        <label class="block text-[12px] font-bold uppercase tracking-wider text-gray-900 mb-2">File Name (Editable)</label>
        <div class="flex items-center border-b-2 border-dashed border-gray-300 focus-within:border-blue-500 transition">
          <input type="text" data-filename value="${escapeHtml(baseName)}"
                 class="flex-1 text-[15px] font-semibold text-gray-900 bg-transparent outline-none pb-2"
                 maxlength="80" spellcheck="false" autocomplete="off" />
          <span class="text-[15px] font-semibold text-gray-500 pb-2 select-none">.${ext}</span>
        </div>

        <div class="grid ${gridCols} gap-3 mt-5">${cardsHtml}</div>
      </div>

      <div class="w-full flex flex-col gap-2.5">
        <button type="button" data-download
                class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2 transition active:scale-[0.98] text-[14px] shadow-sm">
          <i data-lucide="download" style="width:18px;height:18px;"></i>
          Download ${isZip ? 'ZIP' : 'PDF'}
        </button>
      </div>

      <button type="button" data-start-over
              class="w-full mt-3 bg-white border border-gray-300 hover:border-gray-400 text-gray-700 font-bold py-3 rounded-xl flex items-center justify-center gap-2 transition active:scale-[0.98] text-[14px]">
        <i data-lucide="refresh-cw" style="width:16px;height:16px;"></i>
        Start Over
      </button>
    `;
  }

  /* ---------------------------- downloads ---------------------------- */
  function handleDownload() {
    if (!state.splitResult || state.splitResult.kind === 'multi') return;

    const input = state.root?.querySelector('[data-filename]:not([data-file-id])');
    let base = sanitizeFilename(input?.value || '');
    if (!base) base = 'split';

    const ext = state.splitResult.kind === 'zip' ? 'zip' : 'pdf';
    const filename = base.replace(/\.(pdf|zip)$/i, '') + '.' + ext;

    const a = document.createElement('a');
    a.href = state.splitResult.url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast('Download started', 'success');
  }

  function handleDownloadOne(fileId) {
    if (!state.splitResult || state.splitResult.kind !== 'multi') return;
    const file = state.splitResult.files.find(f => f.id === fileId);
    if (!file || !file.bytes) return;

    const input = state.root?.querySelector(`[data-filename][data-file-id="${fileId}"]`);
    let base = sanitizeFilename(input?.value || '');
    if (!base) base = file.fileName;
    const filename = base.replace(/\.pdf$/i, '') + '.pdf';

    const blob = new Blob([file.bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 4000);
    showToast('Download started', 'success');
  }

  async function handleMergeDownload() {
    if (state.isProcessing) return;
    if (!state.splitResult || state.splitResult.kind !== 'multi') return;
    if (!state.splitResult.files.length) return;

    state.isProcessing = true;
    const btn = state.root?.querySelector('[data-merge-download]');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i data-lucide="loader-2" style="width:18px;height:18px;" class="animate-spin"></i><span>Merging…</span>';
      refreshIcons();
    }
    showToast('Merging files…', 'info', 0);

    let merged = null;

    try {
      merged = await window.PDFLib.PDFDocument.create();

      const files = state.splitResult.files;
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (!file.bytes) continue;

        let src = await window.PDFLib.PDFDocument.load(file.bytes, { ignoreEncryption: true });
        const copied = await merged.copyPages(src, src.getPageIndices());
        copied.forEach(p => merged.addPage(p));
        src = null;

        await new Promise(r => setTimeout(r, 0));
      }

      let out = await merged.save();
      merged = null;

      const blob = new Blob([out], { type: 'application/pdf' });
      out = null;

      const url = URL.createObjectURL(blob);
      const baseName = state.splitResult.sourceName || 'file';
      const filename = `${baseName}-extracted.pdf`;

      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 4000);

      showToast('Merged PDF downloaded', 'success');
    } catch (err) {
      console.error('[SplitPDF] merge', err);
      merged = null;
      showToast('Merge failed: ' + (err.message || 'Unknown error'), 'error');
    } finally {
      state.isProcessing = false;
      const b = state.root?.querySelector('[data-merge-download]');
      if (b) {
        b.disabled = false;
        b.innerHTML = '<i data-lucide="files" style="width:18px;height:18px;"></i><span>Merge &amp; download as PDF</span>';
        refreshIcons();
      }
    }
  }

  // Start Over: hard reset via full page reload. Prevents returning to a
  // pre-populated split control screen with old inputs.
  function startOver() {
    releaseSplitResult();
    window.location.reload();
  }

  /* ------------------------------ toast ------------------------------ */
  function showToast(message, type, duration) {
    const el = state.root?.querySelector('[data-status]');
    if (!el) return;

    if (state.statusTimer) {
      clearTimeout(state.statusTimer);
      state.statusTimer = null;
    }

    if (!message) { el.innerHTML = ''; return; }

    const config = {
      info:    { border: 'border-gray-200',    bg: 'bg-white', text: 'text-gray-900',    iconColor: 'text-blue-600',    icon: 'loader-2',       spin: true },
      success: { border: 'border-emerald-200', bg: 'bg-white', text: 'text-emerald-700', iconColor: 'text-emerald-500', icon: 'check-circle-2', spin: false },
      error:   { border: 'border-rose-200',    bg: 'bg-white', text: 'text-rose-700',    iconColor: 'text-rose-500',    icon: 'alert-triangle', spin: false },
    };
    const c = config[type] || config.info;

    el.innerHTML = `
      <div class="pointer-events-auto flex max-w-[calc(100vw-2rem)] items-center gap-2.5 rounded-xl border ${c.border} ${c.bg} px-4 py-2.5 text-[13px] font-semibold ${c.text} shadow-lg shadow-gray-900/5"
           style="animation: split-toast-in .22s cubic-bezier(0.4, 0, 0.2, 1);">
        <i data-lucide="${c.icon}" class="h-4 w-4 shrink-0 ${c.iconColor} ${c.spin ? 'animate-spin' : ''}"></i>
        <span class="truncate">${escapeHtml(message)}</span>
      </div>
    `;
    refreshIcons();

    if (duration !== 0 && type !== 'info') {
      state.statusTimer = setTimeout(() => {
        el.innerHTML = '';
        state.statusTimer = null;
      }, duration || 2800);
    }
  }

  /* ------------------------------ render ----------------------------- */
  function renderUploadedFile() {
    const root       = state.root;
    const dropzoneEl = root?.querySelector('[data-dropzone]');
    const fileCardEl = root?.querySelector('[data-file-card]');
    const optionsEl  = root?.querySelector('[data-options]');
    if (!root) return;

    const hasFile = !!state.file;
    if (dropzoneEl) dropzoneEl.classList.toggle('hidden', hasFile);
    if (fileCardEl) fileCardEl.classList.toggle('hidden', !hasFile);
    if (optionsEl)  optionsEl.classList.toggle('hidden', !hasFile);

    if (!hasFile || !fileCardEl) return;

    const f = state.file;
    const meta = f.loading
      ? '<span class="text-gray-900">Reading…</span>'
      : f.error
        ? `<span class="text-rose-500">${escapeHtml(f.error)}</span>`
        : `${f.pageCount} page${f.pageCount !== 1 ? 's' : ''} · ${formatBytes(f.size)}`;

    fileCardEl.innerHTML = `
      <div class="flex items-center gap-3 py-3 px-4 bg-white border border-gray-100 rounded-xl shadow-sm">
        <div class="min-w-0 flex-1">
          <div class="inline-block max-w-full truncate px-2 py-0.5 rounded-md text-[12px] font-bold bg-split-100 text-split-700">${escapeHtml(f.name)}</div>
          <p class="text-[11px] text-gray-900 mt-0.5">${meta}</p>
        </div>
        <button type="button" data-remove-file aria-label="Remove file"
                class="p-1 text-gray-500 hover:text-red-500 transition shrink-0">
          <i data-lucide="trash-2" style="width:16px;height:16px;"></i>
        </button>
      </div>
    `;
    refreshIcons();
  }

  function updateMode() {
    const root = state.root;
    if (!root) return;

    root.querySelectorAll('[data-mode-tab]').forEach(tab => {
      const isActive = tab.getAttribute('data-mode-tab') === state.mode;
      tab.classList.toggle('bg-white', isActive);
      tab.classList.toggle('text-split-700', isActive);
      tab.classList.toggle('shadow-sm', isActive);
      tab.classList.toggle('text-gray-700', !isActive);
    });

    root.querySelectorAll('[data-mode-panel]').forEach(panel => {
      const isActive = panel.getAttribute('data-mode-panel') === state.mode;
      panel.classList.toggle('hidden', !isActive);
    });
  }

  function updatePreview() {
    const root = state.root;
    if (!root) return;
    const previewEl = root.querySelector('[data-preview]');
    if (!previewEl) return;

    const f = state.file;
    if (!f || f.loading || f.error || !f.pageCount) {
      previewEl.innerHTML = '';
      return;
    }

    if (state.mode === 'extract') {
      const parsed = parseRanges(state.rangeInput, f.pageCount);
      if (parsed.empty) {
        previewEl.innerHTML = '';
      } else if (parsed.error) {
        previewEl.innerHTML = `
          <div class="flex items-center gap-1.5 text-[12px] font-medium text-rose-600">
            <i data-lucide="alert-triangle" style="width:14px;height:14px;"></i>
            <span>${escapeHtml(parsed.error)}</span>
          </div>
        `;
      } else {
        const fileCount = parsed.chunks.length;
        const pageTotal = totalPagesInChunks(parsed.chunks);
        const labels = parsed.chunks.map(c => c.label).join(', ');
        previewEl.innerHTML = `
          <div class="flex items-start gap-1.5 text-[12px] font-medium text-split-700">
            <i data-lucide="check-circle-2" class="mt-0.5 shrink-0" style="width:14px;height:14px;"></i>
            <div>
              <p>Will create <strong>${fileCount}</strong> file${fileCount !== 1 ? 's' : ''} · ${pageTotal} page${pageTotal !== 1 ? 's' : ''} total</p>
              <p class="mt-0.5 truncate text-[11px] font-normal text-gray-900">${escapeHtml(labels)}</p>
            </div>
          </div>
        `;
      }
    } else {
      const n = Math.max(1, Math.min(f.pageCount, parseInt(state.everyN, 10) || 1));
      const fileCount = Math.ceil(f.pageCount / n);
      previewEl.innerHTML = `
        <div class="flex items-start gap-1.5 text-[12px] font-medium text-split-700">
          <i data-lucide="check-circle-2" class="mt-0.5 shrink-0" style="width:14px;height:14px;"></i>
          <div>
            <p>Will create <strong>${fileCount}</strong> file${fileCount !== 1 ? 's' : ''} (up to ${n} page${n !== 1 ? 's' : ''} each)</p>
            <p class="mt-0.5 text-[11px] font-normal text-gray-900">${fileCount > 1 ? 'Delivered as a single ZIP archive' : 'Delivered as a single PDF'}</p>
          </div>
        </div>
      `;
    }
    refreshIcons();
  }

  function isReadyToSplit() {
    const f = state.file;
    if (!f || f.loading || f.error || !f.pageCount) return false;
    if (state.mode === 'extract') {
      const parsed = parseRanges(state.rangeInput, f.pageCount);
      return !parsed.error && parsed.chunks.length > 0;
    }
    const n = parseInt(state.everyN, 10);
    return Number.isFinite(n) && n >= 1 && n <= f.pageCount;
  }

  function updateBottomBar() {
    const root    = state.root;
    const btn     = root?.querySelector('[data-split]');
    const filesEl = root?.querySelector('[data-total-files]');
    const pagesEl = root?.querySelector('[data-total-pages]');
    if (!btn) return;

    const f = state.file;
    const ready = isReadyToSplit() && !state.isProcessing;

    btn.disabled = !ready;

    if (state.isProcessing) {
      btn.innerHTML = '<i data-lucide="loader-2" style="width:20px;height:20px;" class="animate-spin"></i><span>Processing…</span>';
    } else if (state.mode === 'extract') {
      const parsed = f && f.pageCount ? parseRanges(state.rangeInput, f.pageCount) : { chunks: [] };
      const count = parsed.chunks?.length || 0;
      btn.innerHTML = count > 0
        ? `Extract ${count} <i data-lucide="arrow-right" style="width:20px;height:20px;"></i>`
        : `Extract <i data-lucide="arrow-right" style="width:20px;height:20px;"></i>`;
    } else {
      const n = parseInt(state.everyN, 10) || 1;
      const fileCount = f && f.pageCount ? Math.ceil(f.pageCount / Math.min(n, f.pageCount)) : 0;
      btn.innerHTML = fileCount > 1
        ? `Split into ${fileCount} <i data-lucide="arrow-right" style="width:20px;height:20px;"></i>`
        : `Split <i data-lucide="arrow-right" style="width:20px;height:20px;"></i>`;
    }

    if (filesEl && pagesEl) {
      if (!f || !f.pageCount) {
        filesEl.textContent = '0';
        pagesEl.textContent = '0';
      } else if (state.mode === 'extract') {
        const parsed = parseRanges(state.rangeInput, f.pageCount);
        const count = (!parsed.error && parsed.chunks.length) ? parsed.chunks.length : 0;
        const pgs = (!parsed.error && parsed.chunks.length) ? totalPagesInChunks(parsed.chunks) : 0;
        filesEl.textContent = count;
        pagesEl.textContent = pgs;
      } else {
        const n = Math.max(1, Math.min(f.pageCount, parseInt(state.everyN, 10) || 1));
        const fileCount = Math.ceil(f.pageCount / n);
        filesEl.textContent = fileCount;
        pagesEl.textContent = f.pageCount;
      }
    }

    refreshIcons();
  }

  /* ------------------------------ styles ----------------------------- */
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '@keyframes split-toast-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }',
      '[data-dropzone].is-dragover { background-color: #6D28D9 !important; }',
      '[data-dropzone].is-dragover .dz-inner { border-color: rgba(255, 255, 255, 0.9); }',
      '[data-every-input]::-webkit-outer-spin-button, [data-every-input]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }',
      '[data-every-input] { -moz-appearance: textfield; }',
    ].join('\n');
    document.head.appendChild(style);
  }

  /* ----------------------------- events ------------------------------ */
  function handleClick(e) {
    const t = e.target;

    if (t.closest('[data-back]')) {
      if (typeof state.onBack === 'function') state.onBack();
      return;
    }
    if (t.closest('#chooseBtn')) { state.root.querySelector('[data-file-input]')?.click(); return; }
    if (t.closest('[data-dropzone]'))    { state.root.querySelector('[data-file-input]')?.click(); return; }
    if (t.closest('[data-remove-file]')) { removeFile(); return; }
    if (t.closest('[data-split]'))       { performSplit(); return; }
    if (t.closest('[data-start-over]'))  { startOver(); return; }
    if (t.closest('[data-merge-download]')) { handleMergeDownload(); return; }

    const dl1 = t.closest('[data-download-one]');
    if (dl1) { handleDownloadOne(dl1.getAttribute('data-download-one')); return; }

    if (t.closest('[data-download]')) { handleDownload(); return; }

    const tab = t.closest('[data-mode-tab]');
    if (tab) {
      const mode = tab.getAttribute('data-mode-tab');
      if (mode !== state.mode) {
        state.mode = mode;
        updateMode();
        updatePreview();
        updateBottomBar();
      }
      return;
    }

    const stepUp = t.closest('[data-step-up]');
    if (stepUp) {
      const input = state.root.querySelector('[data-every-input]');
      if (input) {
        const max = state.file?.pageCount || 999;
        const next = Math.min(max, (parseInt(input.value, 10) || 0) + 1);
        input.value = String(next);
        state.everyN = next;
        updatePreview();
        updateBottomBar();
      }
      return;
    }
    const stepDown = t.closest('[data-step-down]');
    if (stepDown) {
      const input = state.root.querySelector('[data-every-input]');
      if (input) {
        const next = Math.max(1, (parseInt(input.value, 10) || 1) - 1);
        input.value = String(next);
        state.everyN = next;
        updatePreview();
        updateBottomBar();
      }
      return;
    }
  }

  function handleInput(e) {
    if (e.target.matches('[data-file-input]')) {
      if (e.target.files && e.target.files.length) {
        addFile(e.target.files);
        e.target.value = '';
      }
      return;
    }
    if (e.target.matches('[data-range-input]')) {
      state.rangeInput = e.target.value;
      updatePreview();
      updateBottomBar();
      return;
    }
    if (e.target.matches('[data-every-input]')) {
      const max = state.file?.pageCount || 999;
      let v = parseInt(e.target.value, 10);
      if (!Number.isFinite(v)) v = 1;
      v = Math.max(1, Math.min(max, v));
      state.everyN = v;
      updatePreview();
      updateBottomBar();
      return;
    }
  }

  function handleFocusIn(e) {
    if (e.target.matches('[data-filename]')) {
      try { e.target.select(); } catch (err) {}
    }
  }

  function handleKeyDown(e) {
    if (e.target.matches('[data-filename]') && e.key === 'Enter') {
      e.preventDefault();
      const fileId = e.target.getAttribute('data-file-id');
      if (fileId) handleDownloadOne(fileId);
      else handleDownload();
    }
  }

  function setupDropZone(dz) {
    const onOver = (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.add('is-dragover'); };
    const onLeave = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.relatedTarget && dz.contains(e.relatedTarget)) return;
      dz.classList.remove('is-dragover');
    };
    const onDrop = (e) => {
      e.preventDefault(); e.stopPropagation();
      dz.classList.remove('is-dragover');
      if (e.dataTransfer?.files?.length) addFile(e.dataTransfer.files);
    };

    dz.addEventListener('dragenter', onOver);
    dz.addEventListener('dragover',  onOver);
    dz.addEventListener('dragleave', onLeave);
    dz.addEventListener('drop',      onDrop);

    const blockOver = (e) => e.preventDefault();
    const blockDrop = (e) => e.preventDefault();
    document.addEventListener('dragover', blockOver);
    document.addEventListener('drop',     blockDrop);

    return () => {
      dz.removeEventListener('dragenter', onOver);
      dz.removeEventListener('dragover',  onOver);
      dz.removeEventListener('dragleave', onLeave);
      dz.removeEventListener('drop',      onDrop);
      document.removeEventListener('dragover', blockOver);
      document.removeEventListener('drop',     blockDrop);
    };
  }

  /* ---------------------------- template ----------------------------- */
  function template() {
    return `
      <div class="split-root min-h-screen bg-white flex flex-col">

        <header class="sticky top-0 z-40 bg-white border-b border-gray-100">
          <div class="max-w-xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
            <div class="w-16 flex justify-start">
              <button type="button" data-back class="flex items-center gap-1 text-[13px] font-semibold text-gray-700 hover:text-gray-900 transition">
                <i data-lucide="arrow-left" style="width:18px;height:18px;"></i>
                <span>Back</span>
              </button>
            </div>
            <div class="flex items-center gap-2">
              <span class="grid h-7 w-7 place-items-center">
                <svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" width="28" height="28" aria-hidden="true">
                  <rect width="32" height="32" rx="8" fill="${BRAND}"/>
                  <path d="M11.5 6.5h7L24 12v12.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 10 24.5V8a1.5 1.5 0 0 1 1.5-1.5Z" fill="#FFFFFF"/>
                  <path d="M18.5 6.5V11a1 1 0 0 0 1 1H24" fill="#DDD6FE"/>
                  <rect x="13" y="15.5" width="7" height="1.6" rx="0.8" fill="${BRAND}"/>
                  <rect x="13" y="19.5" width="5" height="1.6" rx="0.8" fill="${BRAND}"/>
                </svg>
              </span>
              <span class="text-[16px] font-extrabold tracking-tight text-gray-900">
                Split<span style="color:${BRAND}">PDF</span>
              </span>
            </div>
            <div class="w-16"></div>
          </div>
        </header>

        <main class="flex-1 w-full max-w-xl mx-auto px-4 sm:px-6 pt-4 pb-36">

          <div data-work-workspace>

            <!-- Big violet dropzone block, matching SplitPDF.html landing -->
            <div data-dropzone role="button" tabindex="0" aria-label="Upload PDF file"
                 class="group relative cursor-pointer rounded-2xl bg-split-500 px-4 py-8 text-center transition-all duration-200 hover:bg-split-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-split-500 focus-visible:ring-offset-2 sm:px-8 sm:py-10">
              <div class="dz-inner absolute inset-3.5 rounded-xl border-2 border-dashed border-white/60 transition-colors duration-200"></div>
              <input type="file" data-file-input accept=".pdf,application/pdf" hidden />

              <div class="relative z-10 flex flex-col items-center justify-center min-h-[180px] sm:min-h-[210px]">
                <svg width="120" height="80" viewBox="0 0 120 80" fill="none" xmlns="http://www.w3.org/2000/svg" class="mb-5">
                  <rect x="10" y="14" width="46" height="56" rx="5" fill="white" opacity="0.35"/>
                  <rect x="16" y="18" width="46" height="56" rx="5" fill="white" opacity="0.95"/>
                  <rect x="23" y="29" width="30" height="3" rx="1.5" fill="#C4B5FD"/>
                  <rect x="23" y="37" width="22" height="3" rx="1.5" fill="#C4B5FD"/>
                  <rect x="23" y="45" width="26" height="3" rx="1.5" fill="#C4B5FD"/>
                  <path d="M72 42h14" stroke="white" stroke-width="3" stroke-linecap="round" stroke-dasharray="4 4"/>
                  <path d="M86 42 L80 36 M86 42 L80 48" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                  <rect x="94" y="10" width="24" height="30" rx="4" fill="white" opacity="0.9"/>
                  <rect x="99" y="18" width="14" height="2.5" rx="1.25" fill="#C4B5FD"/>
                  <rect x="99" y="24" width="10" height="2.5" rx="1.25" fill="#C4B5FD"/>
                  <rect x="99" y="30" width="12" height="2.5" rx="1.25" fill="#C4B5FD"/>
                  <rect x="94" y="44" width="24" height="30" rx="4" fill="white" opacity="0.9"/>
                  <rect x="99" y="52" width="14" height="2.5" rx="1.25" fill="#C4B5FD"/>
                  <rect x="99" y="58" width="10" height="2.5" rx="1.25" fill="#C4B5FD"/>
                  <rect x="99" y="64" width="12" height="2.5" rx="1.25" fill="#C4B5FD"/>
                </svg>

                <div class="inline-flex overflow-hidden rounded-lg shadow-btn">
                  <button type="button" id="chooseBtn" class="flex items-center gap-2 bg-white px-5 py-3 text-[13px] font-bold text-gray-900 transition hover:bg-gray-50 focus:outline-none sm:px-6 sm:text-[14px]">
                    <i data-lucide="file-plus" style="width:16px;height:16px;"></i>
                    SELECT FILE
                  </button>
                  <button type="button" aria-label="More upload options" class="flex items-center border-l border-gray-200 bg-white px-2.5 transition hover:bg-gray-50 focus:outline-none">
                    <i data-lucide="chevron-down" style="width:16px;height:16px;" class="text-gray-900"></i>
                  </button>
                </div>
              </div>
            </div>

            <div data-file-card class="hidden"></div>

            <div data-options class="hidden mt-5">

              <div class="inline-flex w-full rounded-xl bg-gray-100 p-1">
                <button type="button" data-mode-tab="extract"
                        class="flex-1 rounded-lg px-3 py-2 text-[13px] font-semibold transition">
                  Extract pages
                </button>
                <button type="button" data-mode-tab="every-n"
                        class="flex-1 rounded-lg px-3 py-2 text-[13px] font-semibold transition">
                  Split every N
                </button>
              </div>

              <div data-mode-panel="extract" class="mt-5">
                <label class="block text-[12px] font-bold uppercase tracking-wider text-gray-900 mb-2">
                  Pages to extract
                </label>
                <input type="text" data-range-input inputmode="text" autocomplete="off" spellcheck="false"
                       placeholder="e.g. 1-3, 5, 8-10"
                       class="w-full rounded-xl border border-gray-200 bg-white px-3.5 py-3 text-[14px] font-medium text-gray-900 outline-none transition placeholder-gray-400 focus:border-split-400 focus:ring-4 focus:ring-split-500/10" />
                <p class="mt-1.5 text-[11px] text-gray-900">
                  Each entry becomes its own PDF. Use commas to separate, dashes for ranges.
                </p>
              </div>

              <div data-mode-panel="every-n" class="hidden mt-5">
                <label class="block text-[12px] font-bold uppercase tracking-wider text-gray-900 mb-2">
                  Pages per file
                </label>
                <div class="flex items-stretch gap-2">
                  <button type="button" data-step-down aria-label="Decrease"
                          class="grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-gray-200 bg-white text-gray-900 transition hover:border-split-300 hover:text-split-600 active:scale-95">
                    <i data-lucide="minus" style="width:16px;height:16px;"></i>
                  </button>
                  <input type="number" data-every-input min="1" value="1"
                         class="min-w-0 flex-1 rounded-xl border border-gray-200 bg-white px-3.5 text-center text-[16px] font-semibold text-gray-900 outline-none transition focus:border-split-400 focus:ring-4 focus:ring-split-500/10" />
                  <button type="button" data-step-up aria-label="Increase"
                          class="grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-gray-200 bg-white text-gray-900 transition hover:border-split-300 hover:text-split-600 active:scale-95">
                    <i data-lucide="plus" style="width:16px;height:16px;"></i>
                  </button>
                </div>
                <p class="mt-1.5 text-[11px] text-gray-900">
                  Each output file will contain up to this many pages.
                </p>
              </div>

              <div data-preview class="mt-4 min-h-[1.5rem]"></div>

            </div>
          </div>

          <div data-success-workspace class="hidden"></div>

        </main>

        <div data-bottom-bar class="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 p-4 z-50"
             style="padding-bottom: max(1.5rem, env(safe-area-inset-bottom, 0));">
          <div class="max-w-xl mx-auto flex flex-col gap-2">
            <div class="flex justify-between text-[12px] font-semibold text-gray-500 px-1">
              <span>Total Files: <span data-total-files class="text-blue-600">0</span></span>
              <span>Total Pages: <span data-total-pages class="text-blue-600">0</span></span>
            </div>
            <button type="button" data-split disabled
                    class="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed text-white font-bold py-4 rounded-xl flex items-center justify-center gap-2 transition active:scale-[0.98] text-[16px] shadow-sm">
              Split <i data-lucide="arrow-right" style="width:20px;height:20px;"></i>
            </button>
          </div>
        </div>

        <div data-status class="pointer-events-none fixed inset-x-0 top-20 z-50 flex justify-center px-4"></div>

      </div>
    `;
  }

  /* ---------------------------- public API --------------------------- */
  async function render(rootEl, options) {
    if (!rootEl) throw new Error('SplitPDF.render: missing root element');

    await ensureLibs();

    state.file = null;
    state.mode = 'extract';
    state.rangeInput = '';
    state.everyN = 1;
    state.isProcessing = false;
    state.root = rootEl;
    state.onBack = options?.onBack || null;
    state.cleanup = [];
    state.statusTimer = null;
    state.splitResult = null;

    injectStyles();
    rootEl.innerHTML = template();
    refreshIcons();

    rootEl.addEventListener('click', handleClick);
    rootEl.addEventListener('input', handleInput);
    rootEl.addEventListener('focusin', handleFocusIn);
    rootEl.addEventListener('keydown', handleKeyDown);

    const dz = rootEl.querySelector('[data-dropzone]');
    if (dz) state.cleanup.push(setupDropZone(dz));

    updateMode();
    renderUploadedFile();
    updatePreview();
    updateBottomBar();

    if (options?.initialFiles?.length) {
      await addFile(options.initialFiles);
    }
  }

  function destroy() {
    if (state.root) {
      state.root.removeEventListener('click', handleClick);
      state.root.removeEventListener('input', handleInput);
      state.root.removeEventListener('focusin', handleFocusIn);
      state.root.removeEventListener('keydown', handleKeyDown);
    }
    releaseSplitResult();
    releaseSourceFile();
    state.cleanup.forEach(fn => { try { fn(); } catch (e) {} });
    state.cleanup = [];
    state.file = null;
    state.root = null;
    state.statusTimer = null;
  }

  window.SplitPDF = { render, destroy };
})();