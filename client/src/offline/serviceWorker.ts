// Registers public/sw.js, which keeps the app shell (HTML, JS/CSS, the SQLite wasm,
// exercise animations, photos) available when the laptop server is unreachable.
// Only in production builds, only in a secure context (browsers allow service workers on
// https:// and http://localhost — not on http://192.168.x.x), and not inside the Android
// app, which bundles the shell itself.
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { isNative } from '../native/platform';

export function registerServiceWorker() {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  if (isNative()) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => console.warn('[offline] service worker not registered', err));
    // The first visit loads its JS/CSS/wasm before the worker is in control, so hand it
    // the list of what this page already loaded to cache.
    navigator.serviceWorker.ready.then(reg => {
      const urls = new Set<string>([new URL(wasmUrl, location.href).pathname]);
      for (const e of performance.getEntriesByType('resource')) {
        const u = new URL(e.name);
        if (u.origin === location.origin && /^\/(assets|exercises)\//.test(u.pathname)) urls.add(u.pathname);
      }
      reg.active?.postMessage({ type: 'precache', urls: [...urls] });
    }).catch(() => {});
  });
}
