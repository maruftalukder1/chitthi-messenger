import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import {registerPWA} from './pwa.ts';

// PWA: production-only service worker + install-prompt capture.
// registerPWA() is fully guarded — it no-ops silently where unsupported.
if (import.meta.env.PROD) {
  registerPWA();
}

createRoot(document.getElementById('root')!).render(<App />);
