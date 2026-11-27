(function () {
  'use strict';

  const statusEl = document.getElementById('status');
  const progressTrackEl = document.getElementById('progress-track');
  const storageBoxEl = document.getElementById('storage-box');
  const storagePathEl = document.getElementById('storage-path');
  const metaEl = document.getElementById('meta');
  const gpuEl = document.getElementById('gpu');
  const barEl = document.getElementById('bar');
  const actionsEl = document.getElementById('actions');

  const btnPickFolder = document.getElementById('btn-pick-folder');
  const btnConfirmStorage = document.getElementById('btn-confirm-storage');
  const btnSkip = document.getElementById('btn-skip');
  const btnRetry = document.getElementById('btn-retry');
  const btnOpen = document.getElementById('btn-open');
  const btnChangeStorage = document.getElementById('btn-change-storage');
  const btnUpdate = document.getElementById('btn-update');
  const btnClear = document.getElementById('btn-clear');

  if (!window.__TAURI__) {
    statusEl.textContent = 'Runtime error';
    barEl.classList.remove('indeterminate');
    return;
  }

  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  let selectedStorageDir = '';

  function hideExtras() {
    storageBoxEl.classList.add('hidden');
    metaEl.classList.add('hidden');
    gpuEl.classList.add('hidden');
    actionsEl.classList.add('hidden');
    [
      btnPickFolder,
      btnConfirmStorage,
      btnSkip,
      btnRetry,
      btnOpen,
      btnChangeStorage,
      btnUpdate,
      btnClear,
    ].forEach(function (b) {
      b.classList.add('hidden');
    });
  }

  function showButton(btn) {
    actionsEl.classList.remove('hidden');
    btn.classList.remove('hidden');
  }

  function setProgress(percent) {
    progressTrackEl.classList.remove('hidden');
    if (percent === null || percent === undefined || isNaN(percent)) {
      barEl.classList.add('indeterminate');
      barEl.style.width = '';
    } else {
      barEl.classList.remove('indeterminate');
      barEl.style.width = Math.max(0, Math.min(100, percent)).toFixed(1) + '%';
    }
  }

  async function openCachedStudio() {
    const url = await invoke('get_studio_entry_url');
    window.location.href = url;
  }

  let unlisten = null;

  async function runSync(force) {
    hideExtras();
    setProgress(null);
    statusEl.textContent = 'Updating...';

    if (unlisten) {
      unlisten();
      unlisten = null;
    }

    unlisten = await listen('studio-sync-progress', function (event) {
      const p = event.payload || {};
      statusEl.textContent = 'Updating...';
      setProgress(p.percent);
    });

    try {
      const res = await invoke('prepare_studio', { force: !!force });
      setProgress(100);
      window.location.href = res.entry_url;
    } catch (err) {
      barEl.classList.remove('indeterminate');
      barEl.style.width = '0%';
      statusEl.textContent = 'Update failed';
      metaEl.classList.remove('hidden');
      metaEl.textContent = String(err && err.message ? err.message : err);
      showButton(btnRetry);
      try {
        const info = await invoke('get_cache_info');
        if (info && info.ready) {
          showButton(btnSkip);
        }
      } catch (_) {}
    }
  }

  function showFirstLaunchStoragePicker(cfg) {
    hideExtras();
    progressTrackEl.classList.add('hidden');
    statusEl.textContent = 'Storage Location';
    selectedStorageDir = cfg.storage_dir || cfg.default_dir || '';
    storagePathEl.textContent = selectedStorageDir;
    storageBoxEl.classList.remove('hidden');
    showButton(btnPickFolder);
    showButton(btnConfirmStorage);
  }

  function probeGpu() {
    let renderer = 'Unknown';
    let isWebGL2 = false;
    try {
      const c = document.createElement('canvas');
      const gl =
        c.getContext('webgl2', { powerPreference: 'high-performance' }) ||
        c.getContext('webgl', { powerPreference: 'high-performance' });
      if (gl) {
        isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      }
    } catch (_) {}
    const isSoftware = /swiftshader|basic render|llvmpipe|software/i.test(renderer || '');
    const webCodecs = typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';
    return { renderer: renderer || 'Unknown', isWebGL2, webCodecs, isSoftware };
  }

  async function showManageMode() {
    hideExtras();
    setProgress(100);
    statusEl.textContent = 'Studio Settings';

    const g = probeGpu();
    gpuEl.classList.remove('hidden');
    if (g.isSoftware) {
      gpuEl.classList.add('warn');
      gpuEl.textContent =
        'GPU Software Fallback: ' + g.renderer +
        ' | WebGL2: ' + (g.isWebGL2 ? 'Ya' : 'Tidak') +
        ' | WebCodecs: ' + (g.webCodecs ? 'Ya' : 'Tidak');
    } else {
      gpuEl.classList.remove('warn');
      gpuEl.textContent =
        'GPU: ' + g.renderer +
        ' | WebGL2: ' + (g.isWebGL2 ? 'Ya' : 'Tidak') +
        ' | WebCodecs: ' + (g.webCodecs ? 'Ya' : 'Tidak');
    }

    try {
      const cfg = await invoke('get_storage_config');
      selectedStorageDir = cfg.storage_dir || cfg.default_dir || '';
      storagePathEl.textContent = selectedStorageDir;
      storageBoxEl.classList.remove('hidden');

      const info = await invoke('get_cache_info');
      const shortCommit = info.commit ? info.commit.slice(0, 8) : '-';
      metaEl.classList.remove('hidden');
      metaEl.textContent =
        info.repo + ' (' + info.branch + ') • v' + (info.version || '-') + ' • ' + shortCommit;
      if (info.ready) {
        showButton(btnOpen);
        showButton(btnClear);
      }
      if (cfg.platform !== 'android') {
        showButton(btnChangeStorage);
      }
      showButton(btnUpdate);
    } catch (err) {
      metaEl.classList.remove('hidden');
      metaEl.textContent = String(err);
      showButton(btnUpdate);
    }
  }

  btnPickFolder.addEventListener('click', async function () {
    const picked = await invoke('pick_storage_folder', { initialDir: selectedStorageDir || null });
    if (picked) {
      selectedStorageDir = picked;
      storagePathEl.textContent = selectedStorageDir;
    }
  });

  btnConfirmStorage.addEventListener('click', async function () {
    try {
      await invoke('set_storage_dir', { path: selectedStorageDir });
      runSync(false);
    } catch (err) {
      metaEl.classList.remove('hidden');
      metaEl.textContent = 'Gagal menyimpan folder: ' + err;
    }
  });

  btnChangeStorage.addEventListener('click', async function () {
    const picked = await invoke('pick_storage_folder', { initialDir: selectedStorageDir || null });
    if (picked) {
      try {
        await invoke('set_storage_dir', { path: picked });
        selectedStorageDir = picked;
        storagePathEl.textContent = picked;
      } catch (err) {
        metaEl.classList.remove('hidden');
        metaEl.textContent = 'Gagal mengganti folder: ' + err;
      }
    }
  });

  btnSkip.addEventListener('click', openCachedStudio);
  btnOpen.addEventListener('click', openCachedStudio);
  btnRetry.addEventListener('click', function () {
    runSync(false);
  });
  btnUpdate.addEventListener('click', function () {
    runSync(true);
  });
  btnClear.addEventListener('click', async function () {
    hideExtras();
    statusEl.textContent = 'Updating...';
    await invoke('clear_studio_cache');
    runSync(true);
  });

  async function boot() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('manage') === '1') {
      showManageMode();
      return;
    }
    try {
      const cfg = await invoke('get_storage_config');
      if (!cfg.configured && cfg.platform !== 'android') {
        showFirstLaunchStoragePicker(cfg);
        return;
      }
    } catch (_) {}
    runSync(false);
  }

  boot();
})();
