/* =====================================================================
 * AddPageNumbers.js — PDFTools add page numbers module
 * Add page numbers to a PDF with configurable position, format, color,
 * size, margin, starting number, skip-first-page and bold toggle.
 * Theme: cyan brand mark in the workspace header (matches the HTML);
 *        blue action elements (Save, Download, Share).
 * Depends on (auto-loaded if missing):
 *   - pdf.js   (page rendering)   — loaded at start
 *   - pdf-lib  (PDF manipulation) — loaded LAZILY at save time only
 *   - lucide   (icons, expected on host page)
 * ===================================================================== */
(function () {
  'use strict';

  const PDFLIB_CDN   = 'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js';
  const PDFJS_CDN    = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
  const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  const STYLE_ID     = 'add-page-numbers-styles';

  // Cyan brand mark (matches AddPageNumbers.html header/footer accents)
  const BRAND = '#06B6D4';

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
      maxDpr:     lowMemory ? 1   : (isMobile ? 1.25 : 1.5),
      maxRenderW: lowMemory ? 900 : (isMobile ? 1200 : 1600),
      maxRenderH: lowMemory ? 1200 : (isMobile ? 1600 : 2200),
    };
  })();

  /* ---------------------------- defaults ----------------------------- */
  const DEFAULTS = {
    position: 'bottom-center',
    format: 'number',
    color: '#000000',
    fontSize: 12,
    margin: 30,
    startNumber: 1,
    skipFirst: false,
    bold: false,
  };

  const POSITIONS = [
    'top-left',    'top-center',    'top-right',
    'bottom-left', 'bottom-center', 'bottom-right',
  ];

  const FORMATS = [
    { value: 'number',               label: '1' },
    { value: 'number-of-total',      label: '1 / 100' },
    { value: 'page-number',          label: 'Page 1' },
    { value: 'page-number-of-total', label: 'Page 1 of 100' },
    { value: 'roman-lower',          label: 'i, ii, iii…' },
    { value: 'roman-upper',          label: 'I, II, III…' },
    { value: 'alpha-lower',          label: 'a, b, c…' },
    { value: 'alpha-upper',          label: 'A, B, C…' },
  ];

  const CSS_FONT_STACK = 'Helvetica, Arial, sans-serif';

  const state = {
    file: null,
    jsDoc: null,
    gen: 0,
    currentPage: 0,
    settings: { ...DEFAULTS },
    isProcessing: false,
    root: null,
    onBack: null,
    cleanup: [],
    statusTimer: null,
    result: null,
  };

  let renderToken = 0;
  let activeRenderTask = null;
  let overlayRafId = null;
  let resizeRafId = null;

  const refs = {
    canvas: null, stage: null, stageWrap: null,
    overlay: null, overlayText: null,
    summary: null, saveBtn: null,
    pageInput: null, totPage: null, prevBtn: null, nextBtn: null,
    posGrid: null, colorInput: null, colorSwatch: null, colorHex: null,
    fmt: null, bold: null, skipFirst: null,
    fs: null, fsVal: null, mg: null, mgVal: null, startNum: null,
    dropzone: null, fileCard: null, fileInput: null, clearBtn: null,
    menuWrap: null, menuDropdown: null, title: null,
    workWs: null, successWs: null, bottomBar: null, status: null,
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

  function hexToRgb01(hex) {
    let h = String(hex || '').replace('#', '').trim();
    if (h.length === 3) h = h[0]+h[0] + h[1]+h[1] + h[2]+h[2];
    if (h.length !== 6) h = '000000';
    const n = parseInt(h, 16) || 0;
    return [
      ((n >> 16) & 255) / 255,
      ((n >> 8)  & 255) / 255,
      (n         & 255) / 255,
    ];
  }

  function normalizeHex(hex) {
    let h = String(hex || '').replace('#', '').trim();
    if (h.length === 3) h = h[0]+h[0] + h[1]+h[1] + h[2]+h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) h = '000000';
    return '#' + h.toLowerCase();
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

  async function ensurePdfLib() {
    if (!window.PDFLib) await loadScript(PDFLIB_CDN);
  }

  function revokeResultUrl() {
    if (state.result?.url) {
      try { URL.revokeObjectURL(state.result.url); } catch (e) {}
    }
    state.result = null;
  }

  function cancelActiveRender() {
    if (activeRenderTask) {
      try { activeRenderTask.cancel(); } catch (e) {}
      activeRenderTask = null;
    }
  }

  function destroyJsDoc() {
    cancelActiveRender();
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
    refs.canvas       = root.querySelector('[data-page-canvas]');
    refs.stage        = root.querySelector('[data-preview-stage]');
    refs.stageWrap    = root.querySelector('[data-preview-stage-wrap]');
    refs.overlay      = root.querySelector('[data-number-overlay]');
    refs.overlayText  = root.querySelector('[data-number-text]');
    refs.summary      = root.querySelector('[data-summary]');
    refs.saveBtn      = root.querySelector('[data-save]');
    refs.pageInput    = root.querySelector('[data-page-input]');
    refs.totPage      = root.querySelector('[data-total-pages]');
    refs.prevBtn      = root.querySelector('[data-prev-page]');
    refs.nextBtn      = root.querySelector('[data-next-page]');
    refs.posGrid      = root.querySelector('[data-pos-grid]');
    refs.colorInput   = root.querySelector('[data-color]');
    refs.colorSwatch  = root.querySelector('[data-color-swatch]');
    refs.colorHex     = root.querySelector('[data-color-hex]');
    refs.fmt          = root.querySelector('[data-format]');
    refs.bold         = root.querySelector('[data-bold]');
    refs.skipFirst    = root.querySelector('[data-skip-first]');
    refs.fs           = root.querySelector('[data-font-size]');
    refs.fsVal        = root.querySelector('[data-font-size-val]');
    refs.mg           = root.querySelector('[data-margin]');
    refs.mgVal        = root.querySelector('[data-margin-val]');
    refs.startNum     = root.querySelector('[data-start-num]');
    refs.dropzone     = root.querySelector('[data-dropzone]');
    refs.fileCard     = root.querySelector('[data-file-card]');
    refs.fileInput    = root.querySelector('[data-file-input]');
    refs.clearBtn     = root.querySelector('[data-clear]');
    refs.menuWrap     = root.querySelector('[data-menu-wrap]');
    refs.menuDropdown = root.querySelector('[data-menu-dropdown]');
    refs.title        = root.querySelector('[data-title]');
    refs.workWs       = root.querySelector('[data-work-workspace]');
    refs.successWs    = root.querySelector('[data-success-workspace]');
    refs.bottomBar    = root.querySelector('[data-bottom-bar]');
    refs.status       = root.querySelector('[data-status]');
  }

  /* ------------------------ number helpers --------------------------- */
  function toRoman(n) {
    if (!Number.isFinite(n) || n <= 0 || n > 3999) return String(n);
    const map = [
      [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
      [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
      [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
    ];
    let out = '';
    let v = n | 0;
    for (let i = 0; i < map.length; i++) {
      const num = map[i][0];
      const sym = map[i][1];
      while (v >= num) { out += sym; v -= num; }
    }
    return out;
  }

  function toAlpha(n) {
    if (!Number.isFinite(n) || n <= 0) return String(n);
    let v = n | 0;
    let out = '';
    while (v > 0) {
      v--;
      out = String.fromCharCode(97 + (v % 26)) + out;
      v = Math.floor(v / 26);
    }
    return out;
  }

  function getNumberForPage(pageIdx) {
    const skipOffset = state.settings.skipFirst ? 1 : 0;
    return pageIdx + state.settings.startNumber - skipOffset;
  }

  function isPageNumbered(pageIdx) {
    if (state.settings.skipFirst && pageIdx === 0) return false;
    return true;
  }

  function formatNumberText(number, total, format) {
    switch (format) {
      case 'number':               return String(number);
      case 'number-of-total':      return number + ' / ' + total;
      case 'page-number':          return 'Page ' + number;
      case 'page-number-of-total': return 'Page ' + number + ' of ' + total;
      case 'roman-lower':          return toRoman(number).toLowerCase();
      case 'roman-upper':          return toRoman(number).toUpperCase();
      case 'alpha-lower':          return toAlpha(number).toLowerCase();
      case 'alpha-upper':          return toAlpha(number).toUpperCase();
      default:                     return String(number);
    }
  }

  function pickInitialPreviewPage(pageCount) {
    if (!pageCount || pageCount < 1) return 0;
    if (pageCount < 5) return 0;
    const low  = 5;
    const high = Math.min(10, pageCount);
    const range = high - low + 1;
    const picked = low + Math.floor(Math.random() * range);
    return picked - 1;
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
    releaseCanvas(refs.canvas);
    releaseSourceFile();

    const myGen = ++state.gen;

    state.file = { file: f, name: f.name, size: f.size, pageCount: null, loading: true, error: null };
    state.currentPage = 0;
    state.settings = { ...DEFAULTS };

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

      state.currentPage = pickInitialPreviewPage(state.file.pageCount);

      applySettingsToUI();

      renderUploadedFile();
      updateEditorVisibility();
      updatePageNav();
      updateBottomBar();

      await renderCurrentPage();
    } catch (err) {
      console.error('[AddPageNumbers]', err);
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
    renderToken++;
    cancelActiveRender();
    destroyJsDoc();
    revokeResultUrl();
    releaseCanvas(refs.canvas);
    releaseSourceFile();
    state.file = null;
    state.currentPage = 0;
    state.settings = { ...DEFAULTS };
    renderUploadedFile();
    updateEditorVisibility();
    updateBottomBar();
  }

  /* --------------------------- page render --------------------------- */
  function computeDisplaySize(ratio) {
    const parentW = refs.stageWrap.clientWidth || 600;
    const maxH = Math.max(220, window.innerHeight * 0.5);
    let displayW = parentW;
    let displayH = displayW / ratio;
    if (displayH > maxH) { displayH = maxH; displayW = displayH * ratio; }
    return { w: Math.floor(displayW), h: Math.floor(displayH) };
  }

  function computeBitmapSize(displayW, displayH) {
    const dpr = Math.min(window.devicePixelRatio || 1, CAPS.maxDpr);
    let w = Math.round(displayW * dpr);
    let h = Math.round(displayH * dpr);

    let scale = 1;
    if (w > CAPS.maxRenderW) scale = Math.min(scale, CAPS.maxRenderW / w);
    if (h > CAPS.maxRenderH) scale = Math.min(scale, CAPS.maxRenderH / h);
    if (scale < 1) {
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    return { w, h };
  }

  async function renderCurrentPage() {
    if (!state.jsDoc || !state.file || state.file.error) return;
    if (!refs.canvas || !refs.stage || !refs.stageWrap) return;

    cancelActiveRender();

    const myToken = ++renderToken;
    const myGen = state.gen;
    const pageIdx = state.currentPage;
    const canvas = refs.canvas;

    let jsPage = null;
    let task = null;

    try {
      jsPage = await state.jsDoc.getPage(pageIdx + 1);
      if (myToken !== renderToken || myGen !== state.gen) {
        try { jsPage.cleanup(); } catch (e) {}
        return;
      }

      const vp1 = jsPage.getViewport({ scale: 1 });
      const ratio = vp1.width / vp1.height;
      const displaySize = computeDisplaySize(ratio);
      const displayW = displaySize.w;
      const displayH = displaySize.h;

      refs.stage.style.width  = displayW + 'px';
      refs.stage.style.height = displayH + 'px';

      const bmp = computeBitmapSize(displayW, displayH);
      const bmpW = bmp.w;
      const bmpH = bmp.h;

      canvas.width = 0;
      canvas.height = 0;
      canvas.style.width  = displayW + 'px';
      canvas.style.height = displayH + 'px';
      canvas.width  = bmpW;
      canvas.height = bmpH;

      const renderScale = bmpW / vp1.width;
      const renderVp = jsPage.getViewport({ scale: renderScale });

      const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
      task = jsPage.render({ canvasContext: ctx, viewport: renderVp });
      activeRenderTask = task;

      await task.promise;
      if (myToken !== renderToken || myGen !== state.gen) return;

      refs.stage.dataset.scale = String(displayW / vp1.width);

      updateNumberOverlay();
    } catch (err) {
      if (err && err.name === 'RenderingCancelledException') return;
      console.error('[AddPageNumbers] render', err);
    } finally {
      if (activeRenderTask === task) activeRenderTask = null;
      if (jsPage) { try { jsPage.cleanup(); } catch (e) {} }
    }
  }

  /* ------------------------- number overlay -------------------------- */
  function updateNumberOverlay() {
    if (!refs.overlay || !refs.overlayText || !refs.stage) return;

    const pageIdx = state.currentPage;
    if (!state.file || !isPageNumbered(pageIdx)) {
      refs.overlay.style.display = 'none';
      return;
    }
    refs.overlay.style.display = '';

    const total  = state.file.pageCount || 0;
    const number = getNumberForPage(pageIdx);
    const text   = formatNumberText(number, total, state.settings.format);

    refs.overlayText.textContent = text;

    const s = state.settings;
    const scale = parseFloat(refs.stage.dataset.scale || '1') || 1;
    const fontSizeCss = s.fontSize * scale;
    const marginCss   = s.margin   * scale;

    const st = refs.overlayText.style;
    st.fontSize   = fontSizeCss + 'px';
    st.fontWeight = s.bold ? '700' : '400';
    st.lineHeight = '1';
    st.fontFamily = CSS_FONT_STACK;
    st.color      = s.color;
    st.whiteSpace = 'nowrap';

    st.top = ''; st.bottom = ''; st.left = ''; st.right = ''; st.transform = '';

    const parts = s.position.split('-');
    const vertical   = parts[0];
    const horizontal = parts[1];

    st[vertical === 'top' ? 'top' : 'bottom'] = marginCss + 'px';

    if (horizontal === 'left') {
      st.left = marginCss + 'px';
    } else if (horizontal === 'right') {
      st.right = marginCss + 'px';
    } else {
      st.left = '50%';
      st.transform = 'translateX(-50%)';
    }
  }

  function scheduleOverlayUpdate() {
    if (overlayRafId) return;
    overlayRafId = requestAnimationFrame(() => {
      overlayRafId = null;
      updateNumberOverlay();
    });
  }

  /* ------------------------ settings handling ------------------------ */
  function applySettingsToUI() {
    const root = state.root;
    if (!root) return;
    const s = state.settings;

    root.querySelectorAll('[data-pos]').forEach(btn => {
      const active = btn.getAttribute('data-pos') === s.position;
      btn.classList.toggle('is-active', active);
    });

    if (refs.fmt)         refs.fmt.value = s.format;
    if (refs.colorInput)  refs.colorInput.value = s.color;
    if (refs.colorSwatch) refs.colorSwatch.style.background = s.color;
    if (refs.colorHex)    refs.colorHex.textContent = s.color.toUpperCase();

    if (refs.bold)      refs.bold.checked = s.bold;
    if (refs.skipFirst) refs.skipFirst.checked = s.skipFirst;

    if (refs.fs)    refs.fs.value = String(s.fontSize);
    if (refs.fsVal) refs.fsVal.textContent = s.fontSize + 'pt';

    if (refs.mg)    refs.mg.value = String(s.margin);
    if (refs.mgVal) refs.mgVal.textContent = s.margin + 'pt';

    if (refs.startNum) refs.startNum.value = String(s.startNumber);
  }

  function setSetting(key, value) {
    state.settings[key] = value;
    applySettingsToUI();
    scheduleOverlayUpdate();
    updateSummary();
  }

  /* ------------------------------ save ------------------------------- */
  async function applyNumbers() {
    if (state.isProcessing || !state.file || state.file.error || !state.jsDoc) return;

    state.isProcessing = true;
    updateBottomBar();
    showToast('Adding page numbers…', 'info', 0);

    let srcBuf = null;
    let libDoc = null;
    let bytes  = null;

    try {
      await ensurePdfLib();

      const s = state.settings;

      srcBuf = await state.file.file.arrayBuffer();
      libDoc = await window.PDFLib.PDFDocument.load(srcBuf, {
        ignoreEncryption: true,
        updateMetadata: false,
      });
      srcBuf = null;

      const pdfFontName = s.bold
        ? window.PDFLib.StandardFonts.HelveticaBold
        : window.PDFLib.StandardFonts.Helvetica;
      const font = await libDoc.embedFont(pdfFontName);

      const rgb = hexToRgb01(s.color);
      const color = window.PDFLib.rgb(rgb[0], rgb[1], rgb[2]);

      const total = state.file.pageCount;
      const pages = libDoc.getPages();
      const posParts = s.position.split('-');
      const vertical = posParts[0];
      const horizontal = posParts[1];

      for (let i = 0; i < pages.length; i++) {
        if (!isPageNumbered(i)) continue;

        const page = pages[i];
        const size = page.getSize();
        const pageW = size.width;
        const pageH = size.height;

        const number = getNumberForPage(i);
        const text = formatNumberText(number, total, s.format);
        const textWidth = font.widthOfTextAtSize(text, s.fontSize);

        let x;
        if (horizontal === 'left')       x = s.margin;
        else if (horizontal === 'right') x = pageW - s.margin - textWidth;
        else                             x = (pageW - textWidth) / 2;

        let y;
        if (vertical === 'top')  y = pageH - s.margin - s.fontSize;
        else                     y = s.margin;

        page.drawText(text, { x, y, size: s.fontSize, font, color });
      }

      bytes = await libDoc.save();
      libDoc = null;

      const blob = new Blob([bytes], { type: 'application/pdf' });
      bytes = null;

      const url = URL.createObjectURL(blob);

      revokeResultUrl();
      state.result = {
        blob, url,
        fileName: (state.file.name || 'file').replace(/\.pdf$/i, '') + '-numbered.pdf',
        pageCount: total,
        totalSize: blob.size,
      };

      state.isProcessing = false;
      showToast(null);
      showSuccess();
    } catch (err) {
      console.error('[AddPageNumbers] save', err);
      state.isProcessing = false;
      showToast('Failed: ' + (err.message || 'Unknown error'), 'error');
      updateBottomBar();
    } finally {
      srcBuf = null;
      libDoc = null;
      bytes  = null;
    }
  }

  /* --------------------------- navigation ---------------------------- */
  function goToPage(idx) {
    if (!state.file || state.file.error) return;
    const total = state.file.pageCount || 1;
    idx = Math.max(0, Math.min(total - 1, idx));
    if (idx === state.currentPage) return;

    state.currentPage = idx;
    updatePageNav();
    updateNumberOverlay();
    updateSummary();
    renderCurrentPage();
  }

  function updatePageNav() {
    const total = state.file?.pageCount || 0;
    if (refs.pageInput) {
      refs.pageInput.value = String(state.currentPage + 1);
      refs.pageInput.max = String(total);
      refs.pageInput.disabled = total <= 0;
    }
    if (refs.totPage) refs.totPage.textContent = String(total);
    if (refs.prevBtn) refs.prevBtn.disabled = state.currentPage <= 0;
    if (refs.nextBtn) refs.nextBtn.disabled = state.currentPage >= total - 1;
  }

  function commitPageInput() {
    const input = refs.pageInput;
    if (!input || !state.file || state.file.error) return;

    const total = state.file.pageCount || 1;
    const raw = String(input.value || '').replace(/\D/g, '');
    let n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) n = 1;
    if (n > total) n = total;

    input.value = String(n);
    if (n - 1 !== state.currentPage) goToPage(n - 1);
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
    const baseName = r.fileName.replace(/\.pdf$/i, '');
    return `
      <div class="w-full flex items-center gap-3 mb-6">
        <div class="w-10 h-10 bg-green-500 rounded-xl flex items-center justify-center shrink-0 shadow-sm">
          <i data-lucide="check" class="text-white" style="width:22px;height:22px;" stroke-width="3"></i>
        </div>
        <h2 class="text-xl font-extrabold text-gray-900 tracking-tight">Numbers Added 🎉</h2>
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
            <p class="text-[16px] font-extrabold text-gray-900 mt-1">${r.pageCount}</p>
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

  function handleDownload() {
    if (!state.result) return;
    const input = state.root?.querySelector('[data-filename]');
    let base = sanitizeFilename(input?.value || '');
    if (!base) base = 'numbered';
    const filename = base.replace(/\.pdf$/i, '') + '.pdf';
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
    if (!base) base = 'numbered';
    const filename = base.replace(/\.pdf$/i, '') + '.pdf';

    try {
      const file = new File([state.result.blob], filename, { type: 'application/pdf' });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: 'Numbered PDF',
          text: 'Numbered with PDFTools',
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
  // pre-populated numbered screen with old settings still applied.
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
           style="animation: pagenum-toast-in .22s cubic-bezier(0.4, 0, 0.2, 1);">
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
          <div class="inline-block max-w-full truncate px-2 py-0.5 rounded-md text-[12px] font-bold bg-num-100 text-num-700">${escapeHtml(f.name)}</div>
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
    const root = state.root;
    if (!root) return;
    const editor = root.querySelector('[data-editor]');
    if (!editor) return;
    const ready = !!state.file && !state.file.error && !state.file.loading && state.file.pageCount;
    editor.classList.toggle('hidden', !ready);
    if (ready) updatePageNav();
  }

  function updateSummary() {
    const el = refs.summary || state.root?.querySelector('[data-summary]');
    if (!el) return;
    const f = state.file;
    if (!f) { el.textContent = 'Add a PDF to get started'; return; }
    if (f.loading) { el.textContent = 'Reading file…'; return; }
    if (f.error) { el.textContent = 'This file cannot be processed'; return; }
    if (state.isProcessing) { el.textContent = 'Adding page numbers…'; return; }

    const s = state.settings;
    let fmtLabel = s.format;
    for (let i = 0; i < FORMATS.length; i++) {
      if (FORMATS[i].value === s.format) { fmtLabel = FORMATS[i].label; break; }
    }
    el.textContent = `${s.fontSize}pt · ${s.position.replace('-', ' ')} · ${fmtLabel}`;
  }

  function updateBottomBar() {
    const btn = refs.saveBtn || state.root?.querySelector('[data-save]');
    if (!btn) return;

    const f = state.file;
    const ready = !!f && !f.loading && !f.error && !!f.pageCount
                  && !state.isProcessing && !!state.jsDoc;

    btn.disabled = !ready;
    btn.innerHTML = state.isProcessing
      ? '<i data-lucide="loader-2" style="width:20px;height:20px;" class="animate-spin"></i><span>Applying…</span>'
      : 'Save PDF <i data-lucide="arrow-right" style="width:20px;height:20px;"></i>';
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
      '@keyframes pagenum-toast-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }',
      '[data-dropzone].is-dragover { background-color: #0E7490 !important; }',
      '[data-dropzone].is-dragover .dz-inner { border-color: rgba(255, 255, 255, 0.9); }',

      '[data-preview-stage-wrap] { display: flex; justify-content: center; }',
      '[data-preview-stage] {',
      '  position: relative;',
      '  border-radius: 0.75rem;',
      '  overflow: hidden;',
      '  background: #ffffff;',
      '  box-shadow: 0 1px 3px rgba(15,23,42,.06), 0 0 0 1px rgba(15,23,42,.08);',
      '}',
      '[data-preview-stage] canvas {',
      '  display: block;',
      '  pointer-events: none;',
      '  background: #ffffff;',
      '}',

      '[data-number-overlay] {',
      '  position: absolute;',
      '  inset: 0;',
      '  pointer-events: none;',
      '  z-index: 2;',
      '}',
      '[data-number-text] {',
      '  position: absolute;',
      '  padding: 0;',
      '  margin: 0;',
      '  user-select: none;',
      '}',

      '[data-pos] {',
      '  display: grid;',
      '  place-items: center;',
      '  height: 36px;',
      '  border: 1.5px solid #d1d5db;',
      '  border-radius: 0.5rem;',
      '  background: #ffffff;',
      '  color: #9ca3af;',
      '  cursor: pointer;',
      '  transition: background-color .12s, border-color .12s, color .12s, transform .08s;',
      '}',
      '[data-pos]:hover { border-color: #A5F3FC; color: #06B6D4; }',
      '[data-pos]:active { transform: scale(0.94); }',
      '[data-pos].is-active {',
      '  background: #06B6D4;',
      '  border-color: #06B6D4;',
      '  color: #ffffff;',
      '}',

      '[data-color-picker] {',
      '  position: relative;',
      '  display: inline-flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  width: 42px;',
      '  height: 42px;',
      '  border-radius: 9999px;',
      '  border: 2px solid #d1d5db;',
      '  padding: 3px;',
      '  background: #ffffff;',
      '  cursor: pointer;',
      '  transition: border-color .12s, transform .08s, box-shadow .12s;',
      '  overflow: hidden;',
      '}',
      '[data-color-picker]:hover { border-color: #06B6D4; transform: scale(1.05); }',
      '[data-color-picker]:active { transform: scale(0.95); }',
      '[data-color-picker]:focus-within {',
      '  border-color: #06B6D4;',
      '  box-shadow: 0 0 0 3px rgba(6, 182, 212, 0.18);',
      '}',
      '[data-color-swatch] {',
      '  display: block;',
      '  width: 100%;',
      '  height: 100%;',
      '  border-radius: 9999px;',
      '  box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.08);',
      '  pointer-events: none;',
      '}',
      '[data-color] {',
      '  position: absolute;',
      '  inset: 0;',
      '  width: 100%;',
      '  height: 100%;',
      '  opacity: 0;',
      '  border: none;',
      '  padding: 0;',
      '  margin: 0;',
      '  cursor: pointer;',
      '  background: transparent;',
      '}',
      '[data-color]::-webkit-color-swatch-wrapper { padding: 0; }',
      '[data-color]::-webkit-color-swatch { border: none; }',
      '[data-color]::-moz-color-swatch { border: none; }',

      '.pn-checkbox {',
      '  appearance: none;',
      '  -webkit-appearance: none;',
      '  width: 1.25rem;',
      '  height: 1.25rem;',
      '  border: 1.5px solid #d1d5db;',
      '  border-radius: 0.375rem;',
      '  background: #ffffff;',
      '  cursor: pointer;',
      '  position: relative;',
      '  transition: border-color .12s, background-color .12s;',
      '  flex-shrink: 0;',
      '}',
      '.pn-checkbox:checked { background: #06B6D4; border-color: #06B6D4; }',
      '.pn-checkbox:checked::after {',
      '  content: "";',
      '  position: absolute;',
      '  left: 4px; top: 1px;',
      '  width: 8px; height: 12px;',
      '  border: solid #ffffff;',
      '  border-width: 0 2px 2px 0;',
      '  transform: rotate(45deg);',
      '}',

      '[data-font-size], [data-margin] {',
      '  -webkit-appearance: none;',
      '  appearance: none;',
      '  height: 4px;',
      '  border-radius: 9999px;',
      '  background: #e5e7eb;',
      '  outline: none;',
      '  cursor: pointer;',
      '  width: 100%;',
      '}',
      '[data-font-size]::-webkit-slider-thumb, [data-margin]::-webkit-slider-thumb {',
      '  -webkit-appearance: none;',
      '  width: 18px; height: 18px;',
      '  border-radius: 50%;',
      '  background: #06B6D4;',
      '  border: 2px solid #ffffff;',
      '  box-shadow: 0 1px 4px rgba(15,23,42,.2);',
      '  cursor: pointer;',
      '}',
      '[data-font-size]::-moz-range-thumb, [data-margin]::-moz-range-thumb {',
      '  width: 18px; height: 18px;',
      '  border-radius: 50%;',
      '  background: #06B6D4;',
      '  border: 2px solid #ffffff;',
      '  box-shadow: 0 1px 4px rgba(15,23,42,.2);',
      '  cursor: pointer;',
      '}',

      '[data-format] {',
      '  appearance: none;',
      '  -webkit-appearance: none;',
      '  background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'14\' height=\'14\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%236B7280\' stroke-width=\'2\' stroke-linecap=\'round\' stroke-linejoin=\'round\'%3E%3Cpolyline points=\'6 9 12 15 18 9\'/%3E%3C/svg%3E");',
      '  background-repeat: no-repeat;',
      '  background-position: right 0.75rem center;',
      '  background-size: 14px;',
      '  padding-right: 2.25rem;',
      '}',

      '[data-page-input] {',
      '  -moz-appearance: textfield;',
      '  appearance: textfield;',
      '  width: 3rem;',
      '  padding: 0.3rem 0.4rem;',
      '  text-align: center;',
      '  font-weight: 700;',
      '  font-size: 0.8125rem;',
      '  line-height: 1;',
      '  color: #0f172a;',
      '  background: #ffffff;',
      '  border: 1.5px solid #cbd5e1;',
      '  border-radius: 0.5rem;',
      '  outline: none;',
      '  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);',
      '  transition: border-color .15s, background-color .15s, box-shadow .15s;',
      '  cursor: text;',
      '}',
      '[data-page-input]:hover:not(:disabled):not(:focus) { border-color: #94a3b8; }',
      '[data-page-input]:focus {',
      '  border-color: #06B6D4;',
      '  box-shadow: 0 0 0 3px rgba(6, 182, 212, 0.18);',
      '}',
      '[data-page-input]::-webkit-outer-spin-button,',
      '[data-page-input]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }',
      '[data-page-input]:disabled { opacity: 0.5; cursor: not-allowed; }',

      '[data-start-num]::-webkit-outer-spin-button,',
      '[data-start-num]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }',
      '[data-start-num] { -moz-appearance: textfield; }',
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
    if (t.closest('[data-save]'))        { applyNumbers(); return; }
    if (t.closest('[data-download]'))    { handleDownload(); return; }
    if (t.closest('[data-share]'))       { handleShare(); return; }
    if (t.closest('[data-start-over]'))  { startOver(); return; }

    if (t.closest('[data-prev-page]'))   { goToPage(state.currentPage - 1); return; }
    if (t.closest('[data-next-page]'))   { goToPage(state.currentPage + 1); return; }

    const posBtn = t.closest('[data-pos]');
    if (posBtn) { setSetting('position', posBtn.getAttribute('data-pos')); return; }

    if (t.closest('[data-menu-toggle]')) {
      const dd = refs.menuDropdown || state.root.querySelector('[data-menu-dropdown]');
      if (dd) dd.classList.toggle('hidden');
      return;
    }

    if (t.closest('[data-menu-reset]')) {
      state.settings = { ...DEFAULTS };
      applySettingsToUI();
      scheduleOverlayUpdate();
      updateSummary();
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
    if (t.matches('[data-page-input]')) {
      const total = state.file?.pageCount || 1;
      const maxLen = String(total).length;
      const cleaned = String(t.value || '').replace(/\D/g, '').slice(0, maxLen);
      if (cleaned !== t.value) t.value = cleaned;
      return;
    }
    if (t.matches('[data-format]'))     { setSetting('format', t.value); return; }
    if (t.matches('[data-color]'))      { setSetting('color', normalizeHex(t.value)); return; }
    if (t.matches('[data-font-size]'))  { setSetting('fontSize', parseInt(t.value, 10) || 12); return; }
    if (t.matches('[data-margin]'))     { setSetting('margin',   parseInt(t.value, 10) || 30); return; }
    if (t.matches('[data-start-num]')) {
      const total = state.file?.pageCount || 1000;
      let v = parseInt(t.value, 10);
      if (!Number.isFinite(v) || v < 0) v = 0;
      if (v > total) v = total;
      setSetting('startNumber', v);
      return;
    }
    if (t.matches('[data-bold]'))       { setSetting('bold',      t.checked); return; }
    if (t.matches('[data-skip-first]')) { setSetting('skipFirst', t.checked); return; }
  }

  function handleFocusIn(e) {
    if (e.target.matches('[data-filename]') || e.target.matches('[data-page-input]')) {
      try { e.target.select(); } catch (err) {}
    }
  }

  function handleFocusOut(e) {
    if (e.target.matches('[data-page-input]')) { commitPageInput(); return; }
    if (e.target.matches('[data-start-num]')) {
      const total = state.file?.pageCount || 1000;
      let v = parseInt(e.target.value, 10);
      if (!Number.isFinite(v) || v < 0) v = 0;
      if (v > total) v = total;
      e.target.value = String(v);
      setSetting('startNumber', v);
    }
  }

  function handleKeyDown(e) {
    const t = e.target;

    if (t.matches('[data-filename]') && e.key === 'Enter') {
      e.preventDefault(); handleDownload(); return;
    }
    if (t.matches('[data-page-input]')) {
      if (e.key === 'Enter')      { e.preventDefault(); commitPageInput(); try { t.blur(); } catch (err) {} }
      else if (e.key === 'Escape'){ e.preventDefault(); t.value = String(state.currentPage + 1); try { t.blur(); } catch (err) {} }
      else if (e.key === 'ArrowUp')   { e.preventDefault(); const total = state.file?.pageCount || 1; const cur = parseInt(t.value, 10) || 1; t.value = String(Math.min(total, cur + 1)); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); const cur = parseInt(t.value, 10) || 1; t.value = String(Math.max(1, cur - 1)); }
      return;
    }
    if (t.matches('[data-start-num]') && e.key === 'Enter') {
      e.preventDefault(); try { t.blur(); } catch (err) {}
    }
  }

  function handleResize() {
    if (!state.file || state.file.error || state.file.loading || !state.jsDoc) return;
    if (resizeRafId) return;
    resizeRafId = requestAnimationFrame(() => {
      resizeRafId = null;
      renderCurrentPage();
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
  function positionButtonHtml(pos) {
    const rowMap = { top: 0, bottom: 1 };
    const colMap = { left: 0, center: 1, right: 2 };
    const parts = pos.split('-');
    const r = rowMap[parts[0]];
    const c = colMap[parts[1]];

    const cells = [];
    for (let i = 0; i < 6; i++) {
      const ri = Math.floor(i / 3);
      const ci = i % 3;
      const active = ri === r && ci === c;
      cells.push('<span class="rounded-full ' + (active ? 'bg-current' : 'bg-current opacity-20') + '"></span>');
    }

    return '' +
      '<button type="button" data-pos="' + pos + '" aria-label="' + pos.replace('-', ' ') + '">' +
        '<span class="grid h-4 w-5 grid-cols-3 grid-rows-2 gap-px">' + cells.join('') + '</span>' +
      '</button>';
  }

  function formatOptionsHtml() {
    return FORMATS.map(f =>
      '<option value="' + f.value + '">' + escapeHtml(f.label) + '</option>'
    ).join('');
  }

  function template() {
    return `
      <div class="pagenum-root min-h-screen bg-white flex flex-col">

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
                  <path d="M18.5 6.5V11a1 1 0 0 0 1 1H24" fill="#A5F3FC"/>
                  <rect x="13" y="15.5" width="7" height="1.6" rx="0.8" fill="${BRAND}"/>
                  <rect x="13" y="19.5" width="5" height="1.6" rx="0.8" fill="${BRAND}"/>
                </svg>
              </span>
              <span class="text-[16px] font-extrabold tracking-tight text-gray-900">
                Page<span style="color:${BRAND}">Numbers</span>
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
                     style="animation: pagenum-toast-in .15s cubic-bezier(0.4,0,0.2,1);">
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
                   class="group relative block cursor-pointer rounded-2xl bg-num-500 px-4 py-8 text-center transition-all duration-200 hover:bg-num-600 focus-within:outline-none sm:px-8 sm:py-10">
              <div class="dz-inner absolute inset-3.5 rounded-xl border-2 border-dashed border-white/60 transition-colors duration-200"></div>
              <input type="file" data-file-input accept=".pdf,application/pdf" hidden />

              <div class="relative z-10 flex flex-col items-center justify-center min-h-[180px] sm:min-h-[210px]">
                <svg width="130" height="84" viewBox="0 0 130 84" fill="none" xmlns="http://www.w3.org/2000/svg" class="mb-5">
                  <!-- Page paper -->
                  <rect x="35" y="4" width="60" height="76" rx="5" fill="white"/>

                  <!-- Faint content lines -->
                  <rect x="45" y="15" width="40" height="2.5" rx="1.25" fill="#A5F3FC"/>
                  <rect x="45" y="22" width="28" height="2.5" rx="1.25" fill="#A5F3FC"/>
                  <rect x="45" y="29" width="34" height="2.5" rx="1.25" fill="#A5F3FC"/>

                  <!-- Bold page-number badge: big "1" in a circle -->
                  <circle cx="65" cy="54" r="14" fill="#06B6D4"/>
                  <path d="M62 52 L68 46 L68 62" stroke="white" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
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

              <div class="mb-3 flex items-center justify-between gap-2">
                <button type="button" data-prev-page aria-label="Previous page"
                        class="grid h-9 w-9 place-items-center rounded-full border border-gray-200 bg-white text-gray-700 transition hover:border-num-300 hover:text-num-600 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40">
                  <i data-lucide="chevron-left" style="width:16px;height:16px;"></i>
                </button>

                <p class="flex items-center gap-1.5 text-[12px] font-medium text-gray-900">
                  Page
                  <input type="text" inputmode="numeric" autocomplete="off" spellcheck="false"
                         data-page-input value="1" disabled aria-label="Current page" />
                  of <span data-total-pages class="font-bold text-gray-900">1</span>
                </p>

                <button type="button" data-next-page aria-label="Next page"
                        class="grid h-9 w-9 place-items-center rounded-full border border-gray-200 bg-white text-gray-700 transition hover:border-num-300 hover:text-num-600 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40">
                  <i data-lucide="chevron-right" style="width:16px;height:16px;"></i>
                </button>
              </div>

              <div data-preview-stage-wrap class="relative">
                <div data-preview-stage>
                  <canvas data-page-canvas></canvas>
                  <div data-number-overlay>
                    <div data-number-text>1</div>
                  </div>
                </div>
              </div>

              <p class="mt-2 text-center text-[11px] text-gray-900">
                Live preview · adjust options below
              </p>

              <div class="mt-5 rounded-2xl border border-gray-200 bg-white p-4">

                <label class="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-gray-900">Position</label>
                <div data-pos-grid class="grid grid-cols-3 gap-1.5 max-w-[12rem] mx-auto">
                  ${POSITIONS.map(positionButtonHtml).join('')}
                </div>

                <div class="mt-4">
                  <label class="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-gray-900">Format</label>
                  <select data-format class="w-full rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 text-[14px] font-medium text-gray-900 outline-none transition focus:border-num-400 focus:ring-4 focus:ring-num-500/10">
                    ${formatOptionsHtml()}
                  </select>
                </div>

                <div class="mt-4">
                  <label class="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-gray-900">Color</label>
                  <div class="flex items-center gap-3">
                    <label data-color-picker title="Pick any color">
                      <span data-color-swatch style="background:#000000;"></span>
                      <input type="color" data-color value="#000000" aria-label="Number color" />
                    </label>
                    <span data-color-hex class="font-mono text-[12px] font-bold uppercase text-gray-900">#000000</span>
                  </div>
                </div>

                <div class="mt-4 grid gap-3 sm:grid-cols-2">
                  <div>
                    <div class="mb-1.5 flex items-center justify-between">
                      <label class="text-[11px] font-bold uppercase tracking-wider text-gray-900">Font size</label>
                      <span data-font-size-val class="text-[11px] font-bold text-gray-900">12pt</span>
                    </div>
                    <input type="range" data-font-size min="8" max="32" step="1" value="12" class="w-full" />
                  </div>
                  <div>
                    <div class="mb-1.5 flex items-center justify-between">
                      <label class="text-[11px] font-bold uppercase tracking-wider text-gray-900">Margin</label>
                      <span data-margin-val class="text-[11px] font-bold text-gray-900">30pt</span>
                    </div>
                    <input type="range" data-margin min="10" max="80" step="1" value="30" class="w-full" />
                  </div>
                </div>

                <div class="mt-4">
                  <label class="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-gray-900">Starting number</label>
                  <input type="number" data-start-num min="0" step="1" value="1" inputmode="numeric" autocomplete="off"
                         class="w-full rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 text-[14px] font-bold text-gray-900 outline-none transition focus:border-num-400 focus:ring-4 focus:ring-num-500/10" />
                </div>

                <div class="mt-4 space-y-2.5">
                  <label class="flex cursor-pointer items-center gap-3">
                    <input type="checkbox" data-bold class="pn-checkbox" />
                    <span class="text-[13px] font-medium text-gray-900">Bold text</span>
                  </label>
                  <label class="flex cursor-pointer items-center gap-3">
                    <input type="checkbox" data-skip-first class="pn-checkbox" />
                    <span class="text-[13px] font-medium text-gray-900">Skip first page (e.g. cover)</span>
                  </label>
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
              Save PDF <i data-lucide="arrow-right" style="width:20px;height:20px;"></i>
            </button>
          </div>
        </div>

        <div data-status class="pointer-events-none fixed inset-x-0 top-20 z-50 flex justify-center px-4"></div>

      </div>
    `;
  }

  /* ---------------------------- public API --------------------------- */
  async function render(rootEl, options) {
    if (!rootEl) throw new Error('AddPageNumbers.render: missing root element');

    await ensurePdfJs();

    if (state.root) {
      try { destroy(); } catch (e) {}
    }

    state.cleanup = [];
    state.file = null;
    state.jsDoc = null;
    state.isProcessing = false;
    state.gen = 0;
    state.currentPage = 0;
    state.settings = { ...DEFAULTS };
    state.root = rootEl;
    state.onBack = options?.onBack || null;
    state.statusTimer = null;
    state.result = null;
    renderToken = 0;
    activeRenderTask = null;

    injectStyles();
    rootEl.innerHTML = template();
    cacheRefs();
    refreshIcons();
    applySettingsToUI();

    rootEl.addEventListener('click', handleClick);
    rootEl.addEventListener('input', handleInput);
    rootEl.addEventListener('change', handleInput);
    rootEl.addEventListener('focusin', handleFocusIn);
    rootEl.addEventListener('focusout', handleFocusOut);
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
    renderToken++;

    if (overlayRafId) { cancelAnimationFrame(overlayRafId); overlayRafId = null; }
    if (resizeRafId)  { cancelAnimationFrame(resizeRafId);  resizeRafId = null; }

    if (state.root) {
      state.root.removeEventListener('click', handleClick);
      state.root.removeEventListener('input', handleInput);
      state.root.removeEventListener('change', handleInput);
      state.root.removeEventListener('focusin', handleFocusIn);
      state.root.removeEventListener('focusout', handleFocusOut);
      state.root.removeEventListener('keydown', handleKeyDown);
    }
    document.removeEventListener('click', handleDocumentClick);
    document.removeEventListener('keydown', handleGlobalKey);
    window.removeEventListener('resize', handleResize);

    cancelActiveRender();
    destroyJsDoc();
    revokeResultUrl();
    releaseCanvas(refs.canvas);
    releaseSourceFile();

    state.cleanup.forEach(fn => { try { fn(); } catch (e) {} });
    state.cleanup = [];
    state.file = null;
    state.root = null;
    state.statusTimer = null;

    refs.canvas       = null;
    refs.stage        = null;
    refs.stageWrap    = null;
    refs.overlay      = null;
    refs.overlayText  = null;
    refs.summary      = null;
    refs.saveBtn      = null;
    refs.pageInput    = null;
    refs.totPage      = null;
    refs.prevBtn      = null;
    refs.nextBtn      = null;
    refs.posGrid      = null;
    refs.colorInput   = null;
    refs.colorSwatch  = null;
    refs.colorHex     = null;
    refs.fmt          = null;
    refs.bold         = null;
    refs.skipFirst    = null;
    refs.fs           = null;
    refs.fsVal        = null;
    refs.mg           = null;
    refs.mgVal        = null;
    refs.startNum     = null;
    refs.dropzone     = null;
    refs.fileCard     = null;
    refs.fileInput    = null;
    refs.clearBtn     = null;
    refs.menuWrap     = null;
    refs.menuDropdown = null;
    refs.title        = null;
    refs.workWs       = null;
    refs.successWs    = null;
    refs.bottomBar    = null;
    refs.status       = null;
  }

  window.AddPageNumbers = { render, destroy };
})();