/**
 * ICE configuration for WebRTC calls.
 *
 * The server may expose GET /api/config → { iceServers: [...] } with
 * dedicated TURN credentials. Until/unless it does, calls fall back to
 * the STUN + free Open Relay TURN set that has shipped since the first
 * cross-network fix. getIceServers() never throws and never returns an
 * empty/invalid list — any failure yields FALLBACK_ICE_SERVERS.
 */

// STUN + free Open Relay TURN (same relay that fixed PawMatch's cross-network calls).
// Dedicated TURN credentials are the upgrade path if quality suffers.
export const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp'],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

const isValidIceServer = (entry: unknown): entry is RTCIceServer => {
  if (!entry || typeof entry !== 'object') return false;
  const urls = (entry as { urls?: unknown }).urls;
  if (typeof urls === 'string') return urls.length > 0;
  if (Array.isArray(urls)) return urls.length > 0 && urls.every((u) => typeof u === 'string' && u.length > 0);
  return false;
};

// Cache the in-flight promise so repeated calls (incl. concurrent ones)
// share a single /api/config fetch for the lifetime of the page.
let cachedPromise: Promise<RTCIceServer[]> | null = null;

export function getIceServers(): Promise<RTCIceServer[]> {
  if (cachedPromise) return cachedPromise;
  cachedPromise = (async (): Promise<RTCIceServer[]> => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      let res: Response;
      try {
        res = await fetch('/api/config', { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
      if (!res.ok) return FALLBACK_ICE_SERVERS;
      const json: unknown = await res.json().catch(() => null);
      if (!json || typeof json !== 'object') return FALLBACK_ICE_SERVERS;
      const list = (json as { iceServers?: unknown }).iceServers;
      if (!Array.isArray(list)) return FALLBACK_ICE_SERVERS;
      const valid = list.filter(isValidIceServer);
      if (valid.length < 1) return FALLBACK_ICE_SERVERS;
      return valid;
    } catch {
      return FALLBACK_ICE_SERVERS;
    }
  })();
  return cachedPromise;
}
