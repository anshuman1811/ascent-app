// Where the Ascent server lives. In the browser the app is served by the server itself,
// so requests stay same-origin (base ''). In the Android app the server is on the home
// network and its address is set by the user, so every request and asset URL goes
// through these helpers.
const KEY = 'ascent.serverUrl';

export function getServerBase(): string {
  return (localStorage.getItem(KEY) ?? '').replace(/\/+$/, '');
}

export function setServerBase(url: string | null) {
  const clean = (url ?? '').trim().replace(/\/+$/, '');
  if (clean) localStorage.setItem(KEY, clean);
  else localStorage.removeItem(KEY);
}

// `/workouts/1` → `<base>/api/workouts/1`
export const apiUrl = (path: string) => `${getServerBase()}/api${path}`;

// Server-relative asset paths (`/uploads/…`, `/exercises/…`) → absolute on the server.
export const assetUrl = (path: string | null | undefined) =>
  path && path.startsWith('/') ? `${getServerBase()}${path}` : path ?? '';
