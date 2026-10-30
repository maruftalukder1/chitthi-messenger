import { initializeApp, getApps } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  sendEmailVerification,
  signOut,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
  updateEmail,
  deleteUser
} from 'firebase/auth';
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  getDoc,
  getDocs,
  addDoc,
  serverTimestamp
} from 'firebase/firestore';
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import firebaseConfig from '../../firebase-applet-config.json';

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

export const auth = getAuth(app);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const storage = getStorage(app);
export const googleProvider = new GoogleAuthProvider();

// ---------------------------------------------------------------------------
// Identity helpers (Phase 0.9 — single home for ID derivation & token access)
// ---------------------------------------------------------------------------

/**
 * Legacy synthetic user id for an email address:
 *   `user_${email.replace(/[^a-zA-Z0-9]/g, '_')}`
 * This is the ONE place this derivation lives. New Firebase-backed accounts
 * are keyed by their Firebase UID instead (see PHASE0_REPORT protocol
 * contract v1); the synthetic id remains only for purely local accounts and
 * for locating legacy `users/{user_<email>}` docs during migration.
 */
export function deriveEmailUserId(email: string): string {
  return `user_${email.toLowerCase().trim().replace(/[^a-zA-Z0-9]/g, '_')}`;
}

/** Current Firebase ID token, or null when signed out / on any error. */
export async function getCurrentIdToken(): Promise<string | null> {
  try {
    const user = auth.currentUser;
    if (!user) return null;
    return await user.getIdToken();
  } catch {
    return null;
  }
}

/**
 * REST auth headers per protocol contract v1: a Bearer Firebase ID token
 * when a Firebase user exists, otherwise the demo-mode `X-Demo-User` header
 * carrying the current app user id (accepted by the server only in demo
 * mode). Returns an empty object when neither is available.
 */
export async function authHeaders(userIdFallback?: string): Promise<Record<string, string>> {
  // X-Session-Id lets the server mark which live session is "this device"
  // (e.g. Settings → Active sessions). socketService persists it to
  // sessionStorage on `session:ready`; read here to avoid an import cycle.
  let sessionId: string | null = null;
  try { sessionId = sessionStorage.getItem('chitthi_session_id'); } catch { /* storage unavailable */ }
  const withSession = (h: Record<string, string>): Record<string, string> =>
    sessionId ? { ...h, 'X-Session-Id': sessionId } : h;
  const token = await getCurrentIdToken();
  if (token) return withSession({ Authorization: `Bearer ${token}` });
  let fallback = userIdFallback;
  if (!fallback) {
    try {
      const raw = localStorage.getItem('chithi_auth_user');
      if (raw) fallback = JSON.parse(raw)?.id;
    } catch {
      /* no stored session — no fallback available */
    }
  }
  return fallback ? withSession({ 'X-Demo-User': fallback }) : {};
}

/** Read a single `users/{id}` profile doc. Returns null when absent/on error. */
export async function fetchUserProfile(id: string): Promise<any | null> {
  try {
    const snap = await getDoc(doc(db, 'users', id));
    if (!snap.exists()) return null;
    return snap.data();
  } catch (err) {
    console.warn('Could not fetch user profile from Firestore:', err);
    return null;
  }
}

/**
 * One-time legacy migration (Phase 0.9): when a Firebase-backed user logs in
 * and their profile still lives under the legacy synthetic
 * `users/{user_<email>}` doc, copy its fields to `users/{uid}`. The legacy
 * doc is left in place untouched. No-op when the UID doc already exists or
 * no legacy doc exists. Best-effort — never blocks login.
 */
export async function migrateLegacyUserDoc(uid: string, email: string): Promise<void> {
  try {
    if (!uid || !email) return;
    const legacyId = deriveEmailUserId(email);
    if (legacyId === uid) return;
    const uidRef = doc(db, 'users', uid);
    const uidSnap = await getDoc(uidRef);
    if (uidSnap.exists()) return;
    const legacySnap = await getDoc(doc(db, 'users', legacyId));
    if (!legacySnap.exists()) return;
    const data = legacySnap.data() as Record<string, any>;
    const { email: legacyEmail, ...rest } = data;
    await setDoc(uidRef, { ...rest, id: uid, updatedAt: serverTimestamp() }, { merge: true });
    if (legacyEmail) {
      try {
        await setDoc(doc(db, 'users', uid, 'private', 'contact'), { email: legacyEmail }, { merge: true });
      } catch {
        /* private contact copy is best-effort */
      }
    }
  } catch (err) {
    console.warn('Could not migrate legacy user profile:', err);
  }
}


// Log user activity into Firestore
export async function logUserActivity(userId: string, userName: string, userEmail: string, action: string) {
  try {
    const actRef = collection(db, 'activities');
    await addDoc(actRef, {
      userId,
      userName: userName || 'Anonymous',
      userEmail: userEmail || 'No Email',
      action,
      timestamp: Date.now(),
      createdAt: serverTimestamp()
    });
  } catch (err) {
    console.warn('Could not log activity to Firestore:', err);
  }
}

// Register or update user profile in Firestore.
// The PUBLIC `users/{id}` doc never carries the email address (Phase 0.9):
// email is written to the owner-only `users/{id}/private/contact` sub-doc.
// `status` is written only when provided so existing callers don't wipe it.
export async function syncUserProfile(user: { id: string; name: string; email: string; avatar: string; username?: string; status?: string; about?: string }) {
  try {
    const userRef = doc(db, 'users', user.id);
    await setDoc(userRef, {
      id: user.id,
      name: user.name,
      avatar: user.avatar,
      // Only include username/status/about when provided so existing callers don't wipe them.
      ...(user.username !== undefined ? { username: user.username } : {}),
      ...(user.status !== undefined ? { status: user.status } : {}),
      ...(user.about !== undefined ? { about: user.about } : {}),
      online: true,
      lastSeen: new Date().toISOString(),
      updatedAt: serverTimestamp()
    }, { merge: true });
  } catch (err) {
    console.warn('Could not sync user profile to Firestore:', err);
  }
  if (user.email) {
    try {
      await setDoc(doc(db, 'users', user.id, 'private', 'contact'), { email: user.email }, { merge: true });
    } catch (err) {
      console.warn('Could not sync private contact info to Firestore:', err);
    }
  }
}

// Fetch all registered users from Firestore.
// Email is stripped defensively: the public profile doc must never expose it,
// even if a legacy doc written by an older build still carries the field.
export async function fetchAllUsers(): Promise<any[]> {
  try {
    const usersRef = collection(db, 'users');
    const snap = await getDocs(usersRef);
    return snap.docs.map((d) => {
      const { email: _email, ...rest } = d.data() as Record<string, any>;
      return rest;
    });
  } catch (err) {
    console.warn('Could not fetch users from Firestore:', err);
    return [];
  }
}

// Upload a profile photo to Firebase Storage at `avatars/{uid}.jpg` and
// return its download URL (Phase 0.9 avatar pipeline). Callers pass an
// already cropped/resized/compressed JPEG blob.
export async function uploadAvatar(uid: string, blob: Blob): Promise<string> {
  const ref = storageRef(storage, `avatars/${uid}.jpg`);
  await uploadBytes(ref, blob, { contentType: 'image/jpeg' });
  return getDownloadURL(ref);
}

// ---------------------------------------------------------------------------
// Phase 1 identity system: server user directory, usernames, sessions
// (protocol contract v2 — see PHASE1_REPORT.md). All REST calls go through
// authHeaders(); the server derives the caller's identity from the token.
// ---------------------------------------------------------------------------

/** Privacy audiences (contract v2). `findMe` has no 'contacts' value. */
export interface PrivacyAudiences {
  photo: 'everyone' | 'contacts' | 'nobody';
  about: 'everyone' | 'contacts' | 'nobody';
  lastSeen: 'everyone' | 'contacts' | 'nobody';
  findMe: 'everyone' | 'nobody';
  groupAdd: 'everyone' | 'contacts' | 'nobody';
}

export const DEFAULT_PRIVACY_AUDIENCES: PrivacyAudiences = {
  photo: 'everyone',
  about: 'everyone',
  lastSeen: 'everyone',
  findMe: 'everyone',
  groupAdd: 'everyone'
};

export const PRIVACY_STORAGE_KEY = 'chitthi_privacy_v1';

/** Read the locally persisted privacy audiences, merged over the defaults. */
export function loadPrivacyAudiences(): PrivacyAudiences {
  try {
    const raw = localStorage.getItem(PRIVACY_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return { ...DEFAULT_PRIVACY_AUDIENCES, ...parsed };
      }
    }
  } catch {
    /* storage unavailable — defaults apply */
  }
  return { ...DEFAULT_PRIVACY_AUDIENCES };
}

/** Persist privacy audiences locally (the directory copy is sent separately
 * via registerDirectoryProfile / syncDirectoryProfile). */
export function savePrivacyAudiences(privacy: PrivacyAudiences): void {
  try {
    localStorage.setItem(PRIVACY_STORAGE_KEY, JSON.stringify(privacy));
  } catch {
    /* storage unavailable */
  }
}

/**
 * Client-side username format check (contract v2): 5–20 chars, [a-z0-9_],
 * starts with a letter, no leading/trailing/consecutive `_`, no dots.
 * Returns a machine-readable reason, or null when the format is valid.
 * The server re-validates on check/claim — this only gives instant feedback.
 */
export type UsernameFormatProblem =
  | 'too_short'
  | 'too_long'
  | 'bad_chars'
  | 'must_start_with_letter'
  | 'trailing_underscore'
  | 'consecutive_underscores';

export function validateUsernameFormat(handle: string): UsernameFormatProblem | null {
  const h = (handle || '').trim().toLowerCase();
  if (h.length < 5) return 'too_short';
  if (h.length > 20) return 'too_long';
  if (!/^[a-z0-9_]+$/.test(h)) return 'bad_chars';
  if (!/^[a-z]/.test(h)) return 'must_start_with_letter';
  if (h.endsWith('_')) return 'trailing_underscore';
  if (h.includes('__')) return 'consecutive_underscores';
  return null;
}

/** Human-readable text for a format problem / server check reason. */
export function usernameProblemText(reason: string | undefined, lang: 'bn' | 'en'): string {
  const en: Record<string, string> = {
    too_short: 'Usernames are 5–20 characters long.',
    too_long: 'Usernames are 5–20 characters long.',
    bad_chars: 'Only lowercase letters, numbers and underscores are allowed.',
    must_start_with_letter: 'Usernames must start with a letter.',
    trailing_underscore: 'Usernames cannot end with an underscore.',
    consecutive_underscores: 'Usernames cannot contain consecutive underscores.',
    format: 'That username does not follow the format rules (5–20 chars, a–z 0–9 _, starts with a letter, no leading/trailing/consecutive _).',
    reserved: 'That username is reserved and cannot be claimed.',
    taken: 'That username is already taken.',
    grace: 'That username was recently released and is still in its 14-day reclaim period.',
    unreachable: 'Could not reach the server to verify this username. Please check your connection and try again.',
    error: 'Something went wrong while checking this username. Please try again.'
  };
  const bn: Record<string, string> = {
    too_short: 'ইউজারনেম ৫–২০ অক্ষরের হতে হবে।',
    too_long: 'ইউজারনেম ৫–২০ অক্ষরের হতে হবে।',
    bad_chars: 'শুধু ছোট হাতের অক্ষর, সংখ্যা ও আন্ডারস্কোর ব্যবহার করা যাবে।',
    must_start_with_letter: 'ইউজারনেম অক্ষর দিয়ে শুরু হতে হবে।',
    trailing_underscore: 'ইউজারনেম আন্ডারস্কোর দিয়ে শেষ হতে পারবে না।',
    consecutive_underscores: 'ইউজারনেমে পরপর আন্ডারস্কোর থাকতে পারবে না।',
    format: 'এই ইউজারনেমটি ফরম্যাটের নিয়ম মানছে না (৫–২০ অক্ষর, a–z 0–9 _, অক্ষর দিয়ে শুরু, পরপর/শেষে আন্ডারস্কোর নয়)।',
    reserved: 'এই ইউজারনেমটি সংরক্ষিত — নেওয়া যাবে না।',
    taken: 'এই ইউজারনেমটি ইতিমধ্যে নেওয়া হয়েছে।',
    grace: 'এই ইউজারনেমটি সম্প্রতি ছাড়া হয়েছে এবং এখনো ১৪ দিনের reclaim সময়ের মধ্যে আছে।',
    unreachable: 'ইউজারনেম যাচাই করতে সার্ভারে পৌঁছানো যায়নি। সংযোগ যাচাই করে আবার চেষ্টা করুন।',
    error: 'ইউজারনেম যাচাই করতে সমস্যা হয়েছে। আবার চেষ্টা করুন।'
  };
  const table = lang === 'bn' ? bn : en;
  return table[reason || 'error'] || table.error;
}

// Small JSON REST helper on top of authHeaders(). Never throws: transport
// failures come back as { ok: false, reachable: false } so callers can
// fail CLOSED (username claims) or degrade quietly (directory sync).
interface ApiResult {
  ok: boolean;
  reachable: boolean;
  status: number;
  data: any;
}

async function apiRequest(path: string, init: RequestInit = {}): Promise<ApiResult> {
  try {
    const headers = await authHeaders();
    const res = await fetch(path, {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
        ...(init.headers || {})
      }
    });
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      /* empty / non-JSON body */
    }
    return { ok: res.ok, reachable: true, status: res.status, data };
  } catch {
    return { ok: false, reachable: false, status: 0, data: null };
  }
}

export interface DirectoryProfilePayload {
  name: string;
  avatar?: string;
  about?: string;
  mood?: string;
  discoverable?: boolean;
  privacy?: PrivacyAudiences;
}

/**
 * Upsert the caller's public directory entry (POST /api/users/register).
 * The username is NEVER set here — claims go through claimUsername().
 * Best-effort: resolves false when the server is unreachable or rejects.
 */
export async function registerDirectoryProfile(payload: DirectoryProfilePayload): Promise<boolean> {
  const res = await apiRequest('/api/users/register', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  return res.ok;
}

export interface DirectoryProfileInput {
  name: string;
  avatar?: string;
  about?: string;
  mood?: string;
  discoverable?: boolean;
}

/**
 * Post the current profile to the server directory: the given public fields
 * plus the locally persisted privacy audiences (and discoverability derived
 * from findMe unless explicitly passed). Called from the profile-save paths.
 */
export async function syncDirectoryProfile(profile: DirectoryProfileInput): Promise<boolean> {
  const privacy = loadPrivacyAudiences();
  return registerDirectoryProfile({
    name: profile.name,
    avatar: profile.avatar,
    about: profile.about,
    mood: profile.mood,
    discoverable: profile.discoverable ?? privacy.findMe !== 'nobody',
    privacy
  });
}

export interface UsernameCheckResult {
  /** True only when the server confirmed the handle can be claimed. */
  available: boolean;
  /** Server reason when unavailable: format | reserved | taken | grace. */
  reason?: string;
  /** False when the check itself could not be completed (offline / error).
   * Callers that gate a change on this MUST treat reachable:false as a
   * block — fail closed, never assume availability. */
  reachable: boolean;
}

/** Live availability check (GET /api/usernames/check). Fail-closed shape. */
export async function checkUsername(handle: string): Promise<UsernameCheckResult> {
  const h = (handle || '').trim().toLowerCase();
  const formatProblem = validateUsernameFormat(h);
  if (formatProblem) return { available: false, reason: 'format', reachable: true };
  const res = await apiRequest(`/api/usernames/check?handle=${encodeURIComponent(h)}`);
  if (!res.reachable) return { available: false, reason: 'unreachable', reachable: false };
  if (!res.ok || !res.data || typeof res.data.available !== 'boolean') {
    return { available: false, reason: 'error', reachable: false };
  }
  return {
    available: res.data.available,
    reason: typeof res.data.reason === 'string' ? res.data.reason : undefined,
    reachable: true
  };
}

export interface UsernameClaimResult {
  ok: boolean;
  reason?: string;
  reachable: boolean;
}

/**
 * Atomically claim a username (POST /api/usernames/claim). The caller's
 * previous handle moves to the 14-day reclaim grace on success.
 * Fail-closed: ANY failure (taken, reserved, offline, server error) returns
 * ok:false and the caller must not apply the change locally.
 */
export async function claimUsername(handle: string): Promise<UsernameClaimResult> {
  const h = (handle || '').trim().toLowerCase();
  const formatProblem = validateUsernameFormat(h);
  if (formatProblem) return { ok: false, reason: 'format', reachable: true };
  const res = await apiRequest('/api/usernames/claim', {
    method: 'POST',
    body: JSON.stringify({ handle: h })
  });
  if (!res.reachable) return { ok: false, reason: 'unreachable', reachable: false };
  if (!res.ok) {
    return {
      ok: false,
      reason: typeof res.data?.reason === 'string' ? res.data.reason : 'error',
      reachable: true
    };
  }
  return { ok: true, reachable: true };
}

/** Release the caller's current username (DELETE /api/usernames; the
 * 14-day reclaim grace applies server-side). */
export async function releaseUsername(): Promise<boolean> {
  const res = await apiRequest('/api/usernames', { method: 'DELETE' });
  return res.ok;
}

export interface DirectoryUser {
  id: string;
  name: string;
  username?: string;
  avatar?: string;
  about?: string;
  mood?: string;
  privacy?: PrivacyAudiences;
}

/**
 * Directory search (GET /api/users/search): exact @username (case-insensitive)
 * or name-prefix matches over discoverable entries. Returns [] on any error.
 * The server responds with an envelope `{ users: [...] }` — unwrap it (the
 * previous version tested the envelope itself with Array.isArray, so server
 * search ALWAYS returned []). A leading '@' is stripped first: the server
 * compares the query verbatim against the bare username, so "@name" could
 * never match.
 */
export async function searchUsers(q: string): Promise<DirectoryUser[]> {
  const query = (q || '').trim().replace(/^@/, '');
  if (!query) return [];
  const res = await apiRequest(`/api/users/search?q=${encodeURIComponent(query)}`);
  if (!res.ok) return [];
  const list = Array.isArray(res.data) ? res.data : res.data?.users;
  if (!Array.isArray(list)) return [];
  return list as DirectoryUser[];
}

/**
 * Delete the caller's directory entry (DELETE /api/users/me): removes the
 * directory profile, releases the username and drops server sessions.
 * Account-centre delete support.
 */
export async function deleteDirectoryAccount(): Promise<boolean> {
  const res = await apiRequest('/api/users/me', { method: 'DELETE' });
  return res.ok;
}

export interface SessionInfo {
  sessionId: string;
  deviceLabel: string;
  connectedAt: number;
  lastActive: number;
  current: boolean;
}

/**
 * The caller's live sessions (GET /api/sessions). Returns null when the
 * list could not be loaded, so the UI can distinguish "couldn't load" from
 * a genuinely empty list.
 */
export async function fetchSessions(): Promise<SessionInfo[] | null> {
  const res = await apiRequest('/api/sessions');
  if (!res.ok || !Array.isArray(res.data)) return null;
  return res.data as SessionInfo[];
}

/** Revoke one session (POST /api/sessions/revoke): the server sends that
 * socket `session:revoked` and closes it; the client there logs out. */
export async function revokeSession(sessionId: string): Promise<boolean> {
  const res = await apiRequest('/api/sessions/revoke', {
    method: 'POST',
    body: JSON.stringify({ sessionId })
  });
  return res.ok;
}

/** Revoke every session except the current one (POST /api/sessions/revoke-others). */
export async function revokeOtherSessions(): Promise<boolean> {
  const res = await apiRequest('/api/sessions/revoke-others', { method: 'POST' });
  return res.ok;
}

export {
  sendEmailVerification,
  signOut,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
  updateEmail,
  deleteUser
};
