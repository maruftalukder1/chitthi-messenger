/**
 * Incoming-message notifications (MEGA round — App shell workstream).
 *
 * Settings persist in localStorage under NOTIF_SETTINGS_KEY. Everything
 * here is best-effort and fully guarded: no Notification permission, no
 * AudioContext, or no storage must never break message delivery.
 */

export const NOTIF_SETTINGS_KEY = 'chitthi_notifications_v1';

export type NotifSettings = { messages: boolean; sound: boolean };

const DEFAULTS: NotifSettings = { messages: true, sound: true };

export function getNotifSettings(): NotifSettings {
  try {
    const raw = localStorage.getItem(NOTIF_SETTINGS_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return {
      messages:
        typeof parsed?.messages === 'boolean' ? parsed.messages : DEFAULTS.messages,
      sound: typeof parsed?.sound === 'boolean' ? parsed.sound : DEFAULTS.sound,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setNotifSettings(patch: Partial<NotifSettings>): NotifSettings {
  const next: NotifSettings = { ...getNotifSettings(), ...patch };
  try {
    localStorage.setItem(NOTIF_SETTINGS_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable — return the merged value anyway */
  }
  return next;
}

let audioCtx: AudioContext | null = null;

export function playBlip(): void {
  try {
    if (typeof window === 'undefined') return;
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;
    if (!audioCtx) audioCtx = new Ctor();
    const ctx = audioCtx;
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.09);
  } catch {
    /* audio is progressive enhancement only */
  }
}

export function notifyIncoming(opts: { title: string; body: string }): void {
  try {
    if (!getNotifSettings().messages) return;
    if (typeof window === 'undefined') return;
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    new Notification(opts.title, { body: opts.body, icon: undefined });
  } catch {
    /* notifications are progressive enhancement only */
  }
}

export function updateTitleBadge(totalUnread: number): void {
  try {
    document.title =
      totalUnread > 0
        ? `(${totalUnread}) চিঠি - Chitthi Messenger`
        : 'চিঠি - Chitthi Messenger';
  } catch {
    /* ignore */
  }
}
