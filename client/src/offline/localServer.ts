// A tiny in-process "server": the real route modules from server/routes (bundled by the
// vite plugin in client/vite.config.ts) running on a minimal Express Router shim and the
// sql.js-backed LocalDb. dispatch() mirrors server/routes/sync.js#dispatch.
import { mounts, factories } from 'virtual:ascent-server-routes';
import { localDb } from './localDb';

type Handler = (req: any, res: any, next: (err?: unknown) => void) => unknown;
interface Layer { method: string; re: RegExp; keys: string[]; handlers: Handler[] }

function compilePath(p: string) {
  const keys: string[] = [];
  const src = p.replace(/[.+*?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, (_m, k) => { keys.push(k); return '([^/]+?)'; });
  return { re: new RegExp(`^${src === '/' ? '' : src}\\/?$`, 'i'), keys };
}

function Router() {
  const stack: Layer[] = [];
  const router: any = { stack };
  for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
    router[m] = (p: string, ...handlers: Handler[]) => {
      stack.push({ method: m.toUpperCase(), ...compilePath(p), handlers });
      return router;
    };
  }
  router.handle = (req: any, res: any, done: (err?: unknown) => void) => {
    const layers = stack.filter(l => l.method === req.method);
    let i = 0;
    const nextLayer = (err?: unknown): void => {
      if (err) return done(err);
      while (i < layers.length) {
        const layer = layers[i++];
        const match = layer.re.exec(req.path);
        if (!match) continue;
        req.params = Object.fromEntries(layer.keys.map((k, j) => [k, decodeURIComponent(match[j + 1])]));
        let h = 0;
        const nextHandler = (e?: unknown): void => {
          if (e === 'route') return nextLayer();
          if (e) return done(e);
          const fn = layer.handlers[h++];
          if (!fn) return nextLayer();
          try { fn(req, res, nextHandler); } catch (ex) { done(ex); }
        };
        return nextHandler();
      }
      done();
    };
    nextLayer();
  };
  return router;
}

const expressShim = Object.assign(() => { throw new Error('express() is not available offline'); }, { Router });

// Uploads offline: the engine hands the files over on req.files; the real multer isn't needed.
const multerShim = Object.assign(() => ({
  array: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  single: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}), { diskStorage: () => ({}), memoryStorage: () => ({}) });

const pathShim = {
  join: (...p: string[]) => p.join('/').replace(/\/+/g, '/'),
  extname: (p: string) => { const m = /\.[^./]*$/.exec(p); return m ? m[0] : ''; },
  basename: (p: string) => p.split('/').pop() ?? p,
  dirname: (p: string) => p.split('/').slice(0, -1).join('/') || '/',
};
const fsShim = {
  mkdirSync: () => undefined,
  existsSync: () => false,
  unlink: (_p: string, cb?: () => void) => cb?.(),
};

export function uuid(): string {
  // crypto.randomUUID needs a secure context; phones on plain http://192.168.x.x aren't one.
  if (typeof crypto.randomUUID === 'function' && window.isSecureContext) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function shimRequire(id: string): unknown {
  if (id === 'express') return expressShim;
  if (/\/db\/index$/.test(id)) return localDb;
  if (id === 'multer') return multerShim;
  if (id === 'path') return pathShim;
  if (id === 'fs') return fsShim;
  if (id === 'uuid') return { v4: uuid };
  throw new Error(`Module "${id}" is not available offline`);
}

const loaded: Record<string, any> = {};
function routerFor(name: string) {
  if (!loaded[name]) {
    const module = { exports: {} as any };
    factories[name](shimRequire, module, module.exports, '/server/routes', `/server/routes/${name}.js`);
    loaded[name] = module.exports;
  }
  return loaded[name];
}

export interface LocalResult { status: number; body: any }

export interface DispatchInput {
  method: string;
  path: string;
  body?: unknown;
  files?: { filename: string; originalname: string; mimetype: string }[];
}

export function dispatch({ method, path: fullPath, body, files }: DispatchInput): LocalResult {
  const [pathname, qs = ''] = fullPath.split('?');
  const mount = mounts.find(m => pathname === m.path || pathname.startsWith(m.path + '/'));
  if (!mount) return { status: 404, body: { error: 'This needs a connection to the server' } };
  const router = routerFor(mount.module);
  const sub = pathname.slice(mount.path.length) || '/';
  const req: any = {
    method: method.toUpperCase(), path: sub, url: sub + (qs ? `?${qs}` : ''), originalUrl: '/api' + fullPath,
    baseUrl: '', headers: {}, params: {}, files,
    query: Object.fromEntries(new URLSearchParams(qs)),
    body: body == null ? {} : JSON.parse(JSON.stringify(body)),
    get: () => undefined, header: () => undefined,
  };
  let result: LocalResult | null = null;
  let error: any = null;
  const res = {
    statusCode: 200,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { result = { status: this.statusCode, body: b === undefined ? null : JSON.parse(JSON.stringify(b)) }; return this; },
    send(b: unknown) { result = { status: this.statusCode, body: b ?? null }; return this; },
    end() { result ||= { status: this.statusCode, body: null }; return this; },
    set() { return this; }, setHeader() { /* noop */ }, type() { return this; },
  };
  router.handle(req, res, (err?: unknown) => { error = err ?? Object.assign(new Error('Not found'), { status: 404 }); });
  if (error) {
    if (error.status && error.status < 500) return { status: error.status, body: { error: error.message } };
    throw error;
  }
  if (!result) throw new Error(`Local handler for ${method} ${fullPath} did not respond`);
  return result;
}
