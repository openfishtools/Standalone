(function () {
  'use strict';

  if (!window.__TAURI__) return;

  // Mark as native app for Studio's getStudioApiUrl() & isRunningInsideNativeApp()
  window.__OFT_NATIVE_APP__ = true;

  const { invoke, convertFileSrc } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  const isAndroidUA = /Android/i.test(navigator.userAgent || '');
  let detectedPlatform = isAndroidUA ? 'android' : 'windows';
  invoke('app_info')
    .then(function (info) {
      if (info && info.platform) {
        detectedPlatform = info.platform;
      }
    })
    .catch(function () {});

  // 1. Disable Service Worker in native WebView
  if (navigator.serviceWorker) {
    navigator.serviceWorker.register = function () {
      return Promise.reject(new Error('SW disabled in native'));
    };
  }

  // 2. Block browser-only shortcuts without stopping propagation to editor shortcuts
  window.addEventListener('keydown', function (e) {
    const key = (e.key || '').toLowerCase();
    const ctrlOrMeta = e.ctrlKey || e.metaKey;
    if (ctrlOrMeta && e.shiftKey && key === 'u') {
      e.preventDefault();
      invoke('open_updater_ui').catch(function () {});
      return;
    }
    if (
      e.key === 'F5' ||
      e.key === 'F3' ||
      e.key === 'F7' ||
      (ctrlOrMeta && (key === 'r' || key === 'p' || key === 'u'))
    ) {
      e.preventDefault();
    }
  });

  // 3. Block default browser context menu outside editable text fields
  window.addEventListener('contextmenu', function (e) {
    const target = e.target;
    if (
      target &&
      typeof target.closest === 'function' &&
      target.closest('input, textarea, [contenteditable]')
    ) {
      return;
    }
    e.preventDefault();
  });

  // 4. Helpers for extensions, MIME, and path memory
  function getExtension(filename) {
    if (!filename || typeof filename !== 'string') return null;
    const idx = filename.lastIndexOf('.');
    if (idx <= 0 || idx === filename.length - 1) return null;
    return filename.slice(idx + 1).toLowerCase();
  }

  function guessMime(filename) {
    const ext = getExtension(filename) || '';
    const map = {
      mp4: 'video/mp4',
      webm: 'video/webm',
      mov: 'video/quicktime',
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      zip: 'application/zip',
      json: 'application/json',
      ofts: 'application/octet-stream',
      fishpreset: 'application/json',
    };
    return map[ext] || 'application/octet-stream';
  }

  const PROJECT_PATH_KEY = 'ofts_native_project_paths_v1';
  let currentProjectPath = null;

  function loadProjectPaths() {
    try {
      return JSON.parse(sessionStorage.getItem(PROJECT_PATH_KEY) || '{}');
    } catch (_) {
      return {};
    }
  }

  function saveProjectPathForId(projectId, filePath) {
    currentProjectPath = filePath || null;
    if (!projectId || !filePath) return;
    try {
      const map = loadProjectPaths();
      map[String(projectId)] = filePath;
      sessionStorage.setItem(PROJECT_PATH_KEY, JSON.stringify(map));
    } catch (_) {}
  }

  function getProjectPathForId(projectId) {
    if (projectId) {
      const map = loadProjectPaths();
      if (map[String(projectId)]) return map[String(projectId)];
    }
    return currentProjectPath;
  }

  function uint8ToBase64(u8) {
    const chunk = 0x8000;
    const parts = [];
    for (let i = 0; i < u8.length; i += chunk) {
      parts.push(String.fromCharCode.apply(null, u8.subarray(i, i + chunk)));
    }
    return btoa(parts.join(''));
  }

  function toIpcBinaryPayload(u8) {
    if (detectedPlatform === 'android') {
      return { b64: uint8ToBase64(u8) };
    }
    return u8;
  }

  // 5. Streaming File Writer (Windows: native Save dialog; Android: cache + MediaStore publish)
  async function createStreamObject(targetPath, displayName, mimeType) {
    const handle = await invoke('open_write_stream', { path: targetPath });
    let closed = false;
    return {
      path: targetPath,
      write: async function (chunk, offset) {
        if (closed) throw new Error('Stream already closed');
        const u8 =
          chunk instanceof Uint8Array
            ? chunk
            : chunk instanceof ArrayBuffer
            ? new Uint8Array(chunk)
            : new Uint8Array(chunk.buffer, chunk.byteOffset || 0, chunk.byteLength || chunk.length);
        const headers = { 'x-handle': String(handle) };
        if (typeof offset === 'number' && isFinite(offset) && offset >= 0) {
          headers['x-offset'] = String(Math.floor(offset));
        }
        await invoke('write_stream_chunk', toIpcBinaryPayload(u8), { headers: headers });
      },
      close: async function () {
        if (closed) return targetPath;
        closed = true;
        const finalPath = await invoke('close_write_stream', { handle: handle });
        if (
          detectedPlatform === 'android' &&
          window.AndroidNative &&
          typeof window.AndroidNative.publishToDownloads === 'function'
        ) {
          const mime = mimeType || guessMime(displayName);
          window.AndroidNative.publishToDownloads(finalPath, displayName || 'export.bin', mime);
        }
        return finalPath;
      },
      abort: async function () {
        if (closed) return;
        closed = true;
        try {
          await invoke('abort_write_stream', { handle: handle });
        } catch (_) {}
      },
    };
  }

  async function openWriteStream(suggestedName, ext, mimeType) {
    const safeName = suggestedName || 'export.bin';
    const fileExt = ext || getExtension(safeName);
    if (detectedPlatform === 'android') {
      const uniqueName = Date.now() + '_' + safeName.replace(/[^a-zA-Z0-9._-]/g, '_');
      return createStreamObject('cache:' + uniqueName, safeName, mimeType || guessMime(safeName));
    }
    const path = await invoke('pick_save_path', {
      suggestedName: safeName,
      ext: fileExt,
    });
    if (!path) return null; // User cancelled
    return createStreamObject(path, safeName, mimeType || guessMime(safeName));
  }

  async function openWriteStreamAtPath(exactPath, mimeType) {
    if (!exactPath) return null;
    const parts = exactPath.split(/[\\/]/);
    const displayName = parts[parts.length - 1] || 'project.ofts';
    return createStreamObject(exactPath, displayName, mimeType || guessMime(displayName));
  }

  const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB
  const STREAM_THRESHOLD = 16 * 1024 * 1024; // 16 MB

  async function saveBlobStreamed(blob, suggestedName, existingPath) {
    if (!blob) return null;
    const name = suggestedName || 'download';
    const mime = blob.type || guessMime(name);
    let stream = null;
    try {
      stream = existingPath
        ? await openWriteStreamAtPath(existingPath, mime)
        : await openWriteStream(name, getExtension(name), mime);
      if (!stream) return null; // User cancelled

      let offset = 0;
      while (offset < blob.size) {
        const slice = blob.slice(offset, offset + CHUNK_SIZE);
        const buf = await slice.arrayBuffer();
        await stream.write(new Uint8Array(buf));
        offset += slice.size;
      }
      return await stream.close();
    } catch (err) {
      if (stream) await stream.abort();
      alert('Save failed: ' + (err && err.message ? err.message : err));
      return null;
    }
  }

  async function saveBytes(suggestedName, bytesOrPromise) {
    try {
      const data = await bytesOrPromise;
      const buf =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer || data);
      if (detectedPlatform === 'android' || buf.byteLength >= STREAM_THRESHOLD) {
        return await saveBlobStreamed(
          new Blob([buf], { type: guessMime(suggestedName) }),
          suggestedName
        );
      }
      const ext = getExtension(suggestedName);
      const path = await invoke('pick_save_path', {
        suggestedName: suggestedName || 'download',
        ext: ext,
      });
      if (!path) return null;
      await invoke('write_file_bytes', toIpcBinaryPayload(buf), {
        headers: { 'x-path': encodeURIComponent(path) },
      });
      return path;
    } catch (err) {
      alert('Save failed: ' + (err && err.message ? err.message : err));
      return null;
    }
  }

  async function handleAnchorDownload(href, name) {
    try {
      const resp = await fetch(href);
      const blob = await resp.blob();
      if (blob.size >= STREAM_THRESHOLD || detectedPlatform === 'android') {
        await saveBlobStreamed(blob, name);
      } else {
        await saveBytes(name, blob.arrayBuffer());
      }
    } catch (err) {
      alert('Save failed: ' + (err && err.message ? err.message : err));
    }
  }

  const origAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    const dl = this.getAttribute('download') || this.download;
    const href = this.href || '';
    if (dl && (href.startsWith('blob:') || href.startsWith('data:'))) {
      const name = typeof dl === 'string' && dl.length > 0 ? dl : 'download';
      handleAnchorDownload(href, name);
      return;
    }
    return origAnchorClick.apply(this, arguments);
  };

  document.addEventListener(
    'click',
    function (e) {
      const anchor =
        e.target && typeof e.target.closest === 'function'
          ? e.target.closest('a[download]')
          : null;
      if (!anchor) return;
      const href = anchor.href || '';
      if (!href.startsWith('blob:') && !href.startsWith('data:')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const name = anchor.getAttribute('download') || anchor.download || 'download';
      handleAnchorDownload(href, name);
    },
    true
  );

  // 6. GPU Hardware Diagnostics
  function getGpuInfo() {
    let vendor = 'Unknown';
    let renderer = 'Unknown';
    let isWebGL2 = false;
    let maxTextureSize = 0;

    try {
      const canvas = document.createElement('canvas');
      const gl =
        canvas.getContext('webgl2', { powerPreference: 'high-performance' }) ||
        canvas.getContext('webgl', { powerPreference: 'high-performance' });
      if (gl) {
        isWebGL2 =
          typeof WebGL2RenderingContext !== 'undefined' &&
          gl instanceof WebGL2RenderingContext;
        maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0;
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        if (ext) {
          vendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) || vendor;
          renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || renderer;
        } else {
          vendor = gl.getParameter(gl.VENDOR) || vendor;
          renderer = gl.getParameter(gl.RENDERER) || renderer;
        }
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      }
    } catch (_) {}

    const isSoftwareFallback =
      /swiftshader|basic render|llvmpipe|software/i.test(renderer);

    return {
      vendor: vendor,
      renderer: renderer,
      isWebGL2: isWebGL2,
      maxTextureSize: maxTextureSize,
      hasWebGPU: typeof navigator !== 'undefined' && !!navigator.gpu,
      hasVideoEncoder: typeof VideoEncoder !== 'undefined',
      hasVideoDecoder: typeof VideoDecoder !== 'undefined',
      isSoftwareFallback: isSoftwareFallback,
    };
  }

  // 7. Android Back Button contract & Keep-Screen-On
  window.__OFTS_HANDLE_BACK__ = function () {
    const ev = new CustomEvent('oftsback', { cancelable: true });
    const notCancelled = window.dispatchEvent(ev);
    if (notCancelled) {
      if (
        window.Modal &&
        typeof window.Modal.isOpen === 'function' &&
        window.Modal.isOpen() &&
        typeof window.Modal.close === 'function'
      ) {
        window.Modal.close(false);
        return;
      }
      if (
        window.AndroidNative &&
        typeof window.AndroidNative.exitApp === 'function'
      ) {
        window.AndroidNative.exitApp();
      }
    }
  };

  function keepScreenOn(enabled) {
    if (
      window.AndroidNative &&
      typeof window.AndroidNative.keepScreenOn === 'function'
    ) {
      try {
        window.AndroidNative.keepScreenOn(!!enabled);
      } catch (_) {}
    }
  }

  // 8. Open .ofts file from native path
  function waitForFishDatabase(timeoutMs) {
    return new Promise(function (resolve, reject) {
      const start = Date.now();
      function check() {
        if (
          window.FishDatabase &&
          typeof window.FishDatabase.importOFTSPackage === 'function'
        ) {
          resolve(window.FishDatabase);
          return;
        }
        if (Date.now() - start >= timeoutMs) {
          reject(new Error('Timed out waiting for FishDatabase.importOFTSPackage'));
          return;
        }
        setTimeout(check, 100);
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', check, { once: true });
      } else {
        check();
      }
    });
  }

  async function openOftsPath(filePath) {
    if (!filePath) return;
    try {
      const db = await waitForFishDatabase(15000);
      const buf = await invoke('read_file_bytes', { path: filePath });
      const parts = filePath.split(/[\\/]/);
      const basename = parts[parts.length - 1] || 'project.ofts';
      const file = new File([buf], basename, { type: 'application/octet-stream' });
      const proj = await db.importOFTSPackage(file);
      if (proj && proj.id) {
        saveProjectPathForId(proj.id, filePath);
        const targetPage =
          typeof window.resolveTargetEditorPage === 'function'
            ? window.resolveTargetEditorPage()
            : 'desktop.html';
        window.location.href =
          targetPage + '?id=' + encodeURIComponent(proj.id) + '&template=1';
      }
    } catch (err) {
      console.error('[OFTSNative] Failed to open .ofts file:', err);
      alert('Failed to open .ofts file: ' + (err && err.message ? err.message : err));
    }
  }

  invoke('take_launch_file')
    .then(function (p) {
      if (p) openOftsPath(p);
    })
    .catch(function () {});

  function handleDeepLink(uri, allowInPlace) {
    if (!uri || typeof uri !== 'string') return;
    window.__OFT_DEEPLINK__ = uri;
    try {
      sessionStorage.setItem('oft_pending_import_id', uri);
    } catch (_) {}
    if (typeof window.onNativeDeepLinkReceived === 'function') {
      try {
        window.onNativeDeepLinkReceived(uri);
        return;
      } catch (_) {}
    }
    const isIndex =
      window.location.pathname.endsWith('/index.html') ||
      window.location.pathname === '/';
    if (allowInPlace && isIndex) {
      // Running in <head> before main.js initializes: __OFT_DEEPLINK__ + sessionStorage are already set
      return;
    }
    if (window.location.search.indexOf('deeplink=') === -1) {
      window.location.href = 'index.html?deeplink=' + encodeURIComponent(uri);
    }
  }

  // Synchronously claim any cold-start Android deep-link right when Studio loads after updater
  if (
    window.AndroidNative &&
    typeof window.AndroidNative.takePendingDeepLink === 'function'
  ) {
    try {
      const androidUri = window.AndroidNative.takePendingDeepLink();
      if (androidUri) handleDeepLink(androidUri, true);
    } catch (_) {}
  }

  invoke('take_launch_deeplink')
    .then(function (uri) {
      if (uri) handleDeepLink(uri, false);
    })
    .catch(function () {});

  listen('ofts-open-file', function (event) {
    if (event && event.payload) {
      openOftsPath(event.payload);
    }
  });

  listen('ofts-open-deeplink', function (event) {
    if (event && event.payload) {
      handleDeepLink(event.payload);
    }
  });

  // 9. Native Disk Storage Adapter (bypasses WebView IndexedDB sandbox)
  const nativeStorage = {
    getConfig: function () {
      return invoke('get_storage_config');
    },
    pickFolder: function (initialDir) {
      return invoke('pick_storage_folder', { initialDir: initialDir || null });
    },
    setDir: function (path) {
      return invoke('set_storage_dir', { path: path });
    },
    getStats: async function () {
      const stats = await invoke('storage_get_stats');
      if (
        stats &&
        (!stats.disk_total_bytes || stats.disk_total_bytes === 0) &&
        window.AndroidNative &&
        typeof window.AndroidNative.getDiskSpaceJson === 'function'
      ) {
        try {
          const parsed = JSON.parse(
            window.AndroidNative.getDiskSpaceJson(stats.storage_dir || '')
          );
          if (parsed && parsed.total > 0) {
            stats.disk_free_bytes = parsed.free || 0;
            stats.disk_total_bytes = parsed.total || 0;
          }
        } catch (_) {}
      }
      return stats;
    },
    mediaUrl: function (id) {
      return '/local-media/' + encodeURIComponent(String(id));
    },
    getSettings: async function () {
      const raw = await invoke('storage_get_settings');
      return raw ? JSON.parse(raw) : null;
    },
    saveSettings: function (obj) {
      return invoke('storage_save_settings', { json: JSON.stringify(obj) });
    },
    listProjects: async function () {
      const arr = await invoke('storage_list_projects');
      return (arr || [])
        .map(function (s) {
          try {
            return JSON.parse(s);
          } catch (_) {
            return null;
          }
        })
        .filter(Boolean);
    },
    getProject: async function (id) {
      const raw = await invoke('storage_get_project', { id: String(id) });
      return raw ? JSON.parse(raw) : null;
    },
    saveProject: function (project) {
      return invoke('storage_save_project', {
        id: String(project.id),
        json: JSON.stringify(project),
      });
    },
    deleteProject: function (id) {
      return invoke('storage_delete_project', { id: String(id) });
    },
    clearProjects: function () {
      return invoke('storage_clear_projects');
    },
    saveMedia: async function (item) {
      if (!item || !item.id) return item;
      const id = String(item.id);
      let binBytes = null;
      if (item.blob instanceof Blob && item.blob.size > 0) {
        binBytes = new Uint8Array(await item.blob.arrayBuffer());
      } else if (item.buffer instanceof ArrayBuffer) {
        binBytes = new Uint8Array(item.buffer);
      } else if (ArrayBuffer.isView(item.buffer)) {
        binBytes = new Uint8Array(item.buffer.buffer, item.buffer.byteOffset, item.buffer.byteLength);
      } else if (typeof item.dataUrl === 'string' && item.dataUrl.startsWith('data:')) {
        const resp = await fetch(item.dataUrl);
        binBytes = new Uint8Array(await resp.arrayBuffer());
      }
      if (binBytes && binBytes.byteLength > 0) {
        await invoke('storage_write_media_bin', toIpcBinaryPayload(binBytes), {
          headers: { 'x-id': id, 'x-kind': 'bin' },
        });
      }
      if (item.thumbBlob instanceof Blob && item.thumbBlob.size > 0) {
        const tb = new Uint8Array(await item.thumbBlob.arrayBuffer());
        await invoke('storage_write_media_bin', toIpcBinaryPayload(tb), {
          headers: { 'x-id': id, 'x-kind': 'thumb' },
        });
      }
      const meta = Object.assign({}, item);
      delete meta.blob;
      delete meta.buffer;
      delete meta.thumbBlob;
      delete meta.thumbBuffer;
      if (binBytes && binBytes.byteLength > 0) {
        meta.size = binBytes.byteLength;
        meta.dataUrl = nativeStorage.mediaUrl(id);
        meta._storedOnDisk = true;
      }
      await invoke('storage_save_media_meta', { id: id, json: JSON.stringify(meta) });
      return item;
    },
    getMedia: async function (id, hydrateBlob) {
      const raw = await invoke('storage_get_media_meta', { id: String(id) });
      if (!raw) return null;
      const meta = JSON.parse(raw);
      if (meta._storedOnDisk) {
        meta.dataUrl = nativeStorage.mediaUrl(meta.id);
        if (hydrateBlob !== false) {
          try {
            const buf = await invoke('storage_read_media_bin', { id: String(meta.id), kind: 'bin' });
            meta.blob = new Blob([buf], { type: meta.mimeType || 'application/octet-stream' });
          } catch (_) {}
        }
      }
      return meta;
    },
    listMedia: async function (projectId, hydrateBlobs) {
      const arr = await invoke('storage_list_media_meta', {
        projectId: projectId ? String(projectId) : null,
      });
      const items = (arr || [])
        .map(function (s) {
          try {
            return JSON.parse(s);
          } catch (_) {
            return null;
          }
        })
        .filter(Boolean);
      for (let i = 0; i < items.length; i++) {
        const m = items[i];
        if (m._storedOnDisk) {
          m.dataUrl = nativeStorage.mediaUrl(m.id);
          if (hydrateBlobs) {
            try {
              const buf = await invoke('storage_read_media_bin', { id: String(m.id), kind: 'bin' });
              m.blob = new Blob([buf], { type: m.mimeType || 'application/octet-stream' });
            } catch (_) {}
          }
        }
      }
      return items;
    },
    deleteMedia: function (id) {
      return invoke('storage_delete_media', { id: String(id) });
    },
    deleteProjectMedia: function (projectId) {
      return invoke('storage_delete_project_media', { projectId: String(projectId) });
    },
    clearAllMedia: function () {
      return invoke('storage_clear_all_media');
    },
  };

  // 10. Native FFmpeg Bridge (Windows: native ffmpeg.exe; Android: ffmpeg-kit-min-gpl JNI)
  let ffmpegLogger = null;
  let ffmpegProgress = null;

  const nativeFFmpeg = {
    isNative: true,
    isLoaded: function () {
      return true;
    },
    setLogger: function (fn) {
      ffmpegLogger = typeof fn === 'function' ? fn : null;
    },
    setProgress: function (fn) {
      ffmpegProgress = typeof fn === 'function' ? fn : null;
    },
    FS: async function (op, name, data) {
      if (op === 'writeFile') {
        const u8 =
          data instanceof Uint8Array
            ? data
            : data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength || data.length);
        await invoke('ffmpeg_write_file', toIpcBinaryPayload(u8), {
          headers: { 'x-name': encodeURIComponent(String(name)) },
        });
        return;
      }
      if (op === 'readFile') {
        const buf = await invoke('ffmpeg_read_file', { name: String(name) });
        return new Uint8Array(buf);
      }
      if (op === 'unlink') {
        await invoke('ffmpeg_unlink', { name: String(name) });
        return;
      }
      throw new Error('Unsupported native FFmpeg FS op: ' + op);
    },
    run: async function () {
      const args = Array.prototype.slice.call(arguments).map(String);
      if (ffmpegProgress) {
        try { ffmpegProgress({ ratio: 0.25 }); } catch (_) {}
      }
      if (
        detectedPlatform === 'android' &&
        window.AndroidNative &&
        typeof window.AndroidNative.runFFmpeg === 'function'
      ) {
        const workDir = await invoke('ffmpeg_get_work_dir');
        const raw = await new Promise(function (resolve) {
          setTimeout(function () {
            resolve(window.AndroidNative.runFFmpeg(workDir, JSON.stringify(args)));
          }, 0);
        });
        const parsed = JSON.parse(raw || '{}');
        if (!parsed.ok) {
          throw new Error(parsed.error || 'Android native FFmpeg failed');
        }
      } else {
        const logOut = await invoke('ffmpeg_run_desktop', { args: args });
        if (ffmpegLogger && logOut) {
          try { ffmpegLogger({ message: logOut }); } catch (_) {}
        }
      }
      if (ffmpegProgress) {
        try { ffmpegProgress({ ratio: 1 }); } catch (_) {}
      }
    },
  };

  // 10b. Native Preview Disk Cache (stores compressed cold frames in app_cache_dir/preview-cache)
  const nativePreviewCache = {
    write: async function (key, bytesOrBlob) {
      let u8;
      if (bytesOrBlob instanceof Blob) {
        u8 = new Uint8Array(await bytesOrBlob.arrayBuffer());
      } else if (bytesOrBlob instanceof Uint8Array) {
        u8 = bytesOrBlob;
      } else if (bytesOrBlob instanceof ArrayBuffer) {
        u8 = new Uint8Array(bytesOrBlob);
      } else {
        return;
      }
      await invoke('preview_cache_write', toIpcBinaryPayload(u8), {
        headers: { 'x-key': String(key) },
      });
    },
    url: function (key) {
      return '/preview-cache/' + encodeURIComponent(String(key));
    },
    remove: function (key) {
      return invoke('preview_cache_delete', { key: String(key) }).catch(function () {});
    },
    clear: function () {
      return invoke('preview_cache_clear').catch(function () {});
    },
  };

  // 11. Expose window.OFTSNative v1 contract (zero DOM observers, zero monkey-patching)
  window.OFTSNative = {
    isNative: true,
    storage: nativeStorage,
    ffmpeg: nativeFFmpeg,
    previewCache: nativePreviewCache,
    get platform() {
      return detectedPlatform;
    },
    get currentProjectPath() {
      return currentProjectPath;
    },
    set currentProjectPath(p) {
      currentProjectPath = p || null;
    },
    getProjectPath: getProjectPathForId,
    setProjectPath: saveProjectPathForId,
    getInfo: function () {
      return invoke('app_info');
    },
    setWindowTitle: function (title) {
      if (detectedPlatform === 'android') return Promise.resolve();
      const full = title ? title + ' — FishTools Studio' : 'FishTools Studio';
      return invoke('set_window_title', { title: full }).catch(function () {});
    },
    readFile: function (path) {
      return invoke('read_file_bytes', { path: path });
    },
    writeFile: function (path, data) {
      const buf =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer || data);
      return invoke('write_file_bytes', toIpcBinaryPayload(buf), {
        headers: { 'x-path': encodeURIComponent(path) },
      });
    },
    pickOpenFile: function (ext) {
      return invoke('pick_open_path', { ext: ext || null });
    },
    pickSavePath: function (suggestedName, ext) {
      return invoke('pick_save_path', {
        suggestedName: suggestedName || 'download',
        ext: ext || null,
      });
    },
    openWriteStream: openWriteStream,
    openWriteStreamAtPath: openWriteStreamAtPath,
    saveBlobStreamed: saveBlobStreamed,
    saveBytes: saveBytes,
    openOftsPath: openOftsPath,
    getGpuInfo: getGpuInfo,
    keepScreenOn: keepScreenOn,
    fileUrl: function (path) {
      return convertFileSrc(path);
    },
    getCacheInfo: function () {
      return invoke('get_cache_info');
    },
    syncCache: function (force) {
      return invoke('prepare_studio', { force: !!force });
    },
    clearCache: function () {
      return invoke('clear_studio_cache');
    },
    openUpdater: function () {
      return invoke('open_updater_ui');
    },
  };
})();
