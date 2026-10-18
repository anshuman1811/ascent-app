import { useState } from 'react';
import ServerImage from './ServerImage';

interface Props {
  gifUrl: string;
  name: string;
  className?: string;
}

// gifUrl points to frame 0 (e.g. ".../Barbell_Squat/0.jpg").
// We derive frame 1 by replacing the trailing /0.jpg with /1.jpg.
// CSS animation alternates between the two frames at ~1.4s per cycle.
export default function ExerciseAnimation({ gifUrl, name, className = '' }: Props) {
  const [errored, setErrored] = useState(false);

  if (!gifUrl || errored) return null;

  const frame0 = gifUrl;
  const frame1 = gifUrl.replace(/\/0\.jpg$/, '/1.jpg');
  const isTwoFrame = frame1 !== frame0;

  if (!isTwoFrame) {
    // The bundled GIFs come from Gym visual, whose permission requires this credit.
    const isGymVisual = /^\/exercises\/[^/]+\.gif$/.test(gifUrl);
    const img = (
      <ServerImage
        src={gifUrl}
        alt={name}
        className={`object-contain ${className}`}
        onAllFailed={() => setErrored(true)}
      />
    );
    if (!isGymVisual) return img;
    return (
      <figure className="relative">
        {img}
        <figcaption className="absolute bottom-0 right-1 text-[8px] leading-tight text-gray-500/80 pointer-events-none">
          © Gym visual — gymvisual.com
        </figcaption>
      </figure>
    );
  }

  return (
    <div
      className={`relative overflow-hidden ${className}`}
      style={{ aspectRatio: '4/3' }}
    >
      <ServerImage
        src={frame0}
        alt={name}
        className="absolute inset-0 w-full h-full object-contain"
        style={{ animation: 'exanim-f0 1.4s steps(1, end) infinite' }}
        onAllFailed={() => setErrored(true)}
      />
      <ServerImage
        src={frame1}
        alt=""
        aria-hidden
        className="absolute inset-0 w-full h-full object-contain"
        style={{ animation: 'exanim-f1 1.4s steps(1, end) infinite' }}
        onAllFailed={() => setErrored(true)}
      />
      <style>{`
        @keyframes exanim-f0 {
          0%, 49.9% { opacity: 1; }
          50%, 100%  { opacity: 0; }
        }
        @keyframes exanim-f1 {
          0%, 49.9% { opacity: 0; }
          50%, 100%  { opacity: 1; }
        }
      `}</style>
    </div>
  );
}
