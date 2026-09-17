/* =====================================================================
 * ProtectPDF.js — PDFTools password protect module
 * Encrypt a PDF with a password. The file requires the password to open.
 * Theme: red brand mark in the workspace header (matches the HTML);
 *        blue action elements (Encrypt, Download, Share).
 *
 * IMPORTANT: Plain pdf-lib silently ignores encryption options. We must
 * load the @cantoo/pdf-lib fork which adds real AES-256 encryption. We
 * verify capability with a self-test rather than just checking
 * `window.PDFLib` — because other tools on the page may have already
 * loaded plain pdf-lib under the same global.
 *
 * Depends on (auto-loaded if missing):
 *   - @cantoo/pdf-lib (fork with encryption) — loaded LAZILY on save
 *   - lucide          (icons, expected on host page)
 * ===================================================================== */
(function () {
  'use strict';

  // Red brand mark (matches ProtectPDF.html header/footer accents)
  const BRAND = '#EF4444';

  const CANTOO_URLS = [
    'https://cdn.jsdelivr.net/npm/@cantoo/pdf-lib@2.11.0/dist/pdf-lib.min.js',
    'https://cdn.jsdelivr.net/npm/@cantoo/pdf-lib@2.9.0/dist/pdf-lib.min.js',
    'https://unpkg.com/@cantoo/pdf-lib@latest/dist/pdf-lib.min.js',
    'https://cdn.jsdelivr.net/npm/@cantoo/pdf-lib@2.4.2/dist/pdf-lib.min.js',
    'https://cdn.jsdelivr.net/npm/@cantoo/pdf-lib@2.4.1/dist/pdf-lib.min.js',
    'https://cdn.jsdelivr.net/npm/@cantoo/pdf-lib@2.3.0/dist/pdf-lib.min.js',
    'https://unpkg.com/@cantoo/pdf-lib/dist/pdf-lib.min.js',
  ];

  const STYLE_ID = 'protect-pdf-styles';

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
      maxFileBytes: lowMemory ? 25 * MB : (isMobile ? 75 * MB : 200 * MB),
    };
  })();

  const state = {
    file: null,
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
    fileCard: null, optionsPanel: null, dropzone: null,
    pwInput: null, pwConfirm: null, pwStrength: null, pwStrengthBar: null,
    summary: null, saveBtn: null,
    progressOverlay: null, progressBar: null, progressLabel: null, progressCancel: null,
    fileInput: null, clearBtn: null,
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

  function yieldToPaint() {
    return new Promise(r => setTimeout(r, 20));
  }

  function loadScriptFresh(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      let settled = false;
      script.onload = () => {
        if (settled) return;
        settled = true;
        resolve(script);
      };
      script.onerror = () => {
        if (settled) return;
        settled = true;
        try { script.remove(); } catch (e) {}
        reject(new Error('Failed to load ' + src));
      };
      document.head.appendChild(script);
    });
  }

  function containsEncryptMarker(bytes) {
    const marker = [0x2F, 0x45, 0x6E, 0x63, 0x72, 0x79, 0x70, 0x74];
    const n = bytes.length;
    const m = marker.length;
    if (n < m) return false;
    outer:
    for (let i = n - m; i >= 0; i--) {
      for (let j = 0; j < m; j++) {
        if (bytes[i + j] !== marker[j]) continue outer;
      }
      return true;
    }
    return false;
  }

  async function librarySupportsEncryption(lib) {
    if (!lib || !lib.PDFDocument) return false;
    try {
      const testDoc = await lib.PDFDocument.create();
      testDoc.addPage([100, 100]);
      if (typeof testDoc.encrypt === 'function') {
        await testDoc.encrypt({ userPassword: 'pdftest123', ownerPassword: 'pdftest123' });
      }
      const testBytes = await testDoc.save({ userPassword: 'pdftest123' });
      if (!testBytes || !testBytes.length) return false;
      return containsEncryptMarker(testBytes);
    } catch (err) {
      return false;
    }
  }

  let ensurePromise = null;
  async function ensurePdfLib() {
    if (window.__protectPdfLibReady && window.__protectPdfLib) {
      return window.__protectPdfLib;
    }
    if (ensurePromise) return ensurePromise;

    ensurePromise = (async () => {
      if (await librarySupportsEncryption(window.PDFLib)) {
        window.__protectPdfLib = window.PDFLib;
        window.__protectPdfLibReady = true;
        return window.PDFLib;
      }

      let lastErr = null;
      for (let i = 0; i < CANTOO_URLS.length; i++) {
        const url = CANTOO_URLS[i];
        let scriptEl = null;
        try {
          scriptEl = await loadScriptFresh(url);
          if (await librarySupportsEncryption(window.PDFLib)) {
            window.__protectPdfLib = window.PDFLib;
            window.__protectPdfLibReady = true;
            return window.PDFLib;
          }
          if (scriptEl && scriptEl.parentNode) {
            try { scriptEl.remove(); } catch (e) {}
            scriptEl = null;
          }
        } catch (err) {
          lastErr = err;
        }
      }

      ensurePromise = null;
      throw new Error(
        'Could not load a PDF library that supports encryption. ' +
        'Check your internet connection and try again.' +
        (lastErr ? ' (' + lastErr.message + ')' : '')
      );
    })();

    return ensurePromise;
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
    refs.fileCard        = root.querySelector('[data-file-card]');
    refs.optionsPanel    = root.querySelector('[data-options-panel]');
    refs.dropzone        = root.querySelector('[data-dropzone]');
    refs.pwInput         = root.querySelector('[data-pw]');
    refs.pwConfirm       = root.querySelector('[data-pw-confirm]');
    refs.pwStrength      = root.querySelector('[data-pw-strength]');
    refs.pwStrengthBar   = root.querySelector('[data-pw-strength-bar]');
    refs.summary         = root.querySelector('[data-summary]');
    refs.saveBtn         = root.querySelector('[data-save]');
    refs.progressOverlay = root.querySelector('[data-progress-overlay]');
    refs.progressBar     = root.querySelector('[data-progress-bar]');
    refs.progressLabel   = root.querySelector('[data-progress-label]');
    refs.progressCancel  = root.querySelector('[data-progress-cancel]');
    refs.fileInput       = root.querySelector('[data-file-input]');
    refs.clearBtn        = root.querySelector('[data-clear]');
    refs.menuWrap        = root.querySelector('[data-menu-wrap]');
    refs.menuDropdown    = root.querySelector('[data-menu-dropdown]');
    refs.title           = root.querySelector('[data-title]');
    refs.workWs          = root.querySelector('[data-work-workspace]');
    refs.successWs       = root.querySelector('[data-success-workspace]');
    refs.bottomBar       = root.querySelector('[data-bottom-bar]');
    refs.status          = root.querySelector('[data-status]');
  }

  /* --------------------------- password utils ------------------------ */
  function generateStrongPassword(length) {
    const len = length || 12;
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';
    const bytes = new Uint8Array(len);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    let out = '';
    for (let i = 0; i < len; i++) {
      out += alphabet[bytes[i] % alphabet.length];
    }
    return out;
  }

  function scorePassword(pw) {
    if (!pw) return { score: 0, label: '', color: '' };
    let score = 0;
    if (pw.length >= 8)  score++;
    if (pw.length >= 12) score++;
    if (pw.length >= 16) score++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
    if (/\d/.test(pw)) score++;
    if (/[^A-Za-z0-9]/.test(pw)) score++;

    if (score <= 1) return { score: 1, label: 'Weak', color: '#ef4444' };
    if (score <= 3) return { score: 2, label: 'Fair', color: '#f59e0b' };
    if (score <= 4) return { score: 3, label: 'Good', color: '#10b981' };
    return { score: 4, label: 'Strong', color: '#059669' };
  }

  function updateStrengthUI() {
    if (!refs.pwInput || !refs.pwStrengthBar) return;
    const pw = refs.pwInput.value;
    const s = scorePassword(pw);
    if (!pw) {
      refs.pwStrengthBar.style.width = '0%';
      refs.pwStrengthBar.style.background = '#e5e7eb';
      if (refs.pwStrength) refs.pwStrength.textContent = '';
      return;
    }
    refs.pwStrengthBar.style.width = (s.score / 4 * 100) + '%';
    refs.pwStrengthBar.style.background = s.color;
    if (refs.pwStrength) {
      refs.pwStrength.textContent = s.label;
      refs.pwStrength.style.color = s.color;
    }
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

    if (f.size > CAPS.maxFileBytes) {
      showToast(
        'File is too large (' + formatBytes(f.size) + '). ' +
        'Limit is ' + formatBytes(CAPS.maxFileBytes) + ' on this device.',
        'error', 4500
      );
      return;
    }

    revokeResultUrl();
    const myGen = ++state.gen;

    state.file = { file: f, name: f.name, size: f.size, pageCount: null, loading: true, error: null };

    renderFileCard();
    updateVisibility();
    updateBottomBar();

    let buf = null;
    let doc = null;

    try {
      if (!window.PDFLib) {
        await loadScriptFresh(CANTOO_URLS[0]).catch(function () {});
      }
      const lib = window.PDFLib;
      if (!lib || !lib.PDFDocument) throw new Error('PDF library unavailable');

      buf = await f.arrayBuffer();
      if (myGen !== state.gen) return;

      try {
        doc = await lib.PDFDocument.load(buf, { ignoreEncryption: false });
      } catch (err) {
        const isEncryptedByMarker = containsEncryptMarker(new Uint8Array(buf));
        if (!isEncryptedByMarker) {
          try {
            await lib.PDFDocument.load(buf, { ignoreEncryption: true });
          } catch (err2) {
            throw err;
          }
        }
        state.file.loading = false;
        state.file.pageCount = null;
        state.file.error = 'This PDF is already password-protected.';
        renderFileCard();
        updateVisibility();
        updateBottomBar();
        return;
      }

      if (myGen !== state.gen) return;
      state.file.pageCount = doc.getPageCount();
      state.file.loading = false;
      state.file.error = null;

      renderFileCard();
      updateVisibility();
      updateBottomBar();
    } catch (err) {
      console.error('[ProtectPDF]', err);
      if (myGen !== state.gen) return;
      if (!state.file) return;
      state.file.loading = false;
      state.file.pageCount = null;
      state.file.error = 'Unreadable or corrupt PDF';
      renderFileCard();
      updateVisibility();
      updateBottomBar();
    } finally {
      buf = null;
      doc = null;
    }
  }

  function removeFile() {
    state.gen += 1;
    state.cancelRequested = true;
    revokeResultUrl();
    if (state.file) {
      try { state.file.file = null; } catch (e) {}
      state.file = null;
    }
    resetForm();
    renderFileCard();
    updateVisibility();
    updateBottomBar();
  }

  function resetForm() {
    if (refs.pwInput)   refs.pwInput.value = '';
    if (refs.pwConfirm) refs.pwConfirm.value = '';
    updateStrengthUI();
  }

  /* ------------------------------ render ----------------------------- */
  function renderFileCard() {
    if (!refs.fileCard) return;
    const f = state.file;
    if (!f) { refs.fileCard.innerHTML = ''; return; }

    const meta = f.loading
      ? '<span class="text-gray-900">Reading…</span>'
      : f.error
        ? '<span class="text-rose-500">' + escapeHtml(f.error) + '</span>'
        : f.pageCount + ' page' + (f.pageCount !== 1 ? 's' : '') + ' · ' + formatBytes(f.size);

    refs.fileCard.innerHTML = `
      <div class="flex items-center gap-3 py-3 px-4 bg-white border border-gray-100 rounded-xl shadow-sm">
        <div class="min-w-0 flex-1">
          <div class="inline-block max-w-full truncate px-2 py-0.5 rounded-md text-[12px] font-bold bg-protect-100 text-protect-700">${escapeHtml(f.name)}</div>
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

  function updateVisibility() {
    const hasFile = !!state.file;
    if (refs.dropzone)     refs.dropzone.classList.toggle('hidden', hasFile);
    if (refs.fileCard)     refs.fileCard.classList.toggle('hidden', !hasFile);
    if (refs.optionsPanel) refs.optionsPanel.classList.toggle('hidden', !hasFile);
    if (refs.clearBtn)     refs.clearBtn.classList.toggle('hidden', !hasFile);
    if (refs.menuWrap)     refs.menuWrap.classList.toggle('hidden', !hasFile);
  }

  function updateSummary() {
    const el = refs.summary;
    if (!el) return;
    const f = state.file;
    if (!f) { el.textContent = 'Add a PDF to get started'; return; }
    if (f.loading) { el.textContent = 'Reading file…'; return; }
    if (f.error) { el.textContent = f.error; return; }
    if (state.isProcessing) { el.textContent = 'Encrypting…'; return; }

    const pw = refs.pwInput ? refs.pwInput.value : '';
    if (!pw) { el.textContent = 'Enter a password to continue'; return; }

    el.textContent = 'AES-256 encryption ready';
  }

  function updateBottomBar() {
    const btn = refs.saveBtn;
    if (!btn) return;
    const f = state.file;
    const pw = refs.pwInput ? refs.pwInput.value : '';
    const pwConfirm = refs.pwConfirm ? refs.pwConfirm.value : '';
    const pwOk = pw && pw === pwConfirm;

    const ready = !!f && !f.loading && !f.error && !!f.pageCount
                  && !state.isProcessing && pwOk;

    btn.disabled = !ready;
    btn.innerHTML = state.isProcessing
      ? '<i data-lucide="loader-2" style="width:20px;height:20px;" class="animate-spin"></i><span>Encrypting…</span>'
      : 'Encrypt PDF <i data-lucide="arrow-right" style="width:20px;height:20px;"></i>';
    refreshIcons();
    updateSummary();
  }

  /* ------------------------------ save ------------------------------- */
  async function encrypt() {
    if (state.isProcessing || !state.file || state.file.error) return;

    const pw = refs.pwInput ? refs.pwInput.value : '';
    const pwConfirm = refs.pwConfirm ? refs.pwConfirm.value : '';

    if (!pw) { showToast('Please enter a password.', 'error'); if (refs.pwInput) refs.pwInput.focus(); return; }
    if (pw !== pwConfirm) { showToast('Passwords do not match.', 'error'); if (refs.pwConfirm) refs.pwConfirm.focus(); return; }
    if (pw.length < 4) { showToast('Password is too short (min 4 characters).', 'error'); return; }

    state.isProcessing = true;
    state.cancelRequested = false;
    updateBottomBar();
    showProgress();

    const myGen = state.gen;

    let doc = null;
    let bytes = null;

    try {
      updateProgress(1, 4, 'Preparing encryption library…');
      await yieldToPaint();
      const lib = await ensurePdfLib();
      if (state.cancelRequested || myGen !== state.gen) throw new Error('__cancelled__');

      updateProgress(2, 4, 'Reading PDF…');
      await yieldToPaint();
      let buf = await state.file.file.arrayBuffer();
      if (state.cancelRequested || myGen !== state.gen) throw new Error('__cancelled__');

      updateProgress(3, 4, 'Encrypting…');
      await yieldToPaint();
      doc = await lib.PDFDocument.load(buf, { ignoreEncryption: false });
      buf = null;

      const permissions = {
        printing: 'highResolution',
        modifying: true,
        copying: true,
        annotating: true,
        fillingForms: true,
        contentAccessibility: true,
        documentAssembly: true,
      };

      if (typeof doc.encrypt === 'function') {
        try {
          await doc.encrypt({
            userPassword: pw,
            ownerPassword: pw,
            permissions: permissions,
          });
          bytes = await doc.save();
        } catch (err) {
          console.warn('[ProtectPDF] encrypt() API failed:', err);
          bytes = null;
        }
      }

      if (!bytes || !containsEncryptMarker(bytes)) {
        try {
          bytes = await doc.save({
            userPassword: pw,
            ownerPassword: pw,
            permissions: permissions,
          });
        } catch (err) {
          console.warn('[ProtectPDF] modern save options failed:', err);
          bytes = null;
        }
      }

      if (!bytes || !containsEncryptMarker(bytes)) {
        try {
          bytes = await doc.save({
            encryptUserPassword: pw,
            encryptOwnerPassword: pw,
            permissions: permissions,
          });
        } catch (err) {
          console.warn('[ProtectPDF] legacy save options failed:', err);
          bytes = null;
        }
      }

      if (!bytes || !containsEncryptMarker(bytes)) {
        try {
          bytes = await doc.save({ userPassword: pw });
        } catch (err) {
          console.warn('[ProtectPDF] minimal save options failed:', err);
          bytes = null;
        }
      }

      if (!bytes) {
        throw new Error('PDF library returned no output');
      }

      if (!containsEncryptMarker(bytes)) {
        throw new Error(
          'Encryption did not take effect. Your browser may have blocked the ' +
          'encryption library from loading. Try reloading the page and trying again.'
        );
      }

      doc = null;

      if (state.cancelRequested || myGen !== state.gen) throw new Error('__cancelled__');

      updateProgress(4, 4, 'Finishing…');
      await yieldToPaint();
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const blobSize = blob.size;
      bytes = null;

      const url = URL.createObjectURL(blob);

      if (state.result && state.result.url) {
        try { URL.revokeObjectURL(state.result.url); } catch (e) {}
      }

      state.result = {
        url: url,
        blob: blob,
        fileName: (state.file.name || 'file').replace(/\.pdf$/i, '') + '-protected.pdf',
        pageCount: state.file.pageCount,
        totalSize: blobSize,
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
        showToast('Cancelled', 'info');
      } else {
        console.error('[ProtectPDF] encrypt', err);
        const msg = err && err.message ? err.message : 'Unknown error';
        showToast('Failed: ' + msg, 'error', 5000);
      }
    } finally {
      doc = null;
      bytes = null;
    }
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
    if (refs.progressLabel) refs.progressLabel.textContent = label || '';
  }

  function hideProgress() {
    if (refs.progressOverlay) refs.progressOverlay.classList.add('hidden');
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
        <h2 class="text-xl font-extrabold text-gray-900 tracking-tight">PDF Encrypted 🔒</h2>
      </div>

      <p class="text-[13px] text-gray-900 mb-6">
        Your PDF now requires the password you set to open.
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
            <p class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Encryption</p>
            <p class="text-[16px] font-extrabold text-gray-900 mt-1">AES-256</p>
          </div>
          <div class="bg-gray-50 rounded-xl p-3.5 border border-gray-100 text-center">
            <p class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Size</p>
            <p class="text-[16px] font-extrabold text-gray-900 mt-1">${formatBytes(r.totalSize)}</p>
          </div>
        </div>

        <div class="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-3.5">
          <div class="flex items-start gap-2.5">
            <i data-lucide="key-round" class="mt-0.5 shrink-0 text-amber-600" style="width:16px;height:16px;"></i>
            <p class="text-[12px] leading-relaxed text-amber-900">
              <strong>Save your password somewhere safe.</strong> It cannot be recovered if lost — the file will be permanently inaccessible.
            </p>
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
    if (!base) base = 'protected';
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
    if (!base) base = 'protected';
    const filename = base.replace(/\.pdf$/i, '') + '.pdf';

    try {
      const file = new File([state.result.blob], filename, { type: 'application/pdf' });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: 'Protected PDF',
          text: 'Protected with PDFTools',
        });
        return;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }

    // Fallback: download
    handleDownload();
  }

  // Start Over: hard reset via full page reload.
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
           style="animation: protect-toast-in .22s cubic-bezier(0.4, 0, 0.2, 1);">
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

  /* ------------------------------ styles ----------------------------- */
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '@keyframes protect-toast-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }',
      '[data-dropzone].is-dragover { background-color: #991B1B !important; }',
      '[data-dropzone].is-dragover .dz-inner { border-color: rgba(255, 255, 255, 0.9); }',

      '.protect-checkbox {',
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
      '.protect-checkbox:checked { background: #EF4444; border-color: #EF4444; }',
      '.protect-checkbox:checked::after {',
      '  content: "";',
      '  position: absolute;',
      '  left: 4px; top: 1px;',
      '  width: 8px; height: 12px;',
      '  border: solid #ffffff;',
      '  border-width: 0 2px 2px 0;',
      '  transform: rotate(45deg);',
      '}',

      '.protect-pw-input {',
      '  width: 100%;',
      '  border-radius: 0.75rem;',
      '  border: 1px solid #e5e7eb;',
      '  background: #ffffff;',
      '  padding: 0.625rem 1rem 0.625rem 2.5rem;',
      '  font-size: 0.875rem;',
      '  font-weight: 500;',
      '  color: #0f172a;',
      '  outline: none;',
      '  transition: border-color .15s, box-shadow .15s;',
      '}',
      '.protect-pw-input::placeholder { color: #9ca3af; }',
      '.protect-pw-input:focus { border-color: #EF4444; box-shadow: 0 0 0 4px rgba(239, 68, 68, 0.1); }',

      '[data-progress-overlay] {',
      '  position: fixed; inset: 0; z-index: 60;',
      '  display: flex; align-items: center; justify-content: center;',
      '  background: rgba(15, 23, 42, 0.55); backdrop-filter: blur(4px);',
      '}',
      '[data-progress-overlay].hidden { display: none; }',
      '[data-progress-bar] {',
      '  height: 100%;',
      '  background: linear-gradient(90deg, #EF4444, #F87171);',
      '  border-radius: 9999px;',
      '  transition: width .25s ease;',
      '  width: 0%;',
      '}',
      '[data-pw-strength-bar] {',
      '  height: 100%;',
      '  width: 0%;',
      '  border-radius: 9999px;',
      '  transition: width .3s ease, background-color .3s ease;',
      '  background: #e5e7eb;',
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
    if (t.closest('[data-dropzone]'))    { if (refs.fileInput) refs.fileInput.click(); return; }
    if (t.closest('[data-clear]'))       { closeMenu(); removeFile(); return; }
    if (t.closest('[data-remove-file]')) { closeMenu(); removeFile(); return; }
    if (t.closest('[data-save]'))        { encrypt(); return; }
    if (t.closest('[data-download]'))    { handleDownload(); return; }
    if (t.closest('[data-share]'))       { handleShare(); return; }
    if (t.closest('[data-start-over]'))  { startOver(); return; }

    if (t.closest('[data-generate-pw]')) {
      const pw = generateStrongPassword(12);
      if (refs.pwInput)   refs.pwInput.value = pw;
      if (refs.pwConfirm) refs.pwConfirm.value = pw;
      if (refs.pwInput)   refs.pwInput.type = 'text';
      if (refs.pwConfirm) refs.pwConfirm.type = 'text';
      const toggle = state.root.querySelector('[data-show-pw]');
      if (toggle) toggle.checked = true;
      updateStrengthUI();
      updateBottomBar();
      showToast('Generated a strong password — save it!', 'success', 3500);
      return;
    }

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
      resetForm();
      updateBottomBar();
      closeMenu();
      showToast('Form reset', 'success');
      return;
    }
  }

  function handleInput(e) {
    const t = e.target;

    if (t.matches('[data-file-input]')) {
      if (t.files && t.files.length) {
        addFile(t.files);
        t.value = '';
      }
      return;
    }

    if (t.matches('[data-pw]')) {
      updateStrengthUI();
      updateBottomBar();
      return;
    }

    if (t.matches('[data-pw-confirm]')) {
      updateBottomBar();
      return;
    }

    if (t.matches('[data-show-pw]')) {
      const on = t.checked;
      if (refs.pwInput)   refs.pwInput.type = on ? 'text' : 'password';
      if (refs.pwConfirm) refs.pwConfirm.type = on ? 'text' : 'password';
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
      return;
    }
    if (e.target.matches('[data-pw-confirm]') && e.key === 'Enter') {
      e.preventDefault();
      encrypt();
    }
  }

  function closeMenu() {
    const dd = refs.menuDropdown;
    if (dd) dd.classList.add('hidden');
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
        addFile(e.dataTransfer.files);
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
  function template() {
    return `
      <div class="protect-root min-h-screen bg-white flex flex-col">

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
                  <path d="M18.5 6.5V11a1 1 0 0 0 1 1H24" fill="#FECACA"/>
                  <rect x="13" y="15.5" width="7" height="1.6" rx="0.8" fill="${BRAND}"/>
                  <rect x="13" y="19.5" width="5" height="1.6" rx="0.8" fill="${BRAND}"/>
                </svg>
              </span>
              <span class="text-[16px] font-extrabold tracking-tight text-gray-900">
                Protect<span style="color:${BRAND}">PDF</span>
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
                     style="animation: protect-toast-in .15s cubic-bezier(0.4,0,0.2,1);">
                  <button type="button" data-menu-reset class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-semibold text-gray-900 transition hover:bg-gray-100">
                    <i data-lucide="undo-2" style="width:16px;height:16px;" class="text-gray-500"></i>
                    Reset form
                  </button>
                </div>
              </div>
            </div>
          </div>
        </header>

        <main class="flex-1 w-full max-w-3xl mx-auto px-4 sm:px-6 pt-4 pb-36">

          <div data-work-workspace>

            <label data-dropzone
                   class="group relative block cursor-pointer rounded-2xl bg-protect-500 px-4 py-8 text-center transition-all duration-200 hover:bg-protect-600 focus-within:outline-none sm:px-8 sm:py-10">
              <div class="dz-inner absolute inset-3.5 rounded-xl border-2 border-dashed border-white/60 transition-colors duration-200"></div>
              <input type="file" data-file-input accept=".pdf,application/pdf" hidden />

              <div class="relative z-10 flex flex-col items-center justify-center min-h-[180px] sm:min-h-[210px]">
                <svg width="130" height="84" viewBox="0 0 130 84" fill="none" xmlns="http://www.w3.org/2000/svg" class="mb-5">
                  <rect x="40" y="10" width="50" height="64" rx="5" fill="white" opacity="0.95"/>
                  <rect x="48" y="22" width="34" height="3" rx="1.5" fill="#FECACA"/>
                  <rect x="48" y="30" width="26" height="3" rx="1.5" fill="#FECACA"/>
                  <rect x="48" y="38" width="30" height="3" rx="1.5" fill="#FECACA"/>
                  <rect x="48" y="46" width="22" height="3" rx="1.5" fill="#FECACA"/>
                  <path d="M56 62v-6a4 4 0 0 1 8 0v6" stroke="#B91C1C" stroke-width="2.5" fill="none" stroke-linecap="round"/>
                  <rect x="53" y="62" width="14" height="11" rx="2" fill="#EF4444"/>
                  <circle cx="60" cy="67" r="1.5" fill="white"/>
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

            <div data-options-panel class="hidden mt-5">
              <div class="rounded-2xl border border-gray-200 bg-white p-4">
                <div class="flex items-center justify-between">
                  <label class="text-[11px] font-bold uppercase tracking-wider text-gray-900">Password</label>
                  <button type="button" data-generate-pw class="inline-flex items-center gap-1 text-[11px] font-bold text-protect-600 transition hover:text-protect-700">
                    <i data-lucide="wand-2" style="width:12px;height:12px;"></i> Generate
                  </button>
                </div>

                <div class="relative mt-2">
                  <i data-lucide="key-round" class="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" style="width:16px;height:16px;"></i>
                  <input type="password" data-pw class="protect-pw-input" placeholder="Enter password" autocomplete="new-password" spellcheck="false" />
                </div>

                <div class="mt-2 flex items-center gap-2">
                  <div class="h-1 flex-1 overflow-hidden rounded-full bg-gray-100">
                    <div data-pw-strength-bar></div>
                  </div>
                  <span data-pw-strength class="min-w-[3.5rem] text-right text-[11px] font-bold"></span>
                </div>

                <div class="relative mt-3">
                  <i data-lucide="key-round" class="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" style="width:16px;height:16px;"></i>
                  <input type="password" data-pw-confirm class="protect-pw-input" placeholder="Confirm password" autocomplete="new-password" spellcheck="false" />
                </div>

                <label class="mt-3 flex cursor-pointer items-center gap-2.5">
                  <input type="checkbox" data-show-pw class="protect-checkbox" />
                  <span class="text-[12px] font-medium text-gray-900">Show passwords</span>
                </label>
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
              Encrypt PDF <i data-lucide="arrow-right" style="width:20px;height:20px;"></i>
            </button>
          </div>
        </div>

        <div data-progress-overlay class="hidden">
          <div class="mx-4 w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-6 text-center shadow-2xl">
            <span class="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-protect-50 text-protect-600">
              <i data-lucide="shield-check" class="h-6 w-6"></i>
            </span>
            <h3 class="mt-4 text-lg font-extrabold text-gray-900">Encrypting PDF</h3>
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
    if (!rootEl) throw new Error('ProtectPDF.render: missing root element');

    if (state.root) {
      try { destroy(); } catch (e) {}
    }

    state.cleanup = [];
    state.file = null;
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
    updateStrengthUI();

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

    updateVisibility();
    updateBottomBar();

    if (options?.initialFiles?.length) {
      await addFile(options.initialFiles);
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

    revokeResultUrl();

    state.cleanup.forEach(function (fn) { try { fn(); } catch (e) {} });
    state.cleanup = [];

    if (state.file) {
      try { state.file.file = null; } catch (e) {}
      state.file = null;
    }
    state.root = null;
    state.statusTimer = null;

    Object.keys(refs).forEach(function (k) { refs[k] = null; });
  }

  window.ProtectPDF = { render, destroy };
})();