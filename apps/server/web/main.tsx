import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { ensureServiceWorker } from './service-worker.js';
import './styles.css';

const container = document.getElementById('root');

if (container === null) {
  throw new Error('Root element is missing.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Not awaited: the worker is what makes the app installable and what shows a
// notification while nothing is open, and neither of those is needed to render.
// A browser that cannot register one keeps working exactly as before.
void ensureServiceWorker();
