import React, { useState, useEffect, useRef } from 'react';
import {
  SafeAreaView,
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  Platform,
  StatusBar,
  Modal,
  TextInput,
  ActivityIndicator,
  Linking
} from 'react-native';
import { WebView } from 'react-native-webview';
import { GPU_INJECTED_BRIDGE_JS } from './bridge/GPUBridge';
import {
  DynamicUpdater,
  AppSourceMode,
  DEFAULT_OFFICIAL_URL,
  DEFAULT_DEV_URL,
  BUILTIN_STUDIO_VERSION
} from './updater/DynamicUpdater';

interface GpuTelemetry {
  vendor: string;
  renderer: string;
  webgl1: boolean;
  webgl2: boolean;
  webgpu: boolean;
  webcodecs: boolean;
  hardwareAccelerated: boolean;
  maxTextureSize: number;
}

export default function App() {
  const webViewRef = useRef<WebView>(null);
  const updater = DynamicUpdater.getInstance();

  const [mode, setMode] = useState<AppSourceMode>('OFFICIAL_CLOUD');
  const [customDevUrl, setCustomDevUrl] = useState<string>(DEFAULT_DEV_URL);
  const [currentUrl, setCurrentUrl] = useState<string>(DEFAULT_OFFICIAL_URL);
  const [localVersion, setLocalVersion] = useState<string>(BUILTIN_STUDIO_VERSION);
  const [remoteVersion, setRemoteVersion] = useState<string>(BUILTIN_STUDIO_VERSION);

  const [isCheckingUpdate, setIsCheckingUpdate] = useState<boolean>(false);
  const [updateAvailable, setUpdateAvailable] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>('Ready');

  const [settingsVisible, setSettingsVisible] = useState<boolean>(false);
  const [barCollapsed, setBarCollapsed] = useState<boolean>(false);

  const [gpuInfo, setGpuInfo] = useState<GpuTelemetry>({
    vendor: 'Probing...',
    renderer: Platform.OS === 'macos' ? 'Apple Metal Pipeline' : Platform.OS === 'windows' ? 'DirectX 12 Pipeline' : 'Vulkan/OpenGL Pipeline',
    webgl1: true,
    webgl2: true,
    webgpu: false,
    webcodecs: true,
    hardwareAccelerated: true,
    maxTextureSize: 8192
  });

  // Initialize updater preferences
  useEffect(() => {
    async function init() {
      const prefs = await updater.loadPreferences();
      setMode(prefs.mode);
      setCustomDevUrl(prefs.customDevUrl);
      if (prefs.otaVersion) {
        setLocalVersion(prefs.otaVersion);
      }
      const target = updater.getTargetUrl(prefs.mode, prefs.customDevUrl);
      setCurrentUrl(target);

      // Perform background update check
      checkForUpdates();
    }
    init();
  }, []);

  const checkForUpdates = async () => {
    setIsCheckingUpdate(true);
    setStatusMessage('Checking for updates...');
    try {
      const res = await updater.checkForUpdates();
      setRemoteVersion(res.latestVersion);
      setUpdateAvailable(res.hasUpdate);
      if (res.hasUpdate) {
        setStatusMessage(`New version v${res.latestVersion} available!`);
      } else {
        setStatusMessage(`v${res.currentVersion} (Up to date)`);
      }
    } catch (e: any) {
      setStatusMessage('Update check skipped (offline)');
    } finally {
      setIsCheckingUpdate(false);
    }
  };

  const handleApplyMode = async (newMode: AppSourceMode, newUrl: string = customDevUrl) => {
    setMode(newMode);
    await updater.setSourceMode(newMode);
    await updater.setCustomDevUrl(newUrl);
    const resolved = updater.getTargetUrl(newMode, newUrl);
    setCurrentUrl(resolved);
    setSettingsVisible(false);
  };

  const handleReload = () => {
    if (webViewRef.current) {
      webViewRef.current.reload();
    }
  };

  const handleWebViewMessage = (event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.source === 'FishToolsStudioWeb') {
        if (data.action === 'GPU_TELEMETRY' && data.payload) {
          setGpuInfo(data.payload);
        } else if (data.action === 'OPEN_URL' && data.payload.url) {
          Linking.openURL(data.payload.url);
        }
      }
    } catch (e) {
      // Non-JSON message from web
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0b0f19" />

      {/* Top Application Control Bar */}
      {!barCollapsed ? (
        <View style={styles.topBar}>
          <View style={styles.titleSection}>
            <Text style={styles.appTitle}>FishTools Studio</Text>
            <View style={styles.platformBadge}>
              <Text style={styles.platformBadgeText}>
                {Platform.OS === 'macos'
                  ? 'macOS Universal (Metal)'
                  : Platform.OS === 'windows'
                  ? 'Windows (DirectX 12)'
                  : 'Android (Vulkan/GLES)'}
              </Text>
            </View>
          </View>

          {/* Dynamic Update Pill */}
          <TouchableOpacity
            style={[styles.updatePill, updateAvailable && styles.updatePillAlert]}
            onPress={() => setSettingsVisible(true)}
            activeOpacity={0.8}
          >
            {isCheckingUpdate ? (
              <ActivityIndicator size="small" color="#38bdf8" style={{ marginRight: 6 }} />
            ) : (
              <View style={[styles.dot, updateAvailable ? styles.dotAlert : styles.dotActive]} />
            )}
            <Text style={styles.updatePillText}>{statusMessage}</Text>
          </TouchableOpacity>

          {/* GPU Telemetry Pill */}
          <TouchableOpacity
            style={styles.gpuPill}
            onPress={() => setSettingsVisible(true)}
            activeOpacity={0.8}
          >
            <View style={[styles.dot, gpuInfo.hardwareAccelerated ? styles.dotGpu : styles.dotAlert]} />
            <Text style={styles.gpuPillText} numberOfLines={1}>
              GPU: {gpuInfo.renderer.split('(')[0].trim()}
            </Text>
          </TouchableOpacity>

          {/* Quick Action Buttons */}
          <View style={styles.quickActions}>
            <TouchableOpacity style={styles.actionBtn} onPress={handleReload}>
              <Text style={styles.actionBtnText}>⟳ Reload</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionBtn} onPress={() => setSettingsVisible(true)}>
              <Text style={styles.actionBtnText}>⚙ Mode</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionBtn} onPress={() => setBarCollapsed(true)}>
              <Text style={styles.actionBtnText}>▲ Hide</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <TouchableOpacity
          style={styles.floatingShowBtn}
          onPress={() => setBarCollapsed(false)}
          activeOpacity={0.7}
        >
          <Text style={styles.floatingShowBtnText}>▼ Control Bar</Text>
        </TouchableOpacity>
      )}

      {/* Main Full GPU-Accelerated WebView */}
      <View style={styles.webContainer}>
        <WebView
          ref={webViewRef}
          source={{ uri: currentUrl }}
          style={styles.webview}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          allowsInlineMediaPlayback={true}
          mediaPlaybackRequiresUserAction={false}
          originWhitelist={['*']}
          injectedJavaScriptBeforeContentLoaded={GPU_INJECTED_BRIDGE_JS}
          onMessage={handleWebViewMessage}
          // Enable hardware acceleration across all platforms
          androidLayerType="hardware"
          androidHardwareAccelerationDisabled={false}
          mixedContentMode="always"
          allowFileAccess={true}
          allowFileAccessFromFileURLs={true}
          allowUniversalAccessFromFileURLs={true}
          cacheEnabled={true}
          renderError={(errName) => (
            <View style={styles.errorBox}>
              <Text style={styles.errorTitle}>Cannot load {currentUrl}</Text>
              <Text style={styles.errorDesc}>
                Make sure the network or local dev server is active.
              </Text>
              <TouchableOpacity
                style={styles.errorRetryBtn}
                onPress={() => handleApplyMode('OFFICIAL_CLOUD')}
              >
                <Text style={styles.errorRetryText}>Switch to Official Server</Text>
              </TouchableOpacity>
            </View>
          )}
        />
      </View>

      {/* Settings & Mode Switcher Modal */}
      <Modal
        visible={settingsVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setSettingsVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalHeader}>Dynamic Updates & GPU Settings</Text>

            {/* GPU Diagnostics Card */}
            <View style={styles.infoCard}>
              <Text style={styles.infoCardTitle}>GPU Acceleration Diagnostics</Text>
              <Text style={styles.infoRow}><Text style={styles.bold}>Hardware Accelerated:</Text> {gpuInfo.hardwareAccelerated ? 'YES (Active)' : 'NO'}</Text>
              <Text style={styles.infoRow}><Text style={styles.bold}>Renderer:</Text> {gpuInfo.renderer}</Text>
              <Text style={styles.infoRow}><Text style={styles.bold}>Vendor:</Text> {gpuInfo.vendor}</Text>
              <Text style={styles.infoRow}><Text style={styles.bold}>WebGL 2.0:</Text> {gpuInfo.webgl2 ? 'Supported' : 'Disabled'}</Text>
              <Text style={styles.infoRow}><Text style={styles.bold}>WebCodecs (HW Video):</Text> {gpuInfo.webcodecs ? 'Available' : 'Unavailable'}</Text>
              <Text style={styles.infoRow}><Text style={styles.bold}>Max Texture Size:</Text> {gpuInfo.maxTextureSize}px</Text>
            </View>

            {/* Source Mode Selectors */}
            <Text style={styles.sectionLabel}>Select Application Source Mode</Text>

            <TouchableOpacity
              style={[styles.modeOption, mode === 'OFFICIAL_CLOUD' && styles.modeOptionActive]}
              onPress={() => handleApplyMode('OFFICIAL_CLOUD')}
            >
              <Text style={styles.modeOptionTitle}>Official Cloud Live (Recommended)</Text>
              <Text style={styles.modeOptionDesc}>{DEFAULT_OFFICIAL_URL} — Always latest updates & WASM effects</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.modeOption, mode === 'LOCAL_DEV' && styles.modeOptionActive]}
              onPress={() => handleApplyMode('LOCAL_DEV')}
            >
              <Text style={styles.modeOptionTitle}>Local Studio Dev Server</Text>
              <Text style={styles.modeOptionDesc}>Connects to your local Studio dev server for live development</Text>
            </TouchableOpacity>

            {mode === 'LOCAL_DEV' && (
              <TextInput
                style={styles.urlInput}
                value={customDevUrl}
                onChangeText={setCustomDevUrl}
                placeholder="http://localhost:8080"
                placeholderTextColor="#64748b"
                autoCapitalize="none"
              />
            )}

            <TouchableOpacity
              style={[styles.modeOption, mode === 'EMBEDDED_LOCAL' && styles.modeOptionActive]}
              onPress={() => handleApplyMode('EMBEDDED_LOCAL')}
            >
              <Text style={styles.modeOptionTitle}>Embedded Local Bundle</Text>
              <Text style={styles.modeOptionDesc}>Offline standalone bundle synced directly from ../Studio</Text>
            </TouchableOpacity>

            {/* Actions */}
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.secondaryBtn} onPress={checkForUpdates}>
                <Text style={styles.secondaryBtnText}>Check Updates</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.primaryBtn} onPress={() => setSettingsVisible(false)}>
                <Text style={styles.primaryBtnText}>Close</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#070a13'
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#0f172a',
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8
  },
  titleSection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  appTitle: {
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: '700'
  },
  platformBadge: {
    backgroundColor: '#1e293b',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6
  },
  platformBadgeText: {
    color: '#94a3b8',
    fontSize: 10,
    fontWeight: '600'
  },
  updatePill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e293b',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 14
  },
  updatePillAlert: {
    backgroundColor: '#3b2505',
    borderColor: '#d97706',
    borderWidth: 1
  },
  updatePillText: {
    color: '#e2e8f0',
    fontSize: 11,
    fontWeight: '500'
  },
  gpuPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0c221f',
    borderColor: '#059669',
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 14,
    maxWidth: 220
  },
  gpuPillText: {
    color: '#34d399',
    fontSize: 11,
    fontWeight: '500'
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 6
  },
  dotActive: {
    backgroundColor: '#38bdf8'
  },
  dotAlert: {
    backgroundColor: '#f59e0b'
  },
  dotGpu: {
    backgroundColor: '#10b981'
  },
  quickActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6
  },
  actionBtn: {
    backgroundColor: '#1e293b',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6
  },
  actionBtnText: {
    color: '#cbd5e1',
    fontSize: 11,
    fontWeight: '500'
  },
  floatingShowBtn: {
    position: 'absolute',
    top: 8,
    right: 12,
    zIndex: 99,
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#334155'
  },
  floatingShowBtnText: {
    color: '#94a3b8',
    fontSize: 10
  },
  webContainer: {
    flex: 1,
    backgroundColor: '#000000'
  },
  webview: {
    flex: 1,
    backgroundColor: '#000000'
  },
  errorBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#070a13'
  },
  errorTitle: {
    color: '#f87171',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 8
  },
  errorDesc: {
    color: '#94a3b8',
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 16
  },
  errorRetryBtn: {
    backgroundColor: '#2563eb',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 6
  },
  errorRetryText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600'
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20
  },
  modalCard: {
    width: '100%',
    maxWidth: 520,
    backgroundColor: '#0f172a',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1e293b',
    padding: 20
  },
  modalHeader: {
    color: '#f8fafc',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 14
  },
  infoCard: {
    backgroundColor: '#090e1a',
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#1e293b',
    marginBottom: 14
  },
  infoCardTitle: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5
  },
  infoRow: {
    color: '#cbd5e1',
    fontSize: 11,
    lineHeight: 18
  },
  bold: {
    color: '#f1f5f9',
    fontWeight: '600'
  },
  sectionLabel: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 8,
    textTransform: 'uppercase'
  },
  modeOption: {
    backgroundColor: '#1e293b',
    padding: 12,
    borderRadius: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: 'transparent'
  },
  modeOptionActive: {
    borderColor: '#38bdf8',
    backgroundColor: '#172554'
  },
  modeOptionTitle: {
    color: '#f8fafc',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 2
  },
  modeOptionDesc: {
    color: '#94a3b8',
    fontSize: 11
  },
  urlInput: {
    backgroundColor: '#0b1120',
    borderWidth: 1,
    borderColor: '#334155',
    color: '#f8fafc',
    fontSize: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    marginBottom: 10
  },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 14,
    gap: 8
  },
  secondaryBtn: {
    backgroundColor: '#1e293b',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6
  },
  secondaryBtnText: {
    color: '#cbd5e1',
    fontSize: 12,
    fontWeight: '600'
  },
  primaryBtn: {
    backgroundColor: '#2563eb',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 6
  },
  primaryBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '600'
  }
});
