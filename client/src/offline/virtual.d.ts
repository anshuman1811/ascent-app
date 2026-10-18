/// <reference types="vite/client" />

declare module 'virtual:ascent-server-routes' {
  export const mounts: { path: string; module: string }[];
  export const factories: Record<string, (require: (id: string) => unknown, module: { exports: any }, exports: any, __dirname: string, __filename: string) => void>;
}
