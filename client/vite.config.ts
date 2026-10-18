import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.resolve(here, '../server/routes');

// Bundles the server's route handlers (server/routes/*.js, CommonJS) into the client so a
// device can run the exact same business logic against its local SQLite replica while
// offline (client/src/offline/localServer.ts). Each file becomes a factory
// `function (require, module, exports, __dirname, __filename) { …original source… }`; the client supplies a
// `require` that maps 'express' and '../db/index' to in-browser equivalents.
function serverRoutes(): Plugin {
  const VIRTUAL = 'virtual:ascent-server-routes';
  const RESOLVED = '\0' + VIRTUAL;
  return {
    name: 'ascent-server-routes',
    resolveId(id) { return id === VIRTUAL ? RESOLVED : undefined; },
    load(id) {
      if (id !== RESOLVED) return;
      const mountsFile = path.join(ROUTES_DIR, 'mounts.js');
      this.addWatchFile(mountsFile);
      const req = createRequire(import.meta.url);
      delete req.cache[mountsFile];
      const mounts: { path: string; module: string; offline?: boolean }[] =
        req(mountsFile).filter((m: { offline?: boolean }) => m.offline !== false);
      let code = `export const mounts = ${JSON.stringify(mounts.map(m => ({ path: m.path, module: m.module })))};\n`;
      code += 'export const factories = {\n';
      for (const m of mounts) {
        const file = path.join(ROUTES_DIR, `${m.module}.js`);
        this.addWatchFile(file);
        code += `${JSON.stringify(m.module)}: function (require, module, exports, __dirname, __filename) {\n${fs.readFileSync(file, 'utf8')}\n},\n`;
      }
      return code + '};\n';
    },
  };
}

export default defineConfig({
  plugins: [react(), serverRoutes()],
  server: {
    port: 5173,
    proxy: {
      '/api':     { target: process.env.ASCENT_API || 'http://localhost:3001', changeOrigin: true },
      '/uploads': { target: process.env.ASCENT_API || 'http://localhost:3001', changeOrigin: true },
    },
  },
  preview: { port: 3000 },
});
