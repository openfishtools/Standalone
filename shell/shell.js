(function () {
  'use strict';

  const STUDIO_ORIGIN = 'https://studio.cutefish.my.id';
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
      const parsed = new URL(normalized, STUDIO_ORIGIN);
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

  function start() {
    const incomingImportId = resolveIncomingImportId();
    const targetUrl = incomingImportId
      ? `${STUDIO_ORIGIN}/?import=${encodeURIComponent(incomingImportId)}`
      : `${STUDIO_ORIGIN}/`;

    setStatus(100, incomingImportId ? 'Opening Preset...' : 'Launching FishTools Studio...');
    window.location.replace(targetUrl);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
