// Small sync indicator: a round button above the feedback button, with a panel for details.
//   cloud-check  online, everything synced      cloud-upload  changes waiting to sync
//   cloud-off    offline (working locally)      alert         sync error / conflicts
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Cloud, CloudOff, CloudUpload, AlertTriangle, RefreshCw, X } from 'lucide-react';
import { getSyncState, subscribeSync, syncNow, dismissConflicts, type SyncConflict } from './engine';

function ago(ms: number | null) {
  if (!ms) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

const LABEL: Record<string, string> = {
  meals: 'meal', meal_items: 'meal item', foods: 'food', set_logs: 'set', workout_sessions: 'workout',
  session_exercises: 'workout exercise', routines: 'routine', routine_exercises: 'routine exercise',
  workout_regimes: 'regime', user_profiles: 'profile', users: 'profile', weight_log: 'weight entry',
  exercises: 'exercise', bug_reports: 'feedback', images: 'photo', food_ingredients: 'ingredient',
};

function show(v: unknown) {
  if (v === null || v === undefined || v === '') return '—';
  const s = String(v);
  return s.length > 40 ? s.slice(0, 40) + '…' : s;
}

function ConflictRow({ c }: { c: SyncConflict }) {
  if (c.kind === 'field') {
    const what = `${LABEL[c.tbl ?? ''] ?? c.tbl} · ${(c.col ?? '').replace(/_/g, ' ')}`;
    return (
      <span>
        <span className="text-gray-200">{what}</span>: a newer edit{c.winner_device_name ? ` from ${c.winner_device_name}` : ''} was kept
        (<span className="text-white">{show(c.kept_value)}</span>); this device’s offline value
        (<span className="line-through">{show(c.discarded_value)}</span>) was not applied.
      </span>
    );
  }
  return <span>{c.detail}</span>;
}

export default function SyncStatus() {
  const s = useSyncExternalStore(subscribeSync, getSyncState);
  const [open, setOpen] = useState(false);
  const [, force] = useState(0);
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => force(x => x + 1), 10_000);
    return () => clearInterval(t);
  }, [open]);

  if (s.phase === 'unsupported' && !s.lastError) return null;

  const problems = s.conflicts.length + (s.lastError ? 1 : 0);
  let Icon = Cloud;
  let tone = 'text-gray-500 border-gray-700';
  let title = 'Synced';
  if (!s.online) { Icon = CloudOff; tone = 'text-amber-400 border-amber-500/40'; title = 'Offline — changes are saved on this device'; }
  else if (s.pending) { Icon = CloudUpload; tone = 'text-sky-400 border-sky-500/40'; title = 'Syncing changes'; }
  if (problems) { Icon = AlertTriangle; tone = 'text-rose-400 border-rose-500/40'; title = 'Sync needs attention'; }

  return (
    <>
      <button
        onClick={() => setOpen(o => !o)}
        title={title}
        aria-label={title}
        className={`fixed bottom-[8.5rem] right-4 z-50 lg:bottom-16 flex items-center gap-1 h-8 min-w-8 px-2 justify-center rounded-full bg-gray-800/90 border shadow-lg text-xs font-medium transition-colors hover:text-white ${tone}`}
      >
        <Icon size={15} strokeWidth={1.9} className={s.syncing && s.online ? 'animate-pulse' : ''} />
        {s.pending > 0 && <span>{s.pending}</span>}
        {problems > 0 && !s.pending && <span>{problems}</span>}
      </button>

      {open && (
        <div className="fixed bottom-[11rem] right-4 z-50 lg:bottom-28 w-80 max-w-[calc(100vw-2rem)] rounded-xl bg-gray-900 border border-gray-700 shadow-2xl p-4 text-sm">
          <div className="flex items-center justify-between mb-3">
            <span className="font-semibold text-white">{s.online ? 'Online' : 'Offline'}</span>
            <button onClick={() => setOpen(false)} className="text-gray-500 hover:text-white" aria-label="Close"><X size={16} /></button>
          </div>
          <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-gray-400">
            <dt>Waiting to sync</dt><dd className="text-gray-200">{s.pending ? `${s.pending} change${s.pending === 1 ? '' : 's'}` : 'nothing'}</dd>
            <dt>Last synced</dt><dd className="text-gray-200">{ago(s.lastSyncAt)}</dd>
            <dt>Offline copy</dt>
            <dd className="text-gray-200">{s.phase === 'ready' ? 'on this device' : s.phase === 'no-replica' ? 'not downloaded yet' : s.phase === 'starting' ? 'loading…' : 'unavailable'}</dd>
          </dl>
          {!s.online && (
            <p className="mt-3 text-xs text-gray-500">Everything still works. Changes are kept on this device and sent to the server when it’s reachable again.</p>
          )}
          {s.lastError && <p className="mt-3 text-xs text-rose-400">{s.lastError}</p>}
          {s.conflicts.length > 0 && (
            <div className="mt-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-gray-300">Not applied ({s.conflicts.length})</span>
                <button onClick={() => dismissConflicts(s.conflicts.map(c => c.id)).catch(() => {})} className="text-xs text-gray-500 hover:text-white">Dismiss all</button>
              </div>
              <ul className="max-h-48 overflow-y-auto space-y-1.5 text-xs text-gray-400">
                {s.conflicts.map(c => <li key={c.id} className="border-l-2 border-rose-500/40 pl-2"><ConflictRow c={c} /></li>)}
              </ul>
            </div>
          )}
          <button
            onClick={() => void syncNow()}
            disabled={s.syncing}
            className="mt-4 w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-gray-300 hover:text-white disabled:opacity-50"
          >
            <RefreshCw size={13} className={s.syncing ? 'animate-spin' : ''} /> Sync now
          </button>
        </div>
      )}
    </>
  );
}
