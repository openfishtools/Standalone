/**
 * GPU Acceleration & Native Injected Bridge for FishTools Studio
 *
 * Configures the WebView runtime with full GPU priority, high-performance canvas
 * contexts, WebGL2/WebGPU detection, and bi-directional native messaging.
 */

export const GPU_INJECTED_BRIDGE_JS = `
(function() {
  if (window.__FISHTOOLS_NATIVE_BRIDGE_INSTALLED__) return;
  window.__FISHTOOLS_NATIVE_BRIDGE_INSTALLED__ = true;

  // 1. Telemetry & GPU Detection
  function inspectGPU() {
    var gpuInfo = {
      vendor: 'Unknown',
      renderer: 'Software / Basic',
      webgl1: false,
      webgl2: false,
      webgpu: false,
      webcodecs: typeof VideoEncoder !== 'undefined',
      hardwareAccelerated: false,
      maxTextureSize: 0,
      timestamp: Date.now()
    };

    try {
      // Check WebGPU
      if (navigator.gpu) {
        gpuInfo.webgpu = true;
      }

      // Check WebGL 2
      var canvas = document.createElement('canvas');
      var gl2 = canvas.getContext('webgl2', {
        powerPreference: 'high-performance',
        desynchronized: true,
        antialias: true
      });

      if (gl2) {
        gpuInfo.webgl2 = true;
        gpuInfo.webgl1 = true;
        gpuInfo.maxTextureSize = gl2.getParameter(gl2.MAX_TEXTURE_SIZE);
        var dbg2 = gl2.getExtension('WEBGL_debug_renderer_info');
        if (dbg2) {
          gpuInfo.vendor = gl2.getParameter(dbg2.UNMASKED_VENDOR_WEBGL) || gpuInfo.vendor;
          gpuInfo.renderer = gl2.getParameter(dbg2.UNMASKED_RENDERER_WEBGL) || gpuInfo.renderer;
        }
      } else {
        // Fallback to WebGL 1
        var gl1 = canvas.getContext('webgl', { powerPreference: 'high-performance' }) ||
                  canvas.getContext('experimental-webgl', { powerPreference: 'high-performance' });
        if (gl1) {
          gpuInfo.webgl1 = true;
          gpuInfo.maxTextureSize = gl1.getParameter(gl1.MAX_TEXTURE_SIZE);
          var dbg1 = gl1.getExtension('WEBGL_debug_renderer_info');
          if (dbg1) {
            gpuInfo.vendor = gl1.getParameter(dbg1.UNMASKED_VENDOR_WEBGL) || gpuInfo.vendor;
            gpuInfo.renderer = gl1.getParameter(dbg1.UNMASKED_RENDERER_WEBGL) || gpuInfo.renderer;
          }
        }
      }

      // Assess if hardware accelerated
      var rendererLower = (gpuInfo.renderer || '').toLowerCase();
      if (
        !rendererLower.includes('software') &&
        !rendererLower.includes('llvmpipe') &&
        !rendererLower.includes('swiftshader') &&
        !rendererLower.includes('basic render')
      ) {
        gpuInfo.hardwareAccelerated = true;
      }
    } catch (e) {
      console.warn('[FishTools GPU Bridge] Error querying GPU:', e);
    }

    return gpuInfo;
  }

  // 2. High-Performance Context Override
  // Optimize 2D and WebGL canvas creation automatically for full GPU compositing
  var origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, attributes) {
    attributes = attributes || {};
    if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
      attributes.powerPreference = attributes.powerPreference || 'high-performance';
      if (attributes.desynchronized === undefined) attributes.desynchronized = true;
    } else if (type === '2d') {
      if (attributes.desynchronized === undefined) attributes.desynchronized = true;
      if (attributes.willReadFrequently === undefined) attributes.willReadFrequently = false;
    }
    return origGetContext.call(this, type, attributes);
  };

  // 3. Native Bridge Interface
  window.FishToolsNative = {
    isStandalone: true,
    platform: window.navigator.platform,
    gpu: inspectGPU(),
    notifyNative: function(action, payload) {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          source: 'FishToolsStudioWeb',
          action: action,
          payload: payload || {}
        }));
      }
    }
  };

  // 4. Send initial GPU diagnostics to React Native host
  setTimeout(function() {
    window.FishToolsNative.notifyNative('GPU_TELEMETRY', window.FishToolsNative.gpu);
  }, 100);

  console.log('[FishTools] Full GPU Acceleration Bridge & Native hooks initialized:', window.FishToolsNative.gpu);
})();
true;
`;
