/* =====================================================================
 * PDFtoImage.js — PDFTools PDF to image module
 * Convert PDF pages to JPG / PNG / WebP images.
 * Streams pages one at a time into a ZIP — never holds all bitmaps.
 * Theme: orange brand mark in the workspace header (matches the HTML);
 *        blue action elements (Convert, Download, Share).
 * Depends on (auto-loaded if missing):
 *   - pdf.js  (page rendering)   — loaded at start
 *   - JSZip   (bundling)         — loaded LAZILY on convert
 *   - lucide  (icons, expected on host page)
 * ===================================================================== */
(function () {
  'use strict';

  const PDFJS_CDN    = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
  const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  const JSZIP_CDN    = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
  const STYLE_ID     = 'pdf2img-styles';

  // Orange brand mark (matches PDFtoImage.html header/footer accents)
  const BRAND = '#F97316';

  /* -------------------------- device caps ---------------------------- */
  const CAPS = (function detect() {
    let isMobile = false;
    try {
      const isTouch  = (navigator.maxTouchPoints || 0) > 1;
      const isNarrow = Math.min(window.innerWidth, window.innerHeight) < 820;
      isMobile = isTouch && isNarrow;
    } catch (e) {}
    const memGB = (typeof navigator.deviceMemory === 'number') ? navigator.deviceMemory : 4;
    const lowMemory = memGB <= 2;
    return {
      isMobile, lowMemory, memGB,
      maxPixels: lowMemory ? 6000000 : (isMobile ? 12000000 : 25000000),
      maxOutputBytes: lowMemory ? 150 * 1024 * 1024
                    : (isMobile ? 400 * 1024 * 1024
                                : 1024 * 1024 * 1024),
    };
  })();

  const DEFAULTS = {
    format: 'jpg',
    quality: 90,
    scale: 2,
    range: '',
  };

  const SCALES = [
    { value: 1, label: 'Standard', hint: '72 DPI' },
    { value: 2, label: 'High',     hint: '144 DPI' },
    { value: 3, label: 'Ultra',    hint: '216 DPI' },
  ];

  const state = {
    file: null,
    jsDoc: null,
    gen: 0,
    settings: { ...DEFAULTS },
    isProcessing: false,
    cancelRequested: false,
    root: null,
    onBack: null,
    cleanup: [],
    statusTimer: null,
    result: null,
  };

  let previewToken = 0;
  let previewTask  = null;
  let previewRafId = null;
  let activeConvertTask = null;

  const refs = {
    previewWrap: null, previewCanvas: null,
    summary: null, saveBtn: null,
    rangeInput: null, rangeInfo: null,
    qualityRow: null, qualityInput: null, qualityVal: null,
    progressOverlay: null, progressBar: null, progressLabel: null,
    progressCancel: null,
    dropzone: null, fileCard: null, fileInput: null, clearBtn: null,
    menuWrap: null, menuDropdown: null, title: null,
    workWs: null, successWs: null, bottomBar: null, status: null,
    editor: null,
    formatBtns: null, scaleBtns: null,
  };

  /* ------------------------------ utils ------------------------------ */
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

  async function ensurePdfJs() {
    if (!window.pdfjsLib) await loadScript(PDFJS_CDN);
    if (window.pdfjsLib && window.pdfjsLib.GlobalWorkerOptions) {
      try { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; } catch (e) {}
    }
  }

  async function ensureJSZip() {
    if (!window.JSZip) await loadScript(JSZIP_CDN);
  }

  function revokeResultUrl() {
    if (state.result?.url) {
      try { URL.revokeObjectURL(state.result.url); } catch (e) {}
    }
    state.result = null;
  }

  function cancelPreviewRender() {
    if (previewTask) {
      try { previewTask.cancel(); } catch (e) {}
      previewTask = null;
    }
  }

  function cancelConvertTask() {
    if (activeConvertTask) {
      try { activeConvertTask.cancel(); } catch (e) {}
      activeConvertTask = null;
    }
  }

  function destroyJsDoc() {
    cancelPreviewRender();
    cancelConvertTask();
    if (state.jsDoc) {
      try { state.jsDoc.destroy(); } catch (e) {}
      state.jsDoc = null;
    }
  }

  function releaseCanvas(canvas) {
    if (!canvas) return;
    try {
      canvas.width = 0;
      canvas.height = 0;
      canvas.style.width = '0px';
      canvas.style.height = '0px';
    } catch (e) {}
  }

  function releaseSourceFile() {
    if (state.file) state.file.file = null;
  }

  function cacheRefs() {
    const root = state.root;
    if (!root) return;
    refs.previewWrap    = root.querySelector('[data-preview-wrap]');
    refs.previewCanvas  = root.querySelector('[data-preview-canvas]');
    refs.summary        = root.querySelector('[data-summary]');
    refs.saveBtn        = root.querySelector('[data-save]');
    refs.rangeInput     = root.querySelector('[data-range-input]');
    refs.rangeInfo      = root.querySelector('[data-range-info]');
    refs.qualityRow     = root.querySelector('[data-quality-row]');
    refs.qualityInput   = root.querySelector('[data-quality]');
    refs.qualityVal     = root.querySelector('[data-quality-val]');
    refs.progressOverlay= root.querySelector('[data-progress-overlay]');
    refs.progressBar    = root.querySelector('[data-progress-bar]');
    refs.progressLabel  = root.querySelector('[data-progress-label]');
    refs.progressCancel = root.querySelector('[data-progress-cancel]');
    refs.dropzone       = root.querySelector('[data-dropzone]');
    refs.fileCard       = root.querySelector('[data-file-card]');
    refs.fileInput      = root.querySelector('[data-file-input]');
    refs.clearBtn       = root.querySelector('[data-clear]');
    refs.menuWrap       = root.querySelector('[data-menu-wrap]');
    refs.menuDropdown   = root.querySelector('[data-menu-dropdown]');
    refs.title          = root.querySelector('[data-title]');
    refs.workWs         = root.querySelector('[data-work-workspace]');
    refs.successWs      = root.querySelector('[data-success-workspace]');
    refs.bottomBar      = root.querySelector('[data-bottom-bar]');
    refs.status         = root.querySelector('[data-status]');
    refs.editor         = root.querySelector('[data-editor]');
    refs.formatBtns     = root.querySelectorAll('[data-format]');
    refs.scaleBtns      = root.querySelectorAll('[data-scale]');
  }

  /* -------------------------- range parser --------------------------- */
  function parseRange(input, maxPage) {
    const raw = String(input || '').trim();
    if (!raw) return { pages: null, error: null, empty: true };

    const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (!parts.length) return { pages: null, error: null, empty: true };

    const seen = new Set();
    const pages = [];
    for (const part of parts) {
      if (/^\d+$/.test(part)) {
        const p = parseInt(part, 10);
        if (p < 1 || p > maxPage) return { pages: [], error: `Page ${p} is out of range (1–${maxPage})` };
        if (!seen.has(p)) { seen.add(p); pages.push(p); }
      } else {
        const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
        if (!m) return { pages: [], error: `Invalid entry: "${part}"` };
        const a = parseInt(m[1], 10);
        const b = parseInt(m[2], 10);
        if (a < 1 || b > maxPage) return { pages: [], error: `Range ${part} is out of bounds (1–${maxPage})` };
        if (a > b) return { pages: [], error: `Range ${part}: start must be ≤ end` };
        for (let i = a; i <= b; i++) {
          if (!seen.has(i)) { seen.add(i); pages.push(i); }
        }
      }
    }
    return { pages, error: null, empty: false };
  }

  let _selCache = { key: null, val: null };
  function invalidateSelCache() { _selCache.key = null; _selCache.val = null; }

  function getSelectedPages() {
    if (!state.file?.pageCount) return { pages: [], error: null };
    const key = state.settings.range + '\u0000' + state.file.pageCount;
    if (_selCache.key === key) {
      const c = _selCache.val;
      return { pages: c.pages, error: c.error };
    }

    const parsed = parseRange(state.settings.range, state.file.pageCount);
    let result;
    if (parsed.error) {
      result = { pages: [], error: parsed.error };
    } else if (parsed.pages === null) {
      const arr = new Array(state.file.pageCount);
      for (let i = 0; i < arr.length; i++) arr[i] = i + 1;
      result = { pages: arr, error: null };
    } else {
      result = { pages: parsed.pages, error: null };
    }

    _selCache.key = key;
    _selCache.val = result;
    return { pages: result.pages, error: result.error };
  }

  /* ------------------------------ load ------------------------------- */
  async function addFile(fileList) {
    const f = Array.from(fileList || []).find(x =>
      x.type === 'application/pdf' || /\.pdf$/i.test(x.name)
    );
    if (!f) {
      if (fileList && fileList.length) showToast('Only PDF files are supported.', 'error');
      return;
    }

    revokeResultUrl();
    destroyJsDoc();
    releaseCanvas(refs.previewCanvas);
    releaseSourceFile();
    invalidateSelCache();

    const myGen = ++state.gen;

    state.file = { file: f, name: f.name, size: f.size, pageCount: null, loading: true, error: null };
    state.settings = { ...DEFAULTS };
    state.isProcessing = false;
    state.cancelRequested = false;

    renderUploadedFile();
    updateEditorVisibility();
    updateBottomBar();

    try {
      await ensurePdfJs();

      const buf = await f.arrayBuffer();
      if (myGen !== state.gen) return;

      const jsDoc = await window.pdfjsLib.getDocument({
        data: new Uint8Array(buf),
        isEvalSupported: false,
      }).promise;
      if (myGen !== state.gen) { try { jsDoc.destroy(); } catch (e) {} return; }
      state.jsDoc = jsDoc;

      state.file.pageCount = jsDoc.numPages;
      state.file.loading = false;

      applySettingsToUI();
      renderUploadedFile();
      updateEditorVisibility();
      updateBottomBar();

      await renderPreview();
    } catch (err) {
      console.error('[PDFtoImage]', err);
      if (myGen !== state.gen) return;
      if (!state.file) return;
      state.file.loading = false;
      state.file.error = 'Unreadable or encrypted';
      renderUploadedFile();
      updateEditorVisibility();
      updateBottomBar();
    }
  }

  function removeFile() {
    state.gen += 1;
    state.cancelRequested = true;
    cancelPreviewRender();
    cancelConvertTask();
    destroyJsDoc();
    revokeResultUrl();
    releaseCanvas(refs.previewCanvas);
    releaseSourceFile();
    invalidateSelCache();
    state.file = null;
    state.settings = { ...DEFAULTS };
    state.isProcessing = false;
    hideProgress();
    renderUploadedFile();
    updateEditorVisibility();
    updateBottomBar();
  }

  /* ------------------------- small preview --------------------------- */
  async function renderPreview() {
    if (!state.jsDoc || !refs.previewCanvas || !refs.previewWrap) return;

    cancelPreviewRender();
    const myToken = ++previewToken;
    const myGen = state.gen;

    let jsPage = null;
    try {
      jsPage = await state.jsDoc.getPage(1);
      if (myToken !== previewToken || myGen !== state.gen) {
        try { jsPage.cleanup(); } catch (e) {}
        return;
      }

      const vp1 = jsPage.getViewport({ scale: 1 });
      const ratio = vp1.width / vp1.height;
      const targetW = Math.min(200, refs.previewWrap.clientWidth || 200);
      const displayW = Math.floor(targetW);
      const displayH = Math.floor(displayW / ratio);

      const canvas = refs.previewCanvas;
      const dpr = Math.min(window.devicePixelRatio || 1, CAPS.lowMemory ? 1 : 2);
      canvas.width  = Math.round(displayW * dpr);
      canvas.height = Math.round(displayH * dpr);
      canvas.style.width  = displayW + 'px';
      canvas.style.height = displayH + 'px';

      const renderVp = jsPage.getViewport({ scale: (displayW * dpr) / vp1.width });
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const task = jsPage.render({ canvasContext: ctx, viewport: renderVp });
      previewTask = task;
      await task.promise;
      if (myToken !== previewToken || myGen !== state.gen) return;
      previewTask = null;
    } catch (err) {
      if (err && err.name === 'RenderingCancelledException') return;
      console.error('[PDFtoImage] preview', err);
    } finally {
      if (jsPage) { try { jsPage.cleanup(); } catch (e) {} }
    }
  }

  /* --------------------------- conversion ---------------------------- */
  function canvasToBlob(canvas, mime, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error('toBlob returned null'));
      }, mime, quality);
    });
  }

  const MIME = {
    jpg:  'image/jpeg',
    png:  'image/png',
    webp: 'image/webp',
  };

  const EXT = { jpg: 'jpg', png: 'png', webp: 'webp' };

  function updateProgress(current, total, phase) {
    if (!refs.progressBar || !refs.progressLabel) return;
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    refs.progressBar.style.width = pct + '%';
    refs.progressLabel.textContent = phase
      ? `${phase} · ${current} / ${total}`
      : `${current} / ${total}`;
  }

  function showProgress() {
    if (refs.progressOverlay) refs.progressOverlay.classList.remove('hidden');
    if (refs.progressBar) refs.progressBar.style.width = '0%';
    if (refs.progressCancel) refs.progressCancel.disabled = false;
    updateProgress(0, 1, 'Starting');
  }

  function hideProgress() {
    if (refs.progressOverlay) refs.progressOverlay.classList.add('hidden');
  }

  async function convert() {
    if (state.isProcessing || !state.file || state.file.error || !state.jsDoc) return;

    const sel = getSelectedPages();
    if (sel.error) { showToast(sel.error, 'error'); return; }
    if (!sel.pages.length) { showToast('No pages to convert.', 'error'); return; }

    state.isProcessing = true;
    state.cancelRequested = false;
    updateBottomBar();
    showProgress();

    const myGen = state.gen;
    const total = sel.pages.length;

    const canvas = document.createElement('canvas');
    const s = state.settings;
    const mime = MIME[s.format] || MIME.jpg;
    const quality01 = Math.max(0.01, Math.min(1, (s.quality || 90) / 100));
    const qualityArg = s.format === 'png' ? undefined : quality01;

    const baseName = (state.file.name || 'file').replace(/\.pdf$/i, '');
    const padWidth = String(state.file.pageCount).length;
    const ext = EXT[s.format] || 'jpg';

    const useZip = total > 1;
    let zip = null;
    if (useZip) {
      await ensureJSZip();
      zip = new window.JSZip();
    }

    let singleBlob = null;
    let totalSize = 0;

    try {
      for (let i = 0; i < total; i++) {
        if (state.cancelRequested || myGen !== state.gen) throw new Error('__cancelled__');

        const pageNum = sel.pages[i];
        updateProgress(i, total, `Page ${pageNum}`);

        let jsPage = null;
        try {
          jsPage = await state.jsDoc.getPage(pageNum);
          if (state.cancelRequested || myGen !== state.gen) {
            try { jsPage.cleanup(); } catch (e) {}
            throw new Error('__cancelled__');
          }

          const vp1 = jsPage.getViewport({ scale: 1 });
          const scale = s.scale || 2;

          let renderScale = scale;
          let bmpW = Math.round(vp1.width  * renderScale);
          let bmpH = Math.round(vp1.height * renderScale);
          const pixels = bmpW * bmpH;
          if (pixels > CAPS.maxPixels) {
            const shrink = Math.sqrt(CAPS.maxPixels / pixels);
            renderScale = scale * shrink;
            bmpW = Math.round(vp1.width  * renderScale);
            bmpH = Math.round(vp1.height * renderScale);
          }

          const renderVp = jsPage.getViewport({ scale: renderScale });

          canvas.width  = bmpW;
          canvas.height = bmpH;
          const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, bmpW, bmpH);

          const task = jsPage.render({ canvasContext: ctx, viewport: renderVp });
          activeConvertTask = task;
          try {
            await task.promise;
          } catch (e) {
            if (e && e.name === 'RenderingCancelledException') {
              throw new Error('__cancelled__');
            }
            throw e;
          } finally {
            if (activeConvertTask === task) activeConvertTask = null;
          }
          if (state.cancelRequested || myGen !== state.gen) throw new Error('__cancelled__');

          const blob = await canvasToBlob(canvas, mime, qualityArg);
          if (state.cancelRequested || myGen !== state.gen) throw new Error('__cancelled__');

          totalSize += blob.size;

          if (totalSize > CAPS.maxOutputBytes) {
            const limitMb = Math.round(CAPS.maxOutputBytes / (1024 * 1024));
            const err = new Error(
              `Output exceeds ${limitMb} MB — try fewer pages, a lower resolution, or JPG format.`
            );
            err.__quota = true;
            throw err;
          }

          const fname = `${baseName}-page-${String(pageNum).padStart(padWidth, '0')}.${ext}`;

          if (useZip) {
            zip.file(fname, blob);
          } else {
            singleBlob = blob;
          }

          updateProgress(i + 1, total, `Page ${pageNum}`);
        } catch (err) {
          if (err && (err.message === '__cancelled__' || err.__quota)) throw err;
          console.error(`[PDFtoImage] page ${pageNum}`, err);
          showToast(`Page ${pageNum} failed`, 'error', 1800);
        } finally {
          if (jsPage) { try { jsPage.cleanup(); } catch (e) {} }
        }

        await new Promise(r => setTimeout(r, 0));
      }

      releaseCanvas(canvas);
      activeConvertTask = null;

      if (useZip) {
        updateProgress(total, total, 'Building ZIP');
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        if (state.cancelRequested || myGen !== state.gen) throw new Error('__cancelled__');
        const zipBlob = await zip.generateAsync({
          type: 'blob',
          compression: 'STORE',
        });

        zip = null;

        const url = URL.createObjectURL(zipBlob);
        revokeResultUrl();
        state.result = {
          url,
          blob: zipBlob,
          fileName: `${baseName}-images.zip`,
          isZip: true,
          fileCount: total,
          totalSize: zipBlob.size,
        };
      } else if (singleBlob) {
        const url = URL.createObjectURL(singleBlob);
        revokeResultUrl();
        const pageNum = sel.pages[0];
        state.result = {
          url,
          blob: singleBlob,
          fileName: `${baseName}-page-${pageNum}.${ext}`,
          isZip: false,
          fileCount: 1,
          totalSize: singleBlob.size,
        };
      } else {
        throw new Error('No images were produced.');
      }

      hideProgress();
      state.isProcessing = false;
      updateBottomBar();
      showSuccess();
    } catch (err) {
      hideProgress();
      releaseCanvas(canvas);
      activeConvertTask = null;
      zip = null;
      state.isProcessing = false;
      updateBottomBar();

      if (err && err.__quota) {
        showToast(err.message, 'error', 4500);
      } else if (err && err.message === '__cancelled__') {
        showToast('Conversion cancelled', 'info');
      } else {
        console.error('[PDFtoImage] convert', err);
        showToast('Failed: ' + (err.message || 'Unknown error'), 'error');
      }
    }
  }

  /* --------------------------- success view -------------------------- */
  function showSuccess() {
    const root = state.root;
    if (!root || !state.result) return;

    if (refs.workWs)    refs.workWs.classList.add('hidden');
    if (refs.bottomBar) refs.bottomBar.classList.add('hidden');
    if (refs.clearBtn)  refs.clearBtn.classList.add('hidden');
    if (refs.menuWrap)  refs.menuWrap.classList.add('hidden');

    if (refs.successWs) {
      refs.successWs.classList.remove('hidden');
      refs.successWs.innerHTML = successHtml();
    }
    refreshIcons();
    window.scrollTo(0, 0);
  }

  function successHtml() {
    const r = state.result;
    const isZip = r.isZip;
    const baseName = r.fileName.replace(/\.(zip|jpg|jpeg|png|webp)$/i, '');
    const ext = isZip ? 'zip' : (r.fileName.split('.').pop() || 'jpg');

    return `
      <div class="w-full flex items-center gap-3 mb-6">
        <div class="w-10 h-10 bg-green-500 rounded-xl flex items-center justify-center shrink-0 shadow-sm">
          <i data-lucide="check" class="text-white" style="width:22px;height:22px;" stroke-width="3"></i>
        </div>
        <h2 class="text-xl font-extrabold text-gray-900 tracking-tight">
          ${isZip ? 'Images Ready 🎉' : 'Image Ready 🎉'}
        </h2>
      </div>

      <p class="text-[13px] text-gray-900 mb-6">
        ${isZip ? r.fileCount + ' images bundled into a ZIP archive' : 'Your image is ready to download'}
      </p>

      <div class="w-full mb-8">
        <label class="block text-[12px] font-bold uppercase tracking-wider text-gray-900 mb-2">File Name (Editable)</label>
        <div class="flex items-center border-b-2 border-dashed border-gray-300 focus-within:border-blue-500 transition">
          <input type="text" data-filename value="${escapeHtml(baseName)}"
                 class="flex-1 text-[15px] font-semibold text-gray-900 bg-transparent outline-none pb-2"
                 maxlength="80" spellcheck="false" autocomplete="off" />
          <span class="text-[15px] font-semibold text-gray-500 pb-2 select-none">.${ext}</span>
        </div>

        <div class="grid grid-cols-2 gap-3 mt-5">
          <div class="bg-gray-50 rounded-xl p-3.5 border border-gray-100 text-center">
            <p class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">${isZip ? 'Images' : 'Image'}</p>
            <p class="text-[16px] font-extrabold text-gray-900 mt-1">${r.fileCount}</p>
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
          Download ${isZip ? 'ZIP' : 'Image'}
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

  function handleDownload() {
    if (!state.result) return;
    const input = state.root?.querySelector('[data-filename]');
    let base = sanitizeFilename(input?.value || '');
    if (!base) base = state.result.isZip ? 'images' : 'page';
    const ext = state.result.isZip ? 'zip' : (state.result.fileName.split('.').pop() || 'jpg');
    const filename = base.replace(/\.(zip|jpg|jpeg|png|webp)$/i, '') + '.' + ext;

    const a = document.createElement('a');
    a.href = state.result.url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast('Download started', 'success');
  }

  async function handleShare() {
    if (!state.result) return;
    const input = state.root?.querySelector('[data-filename]');
    let base = sanitizeFilename(input?.value || '');
    if (!base) base = state.result.isZip ? 'images' : 'page';
    const ext = state.result.isZip ? 'zip' : (state.result.fileName.split('.').pop() || 'jpg');
    const filename = base.replace(/\.(zip|jpg|jpeg|png|webp)$/i, '') + '.' + ext;

    try {
      const mime = state.result.isZip ? 'application/zip' : (MIME[ext] || 'image/jpeg');
      const file = new File([state.result.blob], filename, { type: mime });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: state.result.isZip ? 'Converted Images' : 'Converted Image',
          text: 'Converted with PDFTools',
        });
        return;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }

    // Fallback: download
    handleDownload();
  }

  // Start Over: hard reset via full page reload. Prevents returning to a
  // pre-populated conversion screen with old settings still applied.
  function startOver() {
    revokeResultUrl();
    closeMenu();
    window.location.reload();
  }

  /* ------------------------------ toast ------------------------------ */
  function showToast(message, type, duration) {
    const el = refs.status || state.root?.querySelector('[data-status]');
    if (!el) return;

    if (state.statusTimer) { clearTimeout(state.statusTimer); state.statusTimer = null; }
    if (!message) { el.innerHTML = ''; return; }

    const config = {
      info:    { border: 'border-gray-200',    bg: 'bg-white', text: 'text-gray-900',    iconColor: 'text-blue-600',    icon: 'loader-2',       spin: true },
      success: { border: 'border-emerald-200', bg: 'bg-white', text: 'text-emerald-700', iconColor: 'text-emerald-500', icon: 'check-circle-2', spin: false },
      error:   { border: 'border-rose-200',    bg: 'bg-white', text: 'text-rose-700',    iconColor: 'text-rose-500',    icon: 'alert-triangle', spin: false },
    };
    const c = config[type] || config.info;

    el.innerHTML = `
      <div class="pointer-events-auto flex max-w-[calc(100vw-2rem)] items-center gap-2.5 rounded-xl border ${c.border} ${c.bg} px-4 py-2.5 text-[13px] font-semibold ${c.text} shadow-lg shadow-gray-900/5"
           style="animation: pdf2img-toast-in .22s cubic-bezier(0.4, 0, 0.2, 1);">
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
    const root = state.root;
    if (!root) return;

    const hasFile = !!state.file;
    if (refs.dropzone) refs.dropzone.classList.toggle('hidden', hasFile);
    if (refs.fileCard) refs.fileCard.classList.toggle('hidden', !hasFile);
    if (refs.clearBtn) refs.clearBtn.classList.toggle('hidden', !hasFile);
    if (refs.menuWrap) refs.menuWrap.classList.toggle('hidden', !hasFile);

    if (!hasFile || !refs.fileCard) return;

    const f = state.file;
    const meta = f.loading
      ? '<span class="text-gray-900">Reading…</span>'
      : f.error
        ? `<span class="text-rose-500">${escapeHtml(f.error)}</span>`
        : `${f.pageCount} page${f.pageCount !== 1 ? 's' : ''} · ${formatBytes(f.size)}`;

    refs.fileCard.innerHTML = `
      <div class="flex items-center gap-3 py-3 px-4 bg-white border border-gray-100 rounded-xl shadow-sm">
        <div class="min-w-0 flex-1">
          <div class="inline-block max-w-full truncate px-2 py-0.5 rounded-md text-[12px] font-bold bg-img-100 text-img-700">${escapeHtml(f.name)}</div>
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

  function updateEditorVisibility() {
    if (!refs.editor) return;
    const ready = !!state.file && !state.file.error && !state.file.loading && state.file.pageCount;
    refs.editor.classList.toggle('hidden', !ready);
  }

  /* --------------------------- settings UI --------------------------- */
  function applySettingsToUI() {
    const root = state.root;
    if (!root) return;
    const s = state.settings;

    if (refs.formatBtns) {
      refs.formatBtns.forEach(btn => {
        const active = btn.getAttribute('data-format') === s.format;
        btn.classList.toggle('is-active', active);
      });
    }

    if (refs.scaleBtns) {
      refs.scaleBtns.forEach(btn => {
        const active = parseInt(btn.getAttribute('data-scale'), 10) === s.scale;
        btn.classList.toggle('is-active', active);
      });
    }

    if (refs.qualityInput) refs.qualityInput.value = String(s.quality);
    if (refs.qualityVal)   refs.qualityVal.textContent = s.quality + '%';
    if (refs.qualityRow)   refs.qualityRow.classList.toggle('opacity-40', s.format === 'png');

    if (refs.rangeInput) refs.rangeInput.value = s.range;

    updateRangeInfo();
  }

  function updateRangeInfo() {
    if (!refs.rangeInfo) return;
    const f = state.file;
    if (!f || !f.pageCount) { refs.rangeInfo.textContent = ''; return; }

    const parsed = parseRange(state.settings.range, f.pageCount);
    if (parsed.error) {
      refs.rangeInfo.innerHTML =
        '<span class="text-rose-500">' + escapeHtml(parsed.error) + '</span>';
      return;
    }
    if (parsed.empty) {
      refs.rangeInfo.textContent = `All ${f.pageCount} pages will be converted`;
    } else {
      refs.rangeInfo.textContent = `${parsed.pages.length} page${parsed.pages.length !== 1 ? 's' : ''} selected`;
    }
  }

  function setSetting(key, value) {
    state.settings[key] = value;
    applySettingsToUI();
    updateBottomBar();
  }

  function updateSummary() {
    const el = refs.summary || state.root?.querySelector('[data-summary]');
    if (!el) return;
    const f = state.file;
    if (!f) { el.textContent = 'Add a PDF to get started'; return; }
    if (f.loading) { el.textContent = 'Reading file…'; return; }
    if (f.error) { el.textContent = 'This file cannot be processed'; return; }
    if (state.isProcessing) { el.textContent = 'Converting…'; return; }

    const sel = getSelectedPages();
    if (sel.error) { el.textContent = 'Fix the page range'; return; }
    const fmt = state.settings.format.toUpperCase();
    let scaleLabel = state.settings.scale + 'x';
    for (let i = 0; i < SCALES.length; i++) {
      if (SCALES[i].value === state.settings.scale) { scaleLabel = SCALES[i].label; break; }
    }
    el.textContent = `${sel.pages.length} page${sel.pages.length !== 1 ? 's' : ''} · ${fmt} · ${scaleLabel}`;
  }

  function updateBottomBar() {
    const btn = refs.saveBtn || state.root?.querySelector('[data-save]');
    if (!btn) return;

    const f = state.file;
    const sel = getSelectedPages();
    const ready = !!f && !f.loading && !f.error && !!f.pageCount
                  && !state.isProcessing && !!state.jsDoc
                  && !sel.error && sel.pages.length > 0;

    btn.disabled = !ready;
    btn.innerHTML = state.isProcessing
      ? '<i data-lucide="loader-2" style="width:20px;height:20px;" class="animate-spin"></i><span>Converting…</span>'
      : 'Convert <i data-lucide="arrow-right" style="width:20px;height:20px;"></i>';
    refreshIcons();
    updateSummary();
  }

  /* ------------------------- dropdown menu --------------------------- */
  function closeMenu() {
    const dd = refs.menuDropdown || state.root?.querySelector('[data-menu-dropdown]');
    if (dd) dd.classList.add('hidden');
  }

  function handleDocumentClick(e) {
    const menuWrap = refs.menuWrap || state.root?.querySelector('[data-menu-wrap]');
    if (!menuWrap) return;
    if (!menuWrap.contains(e.target)) closeMenu();
  }

  function handleGlobalKey(e) {
    if (e.key === 'Escape') closeMenu();
  }

  /* ------------------------------ styles ----------------------------- */
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '@keyframes pdf2img-toast-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }',
      '[data-dropzone].is-dragover { background-color: #C2410C !important; }',
      '[data-dropzone].is-dragover .dz-inner { border-color: rgba(255, 255, 255, 0.9); }',

      '[data-format], [data-scale] {',
      '  display: flex;',
      '  flex-direction: column;',
      '  align-items: center;',
      '  justify-content: center;',
      '  padding: 0.55rem 0.4rem;',
      '  font-size: 0.75rem;',
      '  font-weight: 700;',
      '  border: 1.5px solid #e5e7eb;',
      '  border-radius: 0.5rem;',
      '  background: #ffffff;',
      '  color: #6b7280;',
      '  cursor: pointer;',
      '  transition: background-color .12s, border-color .12s, color .12s, transform .08s;',
      '  text-align: center;',
      '  line-height: 1.2;',
      '}',
      '[data-format]:hover, [data-scale]:hover { border-color: #FDBA74; color: #F97316; }',
      '[data-format]:active, [data-scale]:active { transform: scale(0.96); }',
      '[data-format].is-active, [data-scale].is-active {',
      '  background: #F97316;',
      '  border-color: #F97316;',
      '  color: #ffffff;',
      '}',
      '[data-format] small, [data-scale] small {',
      '  display: block;',
      '  font-size: 0.6rem;',
      '  font-weight: 500;',
      '  opacity: 0.85;',
      '  margin-top: 2px;',
      '}',

      '[data-preview-wrap] {',
      '  display: flex;',
      '  justify-content: center;',
      '  padding: 12px;',
      '  border-radius: 0.75rem;',
      '  background: #f9fafb;',
      '  border: 1px solid #e5e7eb;',
      '}',
      '[data-preview-canvas] {',
      '  display: block;',
      '  max-width: 100%;',
      '  border-radius: 0.375rem;',
      '  box-shadow: 0 4px 14px -4px rgba(15,23,42,.2), 0 0 0 1px rgba(15,23,42,.06);',
      '  background: #ffffff;',
      '}',

      '[data-quality] {',
      '  -webkit-appearance: none;',
      '  appearance: none;',
      '  width: 100%;',
      '  height: 4px;',
      '  border-radius: 9999px;',
      '  background: #e5e7eb;',
      '  outline: none;',
      '  cursor: pointer;',
      '}',
      '[data-quality]::-webkit-slider-thumb {',
      '  -webkit-appearance: none;',
      '  width: 18px; height: 18px;',
      '  border-radius: 50%;',
      '  background: #F97316;',
      '  border: 2px solid #ffffff;',
      '  box-shadow: 0 1px 4px rgba(15,23,42,.2);',
      '  cursor: pointer;',
      '}',
      '[data-quality]::-moz-range-thumb {',
      '  width: 18px; height: 18px;',
      '  border-radius: 50%;',
      '  background: #F97316;',
      '  border: 2px solid #ffffff;',
      '  box-shadow: 0 1px 4px rgba(15,23,42,.2);',
      '  cursor: pointer;',
      '}',

      '[data-progress-overlay] {',
      '  position: fixed;',
      '  inset: 0;',
      '  z-index: 60;',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  background: rgba(15, 23, 42, 0.55);',
      '  backdrop-filter: blur(4px);',
      '}',
      '[data-progress-overlay].hidden { display: none; }',
      '[data-progress-bar] {',
      '  height: 100%;',
      '  background: linear-gradient(90deg, #F97316, #FB923C);',
      '  border-radius: 9999px;',
      '  transition: width .2s ease;',
      '  width: 0%;',
      '}',
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
    if (t.closest('[data-dropzone]'))    { refs.fileInput?.click(); return; }
    if (t.closest('[data-clear]'))       { closeMenu(); removeFile(); return; }
    if (t.closest('[data-remove-file]')) { closeMenu(); removeFile(); return; }
    if (t.closest('[data-save]'))        { convert(); return; }
    if (t.closest('[data-download]'))    { handleDownload(); return; }
    if (t.closest('[data-share]'))       { handleShare(); return; }
    if (t.closest('[data-start-over]'))  { startOver(); return; }

    if (t.closest('[data-progress-cancel]')) {
      state.cancelRequested = true;
      if (refs.progressCancel) refs.progressCancel.disabled = true;
      cancelConvertTask();
      return;
    }

    const fmtBtn = t.closest('[data-format]');
    if (fmtBtn) { setSetting('format', fmtBtn.getAttribute('data-format')); return; }

    const scaleBtn = t.closest('[data-scale]');
    if (scaleBtn) { setSetting('scale', parseInt(scaleBtn.getAttribute('data-scale'), 10)); return; }

    if (t.closest('[data-menu-toggle]')) {
      const dd = refs.menuDropdown || state.root.querySelector('[data-menu-dropdown]');
      if (dd) dd.classList.toggle('hidden');
      return;
    }

    if (t.closest('[data-menu-reset]')) {
      state.settings = { ...DEFAULTS };
      invalidateSelCache();
      applySettingsToUI();
      updateBottomBar();
      closeMenu();
      showToast('Settings reset', 'success');
      return;
    }
  }

  function handleInput(e) {
    const t = e.target;

    if (t.matches('[data-file-input]')) {
      if (t.files && t.files.length) { addFile(t.files); t.value = ''; }
      return;
    }
    if (t.matches('[data-quality]')) {
      setSetting('quality', parseInt(t.value, 10) || 90);
      return;
    }
    if (t.matches('[data-range-input]')) {
      state.settings.range = t.value;
      invalidateSelCache();
      updateRangeInfo();
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
      handleDownload();
    }
  }

  function handleResize() {
    if (!state.file || state.file.error || state.file.loading || !state.jsDoc) return;
    if (state.isProcessing) return;
    if (previewRafId) return;
    previewRafId = requestAnimationFrame(() => {
      previewRafId = null;
      renderPreview();
    });
  }

  function setupDropZone(dz) {
    const onOver  = (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.add('is-dragover'); };
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
  function formatButtonsHtml() {
    const items = [
      { value: 'jpg',  label: 'JPG',  sub: 'small' },
      { value: 'png',  label: 'PNG',  sub: 'lossless' },
      { value: 'webp', label: 'WebP', sub: 'modern' },
    ];
    return items.map(x =>
      '<button type="button" data-format="' + x.value + '">' +
        '<span>' + x.label + '</span>' +
        '<small>' + x.sub + '</small>' +
      '</button>'
    ).join('');
  }

  function scaleButtonsHtml() {
    return SCALES.map(s =>
      '<button type="button" data-scale="' + s.value + '">' +
        '<span>' + s.label + '</span>' +
        '<small>' + s.hint + '</small>' +
      '</button>'
    ).join('');
  }

  function template() {
    return `
      <div class="pdf2img-root min-h-screen bg-white flex flex-col">

        <header class="sticky top-0 z-40 bg-white border-b border-gray-100">
          <div class="max-w-3xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
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
                  <path d="M18.5 6.5V11a1 1 0 0 0 1 1H24" fill="#FED7AA"/>
                  <rect x="13" y="15.5" width="7" height="1.6" rx="0.8" fill="${BRAND}"/>
                  <rect x="13" y="19.5" width="5" height="1.6" rx="0.8" fill="${BRAND}"/>
                </svg>
              </span>
              <span class="text-[16px] font-extrabold tracking-tight text-gray-900">
                PDF<span style="color:${BRAND}">Image</span>
              </span>
            </div>

            <div class="w-24 flex justify-end items-center gap-1">
              <button type="button" data-clear
                      class="hidden rounded-md px-2 py-1 text-[12px] font-semibold text-gray-700 hover:bg-rose-50 hover:text-rose-600 active:scale-95 transition">
                Clear
              </button>
              <div data-menu-wrap class="relative hidden">
                <button type="button" data-menu-toggle aria-label="More options"
                        class="grid h-8 w-8 place-items-center rounded-md text-gray-700 hover:bg-gray-100 active:scale-95 transition">
                  <i data-lucide="more-vertical" style="width:18px;height:18px;"></i>
                </button>
                <div data-menu-dropdown class="hidden absolute right-0 top-full z-40 mt-2 w-48 overflow-hidden rounded-xl border border-gray-200 bg-white p-1 shadow-xl shadow-gray-900/10"
                     style="animation: pdf2img-toast-in .15s cubic-bezier(0.4,0,0.2,1);">
                  <button type="button" data-menu-reset class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-semibold text-gray-900 transition hover:bg-gray-100">
                    <i data-lucide="undo-2" style="width:16px;height:16px;" class="text-gray-500"></i>
                    Reset settings
                  </button>
                </div>
              </div>
            </div>
          </div>
        </header>

        <main class="flex-1 w-full max-w-3xl mx-auto px-4 sm:px-6 pt-4 pb-36">

          <div data-work-workspace>

            <label data-dropzone
                   class="group relative block cursor-pointer rounded-2xl bg-img-500 px-4 py-8 text-center transition-all duration-200 hover:bg-img-600 focus-within:outline-none sm:px-8 sm:py-10">
              <div class="dz-inner absolute inset-3.5 rounded-xl border-2 border-dashed border-white/60 transition-colors duration-200"></div>
              <input type="file" data-file-input accept=".pdf,application/pdf" hidden />

              <div class="relative z-10 flex flex-col items-center justify-center min-h-[180px] sm:min-h-[210px]">
                <svg width="130" height="84" viewBox="0 0 130 84" fill="none" xmlns="http://www.w3.org/2000/svg" class="mb-5">
                  <rect x="10" y="10" width="40" height="58" rx="4" fill="white" opacity="0.95"/>
                  <rect x="18" y="20" width="24" height="3" rx="1.5" fill="#FDBA74"/>
                  <rect x="18" y="27" width="18" height="3" rx="1.5" fill="#FDBA74"/>
                  <rect x="18" y="34" width="22" height="3" rx="1.5" fill="#FDBA74"/>
                  <rect x="18" y="41" width="16" height="3" rx="1.5" fill="#FDBA74"/>
                  <path d="M58 42h12" stroke="white" stroke-width="3" stroke-linecap="round"/>
                  <path d="M65 34l8 8-8 8" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                  <rect x="82" y="14" width="40" height="56" rx="5" fill="white"/>
                  <circle cx="98" cy="32" r="6" fill="#FDBA74"/>
                  <path d="M84 60 L94 48 L102 56 L108 50 L120 60 Z" fill="#F97316"/>
                  <rect x="84" y="62" width="36" height="4" rx="2" fill="#FED7AA"/>
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
            </label>

            <div data-file-card class="hidden mt-4"></div>

            <div data-editor class="hidden mt-5">

              <div data-preview-wrap class="mb-4">
                <canvas data-preview-canvas></canvas>
              </div>

              <div class="rounded-2xl border border-gray-200 bg-white p-4">

                <label class="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-gray-900">Format</label>
                <div class="grid grid-cols-3 gap-1.5">
                  ${formatButtonsHtml()}
                </div>

                <div data-quality-row class="mt-4">
                  <div class="mb-1.5 flex items-center justify-between">
                    <label class="text-[11px] font-bold uppercase tracking-wider text-gray-900">Quality</label>
                    <span data-quality-val class="text-[11px] font-bold text-gray-900">90%</span>
                  </div>
                  <input type="range" data-quality min="40" max="100" step="5" value="90" class="w-full" />
                  <p class="mt-1 text-[10px] text-gray-900">Applies to JPG and WebP only</p>
                </div>

                <div class="mt-4">
                  <label class="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-gray-900">Resolution</label>
                  <div class="grid grid-cols-3 gap-1.5">
                    ${scaleButtonsHtml()}
                  </div>
                </div>

                <div class="mt-4">
                  <label class="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-gray-900">Pages</label>
                  <input type="text" data-range-input inputmode="text" autocomplete="off" spellcheck="false" placeholder="All pages — or e.g. 1-3, 5, 8-10"
                         class="w-full rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 text-[14px] font-medium text-gray-900 outline-none transition placeholder-gray-400 focus:border-img-400 focus:ring-4 focus:ring-img-500/10" />
                  <p data-range-info class="mt-1 text-[11px] text-gray-900"></p>
                </div>

              </div>

            </div>
          </div>

          <div data-success-workspace class="hidden"></div>

        </main>

        <div data-bottom-bar class="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 p-4 z-40"
             style="padding-bottom: max(1.5rem, env(safe-area-inset-bottom, 0));">
          <div class="max-w-3xl mx-auto flex flex-col gap-2">
            <div class="flex justify-between text-[12px] font-semibold text-gray-900 px-1">
              <span data-summary>Add a PDF to get started</span>
            </div>
            <button type="button" data-save disabled
                    class="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed text-white font-bold py-4 rounded-xl flex items-center justify-center gap-2 transition active:scale-[0.98] text-[16px] shadow-sm">
              Convert <i data-lucide="arrow-right" style="width:20px;height:20px;"></i>
            </button>
          </div>
        </div>

        <div data-progress-overlay class="hidden">
          <div class="mx-4 w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-6 text-center shadow-2xl">
            <span class="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-img-50 text-img-500">
              <i data-lucide="loader-2" class="h-6 w-6 animate-spin"></i>
            </span>
            <h3 class="mt-4 text-lg font-extrabold text-gray-900">Converting Pages</h3>
            <p data-progress-label class="mt-1 text-[12px] font-medium text-gray-900">Starting</p>
            <div class="mt-4 h-2 w-full overflow-hidden rounded-full bg-gray-100">
              <div data-progress-bar></div>
            </div>
            <button type="button" data-progress-cancel
                    class="mt-5 rounded-xl border border-gray-200 bg-white px-4 py-2 text-[12px] font-bold text-gray-900 transition hover:bg-gray-50 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50">
              Cancel
            </button>
          </div>
        </div>

        <div data-status class="pointer-events-none fixed inset-x-0 top-20 z-50 flex justify-center px-4"></div>

      </div>
    `;
  }

  /* ---------------------------- public API --------------------------- */
  async function render(rootEl, options) {
    if (!rootEl) throw new Error('PDFtoImage.render: missing root element');

    await ensurePdfJs();

    if (state.root) {
      try { destroy(); } catch (e) {}
    }

    state.cleanup = [];
    state.file = null;
    state.jsDoc = null;
    state.settings = { ...DEFAULTS };
    state.isProcessing = false;
    state.cancelRequested = false;
    state.gen = 0;
    state.root = rootEl;
    state.onBack = options?.onBack || null;
    state.statusTimer = null;
    state.result = null;
    previewToken = 0;
    previewTask = null;
    activeConvertTask = null;
    invalidateSelCache();

    injectStyles();
    rootEl.innerHTML = template();
    cacheRefs();
    refreshIcons();
    applySettingsToUI();

    rootEl.addEventListener('click', handleClick);
    rootEl.addEventListener('input', handleInput);
    rootEl.addEventListener('change', handleInput);
    rootEl.addEventListener('focusin', handleFocusIn);
    rootEl.addEventListener('keydown', handleKeyDown);
    document.addEventListener('click', handleDocumentClick);
    document.addEventListener('keydown', handleGlobalKey);
    window.addEventListener('resize', handleResize);

    const dz = refs.dropzone;
    if (dz) {
      state.cleanup.push(setupDropZone(dz));
      dz.addEventListener('click', (e) => {
        if (e.target.closest('#chooseBtn')) {
          e.stopPropagation();
          refs.fileInput?.click();
        }
      });
    }

    updateBottomBar();

    if (options?.initialFiles?.length) {
      await addFile(options.initialFiles);
    }
  }

  function destroy() {
    state.gen += 1;
    state.cancelRequested = true;
    previewToken++;

    if (previewRafId) { cancelAnimationFrame(previewRafId); previewRafId = null; }

    if (state.root) {
      state.root.removeEventListener('click', handleClick);
      state.root.removeEventListener('input', handleInput);
      state.root.removeEventListener('change', handleInput);
      state.root.removeEventListener('focusin', handleFocusIn);
      state.root.removeEventListener('keydown', handleKeyDown);
    }
    document.removeEventListener('click', handleDocumentClick);
    document.removeEventListener('keydown', handleGlobalKey);
    window.removeEventListener('resize', handleResize);

    cancelPreviewRender();
    cancelConvertTask();
    destroyJsDoc();
    revokeResultUrl();
    releaseCanvas(refs.previewCanvas);
    releaseSourceFile();
    invalidateSelCache();

    state.cleanup.forEach(fn => { try { fn(); } catch (e) {} });
    state.cleanup = [];
    state.file = null;
    state.root = null;
    state.statusTimer = null;

    refs.previewWrap = null;
    refs.previewCanvas = null;
    refs.summary = null;
    refs.saveBtn = null;
    refs.rangeInput = null;
    refs.rangeInfo = null;
    refs.qualityRow = null;
    refs.qualityInput = null;
    refs.qualityVal = null;
    refs.progressOverlay = null;
    refs.progressBar = null;
    refs.progressLabel = null;
    refs.progressCancel = null;
    refs.dropzone = null;
    refs.fileCard = null;
    refs.fileInput = null;
    refs.clearBtn = null;
    refs.menuWrap = null;
    refs.menuDropdown = null;
    refs.title = null;
    refs.workWs = null;
    refs.successWs = null;
    refs.bottomBar = null;
    refs.status = null;
    refs.editor = null;
    refs.formatBtns = null;
    refs.scaleBtns = null;
  }

  window.PDFtoImage = { render, destroy };
})();