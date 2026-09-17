/* =====================================================================
 * ReorderRotateDeletePages.js — PDFTools organize pages module
 * Organize a single PDF: reorder, rotate, delete, move-to-position,
 * and preview pages. Custom O(1) pointer-event drag.
 * Theme: violet brand mark in the workspace header (matches the HTML);
 *        blue action elements (Save, Download, Share, Move confirm).
 * Depends on (auto-loaded if missing):
 *   - pdf-lib  (PDF manipulation, save)
 *   - pdf.js   (page thumbnail rendering)
 *   - lucide   (icons, expected on host page)
 * ===================================================================== */
(function () {
  'use strict';

  const PDFLIB_CDN   = 'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js';
  const PDFJS_CDN    = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
  const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  const STYLE_ID     = 'org-pages-styles';

  // Violet brand mark (matches ReorderRotateDeletePages.html accents)
  const BRAND = '#8B5CF6';

  const SVG_SPINNER =
    '<svg class="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';
  const SVG_ALERT =
    '<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';

  const state = {
    file: null,
    pages: [],
    originalSnapshot: null,
    pdfDoc: null,
    gen: 0,
    isProcessing: false,
    root: null,
    onBack: null,
    cleanup: [],
    statusTimer: null,
    result: null,
    previewModal: null,
    previewPageId: null,
    previewToken: 0,
    previewImageLoaded: false,
    moveModal: null,
    moveTargetId: null,
  };

  let thumbObserver   = null;
  let thumbQueue      = [];
  let thumbRendering  = false;
  let thumbCanvas     = null;
  let previewCanvas   = null;
  let previewResizeRaf = null;

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
    if (!window.PDFLib)   await loadScript(PDFLIB_CDN);
    if (!window.pdfjsLib) await loadScript(PDFJS_CDN);
    if (window.pdfjsLib && window.pdfjsLib.GlobalWorkerOptions) {
      try { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; } catch (e) {}
    }
  }

  function revokeResultUrl() {
    if (state.result?.url) {
      try { URL.revokeObjectURL(state.result.url); } catch (e) {}
    }
    state.result = null;
  }

  function destroyPdfDoc() {
    if (state.pdfDoc) {
      try { state.pdfDoc.destroy(); } catch (e) {}
      state.pdfDoc = null;
    }
  }

  function releaseSourceFile() {
    if (state.file) state.file.file = null;
  }

  function revokeAllThumbUrls() {
    for (let i = 0; i < state.pages.length; i++) {
      const item = state.pages[i];
      if (item && item.thumb) {
        try { URL.revokeObjectURL(item.thumb); } catch (e) {}
        item.thumb = null;
      }
    }
  }

  /* --------------------------- thumb observer ------------------------ */
  function ensureThumbObserver() {
    if (!thumbObserver) {
      thumbObserver = new IntersectionObserver(onThumbIntersection, {
        root: null,
        rootMargin: '400px 0px',
        threshold: 0.01,
      });
    }
    return thumbObserver;
  }

  function onThumbIntersection(entries) {
    if (!state.pdfDoc) return;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry.isIntersecting) continue;
      const card = entry.target;
      if (!card) continue;
      const id = card.getAttribute('data-card-id');
      if (!id) continue;
      const item = findPage(id);
      if (!item) continue;
      if (item.thumb || item.thumbError) {
        thumbObserver.unobserve(card);
        continue;
      }
      thumbObserver.unobserve(card);
      thumbQueue.push(item);
    }
    processThumbQueue();
  }

  async function processThumbQueue() {
    if (thumbRendering) return;
    if (!state.pdfDoc) return;
    thumbRendering = true;
    try {
      while (thumbQueue.length) {
        if (!state.pdfDoc) { thumbQueue = []; break; }
        const myGen = state.gen;
        const item = thumbQueue.shift();
        if (!item) continue;
        if (state.pages.indexOf(item) === -1) continue;
        if (item.thumb || item.thumbError) continue;
        await renderOneThumb(state.pdfDoc, item, myGen);
        await new Promise(r => setTimeout(r, 0));
      }
    } finally {
      thumbRendering = false;
    }
  }

  function observeCards() {
    if (!state.pdfDoc) return;
    const gridEl = state.root?.querySelector('[data-pages-grid]');
    if (!gridEl) return;
    const observer = ensureThumbObserver();
    observer.disconnect();
    const cards = gridEl.querySelectorAll('.page-card[data-card-id]');
    for (let i = 0; i < cards.length; i++) observer.observe(cards[i]);
  }

  function disconnectThumbObserver() {
    if (thumbObserver) {
      try { thumbObserver.disconnect(); } catch (e) {}
    }
    thumbQueue = [];
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

    revokeAllThumbUrls();
    disconnectThumbObserver();
    revokeResultUrl();
    destroyPdfDoc();
    closePreview();
    closeMoveModal();
    closeMenu();
    releaseSourceFile();
    const myGen = ++state.gen;

    state.file = { file: f, name: f.name, size: f.size, pageCount: null, loading: true, error: null };
    state.pages = [];
    state.originalSnapshot = null;

    renderUploadedFile();
    renderPagesGrid();
    updateBottomBar();

    try {
      const buf = await f.arrayBuffer();
      if (myGen !== state.gen) return;

      const doc = await window.PDFLib.PDFDocument.load(buf, { ignoreEncryption: true });
      if (myGen !== state.gen) return;

      const pageCount = doc.getPageCount();
      state.file.pageCount = pageCount;
      state.file.loading = false;

      state.pages = [];
      for (let i = 0; i < pageCount; i++) {
        state.pages.push({
          id: uid(), sourceIndex: i, rotation: 0,
          thumb: null, thumbLoading: true, thumbError: false,
        });
      }
      state.originalSnapshot = { pageCount, order: state.pages.map(p => p.id) };

      renderUploadedFile();
      renderPagesGrid();
      updateBottomBar();

      loadPdfJsAndRender(buf, myGen);
    } catch (err) {
      console.error('[OrganizePages]', err);
      if (myGen !== state.gen) return;
      if (!state.file) return;
      state.file.loading = false;
      state.file.error = 'Unreadable or encrypted';
      renderUploadedFile();
      updateBottomBar();
    }
  }

  function removeFile() {
    revokeAllThumbUrls();
    disconnectThumbObserver();
    state.gen += 1;
    destroyPdfDoc();
    revokeResultUrl();
    closePreview();
    closeMoveModal();
    closeMenu();
    releaseSourceFile();
    state.file = null;
    state.pages = [];
    state.originalSnapshot = null;
    renderUploadedFile();
    renderPagesGrid();
    updateBottomBar();
  }

  /* --------------------------- thumbnails ---------------------------- */
  async function loadPdfJsAndRender(arrayBuffer, myGen) {
    try {
      const pdfDoc = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      if (myGen !== state.gen) { try { pdfDoc.destroy(); } catch (e) {} return; }
      if (state.pdfDoc && state.pdfDoc !== pdfDoc) {
        try { state.pdfDoc.destroy(); } catch (e) {}
      }
      state.pdfDoc = pdfDoc;
      observeCards();
    } catch (err) {
      console.error('[OrganizePages] thumbs', err);
    }
  }

  async function renderOneThumb(pdfDoc, item, myGen) {
    let pdfPage = null;
    try {
      pdfPage = await pdfDoc.getPage(item.sourceIndex + 1);
      if (myGen !== state.gen) return;

      const baseVp = pdfPage.getViewport({ scale: 1 });
      const scale = 260 / baseVp.width;
      const vp = pdfPage.getViewport({ scale });

      if (!thumbCanvas) thumbCanvas = document.createElement('canvas');
      const canvas = thumbCanvas;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width  = Math.round(vp.width  * dpr);
      canvas.height = Math.round(vp.height * dpr);

      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      await pdfPage.render({ canvasContext: ctx, viewport: vp }).promise;
      if (myGen !== state.gen) return;

      const blob = await new Promise((resolve, reject) => {
        try {
          canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob null'))), 'image/jpeg', 0.72);
        } catch (e) { reject(e); }
      });
      if (myGen !== state.gen) return;

      if (item.thumb) { try { URL.revokeObjectURL(item.thumb); } catch (e) {} }
      item.thumb = URL.createObjectURL(blob);
      item.thumbLoading = false;
      updateCardThumb(item.id);
    } catch (err) {
      if (myGen !== state.gen) return;
      item.thumb = null;
      item.thumbLoading = false;
      item.thumbError = true;
      updateCardThumb(item.id);
    } finally {
      if (pdfPage) { try { pdfPage.cleanup(); } catch (e) {} }
    }
  }

  /* ---------------------------- actions ------------------------------ */
  function findPage(id) { return state.pages.find(p => p.id === id); }

  function rotatePage(id, delta) {
    const p = findPage(id);
    if (!p) return;
    p.rotation = ((p.rotation + delta) % 360 + 360) % 360;
    updateCardRotation(p.id);
    if (state.previewPageId === p.id) fitPreviewImage();
    updateSummary();
  }

  function rotateAll(delta) {
    if (!state.pages.length) return;
    state.pages.forEach(p => {
      p.rotation = ((p.rotation + delta) % 360 + 360) % 360;
      updateCardRotation(p.id);
    });
    if (state.previewPageId) fitPreviewImage();
    updateSummary();
  }

  function deletePage(id) {
    const idx = state.pages.findIndex(p => p.id === id);
    if (idx === -1) return;
    const removed = state.pages[idx];

    if (removed && removed.thumb) {
      try { URL.revokeObjectURL(removed.thumb); } catch (e) {}
      removed.thumb = null;
    }

    state.pages.splice(idx, 1);
    if (state.previewPageId === id) closePreview();
    if (state.moveTargetId === id) closeMoveModal();

    const card = state.root?.querySelector(`[data-card-id="${id}"]`);
    if (card) {
      if (thumbObserver) {
        try { thumbObserver.unobserve(card); } catch (e) {}
      }
      card.style.transition = 'opacity .18s ease, transform .18s ease';
      card.style.opacity = '0';
      card.style.transform = 'scale(0.92)';
      setTimeout(() => { card.remove(); updateGridEmptyState(); }, 180);
    }
    updatePageCount();
    updateBottomBar();
  }

  function performMove(pageId, targetIndex) {
    const idx = state.pages.findIndex(p => p.id === pageId);
    if (idx === -1) return;

    if (targetIndex < 0) targetIndex = 0;
    if (targetIndex > state.pages.length - 1) targetIndex = state.pages.length - 1;
    if (targetIndex === idx) {
      showToast('Already at that position', 'info');
      return;
    }

    const [item] = state.pages.splice(idx, 1);
    state.pages.splice(targetIndex, 0, item);

    const gridEl = state.root?.querySelector('[data-pages-grid]');
    const card = gridEl?.querySelector('[data-card-id="' + pageId + '"]');
    if (card && gridEl) {
      card.remove();
      const cards = Array.from(gridEl.children);
      if (targetIndex >= cards.length) {
        gridEl.appendChild(card);
      } else {
        gridEl.insertBefore(card, cards[targetIndex]);
      }

      card.style.transition = 'box-shadow .35s ease';
      card.style.boxShadow = '0 0 0 3px rgba(37,99,235,.65)';
      setTimeout(() => { card.style.boxShadow = ''; }, 650);
      try { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
    }

    updateSummary();
    showToast('Moved to position ' + (targetIndex + 1), 'success');
  }

  function resetAll() {
    if (!state.originalSnapshot) return;
    closePreview();
    closeMoveModal();

    revokeAllThumbUrls();
    disconnectThumbObserver();

    const myGen = ++state.gen;

    state.pages = [];
    for (let i = 0; i < state.originalSnapshot.pageCount; i++) {
      state.pages.push({
        id: state.originalSnapshot.order[i],
        sourceIndex: i, rotation: 0,
        thumb: null, thumbLoading: true, thumbError: false,
      });
    }

    renderPagesGrid();
    updateBottomBar();

    if (!state.pdfDoc && state.file?.file) {
      state.file.file.arrayBuffer().then(buf => {
        if (myGen !== state.gen) return;
        loadPdfJsAndRender(buf, myGen);
      });
    }

    showToast('Restored to original', 'success');
  }

  /* ------------------------------ save ------------------------------- */
  async function applyChanges() {
    if (state.isProcessing || !state.file || state.file.error || !state.file.file) return;
    if (!state.pages.length) { showToast('No pages to save.', 'error'); return; }

    state.isProcessing = true;
    updateBottomBar();
    showToast('Building PDF…', 'info', 0);

    let buf = null;
    let src = null;
    let out = null;

    try {
      buf = await state.file.file.arrayBuffer();
      src = await window.PDFLib.PDFDocument.load(buf, { ignoreEncryption: true });
      buf = null;

      out = await window.PDFLib.PDFDocument.create();

      const indicesToCopy = state.pages.map(item => item.sourceIndex);
      const copiedPages = await out.copyPages(src, indicesToCopy);

      for (let i = 0; i < state.pages.length; i++) {
        const item = state.pages[i];
        const copied = copiedPages[i];
        if (!copied) continue;

        const baseAngle = copied.getRotation()?.angle || 0;
        const finalAngle = ((baseAngle + item.rotation) % 360 + 360) % 360;
        copied.setRotation(window.PDFLib.degrees(finalAngle));

        out.addPage(copied);
      }

      src = null;

      let bytes = await out.save();
      out = null;

      const blob = new Blob([bytes], { type: 'application/pdf' });
      const totalSize = bytes.byteLength;
      bytes = null;

      const url = URL.createObjectURL(blob);

      revokeResultUrl();
      state.result = {
        blob, url,
        fileName: (state.file.name || 'file').replace(/\.pdf$/i, '') + '-organized.pdf',
        pageCount: state.pages.length,
        totalSize,
      };

      state.isProcessing = false;
      showToast(null);
      showSuccess();
    } catch (err) {
      console.error('[OrganizePages] save', err);
      buf = null;
      src = null;
      out = null;
      state.isProcessing = false;
      showToast('Failed: ' + (err.message || 'Unknown error'), 'error');
      updateBottomBar();
    }
  }

  /* ---------------------------- preview ------------------------------ */
  function createPreviewModal() {
    const el = document.createElement('div');
    el.setAttribute('data-preview-modal', '');
    el.className = 'hidden fixed inset-0 z-[60]';

    el.innerHTML = `
      <div class="absolute inset-0 bg-gray-900/85 backdrop-blur-sm" data-preview-backdrop></div>
      <div class="relative z-10 flex h-full w-full flex-col">

        <div class="flex shrink-0 items-center justify-between px-4 py-3 text-white"
             style="padding-top: max(0.75rem, env(safe-area-inset-top, 0.75rem));">
          <span data-preview-label
                class="grid h-8 min-w-[2.25rem] place-items-center rounded-lg bg-white/15 px-2.5 text-xs font-bold backdrop-blur">
            Page 1
          </span>
          <button type="button" data-preview-close aria-label="Close preview"
                  class="grid h-9 w-9 place-items-center rounded-full bg-white/10 text-white backdrop-blur transition hover:bg-white/20 active:scale-95">
            <i data-lucide="x" class="h-5 w-5"></i>
          </button>
        </div>

        <div data-preview-stage
             class="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-4 py-2">
          <div data-preview-imgwrap class="relative inline-flex max-h-full max-w-full items-center justify-center">
            <img data-preview-img alt="Page preview" draggable="false"
                 class="block max-h-full max-w-full select-none rounded-lg object-contain shadow-2xl transition-transform duration-300"
                 style="transform-origin:center center;" />
            <div data-preview-loading
                 class="absolute inset-0 grid place-items-center rounded-lg bg-gray-800/40 backdrop-blur-[1px]">
              <i data-lucide="loader-2" class="h-6 w-6 animate-spin text-white"></i>
            </div>
          </div>
        </div>

        <div class="flex shrink-0 items-center justify-center gap-2 px-4 pt-3"
             style="padding-bottom: max(1.25rem, env(safe-area-inset-bottom, 1.25rem));">
          <button type="button" data-preview-rotate-left aria-label="Rotate left"
                  class="grid h-11 w-11 place-items-center rounded-full bg-white/10 text-white backdrop-blur transition hover:bg-white/20 active:scale-95">
            <i data-lucide="rotate-ccw" class="h-5 w-5"></i>
          </button>
          <button type="button" data-preview-rotate-right aria-label="Rotate right"
                  class="grid h-11 w-11 place-items-center rounded-full bg-white/10 text-white backdrop-blur transition hover:bg-white/20 active:scale-95">
            <i data-lucide="rotate-cw" class="h-5 w-5"></i>
          </button>
          <button type="button" data-preview-move aria-label="Move page"
                  class="grid h-11 w-11 place-items-center rounded-full bg-white/10 text-white backdrop-blur transition hover:bg-white/20 active:scale-95">
            <i data-lucide="arrow-right-to-line" class="h-5 w-5"></i>
          </button>
          <button type="button" data-preview-delete aria-label="Delete page"
                  class="ml-2 grid h-11 w-11 place-items-center rounded-full bg-rose-500/20 text-rose-200 backdrop-blur transition hover:bg-rose-500/35 hover:text-white active:scale-95">
            <i data-lucide="trash-2" class="h-5 w-5"></i>
          </button>
        </div>

      </div>
    `;
    el.addEventListener('click', handlePreviewClick);
    return el;
  }

  function handlePreviewClick(e) {
    const t = e.target;
    if (t.closest('[data-preview-backdrop]') || t.closest('[data-preview-close]')) { closePreview(); return; }
    if (t.closest('[data-preview-rotate-left]'))  { rotatePage(state.previewPageId, -90); return; }
    if (t.closest('[data-preview-rotate-right]')) { rotatePage(state.previewPageId,  90); return; }
    if (t.closest('[data-preview-move]')) {
      const id = state.previewPageId;
      closePreview();
      if (id) openMoveModal(id);
      return;
    }
    if (t.closest('[data-preview-delete]')) {
      const id = state.previewPageId;
      closePreview();
      if (id) deletePage(id);
    }
  }

  function fitPreviewImage() {
    const modal = state.previewModal;
    if (!modal) return;

    const stage = modal.querySelector('[data-preview-stage]');
    const img   = modal.querySelector('[data-preview-img]');
    const item  = findPage(state.previewPageId);
    if (!stage || !img || !item) return;

    const rot = item.rotation || 0;
    const isQuarter = (rot === 90 || rot === 270);

    const cs = getComputedStyle(stage);
    const padX = (parseFloat(cs.paddingLeft)   || 0) + (parseFloat(cs.paddingRight)  || 0);
    const padY = (parseFloat(cs.paddingTop)    || 0) + (parseFloat(cs.paddingBottom) || 0);

    const availW = Math.max(1, stage.clientWidth  - padX);
    const availH = Math.max(1, stage.clientHeight - padY);

    if (isQuarter) {
      img.style.maxWidth  = availH + 'px';
      img.style.maxHeight = availW + 'px';
    } else {
      img.style.maxWidth  = availW + 'px';
      img.style.maxHeight = availH + 'px';
    }

    img.style.transform = 'rotate(' + rot + 'deg)';
  }

  function handlePreviewResize() {
    if (!state.previewPageId) return;
    if (previewResizeRaf) cancelAnimationFrame(previewResizeRaf);
    previewResizeRaf = requestAnimationFrame(() => {
      previewResizeRaf = null;
      fitPreviewImage();
    });
  }

  async function openPreview(pageId) {
    const item = findPage(pageId);
    if (!item) return;

    if (!state.previewModal) {
      state.previewModal = createPreviewModal();
      document.body.appendChild(state.previewModal);
    }

    const modal   = state.previewModal;
    const img     = modal.querySelector('[data-preview-img]');
    const label   = modal.querySelector('[data-preview-label]');
    const loading = modal.querySelector('[data-preview-loading]');

    state.previewPageId = pageId;
    state.previewToken += 1;
    state.previewImageLoaded = false;
    const myToken = state.previewToken;

    label.textContent = `Page ${item.sourceIndex + 1}`;

    img.onload = null;
    img.removeAttribute('src');
    img.style.maxWidth  = '';
    img.style.maxHeight = '';
    img.style.transform = 'rotate(' + (item.rotation || 0) + 'deg)';
    img.style.display   = 'none';

    loading.classList.remove('hidden');
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    refreshIcons();

    let dataUrl = null;
    try {
      if (state.pdfDoc) {
        try { dataUrl = await renderHighResPage(state.pdfDoc, item); } catch (err) { console.error(err); }
      }
      if (myToken !== state.previewToken) return;
      if (!dataUrl && item.thumb) dataUrl = item.thumb;
    } catch (err) {
      console.error('[OrganizePages] preview', err);
    }

    if (myToken !== state.previewToken) return;

    if (!dataUrl) {
      loading.classList.add('hidden');
      return;
    }

    let loaded = false;
    const onLoaded = () => {
      if (loaded || myToken !== state.previewToken) return;
      loaded = true;
      state.previewImageLoaded = true;
      img.style.display = 'block';
      fitPreviewImage();
      loading.classList.add('hidden');
    };

    img.onload = onLoaded;
    img.src = dataUrl;

    if (img.complete && img.naturalWidth > 0) onLoaded();
  }

  async function renderHighResPage(pdfDoc, item) {
    const pdfPage = await pdfDoc.getPage(item.sourceIndex + 1);
    try {
      const baseVp = pdfPage.getViewport({ scale: 1 });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const maxCssWidth = Math.min(window.innerWidth * 0.9, 900);
      const targetWidth = Math.min(1400, maxCssWidth * dpr);
      const scale = targetWidth / baseVp.width;
      const vp = pdfPage.getViewport({ scale });

      if (!previewCanvas) previewCanvas = document.createElement('canvas');
      const canvas = previewCanvas;
      canvas.width  = Math.round(vp.width);
      canvas.height = Math.round(vp.height);

      const ctx = canvas.getContext('2d');
      await pdfPage.render({ canvasContext: ctx, viewport: vp }).promise;
      return canvas.toDataURL('image/jpeg', 0.85);
    } finally {
      try { pdfPage.cleanup(); } catch (e) {}
    }
  }

  function closePreview() {
    const modal = state.previewModal;
    if (!modal) return;

    const img = modal.querySelector('[data-preview-img]');
    if (img) {
      img.onload = null;
      img.removeAttribute('src');
      img.style.maxWidth  = '';
      img.style.maxHeight = '';
      img.style.transform = '';
      img.style.display   = '';
    }
    const loading = modal.querySelector('[data-preview-loading]');
    if (loading) loading.classList.add('hidden');

    modal.classList.add('hidden');
    document.body.style.overflow = '';
    state.previewPageId = null;
    state.previewToken += 1;
    state.previewImageLoaded = false;

    if (previewResizeRaf) {
      cancelAnimationFrame(previewResizeRaf);
      previewResizeRaf = null;
    }
  }

  /* --------------------------- move modal ---------------------------- */
  function createMoveModal() {
    const el = document.createElement('div');
    el.setAttribute('data-move-modal', '');
    el.className = 'hidden fixed inset-0 z-[70]';

    el.innerHTML = `
      <div class="absolute inset-0 bg-gray-900/60 backdrop-blur-sm" data-move-backdrop></div>
      <div class="relative z-10 flex min-h-full items-center justify-center p-4">
        <div class="w-full max-w-sm overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl"
             style="animation: org-toast-in .2s cubic-bezier(0.4,0,0.2,1);">
          <div class="flex items-center justify-between border-b border-gray-100 px-5 py-3.5">
            <h3 class="text-sm font-bold text-gray-900">Move page</h3>
            <button type="button" data-move-close aria-label="Close"
              class="grid h-8 w-8 place-items-center rounded-full text-gray-400 transition hover:bg-gray-100 hover:text-gray-600">
              <i data-lucide="x" class="h-4 w-4"></i>
            </button>
          </div>
          <div class="px-5 py-4">
            <p class="text-xs text-gray-900">
              Page <span data-move-from-label class="font-bold text-blue-600">1</span>
              of <span data-move-total class="font-bold text-gray-900">1</span>
            </p>
            <label class="mt-4 block text-[11px] font-bold uppercase tracking-wider text-gray-900">
              Move to position
            </label>
            <input type="number" data-move-input min="1" max="1" value="1" inputmode="numeric" autocomplete="off"
              class="mt-2 w-full rounded-xl border border-gray-200 bg-white px-3.5 py-3 text-center text-lg font-bold text-gray-900 outline-none transition focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10" />
            <p class="mt-2 text-[11px] text-gray-900">
              Enter a number between 1 and <span data-move-max-hint>1</span>
            </p>
          </div>
          <div class="flex gap-2 border-t border-gray-100 px-5 py-3.5">
            <button type="button" data-move-cancel
              class="flex-1 rounded-lg border border-gray-200 bg-white px-4 py-2.5 text-sm font-bold text-gray-900 transition hover:bg-gray-50 active:scale-95">
              Cancel
            </button>
            <button type="button" data-move-confirm
              class="flex-1 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-blue-700 active:scale-95">
              Move
            </button>
          </div>
        </div>
      </div>
    `;

    el.addEventListener('click', handleMoveModalClick);
    el.addEventListener('keydown', handleMoveModalKey);
    return el;
  }

  function handleMoveModalClick(e) {
    const t = e.target;
    if (t.closest('[data-move-backdrop]') ||
        t.closest('[data-move-close]') ||
        t.closest('[data-move-cancel]')) {
      closeMoveModal();
      return;
    }
    if (t.closest('[data-move-confirm]')) {
      const modal = state.moveModal;
      if (!modal) return;
      const input = modal.querySelector('[data-move-input]');
      const total = state.pages.length;
      const raw = parseInt(input.value, 10);
      const target = Math.max(1, Math.min(total, Number.isFinite(raw) ? raw : 1));
      const pageId = state.moveTargetId;
      closeMoveModal();
      if (pageId) performMove(pageId, target - 1);
    }
  }

  function handleMoveModalKey(e) {
    if (e.key === 'Enter' && e.target.matches('[data-move-input]')) {
      e.preventDefault();
      const btn = state.moveModal?.querySelector('[data-move-confirm]');
      if (btn) btn.click();
    }
  }

  function openMoveModal(pageId) {
    const item = findPage(pageId);
    if (!item) return;

    if (!state.moveModal) {
      state.moveModal = createMoveModal();
      document.body.appendChild(state.moveModal);
    }

    state.moveTargetId = pageId;
    const idx = state.pages.findIndex(p => p.id === pageId);
    const total = state.pages.length;

    const modal = state.moveModal;
    modal.querySelector('[data-move-from-label]').textContent = String(idx + 1);
    modal.querySelector('[data-move-total]').textContent = String(total);
    modal.querySelector('[data-move-max-hint]').textContent = String(total);

    const input = modal.querySelector('[data-move-input]');
    input.min = '1';
    input.max = String(total);
    input.value = String(idx + 1);

    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    refreshIcons();

    setTimeout(() => {
      try { input.focus(); input.select(); } catch (e) {}
    }, 50);
  }

  function closeMoveModal() {
    const modal = state.moveModal;
    if (!modal) return;
    modal.classList.add('hidden');
    state.moveTargetId = null;
    if (!state.previewPageId) document.body.style.overflow = '';
  }

  /* --------------------------- success view -------------------------- */
  function showSuccess() {
    const root = state.root;
    if (!root || !state.result) return;

    const workWs    = root.querySelector('[data-work-workspace]');
    const successWs = root.querySelector('[data-success-workspace]');
    const bottomBar = root.querySelector('[data-bottom-bar]');
    const menuWrap  = root.querySelector('[data-menu-wrap]');
    const clearBtn  = root.querySelector('[data-clear]');

    if (workWs)    workWs.classList.add('hidden');
    if (bottomBar) bottomBar.classList.add('hidden');
    if (menuWrap)  menuWrap.classList.add('hidden');
    if (clearBtn)  clearBtn.classList.add('hidden');

    if (successWs) {
      successWs.classList.remove('hidden');
      successWs.innerHTML = successHtml();
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
        <h2 class="text-xl font-extrabold text-gray-900 tracking-tight">Pages Organized 🎉</h2>
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
    if (!base) base = 'organized';
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
    if (!base) base = 'organized';
    const filename = base.replace(/\.pdf$/i, '') + '.pdf';

    try {
      const file = new File([state.result.blob], filename, { type: 'application/pdf' });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: 'Organized PDF',
          text: 'Organized with PDFTools',
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
  // pre-populated organize screen with old page edits in place.
  function startOver() {
    revokeResultUrl();
    closeMenu();
    window.location.reload();
  }

  /* ------------------------------ toast ------------------------------ */
  function showToast(message, type, duration) {
    const el = state.root?.querySelector('[data-status]');
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
           style="animation: org-toast-in .22s cubic-bezier(0.4, 0, 0.2, 1);">
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
    const menuWrap   = root?.querySelector('[data-menu-wrap]');
    const clearBtn   = root?.querySelector('[data-clear]');
    if (!root) return;

    const hasFile = !!state.file;
    if (dropzoneEl) dropzoneEl.classList.toggle('hidden', hasFile);
    if (fileCardEl) fileCardEl.classList.toggle('hidden', !hasFile);
    if (menuWrap)   menuWrap.classList.toggle('hidden', !hasFile);
    if (clearBtn)   clearBtn.classList.toggle('hidden', !hasFile);

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
          <div class="inline-block max-w-full truncate px-2 py-0.5 rounded-md text-[12px] font-bold bg-org-100 text-org-700">${escapeHtml(f.name)}</div>
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

  function pageCardHtml(item) {
    const rot = item.rotation || 0;
    const thumbInner = item.thumb
      ? '<img src="' + item.thumb + '" alt="" draggable="false" class="max-h-full max-w-full object-contain select-none" style="transform: rotate(' + rot + 'deg); transition: transform .25s ease;" />'
      : item.thumbError
        ? '<div class="grid h-full w-full place-items-center text-gray-400">' + SVG_ALERT + '</div>'
        : '<div class="grid h-full w-full place-items-center text-blue-400">' + SVG_SPINNER + '</div>';

    return '' +
      '<div class="page-card group relative flex flex-col overflow-hidden rounded-xl border border-gray-200 bg-white" data-card-id="' + item.id + '">' +
        '<div class="relative aspect-square overflow-hidden bg-gray-50">' +
          '<span class="pointer-events-none absolute left-1.5 top-1.5 z-10 grid h-6 min-w-[1.5rem] place-items-center rounded-md bg-gray-900/85 px-1.5 text-[10px] font-bold text-white backdrop-blur">' + (item.sourceIndex + 1) + '</span>' +
          '<button type="button" data-drag-handle aria-label="Drag to reorder" class="absolute right-1.5 top-1.5 z-20 grid h-9 w-9 cursor-grab place-items-center rounded-md bg-white/90 text-gray-500 shadow-sm backdrop-blur transition hover:bg-white hover:text-blue-600 active:cursor-grabbing">' +
            '<i data-lucide="grip-vertical" class="h-4 w-4"></i>' +
          '</button>' +
          '<div data-thumb class="absolute inset-0 grid place-items-center p-3">' + thumbInner + '</div>' +
          '<button type="button" data-preview="' + item.id + '" aria-label="Preview page" class="absolute inset-0 z-10 cursor-pointer bg-transparent"></button>' +
        '</div>' +
        '<div class="relative z-20 flex items-center justify-around border-t border-gray-100 px-1 py-1">' +
          '<button type="button" data-rotate-right="' + item.id + '" aria-label="Rotate right" class="grid h-8 w-8 place-items-center rounded-md text-gray-500 transition hover:bg-blue-50 hover:text-blue-600 active:scale-90"><i data-lucide="rotate-cw" class="h-4 w-4"></i></button>' +
          '<button type="button" data-preview="' + item.id + '" aria-label="Preview" class="grid h-8 w-8 place-items-center rounded-md text-gray-500 transition hover:bg-blue-50 hover:text-blue-600 active:scale-90"><i data-lucide="eye" class="h-4 w-4"></i></button>' +
          '<button type="button" data-delete="' + item.id + '" aria-label="Delete page" class="grid h-8 w-8 place-items-center rounded-md text-gray-500 transition hover:bg-rose-50 hover:text-rose-500 active:scale-90"><i data-lucide="trash-2" class="h-4 w-4"></i></button>' +
          '<button type="button" data-move="' + item.id + '" aria-label="Move to position" class="grid h-8 w-8 place-items-center rounded-md text-gray-500 transition hover:bg-blue-50 hover:text-blue-600 active:scale-90"><i data-lucide="arrow-right-to-line" class="h-4 w-4"></i></button>' +
        '</div>' +
      '</div>';
  }

  function renderPagesGrid() {
    const root = state.root;
    if (!root) return;

    const gridWrap = root.querySelector('[data-pages-wrap]');
    const grid     = root.querySelector('[data-pages-grid]');
    if (!gridWrap || !grid) return;

    const hasFile = !!state.file && !state.file.error && !state.file.loading;
    gridWrap.classList.toggle('hidden', !hasFile);

    if (!hasFile) { grid.innerHTML = ''; updatePageCount(); return; }

    grid.innerHTML = state.pages.map(p => pageCardHtml(p)).join('');
    refreshIcons();
    updatePageCount();
    updateSummary();

    if (state.pdfDoc) observeCards();
  }

  function updateCardThumb(id) {
    const card = state.root?.querySelector('[data-card-id="' + id + '"]');
    if (!card) return;
    const item = findPage(id);
    if (!item) return;

    const holder = card.querySelector('[data-thumb]');
    if (!holder) return;

    let inner;
    if (item.thumb) {
      inner = '<img src="' + item.thumb + '" alt="" draggable="false" class="max-h-full max-w-full object-contain select-none" style="transform: rotate(' + item.rotation + 'deg); transition: transform .25s ease;" />';
    } else if (item.thumbError) {
      inner = '<div class="grid h-full w-full place-items-center text-gray-400">' + SVG_ALERT + '</div>';
    } else {
      inner = '<div class="grid h-full w-full place-items-center text-blue-400">' + SVG_SPINNER + '</div>';
    }
    holder.innerHTML = inner;
  }

  function updateCardRotation(id) {
    const card = state.root?.querySelector('[data-card-id="' + id + '"]');
    if (!card) return;
    const item = findPage(id);
    if (!item) return;
    const img = card.querySelector('img');
    if (img) img.style.transform = 'rotate(' + item.rotation + 'deg)';
  }

  function updateGridEmptyState() {
    const grid = state.root?.querySelector('[data-pages-grid]');
    if (!grid) return;
    if (!grid.children.length) {
      grid.innerHTML =
        '<div class="col-span-full rounded-xl border-2 border-dashed border-gray-300 py-12 text-center">' +
          '<i data-lucide="trash-2" class="mx-auto h-6 w-6 text-gray-400"></i>' +
          '<p class="mt-2 text-sm font-bold text-gray-900">All pages deleted</p>' +
          '<p class="mt-0.5 text-xs text-gray-900">Use the menu to reset</p>' +
        '</div>';
      refreshIcons();
    }
  }

  function updatePageCount() {
    const el = state.root?.querySelector('[data-page-count]');
    if (el) el.textContent = String(state.pages.length);
  }

  function updateSummary() {
    const el = state.root?.querySelector('[data-summary]');
    if (!el) return;
    const n = state.pages.length;
    if (!state.file) { el.textContent = 'Add a PDF to get started'; return; }
    if (state.file.loading) { el.textContent = 'Reading file…'; return; }
    if (state.file.error) { el.textContent = 'This file cannot be processed'; return; }
    if (state.isProcessing) { el.textContent = 'Building your PDF…'; return; }
    if (!n) { el.textContent = 'All pages deleted'; return; }
    el.textContent = n + ' page' + (n !== 1 ? 's' : '') + ' · ready to save';
  }

  function updateBottomBar() {
    const root = state.root;
    const btn  = root?.querySelector('[data-save]');
    if (!btn) return;

    const ready = !!state.file && !state.file.loading && !state.file.error
                  && state.pages.length > 0 && !state.isProcessing;

    btn.disabled = !ready;
    btn.innerHTML = state.isProcessing
      ? '<i data-lucide="loader-2" style="width:20px;height:20px;" class="animate-spin"></i><span>Saving…</span>'
      : 'Save PDF <i data-lucide="arrow-right" style="width:20px;height:20px;"></i>';
    refreshIcons();
    updateSummary();
  }

  /* ===================================================================
   * CUSTOM DRAG — O(1) grid math, unified rAF loop
   * =================================================================== */
  function setupDrag(gridEl) {
    if (!gridEl) return () => {};

    let drag = null;
    let rafId = null;
    let savedScrollBehavior = null;
    let moveDirty = false;

    const SCROLL_MAX  = 38;
    const SCROLL_EDGE = 130;

    let slotW = 0, slotH = 0, cols = 1;
    let gridDocLeft = 0, gridDocTop = 0, totalSlots = 0;

    function disableSmoothScroll() {
      const html = document.documentElement;
      if (savedScrollBehavior === null) savedScrollBehavior = html.style.scrollBehavior;
      html.style.scrollBehavior = 'auto';
      html.style.overflowAnchor = 'none';
      document.body.style.overflowAnchor = 'none';
    }

    function restoreSmoothScroll() {
      const html = document.documentElement;
      if (savedScrollBehavior !== null) {
        html.style.scrollBehavior = savedScrollBehavior;
        savedScrollBehavior = null;
      }
      html.style.overflowAnchor = '';
      document.body.style.overflowAnchor = '';
    }

    function getScroller() {
      return document.scrollingElement || document.documentElement || document.body;
    }

    function computeGridLayout() {
      const first = gridEl.querySelector('.page-card');
      if (!first) return false;

      const cs = getComputedStyle(gridEl);
      const gapX = parseFloat(cs.columnGap) || 0;
      const gapY = parseFloat(cs.rowGap) || 0;
      const padL = parseFloat(cs.paddingLeft) || 0;
      const padR = parseFloat(cs.paddingRight) || 0;
      const padT = parseFloat(cs.paddingTop) || 0;

      const firstRect = first.getBoundingClientRect();
      const gRect = gridEl.getBoundingClientRect();

      const cardW = firstRect.width;
      const cardH = firstRect.height;
      const innerW = gridEl.clientWidth - padL - padR;

      cols = Math.max(1, Math.round((innerW + gapX) / (cardW + gapX)));
      slotW = cardW + gapX;
      slotH = cardH + gapY;

      const scrollX = window.scrollX || window.pageXOffset || 0;
      const scrollY = window.scrollY || window.pageYOffset || 0;
      gridDocLeft = gRect.left + padL + scrollX;
      gridDocTop  = gRect.top  + padT + scrollY;

      totalSlots = gridEl.querySelectorAll('.page-card').length;
      return true;
    }

    function indexFromPoint(px, py) {
      const sx = window.scrollX || window.pageXOffset || 0;
      const sy = window.scrollY || window.pageYOffset || 0;
      const docX = px + sx;
      const docY = py + sy;

      let col = Math.floor((docX - gridDocLeft) / slotW);
      let row = Math.floor((docY - gridDocTop) / slotH);

      if (col < 0) col = 0;
      else if (col > cols - 1) col = cols - 1;
      if (row < 0) row = 0;

      let idx = row * cols + col;
      if (idx > totalSlots - 1) idx = totalSlots - 1;
      if (idx < 0) idx = 0;
      return idx;
    }

    function updatePlaceholderFromPoint(px, py) {
      if (!drag?.active || !drag.placeholder) return;

      const targetIdx = indexFromPoint(px, py);
      if (targetIdx === drag.lastIdx) return;

      const ph = drag.placeholder;
      const parent = ph.parentNode;
      if (!parent) return;

      const cards = [];
      for (let i = 0; i < parent.children.length; i++) {
        const c = parent.children[i];
        if (c !== ph) cards.push(c);
      }

      ph.remove();
      if (targetIdx >= cards.length) parent.appendChild(ph);
      else parent.insertBefore(ph, cards[targetIdx]);
      drag.lastIdx = targetIdx;
    }

    function moveClone(x, y) {
      if (!drag.clone) return;
      const left = x - drag.offsetX;
      const top  = y - drag.offsetY;
      drag.clone.style.transform =
        'translate3d(' + left + 'px, ' + top + 'px, 0) scale(1.04)';
    }

    function tick() {
      if (!drag || !drag.active) { rafId = null; return; }

      if (moveDirty) {
        moveDirty = false;
        moveClone(drag.lastX, drag.lastY);
        updatePlaceholderFromPoint(drag.lastX, drag.lastY);
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
          updatePlaceholderFromPoint(drag.lastX, drag.lastY);
        }
      }

      rafId = requestAnimationFrame(tick);
    }

    function startRaf() { if (!rafId) rafId = requestAnimationFrame(tick); }
    function stopRaf()  { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }

    function onPointerDown(e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;

      const handle = e.target.closest('[data-drag-handle]');
      if (!handle) return;

      const card = handle.closest('.page-card');
      if (!card || card.classList.contains('drag-placeholder')) return;

      e.preventDefault();
      e.stopPropagation();

      drag = {
        pointerId: e.pointerId,
        startX: e.clientX, startY: e.clientY,
        lastX: e.clientX,  lastY: e.clientY,
        card, active: false,
        clone: null, placeholder: null,
        offsetX: 0, offsetY: 0,
        lastIdx: -1,
      };
      moveDirty = false;

      document.addEventListener('pointermove', onPointerMove, { passive: false });
      document.addEventListener('pointerup', onPointerUp);
      document.addEventListener('pointercancel', onPointerUp);
    }

    function activate() {
      const card = drag.card;
      const rect = card.getBoundingClientRect();

      drag.offsetX = drag.lastX - rect.left;
      drag.offsetY = drag.lastY - rect.top;

      if (!computeGridLayout()) { drag.active = false; return; }
      drag.active = true;

      const ph = document.createElement('div');
      ph.className = 'page-card drag-placeholder';
      ph.style.cssText =
        'width:' + rect.width + 'px;height:' + rect.height + 'px;' +
        'box-sizing:border-box;border-radius:0.75rem;' +
        'border:2px dashed #93C5FD;background:rgba(37,99,235,0.08);' +
        'pointer-events:none;transition:none;';
      drag.placeholder = ph;

      const parent = card.parentNode;
      parent.insertBefore(ph, card);
      card.remove();

      drag.lastIdx = Array.prototype.indexOf.call(gridEl.children, ph);

      const clone = card.cloneNode(true);
      clone.style.cssText =
        'position:fixed;left:0;top:0;' +
        'width:' + rect.width + 'px;height:' + rect.height + 'px;' +
        'margin:0;pointer-events:none;z-index:9999;' +
        'transform-origin:0 0;will-change:transform;border-radius:0.75rem;' +
        'box-shadow:0 24px 48px -12px rgba(15,15,30,.5),0 0 0 2px rgba(37,99,235,.55);' +
        'transform:translate3d(' + rect.left + 'px,' + rect.top + 'px,0) scale(1.04);' +
        'transition:none !important;';
      drag.clone = clone;
      document.body.appendChild(clone);

      document.body.classList.add('is-dragging-page');
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
        const { card, clone, placeholder } = drag;

        if (clone?.parentNode) clone.remove();

        if (placeholder?.parentNode && card) {
          placeholder.parentNode.insertBefore(card, placeholder);
          placeholder.remove();
        }

        const order = Array.from(gridEl.querySelectorAll('.page-card'))
          .filter(el => el.getAttribute('data-card-id'))
          .map(el => el.getAttribute('data-card-id'));
        const byId = new Map(state.pages.map(p => [p.id, p]));
        state.pages = order.map(id => byId.get(id)).filter(Boolean);
        updateSummary();
      } else {
        if (drag.placeholder?.parentNode) drag.placeholder.remove();
        if (drag.clone?.parentNode) drag.clone.remove();
      }

      document.body.classList.remove('is-dragging-page');
      restoreSmoothScroll();
      drag = null;
      moveDirty = false;
    }

    function onContextMenu(e) {
      if (e.target.closest('.page-card')) e.preventDefault();
    }

    gridEl.addEventListener('pointerdown', onPointerDown);
    gridEl.addEventListener('contextmenu', onContextMenu);

    return function cleanup() {
      gridEl.removeEventListener('pointerdown', onPointerDown);
      gridEl.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerUp);
      stopRaf();
      if (drag) {
        if (drag.clone?.parentNode) drag.clone.remove();
        if (drag.placeholder?.parentNode) drag.placeholder.remove();
        if (drag.card && !drag.card.parentNode) gridEl.appendChild(drag.card);
        drag = null;
      }
      document.body.classList.remove('is-dragging-page');
      restoreSmoothScroll();
    };
  }

  /* ------------------------- dropdown menu --------------------------- */
  function closeMenu() {
    const dd = state.root?.querySelector('[data-menu-dropdown]');
    if (dd) dd.classList.add('hidden');
  }

  function handleDocumentClick(e) {
    const root = state.root;
    if (!root) return;
    const menuWrap = root.querySelector('[data-menu-wrap]');
    if (!menuWrap) return;
    if (!menuWrap.contains(e.target)) closeMenu();
  }

  function handleGlobalKey(e) {
    if (e.key === 'Escape') {
      closeMenu();
      if (state.previewPageId) { closePreview(); return; }
      if (state.moveTargetId) { closeMoveModal(); return; }
    }
  }

  /* ------------------------------ styles ----------------------------- */
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '@keyframes org-toast-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }',
      '[data-dropzone].is-dragover { background-color: #6D28D9 !important; }',
      '[data-dropzone].is-dragover .dz-inner { border-color: rgba(255, 255, 255, 0.9); }',
      '[data-pages-grid] { overflow-anchor: none; }',
      '.page-card {',
      '  touch-action: manipulation;',
      '  -webkit-touch-callout: none;',
      '  -webkit-user-select: none;',
      '  user-select: none;',
      '  -webkit-user-drag: none;',
      '}',
      '.page-card img {',
      '  -webkit-touch-callout: none;',
      '  -webkit-user-drag: none;',
      '  user-select: none;',
      '  pointer-events: none;',
      '}',
      '.page-card svg { pointer-events: none; }',
      '[data-drag-handle] {',
      '  touch-action: none;',
      '  -webkit-touch-callout: none;',
      '  -webkit-user-select: none;',
      '  user-select: none;',
      '  -webkit-user-drag: none;',
      '}',
      '[data-drag-handle] * { pointer-events: none; }',
      '.page-card.drag-placeholder { transition: none !important; }',
      'body.is-dragging-page {',
      '  overscroll-behavior: contain;',
      '  -webkit-touch-callout: none;',
      '}',
      'body.is-dragging-page * { cursor: grabbing !important; }',
      '[data-move-input]::-webkit-outer-spin-button,',
      '[data-move-input]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }',
      '[data-move-input] { -moz-appearance: textfield; }',
      '[data-preview-img] { display: block; will-change: transform; }',
      '[data-preview-stage] { contain: layout paint; }',
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
    if (t.closest('[data-dropzone]'))    { state.root.querySelector('[data-file-input]')?.click(); return; }
    if (t.closest('[data-clear]'))       { closeMenu(); removeFile(); return; }
    if (t.closest('[data-remove-file]')) { closeMenu(); removeFile(); return; }
    if (t.closest('[data-save]'))        { applyChanges(); return; }
    if (t.closest('[data-download]'))    { handleDownload(); return; }
    if (t.closest('[data-share]'))       { handleShare(); return; }
    if (t.closest('[data-start-over]'))  { startOver(); return; }

    if (t.closest('[data-menu-toggle]')) {
      const dd = state.root.querySelector('[data-menu-dropdown]');
      if (dd) dd.classList.toggle('hidden');
      return;
    }

    if (t.closest('[data-rotate-all-left]'))  { rotateAll(-90); closeMenu(); return; }
    if (t.closest('[data-rotate-all-right]')) { rotateAll(90);  closeMenu(); return; }
    if (t.closest('[data-reset]'))            { resetAll();     closeMenu(); return; }

    if (t.closest('[data-drag-handle]')) return;

    const mv = t.closest('[data-move]');
    if (mv) { openMoveModal(mv.getAttribute('data-move')); return; }

    const pv = t.closest('[data-preview]');
    if (pv) { openPreview(pv.getAttribute('data-preview')); return; }

    const rr = t.closest('[data-rotate-right]');
    if (rr) { rotatePage(rr.getAttribute('data-rotate-right'), 90); return; }
    const dl = t.closest('[data-delete]');
    if (dl) { deletePage(dl.getAttribute('data-delete')); return; }
  }

  function handleInput(e) {
    if (e.target.matches('[data-file-input]')) {
      if (e.target.files && e.target.files.length) {
        addFile(e.target.files);
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
  function template() {
    return `
      <div class="org-root min-h-screen bg-white flex flex-col">

        <header class="sticky top-0 z-40 bg-white border-b border-gray-100">
          <div class="max-w-4xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
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
                Organize<span style="color:${BRAND}">PDF</span>
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
                <div data-menu-dropdown class="hidden absolute right-0 top-full z-40 mt-2 w-52 overflow-hidden rounded-xl border border-gray-200 bg-white p-1 shadow-xl shadow-gray-900/10"
                     style="animation: org-toast-in .15s cubic-bezier(0.4,0,0.2,1);">
                  <button type="button" data-rotate-all-left class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-semibold text-gray-900 transition hover:bg-gray-100">
                    <i data-lucide="rotate-ccw" style="width:16px;height:16px;" class="text-gray-500"></i>
                    Rotate all left
                  </button>
                  <button type="button" data-rotate-all-right class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-semibold text-gray-900 transition hover:bg-gray-100">
                    <i data-lucide="rotate-cw" style="width:16px;height:16px;" class="text-gray-500"></i>
                    Rotate all right
                  </button>
                  <div class="my-1 h-px bg-gray-100"></div>
                  <button type="button" data-reset class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-semibold text-gray-900 transition hover:bg-gray-100">
                    <i data-lucide="undo-2" style="width:16px;height:16px;" class="text-gray-500"></i>
                    Reset changes
                  </button>
                </div>
              </div>
            </div>
          </div>
        </header>

        <main class="flex-1 w-full max-w-4xl mx-auto px-4 sm:px-6 pt-4 pb-36">

          <div data-work-workspace>

            <label data-dropzone
                   class="group relative block cursor-pointer rounded-2xl bg-org-500 px-4 py-8 text-center transition-all duration-200 hover:bg-org-600 focus-within:outline-none sm:px-8 sm:py-10">
              <div class="dz-inner absolute inset-3.5 rounded-xl border-2 border-dashed border-white/60 transition-colors duration-200"></div>
              <input type="file" data-file-input accept=".pdf,application/pdf" hidden />

              <div class="relative z-10 flex flex-col items-center justify-center min-h-[180px] sm:min-h-[210px]">
                <svg width="130" height="84" viewBox="0 0 130 84" fill="none" xmlns="http://www.w3.org/2000/svg" class="mb-5">
                  <rect x="10" y="10" width="30" height="30" rx="3" fill="white" opacity="0.9"/>
                  <rect x="46" y="10" width="30" height="30" rx="3" fill="white" opacity="0.5"/>
                  <rect x="82" y="10" width="30" height="30" rx="3" fill="white" opacity="0.35"/>
                  <rect x="10" y="46" width="30" height="30" rx="3" fill="white" opacity="0.35"/>
                  <rect x="46" y="46" width="30" height="30" rx="3" fill="white" opacity="0.5"/>
                  <rect x="82" y="46" width="30" height="30" rx="3" fill="white" opacity="0.9"/>
                  <path d="M32 24h10" stroke="#DDD6FE" stroke-width="2" stroke-linecap="round"/>
                  <path d="M68 24h10" stroke="#DDD6FE" stroke-width="2" stroke-linecap="round"/>
                  <path d="M32 61h10" stroke="#DDD6FE" stroke-width="2" stroke-linecap="round"/>
                  <path d="M68 61h10" stroke="#DDD6FE" stroke-width="2" stroke-linecap="round"/>
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

            <div data-pages-wrap class="hidden mt-5">
              <div class="mb-2 flex items-center justify-between">
                <p class="text-[11px] font-medium uppercase tracking-wide text-gray-900">
                  Drag <i data-lucide="grip-vertical" class="inline" style="width:14px;height:14px;vertical-align:-2px;"></i> to reorder · tap <i data-lucide="eye" class="inline" style="width:14px;height:14px;vertical-align:-2px;"></i> to preview
                </p>
                <p class="text-[11px] font-semibold text-gray-900"><span data-page-count>0</span> pages</p>
              </div>
              <div data-pages-grid class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4"></div>
            </div>

          </div>

          <div data-success-workspace class="hidden"></div>

        </main>

        <div data-bottom-bar class="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 p-4 z-40"
             style="padding-bottom: max(1.5rem, env(safe-area-inset-bottom, 0));">
          <div class="max-w-4xl mx-auto flex flex-col gap-2">
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
    if (!rootEl) throw new Error('ReorderRotateDeletePages.render: missing root element');

    await ensureLibs();

    state.file = null;
    state.pages = [];
    state.originalSnapshot = null;
    state.isProcessing = false;
    state.gen = 0;
    state.root = rootEl;
    state.onBack = options?.onBack || null;
    state.cleanup = [];
    state.statusTimer = null;
    state.result = null;
    state.previewPageId = null;
    state.previewToken = 0;
    state.previewImageLoaded = false;
    state.moveTargetId = null;

    thumbQueue = [];
    thumbRendering = false;

    injectStyles();
    rootEl.innerHTML = template();
    refreshIcons();

    rootEl.addEventListener('click', handleClick);
    rootEl.addEventListener('input', handleInput);
    rootEl.addEventListener('focusin', handleFocusIn);
    rootEl.addEventListener('keydown', handleKeyDown);
    document.addEventListener('click', handleDocumentClick);
    document.addEventListener('keydown', handleGlobalKey);
    window.addEventListener('resize', handlePreviewResize);
    window.addEventListener('orientationchange', handlePreviewResize);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handlePreviewResize);
    }

    const dz = rootEl.querySelector('[data-dropzone]');
    if (dz) {
      state.cleanup.push(setupDropZone(dz));
      dz.addEventListener('click', (e) => {
        if (e.target.closest('#chooseBtn')) {
          e.stopPropagation();
          rootEl.querySelector('[data-file-input]')?.click();
        }
      });
    }

    const gridEl = rootEl.querySelector('[data-pages-grid]');
    state.cleanup.push(setupDrag(gridEl));

    updateBottomBar();

    if (options?.initialFiles?.length) {
      await addFile(options.initialFiles);
    }
  }

  function destroy() {
    state.gen += 1;
    revokeAllThumbUrls();
    disconnectThumbObserver();
    closePreview();
    closeMoveModal();
    closeMenu();

    if (state.root) {
      state.root.removeEventListener('click', handleClick);
      state.root.removeEventListener('input', handleInput);
      state.root.removeEventListener('focusin', handleFocusIn);
      state.root.removeEventListener('keydown', handleKeyDown);
    }
    document.removeEventListener('click', handleDocumentClick);
    document.removeEventListener('keydown', handleGlobalKey);
    window.removeEventListener('resize', handlePreviewResize);
    window.removeEventListener('orientationchange', handlePreviewResize);
    if (window.visualViewport) {
      try { window.visualViewport.removeEventListener('resize', handlePreviewResize); } catch (e) {}
    }

    if (state.previewModal) {
      state.previewModal.removeEventListener('click', handlePreviewClick);
      try { state.previewModal.remove(); } catch (e) {}
      state.previewModal = null;
    }

    if (state.moveModal) {
      state.moveModal.removeEventListener('click', handleMoveModalClick);
      state.moveModal.removeEventListener('keydown', handleMoveModalKey);
      try { state.moveModal.remove(); } catch (e) {}
      state.moveModal = null;
    }

    document.body.style.overflow = '';
    document.body.classList.remove('is-dragging-page');

    destroyPdfDoc();
    revokeResultUrl();
    releaseSourceFile();
    state.cleanup.forEach(fn => { try { fn(); } catch (e) {} });
    state.cleanup = [];
    state.file = null;
    state.pages = [];
    state.originalSnapshot = null;
    state.root = null;
    state.statusTimer = null;
    state.previewPageId = null;
    state.moveTargetId = null;

    if (previewResizeRaf) {
      cancelAnimationFrame(previewResizeRaf);
      previewResizeRaf = null;
    }
    if (thumbCanvas)   { try { thumbCanvas.width = 0; thumbCanvas.height = 0; } catch (e) {} thumbCanvas = null; }
    if (previewCanvas) { try { previewCanvas.width = 0; previewCanvas.height = 0; } catch (e) {} previewCanvas = null; }
  }

  window.ReorderRotateDeletePages = { render, destroy };
})();