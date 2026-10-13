import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User } from '../types';
import { api } from '../api/client';

interface AppState {
  activeUserId: number | null;
  users: User[];
  setActiveUserId: (id: number) => void;
  setUsers: (users: User[]) => void;
  activeUser: () => User | undefined;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      activeUserId: null,
      users: [],
      setActiveUserId: (id) => set({ activeUserId: id }),
      // If the persisted activeUserId no longer exists (fresh DB, or that user was
      // removed), fall back to the first available user — or null pre-onboarding.
      setUsers: (users) => set(s => ({
        users,
        activeUserId: users.some(u => u.id === s.activeUserId) ? s.activeUserId : (users[0]?.id ?? null),
      })),
      activeUser: () => get().users.find(u => u.id === get().activeUserId),
    }),
    { name: 'fitness-app', partialize: (s) => ({ activeUserId: s.activeUserId }) }
  )
);

// Workout session timer store (not persisted to localStorage — the authoritative rest
// state lives in the DB, via workout_sessions.rest_started_at/rest_target_seconds, so it
// survives reloads and stays in sync across devices viewing the same session).
// Keyed by sessionId so two LiveWorkout panes (pair split-screen) can run
// independent rest timers in the same browser tab without colliding.
interface SessionTimer {
  userId: number | null;
  restRunning: boolean;
  restStartedAtMs: number | null;
  restTargetSeconds: number;
  elapsedSeconds: number;
  sessionStartTs: number | null;
}

const DEFAULT_TIMER: SessionTimer = {
  userId: null, restRunning: false, restStartedAtMs: null, restTargetSeconds: 0,
  elapsedSeconds: 0, sessionStartTs: null,
};

interface DerivedSessionTimer extends SessionTimer {
  restSecondsLeft: number;
  restOvertime: number;
}

interface WorkoutTimerState {
  sessions: Record<number, SessionTimer>;
  tick: number;
  getSession: (sessionId: number) => DerivedSessionTimer;
  setSession: (sessionId: number, userId: number) => void;
  clearSession: (sessionId: number) => void;
  startRest: (sessionId: number, seconds: number, sessionExerciseId?: number | null) => void;
  tickRest: (sessionId: number) => void;
  stopRest: (sessionId: number) => void;
  tickElapsed: (sessionId: number) => void;
  // Hydrates rest state from the server's workout_sessions row (poll/initial load) —
  // this is what makes a second device (or a reload) pick up an in-progress rest.
  syncRest: (sessionId: number, restStartedAt: string | null | undefined, restTargetSeconds: number | null | undefined) => void;
}

function deriveRest(s: SessionTimer): DerivedSessionTimer {
  if (!s.restRunning || s.restStartedAtMs === null) {
    return { ...s, restSecondsLeft: 0, restOvertime: 0 };
  }
  const elapsed = Math.floor((Date.now() - s.restStartedAtMs) / 1000);
  return {
    ...s,
    restSecondsLeft: Math.max(0, s.restTargetSeconds - elapsed),
    restOvertime: Math.max(0, elapsed - s.restTargetSeconds),
  };
}

export const useWorkoutStore = create<WorkoutTimerState>((set, get) => ({
  sessions: {},
  tick: 0,
  getSession: (sessionId) => deriveRest(get().sessions[sessionId] ?? DEFAULT_TIMER),
  setSession: (sessionId, userId) => set(s => ({
    sessions: { ...s.sessions, [sessionId]: { ...DEFAULT_TIMER, userId, sessionStartTs: Date.now() } },
  })),
  clearSession: (sessionId) => set(s => {
    const next = { ...s.sessions };
    delete next[sessionId];
    return { sessions: next };
  }),
  startRest: (sessionId, seconds, sessionExerciseId = null) => {
    set(s => ({
      sessions: {
        ...s.sessions,
        [sessionId]: { ...(s.sessions[sessionId] ?? DEFAULT_TIMER), restStartedAtMs: Date.now(), restTargetSeconds: seconds, restRunning: true },
      },
    }));
    api.put(`/workouts/${sessionId}/rest`, { restTargetSeconds: seconds, sessionExerciseId }).catch(() => {});
  },
  // No longer decrements state directly — just bumps `tick` so subscribers re-render and
  // re-derive restSecondsLeft/restOvertime off the wall clock (no drift, trivially resyncable).
  tickRest: () => set(s => ({ tick: s.tick + 1 })),
  stopRest: (sessionId) => {
    set(s => ({
      sessions: {
        ...s.sessions,
        [sessionId]: { ...(s.sessions[sessionId] ?? DEFAULT_TIMER), restRunning: false, restStartedAtMs: null, restTargetSeconds: 0 },
      },
    }));
    api.put(`/workouts/${sessionId}/rest`, { restTargetSeconds: null }).catch(() => {});
  },
  tickElapsed: (sessionId) => set(s => {
    const cur = s.sessions[sessionId];
    if (!cur) return s;
    return { sessions: { ...s.sessions, [sessionId]: { ...cur, elapsedSeconds: cur.elapsedSeconds + 1 } } };
  }),
  syncRest: (sessionId, restStartedAt, restTargetSeconds) => set(s => {
    const cur = s.sessions[sessionId] ?? DEFAULT_TIMER;
    if (!restStartedAt || restTargetSeconds == null) {
      if (!cur.restRunning) return s; // already clear, avoid needless updates
      return { sessions: { ...s.sessions, [sessionId]: { ...cur, restRunning: false, restStartedAtMs: null, restTargetSeconds: 0 } } };
    }
    // SQLite datetime('now') is UTC without a 'Z' suffix — append it so Date parses as UTC.
    const startedAtMs = new Date(restStartedAt.replace(' ', 'T') + 'Z').getTime();
    if (cur.restRunning && cur.restStartedAtMs === startedAtMs && cur.restTargetSeconds === restTargetSeconds) return s;
    return { sessions: { ...s.sessions, [sessionId]: { ...cur, restRunning: true, restStartedAtMs: startedAtMs, restTargetSeconds } } };
  }),
}));
