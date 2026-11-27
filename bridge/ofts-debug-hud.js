(function () {
  'use strict';

  window.__OFT_DEBUG_BUILD__ = true;

  function mountDebugHud() {
    if (document.getElementById('ofts-debug-hud')) return;
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', mountDebugHud, { once: true });
      return;
    }

    const hud = document.createElement('div');
    hud.id = 'ofts-debug-hud';
    hud.style.cssText = [
      'position:fixed',
      'top:8px',
      'right:8px',
      'z-index:2147483647',
      'font-family:ui-monospace,SFMono-Regular,Consolas,monospace',
      'font-size:10px',
      'line-height:1.35',
      'color:#e6f1d4',
      'background:rgba(15,20,12,0.84)',
      'border:1px solid rgba(199,220,156,0.28)',
      'border-radius:8px',
      'padding:5px 8px',
      'user-select:none',
      'touch-action:none',
      'cursor:grab',
      'min-width:128px',
      'box-shadow:0 4px 14px rgba(0,0,0,0.45)',
      'contain:layout style paint',
      'pointer-events:auto',
    ].join(';');

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:700;';

    const fpsEl = document.createElement('span');
    const fpsText = document.createTextNode('-- FPS');
    fpsEl.appendChild(fpsText);

    const toggleEl = document.createElement('span');
    toggleEl.textContent = 'DBG ▾';
    toggleEl.style.cssText = 'color:#9cb37c;font-size:9px;cursor:pointer;';

    header.appendChild(fpsEl);
    header.appendChild(toggleEl);

    const details = document.createElement('div');
    details.style.cssText = 'margin-top:3px;border-top:1px solid rgba(199,220,156,0.16);padding-top:3px;white-space:pre;color:#c7dc9c;font-size:9.5px;';
    const detailsText = document.createTextNode('init...');
    details.appendChild(detailsText);

    hud.appendChild(header);
    hud.appendChild(details);
    document.body.appendChild(hud);

    let collapsed = false;
    toggleEl.addEventListener('click', function (e) {
      e.stopPropagation();
      collapsed = !collapsed;
      details.style.display = collapsed ? 'none' : 'block';
      toggleEl.textContent = collapsed ? 'DBG ▸' : 'DBG ▾';
    });

    // Draggable HUD
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;
    hud.addEventListener('pointerdown', function (e) {
      if (e.target === toggleEl) return;
      dragging = true;
      hud.style.cursor = 'grabbing';
      const rect = hud.getBoundingClientRect();
      origLeft = rect.left;
      origTop = rect.top;
      startX = e.clientX;
      startY = e.clientY;
      hud.style.right = 'auto';
      hud.style.left = origLeft + 'px';
      hud.style.top = origTop + 'px';
      try { hud.setPointerCapture(e.pointerId); } catch (_) {}
    });
    hud.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      const nx = Math.max(4, Math.min(window.innerWidth - 60, origLeft + (e.clientX - startX)));
      const ny = Math.max(4, Math.min(window.innerHeight - 30, origTop + (e.clientY - startY)));
      hud.style.left = nx + 'px';
      hud.style.top = ny + 'px';
    });
    function endDrag() {
      dragging = false;
      hud.style.cursor = 'grab';
    }
    hud.addEventListener('pointerup', endDrag);
    hud.addEventListener('pointercancel', endDrag);

    // One-time GPU info
    let gpuShort = 'GPU';
    try {
      if (window.OFTSNative && typeof window.OFTSNative.getGpuInfo === 'function') {
        const g = window.OFTSNative.getGpuInfo();
        const r = (g && g.renderer) || '';
        const m = r.match(/ANGLE \([^,]+,\s*([^,)]+)/i);
        gpuShort = (m ? m[1] : r).replace(/\(TM\)|\(R\)|Direct3D11.*$/gi, '').trim().slice(0, 22) || 'WebGL';
        if (g && g.isSoftwareFallback) gpuShort = 'SW:' + gpuShort;
      }
    } catch (_) {}

    // Cached viewport dims (avoid forcing reflow in rAF)
    let vpW = window.innerWidth;
    let vpH = window.innerHeight;
    let vpDpr = (window.devicePixelRatio || 1).toFixed(2);
    window.addEventListener('resize', function () {
      vpW = window.innerWidth;
      vpH = window.innerHeight;
      vpDpr = (window.devicePixelRatio || 1).toFixed(2);
    }, { passive: true });

    // FPS & frame-time ring buffer
    const samples = new Float32Array(60);
    let sIdx = 0;
    let sCount = 0;
    let lastTs = performance.now();
    let lastHudUpdate = lastTs;
    let framesInWindow = 0;
    let jankFrames = 0;
    let lastColor = '';

    function tick(now) {
      const dt = now - lastTs;
      lastTs = now;
      if (dt > 0 && dt < 1000) {
        samples[sIdx] = dt;
        sIdx = (sIdx + 1) % samples.length;
        if (sCount < samples.length) sCount++;
        framesInWindow++;
        if (dt > 20.5) jankFrames++;
      }

      if (now - lastHudUpdate >= 250) {
        const elapsed = now - lastHudUpdate;
        const fps = Math.round((framesInWindow * 1000) / Math.max(1, elapsed));
        framesInWindow = 0;
        lastHudUpdate = now;

        let sum = 0;
        let maxDt = 0;
        for (let i = 0; i < sCount; i++) {
          const v = samples[i];
          sum += v;
          if (v > maxDt) maxDt = v;
        }
        const avgDt = sCount > 0 ? sum / sCount : 0;

        fpsText.nodeValue = fps + ' FPS';
        const nextColor = fps >= 55 ? '#b9ea82' : fps >= 35 ? '#f5cf6b' : '#ff867c';
        if (nextColor !== lastColor) {
          lastColor = nextColor;
          fpsEl.style.color = nextColor;
        }

        if (!collapsed) {
          const mainC = document.getElementById('editor-active-canvas');
          const ovC = document.getElementById('editor-overlay-canvas');
          const cInfo = mainC ? (mainC.width + 'x' + mainC.height) : '-';
          const oInfo = ovC ? (ovC.width + 'x' + ovC.height) : '-';
          const mem = performance && performance.memory
            ? (performance.memory.usedJSHeapSize / (1024 * 1024)).toFixed(0) + 'MB'
            : 'n/a';
          const plat = (window.OFTSNative && window.OFTSNative.platform) || 'app';
          const pcm = window.PreviewCacheManager;
          let cacheStr = '-';
          if (pcm && pcm.frames) {
            let ramFrames = 0;
            let diskFrames = 0;
            pcm.frames.forEach(function (e) {
              if (e && e.cold) diskFrames++;
              else ramFrames++;
            });
            cacheStr = ramFrames + ' ram + ' + diskFrames + ' disk';
          }

          detailsText.nodeValue =
            'ft:    ' + avgDt.toFixed(1) + 'ms (max ' + maxDt.toFixed(0) + ')\n' +
            'jnk:   ' + jankFrames + '  heap: ' + mem + '\n' +
            'cvs:   ' + cInfo + ' / ' + oInfo + '\n' +
            'cache: ' + cacheStr + '\n' +
            'gpu:   ' + gpuShort + ' [' + plat + ']';
        }
      }

      requestAnimationFrame(tick);
    }

    requestAnimationFrame(tick);
  }

  mountDebugHud();
})();
