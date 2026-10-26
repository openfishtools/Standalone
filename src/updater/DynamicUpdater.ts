import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

export type AppSourceMode = 'OFFICIAL_CLOUD' | 'LOCAL_DEV' | 'EMBEDDED_LOCAL' | 'DYNAMIC_OTA';

export interface UpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  updateUrl?: string;
  changelog?: string;
}

export interface UpdaterState {
  currentMode: AppSourceMode;
  localVersion: string;
  remoteVersion: string;
  lastCheckedTime: number | null;
  customDevUrl: string;
  isChecking: boolean;
  isDownloading: boolean;
  downloadProgress: number; // 0 to 100
  statusMessage: string;
}

const STORAGE_KEYS = {
  SOURCE_MODE: '@FishTools:SourceMode',
  CUSTOM_DEV_URL: '@FishTools:CustomDevUrl',
  OTA_VERSION: '@FishTools:OtaVersion',
  LAST_KNOWN_VERSION: '@FishTools:LastKnownVersion'
};

export const DEFAULT_OFFICIAL_URL = 'https://studio.cutefish.my.id';
export const DEFAULT_OFFICIAL_VERSION_URL = 'https://studio.cutefish.my.id/version.json';
export const DEFAULT_DEV_URL = Platform.OS === 'android' ? 'http://10.0.2.2:8080' : 'http://localhost:8080';
export const BUILTIN_STUDIO_VERSION = '0.6.5';

export class DynamicUpdater {
  private static instance: DynamicUpdater;

  private constructor() {}

  public static getInstance(): DynamicUpdater {
    if (!DynamicUpdater.instance) {
      DynamicUpdater.instance = new DynamicUpdater();
    }
    return DynamicUpdater.instance;
  }

  /**
   * Loads saved preferences from AsyncStorage
   */
  public async loadPreferences(): Promise<{ mode: AppSourceMode; customDevUrl: string; otaVersion: string | null }> {
    try {
      const mode = (await AsyncStorage.getItem(STORAGE_KEYS.SOURCE_MODE)) as AppSourceMode || 'OFFICIAL_CLOUD';
      const customDevUrl = (await AsyncStorage.getItem(STORAGE_KEYS.CUSTOM_DEV_URL)) || DEFAULT_DEV_URL;
      const otaVersion = await AsyncStorage.getItem(STORAGE_KEYS.OTA_VERSION);
      return { mode, customDevUrl, otaVersion };
    } catch (e) {
      console.warn('[DynamicUpdater] Error loading preferences:', e);
      return { mode: 'OFFICIAL_CLOUD', customDevUrl: DEFAULT_DEV_URL, otaVersion: null };
    }
  }

  /**
   * Saves source mode preference
   */
  public async setSourceMode(mode: AppSourceMode): Promise<void> {
    await AsyncStorage.setItem(STORAGE_KEYS.SOURCE_MODE, mode);
  }

  /**
   * Saves custom local dev server URL
   */
  public async setCustomDevUrl(url: string): Promise<void> {
    await AsyncStorage.setItem(STORAGE_KEYS.CUSTOM_DEV_URL, url);
  }

  /**
   * Checks official Studio server or custom endpoint for dynamic updates
   */
  public async checkForUpdates(endpoint: string = DEFAULT_OFFICIAL_VERSION_URL): Promise<UpdateCheckResult> {
    const currentVersion = (await AsyncStorage.getItem(STORAGE_KEYS.OTA_VERSION)) || BUILTIN_STUDIO_VERSION;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const response = await fetch(`${endpoint}?t=${Date.now()}`, {
        headers: { 'Cache-Control': 'no-cache' },
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Server responded with ${response.status}`);
      }

      const data = await response.json();
      const latestVersion = data.version || BUILTIN_STUDIO_VERSION;

      await AsyncStorage.setItem(STORAGE_KEYS.LAST_KNOWN_VERSION, latestVersion);

      const hasUpdate = this.compareSemver(latestVersion, currentVersion) > 0;

      return {
        hasUpdate,
        currentVersion,
        latestVersion,
        updateUrl: data.updateUrl || DEFAULT_OFFICIAL_URL,
        changelog: data.changelog || `FishTools Studio v${latestVersion} update available.`
      };
    } catch (err: any) {
      console.warn('[DynamicUpdater] Failed to check for updates:', err.message);
      return {
        hasUpdate: false,
        currentVersion,
        latestVersion: currentVersion,
        changelog: 'Unable to reach update server (offline or unreachable).'
      };
    }
  }

  /**
   * Resolves the target WebView URL based on active mode
   */
  public getTargetUrl(mode: AppSourceMode, customDevUrl: string = DEFAULT_DEV_URL): string {
    switch (mode) {
      case 'OFFICIAL_CLOUD':
        return DEFAULT_OFFICIAL_URL;
      case 'LOCAL_DEV':
        return customDevUrl || DEFAULT_DEV_URL;
      case 'DYNAMIC_OTA':
      case 'EMBEDDED_LOCAL':
      default:
        // On Android, assets are loaded via file:///android_asset/
        // On macOS/Windows, loaded via file:// path or local bundle
        if (Platform.OS === 'android') {
          return 'file:///android_asset/studio/index.html';
        }
        return DEFAULT_OFFICIAL_URL;
    }
  }

  /**
   * Simple semver comparator: 1 if a > b, -1 if a < b, 0 if equal
   */
  private compareSemver(a: string, b: string): number {
    const pa = a.replace(/[^0-9.]/g, '').split('.').map(Number);
    const pb = b.replace(/[^0-9.]/g, '').split('.').map(Number);
    const len = Math.max(pa.length, pb.length);

    for (let i = 0; i < len; i++) {
      const na = pa[i] || 0;
      const nb = pb[i] || 0;
      if (na > nb) return 1;
      if (na < nb) return -1;
    }
    return 0;
  }
}
