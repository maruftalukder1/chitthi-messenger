/**
 * Call-log sync (Phase 1.3 — protocol contract v2, see PHASE1_REPORT.md).
 *
 * Server contract:
 *   POST /api/call-logs { peerId, type, direction, durationSec, startedAt }
 *     → stored for the caller AND mirrored for the peer (direction flipped).
 *   GET  /api/call-logs
 *     → the caller's latest 200 entries.
 *
 * WIRE-FORMAT NOTE (verified against the landed server.ts, Phase 1):
 * the server reads `direction` as the full words 'incoming' | 'outgoing'
 * (anything else collapses to 'outgoing', including for the mirror flip),
 * and stores `type` verbatim with an 'audio' default — i.e. it treats
 * `type` as the call KIND. It does not (yet) persist a separate log-type
 * or callType field. postCallLog therefore maps its rich entry onto the
 * wire as: type = kind ('audio'|'video'), direction = full word, plus
 * `callType` and `logType` duplicates that a fixed server can prefer.
 * fetchCallLogs reverses all of these readings, so entries round-trip
 * under either server interpretation; with today's server a declined
 * call degrades to 'missed' server-side (direction + 0s is all it keeps)
 * while the local log keeps the precise type.
 *
 * Auth follows contract v1 via `authHeaders()` from firebase.ts (Bearer
 * Firebase ID token, or the demo-mode `X-Demo-User` header). Both helpers
 * are best-effort and NEVER throw: a missing/offline server must not break
 * placing calls or rendering the local call history — callers keep their
 * local logs as the fallback (CallsScreen merges the two sources).
 */
import { authHeaders } from './firebase';

export type CallLogType = 'incoming' | 'outgoing' | 'missed' | 'declined';

/** Entry accepted by `postCallLog` (mapped onto the wire — see header). */
export interface PostCallLogEntry {
  peerId: string;
  /** Display-name hint for the peer; the server may ignore it (peers are
   * resolved by ID on render), but it keeps a mirrored entry readable when
   * the peer is not in the local users list. */
  peerName?: string;
  type: CallLogType;
  direction: 'in' | 'out';
  callType: 'audio' | 'video';
  durationSec: number;
  /** Epoch ms when the call started (ring/invite moment). */
  startedAt: number;
  /** Real measured data usage (formatted, e.g. '3.8 MB') from WebRTC stats;
   * absent when stats were unavailable — never fabricated. */
  dataUsed?: string;
}

/** Normalised server entry returned by `fetchCallLogs`. */
export interface ServerCallLog {
  id: string;
  peerId: string;
  peerName?: string;
  type: CallLogType;
  direction: 'in' | 'out';
  callType: 'audio' | 'video';
  durationSec: number;
  /** Epoch ms when the call started. */
  startedAt: number;
  /** Real measured data usage (formatted, e.g. '3.8 MB') when the server stored it. */
  dataUsed?: string;
}

const VALID_TYPES: CallLogType[] = ['incoming', 'outgoing', 'missed', 'declined'];

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Parse a stored "m:ss" duration string back into seconds. */
function parseDurationString(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(?:(\d+):)?([0-5]?\d)$/);
  if (!m) return null;
  return (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]);
}

function normalizeEntry(raw: any, index: number): ServerCallLog | null {
  if (!raw || typeof raw !== 'object') return null;

  const peerId: unknown =
    raw.peerId ?? raw.peer?.id ?? raw.user?.id ?? raw.userId ?? raw.otherUserId;
  if (typeof peerId !== 'string' || !peerId) return null;

  const peerName: unknown = raw.peerName ?? raw.peer?.name ?? raw.user?.name;

  // Call KIND: `callType` field wins; the landed server instead stores the
  // kind in `type` (see the wire-format note at the top of this file).
  const callType: 'audio' | 'video' =
    raw.callType === 'video' || raw.type === 'video'
      ? 'video'
      : 'audio';

  const durationSec =
    toFiniteNumber(raw.durationSec) ?? parseDurationString(raw.duration) ?? 0;

  // Direction: accept 'in'/'out' and the landed server's full words.
  let direction: 'in' | 'out' | null =
    raw.direction === 'in' || raw.direction === 'incoming'
      ? 'in'
      : raw.direction === 'out' || raw.direction === 'outgoing'
        ? 'out'
        : null;

  // Log TYPE: a dedicated `logType` field wins, then a `type` that carries
  // a log type; otherwise derive from direction + whether it connected.
  let type: CallLogType | null = null;
  if (VALID_TYPES.includes(raw.logType)) type = raw.logType as CallLogType;
  else if (VALID_TYPES.includes(raw.type)) type = raw.type as CallLogType;
  if (!direction && type) {
    direction = type === 'outgoing' ? 'out' : 'in';
  }
  if (!direction) return null;
  if (!type) {
    type = durationSec > 0 ? (direction === 'in' ? 'incoming' : 'outgoing') : 'missed';
  }

  let startedAt =
    toFiniteNumber(raw.startedAt) ?? toFiniteNumber(raw.timestamp) ?? toFiniteNumber(raw.createdAt);
  if (startedAt === null && (raw.date || raw.time)) {
    const parsed = Date.parse(`${raw.date ?? ''} ${raw.time ?? ''}`.trim());
    if (Number.isFinite(parsed)) startedAt = parsed;
  }
  if (startedAt === null || startedAt <= 0) return null;

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `srv_${peerId}_${startedAt}_${index}`,
    peerId,
    ...(typeof peerName === 'string' && peerName ? { peerName } : {}),
    type,
    direction,
    callType,
    durationSec,
    startedAt,
    ...(typeof raw.dataUsed === 'string' && raw.dataUsed ? { dataUsed: raw.dataUsed } : {}),
  };
}

/**
 * Persist one finished call on the server (it mirrors the entry to the
 * peer with the direction flipped). Returns true on a 2xx response.
 * Best-effort: returns false instead of throwing on any failure.
 */
export async function postCallLog(
  entry: PostCallLogEntry,
  userIdFallback?: string
): Promise<boolean> {
  try {
    if (!entry || typeof entry.peerId !== 'string' || !entry.peerId) return false;
    const headers = await authHeaders(userIdFallback);
    const res = await fetch('/api/call-logs', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        peerId: entry.peerId,
        ...(entry.peerName ? { peerName: entry.peerName } : {}),
        // Landed-server wire format (see header): `type` carries the call
        // KIND and `direction` the full word; `logType` + `callType` are
        // the unambiguous duplicates for a fixed server / our own reader.
        type: entry.callType,
        callType: entry.callType,
        logType: entry.type,
        direction: entry.direction === 'in' ? 'incoming' : 'outgoing',
        durationSec: Math.max(0, Math.floor(entry.durationSec || 0)),
        startedAt: entry.startedAt,
        ...(entry.dataUsed ? { dataUsed: entry.dataUsed } : {}),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Fetch the caller's server-side call logs (latest 200), normalised to
 * `ServerCallLog[]` and sorted newest-first. Accepts the bare-array and
 * `{ logs | callLogs | entries }` response shapes. Returns [] on any
 * failure (offline, endpoint not deployed yet, bad payload).
 */
export async function fetchCallLogs(userIdFallback?: string): Promise<ServerCallLog[]> {
  try {
    const headers = await authHeaders(userIdFallback);
    const res = await fetch('/api/call-logs', { headers });
    if (!res.ok) return [];
    const data: any = await res.json().catch(() => null);
    const list: unknown[] = Array.isArray(data)
      ? data
      : Array.isArray(data?.logs)
        ? data.logs
        : Array.isArray(data?.callLogs)
          ? data.callLogs
          : Array.isArray(data?.entries)
            ? data.entries
            : [];
    const entries = list
      .map((raw, i) => normalizeEntry(raw, i))
      .filter((e): e is ServerCallLog => e !== null);
    entries.sort((a, b) => b.startedAt - a.startedAt);
    return entries;
  } catch {
    return [];
  }
}
