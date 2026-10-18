import { useEffect, useState, type ImgHTMLAttributes } from 'react';
import { assetUrl } from '../../api/serverUrl';

// Where to try loading a server-relative image from, in order.
// - `/uploads/…` (user photos) only exist on the server.
// - `/exercises/…` ship inside the client bundle too, so the bundled copy is tried first
//   (works offline in the Android app); the server copy covers images added after the
//   app was built.
// In the browser the server base is '' so both resolve to the same URL.
export function imageSources(path: string | null | undefined): string[] {
  if (!path) return [];
  const server = assetUrl(path);
  if (path.startsWith('/exercises/') && server !== path) return [path, server];
  return [server];
}

interface Props extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  /** Server-relative path (`/uploads/…`, `/exercises/…`) or an absolute URL. */
  src: string | null | undefined;
  /** Called once every candidate URL has failed. */
  onAllFailed?: () => void;
}

export default function ServerImage({ src, onAllFailed, onError, ...rest }: Props) {
  const sources = imageSources(src);
  const [idx, setIdx] = useState(0);
  useEffect(() => setIdx(0), [src]);

  return (
    <img
      {...rest}
      src={sources[idx] ?? ''}
      onError={e => {
        if (idx + 1 < sources.length) setIdx(idx + 1);
        else { onAllFailed?.(); onError?.(e); }
      }}
    />
  );
}
