(function () {
  'use strict';

  const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/openfishtools/Studio/main';
  const GITHUB_VERSION_URL = `${GITHUB_RAW_BASE}/version.json`;
  const progressBar = document.getElementById('progress-bar');
  const logText = document.getElementById('log-text');

  function setStatus(pct, msg) {
    if (progressBar) progressBar.style.width = `${Math.max(0, Math.min(100, Math.round(pct)))}%`;
    if (logText && msg) logText.textContent = msg;
  }

  function extractDeepLinkProjectId(raw) {
    if (!raw) return '';
    const str = String(raw).trim().replace(/^#/, '');
    const schemeMatch = str.match(/^(?:ofts|fishtools):\/\/(?:import\/|project\/|p\/)?([a-zA-Z0-9_-]+)/i);
    if (schemeMatch && schemeMatch[1]) return schemeMatch[1].trim();
    if (str.startsWith('import=') || str.startsWith('deeplink=')) {
      const eqVal = decodeURIComponent(str.split('=').slice(1).join('='));
      return extractDeepLinkProjectId(eqVal);
    }
    try {
      const normalized = /^https?:\/\//i.test(str) ? str : (str.includes('cutefish.my.id') ? 'https://' + str : str);
      const parsed = new URL(normalized, 'https://studio.cutefish.my.id');
      const queryId = parsed.searchParams.get('import') || parsed.searchParams.get('p') || parsed.searchParams.get('project') || parsed.searchParams.get('id');
      if (queryId) return queryId.replace(/[^a-zA-Z0-9_-]/g, '').trim();
      const dl = parsed.searchParams.get('deeplink');
      if (dl) return extractDeepLinkProjectId(dl);
      const segs = parsed.pathname.split('/').filter(Boolean);
      if (segs.length > 0) {
        const last = segs[segs.length - 1].trim();
        if (!last.endsWith('.html')) return last.replace(/[^a-zA-Z0-9_-]/g, '');
      }
    } catch (_) {}
    const parts = str.split('/');
    return parts[parts.length - 1].replace(/[^a-zA-Z0-9_-]/g, '').trim();
  }

  function resolveIncomingImportId() {
    try {
      if (window.__OFT_DEEPLINK__) {
        const id = extractDeepLinkProjectId(window.__OFT_DEEPLINK__);
        window.__OFT_DEEPLINK__ = null;
        if (id) return id;
      }
      if (window.location.hash && window.location.hash.length > 1) {
        const id = extractDeepLinkProjectId(decodeURIComponent(window.location.hash.slice(1)));
        if (id) return id;
      }
      const params = new URLSearchParams(window.location.search);
      const rawParam = params.get('deeplink') || params.get('import') || params.get('p') || params.get('project');
      if (rawParam) {
        const id = extractDeepLinkProjectId(rawParam);
        if (id) return id;
      }
    } catch (_) {}
    return '';
  }

  function checkLocalDiskVersion() {
    return new Promise((resolve) => {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', './studio/version.json', true);
        xhr.timeout = 1500;
        xhr.onload = function () {
          if ((xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) && xhr.responseText) {
            try {
              const parsed = JSON.parse(xhr.responseText);
              if (parsed && parsed.version) {
                resolve(String(parsed.version));
                return;
              }
            } catch (_) {}
          }
          resolve(null);
        };
        xhr.onerror = () => resolve(null);
        xhr.ontimeout = () => resolve(null);
        xhr.send(null);
      } catch (_) {
        resolve(null);
      }
    });
  }

  async function checkRemoteVersion() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    try {
      const res = await fetch(`${GITHUB_VERSION_URL}?t=${Date.now()}`, {
        signal: controller.signal,
        cache: 'no-store'
      });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        return data && data.version ? String(data.version) : null;
      }
    } catch (_) {
      clearTimeout(timer);
    }
    return null;
  }

  function checkLiveDeepLinkFile() {
    return new Promise((resolve) => {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', `./deeplink-live.json?t=${Date.now()}`, true);
        xhr.timeout = 800;
        xhr.onload = function () {
          if ((xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) && xhr.responseText) {
            try {
              const payload = JSON.parse(xhr.responseText);
              if (payload && payload.ts && (payload.url || payload.id)) {
                const lastTs = localStorage.getItem('oft_last_deeplink_ts');
                if (String(payload.ts) !== String(lastTs)) {
                  localStorage.setItem('oft_last_deeplink_ts', String(payload.ts));
                  const id = extractDeepLinkProjectId(payload.url || payload.id);
                  if (id) {
                    resolve(id);
                    return;
                  }
                }
              }
            } catch (_) {}
          }
          resolve('');
        };
        xhr.onerror = () => resolve('');
        xhr.ontimeout = () => resolve('');
        xhr.send(null);
      } catch (_) {
        resolve('');
      }
    });
  }

  async function start() {
    let incomingImportId = resolveIncomingImportId();
    const earlyLiveId = await checkLiveDeepLinkFile();
    if (!incomingImportId && earlyLiveId) {
      incomingImportId = earlyLiveId;
    }
    if (incomingImportId) {
      try { sessionStorage.setItem('oft_pending_import_id', incomingImportId); } catch (_) {}
    }

    try {
      if (navigator.storage && typeof navigator.storage.persist === 'function') {
        try { await navigator.storage.persist(); } catch (_) {}
      }
      const diskVersion = await checkLocalDiskVersion();
      const installedVersion = localStorage.getItem('ofts_installed_version') || diskVersion;
      setStatus(20, installedVersion ? `Installed v${installedVersion}` : 'Checking installation...');

      setStatus(50, 'Checking github.com/openfishtools/Studio...');
      const remoteVersion = await checkRemoteVersion();

      if (remoteVersion) {
        if (installedVersion !== remoteVersion || (diskVersion && diskVersion !== remoteVersion)) {
          setStatus(75, `Updating to v${remoteVersion}...`);
          try {
            const wasmRes = await fetch(`${GITHUB_RAW_BASE}/effects/effects.wasm?t=${Date.now()}`, { cache: 'no-store' });
            if (wasmRes.ok) {
              const buf = new Uint8Array(await wasmRes.arrayBuffer());
              let bin = '';
              for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
              localStorage.setItem('ofts_latest_effects_wasm_b64', btoa(bin));
              localStorage.setItem('ofts_latest_effects_wasm_ver', remoteVersion);
            }
          } catch (_) {}
          if (diskVersion && diskVersion !== remoteVersion) {
            localStorage.setItem('ofts_live_cdn_ver', remoteVersion);
          } else {
            localStorage.removeItem('ofts_live_cdn_ver');
          }
          localStorage.setItem('ofts_installed_version', remoteVersion);
        } else {
          localStorage.removeItem('ofts_live_cdn_ver');
          setStatus(85, `Up to date (v${remoteVersion})`);
        }
      } else {
        setStatus(85, installedVersion ? `Offline mode (v${installedVersion})` : 'Offline ready');
      }

      const lateLiveId = await checkLiveDeepLinkFile();
      if (!incomingImportId && lateLiveId) {
        incomingImportId = lateLiveId;
      }
      if (incomingImportId) {
        try { sessionStorage.setItem('oft_pending_import_id', incomingImportId); } catch (_) {}
      }
      const targetStudioUrl = incomingImportId
        ? `./studio/index.html?import=${encodeURIComponent(incomingImportId)}#import=${encodeURIComponent(incomingImportId)}`
        : './studio/index.html';

      setStatus(100, incomingImportId ? 'Opening Preset...' : 'Launching FishTools Studio...');
      setTimeout(() => {
        window.location.replace(targetStudioUrl);
      }, 250);
    } catch (_) {
      const targetStudioUrl = incomingImportId
        ? `./studio/index.html?import=${encodeURIComponent(incomingImportId)}#import=${encodeURIComponent(incomingImportId)}`
        : './studio/index.html';
      setStatus(100, 'Launching FishTools Studio...');
      window.location.replace(targetStudioUrl);
    }
  }

  start();
})();
