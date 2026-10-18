// All API traffic goes through here. Online with nothing waiting to sync, requests go
// straight to the server as they always have. Offline (or while queued changes are still
// being pushed) they are answered by the device's local replica, running the server's own
// route handlers — see client/src/offline/engine.ts.
import { request, upload } from '../offline/engine';

export const api = {
  get:    <T>(path: string)                   => request<T>('GET', path),
  post:   <T>(path: string, body: unknown)    => request<T>('POST', path, body),
  put:    <T>(path: string, body: unknown)    => request<T>('PUT', path, body),
  patch:  <T>(path: string, body: unknown)    => request<T>('PATCH', path, body),
  delete: <T>(path: string)                   => request<T>('DELETE', path),
  upload: <T>(path: string, fd: FormData)     => upload<T>(path, fd),
};
