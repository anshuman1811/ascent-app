import type { CapacitorConfig } from '@capacitor/cli';

// Android app shell for Ascent. The web client is bundled into the APK (webDir) so the
// app opens with no network; the API and server-hosted images are reached at the
// address the user enters on first launch (see src/api/serverUrl.ts).
const config: CapacitorConfig = {
  appId: 'app.ascent.tracker',
  appName: 'Ascent',
  webDir: 'dist',
  backgroundColor: '#030712',
  server: {
    // Serve the bundled app from http://localhost rather than https://localhost. The home
    // server is plain HTTP on the LAN; from an https page the WebView treats every API call
    // and image as mixed content, and blocks <img> loads even with allowMixedContent.
    // http://localhost still counts as a secure context (IndexedDB, crypto.randomUUID, etc.).
    // Don't change this after release: localStorage/IndexedDB are tied to the origin.
    androidScheme: 'http',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 600,
      launchAutoHide: true,
      backgroundColor: '#030712',
      showSpinner: false,
    },
    // index.html doesn't use viewport-fit=cover, so Capacitor keeps the WebView clear of
    // the status/navigation bars and notch; the bars show the dark window background.
    SystemBars: {
      insetsHandling: 'native',
      style: 'DARK',
    },
  },
};

export default config;
