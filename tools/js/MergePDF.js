/* =====================================================================
 * MergePDF.js — PDFTools merge module
 * Memory-efficient client-side PDF merging + app-like workspace UI.
 * Features: sequential reads, explicit GC hints, custom pointer drag,
 *           pastel-color persistence, editable output name, Web Share.
 * Depends on (auto-loaded if missing):
 *   - pdf-lib  (PDF manipulation)
 *   - lucide   (icons, expected on host page)
 * ===================================================================== */
(function () {
  'use strict';

  const PDFLIB_CDN = 'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js';
  const STYLE_ID   = 'merge-pdf-styles';

  // Violet accent used by the workspace brand mark (matches MergePDF.html)
  const BRAND = '#8B5CF6';

  const PASTEL_COLORS = [
    'bg-pink-100 text-pink-700',
    'bg-yellow-100 text-yellow-700',
    'bg-teal-100 text-teal-700',
    'bg-purple-100 text-purple-700',
    'bg-blue-100 text-blue-700',
    'bg-orange-100 text-orange-700',
  ];

  const state = {
    files: [],
    isMerging: false,
    gen: 0,
    root: null,
    onBack: null,
    cleanup: [],
    statusTimer: null,
    mergedResult: null,
    colorCounter: 0,
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
  }

  // Explicitly release File references so the browser can free OS handles.
  function releaseFileRefs() {
    for (let i = 0; i < state.files.length; i++) {
      const item = state.files[i];
      if (item) item.file = null;
    }
  }

  function nextColor() {
    const c = PASTEL_COLORS[state.colorCounter % PASTEL_COLORS.length];
    state.colorCounter++;
    return c;
  }

  /* ---------------------------- file logic --------------------------- */
  // Reads page count, then explicitly releases raw buffer + parsed doc.
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

  async function addFiles(fileList) {
    const pdfs = Array.from(fileList || []).filter(f =>
      f.type === 'application/pdf' || /\.pdf$/i.test(f.name)
    );

    if (!pdfs.length) {
      if (fileList && fileList.length) showToast('Only PDF files are supported.', 'error');
      return;
    }

    const myGen = state.gen;

    const newItems = pdfs.map(f => ({
      id: uid(),
      file: f,
      name: f.name,
      size: f.size,
      pageCount: null,
      loading: true,
      error: null,
      colorClass: nextColor(),
    }));

    state.files.push(...newItems);
    renderFiles();
    updateBottomBar();

    // Sequential reads — one arrayBuffer + one parsed doc at a time.
    for (let i = 0; i < newItems.length; i++) {
      if (myGen !== state.gen) return;
      const item = newItems[i];

      const info = await readPdfInfo(item.file);
      if (myGen !== state.gen) return;

      item.pageCount = info.pageCount;
      item.error     = info.error;
      item.loading   = false;

      renderFiles();
      updateBottomBar();
      await new Promise(r => setTimeout(r, 0));
    }
  }

  function removeFile(id) {
    const idx = state.files.findIndex(f => f.id === id);
    if (idx === -1) return;
    if (state.files[idx]) state.files[idx].file = null;
    state.files.splice(idx, 1);
    renderFiles();
    updateBottomBar();
  }

  function moveFile(id, direction) {
    const idx = state.files.findIndex(f => f.id === id);
    if (idx === -1) return;
    const target = idx + direction;
    if (target < 0 || target >= state.files.length) return;

    const [item] = state.files.splice(idx, 1);
    state.files.splice(target, 0, item);
    renderFiles();
    updateBottomBar();
  }

  function clearAll() {
    if (!state.files.length) return;
    state.gen += 1;
    releaseFileRefs();
    state.files = [];
    renderFiles();
    updateBottomBar();
  }

  /* ------------------------------ merge ------------------------------ */
  async function mergeAll() {
    if (state.isMerging) return;

    const valid = state.files.filter(f => !f.error && f.pageCount && f.file);
    if (valid.length < 2) {
      showToast('Add at least 2 valid PDFs.', 'error');
      return;
    }

    state.isMerging = true;
    showToast('Merging files…', 'info', 0);
    updateBottomBar();

    let merged = null;

    try {
      merged = await window.PDFLib.PDFDocument.create();
      let totalPages = 0;

      for (const item of valid) {
        if (!item.file) continue;
        let bytes = await item.file.arrayBuffer();
        let src = await window.PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
        const pages = await merged.copyPages(src, src.getPageIndices());
        pages.forEach(p => merged.addPage(p));
        totalPages += pages.length;

        src = null;
        bytes = null;
        await new Promise(r => setTimeout(r, 0));
      }

      let out = await merged.save();
      merged = null;

      const totalSize = out.byteLength;
      const blob = new Blob([out], { type: 'application/pdf' });
      out = null;

      const url = URL.createObjectURL(blob);
      if (state.mergedResult?.url) URL.revokeObjectURL(state.mergedResult.url);

      state.mergedResult = {
        blob, url, totalPages, totalSize,
        fileName: 'merged_document.pdf',
        sourceCount: valid.length,
      };

      state.isMerging = false;
      showToast(null);
      showSuccess();
    } catch (err) {
      console.error('[MergePDF]', err);
      merged = null;
      state.isMerging = false;
      showToast('Merge failed: ' + (err.message || 'Unknown error'), 'error');
      updateBottomBar();
    }
  }

  /* --------------------------- success view -------------------------- */
  function showSuccess() {
    const root = state.root;
    if (!root || !state.mergedResult) return;

    const mergeWs   = root.querySelector('[data-merge-workspace]');
    const successWs = root.querySelector('[data-success-workspace]');
    const bottomBar = root.querySelector('[data-bottom-bar]');

    if (mergeWs)   mergeWs.classList.add('hidden');
    if (bottomBar) bottomBar.classList.add('hidden');
    if (successWs) {
      successWs.classList.remove('hidden');
      successWs.innerHTML = successHtml();
    }

    refreshIcons();
    window.scrollTo(0, 0);
  }

  function successHtml() {
    const r = state.mergedResult;
    const baseName = r.fileName.replace(/\.pdf$/i, '');

    return `
      <div class="w-full flex items-center gap-3 mb-6">
        <div class="w-10 h-10 bg-green-500 rounded-xl flex items-center justify-center shrink-0 shadow-sm">
          <i data-lucide="check" class="text-white" style="width:22px;height:22px;" stroke-width="3"></i>
        </div>
        <h2 class="text-xl font-extrabold text-gray-900 tracking-tight">Merged Successfully 🎉</h2>
      </div>

      <div class="w-full mb-8">
        <label class="block text-[12px] font-bold uppercase tracking-wider text-gray-900 mb-2">File Name (Editable)</label>
        <div class="flex items-center border-b-2 border-dashed border-gray-300 focus-within:border-blue-500 transition">
          <input type="text" data-filename value="${escapeHtml(baseName)}"
                 class="flex-1 text-[15px] font-semibold text-gray-900 bg-transparent outline-none pb-2"
                 maxlength="80" spellcheck="false" autocomplete="off" />
          <span class="text-[15px] font-semibold text-gray-500 pb-2 select-none">.pdf</span>
        </div>

        <div class="grid grid-cols-2 gap-3 mt-5">
          <div class="bg-gray-50 rounded-xl p-3.5 border border-gray-100 text-center">
            <p class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Total Pages</p>
            <p class="text-[16px] font-extrabold text-gray-900 mt-1">${r.totalPages}</p>
          </div>
          <div class="bg-gray-50 rounded-xl p-3.5 border border-gray-100 text-center">
            <p class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Size</p>
            <p class="text-[16px] font-extrabold text-gray-900 mt-1">${formatBytes(r.totalSize)}</p>
          </div>
        </div>
      </div>

      <div class="w-full grid grid-cols-2 gap-2.5">
        <button type="button" data-download
                class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2 transition active:scale-[0.98] text-[14px] shadow-sm">
          <i data-lucide="download" style="width:18px;height:18px;"></i>
          Download
        </button>
        <button type="button" data-share
                class="bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 font-bold py-3 rounded-xl flex items-center justify-center gap-2 transition active:scale-[0.98] text-[14px]">
          <i data-lucide="share-2" style="width:18px;height:18px;"></i>
          Share
        </button>
      </div>

      <button type="button" data-start-over
              class="w-full mt-3 bg-white border border-gray-300 hover:border-gray-400 text-gray-700 font-bold py-3 rounded-xl flex items-center justify-center gap-2 transition active:scale-[0.98] text-[14px]">
        <i data-lucide="refresh-cw" style="width:16px;height:16px;"></i>
        Start Over
      </button>
    `;
  }

  function getOutputFilename() {
    const input = state.root?.querySelector('[data-filename]');
    let base = sanitizeFilename(input?.value || '');
    if (!base) base = 'merged_document';
    return base.replace(/\.pdf$/i, '') + '.pdf';
  }

  function handleDownload() {
    if (!state.mergedResult) return;
    const filename = getOutputFilename();

    const a = document.createElement('a');
    a.href = state.mergedResult.url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast('Download started', 'success');
  }

  async function handleShare() {
    if (!state.mergedResult) return;
    const filename = getOutputFilename();

    try {
      const file = new File([state.mergedResult.blob], filename, { type: 'application/pdf' });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: 'Merged PDF',
          text: 'Merged with PDFTools',
        });
        return;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }

    // Fallback: download
    handleDownload();
  }

  // Start Over: hard reset via full page reload. Prevents the user from
  // returning to a pre-populated merge control screen with old inputs.
  function startOver() {
    if (state.mergedResult?.url) {
      try { URL.revokeObjectURL(state.mergedResult.url); } catch (e) {}
      state.mergedResult = null;
    }
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

    // Matches our rounded-xl + blue-accent design language.
    const config = {
      info: {
        border: 'border-gray-200',
        bg: 'bg-white',
        text: 'text-gray-900',
        iconColor: 'text-blue-600',
        icon: 'loader-2',
        spin: true,
      },
      success: {
        border: 'border-emerald-200',
        bg: 'bg-white',
        text: 'text-emerald-700',
        iconColor: 'text-emerald-500',
        icon: 'check-circle-2',
        spin: false,
      },
      error: {
        border: 'border-rose-200',
        bg: 'bg-white',
        text: 'text-rose-700',
        iconColor: 'text-rose-500',
        icon: 'alert-triangle',
        spin: false,
      },
    };
    const c = config[type] || config.info;

    el.innerHTML = `
      <div class="pointer-events-auto flex max-w-[calc(100vw-2rem)] items-center gap-2.5 rounded-xl border ${c.border} ${c.bg} px-4 py-2.5 text-[13px] font-semibold ${c.text} shadow-lg shadow-gray-900/5"
           style="animation: merge-toast-in .22s cubic-bezier(0.4, 0, 0.2, 1);">
        <i data-lucide="${c.icon}"
           class="h-4 w-4 shrink-0 ${c.iconColor} ${c.spin ? 'animate-spin' : ''}"></i>
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
  function renderFiles() {
    const root       = state.root;
    const listEl     = root?.querySelector('[data-file-list]');
    const sectionEl  = root?.querySelector('[data-files-section]');
    const dropzoneEl = root?.querySelector('[data-dropzone]');
    if (!listEl || !sectionEl) return;

    const hasFiles = state.files.length > 0;
    sectionEl.classList.toggle('hidden', !hasFiles);
    if (dropzoneEl) dropzoneEl.classList.toggle('hidden', hasFiles);

    if (!hasFiles) { listEl.innerHTML = ''; return; }

    const total = state.files.length;

    listEl.innerHTML = state.files.map((item, index) => {
      const isFirst = index === 0;
      const isLast  = index === total - 1;

      const meta = item.loading
        ? '<span class="text-gray-500">Reading…</span>'
        : item.error
          ? `<span class="text-rose-500">${escapeHtml(item.error)}</span>`
          : `${item.pageCount} page${item.pageCount !== 1 ? 's' : ''} · ${formatBytes(item.size)}`;

      return `
        <div class="file-item flex items-center gap-1.5 py-3 px-4 border-b border-gray-100 bg-white last:border-0 hover:bg-gray-50/50 transition" data-id="${item.id}">

          <span class="text-[13px] font-bold text-gray-900 w-5 text-center shrink-0">
            ${index + 1}
          </span>

          <button type="button" data-drag aria-label="Drag to reorder"
                  class="cursor-grab active:cursor-grabbing text-gray-400 hover:text-gray-600 shrink-0 p-0.5 rounded">
            <i data-lucide="grip-vertical" style="width:16px;height:16px;"></i>
          </button>

          <div class="min-w-0 flex-1 ml-1">
            <div class="inline-block max-w-full truncate px-2 py-0.5 rounded-md text-[12px] font-bold ${item.colorClass}">${escapeHtml(item.name)}</div>
            <p class="text-[11px] text-gray-900 mt-0.5">${meta}</p>
          </div>

          <div class="flex items-center gap-1 shrink-0 text-gray-500">
            <button type="button" data-move-up="${item.id}" aria-label="Move up"
                    ${isFirst ? 'disabled' : ''}
                    class="p-1 hover:text-blue-600 transition disabled:opacity-20 disabled:hover:text-gray-500">
              <i data-lucide="chevron-up" style="width:18px;height:18px;"></i>
            </button>
            <button type="button" data-move-down="${item.id}" aria-label="Move down"
                    ${isLast ? 'disabled' : ''}
                    class="p-1 hover:text-blue-600 transition disabled:opacity-20 disabled:hover:text-gray-500">
              <i data-lucide="chevron-down" style="width:18px;height:18px;"></i>
            </button>
            <button type="button" data-remove="${item.id}" aria-label="Remove"
                    class="p-1 hover:text-red-500 transition">
              <i data-lucide="trash-2" style="width:16px;height:16px;"></i>
            </button>
          </div>
        </div>
      `;
    }).join('');

    refreshIcons();
  }

  function updateBottomBar() {
    const root    = state.root;
    const btn     = root?.querySelector('[data-merge]');
    const filesEl = root?.querySelector('[data-total-files]');
    const pagesEl = root?.querySelector('[data-total-pages]');
    if (!btn) return;

    const valid = state.files.filter(f => !f.error && f.pageCount && f.file);
    const totalPages = state.files.reduce((s, f) => s + (f.pageCount || 0), 0);
    const ready = valid.length >= 2 && !state.isMerging;

    btn.disabled = !ready;
    btn.innerHTML = state.isMerging
      ? '<i data-lucide="loader-2" style="width:20px;height:20px;" class="animate-spin"></i><span>Merging…</span>'
      : 'Merge <i data-lucide="arrow-right" style="width:20px;height:20px;"></i>';

    if (filesEl) filesEl.textContent = state.files.length;
    if (pagesEl) pagesEl.textContent = totalPages;

    refreshIcons();
  }

  /* ===================================================================
   * CUSTOM DRAG — pointer events + floating clone + auto-scroll
   * Preserves pastel color because the clone is a DOM copy.
   * =================================================================== */
  function setupDrag(listEl) {
    if (!listEl) return () => {};

    let drag = null;
    let scrollRafId = null;
    let savedScrollBehavior = null;
    let moveDirty = false;

    const SCROLL_MAX  = 45;
    const SCROLL_EDGE = 110;

    function disableSmoothScroll() {
      const h = document.documentElement;
      if (savedScrollBehavior === null) savedScrollBehavior = h.style.scrollBehavior;
      h.style.scrollBehavior = 'auto';
      h.style.overflowAnchor = 'none';
      document.body.style.overflowAnchor = 'none';
    }

    function restoreSmoothScroll() {
      const h = document.documentElement;
      if (savedScrollBehavior !== null) {
        h.style.scrollBehavior = savedScrollBehavior;
        savedScrollBehavior = null;
      }
      h.style.overflowAnchor = '';
      document.body.style.overflowAnchor = '';
    }

    function getScroller() {
      return document.scrollingElement || document.documentElement || document.body;
    }

    function moveClone(x, y) {
      if (!drag || !drag.clone) return;
      const left = x - drag.offsetX;
      const top  = y - drag.offsetY;
      drag.clone.style.transform =
        'translate3d(' + left + 'px,' + top + 'px,0) scale(1.02)';
    }

    function updatePlaceholder(x, y) {
      if (!drag || !drag.active || !drag.placeholder) return;

      drag.clone.style.pointerEvents = 'none';
      const el = document.elementFromPoint(x, y);
      const targetRow = el && el.closest('.file-item');

      if (!targetRow) return;
      if (targetRow === drag.placeholder) return;
      if (targetRow.classList.contains('drag-placeholder')) return;

      const rect = targetRow.getBoundingClientRect();
      const before = y < rect.top + rect.height / 2;

      const ph = drag.placeholder;
      const parent = ph.parentNode;
      if (!parent) return;

      const nextSib = ph.nextElementSibling;
      const prevSib = ph.previousElementSibling;

      if (before) {
        if (nextSib === targetRow) return;
        parent.insertBefore(ph, targetRow);
      } else {
        if (prevSib === targetRow) return;
        parent.insertBefore(ph, targetRow.nextSibling);
      }
    }

    function tick() {
      if (!drag || !drag.active) { scrollRafId = null; return; }

      if (moveDirty) {
        moveDirty = false;
        moveClone(drag.lastX, drag.lastY);
        updatePlaceholder(drag.lastX, drag.lastY);
      }

      const vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
      const y  = drag.lastY;
      let delta = 0;

      if (y < SCROLL_EDGE) {
        const t = (SCROLL_EDGE - y) / SCROLL_EDGE;
        if (t > 0) delta = -SCROLL_MAX * t;
      } else if (y > vh - SCROLL_EDGE) {
        const t = (y - (vh - SCROLL_EDGE)) / SCROLL_EDGE;
        if (t > 0) delta = SCROLL_MAX * t;
      }

      if (delta !== 0) {
        const scroller = getScroller();
        const before = scroller.scrollTop;
        scroller.scrollTop = before + delta;
        if (scroller.scrollTop !== before) {
          updatePlaceholder(drag.lastX, drag.lastY);
        }
      }

      scrollRafId = requestAnimationFrame(tick);
    }

    function startRaf() { if (!scrollRafId) scrollRafId = requestAnimationFrame(tick); }
    function stopRaf()  { if (scrollRafId) { cancelAnimationFrame(scrollRafId); scrollRafId = null; } }

    function onPointerDown(e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;

      const handle = e.target.closest('[data-drag]');
      if (!handle) return;
      const row = handle.closest('.file-item');
      if (!row || row.classList.contains('drag-placeholder')) return;

      e.preventDefault();
      e.stopPropagation();

      drag = {
        pointerId: e.pointerId,
        startX: e.clientX, startY: e.clientY,
        lastX: e.clientX, lastY: e.clientY,
        row, active: false,
        clone: null, placeholder: null,
        offsetX: 0, offsetY: 0,
      };
      moveDirty = false;

      document.addEventListener('pointermove', onPointerMove, { passive: false });
      document.addEventListener('pointerup', onPointerUp);
      document.addEventListener('pointercancel', onPointerUp);
    }

    function activate() {
      const row = drag.row;
      const rect = row.getBoundingClientRect();

      drag.offsetX = drag.lastX - rect.left;
      drag.offsetY = drag.lastY - rect.top;
      drag.active = true;

      const ph = document.createElement('div');
      ph.className = 'file-item drag-placeholder';
      ph.style.height = rect.height + 'px';
      ph.style.border = '2px dashed #93C5FD';
      ph.style.background = 'rgba(37, 99, 235, 0.05)';
      ph.style.pointerEvents = 'none';
      ph.style.transition = 'none';
      drag.placeholder = ph;

      const parent = row.parentNode;
      parent.insertBefore(ph, row);
      row.remove();

      const clone = row.cloneNode(true);
      clone.style.position = 'fixed';
      clone.style.left = '0';
      clone.style.top = '0';
      clone.style.width = rect.width + 'px';
      clone.style.height = rect.height + 'px';
      clone.style.margin = '0';
      clone.style.pointerEvents = 'none';
      clone.style.zIndex = '9999';
      clone.style.transformOrigin = '0 0';
      clone.style.borderRadius = '0.5rem';
      clone.style.boxShadow = '0 20px 40px -14px rgba(15,15,30,.35), 0 0 0 2px rgba(37,99,235,.35)';
      clone.style.transform = 'translate3d(' + rect.left + 'px,' + rect.top + 'px,0) scale(1.02)';
      clone.style.transition = 'none';
      clone.style.background = '#ffffff';
      drag.clone = clone;
      document.body.appendChild(clone);

      document.body.classList.add('is-dragging-file');
      disableSmoothScroll();
      moveDirty = true;
      startRaf();
    }

    function onPointerMove(e) {
      if (!drag || e.pointerId !== drag.pointerId) return;

      drag.lastX = e.clientX;
      drag.lastY = e.clientY;

      if (!drag.active) {
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        if (dx * dx + dy * dy < 25) return;
        activate();
        if (!drag.active) return;
      }

      if (e.cancelable) e.preventDefault();
      moveDirty = true;
    }

    function onPointerUp(e) {
      if (!drag || e.pointerId !== drag.pointerId) return;

      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerUp);
      stopRaf();

      if (drag.active) {
        const { row, clone, placeholder } = drag;
        if (clone && clone.parentNode) clone.remove();
        if (placeholder && placeholder.parentNode && row) {
          placeholder.parentNode.insertBefore(row, placeholder);
          placeholder.remove();
        }

        const orderedIds = Array.from(listEl.querySelectorAll('.file-item'))
          .filter(el => el.getAttribute('data-id'))
          .map(el => el.getAttribute('data-id'));
        const byId = new Map(state.files.map(f => [f.id, f]));
        state.files = orderedIds.map(id => byId.get(id)).filter(Boolean);

        renderFiles();
        updateBottomBar();
      } else {
        if (drag.placeholder && drag.placeholder.parentNode) drag.placeholder.remove();
        if (drag.clone && drag.clone.parentNode) drag.clone.remove();
      }

      document.body.classList.remove('is-dragging-file');
      restoreSmoothScroll();
      drag = null;
      moveDirty = false;
    }

    function onContextMenu(e) {
      if (e.target.closest('.file-item')) e.preventDefault();
    }

    listEl.addEventListener('pointerdown', onPointerDown);
    listEl.addEventListener('contextmenu', onContextMenu);

    return function cleanup() {
      listEl.removeEventListener('pointerdown', onPointerDown);
      listEl.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerUp);
      stopRaf();
      if (drag) {
        if (drag.clone && drag.clone.parentNode) drag.clone.remove();
        if (drag.placeholder && drag.placeholder.parentNode) drag.placeholder.remove();
        if (drag.row && !drag.row.parentNode) listEl.appendChild(drag.row);
        drag = null;
      }
      document.body.classList.remove('is-dragging-file');
      restoreSmoothScroll();
    };
  }

  /* ------------------------------ styles ----------------------------- */
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '@keyframes merge-toast-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }',
      '.file-item { touch-action: manipulation; -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }',
      '.file-item svg { pointer-events: none; }',
      '[data-drag] { touch-action: none; -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; -webkit-user-drag: none; }',
      '[data-drag] * { pointer-events: none; }',
      '.file-item.drag-placeholder { transition: none !important; }',
      'body.is-dragging-file { overscroll-behavior: contain; -webkit-touch-callout: none; }',
      'body.is-dragging-file * { cursor: grabbing !important; }',
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
    if (t.closest('[data-dropzone]') || t.closest('[data-add-more]')) {
      state.root.querySelector('[data-file-input]')?.click();
      return;
    }
    if (t.closest('[data-merge]'))      { mergeAll(); return; }
    if (t.closest('[data-download]'))   { handleDownload(); return; }
    if (t.closest('[data-share]'))      { handleShare(); return; }
    if (t.closest('[data-start-over]')) { startOver(); return; }

    const up = t.closest('[data-move-up]');
    if (up && !up.disabled) { moveFile(up.getAttribute('data-move-up'), -1); return; }

    const dn = t.closest('[data-move-down]');
    if (dn && !dn.disabled) { moveFile(dn.getAttribute('data-move-down'), 1); return; }

    const rm = t.closest('[data-remove]');
    if (rm) removeFile(rm.getAttribute('data-remove'));
  }

  function handleInput(e) {
    if (e.target.matches('[data-file-input]')) {
      if (e.target.files && e.target.files.length) {
        addFiles(e.target.files);
        e.target.value = '';
      }
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
      handleDownload();
    }
  }

  function setupDropZone(dz) {
    const onOver = (e) => {
      e.preventDefault(); e.stopPropagation();
      dz.classList.add('is-dragover');
    };
    const onLeave = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.relatedTarget && dz.contains(e.relatedTarget)) return;
      dz.classList.remove('is-dragover');
    };
    const onDrop = (e) => {
      e.preventDefault(); e.stopPropagation();
      dz.classList.remove('is-dragover');
      if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
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
      <div class="merge-root min-h-screen bg-white flex flex-col">

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
                Merge<span style="color:${BRAND}">PDF</span>
              </span>
            </div>
            <div class="w-16"></div>
          </div>
        </header>

        <main class="flex-1 w-full max-w-xl mx-auto px-4 sm:px-6 pt-4 pb-36">

          <div data-merge-workspace>
            <label data-dropzone
                   class="group block cursor-pointer rounded-xl border-2 border-dashed border-gray-300 bg-white p-8 text-center transition hover:border-blue-400 hover:bg-blue-50/30">
              <input type="file" data-file-input accept=".pdf,application/pdf" multiple hidden />
              <div class="flex flex-col items-center justify-center gap-3">
                <span class="grid h-12 w-12 place-items-center rounded-xl bg-blue-50 text-blue-600 transition group-hover:scale-105">
                  <i data-lucide="file-plus" style="width:24px;height:24px;"></i>
                </span>
                <p class="text-sm font-semibold text-gray-900">
                  Drop PDFs here, or <span class="text-blue-600">tap to browse</span>
                </p>
                <p class="text-xs text-gray-500">Select 2 or more files</p>
              </div>
            </label>

            <div data-files-section class="hidden">
              <div data-file-list class="bg-white rounded-xl border border-gray-100 overflow-hidden shadow-sm"></div>

              <button type="button" data-add-more
                      class="w-full mt-3 flex items-center justify-center gap-2 rounded-lg border border-dashed border-blue-300 bg-blue-50/30 py-3 text-[13px] font-semibold text-blue-600 transition hover:border-blue-400 hover:bg-blue-50 hover:text-blue-700">
                <i data-lucide="plus" style="width:16px;height:16px;"></i>
                Add PDF files
              </button>
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
            <button type="button" data-merge disabled
                    class="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed text-white font-bold py-4 rounded-xl flex items-center justify-center gap-2 transition active:scale-[0.98] text-[16px] shadow-sm">
              Merge <i data-lucide="arrow-right" style="width:20px;height:20px;"></i>
            </button>
          </div>
        </div>

        <div data-status class="pointer-events-none fixed inset-x-0 top-20 z-50 flex justify-center px-4"></div>

      </div>
    `;
  }

  /* ---------------------------- public API --------------------------- */
  async function render(rootEl, options) {
    if (!rootEl) throw new Error('MergePDF.render: missing root element');

    await ensureLibs();

    state.files = [];
    state.isMerging = false;
    state.gen = 0;
    state.root = rootEl;
    state.onBack = options?.onBack || null;
    state.cleanup = [];
    state.statusTimer = null;
    state.mergedResult = null;
    state.colorCounter = 0;

    injectStyles();
    rootEl.innerHTML = template();
    refreshIcons();

    rootEl.addEventListener('click', handleClick);
    rootEl.addEventListener('change', handleInput);
    rootEl.addEventListener('focusin', handleFocusIn);
    rootEl.addEventListener('keydown', handleKeyDown);

    const dz = rootEl.querySelector('[data-dropzone]');
    if (dz) state.cleanup.push(setupDropZone(dz));

    const listEl = rootEl.querySelector('[data-file-list]');
    if (listEl) state.cleanup.push(setupDrag(listEl));

    updateBottomBar();

    if (options?.initialFiles?.length) {
      await addFiles(options.initialFiles);
    }
  }

  function destroy() {
    if (state.root) {
      state.root.removeEventListener('click', handleClick);
      state.root.removeEventListener('change', handleInput);
      state.root.removeEventListener('focusin', handleFocusIn);
      state.root.removeEventListener('keydown', handleKeyDown);
    }
    if (state.mergedResult?.url) {
      try { URL.revokeObjectURL(state.mergedResult.url); } catch (e) {}
    }
    releaseFileRefs();
    state.cleanup.forEach(fn => { try { fn(); } catch (e) {} });
    state.cleanup = [];
    state.files = [];
    state.mergedResult = null;
    state.root = null;
    state.statusTimer = null;
  }

  window.MergePDF = { render, destroy };
})();