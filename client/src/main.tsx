import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { setQueryClient, startSyncEngine, debug } from './offline/engine';
import { registerServiceWorker } from './offline/serviceWorker';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    // networkMode 'always': queries and mutations must run while offline too — the API
    // layer answers them from the local replica instead of the network.
    queries: { staleTime: 30_000, retry: 1, networkMode: 'always' },
    mutations: { networkMode: 'always' },
  },
});

setQueryClient(queryClient);
startSyncEngine();
registerServiceWorker();
(window as unknown as { __ascentSync: typeof debug }).__ascentSync = debug;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
);
