/*
  This page implements the same behavior as the VueUse hook in index.ts:
  - isSupported: checks for navigator.mediaDevices.getDisplayMedia
  - stream: holds the current MediaStream (or undefined)
  - start(): calls getDisplayMedia(constraints), binds 'ended' listeners, then sets enabled=true
  - stop(): stops all tracks, clears stream, sets enabled=false
  - enabled: toggling true starts, toggling false stops
*/

(() => {
  /** @type {MediaStream | undefined} */
  let stream;

  /** @type {MediaRecorder | undefined} */
  let recorder;
  /** @type {BlobPart[]} */
  let recordedChunks = [];

  /** @type {FileSystemDirectoryHandle | null} */
  let saveDirHandle = null;

  // Persist the chosen folder as the "default save folder" (Chromium-based browsers)
  const STORAGE_KEY = 'terd_default_save_dir_v1';

  async function idbOpen() {
    return await new Promise((resolve, reject) => {
      const req = indexedDB.open('terd_recorder', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv'))
          db.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSet(key, value) {
    const db = await idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  async function idbGet(key) {
    const db = await idbOpen();
    const val = await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readonly');
      const req = tx.objectStore('kv').get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return val;
  }

  async function ensureDirPermission(dirHandle) {
    // returns true if we can write
    try {
      // @ts-ignore
      const q = await dirHandle.queryPermission?.({ mode: 'readwrite' });
      if (q === 'granted') return true;
      // @ts-ignore
      const r = await dirHandle.requestPermission?.({ mode: 'readwrite' });
      return r === 'granted';
    } catch {
      // If API missing, assume ok and let write attempt decide.
      return true;
    }
  }

  const el = {
    supportDot: document.getElementById('supportDot'),
    supportText: document.getElementById('supportText'),
    enabledDot: document.getElementById('enabledDot'),
    enabledText: document.getElementById('enabledText'),

    enabledToggle: document.getElementById('enabledToggle'),
    videoToggle: document.getElementById('videoToggle'),
    audioToggle: document.getElementById('audioToggle'),
    recordToggle: document.getElementById('recordToggle'),

    startBtn: document.getElementById('startBtn'),
    stopBtn: document.getElementById('stopBtn'),
    pickFolderBtn: document.getElementById('pickFolderBtn'),
    recordingText: document.getElementById('recordingText'),
    recordHint: document.getElementById('recordHint'),

    previewVideo: document.getElementById('previewVideo'),
    placeholder: document.getElementById('placeholder'),
    trackMeta: document.getElementById('trackMeta'),
    recordingIndicator: document.getElementById('recordingIndicator'),
  };

  const isSupported = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

  // Persian labels
  const TEXT = {
    supported: 'پشتیبانی می‌شود',
    notSupported: 'پشتیبانی نمی‌شود',
    checking: 'در حال بررسی…',
    enabledYes: 'بله',
    enabledNo: 'خیر',
    recordingOn: 'روشن',
    recordingOff: 'خاموش',

    folderPickerNotSupported: 'انتخاب پوشه پشتیبانی نمی‌شود؛ فایل در پوشه دانلودهای مرورگر ذخیره می‌شود.',
    defaultFolderReady: 'پوشه‌ی پیش‌فرض تنظیم شد. ویدئوها به‌صورت خودکار در همان پوشه ذخیره می‌شوند.',
    defaultFolderNeedPermission: 'پوشه‌ی پیش‌فرض تنظیم شده اما مجوز دسترسی داده نشده است. یک‌بار روی «انتخاب پوشه‌ی ذخیره» کلیک کنید تا مجوز دوباره صادر شود.',
    savedToDefault: (name) => `در پوشه‌ی پیش‌فرض ذخیره شد: ${name}`,
    downloaded: (name) => `دانلود شد: ${name}`,
    recording: (mime) => `در حال ضبط… ${mime || ''}`.trim(),

    folderPickerMissingAlert: 'انتخاب پوشه در این مرورگر پشتیبانی نمی‌شود.',
    startFailed: (msg) => `شروع اشتراک‌گذاری انجام نشد.\n\n${msg}`,
    mediaRecorderNotSupported: 'قابلیت ضبط (MediaRecorder) در این مرورگر پشتیبانی نمی‌شود.',
    recordingInitFailed: 'راه‌اندازی ضبط ناموفق بود.',
  };

  function setDot(dotEl, kind) {
    // kind: 'ok' | 'warn' | 'danger'
    const map = {
      ok: { bg: 'var(--ok)', shadow: '0 0 0 4px rgba(56,214,159,0.14)' },
      warn: { bg: 'var(--warn)', shadow: '0 0 0 4px rgba(255,204,102,0.12)' },
      danger: { bg: 'var(--danger)', shadow: '0 0 0 4px rgba(255,91,107,0.14)' },
    };
    const s = map[kind] ?? map.warn;
    dotEl.style.background = s.bg;
    dotEl.style.boxShadow = s.shadow;
  }

  async function updateFolderHint() {
    if (!('showDirectoryPicker' in window)) return;

    if (!saveDirHandle) {
      el.recordHint.textContent = TEXT.noDefaultFolder;
      return;
    }

    const ok = await ensureDirPermission(saveDirHandle);
    el.recordHint.textContent = ok
      ? TEXT.defaultFolderReady
      : TEXT.defaultFolderNeedPermission;
  }

  function updateSupportUI() {
    el.supportText.textContent = isSupported ? TEXT.supported : TEXT.notSupported;
    setDot(el.supportDot, isSupported ? 'ok' : 'danger');
    el.startBtn.disabled = !isSupported;
    el.enabledToggle.disabled = !isSupported;
    el.videoToggle.disabled = !isSupported;
    el.audioToggle.disabled = !isSupported;
    el.recordToggle.disabled = !isSupported || !('MediaRecorder' in window);

    // Folder picker availability (Chromium-based mostly)
    el.pickFolderBtn.disabled = !('showDirectoryPicker' in window);
    if (!('showDirectoryPicker' in window)) {
      el.recordHint.textContent = TEXT.folderPickerNotSupported;
    } else {
      // async hint update
      void updateFolderHint();
    }
  }

  function updateEnabledUI(enabled) {
    el.enabledText.textContent = enabled ? TEXT.enabledYes : TEXT.enabledNo;
    setDot(el.enabledDot, enabled ? 'ok' : 'warn');

    el.startBtn.disabled = !isSupported || enabled;
    el.stopBtn.disabled = !enabled;

    el.placeholder.style.display = stream ? 'none' : 'grid';
  }

  function updateRecordingUI(isRecording) {
    el.recordingText.textContent = isRecording ? TEXT.recordingOn : TEXT.recordingOff;
    el.recordingText.classList.toggle('on', isRecording);
    el.recordingText.classList.toggle('off', !isRecording);

    // Show/Hide "REC" overlay on the video preview
    if (el.recordingIndicator)
      el.recordingIndicator.style.display = isRecording ? 'flex' : 'none';
  }

  function updateMeta() {
    if (!stream) {
      el.trackMeta.textContent = 'No stream';
      return;
    }

    const tracks = stream.getTracks();
    const parts = tracks.map(t => {
      const settings = t.getSettings ? t.getSettings() : {};
      const label = t.label || '(no label)';
      const details = [];
      if (t.kind === 'video') {
        if (settings.width && settings.height)
          details.push(`${settings.width}x${settings.height}`);
        if (settings.frameRate)
          details.push(`${settings.frameRate}fps`);
      }
      return `${t.kind}: ${label}${details.length ? ` (${details.join(', ')})` : ''}`;
    });

    el.trackMeta.textContent = parts.join(' | ');
  }

  function getConstraints() {
    // Mirror the TS hook defaults: pass {video, audio} where each is boolean/constraints.
    const video = el.videoToggle.checked ? true : false;
    const audio = el.audioToggle.checked ? true : false;
    return { video, audio };
  }

  function pickBestMimeType() {
    if (!('MediaRecorder' in window)) return undefined;

    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];

    for (const t of candidates) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return undefined;
  }

  function buildFilename() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    return `screen-recording-${stamp}.webm`;
  }

  async function saveBlob(blob, filename) {
    // 1) If user picked a folder (File System Access API), write directly there.
    if (saveDirHandle) {
      try {
        const ok = await ensureDirPermission(saveDirHandle);
        if (!ok)
          throw new Error('مجوز نوشتن در پوشه انتخاب‌شده وجود ندارد');

        const fileHandle = await saveDirHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        el.recordHint.textContent = TEXT.savedToDefault(filename);
        return;
      } catch (e) {
        console.warn('ذخیره در پوشه ناموفق بود؛ انتقال به حالت دانلود.', e);
        void updateFolderHint();
      }
    }

    // 2) Fallback: trigger a download (user can choose the folder via browser settings).
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    el.recordHint.textContent = TEXT.downloaded(filename);
  }

  function startRecording(ms) {
    if (!('MediaRecorder' in window)) {
      el.recordHint.textContent = TEXT.mediaRecorderNotSupported;
      return;
    }
    if (recorder && recorder.state !== 'inactive') return;

    recordedChunks = [];
    const mimeType = pickBestMimeType();

    try {
      recorder = new MediaRecorder(ms, mimeType ? { mimeType } : undefined);
    } catch (e) {
      console.error('ساخت MediaRecorder ناموفق بود', e);
      el.recordHint.textContent = TEXT.recordingInitFailed;
      return;
    }

    recorder.addEventListener('dataavailable', (evt) => {
      if (evt.data && evt.data.size > 0) recordedChunks.push(evt.data);
    });

    recorder.addEventListener('start', () => {
      updateRecordingUI(true);
      el.recordHint.textContent = TEXT.recording(recorder?.mimeType || '');
    });

    recorder.addEventListener('stop', async () => {
      updateRecordingUI(false);
      const mime = recorder?.mimeType || 'video/webm';
      const blob = new Blob(recordedChunks, { type: mime });
      recordedChunks = [];
      recorder = undefined;
      await saveBlob(blob, buildFilename());
    });

    // Collect chunks periodically so memory doesn't explode on long recordings.
    recorder.start(1000);
  }

  async function stopRecording() {
    if (!recorder || recorder.state === 'inactive') return;

    await new Promise((resolve) => {
      const r = recorder;
      r.addEventListener('stop', () => resolve(), { once: true });
      try {
        r.stop();
      } catch {
        resolve();
      }
    });
  }

  async function _start() {
    if (!isSupported || stream) return stream;

    const constraints = getConstraints();

    // getDisplayMedia must be called by a user gesture. If enabled toggle was clicked, that's ok.
    stream = await navigator.mediaDevices.getDisplayMedia(constraints);

    // Same behavior as: stream.getTracks().forEach(t => useEventListener(t, 'ended', stop))
    stream.getTracks().forEach(track => {
      track.addEventListener('ended', () => {
        void stop();
      }, { passive: true });
    });

    el.previewVideo.srcObject = stream;
    el.previewVideo.muted = true; // avoid echo in preview

    updateMeta();

    // Auto start recording when sharing starts
    if (el.recordToggle.checked)
      startRecording(stream);

    return stream;
  }

  async function _stop() {
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
    }
    stream = undefined;

    el.previewVideo.srcObject = null;
    updateMeta();
  }

  async function stop() {
    // Stop recording first so we can finalize and save the file, then stop the stream.
    await stopRecording();
    await _stop();
    el.enabledToggle.checked = false;
    updateEnabledUI(false);
  }

  async function start() {
    try {
      await _start();
      if (stream) {
        el.enabledToggle.checked = true;
        updateEnabledUI(true);
      }
      return stream;
    } catch (err) {
      console.error(err);
      // If user cancels picker, ensure UI returns to disabled state.
      el.enabledToggle.checked = false;
      updateEnabledUI(false);
      alert(TEXT.startFailed(err?.message ?? err));
    }
  }

  // "watch(enabled, ...)" equivalent
  el.enabledToggle.addEventListener('change', async () => {
    if (el.enabledToggle.checked) await start();
    else await stop();
  });

  el.startBtn.addEventListener('click', async () => {
    await start();
  });

  el.stopBtn.addEventListener('click', async () => {
    await stop();
  });

  el.pickFolderBtn.addEventListener('click', async () => {
    if (!('showDirectoryPicker' in window)) {
      alert(TEXT.folderPickerMissingAlert);
      return;
    }
    try {
      // @ts-ignore
      saveDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      // Persist as default folder
      await idbSet(STORAGE_KEY, saveDirHandle);
      await updateFolderHint();
    } catch (e) {
      // user cancelled
      console.warn(e);
    }
  });

  async function restoreDefaultFolder() {
    if (!('showDirectoryPicker' in window)) return;
    try {
      const saved = await idbGet(STORAGE_KEY);
      if (saved) {
        saveDirHandle = saved;
        await updateFolderHint();
      }
    } catch (e) {
      console.warn('بازیابی پوشه پیش‌فرض ناموفق بود', e);
    }
  }

  // Initial UI
  updateSupportUI();
  updateEnabledUI(false);
  updateRecordingUI(false);
  void restoreDefaultFolder();
})();
