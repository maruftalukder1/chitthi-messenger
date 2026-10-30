import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';
import fs from 'fs';
import { randomInt, randomBytes, createPublicKey, verify as cryptoVerify } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// Azure App Service (and most hosts) assign the port via env; 3000 locally.
const port = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

interface ClientSession {
  ws: WebSocket;
  userId?: string;
  username?: string;
  /** true when identity was proven with a verified Firebase ID token. */
  verified?: boolean;
  activeRoomId?: string;
  lastActive: number;
  /** Phase 1: stable per-socket session id (sessions API). */
  sessionId?: string;
  deviceLabel?: string;
  presenceMode?: 'online' | 'away' | 'invisible';
  connectedAt?: number;
}

const clients = new Map<WebSocket, ClientSession>();

// In-memory chat storage for active rooms
interface MessagePayload {
  id: string;
  senderId: string;
  senderName: string;
  senderAvatar: string;
  roomId: string;
  sectionId?: string;
  type: 'text' | 'image' | 'video' | 'audio' | 'file' | 'offline_qr';
  content: string;
  fileName?: string;
  fileSize?: string;
  duration?: number;
  timestamp: number;
  reactions?: Record<string, string[]>;
  editedAt?: number;
  deletedAt?: number;
  pinned?: boolean;
  poll?: any;
  forwardedFrom?: string;
  replyTo?: any;
  expiresAt?: number;
  sticker?: boolean;
  images?: string[];
  /** Phase 1: uploads + rich message extras. */
  mimeType?: string;
  storyRef?: string;
  contactCard?: string;
  stickerPack?: string;
  stickerId?: string;
  /** Server-tracked delivery/read receipts (Phase 0.5): user IDs. */
  deliveredTo?: string[];
  readBy?: string[];
}

const roomMessages = new Map<string, MessagePayload[]>();

// In-memory Two-Factor Authentication (2FA) store
interface TwoFactorRecord {
  email: string;
  name: string;
  code: string;
  expiresAt: number;
  createdAt: number;
  verified: boolean;
}
const twoFactorCodes = new Map<string, TwoFactorRecord>();
// Failed verify attempts per email — brute-force guard (security lab finding:
// unlimited wrong guesses were accepted). Cap: 10, then the code is burned.
const twoFactorAttempts = new Map<string, number>();

// In-memory persistent channels store with accurate timestamps
interface ServerChannel {
  id: string;
  name: string;
  description: string;
  iconType: string;
  category?: string;
  isGroup: boolean;
  avatar?: string;
  lastMessage?: string;
  lastMessageTimestamp: number;
  createdAt: number;
  membersCount?: number;
  members?: string[];
  sections?: any[];
  bookmarks?: any[];
  adminId?: string;
  /** Phase 0.3: ownership + membership by user ID (never display name). */
  ownerId?: string;
  memberIds?: string[];
  adminIds?: string[];
  /** Phase 1: invites, permissions, events. Sections may carry readOnly. */
  inviteCode?: string;
  inviteEnabled?: boolean;
  joinApproval?: boolean;
  joinRequests?: string[];
  permissions?: { post?: string; pin?: string; manage?: string };
  events?: any[];
}

const serverChannels = new Map<string, ServerChannel>();

// Phase 0.4: NO seeded/demo channels. A fresh install starts empty; the demo
// "Fullsnack Designers" group (fake members, hotlinked avatar, fabricated
// lastMessage) was removed from the shipped server.

// -------------------------------------------------------------
// Phase 0.1 — Identity: Firebase ID-token verification + demo gate
// -------------------------------------------------------------
// The Firebase project id comes from the applet config shipped with the app.
let FIREBASE_PROJECT_ID = 'modern-patrol-vt3g1';
try {
  const cfg = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'firebase-applet-config.json'), 'utf8')
  );
  if (cfg && typeof cfg.projectId === 'string' && cfg.projectId) {
    FIREBASE_PROJECT_ID = cfg.projectId;
  }
} catch {
  /* fall back to the known project id */
}

// Demo auth bypass: self-asserted identities are accepted ONLY when the
// operator explicitly opts in for local development/demo, and NEVER in
// production builds. Production always requires a verified Firebase token.
const DEMO_AUTH =
  process.env.CHITTHI_ALLOW_UNAUTH_DEMO === 'true' &&
  process.env.NODE_ENV !== 'production';
if (process.env.CHITTHI_ALLOW_UNAUTH_DEMO === 'true' && !DEMO_AUTH) {
  console.warn(
    '[auth] CHITTHI_ALLOW_UNAUTH_DEMO is set but ignored: demo auth is disabled when NODE_ENV=production.'
  );
}

// Google secure-token JWKS cache (RS256 public keys for ID-token verification).
let jwksCache: { keys: any[]; fetchedAt: number } | null = null;
async function fetchSecureTokenJwks(): Promise<any[]> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < 60 * 60 * 1000) {
    return jwksCache.keys;
  }
  const res = await fetch(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'
  );
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body: any = await res.json();
  jwksCache = { keys: body.keys || [], fetchedAt: Date.now() };
  return jwksCache.keys;
}

function b64urlJson(part: string): any {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/** Verify a Firebase ID token. Returns { uid, email? } or null. Fail-closed. */
async function verifyFirebaseIdToken(
  token: string
): Promise<{ uid: string; email?: string } | null> {
  try {
    if (typeof token !== 'string' || token.length > 8192) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const header = b64urlJson(parts[0]);
    const payload = b64urlJson(parts[1]);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
    const keys = await fetchSecureTokenJwks();
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    const signature = Buffer.from(parts[2], 'base64url');
    if (!cryptoVerify('RSA-SHA256', signed, key, signature)) return null;
    const now = Math.floor(Date.now() / 1000);
    if (payload.iss !== `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`)
      return null;
    if (payload.aud !== FIREBASE_PROJECT_ID) return null;
    if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
    if (typeof payload.iat !== 'number' || payload.iat > now + 300) return null;
    if (typeof payload.sub !== 'string' || !payload.sub) return null;
    return {
      uid: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
    };
  } catch (err) {
    console.warn('[auth] ID token verification failed:', err);
    return null;
  }
}

/** Authenticate an HTTP request. Returns the caller's user ID or null. */
async function authenticateHttpRequest(
  req: express.Request
): Promise<{ userId: string; via: 'firebase' | 'demo' } | null> {
  const authz = req.headers['authorization'];
  if (typeof authz === 'string' && authz.startsWith('Bearer ')) {
    const v = await verifyFirebaseIdToken(authz.slice(7).trim());
    if (v) return { userId: v.uid, via: 'firebase' };
    return null;
  }
  if (DEMO_AUTH) {
    const demoUser = req.headers['x-demo-user'];
    if (typeof demoUser === 'string' && demoUser) {
      return { userId: demoUser, via: 'demo' };
    }
  }
  return null;
}

function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  authenticateHttpRequest(req)
    .then((auth) => {
      if (!auth) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      (req as any).authUserId = auth.userId;
      (req as any).authVia = auth.via;
      next();
    })
    .catch(() => res.status(401).json({ error: 'Authentication required' }));
}

// -------------------------------------------------------------
// Mega Round — In-memory sliding-window rate limiter
// -------------------------------------------------------------
const rateLimitBuckets = new Map<string, number[]>();
function isRateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const windowStart = now - windowMs;
  const hits = (rateLimitBuckets.get(key) || []).filter((t) => t > windowStart);
  if (hits.length >= limit) {
    rateLimitBuckets.set(key, hits);
    return true;
  }
  hits.push(now);
  rateLimitBuckets.set(key, hits);
  return false;
}

// -------------------------------------------------------------
// Phase 0.6/0.11 — Stories + Blocks/Reports stores
// -------------------------------------------------------------
interface ServerStory {
  id: string;
  userId: string;
  userName: string;
  userAvatar: string;
  media: string;
  type: 'image' | 'text';
  text?: string;
  createdAt: number;
  expiresAt: number;
  viewers: { userId: string; viewedAt: number }[];
  /** Phase 1: audience, kind, text styling, reactions. */
  audience?: { mode: 'everyone' | 'contacts' | 'close' | 'custom'; userIds?: string[] };
  kind?: 'image' | 'text' | 'video';
  textData?: { text: string; bg: string; font: string };
  reactions?: { userId: string; emoji: string }[];
}
const serverStories = new Map<string, ServerStory>();

/** blockedBy: userId -> set of userIds they have blocked. */
const blockedBy = new Map<string, Set<string>>();
interface ReportRecord {
  id: string;
  reporterId: string;
  reportedId: string;
  reason?: string;
  createdAt: number;
}
const reportRecords: ReportRecord[] = [];

function isBlockedBetween(a: string, b: string): boolean {
  return !!blockedBy.get(a)?.has(b) || !!blockedBy.get(b)?.has(a);
}

// -------------------------------------------------------------
// Phase 1 — Directory, usernames, scheduled, reminders, stars,
// call logs, story mutes/highlights, devices, last-seen
// -------------------------------------------------------------
export interface PrivacySettings {
  photo?: string;
  about?: string;
  lastSeen?: string;
  findMe?: string;
  groupAdd?: string;
}
interface DirectoryEntry {
  id: string;
  name: string;
  username?: string;
  avatar?: string;
  about?: string;
  mood?: string;
  discoverable?: boolean;
  privacy?: PrivacySettings;
  updatedAt: number;
}
const directory = new Map<string, DirectoryEntry>();
/** handle (lowercase) -> owner userId */
const usernames = new Map<string, string>();
/** handle -> previous owner + grace expiry (14 days) */
const releasedHandles = new Map<string, { userId: string; releasedAt: number; expiresAt: number }>();

interface ScheduledItem {
  id: string;
  ownerId: string;
  roomId: string;
  message: any;
  dueAt: number;
  status: 'pending' | 'sent' | 'failed';
  createdAt: number;
  messageId?: string;
  failReason?: string;
}
const scheduledItems: ScheduledItem[] = [];

interface ReminderItem {
  id: string;
  ownerId: string;
  roomId: string;
  messageId: string;
  dueAt: number;
  status: 'pending' | 'done';
  createdAt: number;
}
const reminderItems: ReminderItem[] = [];

/** userId -> message snapshots */
const starsByUser = new Map<string, any[]>();
/** userId -> call log entries (newest last) */
const callLogsByUser = new Map<string, any[]>();
/** userId -> muted story author ids */
const storyMutes = new Map<string, Set<string>>();
/** userId -> highlight snapshots */
const highlightsByUser = new Map<string, any[]>();
/** userId -> device labels already seen (login alerts fire once per label) */
const seenDevices = new Map<string, Set<string>>();
/** userId -> last offline timestamp (ms) */
const userLastSeen = new Map<string, number>();
/** userId -> last known email (from verified token), for login alerts */
const userEmails = new Map<string, string>();

const RESERVED_USERNAMES = new Set([
  'admin', 'support', 'chitthi', 'team', 'official', 'maruf', 'help',
  'system', 'root', 'null', 'undefined', 'about', 'login', 'signup',
  'settings', 'api', 'www',
]);
const HANDLE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

function validateHandleFormat(handle: string): boolean {
  if (typeof handle !== 'string') return false;
  if (handle.length < 5 || handle.length > 20) return false;
  if (!/^[a-z][a-z0-9_]*$/.test(handle)) return false;
  if (handle.endsWith('_')) return false;
  if (handle.includes('__')) return false;
  return true;
}

/** Availability of `handle` for `callerId` (null caller = anonymous check). */
function handleAvailability(
  handle: string,
  callerId: string | null
): { available: boolean; reason?: 'format' | 'reserved' | 'taken' | 'grace' } {
  if (!validateHandleFormat(handle)) return { available: false, reason: 'format' };
  if (RESERVED_USERNAMES.has(handle)) return { available: false, reason: 'reserved' };
  const owner = usernames.get(handle);
  if (owner) {
    if (callerId && owner === callerId) return { available: true };
    return { available: false, reason: 'taken' };
  }
  const rel = releasedHandles.get(handle);
  if (rel && rel.expiresAt > Date.now()) {
    if (callerId && rel.userId === callerId) return { available: true };
    return { available: false, reason: 'grace' };
  }
  return { available: true };
}

function handleOwnedBy(userId: string): string | undefined {
  for (const [h, uid] of usernames.entries()) if (uid === userId) return h;
  return undefined;
}

/** "Contacts" approximation per contract: shared channel co-membership. */
function areCoMembers(a: string, b: string): boolean {
  if (a === b) return true;
  for (const ch of serverChannels.values()) {
    const ids = new Set<string>([
      ...(ch.memberIds || []),
      ...(ch.adminIds || []),
      ...(ch.ownerId ? [ch.ownerId] : []),
    ]);
    if (ids.has(a) && ids.has(b)) return true;
  }
  return false;
}

function privacyAllows(
  setting: string | undefined,
  subjectId: string,
  viewerId: string
): boolean {
  const s = setting || 'everyone';
  if (subjectId === viewerId) return true;
  if (s === 'everyone') return true;
  if (s === 'nobody') return false;
  if (s === 'contacts') return areCoMembers(subjectId, viewerId);
  return true;
}

/** Send a WS payload to every live socket belonging to `userId`. */
function sendToUser(userId: string, data: any) {
  const payload = JSON.stringify(data);
  for (const [ws, session] of clients.entries()) {
    if (ws.readyState === WebSocket.OPEN && session.userId === userId) {
      try { ws.send(payload); } catch { /* ignore */ }
    }
  }
}

// -------------------------------------------------------------
// Disk persistence (Task C): roomMessages + serverChannels live in Maps,
// but are snapshotted to disk so they survive a server restart.
// 2FA codes intentionally do NOT persist (short-lived, security-sensitive).
// -------------------------------------------------------------
// On Azure, CHITTHI_DATA_DIR can point at a persistent folder outside the
// deployment directory so redeploys never wipe chat history.
const STORE_DIR = process.env.CHITTHI_DATA_DIR || path.join(__dirname, 'data');
const STORE_PATH = path.join(STORE_DIR, 'store.json');
let saveTimer: any = null;

function scheduleStoreSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveStoreNow, 500);
}

function saveStoreNow() {
  saveTimer = null;
  try {
    if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
    const snapshot = {
      version: 1,
      savedAt: Date.now(),
      channels: Array.from(serverChannels.values()),
      messages: Object.fromEntries(roomMessages),
      stories: Array.from(serverStories.values()),
      blocks: Object.fromEntries(
        Array.from(blockedBy.entries()).map(([k, v]) => [k, Array.from(v)])
      ),
      reports: reportRecords,
      directory: Array.from(directory.values()),
      usernames: Object.fromEntries(usernames),
      releasedHandles: Object.fromEntries(releasedHandles),
      scheduled: scheduledItems,
      reminders: reminderItems,
      stars: Object.fromEntries(starsByUser),
      callLogs: Object.fromEntries(callLogsByUser),
      storyMutes: Object.fromEntries(
        Array.from(storyMutes.entries()).map(([k, v]) => [k, Array.from(v)])
      ),
      highlights: Object.fromEntries(highlightsByUser),
      seenDevices: Object.fromEntries(
        Array.from(seenDevices.entries()).map(([k, v]) => [k, Array.from(v)])
      ),
      userLastSeen: Object.fromEntries(userLastSeen),
      userEmails: Object.fromEntries(userEmails),
    };
    const tmpPath = STORE_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(snapshot), 'utf8');
    if (fs.existsSync(STORE_PATH)) {
      // Only a parseable main file may become the backup — copying a corrupt
      // store.json over .bak would destroy the last good snapshot.
      try {
        JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
        fs.copyFileSync(STORE_PATH, STORE_PATH + '.bak');
      } catch { /* backup is best-effort; never back up a corrupt file */ }
    }
    fs.renameSync(tmpPath, STORE_PATH);
  } catch (err) {
    console.warn('Store snapshot failed:', err);
  }
}

function loadStore() {
  // Backup recovery: a corrupt main store must not mean total data loss when
  // the .bak snapshot is still valid — restore from it before loading.
  try {
    if (fs.existsSync(STORE_PATH)) {
      try {
        JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
      } catch {
        const bakPath = STORE_PATH + '.bak';
        if (fs.existsSync(bakPath)) {
          JSON.parse(fs.readFileSync(bakPath, 'utf8')); // validate before restoring
          fs.copyFileSync(bakPath, STORE_PATH);
          console.warn('Store file corrupt — restored from store.json.bak backup.');
        }
      }
    }
  } catch { /* no usable backup — the load below logs and starts fresh */ }
  try {
    if (!fs.existsSync(STORE_PATH)) {
      console.log('No store file found — starting empty (no seeded data).');
      return;
    }
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const snap = JSON.parse(raw);
    if (Array.isArray(snap.channels)) {
      for (const ch of snap.channels) {
        if (ch && ch.id) serverChannels.set(ch.id, ch);
      }
    }
    if (snap.messages && typeof snap.messages === 'object') {
      for (const [roomId, msgs] of Object.entries(snap.messages)) {
        // Phase 1 cap lift: ALL messages are retained (no destructive trim).
        if (Array.isArray(msgs)) roomMessages.set(roomId, msgs);
      }
    }
    if (Array.isArray(snap.stories)) {
      const now = Date.now();
      for (const st of snap.stories) {
        if (st && st.id && st.expiresAt > now) serverStories.set(st.id, st);
      }
    }
    if (snap.blocks && typeof snap.blocks === 'object') {
      for (const [uid, list] of Object.entries(snap.blocks)) {
        if (Array.isArray(list)) {
          blockedBy.set(uid, new Set(list.filter((x) => typeof x === 'string')));
        }
      }
    }
    if (Array.isArray(snap.reports)) {
      for (const r of snap.reports) if (r && r.id) reportRecords.push(r);
    }
    if (Array.isArray(snap.directory)) {
      for (const d of snap.directory) if (d && d.id) directory.set(d.id, d);
    }
    if (snap.usernames && typeof snap.usernames === 'object') {
      for (const [h, uid] of Object.entries(snap.usernames)) {
        if (typeof uid === 'string') usernames.set(h, uid);
      }
    }
    if (snap.releasedHandles && typeof snap.releasedHandles === 'object') {
      for (const [h, rel] of Object.entries(snap.releasedHandles) as any) {
        if (rel && typeof rel.userId === 'string') releasedHandles.set(h, rel);
      }
    }
    if (Array.isArray(snap.scheduled)) {
      for (const s of snap.scheduled) if (s && s.id) scheduledItems.push(s);
    }
    if (Array.isArray(snap.reminders)) {
      for (const r of snap.reminders) if (r && r.id) reminderItems.push(r);
    }
    if (snap.stars && typeof snap.stars === 'object') {
      for (const [uid, list] of Object.entries(snap.stars)) {
        if (Array.isArray(list)) starsByUser.set(uid, list);
      }
    }
    if (snap.callLogs && typeof snap.callLogs === 'object') {
      for (const [uid, list] of Object.entries(snap.callLogs)) {
        if (Array.isArray(list)) callLogsByUser.set(uid, list);
      }
    }
    if (snap.storyMutes && typeof snap.storyMutes === 'object') {
      for (const [uid, list] of Object.entries(snap.storyMutes)) {
        if (Array.isArray(list)) storyMutes.set(uid, new Set(list.filter((x: any) => typeof x === 'string')));
      }
    }
    if (snap.highlights && typeof snap.highlights === 'object') {
      for (const [uid, list] of Object.entries(snap.highlights)) {
        if (Array.isArray(list)) highlightsByUser.set(uid, list);
      }
    }
    if (snap.seenDevices && typeof snap.seenDevices === 'object') {
      for (const [uid, list] of Object.entries(snap.seenDevices)) {
        if (Array.isArray(list)) seenDevices.set(uid, new Set(list.filter((x: any) => typeof x === 'string')));
      }
    }
    if (snap.userLastSeen && typeof snap.userLastSeen === 'object') {
      for (const [uid, ts] of Object.entries(snap.userLastSeen)) {
        if (typeof ts === 'number') userLastSeen.set(uid, ts);
      }
    }
    if (snap.userEmails && typeof snap.userEmails === 'object') {
      for (const [uid, em] of Object.entries(snap.userEmails)) {
        if (typeof em === 'string') userEmails.set(uid, em);
      }
    }
    console.log(
      `Loaded store from disk: ${serverChannels.size} channel(s), ${roomMessages.size} room(s) with history.`
    );
  } catch (err) {
    // A corrupt store file must never crash the server — log and continue empty.
    console.warn('Could not load store file, starting fresh:', err);
  }
}

// Load persisted data. There are no seeded defaults (Phase 0.4): a fresh
// install starts with zero channels, zero messages, zero stories.
loadStore();

const server = http.createServer(app);
// maxPayload caps a single WS frame (default is 100MB — a disk-fill / memory
// DoS vector, security lab finding). 12MB still fits photo data-URL messages.
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 12 * 1024 * 1024 });

function broadcast(data: any, filter?: (client: ClientSession) => boolean) {
  const messageStr = JSON.stringify(data);
  for (const [ws, session] of clients.entries()) {
    if (ws.readyState === WebSocket.OPEN) {
      if (!filter || filter(session)) {
        try {
          ws.send(messageStr);
        } catch (err) {
          console.error('Error broadcasting message:', err);
        }
      }
    }
  }
}

// -------------------------------------------------------------
// Phase 0.1/0.3 — Room access control + per-recipient serialisation
// -------------------------------------------------------------
/** DM room ids are `[idA, idB].sort().join('__')` (see client Sidebar/App). */
function dmPeerOf(roomId: string, userId: string): string | null {
  if (serverChannels.has(roomId)) return null;
  const parts = roomId.split('__');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (parts[0] === userId) return parts[1];
  if (parts[1] === userId) return parts[0];
  return null;
}

function canAccessRoom(session: ClientSession, roomId: string): boolean {
  if (!session.userId) return false;
  if (roomId === 'saved_messages') return false; // local-only, never relayed
  const ch = serverChannels.get(roomId);
  if (ch) {
    const members = ch.memberIds;
    if (members && members.length > 0) {
      return (
        members.includes(session.userId) ||
        ch.ownerId === session.userId ||
        (ch.adminIds || []).includes(session.userId)
      );
    }
    return true; // legacy/open channel without a member list
  }
  const parts = roomId.split('__');
  if (parts.length === 2 && parts[0] && parts[1]) {
    return parts[0] === session.userId || parts[1] === session.userId;
  }
  return true; // unknown/ad-hoc room: any authenticated session (join is logged)
}

/** Poll anonymity (0.3): non-privileged recipients never receive voterIds. */
function serializeMessageFor(
  msg: MessagePayload,
  session: ClientSession
): MessagePayload {
  if (!msg.poll || !Array.isArray(msg.poll.options)) return msg;
  const ch = serverChannels.get(msg.roomId);
  const privileged =
    session.userId === msg.senderId ||
    (ch && ch.ownerId === session.userId) ||
    (ch && (ch.adminIds || []).includes(session.userId || ''));
  if (privileged) return msg;
  return {
    ...msg,
    poll: {
      ...msg.poll,
      options: msg.poll.options.map((o: any) => ({
        ...o,
        voterCount: Array.isArray(o.voterIds) ? o.voterIds.length : o.voterCount || 0,
        voterIds: [],
      })),
    },
  };
}

/**
 * Deliver a room event to every session with room access (per-recipient
 * serialisation). Returns the set of user IDs (excluding the sender) whose
 * open sockets actually received a `message:new` — used for receipts.
 */
function deliverToRoom(
  data: any,
  roomId: string,
  opts?: { excludeWs?: WebSocket; messageForReceipts?: MessagePayload }
): Set<string> {
  const delivered = new Set<string>();
  for (const [ws, session] of clients.entries()) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (opts?.excludeWs && ws === opts.excludeWs) continue;
    if (!canAccessRoom(session, roomId)) continue;
    let payload = data;
    if (data && data.message) {
      payload = { ...data, message: serializeMessageFor(data.message, session) };
    }
    try {
      ws.send(JSON.stringify(payload));
      if (
        opts?.messageForReceipts &&
        session.userId &&
        session.userId !== opts.messageForReceipts.senderId
      ) {
        delivered.add(session.userId);
      }
    } catch (err) {
      console.error('Error delivering to room:', err);
    }
  }
  return delivered;
}

/** Remove expired (disappearing) messages from a room; true if any purged. */
function purgeExpiredMessages(roomId: string): boolean {
  const list = roomMessages.get(roomId);
  if (!list || !list.length) return false;
  const now = Date.now();
  const kept = list.filter((m) => !m.expiresAt || m.expiresAt > now);
  if (kept.length !== list.length) {
    roomMessages.set(roomId, kept);
    return true;
  }
  return false;
}

/**
 * Phase 1 presence: per-viewer snapshot. Invisible users appear offline to
 * everyone else; `lastSeenAt` is attached to a subject's entry only when the
 * subject's privacy.lastSeen allows that viewer.
 */
function presenceListFor(viewer: ClientSession): any[] {
  const viewerId = viewer.userId!;
  const out: any[] = [];
  const seenUsers = new Set<string>();
  for (const s of clients.values()) {
    if (!s.userId) continue;
    // One entry per user (first live session wins), except the viewer sees
    // their own entry from their own session.
    if (s.userId !== viewerId && seenUsers.has(s.userId)) continue;
    if (s.userId === viewerId && s.ws !== viewer.ws) continue;
    seenUsers.add(s.userId);
    const invisible = s.presenceMode === 'invisible' && s.userId !== viewerId;
    const entry: any = {
      id: s.userId,
      name: s.username,
      online: !invisible,
      presence: invisible ? 'offline' : s.presenceMode === 'away' ? 'away' : 'online',
      lastActive: s.lastActive,
    };
    const subjPrivacy = directory.get(s.userId)?.privacy;
    const lastSeen = userLastSeen.get(s.userId);
    if (!invisible && privacyAllows(subjPrivacy?.lastSeen, s.userId, viewerId)) {
      // Online subjects: lastSeenAt = their last activity; offline-capable
      // viewers may also receive the stored last-seen when present.
      entry.lastSeenAt = lastSeen || s.lastActive;
    } else if (invisible && lastSeen && privacyAllows(subjPrivacy?.lastSeen, s.userId, viewerId)) {
      entry.lastSeenAt = lastSeen;
    }
    out.push(entry);
  }
  return out;
}

function broadcastPresence() {
  for (const [ws, session] of clients.entries()) {
    if (ws.readyState !== WebSocket.OPEN || !session.userId) continue;
    try {
      ws.send(
        JSON.stringify({ type: 'presence:update', users: presenceListFor(session) })
      );
    } catch { /* ignore */ }
  }
}

/**
 * Phase 1 login alert: first-seen deviceLabel for a user -> best-effort
 * email via the existing SMTP setup. Silent skip when SMTP is unconfigured
 * or the user's email is unknown.
 */
async function maybeSendLoginAlert(userId: string, deviceLabel: string) {
  try {
    if (!deviceLabel) return;
    if (!seenDevices.has(userId)) seenDevices.set(userId, new Set());
    const seen = seenDevices.get(userId)!;
    if (seen.has(deviceLabel)) return;
    seen.add(deviceLabel);
    scheduleStoreSave();
    if (!isSmtpConfigured()) return; // silent skip
    const email = userEmails.get(userId);
    if (!email) return; // nowhere to send — silent skip
    const transporter = await getTransporter();
    await transporter.sendMail({
      from: '"Chitthi Security" <security@chitthi.app>',
      to: email,
      subject: 'New sign-in to your Chitthi account',
      text: `A new device ("${deviceLabel}") just signed in to your Chitthi account at ${new Date().toISOString()}. If this wasn't you, revoke the session from Settings > Sessions.`,
    });
  } catch (err) {
    console.warn('[login-alert] best-effort email failed:', err);
  }
}

/**
 * Phase 1 channel send-path enforcement. Returns a drop reason or null.
 * readOnly sections and permissions.post==='admins' block non-privileged
 * senders (privileged = owner or admin).
 */
function channelSendBlockReason(
  ch: ServerChannel,
  sectionId: string | undefined,
  userId: string
): string | null {
  const privileged = ch.ownerId === userId || (ch.adminIds || []).includes(userId);
  if (privileged) return null;
  if (ch.permissions && ch.permissions.post === 'admins') return 'channel_admins_only';
  if (sectionId && Array.isArray(ch.sections)) {
    const sec = ch.sections.find((s: any) => s && s.id === sectionId);
    if (sec && sec.readOnly) return 'section_read_only';
  }
  return null;
}

/** Emit a receipts update to every session of the message's sender. */
function emitReceipts(msg: MessagePayload) {
  const payload = JSON.stringify({
    type: 'message:receipts',
    roomId: msg.roomId,
    messageId: msg.id,
    deliveredTo: msg.deliveredTo || [],
    readBy: msg.readBy || [],
  });
  for (const [ws, session] of clients.entries()) {
    if (ws.readyState === WebSocket.OPEN && session.userId === msg.senderId) {
      try {
        ws.send(payload);
      } catch {
        /* ignore */
      }
    }
  }
}

// -------------------------------------------------------------
// Two-Factor Authentication (2FA) Email Dispatch System
// -------------------------------------------------------------
let cachedTransporter: any = null;

// Whether real email delivery is configured. Without SMTP env, the transporter
// falls back to ethereal/json transport and the email is NOT really delivered
// to the user's inbox — the API must be honest about that (demo mode).
function isSmtpConfigured(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

// Rate limit for 2FA code requests: max 5 per email per rolling hour.
const otpRequestLog = new Map<string, number[]>();
function isOtpRateLimited(cleanEmail: string): boolean {
  const now = Date.now();
  const windowStart = now - 60 * 60 * 1000;
  const hits = (otpRequestLog.get(cleanEmail) || []).filter((t) => t > windowStart);
  if (hits.length >= 5) {
    otpRequestLog.set(cleanEmail, hits);
    return true;
  }
  hits.push(now);
  otpRequestLog.set(cleanEmail, hits);
  return false;
}

async function getTransporter(): Promise<any> {
  if (cachedTransporter) return cachedTransporter;

  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    cachedTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
    return cachedTransporter;
  }

  // Fallback to test ethereal email transport
  try {
    const testAccount = await nodemailer.createTestAccount();
    cachedTransporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: {
        user: testAccount.user,
        pass: testAccount.pass,
      },
    });
    return cachedTransporter;
  } catch (err) {
    console.warn('Could not create ethereal test account, using json transport:', err);
    cachedTransporter = nodemailer.createTransport({
      jsonTransport: true,
    });
    return cachedTransporter;
  }
}

// API: Send 2FA verification code to user email
// The code is ALWAYS generated server-side. Any `code` supplied by the client
// is ignored — accepting client-supplied codes would let an attacker pick a
// known code and bypass 2FA.
app.post('/api/auth/send-2fa-code', async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Valid email address is required' });
    }

    const cleanEmail = email.toLowerCase().trim();

    // Rate limit: max 5 code requests per email per hour.
    if (isOtpRateLimited(cleanEmail)) {
      return res
        .status(429)
        .json({ error: 'Too many code requests. Please try again in about an hour.' });
    }

    const code = randomInt(100000, 1000000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes expiry

    // Save record (a fresh code resets the brute-force attempt counter)
    twoFactorAttempts.delete(cleanEmail);
    twoFactorCodes.set(cleanEmail, {
      email: cleanEmail,
      name: name || cleanEmail.split('@')[0],
      code,
      expiresAt,
      createdAt: Date.now(),
      verified: false,
    });

    const delivery: 'email' | 'demo' = isSmtpConfigured() ? 'email' : 'demo';
    let previewUrl: string | false = false;
    let emailSent = false;

    try {
      const transporter = await getTransporter();
      const mailOptions = {
        from: '"Chitthi Security" <security@chitthi.app>',
        to: cleanEmail,
        subject: `Your Chitthi Email Verification Code: ${code}`,
        text: `Hello ${name || 'User'},\n\nYour email verification code for Chitthi is: ${code}\n\nThis code will expire in 10 minutes. Please enter or paste this code in the app to activate your account.\n\nThank you,\nChitthi Team`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px; background-color: #ffffff;">
            <div style="text-align: center; margin-bottom: 24px;">
              <h2 style="color: #2563eb; margin: 0; font-size: 24px;">চিঠি · Chitthi Messenger</h2>
              <p style="color: #64748b; font-size: 13px; margin-top: 4px;">Email Verification</p>
            </div>
            <p style="color: #334155; font-size: 15px;">Hello <strong>${name || 'User'}</strong>,</p>
            <p style="color: #475569; font-size: 14px; line-height: 1.5;">
              Use the following 6-digit email verification code to complete your account registration and log in:
            </p>
            <div style="text-align: center; margin: 28px 0;">
              <div style="display: inline-block; font-family: monospace; font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #4f46e5; background: #eef2ff; border: 1px solid #c7d2fe; border-radius: 12px; padding: 12px 28px;">
                ${code}
              </div>
            </div>
            <p style="color: #64748b; font-size: 13px; text-align: center;">
              This code will expire in <strong>10 minutes</strong>. Do not share this code with anyone.
            </p>
            <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
            <p style="color: #94a3b8; font-size: 11px; text-align: center; margin: 0;">
              If you did not request this code, you can safely ignore this email.
            </p>
          </div>
        `,
      };

      const info = await transporter.sendMail(mailOptions);
      emailSent = true;
      previewUrl = nodemailer.getTestMessageUrl(info);
    } catch (mailErr) {
      console.warn('Mail transporter notice:', mailErr);
    }

    // NOTE on response honesty: when real SMTP is configured the code is
    // delivered only via the user's email and is NEVER included here.
    // Without SMTP configured, no real email leaves the server (the transport
    // falls back to ethereal/json). Phase 0.1: the code is included in the
    // demo response ONLY behind the explicit CHITTHI_DEMO_OTP=true env flag,
    // and never in production builds. Otherwise the response honestly states
    // the code was generated but not delivered and not disclosed.
    const DEMO_OTP =
      process.env.CHITTHI_DEMO_OTP === 'true' &&
      process.env.NODE_ENV !== 'production';
    if (delivery === 'demo' && DEMO_OTP) {
      console.warn(
        `[email verification demo mode] No SMTP configured — email NOT actually delivered to ${cleanEmail}. Code returned in response because CHITTHI_DEMO_OTP=true (local demo only).`
      );
      return res.json({
        success: true,
        email: cleanEmail,
        delivery,
        code,
        expiresAt,
        emailSent: false,
        previewUrl: previewUrl || undefined,
        message: `Verification code generated for ${cleanEmail} (demo mode — no SMTP configured, no real email sent)`,
      });
    }
    if (delivery === 'demo') {
      console.warn(
        `[email verification] No SMTP configured — code for ${cleanEmail} generated but NOT delivered and NOT included in the response (set CHITTHI_DEMO_OTP=true for local demo testing).`
      );
      return res.json({
        success: true,
        email: cleanEmail,
        delivery,
        expiresAt,
        emailSent: false,
        previewUrl: previewUrl || undefined,
        message: `Verification code generated for ${cleanEmail}, but no email could be delivered because the server has no SMTP configured.`,
      });
    }

    return res.json({
      success: true,
      email: cleanEmail,
      delivery,
      expiresAt,
      emailSent,
      previewUrl: previewUrl || undefined,
      message: `Verification code successfully dispatched to ${cleanEmail}`,
    });
  } catch (err: any) {
    console.error('Error sending verification code:', err);
    return res.status(500).json({ error: 'Failed to dispatch verification code' });
  }
});

// API: Verify 2FA verification code
app.post('/api/auth/verify-2fa-code', (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ valid: false, error: 'Email and code are required' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const record = twoFactorCodes.get(cleanEmail);

    if (!record) {
      return res.status(400).json({
        valid: false,
        error: 'No verification code found for this email. Please request a new code.',
      });
    }

    if (record.code !== String(code).trim()) {
      const attempts = (twoFactorAttempts.get(cleanEmail) || 0) + 1;
      twoFactorAttempts.set(cleanEmail, attempts);
      if (attempts >= 10) {
        // Burn the code: too many wrong guesses. A fresh code must be requested.
        twoFactorCodes.delete(cleanEmail);
        twoFactorAttempts.delete(cleanEmail);
        return res.status(400).json({
          valid: false,
          error: 'Too many incorrect attempts. Please request a new code.',
        });
      }
      return res.status(400).json({
        valid: false,
        error: 'Invalid verification code. Please enter the correct 6-digit code.',
      });
    }

    if (Date.now() > record.expiresAt) {
      return res.status(400).json({
        valid: false,
        error: 'This verification code has expired. Please click "Resend Code".',
      });
    }

    // Consume the code on success: it must never verify twice (security lab
    // finding — a correct code stayed valid for its full 10-minute window).
    twoFactorCodes.delete(cleanEmail);
    twoFactorAttempts.delete(cleanEmail);
    return res.json({
      valid: true,
      email: cleanEmail,
      message: 'Email verification successful',
    });
  } catch (err: any) {
    return res.status(500).json({ valid: false, error: 'Verification error' });
  }
});

// API: Get Channels with server-authoritative timestamps
app.get('/api/channels', (_req, res) => {
  const channels = Array.from(serverChannels.values()).sort(
    (a, b) => b.lastMessageTimestamp - a.lastMessageTimestamp
  );
  res.json({ channels });
});

/**
 * Addendum (Team GI): narrow member self-service updates. A non-privileged
 * MEMBER may update a channel only when the diff versus the stored channel
 * is confined to: removing their own id from memberIds/adminIds/
 * memberRoles/joinRequests (leave group), and/or the events field (event
 * creation + RSVP writes live in events[].rsvps). Anything else -> 403.
 */
function isRemovalOnlyList(oldList: any, newList: any, callerId: string): boolean {
  if (newList === undefined) return true; // omitted -> server keeps existing
  if (!Array.isArray(newList)) return false;
  const oldArr: any[] = Array.isArray(oldList) ? oldList : [];
  if (newList.includes(callerId)) return false; // must actually remove self
  const removed = oldArr.filter((x) => !newList.includes(x));
  if (removed.some((x) => x !== callerId)) return false; // removed someone else
  if (newList.some((x) => !oldArr.includes(x))) return false; // added someone
  return true;
}

function isMemberOnlyUpdateAllowed(existing: ServerChannel, data: any, callerId: string): boolean {
  const ex: any = existing as any;
  const isMember =
    (existing.memberIds || []).includes(callerId) ||
    (ex.memberRoles && typeof ex.memberRoles === 'object' && callerId in ex.memberRoles);
  if (!isMember) return false;
  // Server-managed fields are overwritten after this check; ignore them.
  const serverManaged = new Set(['ownerId', 'createdAt', 'membersCount', 'lastMessageTimestamp']);
  const keys = new Set([...Object.keys(ex), ...Object.keys(data || {})]);
  for (const key of keys) {
    if (serverManaged.has(key)) continue;
    const incoming = data ? data[key] : undefined;
    if (incoming === undefined) continue; // omitted -> preserved, no change
    if (JSON.stringify(incoming) === JSON.stringify(ex[key])) continue; // unchanged
    if (key === 'memberIds' || key === 'adminIds' || key === 'joinRequests') {
      if (!isRemovalOnlyList(ex[key], incoming, callerId)) return false;
      continue;
    }
    if (key === 'memberRoles') {
      // Only change allowed: caller's own entry removed.
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return false;
      if (callerId in incoming) return false;
      const oldRoles = ex.memberRoles && typeof ex.memberRoles === 'object' ? ex.memberRoles : {};
      const changed = new Set([...Object.keys(oldRoles), ...Object.keys(incoming)]);
      let bad = false;
      for (const rk of changed) {
        if (rk === callerId) continue;
        if (JSON.stringify(incoming[rk]) !== JSON.stringify(oldRoles[rk])) { bad = true; break; }
      }
      if (bad) return false;
      continue;
    }
    if (key === 'events') continue; // event creation + RSVPs
    return false; // any other field change is privileged
  }
  return true;
}

// API: Create or update Channel with immutable real createdAt.
// Phase 0.1/0.3: writes require authentication (Firebase ID token, or the
// demo header in local demo mode). The creator is recorded as owner; updates
// are restricted to the owner/admins. Membership is stored as user IDs.
app.post('/api/channels', requireAuth, (req, res) => {
  try {
    if (isRateLimited(`channels:${req.ip || 'unknown'}`, 30, 60 * 1000)) {
      return res.status(429).json({ error: 'rate_limited' });
    }
    const callerId = (req as any).authUserId as string;
    const channelData = req.body;
    if (!channelData || !channelData.name) {
      return res.status(400).json({ error: 'Channel name is required' });
    }
    if (typeof channelData.name !== 'string' || channelData.name.length > 120) {
      return res.status(400).json({ error: 'Channel name is too long' });
    }

    const now = Date.now();
    const id = channelData.id || `group_${now}`;

    const existing = serverChannels.get(id);
    if (!existing && serverChannels.size >= 500) {
      return res.status(429).json({ error: 'Channel limit reached on this server' });
    }
    if (existing && existing.ownerId) {
      const isOwner = existing.ownerId === callerId;
      const isAdmin = (existing.adminIds || []).includes(callerId);
      if (!isOwner && !isAdmin && !isMemberOnlyUpdateAllowed(existing, channelData, callerId)) {
        return res
          .status(403)
          .json({ error: 'Only the group owner or admins can update this channel' });
      }
    }
    // Preserve existing createdAt if channel already exists
    const createdAt = existing ? existing.createdAt : (channelData.createdAt || now);

    // Sanitise membership: user IDs only, owner always a member.
    const memberIds: string[] | undefined = Array.isArray(channelData.memberIds)
      ? Array.from(
          new Set(
            channelData.memberIds.filter(
              (m: any) => typeof m === 'string' && m.length > 0
            )
          )
        )
      : existing?.memberIds;
    const ownerId = existing?.ownerId || callerId;
    if (memberIds && !memberIds.includes(ownerId)) memberIds.unshift(ownerId);
    const adminIds: string[] | undefined = Array.isArray(channelData.adminIds)
      ? channelData.adminIds.filter((m: any) => typeof m === 'string')
      : existing?.adminIds;

    const channel: ServerChannel = {
      ...channelData,
      id,
      createdAt,
      ownerId,
      memberIds,
      adminIds,
      // Phase 1 fields: preserve existing values when the update omits them.
      inviteCode:
        channelData.inviteCode !== undefined ? channelData.inviteCode : existing?.inviteCode,
      inviteEnabled:
        channelData.inviteEnabled !== undefined ? channelData.inviteEnabled : existing?.inviteEnabled,
      joinApproval:
        channelData.joinApproval !== undefined ? channelData.joinApproval : existing?.joinApproval,
      joinRequests: Array.isArray(channelData.joinRequests)
        ? channelData.joinRequests.filter((m: any) => typeof m === 'string')
        : existing?.joinRequests,
      permissions:
        channelData.permissions && typeof channelData.permissions === 'object'
          ? channelData.permissions
          : existing?.permissions,
      events: Array.isArray(channelData.events) ? channelData.events : existing?.events,
      sections: Array.isArray(channelData.sections) ? channelData.sections : existing?.sections,
      membersCount:
        memberIds && memberIds.length
          ? memberIds.length
          : channelData.membersCount,
      lastMessageTimestamp: channelData.lastMessageTimestamp || now,
    };

    serverChannels.set(id, channel);

    // Persist to disk (debounced)
    scheduleStoreSave();

    // Upsert broadcast: members only when a member list exists, else everyone.
    broadcast({ type: 'channel:created', channel }, (s) =>
      memberIds && memberIds.length
        ? !!s.userId &&
          (memberIds.includes(s.userId) ||
            ownerId === s.userId ||
            (adminIds || []).includes(s.userId))
        : !!s.userId
    );

    res.json({ success: true, channel });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to save channel' });
  }
});

// -------------------------------------------------------------
// Phase 0.6 — Stories API (server-synced, per-user, 24h expiry)
// -------------------------------------------------------------
function storyVisibleTo(st: ServerStory, callerId: string): boolean {
  if (st.userId === callerId) return true;
  if (isBlockedBetween(callerId, st.userId)) return false;
  if (storyMutes.get(callerId)?.has(st.userId)) return false;
  const aud = st.audience;
  if (!aud || !aud.mode || aud.mode === 'everyone') return true;
  if (aud.mode === 'contacts') return areCoMembers(st.userId, callerId);
  if (aud.mode === 'close' || aud.mode === 'custom') {
    return Array.isArray(aud.userIds) && aud.userIds.includes(callerId);
  }
  return true;
}

app.get('/api/stories', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const now = Date.now();
  let purged = false;
  for (const [sid, st] of serverStories.entries()) {
    if (st.expiresAt <= now) {
      serverStories.delete(sid);
      purged = true;
    }
  }
  if (purged) scheduleStoreSave();
  const stories = Array.from(serverStories.values())
    .filter((st) => storyVisibleTo(st, callerId))
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json({ stories });
});

// Story mutes — defined before /api/stories/:id routes so 'mutes' is not
// captured as a story id.
app.get('/api/stories/mutes', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  res.json({ muted: Array.from(storyMutes.get(callerId) || []) });
});

app.post('/api/stories/mutes', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const userId = typeof req.body?.userId === 'string' ? req.body.userId : '';
  if (!userId || userId === callerId) return res.status(400).json({ error: 'Valid userId is required' });
  if (!storyMutes.has(callerId)) storyMutes.set(callerId, new Set());
  storyMutes.get(callerId)!.add(userId);
  scheduleStoreSave();
  res.json({ success: true, muted: Array.from(storyMutes.get(callerId)!) });
});

app.delete('/api/stories/mutes', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const userId = typeof req.body?.userId === 'string' ? req.body.userId : '';
  if (userId) storyMutes.get(callerId)?.delete(userId);
  scheduleStoreSave();
  res.json({ success: true, muted: Array.from(storyMutes.get(callerId) || []) });
});

app.delete('/api/stories/mutes/:userId', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  storyMutes.get(callerId)?.delete(req.params.userId);
  scheduleStoreSave();
  res.json({ success: true, muted: Array.from(storyMutes.get(callerId) || []) });
});

app.post('/api/stories', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const { media, type, text, userName, userAvatar, audience, kind, textData } = req.body || {};
  if (type !== 'text' && kind !== 'text' && (typeof media !== 'string' || !media)) {
    return res.status(400).json({ error: 'Story media is required' });
  }
  if (typeof media === 'string' && media.length > 10 * 1024 * 1024) {
    return res.status(413).json({ error: 'Story media too large' });
  }
  const now = Date.now();
  const story: ServerStory = {
    id: `story_${now}_${randomInt(1000, 100000)}`,
    userId: callerId,
    userName: typeof userName === 'string' ? userName : '',
    userAvatar: typeof userAvatar === 'string' ? userAvatar : '',
    media: typeof media === 'string' ? media : '',
    type: type === 'text' ? 'text' : 'image',
    text: typeof text === 'string' ? text : undefined,
    createdAt: now,
    expiresAt: now + 24 * 60 * 60 * 1000,
    viewers: [],
    audience:
      audience && typeof audience === 'object' && ['everyone', 'contacts', 'close', 'custom'].includes(audience.mode)
        ? {
            mode: audience.mode,
            userIds: Array.isArray(audience.userIds)
              ? audience.userIds.filter((x: any) => typeof x === 'string')
              : undefined,
          }
        : undefined,
    kind: ['image', 'text', 'video'].includes(kind) ? kind : type === 'text' ? 'text' : 'image',
    textData:
      textData && typeof textData === 'object'
        ? {
            text: typeof textData.text === 'string' ? textData.text : '',
            bg: typeof textData.bg === 'string' ? textData.bg : '',
            font: typeof textData.font === 'string' ? textData.font : '',
          }
        : undefined,
    reactions: [],
  };
  serverStories.set(story.id, story);
  scheduleStoreSave();
  res.json({ success: true, story });
});

app.post('/api/stories/:id/react', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const story = serverStories.get(req.params.id);
  if (!story) return res.status(404).json({ error: 'Story not found' });
  const emoji = typeof req.body?.emoji === 'string' ? req.body.emoji.slice(0, 16) : '';
  if (!emoji) return res.status(400).json({ error: 'emoji is required' });
  if (!Array.isArray(story.reactions)) story.reactions = [];
  const idx = story.reactions.findIndex((r) => r.userId === callerId);
  if (idx > -1 && story.reactions[idx].emoji === emoji) {
    story.reactions.splice(idx, 1); // toggle off
  } else if (idx > -1) {
    story.reactions[idx] = { userId: callerId, emoji }; // switch emoji
  } else {
    story.reactions.push({ userId: callerId, emoji });
  }
  scheduleStoreSave();
  res.json({ success: true, story });
});

// Highlights: snapshots that survive story expiry.
app.get('/api/highlights', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const target = typeof req.query.userId === 'string' && req.query.userId ? req.query.userId : callerId;
  res.json({ highlights: highlightsByUser.get(target) || [] });
});

app.post('/api/highlights', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const story = req.body?.story;
  if (!story || typeof story !== 'object') return res.status(400).json({ error: 'story snapshot is required' });
  const entry = {
    ...story,
    id: typeof story.id === 'string' && story.id ? `hl_${story.id}` : `hl_${Date.now()}_${randomInt(1000, 100000)}`,
    highlightedBy: callerId,
    highlightedAt: Date.now(),
  };
  if (!highlightsByUser.has(callerId)) highlightsByUser.set(callerId, []);
  const list = highlightsByUser.get(callerId)!;
  const idx = list.findIndex((h: any) => h && h.id === entry.id);
  if (idx > -1) list[idx] = entry; else list.push(entry);
  scheduleStoreSave();
  res.json({ success: true, highlight: entry, highlights: list });
});

app.delete('/api/highlights/:id', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const list = highlightsByUser.get(callerId) || [];
  highlightsByUser.set(callerId, list.filter((h: any) => h && h.id !== req.params.id));
  scheduleStoreSave();
  res.json({ success: true, highlights: highlightsByUser.get(callerId) });
});

app.post('/api/stories/:id/view', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const story = serverStories.get(req.params.id);
  if (!story) return res.status(404).json({ error: 'Story not found' });
  if (story.userId !== callerId && !story.viewers.some((v) => v.userId === callerId)) {
    story.viewers.push({ userId: callerId, viewedAt: Date.now() });
    scheduleStoreSave();
  }
  res.json({ success: true, viewers: story.viewers });
});

app.delete('/api/stories/:id', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const story = serverStories.get(req.params.id);
  if (!story) return res.status(404).json({ error: 'Story not found' });
  if (story.userId !== callerId) {
    return res.status(403).json({ error: 'Only the author can delete this story' });
  }
  serverStories.delete(req.params.id);
  scheduleStoreSave();
  res.json({ success: true });
});

// -------------------------------------------------------------
// Phase 0.11 — Block & Report API (minimum sellable safety layer)
// -------------------------------------------------------------
app.get('/api/blocks', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  res.json({ blocked: Array.from(blockedBy.get(callerId) || []) });
});

app.post('/api/blocks', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const { blockedId } = req.body || {};
  if (typeof blockedId !== 'string' || !blockedId || blockedId === callerId) {
    return res.status(400).json({ error: 'Valid blockedId is required' });
  }
  if (!blockedBy.has(callerId)) blockedBy.set(callerId, new Set());
  blockedBy.get(callerId)!.add(blockedId);
  scheduleStoreSave();
  res.json({ success: true, blocked: Array.from(blockedBy.get(callerId)!) });
});

app.delete('/api/blocks/:blockedId', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  blockedBy.get(callerId)?.delete(req.params.blockedId);
  scheduleStoreSave();
  res.json({ success: true, blocked: Array.from(blockedBy.get(callerId) || []) });
});

app.post('/api/reports', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const { reportedId, reason } = req.body || {};
  if (typeof reportedId !== 'string' || !reportedId) {
    return res.status(400).json({ error: 'Valid reportedId is required' });
  }
  const record: ReportRecord = {
    id: `report_${Date.now()}_${randomInt(1000, 100000)}`,
    reporterId: callerId,
    reportedId,
    reason: typeof reason === 'string' ? reason.slice(0, 500) : undefined,
    createdAt: Date.now(),
  };
  reportRecords.push(record);
  // Report implies block (roadmap 0.11: Report = block + optional reason).
  if (!blockedBy.has(callerId)) blockedBy.set(callerId, new Set());
  blockedBy.get(callerId)!.add(reportedId);
  scheduleStoreSave();
  res.json({ success: true, reportId: record.id });
});

// -------------------------------------------------------------
// Phase 1 — User directory
// -------------------------------------------------------------
const PRIVACY_LEVELS = new Set(['everyone', 'contacts', 'nobody']);
function sanitisePrivacy(input: any, base?: PrivacySettings): PrivacySettings | undefined {
  if (!input || typeof input !== 'object') return base;
  const out: PrivacySettings = { ...(base || {}) };
  for (const key of ['photo', 'about', 'lastSeen', 'groupAdd'] as const) {
    if (typeof input[key] === 'string' && PRIVACY_LEVELS.has(input[key])) out[key] = input[key];
  }
  if (typeof input.findMe === 'string' && ['everyone', 'nobody'].includes(input.findMe)) {
    out.findMe = input.findMe;
  }
  return out;
}

app.post('/api/users/register', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const body = req.body || {};
  const existing = directory.get(callerId);
  const entry: DirectoryEntry = {
    id: callerId,
    name:
      typeof body.name === 'string' && body.name ? body.name.slice(0, 120) : existing?.name || '',
    // Username is NEVER set here — it comes only from the claim flow.
    username: handleOwnedBy(callerId),
    avatar: typeof body.avatar === 'string' ? body.avatar : existing?.avatar,
    about: typeof body.about === 'string' ? body.about.slice(0, 300) : existing?.about,
    mood: typeof body.mood === 'string' ? body.mood.slice(0, 120) : existing?.mood,
    discoverable: typeof body.discoverable === 'boolean' ? body.discoverable : existing?.discoverable,
    privacy: sanitisePrivacy(body.privacy, existing?.privacy),
    updatedAt: Date.now(),
  };
  directory.set(callerId, entry);
  scheduleStoreSave();
  res.json({ success: true, user: entry });
});

app.get('/api/users/search', requireAuth, (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
  if (!q) return res.json({ users: [] });
  const users = Array.from(directory.values())
    .filter((e) => e.discoverable !== false && e.privacy?.findMe !== 'nobody')
    .filter(
      (e) =>
        (e.username && e.username.toLowerCase() === q) ||
        (e.name && e.name.toLowerCase().startsWith(q))
    )
    .slice(0, 50)
    .map((e) => ({
      id: e.id,
      name: e.name,
      username: e.username,
      avatar: e.avatar,
      about: e.about,
      mood: e.mood,
      privacy: e.privacy,
    }));
  res.json({ users });
});

app.delete('/api/users/me', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  directory.delete(callerId);
  const handle = handleOwnedBy(callerId);
  if (handle) {
    usernames.delete(handle);
    releasedHandles.set(handle, {
      userId: callerId,
      releasedAt: Date.now(),
      expiresAt: Date.now() + HANDLE_GRACE_MS,
    });
  }
  // Drop all live sessions for the deleted account.
  for (const [ws, session] of Array.from(clients.entries())) {
    if (session.userId === callerId) {
      try {
        ws.send(JSON.stringify({ type: 'session:revoked' }));
        ws.close();
      } catch { /* ignore */ }
      clients.delete(ws);
    }
  }
  scheduleStoreSave();
  res.json({ success: true });
});

// -------------------------------------------------------------
// Phase 1 — Usernames
// -------------------------------------------------------------
app.get('/api/usernames/check', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const handle = typeof req.query.handle === 'string' ? req.query.handle.trim().toLowerCase() : '';
  const result = handleAvailability(handle, callerId);
  res.json(result);
});

app.post('/api/usernames/claim', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const handle = typeof req.body?.handle === 'string' ? req.body.handle.trim().toLowerCase() : '';
  const result = handleAvailability(handle, callerId);
  if (!result.available) {
    const status = result.reason === 'taken' || result.reason === 'grace' ? 409 : 400;
    return res.status(status).json({ available: false, reason: result.reason, error: `Username ${result.reason}` });
  }
  const previous = handleOwnedBy(callerId);
  if (previous && previous !== handle) {
    usernames.delete(previous);
    releasedHandles.set(previous, {
      userId: callerId,
      releasedAt: Date.now(),
      expiresAt: Date.now() + HANDLE_GRACE_MS,
    });
  }
  releasedHandles.delete(handle);
  usernames.set(handle, callerId);
  const entry = directory.get(callerId);
  if (entry) {
    entry.username = handle;
    entry.updatedAt = Date.now();
  }
  scheduleStoreSave();
  res.json({ success: true, username: handle });
});

app.delete('/api/usernames', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const handle = handleOwnedBy(callerId);
  if (handle) {
    usernames.delete(handle);
    releasedHandles.set(handle, {
      userId: callerId,
      releasedAt: Date.now(),
      expiresAt: Date.now() + HANDLE_GRACE_MS,
    });
    const entry = directory.get(callerId);
    if (entry) {
      entry.username = undefined;
      entry.updatedAt = Date.now();
    }
    scheduleStoreSave();
  }
  res.json({ success: true });
});

// -------------------------------------------------------------
// Phase 1 — Sessions API
// -------------------------------------------------------------
function liveSessionsOf(userId: string) {
  const out: any[] = [];
  for (const session of clients.values()) {
    if (session.userId !== userId || !session.sessionId) continue;
    out.push({
      sessionId: session.sessionId,
      deviceLabel: session.deviceLabel || 'Unknown device',
      connectedAt: session.connectedAt || session.lastActive,
      lastActive: session.lastActive,
      session,
    });
  }
  return out;
}

app.get('/api/sessions', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const currentId =
    (typeof req.headers['x-session-id'] === 'string' && req.headers['x-session-id']) || '';
  const sessions = liveSessionsOf(callerId).map(({ session, ...rest }) => ({
    ...rest,
    current: !!currentId && rest.sessionId === currentId,
  }));
  res.json({ sessions });
});

app.post('/api/sessions/revoke', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
  const target = liveSessionsOf(callerId).find((s) => s.sessionId === sessionId);
  if (!target) {
    // Exists but belongs to someone else?
    for (const s of clients.values()) {
      if (s.sessionId === sessionId) return res.status(403).json({ error: 'Not your session' });
    }
    return res.status(404).json({ error: 'Session not found' });
  }
  try {
    target.session.ws.send(JSON.stringify({ type: 'session:revoked' }));
    target.session.ws.close();
  } catch { /* ignore */ }
  clients.delete(target.session.ws);
  res.json({ success: true });
});

app.post('/api/sessions/revoke-others', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const keepId =
    (typeof req.headers['x-session-id'] === 'string' && (req.headers['x-session-id'] as string)) ||
    (typeof req.body?.keepSessionId === 'string' && req.body.keepSessionId) ||
    (typeof req.body?.currentSessionId === 'string' && req.body.currentSessionId) ||
    '';
  const mine = liveSessionsOf(callerId);
  // With no keeper identified, keep the most recently connected session.
  const keeper = keepId || mine.slice().sort((a, b) => b.connectedAt - a.connectedAt)[0]?.sessionId;
  let revoked = 0;
  for (const s of mine) {
    if (s.sessionId === keeper) continue;
    try {
      s.session.ws.send(JSON.stringify({ type: 'session:revoked' }));
      s.session.ws.close();
    } catch { /* ignore */ }
    clients.delete(s.session.ws);
    revoked++;
  }
  res.json({ success: true, revoked });
});

// -------------------------------------------------------------
// Phase 1 — Scheduled messages (REST)
// -------------------------------------------------------------
app.post('/api/scheduled', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const { roomId, message, dueAt } = req.body || {};
  if (typeof roomId !== 'string' || !roomId || roomId === 'saved_messages') {
    return res.status(400).json({ error: 'Valid roomId is required' });
  }
  if (!message || typeof message !== 'object') {
    return res.status(400).json({ error: 'message payload is required' });
  }
  if (typeof dueAt !== 'number' || !Number.isFinite(dueAt)) {
    return res.status(400).json({ error: 'dueAt (epoch ms) is required' });
  }
  const item: ScheduledItem = {
    id: `sched_${Date.now()}_${randomInt(1000, 100000)}`,
    ownerId: callerId,
    roomId,
    message,
    dueAt,
    status: 'pending',
    createdAt: Date.now(),
  };
  scheduledItems.push(item);
  scheduleStoreSave();
  res.json({ success: true, scheduled: item, item });
});

app.get('/api/scheduled', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  res.json({ scheduled: scheduledItems.filter((s) => s.ownerId === callerId) });
});

app.patch('/api/scheduled/:id', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const item = scheduledItems.find((s) => s.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Scheduled item not found' });
  if (item.ownerId !== callerId) return res.status(403).json({ error: 'Not your scheduled item' });
  if (item.status !== 'pending') return res.status(409).json({ error: 'Only pending items can be edited' });
  if (typeof req.body?.dueAt === 'number' && Number.isFinite(req.body.dueAt)) item.dueAt = req.body.dueAt;
  if (req.body?.message && typeof req.body.message === 'object') item.message = req.body.message;
  scheduleStoreSave();
  res.json({ success: true, scheduled: item, item });
});

app.delete('/api/scheduled/:id', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const idx = scheduledItems.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Scheduled item not found' });
  if (scheduledItems[idx].ownerId !== callerId) return res.status(403).json({ error: 'Not your scheduled item' });
  scheduledItems.splice(idx, 1);
  scheduleStoreSave();
  res.json({ success: true });
});

app.post('/api/scheduled/:id/retry', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const item = scheduledItems.find((s) => s.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Scheduled item not found' });
  if (item.ownerId !== callerId) return res.status(403).json({ error: 'Not your scheduled item' });
  if (item.status !== 'failed') return res.status(409).json({ error: 'Only failed items can be retried' });
  item.status = 'pending';
  item.failReason = undefined;
  item.dueAt = Math.min(item.dueAt, Date.now());
  scheduleStoreSave();
  res.json({ success: true, scheduled: item, item });
});

// -------------------------------------------------------------
// Phase 1 — Reminders (REST)
// -------------------------------------------------------------
app.post('/api/reminders', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const { roomId, messageId, dueAt } = req.body || {};
  if (typeof roomId !== 'string' || !roomId) return res.status(400).json({ error: 'roomId is required' });
  if (typeof messageId !== 'string' || !messageId) return res.status(400).json({ error: 'messageId is required' });
  if (typeof dueAt !== 'number' || !Number.isFinite(dueAt)) return res.status(400).json({ error: 'dueAt (epoch ms) is required' });
  const item: ReminderItem = {
    id: `rem_${Date.now()}_${randomInt(1000, 100000)}`,
    ownerId: callerId,
    roomId,
    messageId,
    dueAt,
    status: 'pending',
    createdAt: Date.now(),
  };
  reminderItems.push(item);
  scheduleStoreSave();
  res.json({ success: true, reminder: item, item });
});

app.get('/api/reminders', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  res.json({ reminders: reminderItems.filter((r) => r.ownerId === callerId) });
});

app.patch('/api/reminders/:id', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const item = reminderItems.find((r) => r.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Reminder not found' });
  if (item.ownerId !== callerId) return res.status(403).json({ error: 'Not your reminder' });
  if (typeof req.body?.dueAt === 'number' && Number.isFinite(req.body.dueAt)) {
    item.dueAt = req.body.dueAt;
    item.status = 'pending'; // snooze re-arms a fired reminder
  }
  scheduleStoreSave();
  res.json({ success: true, reminder: item, item });
});

app.delete('/api/reminders/:id', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const idx = reminderItems.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Reminder not found' });
  if (reminderItems[idx].ownerId !== callerId) return res.status(403).json({ error: 'Not your reminder' });
  reminderItems.splice(idx, 1);
  scheduleStoreSave();
  res.json({ success: true });
});

// -------------------------------------------------------------
// Phase 1 — Uploads
// -------------------------------------------------------------
const UPLOAD_DIR = path.join(STORE_DIR, 'uploads');
const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/avif': 'avif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/webm': 'webm',
  'audio/wav': 'wav', 'application/pdf': 'pdf', 'text/plain': 'txt',
  'application/zip': 'zip', 'application/json': 'json',
};
const EXT_TO_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_TO_EXT).map(([m, e]) => [e, m])
);
function sanitiseExt(raw: string | undefined): string {
  if (!raw) return '';
  const clean = raw.toLowerCase().replace(/^\./, '').replace(/[^a-z0-9]/g, '').slice(0, 10);
  return clean;
}

app.post('/api/uploads', requireAuth, (req, res) => {
  const { name, mime, dataBase64 } = req.body || {};
  if (typeof dataBase64 !== 'string' || !dataBase64) {
    return res.status(400).json({ error: 'dataBase64 is required' });
  }
  const b64 = dataBase64.includes(',') && dataBase64.startsWith('data:')
    ? dataBase64.slice(dataBase64.indexOf(',') + 1)
    : dataBase64;
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    return res.status(400).json({ error: 'Invalid base64 data' });
  }
  if (buf.length > 25 * 1024 * 1024) {
    return res.status(413).json({ error: 'File exceeds the 25 MB cap' });
  }
  if (buf.length === 0) return res.status(400).json({ error: 'Empty file' });
  const safeName = typeof name === 'string' ? name.slice(0, 200) : 'file';
  const nameExt = sanitiseExt(safeName.includes('.') ? safeName.split('.').pop() : undefined);
  const mimeStr = typeof mime === 'string' ? mime : 'application/octet-stream';
  const ext = sanitiseExt(MIME_TO_EXT[mimeStr]) || nameExt || 'bin';
  const fileName = `${randomBytes(12).toString('hex')}.${ext}`;
  try {
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOAD_DIR, fileName), buf);
  } catch (err) {
    console.warn('Upload write failed:', err);
    return res.status(500).json({ error: 'Failed to store upload' });
  }
  res.json({ url: `/uploads/${fileName}`, name: safeName, size: buf.length, mime: mimeStr });
});

app.get('/uploads/:file', (req, res) => {
  const file = path.basename(req.params.file || '');
  if (!file || file !== req.params.file || !/^[a-f0-9]{24}\.[a-z0-9]{1,10}$/.test(file)) {
    return res.status(404).json({ error: 'File not found' });
  }
  const full = path.join(UPLOAD_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'File not found' });
  const ext = file.split('.').pop() || '';
  if (EXT_TO_MIME[ext]) res.type(EXT_TO_MIME[ext]);
  res.sendFile(full);
});

// -------------------------------------------------------------
// Phase 1 — Global search (membership-checked)
// -------------------------------------------------------------
app.get('/api/search', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
  const roomFilter = typeof req.query.roomId === 'string' ? req.query.roomId : undefined;
  if (!q) return res.json({ results: [] });
  const probe: ClientSession = { ws: null as any, userId: callerId, lastActive: Date.now() };
  const results: any[] = [];
  for (const [roomId, msgs] of roomMessages.entries()) {
    if (roomFilter && roomId !== roomFilter) continue;
    if (roomId === 'saved_messages') continue;
    if (!canAccessRoom(probe, roomId)) continue;
    for (const m of msgs) {
      if (m.deletedAt) continue;
      const hit =
        (typeof m.content === 'string' && m.content.toLowerCase().includes(q)) ||
        (typeof m.fileName === 'string' && m.fileName.toLowerCase().includes(q));
      if (hit) {
        results.push({
          roomId,
          message: {
            id: m.id,
            senderId: m.senderId,
            senderName: m.senderName,
            timestamp: m.timestamp,
            type: m.type,
            content: m.content,
            fileName: m.fileName,
          },
        });
      }
    }
  }
  results.sort((a, b) => b.message.timestamp - a.message.timestamp);
  res.json({ results: results.slice(0, 100) });
});

// -------------------------------------------------------------
// Phase 1 — Stars
// -------------------------------------------------------------
app.get('/api/stars', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  res.json({ stars: starsByUser.get(callerId) || [] });
});

app.post('/api/stars', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const message = req.body?.message;
  if (!message || typeof message !== 'object' || typeof message.id !== 'string') {
    return res.status(400).json({ error: 'message snapshot with id is required' });
  }
  if (!starsByUser.has(callerId)) starsByUser.set(callerId, []);
  const list = starsByUser.get(callerId)!;
  const idx = list.findIndex((m: any) => m && m.id === message.id);
  if (idx > -1) list[idx] = message; else list.push(message);
  scheduleStoreSave();
  res.json({ success: true, stars: list });
});

app.delete('/api/stars/:messageId', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const list = starsByUser.get(callerId) || [];
  starsByUser.set(callerId, list.filter((m: any) => m && m.id !== req.params.messageId));
  scheduleStoreSave();
  res.json({ success: true, stars: starsByUser.get(callerId) });
});

// -------------------------------------------------------------
// Phase 1 — Call logs
// -------------------------------------------------------------
app.post('/api/call-logs', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const { peerId, type, direction, durationSec, startedAt, callType, logType, dataUsed } = req.body || {};
  if (typeof peerId !== 'string' || !peerId || peerId === callerId) {
    return res.status(400).json({ error: 'Valid peerId is required' });
  }
  const now = Date.now();
  const base = {
    peerId,
    type: typeof type === 'string' ? type : 'audio',
    // Addendum (Team CA): persist kind/outcome verbatim when supplied —
    // `type` keeps its historical meaning (call kind); `logType` carries
    // the outcome (e.g. 'declined' must not degrade to 'missed').
    callType: typeof callType === 'string' ? callType : undefined,
    logType: typeof logType === 'string' ? logType : undefined,
    dataUsed: typeof dataUsed === 'string' && dataUsed.length <= 24 ? dataUsed : undefined,
    durationSec: typeof durationSec === 'number' ? durationSec : 0,
    startedAt: typeof startedAt === 'number' ? startedAt : now,
    createdAt: now,
  };
  const dirIn = direction === 'incoming' ? 'incoming' : 'outgoing';
  const callerEntry = { ...base, id: `call_${now}_${randomInt(1000, 100000)}`, direction: dirIn };
  if (!callLogsByUser.has(callerId)) callLogsByUser.set(callerId, []);
  callLogsByUser.get(callerId)!.push(callerEntry);
  // Mirror for the peer with the direction flipped.
  const peerEntry = {
    ...base,
    peerId: callerId,
    id: `call_${now}_${randomInt(1000, 100000)}_p`,
    direction: dirIn === 'outgoing' ? 'incoming' : 'outgoing',
  };
  if (!callLogsByUser.has(peerId)) callLogsByUser.set(peerId, []);
  callLogsByUser.get(peerId)!.push(peerEntry);
  scheduleStoreSave();
  res.json({ success: true, entry: callerEntry });
});

app.get('/api/call-logs', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const list = (callLogsByUser.get(callerId) || [])
    .slice()
    .sort((a: any, b: any) => (b.startedAt || 0) - (a.startedAt || 0))
    .slice(0, 200);
  res.json({ callLogs: list, logs: list });
});

// Addendum (Team CA): delete one of the caller's own entries / clear all.
// Only the caller's own list is touched — the peer's mirrored copy is theirs.
app.delete('/api/call-logs/:id', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const list = callLogsByUser.get(callerId) || [];
  const idx = list.findIndex((e: any) => e && e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Call log entry not found' });
  list.splice(idx, 1);
  scheduleStoreSave();
  res.json({ success: true, callLogs: list });
});

app.delete('/api/call-logs', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  callLogsByUser.set(callerId, []);
  scheduleStoreSave();
  res.json({ success: true, callLogs: [] });
});

// -------------------------------------------------------------
// Phase 1 — Channel invites / join / delete
// -------------------------------------------------------------
function channelPrivileged(ch: ServerChannel, userId: string): boolean {
  return ch.ownerId === userId || (ch.adminIds || []).includes(userId);
}

app.post('/api/channels/:id/invite', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const ch = serverChannels.get(req.params.id);
  if (!ch) return res.status(404).json({ error: 'Channel not found' });
  if (!channelPrivileged(ch, callerId)) {
    return res.status(403).json({ error: 'Only the owner or admins can manage invites' });
  }
  ch.inviteCode = randomBytes(5).toString('hex');
  ch.inviteEnabled = true;
  scheduleStoreSave();
  res.json({ success: true, inviteCode: ch.inviteCode, channel: ch });
});

app.delete('/api/channels/:id/invite', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const ch = serverChannels.get(req.params.id);
  if (!ch) return res.status(404).json({ error: 'Channel not found' });
  if (!channelPrivileged(ch, callerId)) {
    return res.status(403).json({ error: 'Only the owner or admins can manage invites' });
  }
  ch.inviteCode = undefined;
  ch.inviteEnabled = false;
  scheduleStoreSave();
  res.json({ success: true, channel: ch });
});

app.post('/api/channels/join', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  if (!code) return res.status(400).json({ error: 'Invite code is required' });
  const ch = Array.from(serverChannels.values()).find(
    (c) => c.inviteCode && c.inviteCode === code && c.inviteEnabled !== false
  );
  if (!ch) return res.status(404).json({ error: 'Invalid or revoked invite code' });
  if (!ch.memberIds) ch.memberIds = [];
  if (ch.memberIds.includes(callerId) || ch.ownerId === callerId) {
    return res.json({ success: true, channel: ch });
  }
  if (ch.joinApproval) {
    if (!Array.isArray(ch.joinRequests)) ch.joinRequests = [];
    if (!ch.joinRequests.includes(callerId)) ch.joinRequests.push(callerId);
    scheduleStoreSave();
    return res.json({ success: true, pending: true });
  }
  ch.memberIds.push(callerId);
  ch.membersCount = ch.memberIds.length;
  scheduleStoreSave();
  broadcast({ type: 'channel:created', channel: ch }, (s) => !!s.userId && ch.memberIds!.includes(s.userId));
  res.json({ success: true, channel: ch });
});

app.delete('/api/channels/:id', requireAuth, (req, res) => {
  const callerId = (req as any).authUserId as string;
  const ch = serverChannels.get(req.params.id);
  if (!ch) return res.status(404).json({ error: 'Channel not found' });
  if (ch.ownerId && ch.ownerId !== callerId) {
    return res.status(403).json({ error: 'Only the channel owner can delete this channel' });
  }
  const memberIds = ch.memberIds || [];
  serverChannels.delete(req.params.id);
  roomMessages.delete(req.params.id);
  scheduleStoreSave();
  broadcast({ type: 'channel:deleted', channelId: req.params.id }, (s) =>
    !!s.userId && (memberIds.includes(s.userId) || s.userId === callerId)
  );
  res.json({ success: true });
});

// -------------------------------------------------------------
// Phase 1 — Scheduled delivery + reminder sweeper (5 s)
// Delivers through the normal send path: room ACL, block checks and
// channel send restrictions all apply. Exactly-once by schedule id:
// the item's status flips synchronously before delivery is attempted.
// -------------------------------------------------------------
function deliverScheduledItem(item: ScheduledItem): { ok: boolean; messageId?: string; reason?: string } {
  const probe: ClientSession = { ws: null as any, userId: item.ownerId, lastActive: Date.now() };
  if (!canAccessRoom(probe, item.roomId)) return { ok: false, reason: 'room_access_denied' };
  const peer = dmPeerOf(item.roomId, item.ownerId);
  if (peer && isBlockedBetween(item.ownerId, peer)) return { ok: false, reason: 'blocked' };
  const ch = serverChannels.get(item.roomId);
  if (ch) {
    const reason = channelSendBlockReason(ch, item.message?.sectionId, item.ownerId);
    if (reason) return { ok: false, reason };
  }
  const raw = item.message && typeof item.message === 'object' ? item.message : {};
  const now = Date.now();
  const msg: MessagePayload = {
    ...raw,
    id: `msg_${now}_${randomInt(1000, 100000)}`,
    senderId: item.ownerId,
    senderName:
      typeof raw.senderName === 'string' && raw.senderName
        ? raw.senderName
        : directory.get(item.ownerId)?.name || item.ownerId,
    senderAvatar: typeof raw.senderAvatar === 'string' ? raw.senderAvatar : '',
    roomId: item.roomId,
    type: ['text', 'image', 'video', 'audio', 'file', 'offline_qr'].includes(raw.type) ? raw.type : 'text',
    content: typeof raw.content === 'string' ? raw.content : '',
    timestamp: now,
    deliveredTo: [],
    readBy: [],
  };
  if (!roomMessages.has(item.roomId)) {
    if (roomMessages.size >= 1000) return { ok: false, reason: 'room_limit' };
    roomMessages.set(item.roomId, []);
  }
  purgeExpiredMessages(item.roomId);
  roomMessages.get(item.roomId)!.push(msg);
  if (ch) {
    ch.lastMessage = msg.type === 'text' ? msg.content : `[${msg.type}]`;
    ch.lastMessageTimestamp = now;
  }
  const delivered = deliverToRoom({ type: 'message:new', message: msg }, item.roomId, {
    messageForReceipts: msg,
  });
  if (delivered.size) {
    msg.deliveredTo = Array.from(delivered);
    emitReceipts(msg);
  }
  return { ok: true, messageId: msg.id };
}

setInterval(() => {
  try {
    const now = Date.now();
    let changed = false;
    for (const item of scheduledItems) {
      if (item.status !== 'pending' || item.dueAt > now) continue;
      const result = deliverScheduledItem(item);
      if (result.ok) {
        item.status = 'sent';
        item.messageId = result.messageId;
        sendToUser(item.ownerId, { type: 'scheduled:sent', id: item.id, messageId: result.messageId });
      } else {
        item.status = 'failed';
        item.failReason = result.reason || 'delivery_failed';
        sendToUser(item.ownerId, { type: 'scheduled:failed', id: item.id, reason: item.failReason });
      }
      changed = true;
    }
    for (const rem of reminderItems) {
      if (rem.status !== 'pending' || rem.dueAt > now) continue;
      rem.status = 'done'; // auto-complete after firing
      sendToUser(rem.ownerId, {
        type: 'reminder:due',
        reminder: {
          id: rem.id, ownerId: rem.ownerId, roomId: rem.roomId,
          messageId: rem.messageId, dueAt: rem.dueAt, status: rem.status, createdAt: rem.createdAt,
        },
      });
      changed = true;
    }
    if (changed) scheduleStoreSave();
  } catch (err) {
    console.warn('Sweeper error:', err);
  }
}, 5000);

// -------------------------------------------------------------
// WebSocket Real-Time Communication & Presence Engine
// -------------------------------------------------------------
wss.on('connection', (ws: WebSocket) => {
  const session: ClientSession = {
    ws,
    lastActive: Date.now(),
  };
  clients.set(ws, session);

  ws.on('message', async (message: string) => {
    try {
      const data = JSON.parse(message.toString());
      session.lastActive = Date.now();

      // Auth gate (security lab finding): until a socket identifies itself
      // with user:login it may not join rooms, publish messages/reactions,
      // typing or call signals. Anonymous clients could previously post
      // messages and even ring other users' call UI.
      if (data.type !== 'user:login' && !session.userId) {
        return;
      }

      switch (data.type) {
        case 'user:login': {
          // Phase 0.1: identity must be PROVEN, not asserted. With a Firebase
          // ID token, the session identity is the token's uid and a claimed
          // userId that differs is rejected outright. Without a token, the
          // self-asserted login is honoured only in explicit local demo mode
          // (CHITTHI_ALLOW_UNAUTH_DEMO=true, never in production).
          const claimedId =
            typeof data.userId === 'string' ? data.userId : '';
          let tokenEmail: string | undefined;
          if (typeof data.idToken === 'string' && data.idToken) {
            const verified = await verifyFirebaseIdToken(data.idToken);
            if (!verified) {
              ws.send(
                JSON.stringify({ type: 'auth:error', error: 'invalid_token' })
              );
              return;
            }
            if (claimedId && claimedId !== verified.uid) {
              ws.send(
                JSON.stringify({
                  type: 'auth:error',
                  error: 'identity_mismatch',
                })
              );
              return;
            }
            session.userId = verified.uid;
            session.verified = true;
            tokenEmail = verified.email;
          } else if (DEMO_AUTH) {
            if (!claimedId) {
              ws.send(
                JSON.stringify({ type: 'auth:error', error: 'user_required' })
              );
              return;
            }
            session.userId = claimedId;
            session.verified = false;
          } else {
            ws.send(
              JSON.stringify({ type: 'auth:error', error: 'token_required' })
            );
            return;
          }
          session.username = data.username;
          session.lastActive = Date.now();
          // Phase 1 sessions: stable id, device label, presence mode.
          if (!session.sessionId) {
            session.sessionId = `sess_${Date.now()}_${randomBytes(6).toString('hex')}`;
          }
          session.connectedAt = Date.now();
          if (typeof data.deviceLabel === 'string' && data.deviceLabel) {
            session.deviceLabel = data.deviceLabel.slice(0, 100);
          }
          session.presenceMode = ['online', 'away', 'invisible'].includes(data.presenceMode)
            ? data.presenceMode
            : 'online';
          if (tokenEmail && session.userId) userEmails.set(session.userId, tokenEmail);
          ws.send(
            JSON.stringify({
              type: 'session:ready',
              sessionId: session.sessionId,
              userId: session.userId,
            })
          );
          // Login alert on first-seen device label (best-effort, silent).
          if (session.deviceLabel && session.userId) {
            void maybeSendLoginAlert(session.userId, session.deviceLabel);
          }

          // Broadcast active online users (to authenticated sockets only),
          // personalised per viewer (invisible mode + lastSeen privacy).
          broadcastPresence();
          break;
        }

        case 'user:heartbeat': {
          session.lastActive = Date.now();
          break;
        }

        case 'room:join':
        case 'room:history': {
          // Phase 0.1: history is served only to sessions with room access.
          if (!canAccessRoom(session, data.roomId)) {
            ws.send(
              JSON.stringify({ type: 'room:denied', roomId: data.roomId })
            );
            break;
          }
          if (data.type === 'room:join') session.activeRoomId = data.roomId;
          // Phase 0.3: expired (disappearing) messages never resurrect.
          if (purgeExpiredMessages(data.roomId)) scheduleStoreSave();
          // Phase 1 paging: {before?, limit?} -> newest page ending before
          // `before` (or the latest page). Response gains hasMore/oldestId;
          // shape is otherwise identical to Phase 0 (backward compatible).
          const all = roomMessages.get(data.roomId) || [];
          let end = all.length;
          if (typeof data.before === 'string' && data.before) {
            const idx = all.findIndex((m) => m.id === data.before);
            if (idx > -1) end = idx;
          }
          const limit = Math.min(
            Math.max(typeof data.limit === 'number' && Number.isFinite(data.limit) ? Math.floor(data.limit) : 200, 1),
            500
          );
          const start = Math.max(0, end - limit);
          const page = all.slice(start, end);
          ws.send(
            JSON.stringify({
              type: 'room:history',
              roomId: data.roomId,
              messages: page.map((m) => serializeMessageFor(m, session)),
              hasMore: start > 0,
              oldestId: page.length ? page[0].id : undefined,
            })
          );
          break;
        }

        case 'message:send': {
          const msg: MessagePayload = data.message;
          // Shape + size validation (security lab: malformed/huge payloads
          // were stored and relayed verbatim, an unauthenticated disk-fill).
          if (!msg || typeof msg !== 'object' || typeof msg.roomId !== 'string' || typeof msg.id !== 'string') break;
          if (JSON.stringify(msg).length > 8 * 1024 * 1024) break;
          const roomId = msg.roomId;
          // Saved Messages is a per-user LOCAL-ONLY room with the same id for
          // everyone: never store or relay it, or users would receive each
          // other's saved items.
          if (roomId === 'saved_messages') break;
          // Phase 0.1: the sender must actually have access to this room.
          if (!canAccessRoom(session, roomId)) break;
          // Phase 0.11: a blocked user cannot reach the person who blocked
          // them — DM sends across a block (either direction) are dropped.
          const peer = dmPeerOf(roomId, session.userId!);
          if (peer && isBlockedBetween(session.userId!, peer)) break;
          // Phase 1: channel send-path enforcement (readOnly sections,
          // permissions.post === 'admins') drops non-privileged sends.
          const sendChannel = serverChannels.get(roomId);
          if (
            sendChannel &&
            channelSendBlockReason(sendChannel, msg.sectionId, session.userId!)
          ) {
            break;
          }
          // Stamp sender identity from the login session — never trust the
          // payload's senderId/senderName (impersonation, security lab).
          msg.senderId = session.userId!;
          if (session.username) msg.senderName = session.username;
          // Receipts start empty; the server owns them from here.
          msg.deliveredTo = [];
          msg.readBy = [];
          if (!roomMessages.has(roomId)) {
            if (roomMessages.size >= 1000) break; // room-count ceiling
            roomMessages.set(roomId, []);
          }
          purgeExpiredMessages(roomId);
          const list = roomMessages.get(roomId)!;
          list.push(msg);
          // Phase 1 cap lift: messages are NEVER destructively trimmed.

          // Update server channel last message timestamp
          if (serverChannels.has(roomId)) {
            const ch = serverChannels.get(roomId)!;
            ch.lastMessage = msg.type === 'text' ? msg.content : `[${msg.type}]`;
            ch.lastMessageTimestamp = msg.timestamp || Date.now();
          }

          // Phase 0.5: room-scoped delivery + real receipts. Only members
          // receive the message; every member socket that got it counts as
          // a delivery for the sender's receipts.
          const delivered = deliverToRoom(
            { type: 'message:new', message: msg },
            roomId,
            { messageForReceipts: msg }
          );
          if (delivered.size) {
            msg.deliveredTo = Array.from(delivered);
            emitReceipts(msg);
          }

          // Persist to disk (debounced)
          scheduleStoreSave();

          // Ack the sender so clients can distinguish "accepted by server"
          // from a silent drop (scheduled-message retry depends on this).
          ws.send(
            JSON.stringify({
              type: 'message:ack',
              messageId: msg.id,
              roomId,
            })
          );
          break;
        }

        case 'message:react': {
          const { messageId, roomId, emoji } = data;
          const userId = session.userId!;
          if (!canAccessRoom(session, roomId)) break;
          const msgs = roomMessages.get(roomId);
          if (msgs) {
            const target = msgs.find((m) => m.id === messageId);
            if (target) {
              if (!target.reactions) target.reactions = {};
              if (!target.reactions[emoji]) target.reactions[emoji] = [];
              const userList = target.reactions[emoji];
              const idx = userList.indexOf(userId);
              if (idx > -1) {
                userList.splice(idx, 1);
                if (userList.length === 0) delete target.reactions[emoji];
              } else {
                userList.push(userId);
              }

              deliverToRoom(
                { type: 'message:updated', roomId, message: target },
                roomId
              );
            }
          }
          break;
        }

        case 'message:read': {
          // Phase 0.5: the reader's client reports viewed messages; the
          // server records readBy and pushes receipts to the senders.
          const roomId = data.roomId;
          if (typeof roomId !== 'string' || !canAccessRoom(session, roomId))
            break;
          const msgs = roomMessages.get(roomId);
          if (!msgs) break;
          const ids: string[] | null = Array.isArray(data.messageIds)
            ? data.messageIds.filter((x: any) => typeof x === 'string')
            : null;
          const touchedSenders = new Map<string, MessagePayload>();
          for (const m of msgs) {
            if (m.senderId === session.userId) continue;
            if (ids && !ids.includes(m.id)) continue;
            if (!m.readBy) m.readBy = [];
            if (!m.deliveredTo) m.deliveredTo = [];
            let changed = false;
            if (!m.readBy.includes(session.userId!)) {
              m.readBy.push(session.userId!);
              changed = true;
            }
            if (!m.deliveredTo.includes(session.userId!)) {
              m.deliveredTo.push(session.userId!);
              changed = true;
            }
            if (changed) touchedSenders.set(m.id, m);
          }
          if (touchedSenders.size) {
            for (const m of touchedSenders.values()) emitReceipts(m);
            scheduleStoreSave();
          }
          break;
        }

        case 'message:update': {
          const { messageId, roomId, patch } = data;
          // Saved Messages is local-only — never store or relay updates for it.
          if (roomId === 'saved_messages') break;
          if (!canAccessRoom(session, roomId)) break;
          if (!patch || typeof patch !== 'object') break;
          if (JSON.stringify(patch).length > 64 * 1024) break;
          const msgs = roomMessages.get(roomId);
          if (!msgs) break;
          const target = msgs.find((m) => m.id === messageId);
          if (!target) break;
          const isSender = session.userId === target.senderId;
          let changed = false;

          // Edit: sender-only, within 15 minutes, text messages only, not deleted.
          if ('content' in patch || 'editedAt' in patch) {
            if (
              isSender &&
              !target.deletedAt &&
              target.type === 'text' &&
              Date.now() - target.timestamp <= 15 * 60 * 1000
            ) {
              target.content = String(patch.content ?? target.content);
              // Server-stamped so clients cannot fake edit times.
              target.editedAt = Date.now();
              changed = true;
            }
          }

          // Delete: sender-only tombstone, mirroring the client wipe exactly.
          if ('deletedAt' in patch) {
            if (isSender) {
              target.content = '';
              target.images = undefined;
              target.poll = undefined;
              target.reactions = {};
              target.deletedAt = Date.now();
              changed = true;
            }
          }

          // Pin: any authenticated participant may pin/unpin.
          if ('pinned' in patch) {
            target.pinned = !!patch.pinned;
            changed = true;
          }

          // Poll: sender may replace wholesale; voters may only change voterIds.
          if ('poll' in patch && target.poll) {
            const storedPoll = target.poll;
            const isClosed = storedPoll.closesAt && Date.now() > storedPoll.closesAt;
            if (!isClosed) {
              if (isSender) {
                target.poll = patch.poll;
                changed = true;
              } else {
                const patchPoll = patch.poll;
                if (patchPoll && Array.isArray(patchPoll.options) && Array.isArray(storedPoll.options)) {
                  // Preserve stored question/option text — voters cannot rewrite the poll.
                  target.poll = {
                    ...storedPoll,
                    options: storedPoll.options.map((o: any) => ({
                      ...o,
                      voterIds:
                        patchPoll.options.find((p: any) => p.id === o.id)?.voterIds ?? o.voterIds,
                    })),
                  };
                  changed = true;
                }
              }
            }
          }

          if (changed) {
            scheduleStoreSave();
            deliverToRoom(
              { type: 'message:updated', roomId, message: target },
              roomId
            );
          }
          break;
        }

        case 'typing:indicator': {
          if (!canAccessRoom(session, data.roomId)) break;
          broadcast(
            {
              type: 'typing:indicator',
              roomId: data.roomId,
              userId: session.userId,
              username: session.username || data.username,
              isTyping: data.isTyping,
            },
            (s) => s.ws !== ws && canAccessRoom(s, data.roomId)
          );
          break;
        }

        case 'call:signal': {
          // Generic WebRTC signaling relay: forward SDP offers/answers and ICE
          // candidates between call peers. The payload is relayed verbatim and
          // never stored. When data.targetUserId is provided, only that peer
          // receives it. Phase 0.11: an invite from a user the target has
          // blocked is dropped — a blocked user cannot ring you.
          if (
            data.signalType === 'invite' &&
            typeof data.targetUserId === 'string' &&
            blockedBy.get(data.targetUserId)?.has(session.userId!)
          ) {
            break;
          }
          if (data.targetUserId) {
            broadcast(
              {
                type: 'call:signal',
                fromUserId: session.userId,
                targetUserId: data.targetUserId,
                signalType: data.signalType, // 'offer' | 'answer' | 'ice-candidate'
                signal: data.signal,
                roomId: data.roomId,
              },
              (s) => s.ws !== ws && s.userId === data.targetUserId
            );
          } else if (typeof data.roomId === 'string') {
            // Untargeted signals are scoped to room members — never global
            // (the old global relay is what made the group-call button ring
            // every online user).
            broadcast(
              {
                type: 'call:signal',
                fromUserId: session.userId,
                targetUserId: data.targetUserId,
                signalType: data.signalType,
                signal: data.signal,
                roomId: data.roomId,
              },
              (s) => s.ws !== ws && canAccessRoom(s, data.roomId)
            );
          }
          break;
        }
      }
    } catch (err) {
      console.error('Failed to handle ws message:', err);
    }
  });

  ws.on('close', () => {
    const disconnectedUserId = session.userId;
    clients.delete(ws);

    if (disconnectedUserId) {
      // Phase 1: record a real last-seen only when the user's LAST socket
      // goes away (other live sessions keep them online).
      const stillOnline = Array.from(clients.values()).some(
        (s) => s.userId === disconnectedUserId
      );
      if (!stillOnline) {
        userLastSeen.set(disconnectedUserId, Date.now());
        scheduleStoreSave();
        broadcast({
          type: 'presence:user_offline',
          userId: disconnectedUserId,
          lastSeen: 'Active just now',
          lastActiveTimestamp: Date.now(),
          lastSeenAt: Date.now(),
        });
      }
    }

    broadcastPresence();
  });
});

// Mega Round — Public client config (ICE servers). No auth; never cached.
app.get('/api/config', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const iceServers: any[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(',').map((s) => s.trim()).filter(Boolean),
      username: process.env.TURN_USER,
      credential: process.env.TURN_PASS,
    });
  } else {
    iceServers.push({
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    });
  }
  res.json({ iceServers });
});

// Mega Round — AI chat proxy (NVIDIA). Auth required; key stays server-side.
app.post('/api/ai/chat', requireAuth, async (req, res) => {
  try {
    const callerId = (req as any).authUserId as string;
    if (isRateLimited(`ai:${callerId}`, 20, 60 * 1000)) {
      return res.status(429).json({ error: 'rate_limited' });
    }
    const apiKey = process.env.NVIDIA_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: 'ai_not_configured' });
    }
    const rawMessages = req.body?.messages;
    if (!Array.isArray(rawMessages)) {
      return res.status(400).json({ error: 'messages_required' });
    }
    const filtered: { role: string; content: string }[] = [];
    for (const m of rawMessages) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
      if (typeof m.content !== 'string') continue;
      const content = m.content.slice(0, 4000);
      if (!content.trim()) continue;
      filtered.push({ role: m.role, content });
    }
    const sanitized = filtered.slice(-20);
    if (!sanitized.length) {
      return res.status(400).json({ error: 'messages_required' });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const upstream = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: process.env.AI_MODEL || 'nvidia/nemotron-3.5-lightning-30b-a3b',
          messages: [
            {
              role: 'system',
              content:
                'You are the AI assistant inside Chitthi, a friendly messenger app. Be helpful and concise. Reply in the language the user writes in (Bangla if they write Bangla, English if English).',
            },
            ...sanitized,
          ],
          temperature: 0.7,
          max_tokens: 1024,
        }),
        signal: controller.signal,
      });
      if (!upstream.ok) {
        return res.status(502).json({ error: 'ai_upstream' });
      }
      const data: any = await upstream.json();
      const reply = data?.choices?.[0]?.message?.content;
      if (typeof reply !== 'string') {
        return res.status(502).json({ error: 'ai_upstream' });
      }
      return res.json({ reply });
    } catch {
      return res.status(502).json({ error: 'ai_upstream' });
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return res.status(502).json({ error: 'ai_upstream' });
  }
});

// API health endpoint
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    connections: clients.size,
    timestamp: Date.now(),
  });
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  server.listen(port, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Error starting server:', err);
});

// Mega Round — Graceful shutdown: flush store, close WS + HTTP, exit 0.
let shuttingDown = false;
function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received — flushing store and closing…`);
  const forceTimer = setTimeout(() => process.exit(0), 3000);
  try {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    saveStoreNow();
  } catch { /* saveStoreNow already guards internally */ }
  try {
    for (const [ws] of clients.entries()) {
      try { ws.close(); } catch { /* ignore */ }
    }
    try { wss.close(); } catch { /* ignore */ }
  } catch { /* ignore */ }
  try {
    server.close(() => {
      clearTimeout(forceTimer);
      process.exit(0);
    });
  } catch {
    clearTimeout(forceTimer);
    process.exit(0);
  }
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
