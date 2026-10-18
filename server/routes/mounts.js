// Single list of API route modules and where they are mounted. Used by server/index.js
// to mount them, by routes/sync.js to replay queued offline operations through the same
// handlers, and by the client's build (client/vite.config.ts) to bundle the same handlers
// for offline use on a device. `offline: false` = server-only (needs the network anyway).
module.exports = [
  { path: '/users',       module: 'users' },
  { path: '/foods',       module: 'foods' },
  { path: '/meals',       module: 'meals' },
  { path: '/exercises',   module: 'exercises' },
  { path: '/routines',    module: 'routines' },
  { path: '/regimes',     module: 'regimes' },
  { path: '/workouts',    module: 'workouts' },
  { path: '/dashboard',   module: 'dashboard' },
  { path: '/images',      module: 'images' },
  { path: '/ai',          module: 'ai', offline: false },
  { path: '/bug-reports', module: 'bug-reports' },
];
