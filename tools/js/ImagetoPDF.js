/* =====================================================================
 * ImagetoPDF.js — PDFTools image to PDF module
 * Combine JPG / PNG / WebP / GIF / BMP / AVIF images into a single PDF.
 * Theme: orange brand mark in the workspace header (matches the HTML);
 *        blue action elements (Convert, Download, Share).
 *
 * Memory-efficient:
 *   • Bytes are read ONCE at add time (File.arrayBuffer + FileReader fallback)
 *     so we never depend on File handles surviving a cleared input element.
 *   • PNG / non-rotated JPEGs are embedded directly from raw bytes.
 *   • Device-aware batch size limits prevent mobile tab crashes.
 *   • pdf-lib loaded lazily on convert only.
 *
 * Depends on (auto-loaded if missing):
 *   - pdf-lib (PDF generation) — loaded LAZILY on convert
 *   - lucide  (icons, expected on host page)
 * ===================================================================== */
(function () {
  'use strict';

  const PDFLIB_CDN = 'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js';
  const STYLE_ID   = 'img2pdf-styles';

  // Orange brand mark (matches ImagetoPDF.html header/footer accents)
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

    const MB = 1024 * 1024;
    return {
      isMobile, lowMemory, memGB,
      maxSide: lowMemory ? 2000 : (isMobile ? 2800 : 4000),
      maxBatchBytes: lowMemory ? 80 * MB : (isMobile ? 150 * MB : 400 * MB),
      maxSingleFileBytes: lowMemory ? 30 * MB : (isMobile ? 60 * MB : 150 * MB),
      warnBatchBytes: lowMemory ? 60 * MB : (isMobile ? 120 * MB : 320 * MB),
      thumbnailConcurrency: lowMemory ? 4 : (isMobile ? 5 : 8),
    };
  })();

  const DEFAULTS = {
    pageSize: 'auto',
    orientation: 'auto',
    margin: 0,
  };

  const PAGE_SIZES = [
    { value: 'auto',   label: 'Auto',   sub: 'Fit image' },
    { value: 'a4',     label: 'A4',     sub: '210×297' },
    { value: 'letter', label: 'Letter', sub: '8.5×11' },
    { value: 'a3',     label: 'A3',     sub: '297×420' },
  ];

  const ORIENTATIONS = [
    { value: 'auto',      label: 'Auto' },
    { value: 'portrait',  label: 'Portrait' },
    { value: 'landscape', label: 'Landscape' },
  ];

  const PAGE_SIZES_PT = {
    a4:     { w: 595.28, h: 841.89 },
    letter: { w: 612,    h: 792 },
    a3:     { w: 841.89, h: 1190.55 },
  };

  const ACCEPT_ATTR = 'image/jpeg,image/png,image/webp,image/gif,image/bmp,image/avif,.jpg,.jpeg,.png,.webp,.gif,.bmp,.avif';

  const state = {
    files: [],
    settings: { ...DEFAULTS },
    isProcessing: false,
    cancelRequested: false,
    gen: 0,
    root: null,
    onBack: null,
    cleanup: [],
    statusTimer: null,
    result: null,
  };

  const refs = {
    listEl: null, listWrap: null, listWrap2: null, count: null, sizeLabel: null,
    summary: null, saveBtn: null,
    warningEl: null,
    progressOverlay: null, progressBar: null, progressLabel: null, progressCancel: null,
    dropzone: null, fileInput: null, clearBtn: null,
    menuWrap: null, menuDropdown: null, title: null,
    workWs: null, successWs: null, bottomBar: null, status: null,
    pageSizeBtns: null, orientationBtns: null,
    marginInput: null, marginVal: null,
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

  async function ensurePdfLib() {
    if (!window.PDFLib) await loadScript(PDFLIB_CDN);
  }

  function releaseCanvas(canvas) {
    if (!canvas) return;
    try { canvas.width = 0; canvas.height = 0; } catch (e) {}
  }

  async function mapWithConcurrency(items, limit, worker) {
    const n = items.length;
    if (!n) return;
    let cursor = 0;
    const runners = [];
    const count = Math.min(Math.max(1, limit), n);
    for (let k = 0; k < count; k++) {
      runners.push((async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= n) return;
          await worker(items[idx], idx);
        }
      })());
    }
    await Promise.all(runners);
  }

  function revokeResultUrl() {
    const r = state.result;
    if (r && r.url) {
      try { URL.revokeObjectURL(r.url); } catch (e) {}
    }
    state.result = null;
  }

  function cacheRefs() {
    const root = state.root;
    if (!root) return;
    refs.listEl          = root.querySelector('[data-list]');
    refs.listWrap        = root.querySelector('[data-list-wrap]');
    refs.listWrap2       = root.querySelector('[data-list-wrap-2]');
    refs.count           = root.querySelector('[data-count]');
    refs.sizeLabel       = root.querySelector('[data-size-label]');
    refs.summary         = root.querySelector('[data-summary]');
    refs.saveBtn         = root.querySelector('[data-save]');
    refs.warningEl       = root.querySelector('[data-batch-warning]');
    refs.progressOverlay = root.querySelector('[data-progress-overlay]');
    refs.progressBar     = root.querySelector('[data-progress-bar]');
    refs.progressLabel   = root.querySelector('[data-progress-label]');
    refs.progressCancel  = root.querySelector('[data-progress-cancel]');

    refs.dropzone        = root.querySelector('[data-dropzone]');
    refs.fileInput       = root.querySelector('[data-file-input]');
    refs.clearBtn        = root.querySelector('[data-clear]');
    refs.menuWrap        = root.querySelector('[data-menu-wrap]');
    refs.menuDropdown    = root.querySelector('[data-menu-dropdown]');
    refs.title           = root.querySelector('[data-title]');
    refs.workWs          = root.querySelector('[data-work-workspace]');
    refs.successWs       = root.querySelector('[data-success-workspace]');
    refs.bottomBar       = root.querySelector('[data-bottom-bar]');
    refs.status          = root.querySelector('[data-status]');
    refs.pageSizeBtns    = root.querySelectorAll('[data-page-size]');
    refs.orientationBtns = root.querySelectorAll('[data-orientation]');
    refs.marginInput     = root.querySelector('[data-margin]');
    refs.marginVal       = root.querySelector('[data-margin-val]');
  }

  function getCurrentTotalBytes() {
    let sum = 0;
    for (let i = 0; i < state.files.length; i++) sum += state.files[i].size || 0;
    return sum;
  }

  /* ========== RELIABLE FILE READING (the actual fix) ================= */

  function readWithFileReader(file) {
    return new Promise(function (resolve, reject) {
      let reader;
      try {
        reader = new FileReader();
      } catch (e) {
        return reject(e);
      }
      reader.onload = function () {
        const r = reader.result;
        if (r && r.byteLength > 0) resolve(r);
        else reject(new Error('Empty file'));
      };
      reader.onerror = function () {
        reject(reader.error || new Error('FileReader error'));
      };
      reader.onabort = function () {
        reject(new Error('Read aborted'));
      };
      try {
        reader.readAsArrayBuffer(file);
      } catch (e) {
        reject(e);
      }
    });
  }

  async function readFileAsArrayBuffer(file) {
    if (!file) throw new Error('No file');

    // Prefer File.arrayBuffer() — fastest path on modern browsers.
    if (typeof file.arrayBuffer === 'function') {
      try {
        const buf = await file.arrayBuffer();
        if (buf && buf.byteLength > 0) return buf;
        // Empty — fall through to FileReader just in case.
      } catch (err) {
        // Fall through to FileReader.
      }
    }

    // FileReader is the most widely-supported fallback.
    return await readWithFileReader(file);
  }

  /* ------------------------- header parsers -------------------------- */
  function parsePng(bytes) {
    try {
      if (bytes.length < 24) return null;
      if (bytes[0] !== 0x89 || bytes[1] !== 0x50 ||
          bytes[2] !== 0x4E || bytes[3] !== 0x47) return null;

      const dv = new DataView(bytes.buffer, bytes.byteOffset, 24);
      const width  = dv.getUint32(16, false);
      const height = dv.getUint32(20, false);
      if (!width || !height) return null;
      if (width > 0x7FFFFFFF || height > 0x7FFFFFFF) return null;

      return { width, height };
    } catch (e) {
      return null;
    }
  }

  function parseJpeg(bytes) {
    try {
      const length = bytes.length;
      if (length < 4) return null;

      const dv = new DataView(bytes.buffer, bytes.byteOffset, length);
      if (dv.getUint16(0, false) !== 0xFFD8) return null;

      let offset = 2;
      let width = 0, height = 0, orientation = 1;

      while (offset < length - 1) {
        if (dv.getUint8(offset) !== 0xFF) break;
        const marker = dv.getUint8(offset + 1);

        if (marker === 0xD8 || marker === 0xD9 ||
            (marker >= 0xD0 && marker <= 0xD7)) {
          offset += 2;
          continue;
        }
        if (marker === 0xDA) break;

        if (offset + 3 >= length) break;
        const segLen = dv.getUint16(offset + 2, false);
        if (segLen < 2 || offset + 2 + segLen > length) break;

        if (marker === 0xE1 && segLen >= 8) {
          if (dv.getUint32(offset + 4, false) === 0x45786966) {
            const tiff = offset + 10;
            if (tiff + 8 <= length) {
              const littleEndian = dv.getUint16(tiff, false) === 0x4949;
              const ifdOffset = tiff + dv.getUint32(tiff + 4, littleEndian);
              if (ifdOffset + 2 <= length) {
                const numEntries = dv.getUint16(ifdOffset, littleEndian);
                for (let i = 0; i < numEntries; i++) {
                  const entry = ifdOffset + 2 + i * 12;
                  if (entry + 12 > length) break;
                  const tag = dv.getUint16(entry, littleEndian);
                  if (tag === 0x0112) {
                    const value = dv.getUint16(entry + 8, littleEndian);
                    if (value >= 1 && value <= 8) orientation = value;
                    break;
                  }
                }
              }
            }
          }
        }

        if (marker >= 0xC0 && marker <= 0xCF &&
            marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          if (offset + 9 <= length) {
            height = dv.getUint16(offset + 5, false);
            width  = dv.getUint16(offset + 7, false);
          }
        }

        offset += 2 + segLen;
      }

      if (!width || !height) return null;
      return { width, height, orientation };
    } catch (e) {
      return null;
    }
  }

  /* -------------------------- image pipeline ------------------------- */
  async function processImage(item) {
    // Guaranteed to exist thanks to add-time reads. If somehow missing,
    // attempt one last re-read from the original File handle.
    let bytes = item.bytes;
    if (!bytes || !bytes.byteLength) {
      if (item.file) {
        try {
          const buf = await readFileAsArrayBuffer(item.file);
          if (buf && buf.byteLength > 0) {
            bytes = new Uint8Array(buf);
            item.bytes = bytes;
          }
        } catch (err) {
          throw new Error('Could not re-read image data: ' + (err.message || 'unknown'));
        }
      }
      if (!bytes || !bytes.byteLength) {
        throw new Error('Image data unavailable');
      }
    }

    const type = (item.file && item.file.type ? item.file.type : '').toLowerCase();
    const isPng = type === 'image/png';
    const isJpg = type === 'image/jpeg' || type === 'image/jpg';

    if (isPng) {
      const dims = parsePng(bytes);
      if (dims && dims.width > 0 && dims.height > 0) {
        return { bytes, mime: 'image/png', width: dims.width, height: dims.height };
      }
    }

    if (isJpg) {
      const info = parseJpeg(bytes);
      if (info && info.orientation === 1 && info.width > 0 && info.height > 0) {
        return { bytes, mime: 'image/jpeg', width: info.width, height: info.height };
      }
    }

    const blob = new Blob([bytes], { type: type || 'application/octet-stream' });
    return await reencodeViaCanvas(blob, isPng);
  }

  async function reencodeViaCanvas(blob, preferPng) {
    let source = null;
    let cleanupSource = function () {};

    try {
      if (typeof createImageBitmap === 'function') {
        try {
          source = await createImageBitmap(blob, { imageOrientation: 'from-image' });
          cleanupSource = function () { try { source.close(); } catch (e) {} };
        } catch (e) { source = null; }
      }

      if (!source) {
        const url = URL.createObjectURL(blob);
        cleanupSource = function () { try { URL.revokeObjectURL(url); } catch (e) {} };
        source = await new Promise(function (resolve, reject) {
          const img = new Image();
          img.onload  = function () { resolve(img); };
          img.onerror = function () { reject(new Error('Image decode failed')); };
          img.src = url;
        });
      }

      let w = source.width || source.naturalWidth;
      let h = source.height || source.naturalHeight;
      if (!w || !h) throw new Error('Image has no dimensions');

      const maxSide = CAPS.maxSide;
      if (Math.max(w, h) > maxSide) {
        const scale = maxSide / Math.max(w, h);
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
      }

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { alpha: preferPng, desynchronized: true });
      if (!ctx) throw new Error('Canvas 2D context unavailable');

      if (!preferPng) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
      }
      ctx.drawImage(source, 0, 0, w, h);

      const outMime = preferPng ? 'image/png' : 'image/jpeg';
      const quality = preferPng ? undefined   : 0.92;
      const outBlob = await canvasToBlob(canvas, outMime, quality);

      releaseCanvas(canvas);

      const outBytes = new Uint8Array(await outBlob.arrayBuffer());

      return { bytes: outBytes, mime: outMime, width: w, height: h };
    } finally {
      try { cleanupSource(); } catch (e) {}
    }
  }

  function canvasToBlob(canvas, mime, quality) {
    return new Promise(function (resolve, reject) {
      try {
        canvas.toBlob(function (blob) {
          if (blob) { resolve(blob); return; }
          reject(new Error('Canvas export failed'));
        }, mime, quality);
      } catch (e) { reject(e); }
    });
  }

  /* --------------------- image dimension load ------------------------ */
  function loadImageDimensions(url) {
    return new Promise(function (resolve) {
      const img = new Image();
      img.onload  = function () { resolve({ width: img.naturalWidth, height: img.naturalHeight }); };
      img.onerror = function () { resolve({ width: 0, height: 0 }); };
      img.src = url;
    });
  }

  /* ------------------------------ add -------------------------------- */
  function isSupportedImageFile(file) {
    const t = (file.type || '').toLowerCase();
    if (t === 'image/jpeg' || t === 'image/jpg' || t === 'image/png' ||
        t === 'image/webp' || t === 'image/gif' ||
        t === 'image/bmp'  || t === 'image/avif') {
      return true;
    }
    return /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(file.name || '');
  }

  async function addFiles(fileList) {
    const incoming = Array.from(fileList || []).filter(isSupportedImageFile);

    if (!incoming.length) {
      if (fileList && fileList.length) {
        showToast('No supported images (JPG, PNG, WebP, GIF, BMP, AVIF).', 'error');
      }
      return;
    }

    const currentTotal = getCurrentTotalBytes();
    const maxBatch = CAPS.maxBatchBytes;
    const maxSingle = CAPS.maxSingleFileBytes;

    const accepted = [];
    let rejectedTooBig = 0;
    let rejectedWouldOverflow = 0;
    let runningTotal = currentTotal;

    for (let i = 0; i < incoming.length; i++) {
      const f = incoming[i];
      if (f.size > maxSingle) {
        rejectedTooBig++;
        continue;
      }
      if (runningTotal + f.size > maxBatch) {
        rejectedWouldOverflow++;
        continue;
      }
      accepted.push(f);
      runningTotal += f.size;
    }

    if (rejectedTooBig > 0) {
      showToast(
        rejectedTooBig === 1
          ? '1 image exceeds the ' + formatBytes(maxSingle) + ' per-file limit'
          : rejectedTooBig + ' images exceed the ' + formatBytes(maxSingle) + ' per-file limit',
        'error', 3200
      );
    }
    if (rejectedWouldOverflow > 0) {
      const label = rejectedTooBig > 0 ? ' Additional' : '';
      showToast(
        (label + ' ' + rejectedWouldOverflow + ' image' + (rejectedWouldOverflow !== 1 ? 's' : '') + ' skipped — batch would exceed ' + formatBytes(maxBatch)).trim(),
        'error', 3200
      );
    }

    if (!accepted.length) {
      updateBatchWarning();
      return;
    }

    const myGen = state.gen;

    // ---- CRITICAL: Read bytes NOW, before the file input gets cleared. ----
    // Also record which files failed so we can report them.
    const readResults = new Array(accepted.length);
    await mapWithConcurrency(accepted, CAPS.thumbnailConcurrency, async function (f, idx) {
      try {
        const buf = await readFileAsArrayBuffer(f);
        if (!buf || buf.byteLength === 0) {
          readResults[idx] = { file: f, bytes: null, error: 'Empty file' };
        } else {
          readResults[idx] = { file: f, bytes: new Uint8Array(buf), error: null };
        }
      } catch (err) {
        readResults[idx] = {
          file: f,
          bytes: null,
          error: (err && err.message) || 'Read failed',
        };
      }
    });

    if (myGen !== state.gen) return;

    const readable   = readResults.filter(function (r) { return r && !r.error && r.bytes; });
    const unreadable = readResults.filter(function (r) { return r && r.error; });

    if (unreadable.length > 0) {
      const names = unreadable.slice(0, 2).map(function (r) { return r.file.name; }).join(', ');
      const more = unreadable.length > 2 ? ' (+' + (unreadable.length - 2) + ' more)' : '';
      showToast(
        unreadable.length + ' image' + (unreadable.length > 1 ? 's' : '') +
        ' couldn\u2019t be read: ' + names + more,
        'error', 4200
      );
    }

    if (!readable.length) {
      updateBatchWarning();
      return;
    }

    const newItems = readable.map(function (r) {
      return {
        id: uid(),
        file: r.file,
        name: r.file.name,
        size: r.file.size,
        bytes: r.bytes,
        thumbUrl: URL.createObjectURL(r.file),
        width: 0, height: 0,
        loading: true,
      };
    });

    state.files.push.apply(state.files, newItems);
    renderList();
    updateSummary();
    updateBottomBar();

    // Load dimensions via the blob URL — separate from byte reads.
    await mapWithConcurrency(newItems, CAPS.thumbnailConcurrency, async function (item) {
      if (myGen !== state.gen) return;
      const dims = await loadImageDimensions(item.thumbUrl);
      if (myGen !== state.gen) return;
      item.width  = dims.width;
      item.height = dims.height;
      item.loading = false;
      updateRowMeta(item.id);
    });
  }

  function releaseItemMemory(item) {
    if (!item) return;
    if (item.thumbUrl) { try { URL.revokeObjectURL(item.thumbUrl); } catch (e) {} }
    item.thumbUrl = null;
    item.file = null;
    item.bytes = null;
  }

  function removeFile(id) {
    const idx = state.files.findIndex(function (f) { return f.id === id; });
    if (idx === -1) return;
    const item = state.files[idx];
    releaseItemMemory(item);
    state.files.splice(idx, 1);
    renderList();
    updateSummary();
    updateBottomBar();
  }

  function clearAll() {
    if (!state.files.length) return;
    for (let i = 0; i < state.files.length; i++) {
      releaseItemMemory(state.files[i]);
    }
    state.files = [];
    renderList();
    updateSummary();
    updateBottomBar();
    showToast('Cleared', 'success');
  }

  function moveFile(id, direction) {
    const idx = state.files.findIndex(function (f) { return f.id === id; });
    if (idx === -1) return;
    const target = idx + direction;
    if (target < 0 || target >= state.files.length) return;
    const item = state.files.splice(idx, 1)[0];
    state.files.splice(target, 0, item);
    renderList();
    updateSummary();
  }

  /* --------------------------- list render --------------------------- */
  function rowHtml(item, index) {
    const total = state.files.length;
    const isFirst = index === 0;
    const isLast  = index === total - 1;
    const dims = item.loading
      ? 'Reading…'
      : (item.width && item.height
          ? item.width + ' × ' + item.height + ' · ' + formatBytes(item.size)
          : formatBytes(item.size));

    return '' +
      '<div class="img-row flex items-center gap-2 rounded-xl border border-gray-200 bg-white p-2 pr-1.5 transition" data-row-id="' + item.id + '">' +
        '<span class="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-gray-100 text-[11px] font-bold text-gray-900">' + (index + 1) + '</span>' +
        '<button type="button" data-drag-handle aria-label="Drag to reorder" class="grid h-8 w-6 shrink-0 cursor-grab place-items-center rounded-md text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 active:cursor-grabbing">' +
          '<i data-lucide="grip-vertical" style="width:16px;height:16px;"></i>' +
        '</button>' +
        '<div class="relative grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-lg bg-gray-100">' +
          '<img src="' + item.thumbUrl + '" alt="" class="max-h-full max-w-full object-contain" />' +
        '</div>' +
        '<div class="min-w-0 flex-1 py-0.5">' +
          '<p class="truncate text-[13px] font-semibold leading-tight text-gray-900">' + escapeHtml(item.name) + '</p>' +
          '<p data-row-meta="' + item.id + '" class="mt-0.5 truncate text-[11px] leading-tight text-gray-900">' + escapeHtml(dims) + '</p>' +
        '</div>' +
        '<div class="flex shrink-0 items-center gap-0.5">' +
          '<button type="button" data-move-up="' + item.id + '" aria-label="Move up" ' + (isFirst ? 'disabled' : '') +
            ' class="grid h-8 w-8 place-items-center rounded-md text-gray-500 transition hover:bg-orange-50 hover:text-orange-600 active:scale-95 disabled:cursor-not-allowed disabled:opacity-30">' +
            '<i data-lucide="chevron-up" style="width:16px;height:16px;"></i>' +
          '</button>' +
          '<button type="button" data-move-down="' + item.id + '" aria-label="Move down" ' + (isLast ? 'disabled' : '') +
            ' class="grid h-8 w-8 place-items-center rounded-md text-gray-500 transition hover:bg-orange-50 hover:text-orange-600 active:scale-95 disabled:cursor-not-allowed disabled:opacity-30">' +
            '<i data-lucide="chevron-down" style="width:16px;height:16px;"></i>' +
          '</button>' +
        '</div>' +
        '<button type="button" data-remove="' + item.id + '" aria-label="Remove" ' +
          ' class="grid h-8 w-8 shrink-0 place-items-center rounded-md text-gray-500 transition hover:bg-rose-50 hover:text-rose-500 active:scale-95">' +
          '<i data-lucide="x" style="width:16px;height:16px;"></i>' +
        '</button>' +
      '</div>';
  }

  function updateBatchWarning(totalBytes) {
    const el = refs.warningEl;
    if (!el) return;

    if (typeof totalBytes !== 'number') totalBytes = getCurrentTotalBytes();
    const maxBatch = CAPS.maxBatchBytes;
    const warnAt = CAPS.warnBatchBytes;

    if (!state.files.length || totalBytes < warnAt) {
      el.classList.add('hidden');
      el.innerHTML = '';
      return;
    }

    const pct = Math.min(100, Math.round((totalBytes / maxBatch) * 100));
    const isCritical = totalBytes >= maxBatch * 0.95;

    el.classList.remove('hidden');
    el.innerHTML =
      '<div class="flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-[12px] ' +
        (isCritical
          ? 'border-rose-200 bg-rose-50 text-rose-700'
          : 'border-amber-200 bg-amber-50 text-amber-700') +
      '">' +
        '<i data-lucide="' + (isCritical ? 'alert-triangle' : 'info') + '" class="mt-0.5 shrink-0" style="width:14px;height:14px;"></i>' +
        '<div class="min-w-0 flex-1">' +
          '<p class="font-bold">' +
            (isCritical ? 'Batch is nearly full' : 'Large batch') +
          '</p>' +
          '<p class="mt-0.5 opacity-90">' +
            'Using ' + formatBytes(totalBytes) + ' of ' + formatBytes(maxBatch) + ' (' + pct + '%). ' +
            (isCritical
              ? 'Adding more images may fail.'
              : 'Consider splitting into multiple PDFs.') +
          '</p>' +
        '</div>' +
      '</div>';
    refreshIcons();
  }

  function renderList() {
    if (!state.root) return;

    const hasFiles = state.files.length > 0;
    const totalBytes = getCurrentTotalBytes();

    if (refs.count) refs.count.textContent = String(state.files.length);
    if (refs.sizeLabel) refs.sizeLabel.textContent = hasFiles ? formatBytes(totalBytes) : '';
    if (refs.listWrap) refs.listWrap.classList.toggle('hidden', !hasFiles);
    if (refs.listWrap2) refs.listWrap2.classList.toggle('hidden', !hasFiles);
    if (refs.menuWrap) refs.menuWrap.classList.toggle('hidden', !hasFiles);
    if (refs.clearBtn) refs.clearBtn.classList.toggle('hidden', !hasFiles);
    if (refs.dropzone) refs.dropzone.classList.toggle('hidden', hasFiles);

    if (!refs.listEl) return;
    if (!hasFiles) {
      refs.listEl.innerHTML = '';
      updateBatchWarning(totalBytes);
      return;
    }

    refs.listEl.innerHTML = state.files.map(function (f, i) { return rowHtml(f, i); }).join('');
    refreshIcons();
    updateBatchWarning(totalBytes);
  }

  function updateRowMeta(id) {
    const item = state.files.find(function (f) { return f.id === id; });
    if (!item) return;
    const el = state.root && state.root.querySelector('[data-row-meta="' + id + '"]');
    if (!el) return;
    el.textContent = item.width && item.height
      ? item.width + ' × ' + item.height + ' · ' + formatBytes(item.size)
      : formatBytes(item.size);
  }

  function updateSummary() {
    const el = refs.summary || (state.root && state.root.querySelector('[data-summary]'));
    if (!el) return;

    if (state.isProcessing) { el.textContent = 'Converting…'; return; }
    if (!state.files.length) { el.textContent = 'Add images to get started'; return; }

    const n = state.files.length;
    let sizeLabel = 'Auto';
    for (let i = 0; i < PAGE_SIZES.length; i++) {
      if (PAGE_SIZES[i].value === state.settings.pageSize) { sizeLabel = PAGE_SIZES[i].label; break; }
    }
    el.textContent = n + ' image' + (n !== 1 ? 's' : '') + ' · ' + sizeLabel + ' · ' + state.settings.orientation;
  }

  function updateBottomBar() {
    const btn = refs.saveBtn || (state.root && state.root.querySelector('[data-save]'));
    if (!btn) return;
    const ready = state.files.length > 0 && !state.isProcessing;

    btn.disabled = !ready;
    btn.innerHTML = state.isProcessing
      ? '<i data-lucide="loader-2" style="width:20px;height:20px;" class="animate-spin"></i><span>Converting…</span>'
      : 'Convert to PDF <i data-lucide="arrow-right" style="width:20px;height:20px;"></i>';
    refreshIcons();
    updateSummary();
  }

  /* --------------------------- settings UI --------------------------- */
  function applySettingsToUI() {
    if (!state.root) return;
    const s = state.settings;

    if (refs.pageSizeBtns) {
      refs.pageSizeBtns.forEach(function (btn) {
        btn.classList.toggle('is-active', btn.getAttribute('data-page-size') === s.pageSize);
      });
    }
    if (refs.orientationBtns) {
      refs.orientationBtns.forEach(function (btn) {
        btn.classList.toggle('is-active', btn.getAttribute('data-orientation') === s.orientation);
      });
    }
    if (refs.marginInput) refs.marginInput.value = String(s.margin);
    if (refs.marginVal)   refs.marginVal.textContent = s.margin + 'pt';
  }

  function setSetting(key, value) {
    state.settings[key] = value;
    applySettingsToUI();
    updateBottomBar();
  }

  /* ---------------------------- layout ------------------------------- */
  function computeLayout(imgW, imgH, settings) {
    const margin = settings.margin || 0;

    if (settings.pageSize === 'auto') {
      return {
        pageW: imgW + margin * 2,
        pageH: imgH + margin * 2,
        drawW: imgW,
        drawH: imgH,
        x: margin,
        y: margin,
      };
    }

    const base = PAGE_SIZES_PT[settings.pageSize] || PAGE_SIZES_PT.a4;
    let pageW = base.w;
    let pageH = base.h;

    let targetLandscape;
    if (settings.orientation === 'landscape')     targetLandscape = true;
    else if (settings.orientation === 'portrait') targetLandscape = false;
    else                                          targetLandscape = imgW > imgH;

    const baseIsLandscape = pageW > pageH;
    if (baseIsLandscape !== targetLandscape) {
      const t = pageW; pageW = pageH; pageH = t;
    }

    const availW = Math.max(1, pageW - margin * 2);
    const availH = Math.max(1, pageH - margin * 2);

    const ratio = Math.min(availW / imgW, availH / imgH);
    const drawW = imgW * ratio;
    const drawH = imgH * ratio;

    return {
      pageW: pageW, pageH: pageH,
      drawW: drawW, drawH: drawH,
      x: (pageW - drawW) / 2,
      y: (pageH - drawH) / 2,
    };
  }

  /* ---------------------------- progress ----------------------------- */
  function showProgress() {
    if (refs.progressOverlay) refs.progressOverlay.classList.remove('hidden');
    if (refs.progressBar) refs.progressBar.style.width = '0%';
    if (refs.progressLabel) refs.progressLabel.textContent = 'Starting…';
    if (refs.progressCancel) refs.progressCancel.disabled = false;
  }

  function updateProgress(current, total, label) {
    if (refs.progressBar) refs.progressBar.style.width = (total ? Math.round(current / total * 100) : 0) + '%';
    if (refs.progressLabel) refs.progressLabel.textContent = label || (current + ' / ' + total);
  }

  function hideProgress() {
    if (refs.progressOverlay) refs.progressOverlay.classList.add('hidden');
  }

  /* ------------------------------ save ------------------------------- */
  async function convert() {
    if (state.isProcessing || !state.files.length) return;

    state.isProcessing = true;
    state.cancelRequested = false;
    updateBottomBar();
    showProgress();

    const myGen = state.gen;
    const total = state.files.length;
    const settings = state.settings;

    let libDoc = null;
    let firstError = null;
    let added = 0;

    try {
      await ensurePdfLib();

      const PDFDocument = window.PDFLib.PDFDocument;
      libDoc = await PDFDocument.create();

      const filesSnapshot = state.files.slice();

      for (let i = 0; i < filesSnapshot.length; i++) {
        if (state.cancelRequested || myGen !== state.gen) throw new Error('__cancelled__');
        const item = filesSnapshot[i];

        updateProgress(i, total, 'Image ' + (i + 1) + ' of ' + total);

        try {
          let processed;
          try {
            processed = await processImage(item);
          } catch (err) {
            if (!firstError) firstError = err;
            console.error('[ImagetoPDF] process fail "' + item.name + '":', err);
            showToast('Skipped "' + item.name + '": ' + (err.message || 'unknown'), 'error', 2400);
            continue;
          }

          if (state.cancelRequested || myGen !== state.gen) throw new Error('__cancelled__');

          let embedded;
          try {
            embedded = processed.mime === 'image/png'
              ? await libDoc.embedPng(processed.bytes)
              : await libDoc.embedJpg(processed.bytes);
          } catch (err) {
            if (!firstError) firstError = err;
            console.error('[ImagetoPDF] embed fail "' + item.name + '":', err);
            showToast('Skipped "' + item.name + '": ' + (err.message || 'unknown'), 'error', 2400);
            continue;
          }

          const imgW = embedded.width  || item.width  || 1;
          const imgH = embedded.height || item.height || 1;
          const layout = computeLayout(imgW, imgH, settings);

          const page = libDoc.addPage([layout.pageW, layout.pageH]);
          page.drawImage(embedded, {
            x: layout.x,
            y: layout.y,
            width: layout.drawW,
            height: layout.drawH,
          });

          processed.bytes = null;
          processed = null;

          added++;
          updateProgress(i + 1, total, 'Image ' + (i + 1) + ' of ' + total);
        } finally {
          if (!state.cancelRequested && myGen === state.gen) {
            await new Promise(function (r) { setTimeout(r, 0); });
          }
        }
      }

      if (state.cancelRequested || myGen !== state.gen) throw new Error('__cancelled__');

      if (added === 0) {
        const detail = firstError && firstError.message ? ' (' + firstError.message + ')' : '';
        throw new Error('No valid images could be processed' + detail);
      }

      updateProgress(total, total, 'Building PDF…');
      await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });

      const pageCount = libDoc.getPageCount();

      let bytes = await libDoc.save();
      libDoc = null;

      const blob = new Blob([bytes], { type: 'application/pdf' });
      bytes = null;

      const url  = URL.createObjectURL(blob);

      if (state.result && state.result.url) {
        try { URL.revokeObjectURL(state.result.url); } catch (e) {}
      }

      state.result = {
        url: url,
        blob: blob,
        fileName: 'images.pdf',
        pageCount: pageCount,
        imageCount: added,
        totalSize: blob.size,
      };

      hideProgress();
      state.isProcessing = false;
      updateBottomBar();
      showSuccess();
    } catch (err) {
      hideProgress();
      state.isProcessing = false;
      updateBottomBar();
      if (err && err.message === '__cancelled__') {
        showToast('Conversion cancelled', 'info');
      } else {
        console.error('[ImagetoPDF] convert', err);
        showToast('Failed: ' + (err.message || 'Unknown error'), 'error');
      }
    } finally {
      libDoc = null;
    }
  }

  /* --------------------------- success view -------------------------- */
  function showSuccess() {
    if (!state.root || !state.result) return;

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
        <h2 class="text-xl font-extrabold text-gray-900 tracking-tight">PDF Created 🎉</h2>
      </div>

      <p class="text-[13px] text-gray-900 mb-6">
        ${r.imageCount} image${r.imageCount !== 1 ? 's' : ''} combined into ${r.pageCount} page${r.pageCount !== 1 ? 's' : ''}
      </p>

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
    const input = state.root && state.root.querySelector('[data-filename]');
    let base = sanitizeFilename(input ? input.value : '');
    if (!base) base = 'images';
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
    const input = state.root && state.root.querySelector('[data-filename]');
    let base = sanitizeFilename(input ? input.value : '');
    if (!base) base = 'images';
    const filename = base.replace(/\.pdf$/i, '') + '.pdf';

    try {
      const file = new File([state.result.blob], filename, { type: 'application/pdf' });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: 'Combined PDF',
          text: 'Combined with PDFTools',
        });
        return;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }

    handleDownload();
  }

  function startOver() {
    revokeResultUrl();
    closeMenu();
    window.location.reload();
  }

  /* ------------------------------ toast ------------------------------ */
  function showToast(message, type, duration) {
    const el = refs.status || (state.root && state.root.querySelector('[data-status]'));
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
           style="animation: img2pdf-toast-in .22s cubic-bezier(0.4, 0, 0.2, 1);">
        <i data-lucide="${c.icon}" class="h-4 w-4 shrink-0 ${c.iconColor} ${c.spin ? 'animate-spin' : ''}"></i>
        <span class="truncate">${escapeHtml(message)}</span>
      </div>
    `;
    refreshIcons();

    if (duration !== 0 && type !== 'info') {
      state.statusTimer = setTimeout(function () {
        el.innerHTML = '';
        state.statusTimer = null;
      }, duration || 2800);
    }
  }

  /* ===================================================================
   * Drag-to-reorder
   * =================================================================== */
  function setupDrag(listEl) {
    if (!listEl) return function () {};

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
      drag.clone.style.transform = 'translate3d(' + left + 'px,' + top + 'px,0) scale(1.02)';
    }

    function updatePlaceholder(x, y) {
      if (!drag || !drag.active || !drag.placeholder) return;

      drag.clone.style.pointerEvents = 'none';
      const el = document.elementFromPoint(x, y);
      const targetRow = el && el.closest('.img-row');

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

      const handle = e.target.closest('[data-drag-handle]');
      if (!handle) return;
      const row = handle.closest('.img-row');
      if (!row || row.classList.contains('drag-placeholder')) return;

      e.preventDefault();
      e.stopPropagation();

      drag = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        row: row,
        active: false,
        clone: null,
        placeholder: null,
        offsetX: 0,
        offsetY: 0,
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
      ph.className = 'img-row drag-placeholder';
      ph.style.height = rect.height + 'px';
      ph.style.borderRadius = '0.75rem';
      ph.style.border = '2px dashed #FDBA74';
      ph.style.background = 'rgba(249, 115, 22, 0.06)';
      ph.style.pointerEvents = 'none';
      ph.style.transition = 'none';
      drag.placeholder = ph;

      const parent = row.parentNode;
      parent.insertBefore(ph, row);
      row.remove();

      const clone = row.cloneNode(true);
      const bg = getComputedStyle(row).backgroundColor;
      const solidBg = (bg && bg !== 'rgba(0, 0, 0, 0)') ? bg : '#ffffff';

      clone.style.position = 'fixed';
      clone.style.left = '0';
      clone.style.top = '0';
      clone.style.width = rect.width + 'px';
      clone.style.height = rect.height + 'px';
      clone.style.margin = '0';
      clone.style.pointerEvents = 'none';
      clone.style.zIndex = '9999';
      clone.style.transformOrigin = '0 0';
      clone.style.borderRadius = '0.75rem';
      clone.style.boxShadow = '0 20px 40px -14px rgba(15,15,30,.5), 0 0 0 2px rgba(249,115,22,.5)';
      clone.style.transform = 'translate3d(' + rect.left + 'px,' + rect.top + 'px,0) scale(1.02)';
      clone.style.transition = 'none';
      clone.style.background = solidBg;
      drag.clone = clone;
      document.body.appendChild(clone);

      document.body.classList.add('is-dragging-img');
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
        const row = drag.row;
        const clone = drag.clone;
        const placeholder = drag.placeholder;
        if (clone && clone.parentNode) clone.remove();
        if (placeholder && placeholder.parentNode && row) {
          placeholder.parentNode.insertBefore(row, placeholder);
          placeholder.remove();
        }

        const orderedIds = Array.from(listEl.querySelectorAll('.img-row'))
          .filter(function (el) { return el.getAttribute('data-row-id'); })
          .map(function (el) { return el.getAttribute('data-row-id'); });
        const byId = new Map(state.files.map(function (f) { return [f.id, f]; }));
        state.files = orderedIds.map(function (id) { return byId.get(id); }).filter(Boolean);

        renderList();
        updateSummary();
      } else {
        if (drag.placeholder && drag.placeholder.parentNode) drag.placeholder.remove();
        if (drag.clone && drag.clone.parentNode) drag.clone.remove();
      }

      document.body.classList.remove('is-dragging-img');
      restoreSmoothScroll();
      drag = null;
      moveDirty = false;
    }

    function onContextMenu(e) {
      if (e.target.closest('.img-row')) e.preventDefault();
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
      document.body.classList.remove('is-dragging-img');
      restoreSmoothScroll();
    };
  }

  /* ------------------------------ styles ----------------------------- */
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '@keyframes img2pdf-toast-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }',
      '[data-dropzone].is-dragover { background-color: #C2410C !important; }',
      '[data-dropzone].is-dragover .dz-inner { border-color: rgba(255, 255, 255, 0.9); }',

      '.img-row { touch-action: manipulation; -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }',
      '.img-row img { -webkit-touch-callout: none; -webkit-user-drag: none; user-select: none; pointer-events: none; }',
      '.img-row svg { pointer-events: none; }',
      '[data-drag-handle] { touch-action: none; -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; -webkit-user-drag: none; }',
      '[data-drag-handle] * { pointer-events: none; }',
      '.img-row.drag-placeholder { transition: none !important; }',
      'body.is-dragging-img { overscroll-behavior: contain; -webkit-touch-callout: none; }',
      'body.is-dragging-img * { cursor: grabbing !important; }',

      '[data-page-size], [data-orientation] {',
      '  display: flex;',
      '  flex-direction: column;',
      '  align-items: center;',
      '  justify-content: center;',
      '  padding: 0.55rem 0.35rem;',
      '  font-size: 0.75rem;',
      '  font-weight: 700;',
      '  border: 1.5px solid #e5e7eb;',
      '  border-radius: 0.5rem;',
      '  background: #ffffff;',
      '  color: #6b7280;',
      '  cursor: pointer;',
      '  transition: background-color .12s, border-color .12s, color .12s, transform .08s;',
      '  text-align: center;',
      '  line-height: 1.15;',
      '  min-height: 44px;',
      '}',
      '[data-page-size]:hover, [data-orientation]:hover { border-color: #FDBA74; color: #F97316; }',
      '[data-page-size]:active, [data-orientation]:active { transform: scale(0.96); }',
      '[data-page-size].is-active, [data-orientation].is-active {',
      '  background: #F97316;',
      '  border-color: #F97316;',
      '  color: #ffffff;',
      '}',
      '[data-page-size] small {',
      '  display: block;',
      '  font-size: 0.625rem;',
      '  font-weight: 500;',
      '  opacity: 0.85;',
      '  margin-top: 2px;',
      '}',

      '[data-margin] {',
      '  -webkit-appearance: none;',
      '  appearance: none;',
      '  width: 100%;',
      '  height: 4px;',
      '  border-radius: 9999px;',
      '  background: #e5e7eb;',
      '  outline: none;',
      '  cursor: pointer;',
      '}',
      '[data-margin]::-webkit-slider-thumb {',
      '  -webkit-appearance: none;',
      '  width: 18px; height: 18px;',
      '  border-radius: 50%;',
      '  background: #F97316;',
      '  border: 2px solid #ffffff;',
      '  box-shadow: 0 1px 4px rgba(15,23,42,.2);',
      '  cursor: pointer;',
      '}',
      '[data-margin]::-moz-range-thumb {',
      '  width: 18px; height: 18px;',
      '  border-radius: 50%;',
      '  background: #F97316;',
      '  border: 2px solid #ffffff;',
      '  box-shadow: 0 1px 4px rgba(15,23,42,.2);',
      '  cursor: pointer;',
      '}',

      '[data-progress-overlay] {',
      '  position: fixed; inset: 0; z-index: 60;',
      '  display: flex; align-items: center; justify-content: center;',
      '  background: rgba(15, 23, 42, 0.55); backdrop-filter: blur(4px);',
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
  function closeMenu() {
    const dd = refs.menuDropdown;
    if (dd) dd.classList.add('hidden');
  }

  function handleClick(e) {
    const t = e.target;

    if (t.closest('[data-back]')) {
      if (typeof state.onBack === 'function') state.onBack();
      return;
    }
    if (t.closest('[data-dropzone]'))    { if (refs.fileInput) refs.fileInput.click(); return; }
    if (t.closest('[data-add-more]'))    { if (refs.fileInput) refs.fileInput.click(); return; }
    if (t.closest('[data-clear]'))       { closeMenu(); clearAll(); return; }
    if (t.closest('[data-save]'))        { convert(); return; }
    if (t.closest('[data-download]'))    { handleDownload(); return; }
    if (t.closest('[data-share]'))       { handleShare(); return; }
    if (t.closest('[data-start-over]'))  { startOver(); return; }

    const rm = t.closest('[data-remove]');
    if (rm) { removeFile(rm.getAttribute('data-remove')); return; }

    const up = t.closest('[data-move-up]');
    if (up && !up.disabled) { moveFile(up.getAttribute('data-move-up'), -1); return; }
    const dn = t.closest('[data-move-down]');
    if (dn && !dn.disabled) { moveFile(dn.getAttribute('data-move-down'), 1); return; }

    const psBtn = t.closest('[data-page-size]');
    if (psBtn) { setSetting('pageSize', psBtn.getAttribute('data-page-size')); return; }
    const orBtn = t.closest('[data-orientation]');
    if (orBtn) { setSetting('orientation', orBtn.getAttribute('data-orientation')); return; }

    if (t.closest('[data-progress-cancel]')) {
      state.cancelRequested = true;
      if (refs.progressCancel) refs.progressCancel.disabled = true;
      return;
    }

    if (t.closest('[data-menu-toggle]')) {
      const dd = refs.menuDropdown;
      if (dd) dd.classList.toggle('hidden');
      return;
    }

    if (t.closest('[data-menu-reset]')) {
      state.settings = { ...DEFAULTS };
      applySettingsToUI();
      updateBottomBar();
      closeMenu();
      showToast('Settings reset', 'success');
      return;
    }

    if (t.closest('[data-menu-clear-all]')) {
      closeMenu();
      clearAll();
      return;
    }
  }

  function handleInput(e) {
    const t = e.target;
    if (t.matches('[data-file-input]')) {
      if (t.files && t.files.length) {
        addFiles(t.files);
        t.value = '';
      }
      return;
    }
    if (t.matches('[data-margin]')) {
      setSetting('margin', parseInt(t.value, 10) || 0);
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

  function handleDocumentClick(e) {
    const menuWrap = refs.menuWrap;
    if (!menuWrap) return;
    if (!menuWrap.contains(e.target)) closeMenu();
  }

  function handleGlobalKey(e) {
    if (e.key === 'Escape') closeMenu();
  }

  function setupDropZone(dz) {
    const onOver  = function (e) { e.preventDefault(); e.stopPropagation(); dz.classList.add('is-dragover'); };
    const onLeave = function (e) {
      e.preventDefault(); e.stopPropagation();
      if (e.relatedTarget && dz.contains(e.relatedTarget)) return;
      dz.classList.remove('is-dragover');
    };
    const onDrop = function (e) {
      e.preventDefault(); e.stopPropagation();
      dz.classList.remove('is-dragover');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        addFiles(e.dataTransfer.files);
      }
    };

    dz.addEventListener('dragenter', onOver);
    dz.addEventListener('dragover',  onOver);
    dz.addEventListener('dragleave', onLeave);
    dz.addEventListener('drop',      onDrop);

    const blockOver = function (e) { e.preventDefault(); };
    const blockDrop = function (e) { e.preventDefault(); };
    document.addEventListener('dragover', blockOver);
    document.addEventListener('drop',     blockDrop);

    return function () {
      dz.removeEventListener('dragenter', onOver);
      dz.removeEventListener('dragover',  onOver);
      dz.removeEventListener('dragleave', onLeave);
      dz.removeEventListener('drop',      onDrop);
      document.removeEventListener('dragover', blockOver);
      document.removeEventListener('drop',     blockDrop);
    };
  }

  /* ---------------------------- template ----------------------------- */
  function pageSizeButtonsHtml() {
    return PAGE_SIZES.map(function (p) {
      return '<button type="button" data-page-size="' + p.value + '">' +
        '<span>' + p.label + '</span>' +
        '<small>' + p.sub + '</small>' +
      '</button>';
    }).join('');
  }

  function orientationButtonsHtml() {
    return ORIENTATIONS.map(function (o) {
      return '<button type="button" data-orientation="' + o.value + '">' +
        '<span>' + o.label + '</span>' +
      '</button>';
    }).join('');
  }

  function template() {
    return `
      <div class="img2pdf-root min-h-screen bg-white flex flex-col">

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
                Image<span style="color:${BRAND}">PDF</span>
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
                     style="animation: img2pdf-toast-in .15s cubic-bezier(0.4,0,0.2,1);">
                  <button type="button" data-menu-reset class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-semibold text-gray-900 transition hover:bg-gray-100">
                    <i data-lucide="undo-2" style="width:16px;height:16px;" class="text-gray-500"></i>
                    Reset settings
                  </button>
                  <div class="my-1 h-px bg-gray-100"></div>
                  <button type="button" data-menu-clear-all class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-semibold text-rose-600 transition hover:bg-rose-50">
                    <i data-lucide="trash-2" style="width:16px;height:16px;"></i>
                    Clear all images
                  </button>
                </div>
              </div>
            </div>
          </div>
        </header>

        <main class="flex-1 w-full max-w-3xl mx-auto px-4 sm:px-6 pt-4 pb-36">

          <div data-work-workspace>

            <label data-dropzone
                   class="group relative block cursor-pointer rounded-2xl bg-orange-500 px-4 py-8 text-center transition-all duration-200 hover:bg-orange-600 focus-within:outline-none sm:px-8 sm:py-10">
              <div class="dz-inner absolute inset-3.5 rounded-xl border-2 border-dashed border-white/60 transition-colors duration-200"></div>
              <input type="file" data-file-input accept="${ACCEPT_ATTR}" multiple hidden />

              <div class="relative z-10 flex flex-col items-center justify-center min-h-[180px] sm:min-h-[210px]">
                <svg width="130" height="84" viewBox="0 0 130 84" fill="none" xmlns="http://www.w3.org/2000/svg" class="mb-5">
                  <rect x="6" y="10" width="34" height="34" rx="4" fill="white" opacity="0.55"/>
                  <circle cx="17" cy="21" r="3.5" fill="#FDBA74"/>
                  <path d="M8 40 L17 30 L23 36 L28 31 L38 40 Z" fill="#FB923C" opacity="0.8"/>

                  <rect x="16" y="16" width="34" height="34" rx="4" fill="white" opacity="0.95"/>
                  <circle cx="27" cy="27" r="3.5" fill="#FDBA74"/>
                  <path d="M18 46 L27 36 L33 42 L38 37 L48 46 Z" fill="#F97316"/>

                  <path d="M58 34h12" stroke="white" stroke-width="3" stroke-linecap="round"/>
                  <path d="M65 26l8 8-8 8" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>

                  <path d="M82 12h28l14 14v44a4 4 0 0 1-4 4H82a4 4 0 0 1-4-4V16a4 4 0 0 1 4-4Z" fill="white"/>
                  <path d="M110 12l14 14h-14z" fill="#FED7AA"/>
                  <rect x="86" y="38" width="26" height="3" rx="1.5" fill="#FDBA74"/>
                  <rect x="86" y="46" width="20" height="3" rx="1.5" fill="#FDBA74"/>
                  <rect x="86" y="54" width="24" height="3" rx="1.5" fill="#FDBA74"/>
                  <rect x="86" y="62" width="16" height="3" rx="1.5" fill="#FDBA74"/>
                </svg>

                <div class="inline-flex overflow-hidden rounded-lg shadow-btn">
                  <button type="button" id="chooseBtn" class="flex items-center gap-2 bg-white px-5 py-3 text-[13px] font-bold text-gray-900 transition hover:bg-gray-50 focus:outline-none sm:px-6 sm:text-[14px]">
                    <i data-lucide="image-plus" style="width:16px;height:16px;"></i>
                    SELECT IMAGES
                  </button>
                  <button type="button" aria-label="More upload options" class="flex items-center border-l border-gray-200 bg-white px-2.5 transition hover:bg-gray-50 focus:outline-none">
                    <i data-lucide="chevron-down" style="width:16px;height:16px;" class="text-gray-900"></i>
                  </button>
                </div>
              </div>
            </label>

            <div data-list-wrap class="hidden mt-4">
              <div class="mb-2 flex items-center justify-between gap-2">
                <p class="text-[11px] font-medium uppercase tracking-wide text-gray-900">
                  Drag <i data-lucide="grip-vertical" class="inline" style="width:14px;height:14px;vertical-align:-2px;"></i> to reorder
                </p>
                <p class="text-[11px] text-gray-900">
                  <span data-count>0</span> images
                  <span data-size-label class="ml-1 font-bold text-gray-900"></span>
                </p>
              </div>

              <div data-batch-warning class="hidden mb-2"></div>

              <div data-list class="space-y-2"></div>

              <button type="button" data-add-more
                      class="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-orange-300 bg-orange-50/30 py-3 text-[13px] font-semibold text-orange-600 transition hover:border-orange-400 hover:bg-orange-50 hover:text-orange-700">
                <i data-lucide="plus" style="width:16px;height:16px;"></i>
                Add more images
              </button>
            </div>

            <div data-list-wrap-2 class="hidden mt-5">
              <div class="rounded-2xl border border-gray-200 bg-white p-4">

                <label class="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-gray-900">Page size</label>
                <div class="grid grid-cols-4 gap-1.5">
                  ${pageSizeButtonsHtml()}
                </div>

                <div class="mt-4">
                  <label class="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-gray-900">Orientation</label>
                  <div class="grid grid-cols-3 gap-1.5">
                    ${orientationButtonsHtml()}
                  </div>
                </div>

                <div class="mt-4">
                  <div class="mb-1.5 flex items-center justify-between">
                    <label class="text-[11px] font-bold uppercase tracking-wider text-gray-900">Margin</label>
                    <span data-margin-val class="text-[11px] font-bold text-gray-900">0pt</span>
                  </div>
                  <input type="range" data-margin min="0" max="50" step="1" value="0" class="w-full" />
                  <p class="mt-1 text-[10px] text-gray-900">Adds padding around each image</p>
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
              <span data-summary>Add images to get started</span>
            </div>
            <button type="button" data-save disabled
                    class="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed text-white font-bold py-4 rounded-xl flex items-center justify-center gap-2 transition active:scale-[0.98] text-[16px] shadow-sm">
              Convert to PDF <i data-lucide="arrow-right" style="width:20px;height:20px;"></i>
            </button>
          </div>
        </div>

        <div data-progress-overlay class="hidden">
          <div class="mx-4 w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-6 text-center shadow-2xl">
            <span class="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-orange-50 text-orange-600">
              <i data-lucide="loader-2" class="h-6 w-6 animate-spin"></i>
            </span>
            <h3 class="mt-4 text-lg font-extrabold text-gray-900">Building PDF</h3>
            <p data-progress-label class="mt-1 text-[12px] font-medium text-gray-900">Starting…</p>
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
    if (!rootEl) throw new Error('ImageToPdf.render: missing root element');

    if (state.root) {
      try { destroy(); } catch (e) {}
    }

    state.cleanup = [];
    state.files = [];
    state.settings = { ...DEFAULTS };
    state.isProcessing = false;
    state.cancelRequested = false;
    state.gen = 0;
    state.root = rootEl;
    state.onBack = options?.onBack || null;
    state.statusTimer = null;
    state.result = null;

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

    const dz = refs.dropzone;
    if (dz) {
      state.cleanup.push(setupDropZone(dz));
      dz.addEventListener('click', function (e) {
        if (e.target.closest('#chooseBtn')) {
          e.stopPropagation();
          if (refs.fileInput) refs.fileInput.click();
        }
      });
    }

    const listEl = refs.listEl;
    if (listEl) state.cleanup.push(setupDrag(listEl));

    renderList();
    updateBottomBar();

    if (options?.initialFiles?.length) {
      // Kick off byte reads immediately so they complete before any
      // surrounding HTML handlers can clear the file input.
      await addFiles(options.initialFiles);
    }
  }

  function destroy() {
    state.gen += 1;
    state.cancelRequested = true;

    if (state.root) {
      state.root.removeEventListener('click', handleClick);
      state.root.removeEventListener('input', handleInput);
      state.root.removeEventListener('change', handleInput);
      state.root.removeEventListener('focusin', handleFocusIn);
      state.root.removeEventListener('keydown', handleKeyDown);
    }
    document.removeEventListener('click', handleDocumentClick);
    document.removeEventListener('keydown', handleGlobalKey);

    for (let i = 0; i < state.files.length; i++) {
      releaseItemMemory(state.files[i]);
    }
    state.files = [];

    revokeResultUrl();

    state.cleanup.forEach(function (fn) { try { fn(); } catch (e) {} });
    state.cleanup = [];
    state.root = null;
    state.statusTimer = null;

    refs.listEl = null;
    refs.listWrap = null;
    refs.listWrap2 = null;
    refs.count = null;
    refs.sizeLabel = null;
    refs.summary = null;
    refs.saveBtn = null;
    refs.warningEl = null;
    refs.progressOverlay = null;
    refs.progressBar = null;
    refs.progressLabel = null;
    refs.progressCancel = null;
    refs.dropzone = null;
    refs.fileInput = null;
    refs.clearBtn = null;
    refs.menuWrap = null;
    refs.menuDropdown = null;
    refs.title = null;
    refs.workWs = null;
    refs.successWs = null;
    refs.bottomBar = null;
    refs.status = null;
    refs.pageSizeBtns = null;
    refs.orientationBtns = null;
    refs.marginInput = null;
    refs.marginVal = null;
  }

  window.ImageToPdf = { render, destroy };
})();