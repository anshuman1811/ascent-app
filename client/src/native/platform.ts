import { Capacitor } from '@capacitor/core';

// True inside the Android app (Capacitor WebView), false in a normal browser.
export const isNative = () => Capacitor.isNativePlatform();

export const DEFAULT_PORT = 3001;

// Turn what someone types ("192.168.1.20", "192.168.1.20:3001/", "http://nas.local:3001")
// into a base URL. Bare hosts get http:// and, if no port is given, Ascent's default port.
export function normalizeServerAddress(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  const hadScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  if (!hadScheme) s = `http://${s}`;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!hadScheme && !u.port) u.port = String(DEFAULT_PORT);
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

// GET <base>/api/health — resolves on success, throws a human-readable error otherwise.
export async function checkServer(base: string, timeoutMs = 6000): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/health`, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`The server answered with HTTP ${res.status}.`);
    const body = await res.json().catch(() => null);
    if (!body || body.ok !== true) throw new Error("That address answered, but it doesn't look like an Ascent server.");
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error('No answer within a few seconds. Check the address and that the phone is on the same Wi-Fi.');
    if (e instanceof TypeError) throw new Error("Couldn't reach that address. Check it, and that the phone is on the same Wi-Fi as the server.");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
