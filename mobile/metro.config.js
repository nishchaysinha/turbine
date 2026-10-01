const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Expo web has no native WebView: swap in an iframe-based shim so the
// companion (including its WebRTC engine) runs in a browser.
const defaultResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web' && moduleName === 'react-native-webview') {
    return { type: 'sourceFile', filePath: path.join(__dirname, 'src/web/WebViewShim.tsx') };
  }
  return (defaultResolve || context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
