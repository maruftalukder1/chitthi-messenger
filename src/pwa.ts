/**
 * চিঠি · Chitthi — PWA support (Phase 5 packaging)
 *
 * Owns: service-worker registration, the `beforeinstallprompt` capture,
 * and a self-contained install banner helper.
 *
 * Honesty rules:
 *  - No fake "installed" state: `canInstall()` is true only while a real
 *    browser-supplied install prompt is stashed, and `promptInstall()`
 *    only ever reports the browser's actual outcome.
 *  - Everything is guarded — unsupported browsers, blocked storage or a
 *    failed registration must never produce a console error or break
 *    app boot.
 *
 * App wiring (one line, owned by the App team — not done here):
 *   import { maybeShowInstallBanner } from './pwa';
 *   // e.g. once after first render / login:
 *   maybeShowInstallBanner();
 * `registerPWA()` is already called from src/main.tsx in production.
 */

/** The non-standard event Chrome/Edge fire when the app is installable. */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

const DISMISS_KEY = 'chitthi_pwa_dismissed';
const BANNER_ID = 'chitthi-pwa-install-banner';

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let listenersInstalled = false;

function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage blocked (private mode etc.) — dismissal just won't persist */
  }
}

/** True when the app is already running as an installed PWA. */
export function isStandalone(): boolean {
  try {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      // iOS Safari's non-standard flag.
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true
    );
  } catch {
    return false;
  }
}

/** True only while a real browser install prompt is available. */
export function canInstall(): boolean {
  return deferredPrompt !== null;
}

/** True when the user previously dismissed the install banner. */
export function isInstallDismissed(): boolean {
  return storageGet(DISMISS_KEY) !== null;
}

/** Remember the dismissal so the banner is not shown again. */
export function dismissInstall(): void {
  storageSet(DISMISS_KEY, '1');
}

/**
 * Show the browser's real install prompt.
 * Returns 'accepted' | 'dismissed' from the browser's own userChoice,
 * or 'unavailable' when no prompt is stashed (never faked).
 */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const event = deferredPrompt;
  if (!event) return 'unavailable';
  // The stashed event can only be used once.
  deferredPrompt = null;
  try {
    await event.prompt();
    const choice = await event.userChoice;
    return choice.outcome === 'accepted' ? 'accepted' : 'dismissed';
  } catch {
    return 'unavailable';
  }
}

function installPromptListeners(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;
  window.addEventListener('beforeinstallprompt', (event: Event) => {
    // Stop Chrome's mini-infobar; the banner helper decides when to ask.
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    removeInstallBanner();
  });
}

/**
 * Register the service worker (see public/sw.js for its caching rules).
 * Safe to call anywhere: no-ops silently when unsupported and swallows
 * registration failures — PWA support must never break the app.
 */
export function registerPWA(): void {
  installPromptListeners();
  try {
    if (!('serviceWorker' in navigator)) return;
    const register = () => {
      try {
        void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
          /* registration rejected (e.g. non-secure context) — app runs fine without it */
        });
      } catch {
        /* ignore — see honesty note above */
      }
    };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  } catch {
    /* ignore — PWA is progressive enhancement only */
  }
}

/** Remove the install banner if it is currently mounted. */
export function removeInstallBanner(): void {
  try {
    document.getElementById(BANNER_ID)?.remove();
  } catch {
    /* ignore */
  }
}

/**
 * Self-contained, dismissible install banner. Creates and mounts its own
 * fixed bottom DOM node (inline styles only — no app components, no
 * Tailwind classes, so it cannot disturb app styling), and no-ops when:
 * the app is already installed/standalone, the user dismissed it before
 * (localStorage `chitthi_pwa_dismissed`), no real install prompt is
 * available, or the banner is already on screen.
 * Returns true when the banner was mounted.
 */
export function showInstallBanner(): boolean {
  try {
    if (isStandalone() || isInstallDismissed() || !canInstall()) return false;
    if (document.getElementById(BANNER_ID)) return false;

    const banner = document.createElement('div');
    banner.id = BANNER_ID;
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Install Chitthi');
    banner.style.cssText = [
      'position:fixed',
      'left:16px',
      'right:16px',
      'bottom:calc(16px + env(safe-area-inset-bottom, 0px))',
      'margin:0 auto',
      'max-width:420px',
      'z-index:9999',
      'display:flex',
      'align-items:center',
      'gap:12px',
      'padding:12px 14px',
      'border-radius:20px',
      'background:rgba(255,255,255,0.92)',
      'backdrop-filter:blur(14px) saturate(140%)',
      '-webkit-backdrop-filter:blur(14px) saturate(140%)',
      'border:1px solid #E5E9F0',
      'box-shadow:0 8px 32px rgba(0,0,0,0.18)',
      "font-family:'Inter','Hind Siliguri',system-ui,sans-serif",
      'color:#111827',
    ].join(';');

    const icon = document.createElement('img');
    icon.src = '/icons/icon-192.png';
    icon.alt = '';
    icon.width = 40;
    icon.height = 40;
    icon.style.cssText = 'border-radius:10px;flex:none';

    const text = document.createElement('div');
    text.style.cssText = 'flex:1;min-width:0';
    const title = document.createElement('div');
    title.textContent = 'Install চিঠি · Chitthi';
    title.style.cssText = 'font-size:15px;font-weight:600;line-height:1.3';
    const sub = document.createElement('div');
    sub.textContent = 'Add Chitthi to your home screen for a faster, app-like experience.';
    sub.style.cssText = 'font-size:13px;line-height:1.4;color:#6B7280';
    text.append(title, sub);

    const installButton = document.createElement('button');
    installButton.type = 'button';
    installButton.textContent = 'Install';
    installButton.style.cssText = [
      'flex:none',
      'border:0',
      'cursor:pointer',
      'padding:9px 16px',
      'border-radius:999px',
      'font-size:14px',
      'font-weight:600',
      'color:#FFFFFF',
      'background:#0B6E4F',
    ].join(';');
    installButton.addEventListener('click', () => {
      void promptInstall().then(() => removeInstallBanner());
    });

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.textContent = '×';
    closeButton.setAttribute('aria-label', 'Dismiss install banner');
    closeButton.style.cssText = [
      'flex:none',
      'border:0',
      'cursor:pointer',
      'background:transparent',
      'color:#68707E',
      'font-size:22px',
      'line-height:1',
      'padding:4px 6px',
    ].join(';');
    closeButton.addEventListener('click', () => {
      dismissInstall();
      removeInstallBanner();
    });

    banner.append(icon, text, installButton, closeButton);
    document.body.appendChild(banner);
    return true;
  } catch {
    return false;
  }
}

/** Alias for the App wiring line: show the banner only when appropriate. */
export function maybeShowInstallBanner(): boolean {
  return showInstallBanner();
}
