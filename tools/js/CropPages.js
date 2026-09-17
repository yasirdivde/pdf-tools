/* =====================================================================
 * CropPages.js — PDFTools crop pages module
 * Crop PDF pages with per-page crops. Memory-optimized for desktop & mobile.
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
  const STYLE_ID     = 'crop-pages-styles';

  // Cyan brand mark (matches CropPages.html header/footer accents)
  const BRAND = '#06B6D4';

  const MIN_CROP     = 0.05;
  const DEFAULT_CROP = { x: 0.05, y: 0.05, w: 0.9, h: 0.9 };

  const CAPS = (function detect() {
    let isMobile = false;
    try {
      const isTouch  = (navigator.maxTouchPoints || 0) > 1;
      const isNarrow = Math.min(window.innerWidth, window.innerHeight) < 820;
      isMobile = isTouch && isNarrow;
    } catch (e) {}

    const memGB = (typeof navigator.deviceMemory === 'number') ? navigator.deviceMemory : 4;
    const lowMemory = memGB <= 2;

    const maxDpr     = lowMemory ? 1   : (isMobile ? 1.25 : 1.5);
    const maxRenderW = lowMemory ? 900 : (isMobile ? 1200 : 1600);
    const pageCacheMax = lowMemory ? 2 : (isMobile ? 4 : 8);

    const preloadEnabled  = !lowMemory;
    const preloadDistance = 1;
    const preloadMaxPages = 60;

    return {
      isMobile, lowMemory, memGB,
      maxDpr, maxRenderW, pageCacheMax,
      preloadEnabled, preloadDistance, preloadMaxPages,
    };
  })();

  const state = {
    file: null,
    jsDoc: null,
    gen: 0,
    currentPage: 0,
    pageCrops: [],
    cropRect: { ...DEFAULT_CROP },
    isProcessing: false,
    root: null,
    onBack: null,
    cleanup: [],
    statusTimer: null,
    result: null,
  };

  let renderToken = 0;
  let activeRenderTask = null;
  let preloadRafId = null;
  let resizeRafId = null;
  let overlayRafId = null;

  const pageCache = new Map();

  const refs = {
    canvas: null, stage: null, stageWrap: null, cropRect: null,
    cropSize: null, summary: null, saveBtn: null,
    pageInput: null, totPage: null, prevBtn: null, nextBtn: null,
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

  function round4(v) { return Math.round(v * 10000) / 10000; }

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
    refs.canvas    = root.querySelector('[data-page-canvas]');
    refs.stage     = root.querySelector('[data-crop-stage]');
    refs.stageWrap = root.querySelector('[data-crop-stage-wrap]');
    refs.cropRect  = root.querySelector('[data-crop-rect]');
    refs.cropSize  = root.querySelector('[data-crop-size]');
    refs.summary   = root.querySelector('[data-summary]');
    refs.saveBtn   = root.querySelector('[data-save]');
    refs.pageInput = root.querySelector('[data-page-input]');
    refs.totPage   = root.querySelector('[data-total-pages]');
    refs.prevBtn   = root.querySelector('[data-prev-page]');
    refs.nextBtn   = root.querySelector('[data-next-page]');
  }

  /* -------------------------- page cache ----------------------------- */
  function clearPageCache() {
    for (const entry of pageCache.values()) {
      try { if (entry.bitmap && entry.bitmap.close) entry.bitmap.close(); } catch (e) {}
    }
    pageCache.clear();
  }

  function getCachedPage(idx, cssW, cssH) {
    const e = pageCache.get(idx);
    if (!e) return null;
    if (e.cssW !== cssW || e.cssH !== cssH) return null;
    pageCache.delete(idx);
    pageCache.set(idx, e);
    return e;
  }

  function setCachedPage(idx, bitmap, cssW, cssH) {
    const existing = pageCache.get(idx);
    if (existing) {
      try { if (existing.bitmap && existing.bitmap.close) existing.bitmap.close(); } catch (e) {}
      pageCache.delete(idx);
    }
    pageCache.set(idx, { bitmap, cssW, cssH });

    while (pageCache.size > CAPS.pageCacheMax) {
      const oldestKey = pageCache.keys().next().value;
      const old = pageCache.get(oldestKey);
      try { if (old.bitmap && old.bitmap.close) old.bitmap.close(); } catch (e) {}
      pageCache.delete(oldestKey);
    }
  }

  /* ------------------------ per-page crop state ---------------------- */
  function initPageCrops(count) {
    state.pageCrops = new Array(count);
    for (let i = 0; i < count; i++) state.pageCrops[i] = { ...DEFAULT_CROP };
  }

  function getPageCrop(idx) {
    return state.pageCrops[idx] ? { ...state.pageCrops[idx] } : { ...DEFAULT_CROP };
  }

  function setPageCrop(idx, crop) {
    state.pageCrops[idx] = {
      x: round4(crop.x), y: round4(crop.y),
      w: round4(crop.w), h: round4(crop.h),
    };
  }

  function loadCropForPage(idx) { state.cropRect = getPageCrop(idx); }
  function commitCurrentCrop() { setPageCrop(state.currentPage, state.cropRect); }

  function isDefaultCrop(crop) {
    return Math.abs(crop.x - DEFAULT_CROP.x) < 0.001 &&
           Math.abs(crop.y - DEFAULT_CROP.y) < 0.001 &&
           Math.abs(crop.w - DEFAULT_CROP.w) < 0.001 &&
           Math.abs(crop.h - DEFAULT_CROP.h) < 0.001;
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
    clearPageCache();
    releaseCanvas(refs.canvas);
    releaseSourceFile();

    const myGen = ++state.gen;

    state.file = { file: f, name: f.name, size: f.size, pageCount: null, loading: true, error: null };
    state.pageCrops = [];
    state.currentPage = 0;
    state.cropRect = { ...DEFAULT_CROP };

    renderUploadedFile();
    updateEditorVisibility();
    updateBottomBar();

    try {
      await ensurePdfJs();

      const buf = await f.arrayBuffer();
      if (myGen !== state.gen) return;

      const jsDoc = await window.pdfjsLib.getDocument({ data: buf }).promise;
      if (myGen !== state.gen) { try { jsDoc.destroy(); } catch (e) {} return; }
      state.jsDoc = jsDoc;

      const pageCount = jsDoc.numPages;
      state.file.pageCount = pageCount;
      state.file.loading = false;
      initPageCrops(pageCount);
      loadCropForPage(0);

      renderUploadedFile();
      updateEditorVisibility();
      updatePageNav();
      updateCropOverlay();
      updateCropSizeBadge();
      updateBottomBar();

      await renderCurrentPage();

      if (!CAPS.lowMemory) warmupPages(myGen);
    } catch (err) {
      console.error('[CropPages]', err);
      if (myGen !== state.gen) return;
      if (!state.file) return;
      state.file.loading = false;
      state.file.error = 'Unreadable or encrypted';
      renderUploadedFile();
      updateEditorVisibility();
      updateBottomBar();
    }
  }

  function warmupPages(myGen) {
    setTimeout(() => {
      if (myGen !== state.gen || !state.jsDoc) return;
      const limit = Math.min(CAPS.isMobile ? 4 : 8, state.file?.pageCount || 0);
      for (let i = 1; i <= limit; i++) {
        try { state.jsDoc.getPage(i).catch(() => {}); } catch (e) {}
      }
    }, 400);
  }

  function removeFile() {
    state.gen += 1;
    renderToken++;
    cancelActiveRender();
    destroyJsDoc();
    revokeResultUrl();
    clearPageCache();
    releaseCanvas(refs.canvas);
    releaseSourceFile();
    state.file = null;
    state.pageCrops = [];
    state.currentPage = 0;
    state.cropRect = { ...DEFAULT_CROP };
    renderUploadedFile();
    updateEditorVisibility();
    updateBottomBar();
  }

  /* --------------------------- page render --------------------------- */
  function computeDisplaySize(ratio) {
    const parentW = refs.stageWrap.clientWidth || 600;
    const maxH = Math.max(220, window.innerHeight * 0.55);
    let displayW = parentW;
    let displayH = displayW / ratio;
    if (displayH > maxH) { displayH = maxH; displayW = displayH * ratio; }
    return { w: Math.floor(displayW), h: Math.floor(displayH) };
  }

  function computeBitmapSize(displayW, displayH) {
    const dpr = Math.min(window.devicePixelRatio || 1, CAPS.maxDpr);
    let w = Math.round(displayW * dpr);
    let h = Math.round(displayH * dpr);
    if (w > CAPS.maxRenderW) {
      const scale = CAPS.maxRenderW / w;
      w = CAPS.maxRenderW;
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

    try {
      jsPage = await state.jsDoc.getPage(pageIdx + 1);
      if (myToken !== renderToken || myGen !== state.gen) return;

      const vp1 = jsPage.getViewport({ scale: 1 });
      const ratio = vp1.width / vp1.height;
      const { w: displayW, h: displayH } = computeDisplaySize(ratio);

      refs.stage.style.width  = displayW + 'px';
      refs.stage.style.height = displayH + 'px';

      const cached = getCachedPage(pageIdx, displayW, displayH);
      if (cached) {
        canvas.style.width  = displayW + 'px';
        canvas.style.height = displayH + 'px';
        canvas.width  = cached.bitmap.width;
        canvas.height = cached.bitmap.height;
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.drawImage(cached.bitmap, 0, 0);
        updateCropOverlay();
        schedulePreload(pageIdx);
        return;
      }

      const { w: bmpW, h: bmpH } = computeBitmapSize(displayW, displayH);

      canvas.width = 0;
      canvas.height = 0;
      canvas.style.width  = displayW + 'px';
      canvas.style.height = displayH + 'px';
      canvas.width  = bmpW;
      canvas.height = bmpH;

      const renderScale = bmpW / vp1.width;
      const renderVp = jsPage.getViewport({ scale: renderScale });

      const ctx = canvas.getContext('2d', { alpha: false });
      const task = jsPage.render({ canvasContext: ctx, viewport: renderVp });
      activeRenderTask = task;

      await task.promise;
      if (myToken !== renderToken || myGen !== state.gen) return;
      activeRenderTask = null;

      try {
        const bitmap = await createImageBitmap(canvas);
        if (myToken !== renderToken || myGen !== state.gen) {
          try { bitmap.close(); } catch (e) {}
          return;
        }
        setCachedPage(pageIdx, bitmap, displayW, displayH);
      } catch (e) {}

      updateCropOverlay();
      schedulePreload(pageIdx);
    } catch (err) {
      if (err && err.name === 'RenderingCancelledException') return;
      console.error('[CropPages] render', err);
    } finally {
      if (jsPage) { try { jsPage.cleanup(); } catch (e) {} }
    }
  }

  /* -------------------------- preloading ----------------------------- */
  function schedulePreload(currentIdx) {
    if (!CAPS.preloadEnabled) return;
    if ((state.file?.pageCount || 0) > CAPS.preloadMaxPages) return;

    if (preloadRafId) cancelAnimationFrame(preloadRafId);
    preloadRafId = requestAnimationFrame(() => {
      preloadRafId = null;
      preloadPage(currentIdx + 1);
      preloadPage(currentIdx - 1);
    });
  }

  async function preloadPage(pageIdx) {
    if (!state.jsDoc || !state.file || state.file.error) return;
    const total = state.file.pageCount || 0;
    if (pageIdx < 0 || pageIdx >= total) return;
    if (pageCache.has(pageIdx)) return;

    const myGen = state.gen;
    const stage = refs.stage;
    if (!stage) return;

    let jsPage = null;

    try {
      jsPage = await state.jsDoc.getPage(pageIdx + 1);
      if (myGen !== state.gen) return;

      const vp1 = jsPage.getViewport({ scale: 1 });
      const ratio = vp1.width / vp1.height;
      const { w: displayW, h: displayH } = computeDisplaySize(ratio);

      if (pageCache.has(pageIdx)) return;

      const { w: bmpW, h: bmpH } = computeBitmapSize(displayW, displayH);

      const off = document.createElement('canvas');
      off.width  = bmpW;
      off.height = bmpH;
      const offCtx = off.getContext('2d', { alpha: false });
      const renderVp = jsPage.getViewport({ scale: bmpW / vp1.width });

      await jsPage.render({ canvasContext: offCtx, viewport: renderVp }).promise;
      if (myGen !== state.gen) { releaseCanvas(off); return; }

      let bitmap;
      try {
        bitmap = await createImageBitmap(off);
      } catch (e) {
        bitmap = off;
      }

      if (bitmap !== off) releaseCanvas(off);

      if (myGen !== state.gen) {
        try { if (bitmap && bitmap.close) bitmap.close(); } catch (e) {}
        return;
      }
      setCachedPage(pageIdx, bitmap, displayW, displayH);
    } catch (err) {
      // preload errors are non-fatal
    } finally {
      if (jsPage) { try { jsPage.cleanup(); } catch (e) {} }
    }
  }

  /* --------------------------- crop overlay -------------------------- */
  function updateCropOverlay() {
    if (!refs.cropRect) return;
    const r = state.cropRect;
    refs.cropRect.style.left   = (r.x * 100) + '%';
    refs.cropRect.style.top    = (r.y * 100) + '%';
    refs.cropRect.style.width  = (r.w * 100) + '%';
    refs.cropRect.style.height = (r.h * 100) + '%';
  }

  function updateCropSizeBadge() {
    if (!refs.cropSize) return;
    const r = state.cropRect;
    refs.cropSize.textContent = Math.round(r.w * 100) + '% × ' + Math.round(r.h * 100) + '%';
  }

  function scheduleOverlayUpdate() {
    if (overlayRafId) return;
    overlayRafId = requestAnimationFrame(() => {
      overlayRafId = null;
      updateCropOverlay();
      updateCropSizeBadge();
    });
  }

  function resetCrop() {
    state.cropRect = { ...DEFAULT_CROP };
    commitCurrentCrop();
    updateCropOverlay();
    updateCropSizeBadge();
    updateSummary();
    showToast('Crop reset to default', 'success');
  }

  function applyToAllPages() {
    commitCurrentCrop();
    const crop = { ...state.cropRect };
    for (let i = 0; i < state.pageCrops.length; i++) state.pageCrops[i] = { ...crop };
    showToast('Crop applied to all ' + state.pageCrops.length + ' pages', 'success');
    updateSummary();
  }

  function resetAllCrops() {
    for (let i = 0; i < state.pageCrops.length; i++) state.pageCrops[i] = { ...DEFAULT_CROP };
    loadCropForPage(state.currentPage);
    updateCropOverlay();
    updateCropSizeBadge();
    updateSummary();
    showToast('All pages reset to default', 'success');
  }

  /* ------------------------ crop interaction ------------------------- */
  function setupCropInteraction(stageEl) {
    if (!stageEl) return () => {};

    let drag = null;
    let activeCaptureEl = null;
    let cachedStageW = 0;
    let cachedStageH = 0;

    function clamp(r) {
      if (r.w < MIN_CROP) r.w = MIN_CROP;
      if (r.h < MIN_CROP) r.h = MIN_CROP;
      if (r.x < 0) r.x = 0;
      if (r.y < 0) r.y = 0;
      if (r.x + r.w > 1) r.x = 1 - r.w;
      if (r.y + r.h > 1) r.y = 1 - r.h;
      return r;
    }

    function onPointerDown(e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (!state.file || state.file.error) return;

      const sr = stageEl.getBoundingClientRect();
      if (!sr.width || !sr.height) return;

      cachedStageW = sr.width;
      cachedStageH = sr.height;

      const handleEl = e.target.closest('[data-crop-handle]');
      const rectEl   = e.target.closest('[data-crop-rect]');

      if (handleEl) {
        drag = {
          pointerId: e.pointerId,
          mode: 'resize',
          side: handleEl.getAttribute('data-crop-handle'),
          startX: e.clientX, startY: e.clientY,
          rect: { ...state.cropRect },
        };
      } else if (rectEl) {
        drag = {
          pointerId: e.pointerId,
          mode: 'move',
          startX: e.clientX, startY: e.clientY,
          rect: { ...state.cropRect },
        };
      } else {
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      activeCaptureEl = handleEl || rectEl;
      try { activeCaptureEl.setPointerCapture(e.pointerId); } catch (err) {}

      document.body.classList.add('is-cropping');

      document.addEventListener('pointermove', onPointerMove, { passive: false });
      document.addEventListener('pointerup', onPointerUp);
      document.addEventListener('pointercancel', onPointerUp);
    }

    function onPointerMove(e) {
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (e.cancelable) e.preventDefault();

      const dx = (e.clientX - drag.startX) / cachedStageW;
      const dy = (e.clientY - drag.startY) / cachedStageH;

      let r = { ...drag.rect };

      if (drag.mode === 'move') {
        r.x = drag.rect.x + dx;
        r.y = drag.rect.y + dy;
      } else if (drag.mode === 'resize') {
        const s = drag.side;

        if (s.indexOf('n') !== -1) {
          const newY = drag.rect.y + dy;
          const newH = drag.rect.h - dy;
          if (newY >= 0 && newH >= MIN_CROP) { r.y = newY; r.h = newH; }
          else if (newY < 0) { r.y = 0; r.h = drag.rect.y + drag.rect.h; }
          else { r.y = drag.rect.y + drag.rect.h - MIN_CROP; r.h = MIN_CROP; }
        }
        if (s.indexOf('s') !== -1) {
          const newH = drag.rect.h + dy;
          if (drag.rect.y + newH <= 1 && newH >= MIN_CROP) { r.h = newH; }
          else if (drag.rect.y + newH > 1) { r.h = 1 - drag.rect.y; }
          else { r.h = MIN_CROP; }
        }
        if (s.indexOf('w') !== -1) {
          const newX = drag.rect.x + dx;
          const newW = drag.rect.w - dx;
          if (newX >= 0 && newW >= MIN_CROP) { r.x = newX; r.w = newW; }
          else if (newX < 0) { r.x = 0; r.w = drag.rect.x + drag.rect.w; }
          else { r.x = drag.rect.x + drag.rect.w - MIN_CROP; r.w = MIN_CROP; }
        }
        if (s.indexOf('e') !== -1) {
          const newW = drag.rect.w + dx;
          if (drag.rect.x + newW <= 1 && newW >= MIN_CROP) { r.w = newW; }
          else if (drag.rect.x + newW > 1) { r.w = 1 - drag.rect.x; }
          else { r.w = MIN_CROP; }
        }
      }

      state.cropRect = clamp(r);
      scheduleOverlayUpdate();
    }

    function onPointerUp(e) {
      if (!drag || e.pointerId !== drag.pointerId) return;

      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerUp);

      if (activeCaptureEl) {
        try { activeCaptureEl.releasePointerCapture(e.pointerId); } catch (err) {}
        activeCaptureEl = null;
      }

      document.body.classList.remove('is-cropping');

      state.cropRect = clamp({
        x: round4(state.cropRect.x),
        y: round4(state.cropRect.y),
        w: round4(state.cropRect.w),
        h: round4(state.cropRect.h),
      });
      commitCurrentCrop();
      updateCropOverlay();
      updateCropSizeBadge();
      updateSummary();

      drag = null;
    }

    stageEl.addEventListener('pointerdown', onPointerDown);

    return () => {
      stageEl.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerUp);
      document.body.classList.remove('is-cropping');
    };
  }

  /* ------------------------------ save ------------------------------- */
  async function applyCrop() {
    if (state.isProcessing || !state.file || state.file.error || !state.jsDoc) return;

    commitCurrentCrop();
    state.isProcessing = true;
    updateBottomBar();
    showToast('Applying crops…', 'info', 0);

    let buf = null;
    let libDoc = null;
    let out = null;

    try {
      await ensurePdfLib();

      const pageCount = state.file.pageCount;

      if (state.pageCrops.length !== pageCount) initPageCrops(pageCount);

      buf = await state.file.file.arrayBuffer();
      libDoc = await window.PDFLib.PDFDocument.load(buf, { ignoreEncryption: true });
      buf = null;

      out = await window.PDFLib.PDFDocument.create();
      const indices = libDoc.getPageIndices();
      const copied = await out.copyPages(libDoc, indices);
      libDoc = null;

      for (let i = 0; i < copied.length; i++) {
        const page = copied[i];
        const crop = state.pageCrops[i] || DEFAULT_CROP;

        let jsPage = null;
        try {
          jsPage = await state.jsDoc.getPage(i + 1);
          const vp1 = jsPage.getViewport({ scale: 1 });

          const vx = crop.x * vp1.width;
          const vy = crop.y * vp1.height;
          const vw = crop.w * vp1.width;
          const vh = crop.h * vp1.height;

          const [ax, ay] = vp1.convertToPdfPoint(vx, vy);
          const [bx, by] = vp1.convertToPdfPoint(vx + vw, vy + vh);

          const x0 = Math.min(ax, bx);
          const y0 = Math.min(ay, by);
          const w0 = Math.abs(bx - ax);
          const h0 = Math.abs(by - ay);

          page.setMediaBox(x0, y0, w0, h0);
          page.setCropBox(x0, y0, w0, h0);
          try { page.setTrimBox(x0, y0, w0, h0); } catch (e) {}
          try { page.setBleedBox(x0, y0, w0, h0); } catch (e) {}
        } finally {
          if (jsPage) { try { jsPage.cleanup(); } catch (e) {} }
        }

        out.addPage(page);

        if ((i & 31) === 31) await new Promise(r => setTimeout(r, 0));
      }

      let bytes = await out.save();
      out = null;

      const blob = new Blob([bytes], { type: 'application/pdf' });
      const totalSize = bytes.byteLength;
      bytes = null;

      const url = URL.createObjectURL(blob);

      revokeResultUrl();
      state.result = {
        blob, url,
        fileName: (state.file.name || 'file').replace(/\.pdf$/i, '') + '-cropped.pdf',
        pageCount,
        totalSize,
      };

      state.isProcessing = false;
      showToast(null);
      showSuccess();
    } catch (err) {
      console.error('[CropPages] save', err);
      buf = null;
      libDoc = null;
      out = null;
      state.isProcessing = false;
      showToast('Failed: ' + (err.message || 'Unknown error'), 'error');
      updateBottomBar();
    }
  }

  /* --------------------------- navigation ---------------------------- */
  function goToPage(idx) {
    if (!state.file || state.file.error) return;
    const total = state.file.pageCount || 1;
    idx = Math.max(0, Math.min(total - 1, idx));
    if (idx === state.currentPage) return;

    commitCurrentCrop();
    state.currentPage = idx;
    loadCropForPage(idx);

    updatePageNav();
    updateCropOverlay();
    updateCropSizeBadge();
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

    const workWs    = root.querySelector('[data-work-workspace]');
    const successWs = root.querySelector('[data-success-workspace]');
    const bottomBar = root.querySelector('[data-bottom-bar]');
    const menuWrap  = root.querySelector('[data-menu-wrap]');
    const clearBtn  = root.querySelector('[data-clear]');

    if (workWs)    workWs.classList.add('hidden');
    if (bottomBar) bottomBar.classList.add('hidden');
    if (clearBtn)  clearBtn.classList.add('hidden');
    if (menuWrap)  menuWrap.classList.add('hidden');

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
        <h2 class="text-xl font-extrabold text-gray-900 tracking-tight">Cropped Successfully 🎉</h2>
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
    if (!base) base = 'cropped';
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
    if (!base) base = 'cropped';
    const filename = base.replace(/\.pdf$/i, '') + '.pdf';

    try {
      const file = new File([state.result.blob], filename, { type: 'application/pdf' });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: 'Cropped PDF',
          text: 'Cropped with PDFTools',
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
  // pre-populated crop screen with old crops still applied.
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
           style="animation: crop-toast-in .22s cubic-bezier(0.4, 0, 0.2, 1);">
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
          <div class="inline-block max-w-full truncate px-2 py-0.5 rounded-md text-[12px] font-bold bg-crop-100 text-crop-700">${escapeHtml(f.name)}</div>
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
    if (state.isProcessing) { el.textContent = 'Applying crops…'; return; }

    const n = state.pageCrops.length;
    const customized = state.pageCrops.filter(c => !isDefaultCrop(c)).length;
    const r = state.cropRect;
    const pct = Math.round(r.w * 100) + '% × ' + Math.round(r.h * 100) + '%';

    if (customized === 0) {
      el.textContent = `Page ${state.currentPage + 1} of ${n} · Crop ${pct}`;
    } else {
      el.textContent = `Crop ${pct} · ${customized}/${n} pages customized`;
    }
  }

  function updateBottomBar() {
    const btn = refs.saveBtn || state.root?.querySelector('[data-save]');
    if (!btn) return;

    const f = state.file;
    const ready = !!f && !f.loading && !f.error && !!f.pageCount
                  && !state.isProcessing && !!state.jsDoc;

    btn.disabled = !ready;
    btn.innerHTML = state.isProcessing
      ? '<i data-lucide="loader-2" style="width:20px;height:20px;" class="animate-spin"></i><span>Cropping…</span>'
      : 'Save PDF <i data-lucide="arrow-right" style="width:20px;height:20px;"></i>';
    refreshIcons();
    updateSummary();
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
    if (e.key === 'Escape') closeMenu();
  }

  /* ------------------------------ styles ----------------------------- */
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '@keyframes crop-toast-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }',
      '[data-dropzone].is-dragover { background-color: #0E7490 !important; }',
      '[data-dropzone].is-dragover .dz-inner { border-color: rgba(255, 255, 255, 0.9); }',

      '[data-crop-stage-wrap] { display: flex; justify-content: center; }',

      '[data-crop-stage] {',
      '  position: relative;',
      '  border-radius: 0.75rem;',
      '  overflow: hidden;',
      '  touch-action: none;',
      '  user-select: none;',
      '  -webkit-user-select: none;',
      '  -webkit-touch-callout: none;',
      '  background: #ffffff;',
      '  box-shadow: 0 0 0 1px rgba(15,15,20,.08), 0 1px 3px rgba(15,15,20,.06);',
      '}',

      '[data-crop-stage] canvas {',
      '  display: block;',
      '  pointer-events: none;',
      '  background: #ffffff;',
      '}',

      '[data-crop-rect] {',
      '  position: absolute;',
      '  box-sizing: border-box;',
      '  border: 2px solid #06B6D4;',
      '  cursor: move;',
      '  touch-action: none;',
      '  z-index: 2;',
      '  contain: layout style;',
      '  box-shadow: 0 0 0 5000px rgba(15, 15, 20, 0.6);',
      '}',

      '[data-crop-rect]::before,',
      '[data-crop-rect]::after {',
      '  content: "";',
      '  position: absolute;',
      '  inset: 0;',
      '  pointer-events: none;',
      '}',
      '[data-crop-rect]::before {',
      '  background-image:',
      '    linear-gradient(to right, transparent calc(33.333% - 0.5px), rgba(6,182,212,0.35) calc(33.333% - 0.5px), rgba(6,182,212,0.35) calc(33.333% + 0.5px), transparent calc(33.333% + 0.5px)),',
      '    linear-gradient(to right, transparent calc(66.666% - 0.5px), rgba(6,182,212,0.35) calc(66.666% - 0.5px), rgba(6,182,212,0.35) calc(66.666% + 0.5px), transparent calc(66.666% + 0.5px));',
      '}',
      '[data-crop-rect]::after {',
      '  background-image:',
      '    linear-gradient(to bottom, transparent calc(33.333% - 0.5px), rgba(6,182,212,0.35) calc(33.333% - 0.5px), rgba(6,182,212,0.35) calc(33.333% + 0.5px), transparent calc(33.333% + 0.5px)),',
      '    linear-gradient(to bottom, transparent calc(66.666% - 0.5px), rgba(6,182,212,0.35) calc(66.666% - 0.5px), rgba(6,182,212,0.35) calc(66.666% + 0.5px), transparent calc(66.666% + 0.5px));',
      '}',

      '[data-crop-handle] {',
      '  position: absolute;',
      '  width: 26px;',
      '  height: 26px;',
      '  background: transparent;',
      '  z-index: 3;',
      '  -webkit-tap-highlight-color: transparent;',
      '}',
      '[data-crop-handle]::after {',
      '  content: "";',
      '  position: absolute;',
      '  top: 50%;',
      '  left: 50%;',
      '  width: 10px;',
      '  height: 10px;',
      '  margin: -5px 0 0 -5px;',
      '  background: #ffffff;',
      '  border: 2px solid #06B6D4;',
      '  border-radius: 3px;',
      '  box-shadow: 0 1px 3px rgba(0,0,0,.25);',
      '}',

      '[data-crop-handle="nw"] { top: -13px; left: -13px;  cursor: nwse-resize; }',
      '[data-crop-handle="n"]  { top: -13px; left: 50%; margin-left: -13px; cursor: ns-resize; }',
      '[data-crop-handle="ne"] { top: -13px; right: -13px; cursor: nesw-resize; }',
      '[data-crop-handle="e"]  { top: 50%; right: -13px; margin-top: -13px; cursor: ew-resize; }',
      '[data-crop-handle="se"] { bottom: -13px; right: -13px; cursor: nwse-resize; }',
      '[data-crop-handle="s"]  { bottom: -13px; left: 50%; margin-left: -13px; cursor: ns-resize; }',
      '[data-crop-handle="sw"] { bottom: -13px; left: -13px; cursor: nesw-resize; }',
      '[data-crop-handle="w"]  { top: 50%; left: -13px; margin-top: -13px; cursor: ew-resize; }',

      'body.is-cropping, body.is-cropping * { cursor: default !important; }',
      'body.is-cropping { user-select: none; -webkit-user-select: none; }',

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
      '  transition: border-color .15s, background-color .15s, box-shadow .15s, transform .1s;',
      '  cursor: text;',
      '}',
      '[data-page-input]:hover:not(:disabled):not(:focus) {',
      '  border-color: #94a3b8;',
      '  background: #ffffff;',
      '}',
      '[data-page-input]:focus {',
      '  border-color: #06B6D4;',
      '  background: #ffffff;',
      '  box-shadow: 0 0 0 3px rgba(6, 182, 212, 0.18);',
      '  transform: translateY(-1px);',
      '}',
      '[data-page-input]::-webkit-outer-spin-button,',
      '[data-page-input]::-webkit-inner-spin-button {',
      '  -webkit-appearance: none;',
      '  margin: 0;',
      '}',
      '[data-page-input]:disabled {',
      '  opacity: 0.5;',
      '  cursor: not-allowed;',
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
    if (t.closest('[data-dropzone]'))    { state.root.querySelector('[data-file-input]')?.click(); return; }
    if (t.closest('[data-clear]'))       { closeMenu(); removeFile(); return; }
    if (t.closest('[data-remove-file]')) { closeMenu(); removeFile(); return; }
    if (t.closest('[data-save]'))        { applyCrop(); return; }
    if (t.closest('[data-download]'))    { handleDownload(); return; }
    if (t.closest('[data-share]'))       { handleShare(); return; }
    if (t.closest('[data-start-over]'))  { startOver(); return; }

    if (t.closest('[data-prev-page]'))   { goToPage(state.currentPage - 1); return; }
    if (t.closest('[data-next-page]'))   { goToPage(state.currentPage + 1); return; }
    if (t.closest('[data-reset-crop]'))  { resetCrop(); return; }
    if (t.closest('[data-apply-all]'))   { applyToAllPages(); return; }

    if (t.closest('[data-menu-toggle]')) {
      const dd = state.root.querySelector('[data-menu-dropdown]');
      if (dd) dd.classList.toggle('hidden');
      return;
    }

    if (t.closest('[data-menu-reset]'))     { resetCrop();      closeMenu(); return; }
    if (t.closest('[data-menu-apply-all]')) { applyToAllPages(); closeMenu(); return; }
    if (t.closest('[data-menu-reset-all]')) { resetAllCrops();  closeMenu(); return; }
  }

  function handleInput(e) {
    if (e.target.matches('[data-file-input]')) {
      if (e.target.files && e.target.files.length) {
        addFile(e.target.files);
        e.target.value = '';
      }
      return;
    }

    if (e.target.matches('[data-page-input]')) {
      const total = state.file?.pageCount || 1;
      const maxLen = String(total).length;
      const cleaned = String(e.target.value || '').replace(/\D/g, '').slice(0, maxLen);
      if (cleaned !== e.target.value) e.target.value = cleaned;
    }
  }

  function handleFocusIn(e) {
    if (e.target.matches('[data-filename]')) {
      try { e.target.select(); } catch (err) {}
      return;
    }
    if (e.target.matches('[data-page-input]')) {
      try { e.target.select(); } catch (err) {}
    }
  }

  function handleFocusOut(e) {
    if (e.target.matches('[data-page-input]')) commitPageInput();
  }

  function handleKeyDown(e) {
    if (e.target.matches('[data-filename]') && e.key === 'Enter') {
      e.preventDefault();
      handleDownload();
      return;
    }
    if (e.target.matches('[data-page-input]')) {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitPageInput();
        try { e.target.blur(); } catch (err) {}
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.target.value = String(state.currentPage + 1);
        try { e.target.blur(); } catch (err) {}
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const total = state.file?.pageCount || 1;
        const cur = parseInt(e.target.value, 10) || 1;
        e.target.value = String(Math.min(total, cur + 1));
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const cur = parseInt(e.target.value, 10) || 1;
        e.target.value = String(Math.max(1, cur - 1));
        return;
      }
    }
  }

  function handleResize() {
    if (!state.file || state.file.error || state.file.loading || !state.jsDoc) return;
    if (resizeRafId) return;
    resizeRafId = requestAnimationFrame(() => {
      resizeRafId = null;
      clearPageCache();
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
  function template() {
    return `
      <div class="crop-root min-h-screen bg-white flex flex-col">

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
                Crop<span style="color:${BRAND}">PDF</span>
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
                <div data-menu-dropdown class="hidden absolute right-0 top-full z-40 mt-2 w-56 overflow-hidden rounded-xl border border-gray-200 bg-white p-1 shadow-xl shadow-gray-900/10"
                     style="animation: crop-toast-in .15s cubic-bezier(0.4,0,0.2,1);">
                  <button type="button" data-menu-apply-all class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-semibold text-gray-900 transition hover:bg-gray-100">
                    <i data-lucide="copy" style="width:16px;height:16px;" class="text-gray-500"></i>
                    Apply to all pages
                  </button>
                  <button type="button" data-menu-reset class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-semibold text-gray-900 transition hover:bg-gray-100">
                    <i data-lucide="undo-2" style="width:16px;height:16px;" class="text-gray-500"></i>
                    Reset this page
                  </button>
                  <div class="my-1 h-px bg-gray-100"></div>
                  <button type="button" data-menu-reset-all class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-semibold text-rose-600 transition hover:bg-rose-50">
                    <i data-lucide="rotate-ccw" style="width:16px;height:16px;"></i>
                    Reset all pages
                  </button>
                </div>
              </div>
            </div>
          </div>
        </header>

        <main class="flex-1 w-full max-w-3xl mx-auto px-4 sm:px-6 pt-4 pb-36">

          <div data-work-workspace>

            <label data-dropzone
                   class="group relative block cursor-pointer rounded-2xl bg-crop-500 px-4 py-8 text-center transition-all duration-200 hover:bg-crop-600 focus-within:outline-none sm:px-8 sm:py-10">
              <div class="dz-inner absolute inset-3.5 rounded-xl border-2 border-dashed border-white/60 transition-colors duration-200"></div>
              <input type="file" data-file-input accept=".pdf,application/pdf" hidden />

              <div class="relative z-10 flex flex-col items-center justify-center min-h-[180px] sm:min-h-[210px]">
                <svg width="130" height="84" viewBox="0 0 130 84" fill="none" xmlns="http://www.w3.org/2000/svg" class="mb-5">
                  <!-- Full page (dimmed — this part will be trimmed away) -->
                  <rect x="24" y="8" width="82" height="68" rx="5" fill="white" opacity="0.35"/>

                  <!-- Kept region (bright) -->
                  <rect x="34" y="18" width="62" height="48" rx="3" fill="white" opacity="0.95"/>

                  <!-- Crop boundary (dashed) -->
                  <rect x="34" y="18" width="62" height="48" rx="3" fill="none" stroke="#0E7490" stroke-width="2" stroke-dasharray="5 4"/>

                  <!-- Corner handles (bold L-shapes) -->
                  <path d="M34 28 L34 18 L44 18" stroke="#0E7490" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
                  <path d="M86 18 L96 18 L96 28" stroke="#0E7490" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
                  <path d="M96 56 L96 66 L86 66" stroke="#0E7490" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
                  <path d="M44 66 L34 66 L34 56" stroke="#0E7490" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>

                  <!-- Content lines inside the kept region -->
                  <rect x="44" y="28" width="30" height="3" rx="1.5" fill="#A5F3FC"/>
                  <rect x="44" y="36" width="22" height="3" rx="1.5" fill="#A5F3FC"/>
                  <rect x="44" y="44" width="26" height="3" rx="1.5" fill="#A5F3FC"/>
                  <rect x="44" y="52" width="18" height="3" rx="1.5" fill="#A5F3FC"/>
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
                        class="grid h-9 w-9 place-items-center rounded-full border border-gray-200 bg-white text-gray-700 transition hover:border-crop-300 hover:text-crop-600 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40">
                  <i data-lucide="chevron-left" style="width:16px;height:16px;"></i>
                </button>

                <p class="flex items-center gap-1.5 text-[12px] font-medium text-gray-900">
                  Page
                  <input type="text" inputmode="numeric" autocomplete="off" spellcheck="false"
                         data-page-input value="1" disabled aria-label="Current page" />
                  of <span data-total-pages class="font-bold text-gray-900">1</span>
                  <span class="ml-2 inline-flex items-center gap-1 rounded-full bg-crop-50 px-2 py-0.5 text-[10px] font-bold text-crop-700">
                    <span data-crop-size>90% × 90%</span>
                  </span>
                </p>

                <button type="button" data-next-page aria-label="Next page"
                        class="grid h-9 w-9 place-items-center rounded-full border border-gray-200 bg-white text-gray-700 transition hover:border-crop-300 hover:text-crop-600 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40">
                  <i data-lucide="chevron-right" style="width:16px;height:16px;"></i>
                </button>
              </div>

              <div data-crop-stage-wrap class="relative">
                <div data-crop-stage>
                  <canvas data-page-canvas></canvas>
                  <div data-crop-rect>
                    <div data-crop-handle="nw"></div>
                    <div data-crop-handle="n"></div>
                    <div data-crop-handle="ne"></div>
                    <div data-crop-handle="e"></div>
                    <div data-crop-handle="se"></div>
                    <div data-crop-handle="s"></div>
                    <div data-crop-handle="sw"></div>
                    <div data-crop-handle="w"></div>
                  </div>
                </div>
              </div>

              <div class="mt-3 flex items-center justify-center gap-2">
                <button type="button" data-reset-crop
                        class="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-[11px] font-bold text-gray-900 transition hover:border-crop-300 hover:text-crop-600 active:scale-95">
                  <i data-lucide="undo-2" style="width:14px;height:14px;"></i>
                  Reset
                </button>
                <button type="button" data-apply-all
                        class="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-[11px] font-bold text-gray-900 transition hover:border-crop-300 hover:text-crop-600 active:scale-95">
                  <i data-lucide="copy" style="width:14px;height:14px;"></i>
                  Apply to all
                </button>
              </div>

              <p class="mt-2 text-center text-[11px] text-gray-900">
                Drag inside the frame to move · drag edges/corners to resize · type a page number to jump
              </p>
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
    if (!rootEl) throw new Error('CropPages.render: missing root element');

    await ensurePdfJs();

    state.file = null;
    state.jsDoc = null;
    state.pageCrops = [];
    state.isProcessing = false;
    state.gen = 0;
    state.currentPage = 0;
    state.cropRect = { ...DEFAULT_CROP };
    state.root = rootEl;
    state.onBack = options?.onBack || null;
    state.cleanup = [];
    state.statusTimer = null;
    state.result = null;
    renderToken = 0;
    activeRenderTask = null;
    clearPageCache();

    injectStyles();
    rootEl.innerHTML = template();
    cacheRefs();
    refreshIcons();

    rootEl.addEventListener('click', handleClick);
    rootEl.addEventListener('input', handleInput);
    rootEl.addEventListener('focusin', handleFocusIn);
    rootEl.addEventListener('focusout', handleFocusOut);
    rootEl.addEventListener('keydown', handleKeyDown);
    document.addEventListener('click', handleDocumentClick);
    document.addEventListener('keydown', handleGlobalKey);
    window.addEventListener('resize', handleResize);

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

    const stageEl = rootEl.querySelector('[data-crop-stage]');
    if (stageEl) state.cleanup.push(setupCropInteraction(stageEl));

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
    if (preloadRafId) { cancelAnimationFrame(preloadRafId); preloadRafId = null; }

    if (state.root) {
      state.root.removeEventListener('click', handleClick);
      state.root.removeEventListener('input', handleInput);
      state.root.removeEventListener('focusin', handleFocusIn);
      state.root.removeEventListener('focusout', handleFocusOut);
      state.root.removeEventListener('keydown', handleKeyDown);
    }
    document.removeEventListener('click', handleDocumentClick);
    document.removeEventListener('keydown', handleGlobalKey);
    window.removeEventListener('resize', handleResize);

    document.body.classList.remove('is-cropping');

    cancelActiveRender();
    destroyJsDoc();
    revokeResultUrl();
    clearPageCache();
    releaseCanvas(refs.canvas);
    releaseSourceFile();

    state.cleanup.forEach(fn => { try { fn(); } catch (e) {} });
    state.cleanup = [];
    state.file = null;
    state.pageCrops = [];
    state.root = null;
    state.statusTimer = null;

    refs.canvas = refs.stage = refs.stageWrap = refs.cropRect = null;
    refs.cropSize = refs.summary = refs.saveBtn = null;
    refs.pageInput = refs.totPage = refs.prevBtn = refs.nextBtn = null;
  }

  window.CropPages = { render, destroy };
})();