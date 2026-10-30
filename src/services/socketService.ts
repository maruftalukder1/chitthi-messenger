/**
 * BroadcastChannel audit (Phase 0.5 — ROADMAP_SELLABLE 0.5)
 * =========================================================
 * This service runs TWO transports side by side:
 *
 *  1. WebSocket (`/ws`) — the authoritative transport. The server verifies
 *     identity, enforces room membership, tracks receipts and persists
 *     history. Everything the server must see goes over the socket ONLY.
 *
 *  2. BroadcastChannel (`pulsechat_sync_channel`) — a same-browser,
 *     same-origin tab-sync mirror. `send()` re-posts a frame to the other
 *     open tabs of THIS browser so a second tab stays roughly in step
 *     without waiting for the server round-trip. It is unauthenticated,
 *     unscoped and never leaves the device, so it must never carry
 *     anything identity-, call- or receipt-shaped.
 *
 * What BC carries today (client → other tabs, via `send()`):
 *  - `message:send`    — a chat message frame the sending tab also sent to
 *                        the server; other tabs may render it optimistically.
 *  - `message:update`  — edit / pin / poll / delete patches.
 *  - `message:react`   — reaction toggles.
 *  - `typing:indicator`— typing state for the open room.
 *  - `room:join`       — lets sibling tabs follow the active room.
 *  - `user:heartbeat`  — liveness ping (carries only the sender's own id).
 *
 * What BC must NEVER carry (blocked in BOTH directions — `send()` does not
 * post them, and incoming BC frames of these types are dropped):
 *  - `user:login`      — identity is asserted to the server with a Firebase
 *                        ID token; mirroring it would let one tab's login
 *                        impersonate / overwrite another tab's identity.
 *  - `call:signal`     — call invites/offers must ring exactly one device;
 *                        a BC copy would ring (and could be answered in)
 *                        every open tab.
 *  - `auth:*`          — auth verdicts (`auth:error`, …) are server→client
 *                        only, bound to one socket's handshake.
 *  - `message:read`    — read receipts are recorded by the server; a BC
 *                        copy could forge "read" state in sibling tabs.
 *  - `presence:*`      — presence is owned by the server registry; mirrored
 *                        presence would resurrect fabricated online state
 *                        (Phase 0.4) and fight the real registry.
 *
 * Everything else keeps working exactly as before for same-browser tab sync.
 */
import { ChatMessage, User, Channel } from '../types/chat';
import { getCurrentIdToken } from './firebase';

type MessageCallback = (msg: ChatMessage) => void;
type ReactionCallback = (msg: ChatMessage) => void;
type PresenceCallback = (
  users: { id: string; name?: string; online: boolean; lastActive?: number }[],
  meta?: { full?: boolean }
) => void;
type TypingCallback = (data: { roomId: string; userId: string; username: string; isTyping: boolean }) => void;
type ChannelCallback = (channel: Channel) => void;
export interface HistoryMeta {
  hasMore: boolean;
  oldestId?: string;
}
type HistoryCallback = (roomId: string, messages: ChatMessage[], meta?: HistoryMeta) => void;
type AuthErrorCallback = (data: { error: string }) => void;
type AckCallback = (data: { messageId: string; roomId: string }) => void;
type ReceiptsCallback = (data: { roomId: string; messageId: string; deliveredTo: string[]; readBy: string[] }) => void;
// Phase 1 (Team I wiring): another of the user's sessions was revoked
// server-side (Settings → Sessions, or revoke-others from another device).
type SessionRevokedCallback = () => void;
// Phase 1 (Team CL wiring): server-side scheduled queue outcomes.
export interface ScheduledEvent {
  kind: 'sent' | 'failed';
  id: string;
  messageId?: string;
  reason?: string;
}
type ScheduledEventCallback = (ev: ScheduledEvent) => void;
// Phase 1 (Team CL wiring): a message reminder fired server-side.
export interface ReminderDuePayload {
  id: string;
  roomId: string;
  messageId: string;
  dueAt: number;
}
type ReminderDueCallback = (reminder: ReminderDuePayload) => void;

export type PresenceMode = 'online' | 'away' | 'invisible';

export const PRESENCE_MODE_KEY = 'chitthi_presence_mode';
const DEVICE_LABEL_KEY = 'chitthi_device_label';

/** Read the persisted presence mode (default 'online'). */
export function loadPresenceMode(): PresenceMode {
  try {
    const v = localStorage.getItem(PRESENCE_MODE_KEY);
    if (v === 'away' || v === 'invisible' || v === 'online') return v;
  } catch {
    /* storage unavailable */
  }
  return 'online';
}

/**
 * Human device label for the session registry (e.g. "Chrome on Windows"),
 * generated ONCE per device from the UA and persisted, so the server's
 * first-seen-device login alert fires once — not on every reconnect.
 */
export function getDeviceLabel(): string {
  try {
    const stored = localStorage.getItem(DEVICE_LABEL_KEY);
    if (stored) return stored;
    const ua = navigator.userAgent || '';
    const browser = /Edg\//.test(ua)
      ? 'Edge'
      : /OPR\/|Opera/.test(ua)
        ? 'Opera'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Firefox\//.test(ua)
            ? 'Firefox'
            : /Safari\//.test(ua)
              ? 'Safari'
              : 'Browser';
    const os = /Windows/.test(ua)
      ? 'Windows'
      : /Android/.test(ua)
        ? 'Android'
        : /iPhone|iPad|iPod/.test(ua)
          ? 'iOS'
          : /Mac OS|Macintosh/.test(ua)
            ? 'macOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Unknown OS';
    const label = `${browser} on ${os}`;
    localStorage.setItem(DEVICE_LABEL_KEY, label);
    return label;
  } catch {
    return 'Unknown device';
  }
}

/**
 * The live session id from the server's `session:ready` frame. It is also
 * mirrored to sessionStorage, which firebase.ts `authHeaders()` reads to
 * send `X-Session-Id` on REST calls (storage avoids a firebase<->socket
 * import cycle).
 */
let currentSessionId: string | null = null;
export function getCurrentSessionId(): string | null {
  return currentSessionId;
}
export interface CallSignalData {
  fromUserId?: string;
  targetUserId?: string;
  signalType: string; // 'invite' | 'accept' | 'offer' | 'answer' | 'ice-candidate' | 'reject' | 'end'
  signal?: any;
  roomId?: string;
}
type CallSignalCallback = (data: CallSignalData) => void;

/** Frame types that must never travel over BroadcastChannel (see header).
 * Phase 1 adds the session/scheduled/reminder server→client frames: like
 * `auth:*`, they are bound to one socket's session and must never be
 * forgeable by a sibling tab. */
const BC_BLOCKED_EXACT = new Set([
  'user:login',
  'call:signal',
  'message:read',
  'session:ready',
  'session:revoked',
  'scheduled:sent',
  'scheduled:failed',
  'reminder:due',
]);
function isBcBlocked(type: unknown): boolean {
  if (typeof type !== 'string') return false;
  return (
    BC_BLOCKED_EXACT.has(type) ||
    type.startsWith('auth:') ||
    type.startsWith('presence:')
  );
}

/** Auth failures that no reconnect can ever fix — retrying is pointless. */
const FATAL_AUTH_ERRORS = new Set(['identity_mismatch', 'invalid_token']);

class SocketService {
  private ws: WebSocket | null = null;
  private bc: BroadcastChannel | null = null;
  private messageListeners: Set<MessageCallback> = new Set();
  private reactionListeners: Set<ReactionCallback> = new Set();
  private presenceListeners: Set<PresenceCallback> = new Set();
  private typingListeners: Set<TypingCallback> = new Set();
  private channelListeners: Set<ChannelCallback> = new Set();
  private callSignalListeners: Set<CallSignalCallback> = new Set();
  private historyListeners: Set<HistoryCallback> = new Set();
  private authErrorListeners: Set<AuthErrorCallback> = new Set();
  private ackListeners: Set<AckCallback> = new Set();
  private receiptsListeners: Set<ReceiptsCallback> = new Set();
  private sessionRevokedListeners: Set<SessionRevokedCallback> = new Set();
  private scheduledListeners: Set<ScheduledEventCallback> = new Set();
  private reminderListeners: Set<ReminderDueCallback> = new Set();
  /** Pending fetchHistoryPage() resolvers, FIFO per room (Phase 1.9.1). */
  private pendingHistory: Map<
    string,
    { resolve: (page: { messages: ChatMessage[] } & HistoryMeta) => void; settled: boolean }[]
  > = new Map();
  /** Presence mode sent with the login payload (persisted per device). */
  private presenceMode: PresenceMode = loadPresenceMode();
  private isConnected = false;
  private reconnectTimeout: any = null;
  /** Set on a fatal `auth:error` — stops the reconnect loop until an
   *  explicit fresh `connect()` (e.g. a new login) clears it. */
  private authFailed = false;
  private currentRoomId = 'general';
  private currentUser: User | null = null;

  constructor() {
    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      this.bc = new BroadcastChannel('pulsechat_sync_channel');
      this.bc.onmessage = (event) => {
        // Cross-tab hazard guard: identity / call / auth / receipt /
        // presence frames arriving over BC are never legitimate (see the
        // audit in the file header) — drop them, don't dispatch.
        if (isBcBlocked(event.data?.type)) return;
        this.handleEvent(event.data);
      };
    }
  }

  public connect(user: User, roomId: string) {
    this.currentUser = user;
    this.currentRoomId = roomId;
    // A fresh, explicit connect (new login / user switch) may retry even
    // after a previous fatal auth error.
    this.authFailed = false;

    if (typeof window === 'undefined') return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/ws`;

    try {
      this.ws = new WebSocket(wsUrl);
      const socket = this.ws;

      this.ws.onopen = async () => {
        this.isConnected = true;
        await this.sendLogin(socket, user);
        // The socket may have closed or been replaced while we waited.
        if (this.ws !== socket || socket.readyState !== WebSocket.OPEN) return;
        this.send({
          type: 'room:join',
          roomId,
        });
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.handleEvent(data);
        } catch (e) {
          console.error('Failed to parse incoming WS message', e);
        }
      };

      this.ws.onclose = () => {
        this.isConnected = false;
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        this.isConnected = false;
      };
    } catch (e) {
      console.warn('WebSocket connection not supported in this environment, using BroadcastChannel.', e);
    }
  }

  /**
   * Send the `user:login` frame for `user` on `socket`. Phase 0.1: the
   * Firebase ID token is attached so the server can verify identity
   * instead of trusting the asserted userId; the fetch is raced against
   * 1500 ms so purely local / demo logins are never blocked on it.
   * Phase 1: the payload also carries `deviceLabel` (session registry +
   * first-seen login alerts) and `presenceMode` (online/away/invisible).
   */
  private async sendLogin(socket: WebSocket, user: User) {
    let idToken: string | null = null;
    try {
      idToken = await Promise.race([
        getCurrentIdToken(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
      ]);
    } catch {
      idToken = null;
    }
    // The socket may have closed or been replaced while we waited.
    if (this.ws !== socket || socket.readyState !== WebSocket.OPEN) return;
    this.send({
      type: 'user:login',
      userId: user.id,
      username: user.name,
      ...(idToken ? { idToken } : {}),
      deviceLabel: getDeviceLabel(),
      presenceMode: this.presenceMode,
    });
  }

  /**
   * Change this device's presence mode (Phase 1.4.8). Persisted to
   * localStorage (`chitthi_presence_mode`) so the login payload carries it
   * on every (re)connect. The server exposes NO dedicated presence-update
   * frame (checked server.ts: presenceMode is read only in the
   * `user:login` handler), so when a socket is live we re-send the login
   * frame on it — the server updates the session's presenceMode and
   * re-broadcasts presence. Invisible still receives everything; it only
   * changes how OTHERS see this user (server-side, contract v2).
   */
  public setPresenceMode(mode: PresenceMode) {
    this.presenceMode = mode;
    try {
      localStorage.setItem(PRESENCE_MODE_KEY, mode);
    } catch {
      /* storage unavailable — the in-memory value still applies */
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.currentUser) {
      void this.sendLogin(this.ws, this.currentUser);
    }
  }

  /** The presence mode currently in effect on this device. */
  public getPresenceMode(): PresenceMode {
    return this.presenceMode;
  }

  private scheduleReconnect() {
    // Fatal auth errors (identity_mismatch / invalid_token) will fail
    // identically on every retry — never loop on them. Network drops keep
    // the normal 3 s reconnect.
    if (this.authFailed) return;
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = setTimeout(() => {
      if (this.currentUser && !this.authFailed) {
        this.connect(this.currentUser, this.currentRoomId);
      }
    }, 3000);
  }

  /** Fatal `auth:error`: notify listeners, then tear the socket down
   *  WITHOUT triggering the reconnect loop. */
  private handleFatalAuthError() {
    this.authFailed = true;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.isConnected = false;
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      // Null handlers first so close() doesn't trigger reconnect logic.
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.onopen = null;
      try { ws.close(); } catch { /* ignore */ }
    }
  }

  private handleEvent(data: any) {
    switch (data.type) {
      case 'message:new':
        this.messageListeners.forEach((cb) => cb(data.message));
        break;
      case 'message:updated':
        this.reactionListeners.forEach((cb) => cb(data.message));
        break;
      case 'presence:update':
        // Full registry snapshot: everyone authenticated right now.
        this.presenceListeners.forEach((cb) => cb(data.users, { full: true }));
        break;
      case 'presence:user_offline':
        // Partial event: exactly one user just went offline.
        this.presenceListeners.forEach((cb) =>
          cb(
            [
              {
                id: data.userId,
                online: false,
                // Real last-active moment from the server (it sends
                // `lastActiveTimestamp`; accept `lastActive` too) so the UI
                // can render an honest last-seen instead of a fabricated one.
                lastActive:
                  typeof data.lastActive === 'number'
                    ? data.lastActive
                    : typeof data.lastActiveTimestamp === 'number'
                      ? data.lastActiveTimestamp
                      : undefined,
              },
            ],
            { full: false }
          )
        );
        break;
      case 'channel:created':
        this.channelListeners.forEach((cb) => cb(data.channel));
        break;
      case 'typing:indicator':
        this.typingListeners.forEach((cb) => cb(data));
        break;
      case 'call:signal':
        this.callSignalListeners.forEach((cb) => cb(data));
        break;
      case 'room:history': {
        const meta: HistoryMeta = {
          hasMore: !!data.hasMore,
          oldestId: typeof data.oldestId === 'string' ? data.oldestId : undefined,
        };
        this.historyListeners.forEach((cb) => cb(data.roomId, data.messages || [], meta));
        // Resolve the oldest pending fetchHistoryPage() for this room.
        const queue = this.pendingHistory.get(data.roomId);
        if (queue && queue.length) {
          const entry = queue.shift()!;
          if (!entry.settled) {
            entry.settled = true;
            entry.resolve({ messages: data.messages || [], ...meta });
          }
          if (!queue.length) this.pendingHistory.delete(data.roomId);
        }
        break;
      }
      case 'session:ready':
        // Captured for the X-Session-Id REST header: firebase.ts authHeaders
        // reads it from sessionStorage (avoids a firebase<->socket import
        // cycle); getCurrentSessionId exposes it in-module too.
        if (typeof data.sessionId === 'string' && data.sessionId) {
          currentSessionId = data.sessionId;
          try { sessionStorage.setItem('chitthi_session_id', data.sessionId); } catch { /* storage unavailable */ }
        }
        break;
      case 'session:revoked':
        this.sessionRevokedListeners.forEach((cb) => cb());
        break;
      case 'scheduled:sent':
        this.scheduledListeners.forEach((cb) =>
          cb({
            kind: 'sent',
            id: String(data.id || ''),
            messageId: typeof data.messageId === 'string' ? data.messageId : undefined,
          })
        );
        break;
      case 'scheduled:failed':
        this.scheduledListeners.forEach((cb) =>
          cb({
            kind: 'failed',
            id: String(data.id || ''),
            reason: typeof data.reason === 'string' ? data.reason : undefined,
          })
        );
        break;
      case 'reminder:due': {
        const rem = data.reminder;
        if (rem && typeof rem.id === 'string' && typeof rem.roomId === 'string' && typeof rem.messageId === 'string') {
          this.reminderListeners.forEach((cb) =>
            cb({
              id: rem.id,
              roomId: rem.roomId,
              messageId: rem.messageId,
              dueAt: typeof rem.dueAt === 'number' ? rem.dueAt : Date.now(),
            })
          );
        }
        break;
      }
      case 'auth:error': {
        const error = typeof data.error === 'string' ? data.error : 'unknown';
        this.authErrorListeners.forEach((cb) => cb({ error }));
        if (FATAL_AUTH_ERRORS.has(error)) {
          this.handleFatalAuthError();
        }
        break;
      }
      case 'message:ack':
        this.ackListeners.forEach((cb) =>
          cb({ messageId: data.messageId, roomId: data.roomId })
        );
        break;
      case 'message:receipts':
        this.receiptsListeners.forEach((cb) =>
          cb({
            roomId: data.roomId,
            messageId: data.messageId,
            deliveredTo: Array.isArray(data.deliveredTo) ? data.deliveredTo : [],
            readBy: Array.isArray(data.readBy) ? data.readBy : [],
          })
        );
        break;
    }
  }

  public sendCallSignal(data: CallSignalData) {
    this.send({
      type: 'call:signal',
      fromUserId: this.currentUser?.id,
      targetUserId: data.targetUserId,
      signalType: data.signalType,
      signal: data.signal,
      roomId: data.roomId ?? this.currentRoomId,
    });
  }

  public onCallSignal(cb: CallSignalCallback) {
    this.callSignalListeners.add(cb);
    return () => {
      this.callSignalListeners.delete(cb);
    };
  }

  public onAuthError(cb: AuthErrorCallback) {
    this.authErrorListeners.add(cb);
    return () => {
      this.authErrorListeners.delete(cb);
    };
  }

  public onAck(cb: AckCallback) {
    this.ackListeners.add(cb);
    return () => {
      this.ackListeners.delete(cb);
    };
  }

  public onReceipts(cb: ReceiptsCallback) {
    this.receiptsListeners.add(cb);
    return () => {
      this.receiptsListeners.delete(cb);
    };
  }

  /** Phase 1 (Team I wiring): fired when the server revokes THIS session
   * (`session:revoked`) — the app logs out locally. Mirrors onAuthError. */
  public onSessionRevoked(cb: SessionRevokedCallback) {
    this.sessionRevokedListeners.add(cb);
    return () => {
      this.sessionRevokedListeners.delete(cb);
    };
  }

  /** Phase 1: server-side scheduled queue outcomes (`scheduled:sent` /
   * `scheduled:failed`). */
  public onScheduledEvent(cb: ScheduledEventCallback) {
    this.scheduledListeners.add(cb);
    return () => {
      this.scheduledListeners.delete(cb);
    };
  }

  /** Phase 1: a message reminder fired (`reminder:due`). */
  public onReminderDue(cb: ReminderDueCallback) {
    this.reminderListeners.add(cb);
    return () => {
      this.reminderListeners.delete(cb);
    };
  }

  /**
   * Phase 1.9.1 history paging: request one page of a room's history
   * (optionally ending before `before`) and resolve with the page plus
   * the server's `hasMore`/`oldestId`. The same `room:history` response
   * also flows to onHistory listeners, so callers' message stores merge
   * the page exactly as with a room join. Resolves with an empty page on
   * an 8 s timeout rather than hanging forever.
   */
  public fetchHistoryPage(
    roomId: string,
    opts?: { before?: string; limit?: number }
  ): Promise<{ messages: ChatMessage[] } & HistoryMeta> {
    return new Promise((resolve) => {
      const entry = {
        settled: false,
        resolve: (page: { messages: ChatMessage[] } & HistoryMeta) => resolve(page),
      };
      const queue = this.pendingHistory.get(roomId) || [];
      queue.push(entry);
      this.pendingHistory.set(roomId, queue);
      setTimeout(() => {
        if (entry.settled) return;
        entry.settled = true;
        const q = this.pendingHistory.get(roomId);
        if (q) {
          const idx = q.indexOf(entry);
          if (idx > -1) q.splice(idx, 1);
          if (!q.length) this.pendingHistory.delete(roomId);
        }
        resolve({ messages: [], hasMore: false });
      }, 8000);
      this.send({
        type: 'room:history',
        roomId,
        ...(opts?.before ? { before: opts.before } : {}),
        ...(typeof opts?.limit === 'number' ? { limit: opts.limit } : {}),
      });
    });
  }

  /** Tell the server the current user has viewed messages in a room
   *  (Phase 0.5 receipts). `messageIds` omitted = everything in the room.
   *  Socket-only by design: `message:read` is on the BC blocklist. */
  public sendRead(roomId: string, messageIds?: string[]) {
    // Saved Messages is local-only — it has no server-side receipts.
    if (roomId === 'saved_messages') return;
    this.send({
      type: 'message:read',
      roomId,
      ...(messageIds && messageIds.length ? { messageIds } : {}),
    });
  }

  public send(data: any) {
    // Send over WebSocket if connected
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(data));
      } catch (err) {
        console.error('WS send error:', err);
      }
    }
    // Also broadcast across tabs — EXCEPT the blocklisted frame types in
    // the header audit (identity, calls, auth, read receipts, presence),
    // which are socket-only.
    if (this.bc && !isBcBlocked(data?.type)) {
      try {
        this.bc.postMessage(data);
      } catch (err) {
        console.error('BC postMessage error:', err);
      }
    }
  }

  public sendMessage(msg: ChatMessage) {
    // Saved Messages is a LOCAL-ONLY room: it must never leave this device.
    // The room id is identical for every user, so relaying it would drop one
    // person's saved items into everyone else's Saved Messages.
    if (msg.roomId !== 'saved_messages') {
      this.send({
        type: 'message:send',
        message: msg,
      });
    }
    // Immediately deliver locally
    this.messageListeners.forEach((cb) => cb(msg));
  }

  public sendMessageUpdate(messageId: string, roomId: string, patch: Partial<ChatMessage>) {
    // Local-only guard mirrors sendMessage: Saved Messages never leaves the device.
    if (roomId === 'saved_messages') return;
    this.send({ type: 'message:update', messageId, roomId, patch });
  }

  public sendReaction(messageId: string, roomId: string, emoji: string, userId: string) {
    this.send({
      type: 'message:react',
      messageId,
      roomId,
      emoji,
      userId,
    });
  }

  public sendTyping(roomId: string, userId: string, username: string, isTyping: boolean) {
    this.send({
      type: 'typing:indicator',
      roomId,
      userId,
      username,
      isTyping,
    });
  }

  public switchRoom(newRoomId: string) {
    this.currentRoomId = newRoomId;
    if (this.isConnected) {
      this.send({
        type: 'room:join',
        roomId: newRoomId,
      });
    }
  }

  public onMessage(cb: MessageCallback) {
    this.messageListeners.add(cb);
    return () => {
      this.messageListeners.delete(cb);
    };
  }

  public onReaction(cb: ReactionCallback) {
    this.reactionListeners.add(cb);
    return () => {
      this.reactionListeners.delete(cb);
    };
  }

  public onPresence(cb: PresenceCallback) {
    this.presenceListeners.add(cb);
    return () => {
      this.presenceListeners.delete(cb);
    };
  }

  public onChannelCreated(cb: ChannelCallback) {
    this.channelListeners.add(cb);
    return () => {
      this.channelListeners.delete(cb);
    };
  }

  public onTyping(cb: TypingCallback) {
    this.typingListeners.add(cb);
    return () => {
      this.typingListeners.delete(cb);
    };
  }

  public onHistory(cb: HistoryCallback) {
    this.historyListeners.add(cb);
    return () => {
      this.historyListeners.delete(cb);
    };
  }

  public disconnect() {
    // Clear pending reconnect so scheduleReconnect won't revive the socket.
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    // A deliberate disconnect (logout) clears any fatal-auth latch so the
    // next login starts from a clean slate.
    this.authFailed = false;
    this.currentUser = null;
    currentSessionId = null;
    try { sessionStorage.removeItem('chitthi_session_id'); } catch { /* storage unavailable */ }
    // Settle any pending history-page requests so callers never hang.
    for (const queue of this.pendingHistory.values()) {
      for (const entry of queue) {
        if (!entry.settled) {
          entry.settled = true;
          entry.resolve({ messages: [], hasMore: false });
        }
      }
    }
    this.pendingHistory.clear();
    if (this.ws) {
      // Null handlers first so close() doesn't trigger reconnect logic.
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.onopen = null;
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.isConnected = false;
  }
}

export const socketService = new SocketService();
