const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('metro-config').MetroConfig}
 */
const config = {
  resolver: {
    assetExts: ['html', 'css', 'js', 'json', 'wasm', 'png', 'jpg', 'jpeg', 'svg', 'mp4', 'obj', 'mtl', 'bin', 'webp']
  }
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
