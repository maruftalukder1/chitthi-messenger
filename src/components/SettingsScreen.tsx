import React, { useState, useEffect } from 'react';
import { User } from '../types/chat';
import {
  auth,
  authHeaders,
  loadPrivacyAudiences,
  savePrivacyAudiences,
  registerDirectoryProfile,
  fetchSessions,
  revokeSession,
  revokeOtherSessions,
  releaseUsername,
  deleteDirectoryAccount,
  reauthenticateWithCredential,
  EmailAuthProvider,
  updatePassword,
  updateEmail,
  sendEmailVerification,
  deleteUser,
  type PrivacyAudiences,
  type SessionInfo
} from '../services/firebase';
import { initialsAvatarDataUrl } from '../utils/avatar';
import { getNotifSettings, setNotifSettings } from '../utils/notify';
import { socketService } from '../services/socketService';
import {
  Moon,
  Sun,
  User as UserIcon,
  Bell,
  MessageCircle,
  Database,
  Lock,
  Info,
  ChevronRight,
  Globe,
  LogOut,
  X,
  Trash2,
  Wifi,
  CalendarClock,
  Smartphone,
  KeyRound,
  Mail,
  AlertTriangle,
  RefreshCw,
  FileText,
  Loader2
} from 'lucide-react';

// ─── Real local-storage manager ─────────────────────────────────────────────
interface StorageGroupDef {
  id: string;
  labelEn: string;
  labelBn: string;
  match: RegExp;
}

const STORAGE_GROUP_DEFS: StorageGroupDef[] = [
  { id: 'messages', labelEn: 'Messages & media', labelBn: 'মেসেজ ও মিডিয়া', match: /messages/i },
  { id: 'channels', labelEn: 'Chats & channels', labelBn: 'চ্যাট ও চ্যানেল', match: /channels/i },
  { id: 'accounts', labelEn: 'Users & accounts', labelBn: 'ইউজার ও অ্যাকাউন্ট', match: /users|registered_accounts/i },
  { id: 'auth', labelEn: 'Session & login', labelBn: 'সেশন ও লগইন', match: /auth/i },
  { id: 'calls', labelEn: 'Call history', labelBn: 'কল হিস্ট্রি', match: /call_logs/i },
  { id: 'stories', labelEn: 'Stories', labelBn: 'স্টোরি', match: /stories/i },
  { id: 'drafts', labelEn: 'Drafts', labelBn: 'ড্রাফট', match: /^chitthi_draft_/ },
  { id: 'scheduled', labelEn: 'Scheduled messages', labelBn: 'শিডিউল করা মেসেজ', match: /^chitthi_scheduled/ },
  { id: 'ttl', labelEn: 'Disappearing-message timers', labelBn: 'ডিসঅ্যাপিয়ারিং টাইমার', match: /^chitthi_ttl_/ },
  { id: 'wallpaper', labelEn: 'Chat wallpapers', labelBn: 'চ্যাট ওয়ালপেপার', match: /^chitthi_wallpaper_/ },
  { id: 'prefs', labelEn: 'Preferences', labelBn: 'পছন্দসমূহ', match: /theme|data_saver|settings/i },
];

interface StorageGroup {
  id: string;
  labelEn: string;
  labelBn: string;
  keys: string[];
  bytes: number;
}

const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
};

// Keys owned by this app (read-only scan; other sites' keys never touched)
const APP_KEY_PREFIX = /^(chithi_|chitthi_)/;

function readStorageGroups(): StorageGroup[] {
  const acc = new Map<string, StorageGroup>();
  for (const def of STORAGE_GROUP_DEFS) acc.set(def.id, { ...def, keys: [], bytes: 0 });
  const other: StorageGroup = { id: 'other', labelEn: 'Other', labelBn: 'অন্যান্য', keys: [], bytes: 0 };
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    // Headline total must count ONLY this app's keys — other origins' keys
    // are never scanned, grouped, or cleared.
    if (!APP_KEY_PREFIX.test(key)) continue;
    const value = localStorage.getItem(key) ?? '';
    const bytes = (key.length + value.length) * 2; // localStorage stores UTF-16
    const def = STORAGE_GROUP_DEFS.find((d) => d.match.test(key));
    const target = def ? acc.get(def.id)! : other;
    target.keys.push(key);
    target.bytes += bytes;
  }
  const groups = [...acc.values()];
  if (other.keys.length > 0) groups.push(other);
  return groups;
}

interface SettingsScreenProps {
  currentUser: User;
  onEditProfile: () => void;
  isDarkMode: boolean;
  onToggleDarkMode: () => void;
  lang: 'bn' | 'en';
  onToggleLang: () => void;
  onLogout: () => void;
}

export const SettingsScreen: React.FC<SettingsScreenProps> = ({
  currentUser,
  onEditProfile,
  isDarkMode,
  onToggleDarkMode,
  lang,
  onToggleLang,
  onLogout,
}) => {
  // Ringtone preference persisted to localStorage ('chitthi_ringtone': '1'/'0')
  const [ringtoneEnabled, setRingtoneEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem('chitthi_ringtone') !== '0';
    } catch {
      return true;
    }
  });
  const [activeModal, setActiveModal] = useState<string | null>(null);

  // ── Real notification controls (persisted via utils/notify, key
  // 'chitthi_notifications_v1') ────────────────────────────────────────────
  // Initialised from the stored settings AND the browser's live permission,
  // so the toggles reflect reality on mount: a stored "on" means nothing if
  // the browser has blocked notifications.
  const notifPermission = (): NotificationPermission | 'unsupported' => {
    try {
      if (typeof window !== 'undefined' && 'Notification' in window) {
        return Notification.permission;
      }
    } catch {
      /* fall through */
    }
    return 'unsupported';
  };
  const [notifMessages, setNotifMessages] = useState<boolean>(() => {
    if (notifPermission() === 'denied') return false;
    return getNotifSettings().messages;
  });
  const [notifSound, setNotifSound] = useState<boolean>(() => getNotifSettings().sound);
  const [notifBlocked, setNotifBlocked] = useState<boolean>(
    () => notifPermission() === 'denied'
  );

  // Re-sync from storage + live permission every time the modal opens.
  useEffect(() => {
    if (activeModal !== 'notification') return;
    const stored = getNotifSettings();
    setNotifSound(stored.sound);
    if (notifPermission() === 'denied') {
      setNotifMessages(false);
      setNotifBlocked(true);
    } else {
      setNotifMessages(stored.messages);
      setNotifBlocked(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeModal]);

  const handleNotifMessagesChange = async (next: boolean) => {
    if (!next) {
      setNotifMessages(false);
      setNotifSettings({ messages: false });
      return;
    }
    // Turning ON — this handler runs from the checkbox change event, i.e. a
    // real user gesture, so requesting permission here is allowed.
    const permission = notifPermission();
    if (permission === 'granted') {
      setNotifBlocked(false);
      setNotifMessages(true);
      setNotifSettings({ messages: true });
      return;
    }
    if (permission !== 'default') {
      // 'denied' or Notification unsupported — cannot turn on.
      setNotifMessages(false);
      setNotifSettings({ messages: false });
      setNotifBlocked(true);
      return;
    }
    try {
      const result = await Notification.requestPermission();
      if (result === 'granted') {
        setNotifBlocked(false);
        setNotifMessages(true);
        setNotifSettings({ messages: true });
      } else {
        setNotifMessages(false);
        setNotifSettings({ messages: false });
        if (result === 'denied') setNotifBlocked(true);
      }
    } catch {
      setNotifMessages(false);
      setNotifSettings({ messages: false });
    }
  };

  const handleNotifSoundChange = (next: boolean) => {
    setNotifSound(next);
    setNotifSettings({ sound: next });
  };

  // ── Storage manager state ────────────────────────────────────────────────
  const [storageGroups, setStorageGroups] = useState<StorageGroup[] | null>(null);
  const [storageError, setStorageError] = useState(false);
  const [confirmClear, setConfirmClear] = useState<'messages' | 'calls' | 'all' | null>(null);
  const [clearResult, setClearResult] = useState<string | null>(null);
  const [dataSaver, setDataSaver] = useState<boolean>(() => {
    try {
      return localStorage.getItem('chitthi_data_saver') === '1';
    } catch {
      return false;
    }
  });

  const refreshStorage = () => {
    try {
      setStorageGroups(readStorageGroups());
      setStorageError(false);
    } catch {
      setStorageError(true);
      setStorageGroups(null);
    }
    setConfirmClear(null);
  };

  // Recompute every time the storage modal opens, and nothing else touches it
  useEffect(() => {
    if (activeModal === 'storage') {
      setClearResult(null);
      refreshStorage();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeModal]);

  // ── Enter to Send (Phase 0.10: wired, not cosmetic) ─────────────────────
  // Persisted to localStorage `chitthi_settings_v1` JSON on change — no Save
  // step. ChatViewScreen reads `enterToSend` from the same key (contract v1).
  const SETTINGS_KEY = 'chitthi_settings_v1';
  const [enterToSend, setEnterToSend] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (typeof parsed?.enterToSend === 'boolean') return parsed.enterToSend;
      }
    } catch {
      /* fall through to default */
    }
    return true;
  });

  const toggleEnterToSend = (next: boolean) => {
    setEnterToSend(next);
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      const existing = raw ? JSON.parse(raw) : {};
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...existing, enterToSend: next }));
    } catch {
      /* storage unavailable — toggle still reflects the intent */
    }
  };

  // ── Blocked users (Phase 0.11: Privacy page minimum) ────────────────────
  const [blockedIds, setBlockedIds] = useState<string[]>([]);
  const [blockedLoaded, setBlockedLoaded] = useState(false);

  useEffect(() => {
    if (activeModal !== 'privacy') return;
    let cancelled = false;
    (async () => {
      try {
        const headers = await authHeaders(currentUser.id);
        const res = await fetch('/api/blocks', { headers });
        if (res.ok) {
          const data = await res.json();
          if (!cancelled && Array.isArray(data?.blocked)) setBlockedIds(data.blocked);
        }
      } catch {
        /* server unreachable — list stays as-is */
      } finally {
        if (!cancelled) setBlockedLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeModal, currentUser.id]);

  const resolveKnownUser = (id: string): User | undefined => {
    if (id === currentUser.id) return currentUser;
    try {
      const raw = localStorage.getItem('chithi_users_v5');
      if (raw) {
        const list: User[] = JSON.parse(raw);
        return list.find((u) => u.id === id);
      }
    } catch {
      /* ignore */
    }
    return undefined;
  };

  const unblockUser = async (id: string) => {
    setBlockedIds((prev) => prev.filter((b) => b !== id));
    try {
      const headers = await authHeaders(currentUser.id);
      await fetch(`/api/blocks/${encodeURIComponent(id)}`, { method: 'DELETE', headers });
    } catch {
      /* removed locally; server copy reconciles on next load */
    }
  };

  const tr = (en: string, bn: string) => (lang === 'bn' ? bn : en);

  // ── Privacy audiences (Phase 1.4.4) ─────────────────────────────────────
  // Persisted to localStorage `chitthi_privacy_v1` AND sent to the server
  // directory on every change, so presence/search rendering can honour them.
  const [privacy, setPrivacy] = useState<PrivacyAudiences>(() => loadPrivacyAudiences());

  const updatePrivacy = <K extends keyof PrivacyAudiences>(field: K, value: PrivacyAudiences[K]) => {
    const next = { ...privacy, [field]: value };
    setPrivacy(next);
    savePrivacyAudiences(next);
    void registerDirectoryProfile({
      name: currentUser.name,
      avatar: currentUser.avatar,
      about: (currentUser as User & { about?: string }).about,
      mood: currentUser.status,
      discoverable: next.findMe !== 'nobody',
      privacy: next
    });
  };

  // ── Manual presence (Phase 1 follow-up) ─────────────────────────────────
  // Persisted to localStorage `chitthi_presence_mode`
  // ('online' | 'away' | 'invisible'); Team CL reads it at login. When the
  // socket layer exposes setPresenceMode it is called too — via dynamic
  // access with a typeof guard, so there is no hard dependency on it.
  type PresenceMode = 'online' | 'away' | 'invisible';
  const [presenceMode, setPresenceModeState] = useState<PresenceMode>(() => {
    try {
      const v = localStorage.getItem('chitthi_presence_mode');
      if (v === 'online' || v === 'away' || v === 'invisible') return v;
    } catch {
      /* fall through to default */
    }
    return 'online';
  });

  const setPresenceMode = (mode: PresenceMode) => {
    setPresenceModeState(mode);
    try {
      localStorage.setItem('chitthi_presence_mode', mode);
    } catch {
      /* storage unavailable — the picker still reflects the intent */
    }
    try {
      const svc = socketService as unknown as { setPresenceMode?: unknown };
      if (typeof svc.setPresenceMode === 'function') {
        (svc.setPresenceMode as (m: PresenceMode) => void).call(socketService, mode);
      }
    } catch {
      /* socket layer not ready — the localStorage value applies at login */
    }
  };

  // ── Account centre (Phase 1.4.7) ────────────────────────────────────────
  const fbUser = auth.currentUser;
  const accountEmail = fbUser?.email || currentUser.email || '';

  const authErrorText = (err: any): string => {
    const code = err?.code || '';
    switch (code) {
      case 'auth/wrong-password':
      case 'auth/invalid-credential':
        return tr('The current password is incorrect.', 'বর্তমান পাসওয়ার্ডটি সঠিক নয়।');
      case 'auth/requires-recent-login':
        return tr(
          'For security, please log out and log back in, then try again.',
          'নিরাপত্তার জন্য লগআউট করে আবার লগইন করুন, তারপর চেষ্টা করুন।'
        );
      case 'auth/email-already-in-use':
        return tr('That email is already used by another account.', 'এই ইমেইলটি অন্য অ্যাকাউন্টে ব্যবহৃত হচ্ছে।');
      case 'auth/invalid-email':
        return tr('That email address is not valid.', 'এই ইমেইল অ্যাড্রেসটি সঠিক নয়।');
      case 'auth/weak-password':
        return tr('The new password is too weak (min. 6 characters).', 'নতুন পাসওয়ার্ডটি দুর্বল (কমপক্ষে ৬ অক্ষর)।');
      default:
        return err?.message || tr('Something went wrong. Please try again.', 'সমস্যা হয়েছে। আবার চেষ্টা করুন।');
    }
  };

  // Change password / email (Firebase, with re-authentication)
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [newEmail, setNewEmail] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailMsg, setEmailMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const reauth = async (password: string) => {
    const user = auth.currentUser;
    if (!user || !user.email) throw new Error('no-firebase-user');
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
    return user;
  };

  const handleChangePassword = async () => {
    setPwMsg(null);
    if (!currentPw || newPw.length < 6) {
      setPwMsg({
        kind: 'err',
        text: tr('Enter your current password and a new password of at least 6 characters.', 'বর্তমান পাসওয়ার্ড এবং কমপক্ষে ৬ অক্ষরের নতুন পাসওয়ার্ড দিন।')
      });
      return;
    }
    setPwBusy(true);
    try {
      const user = await reauth(currentPw);
      await updatePassword(user, newPw);
      setCurrentPw('');
      setNewPw('');
      setPwMsg({ kind: 'ok', text: tr('Password changed.', 'পাসওয়ার্ড বদলানো হয়েছে।') });
    } catch (err: any) {
      setPwMsg({ kind: 'err', text: authErrorText(err) });
    } finally {
      setPwBusy(false);
    }
  };

  const handleChangeEmail = async () => {
    setEmailMsg(null);
    const clean = newEmail.toLowerCase().trim();
    if (!currentPw || !clean || !clean.includes('@')) {
      setEmailMsg({
        kind: 'err',
        text: tr('Enter your current password and a valid new email address.', 'বর্তমান পাসওয়ার্ড এবং একটি সঠিক নতুন ইমেইল দিন।')
      });
      return;
    }
    setEmailBusy(true);
    try {
      const user = await reauth(currentPw);
      await updateEmail(user, clean);
      try {
        await sendEmailVerification(user);
      } catch {
        /* verification resend is best-effort */
      }
      setNewEmail('');
      setEmailMsg({
        kind: 'ok',
        text: tr(
          'Email changed and a verification link was sent to the new address. Please verify it, and use the new email next time you sign in.',
          'ইমেইল বদলানো হয়েছে এবং নতুন ঠিকানায় ভেরিফিকেশন লিংক পাঠানো হয়েছে। যাচাই করুন এবং পরের বার নতুন ইমেইল দিয়ে সাইন ইন করুন।'
        )
      });
    } catch (err: any) {
      setEmailMsg({ kind: 'err', text: authErrorText(err) });
    } finally {
      setEmailBusy(false);
    }
  };

  // Active sessions (server connection registry, contract v2)
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const loadSessions = async () => {
    setSessionsLoading(true);
    try {
      setSessions(await fetchSessions());
    } finally {
      setSessionsLoading(false);
    }
  };

  useEffect(() => {
    if (activeModal === 'account') void loadSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeModal]);

  const handleRevokeSession = async (sessionId: string) => {
    setRevokingId(sessionId);
    try {
      if (await revokeSession(sessionId)) {
        setSessions((prev) => (prev ? prev.filter((s) => s.sessionId !== sessionId) : prev));
      }
    } finally {
      setRevokingId(null);
    }
  };

  const handleRevokeOthers = async () => {
    setRevokingId('__others__');
    try {
      if (await revokeOtherSessions()) await loadSessions();
    } finally {
      setRevokingId(null);
    }
  };

  // Local device wipe — removes every app-owned localStorage key. Logout
  // alone does NOT do this: local stores (messages, the registered-accounts
  // store incl. password hashes) stay on a shared device after logout.
  const wipeLocalAppData = () => {
    try {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && APP_KEY_PREFIX.test(k)) keys.push(k);
      }
      keys.forEach((k) => localStorage.removeItem(k));
    } catch {
      /* storage unavailable */
    }
  };

  const [eraseArmed, setEraseArmed] = useState(false);
  const handleEraseDevice = () => {
    wipeLocalAppData();
    onLogout();
  };

  // Delete account (type-to-confirm)
  const [deleteText, setDeleteText] = useState('');
  const [deletePw, setDeletePw] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDeleteAccount = async () => {
    setDeleteError(null);
    setDeleteBusy(true);
    try {
      // Server-side cleanup first, while the auth token is still valid:
      // release the username claim, then delete the directory entry
      // (which also drops server sessions).
      await releaseUsername().catch(() => false);
      await deleteDirectoryAccount().catch(() => false);
      const user = auth.currentUser;
      if (user) {
        if (deletePw && user.email) {
          try {
            await reauthenticateWithCredential(
              user,
              EmailAuthProvider.credential(user.email, deletePw)
            );
          } catch {
            /* deleteUser below surfaces a requires-recent-login error */
          }
        }
        await deleteUser(user);
      }
      wipeLocalAppData();
      onLogout();
    } catch (err: any) {
      setDeleteError(authErrorText(err));
    } finally {
      setDeleteBusy(false);
    }
  };

  // ── Scheduled-messages manager (Phase 1.8, server-side queue) ───────────
  interface ScheduledItemView {
    id: string;
    roomId: string;
    content: string;
    dueAt: number;
    status: string;
    reason?: string;
  }
  const [schedItems, setSchedItems] = useState<ScheduledItemView[] | null>(null);
  const [schedLoading, setSchedLoading] = useState(false);
  const [schedError, setSchedError] = useState(false);
  const [schedBusyId, setSchedBusyId] = useState<string | null>(null);
  const [dueEdits, setDueEdits] = useState<Record<string, string>>({});

  const toLocalInput = (ts: number): string => {
    const d = new Date(ts);
    return new Date(ts - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };

  const loadScheduled = async () => {
    setSchedLoading(true);
    setSchedError(false);
    try {
      const headers = await authHeaders(currentUser.id);
      const res = await fetch('/api/scheduled', { headers });
      if (!res.ok) throw new Error('bad status');
      const data = await res.json();
      const list: any[] = Array.isArray(data) ? data : data?.scheduled || [];
      setSchedItems(
        list.map((raw: any) => ({
          id: String(raw.id),
          roomId: String(raw.roomId || ''),
          content:
            typeof raw.message === 'string'
              ? raw.message
              : raw.message?.content ?? raw.content ?? '',
          dueAt:
            typeof raw.dueAt === 'number' ? raw.dueAt : Date.parse(raw.dueAt) || 0,
          status: typeof raw.status === 'string' ? raw.status : 'pending',
          reason: raw.reason || raw.failReason || undefined
        }))
      );
    } catch {
      setSchedError(true);
      setSchedItems(null);
    } finally {
      setSchedLoading(false);
    }
  };

  useEffect(() => {
    if (activeModal === 'scheduled') void loadScheduled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeModal]);

  const schedAction = async (id: string, fn: () => Promise<Response>) => {
    setSchedBusyId(id);
    try {
      const res = await fn();
      if (res.ok) await loadScheduled();
    } catch {
      /* list reload shows the true state */
    } finally {
      setSchedBusyId(null);
    }
  };

  const toggleDataSaver = () => {
    const next = !dataSaver;
    setDataSaver(next);
    try {
      localStorage.setItem('chitthi_data_saver', next ? '1' : '0');
    } catch {
      /* storage unavailable — the toggle still reflects the intent */
    }
  };

  // Removes the given keys and reports the honest outcome (bytes measured BEFORE removal)
  const clearStorageKeys = (keys: string[]) => {
    let freed = 0;
    try {
      for (const k of keys) {
        const v = localStorage.getItem(k);
        if (v !== null) freed += (k.length + v.length) * 2;
        localStorage.removeItem(k);
      }
    } catch {
      setClearResult(
        lang === 'bn'
          ? 'মুছতে সমস্যা হয়েছে — আবার চেষ্টা করুন'
          : 'Could not clear storage — please try again'
      );
      refreshStorage();
      return;
    }
    setClearResult(
      lang === 'bn'
        ? freed > 0
          ? `${formatBytes(freed)} খালি হয়েছে — পরিবর্তন দেখতে অ্যাপ রিলোড করুন`
          : 'খালি করার মতো কিছু ছিল না'
        : freed > 0
          ? `Freed ${formatBytes(freed)} — reload the app to see the change`
          : 'Nothing to clear — storage was already empty'
    );
    refreshStorage();
  };

  const appKeys = storageGroups
    ? storageGroups.flatMap((g) => g.keys).filter((k) => APP_KEY_PREFIX.test(k))
    : [];

  const cardClass =
    'bg-app border border-token rounded-[var(--r-card)] divide-y divide-[var(--c-border)] overflow-hidden';
  const groupLabelClass =
    'text-xs font-semibold uppercase tracking-wider text-app-2 px-1 mb-2';
  const rowClass =
    'px-4 py-3.5 flex items-center justify-between gap-3 hover:bg-surface  cursor-pointer transition-colors';
  const iconBoxClass =
    'w-7 h-7 rounded-lg flex items-center justify-center shrink-0';

  return (
    <div className="flex-1 flex flex-col h-full bg-surface  overflow-y-auto select-none relative">
      {/* Header — solid token bar (Phase 2 map: headers are never glass) */}
      <div className="sticky top-0 z-20 bg-header border-b border-token px-5 pt-4 pb-3 flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-app">
          {lang === 'bn' ? 'সেটিংস' : 'Settings'}
        </h1>
      </div>

      <div className="p-4 space-y-5 max-w-2xl mx-auto w-full">
        {/* Profile header */}
        <div
          onClick={onEditProfile}
          className="p-4 bg-app border border-token rounded-[var(--r-card)] flex items-center gap-4 cursor-pointer group hover:bg-surface transition-colors"
        >
          <img
            src={currentUser.avatar || initialsAvatarDataUrl(currentUser.name)}
            alt={currentUser.name}
            className="w-20 h-20 rounded-full bg-surface object-cover ring-2 ring-(--c-primary) group-hover:ring-(--c-primary) transition-colors shrink-0"
          />
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold text-app truncate bn-safe">
              {currentUser.name}
            </h2>
            {currentUser.username && (
              <p className="text-sm text-app-2 truncate mt-0.5">
                @{currentUser.username}
              </p>
            )}
            <p className="text-xs text-app-2 truncate mt-0.5 bn-safe">
              {currentUser.status}
            </p>
          </div>
          <ChevronRight className="w-5 h-5 text-app-faint group-hover:text-primary transition-colors shrink-0" />
        </div>

        {/* ── Account ─────────────────────────────────────────────────── */}
        <section>
          <h3 className={groupLabelClass}>{lang === 'bn' ? 'অ্যাকাউন্ট' : 'Account'}</h3>
          <div className={cardClass}>
            <div onClick={() => setActiveModal('account')} className={rowClass}>
              <div className="flex items-center gap-3 min-w-0">
                <span className={`${iconBoxClass} bg-bubble-in text-primary`}>
                  <UserIcon className="w-4 h-4" />
                </span>
                <span className="text-app text-[15px] font-medium">
                  {lang === 'bn' ? 'অ্যাকাউন্ট' : 'Account'}
                </span>
              </div>
              <ChevronRight className="w-4 h-4 text-app-faint shrink-0" />
            </div>
            <div onClick={onEditProfile} className={rowClass}>
              <div className="flex items-center gap-3 min-w-0">
                <span className={`${iconBoxClass} bg-bubble-in text-primary`}>
                  <UserIcon className="w-4 h-4" />
                </span>
                <span className="text-app text-[15px] font-medium">
                  {lang === 'bn' ? 'প্রোফাইল সম্পাদনা' : 'Edit profile'}
                </span>
              </div>
              <ChevronRight className="w-4 h-4 text-app-faint shrink-0" />
            </div>
          </div>
        </section>

        {/* ── Appearance ──────────────────────────────────────────────── */}
        <section>
          <h3 className={groupLabelClass}>{lang === 'bn' ? 'চেহারা' : 'Appearance'}</h3>
          <div className={cardClass}>
            {/* Dark Mode */}
            <div className="px-4 py-3.5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <span className={`${iconBoxClass} bg-bubble-in text-primary`}>
                  {isDarkMode ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
                </span>
                <span className="text-app text-[15px] font-medium">
                  {lang === 'bn' ? 'ডার্ক মোড' : 'Dark mode'}
                </span>
              </div>
              <button
                onClick={onToggleDarkMode}
                className={`w-11 h-6 flex items-center rounded-full p-1 transition-colors shrink-0 ${
                  isDarkMode ? 'bg-primary' : 'bg-pressed '
                }`}
               role="switch" aria-checked={isDarkMode} aria-label={lang === 'bn' ? 'ডার্ক মোড' : 'Dark mode'} >
                <div
                  className={`bg-app w-4 h-4 rounded-full shadow-md transform transition-transform ${
                    isDarkMode ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>

            {/* Language */}
            <div onClick={onToggleLang} className={rowClass}>
              <div className="flex items-center gap-3 min-w-0">
                <span className={`${iconBoxClass} bg-bubble-in text-primary`}>
                  <Globe className="w-4 h-4" />
                </span>
                <span className="text-app text-[15px] font-medium">
                  {lang === 'bn' ? 'ভাষা / Language' : 'Language (English / বাংলা)'}
                </span>
              </div>
              <span className="text-xs font-bold text-primary bg-bubble-in px-2.5 py-1 rounded-full shrink-0">
                {lang === 'bn' ? 'বাংলা' : 'English'}
              </span>
            </div>

            {/* Chat settings (fonts & chat behaviour live under Appearance) */}
            <div onClick={() => setActiveModal('chat')} className={rowClass}>
              <div className="flex items-center gap-3 min-w-0">
                <span className={`${iconBoxClass} bg-bubble-in text-primary`}>
                  <MessageCircle className="w-4 h-4" />
                </span>
                <span className="text-app text-[15px] font-medium">
                  {lang === 'bn' ? 'চ্যাট সেটিংস ও ফন্ট' : 'Chat settings'}
                </span>
              </div>
              <ChevronRight className="w-4 h-4 text-app-faint shrink-0" />
            </div>
          </div>
        </section>

        {/* ── Notifications ───────────────────────────────────────────── */}
        <section>
          <h3 className={groupLabelClass}>{lang === 'bn' ? 'নোটিফিকেশন' : 'Notifications'}</h3>
          <div className={cardClass}>
            <div onClick={() => setActiveModal('notification')} className={rowClass}>
              <div className="flex items-center gap-3 min-w-0">
                <span className={`${iconBoxClass} bg-away text-away `}>
                  <Bell className="w-4 h-4" />
                </span>
                <span className="text-app text-[15px] font-medium">
                  {lang === 'bn' ? 'নোটিফিকেশন ও অ্যালার্ট' : 'Notification'}
                </span>
              </div>
              <ChevronRight className="w-4 h-4 text-app-faint shrink-0" />
            </div>
          </div>
        </section>

        {/* ── Scheduled ─────────────────────────────────────────────── */}
        <section>
          <h3 className={groupLabelClass}>{lang === 'bn' ? 'শিডিউল' : 'Scheduled'}</h3>
          <div className={cardClass}>
            <div onClick={() => setActiveModal('scheduled')} className={rowClass}>
              <div className="flex items-center gap-3 min-w-0">
                <span className={`${iconBoxClass} bg-away text-away `}>
                  <CalendarClock className="w-4 h-4" />
                </span>
                <span className="text-app text-[15px] font-medium">
                  {lang === 'bn' ? 'শিডিউল করা মেসেজ' : 'Scheduled messages'}
                </span>
              </div>
              <ChevronRight className="w-4 h-4 text-app-faint shrink-0" />
            </div>
          </div>
        </section>

        {/* ── Privacy ─────────────────────────────────────────────────── */}
        <section>
          <h3 className={groupLabelClass}>{lang === 'bn' ? 'প্রাইভেসি' : 'Privacy'}</h3>
          <div className={cardClass}>
            <div onClick={() => setActiveModal('privacy')} className={rowClass}>
              <div className="flex items-center gap-3 min-w-0">
                <span className={`${iconBoxClass} bg-bubble-in text-primary`}>
                  <Lock className="w-4 h-4" />
                </span>
                <span className="text-app text-[15px] font-medium">
                  {lang === 'bn' ? 'প্রাইভেসি ও সিকিউরিটি' : 'Privacy and security'}
                </span>
              </div>
              <ChevronRight className="w-4 h-4 text-app-faint shrink-0" />
            </div>
          </div>
        </section>

        {/* ── Storage ─────────────────────────────────────────────────── */}
        <section>
          <h3 className={groupLabelClass}>{lang === 'bn' ? 'স্টোরেজ' : 'Storage'}</h3>
          <div className={cardClass}>
            <div onClick={() => setActiveModal('storage')} className={rowClass}>
              <div className="flex items-center gap-3 min-w-0">
                <span className={`${iconBoxClass} bg-bubble-in text-online `}>
                  <Database className="w-4 h-4" />
                </span>
                <span className="text-app text-[15px] font-medium">
                  {lang === 'bn' ? 'ডাটা ও স্টোরেজ ম্যানেজমেন্ট' : 'Data and storage'}
                </span>
              </div>
              <ChevronRight className="w-4 h-4 text-app-faint shrink-0" />
            </div>
          </div>
        </section>

        {/* ── Help ────────────────────────────────────────────────────── */}
        <section>
          <h3 className={groupLabelClass}>{lang === 'bn' ? 'সাহায্য' : 'Help'}</h3>
          <div className={cardClass}>
            <div onClick={() => setActiveModal('about')} className={rowClass}>
              <div className="flex items-center gap-3 min-w-0">
                <span className={`${iconBoxClass} bg-bubble-in text-primary`}>
                  <Info className="w-4 h-4" />
                </span>
                <span className="text-app text-[15px] font-medium">
                  {lang === 'bn' ? 'অ্যাপ সম্পর্কে' : 'About'}
                </span>
              </div>
              <ChevronRight className="w-4 h-4 text-app-faint shrink-0" />
            </div>
          </div>
        </section>

        {/* Log Out Button */}
        <div className="pt-1">
          <button
            onClick={onLogout}
            className="w-full p-4 bg-app  hover:bg-surface  border border-token  text-danger rounded-[var(--r-card)] font-bold text-xs sm:text-sm flex items-center justify-center gap-2 transition-colors"
          >
            <LogOut className="w-4 h-4" />
            <span>{lang === 'bn' ? 'লগআউট করুন (Log Out)' : 'Log Out'}</span>
          </button>
        </div>
      </div>

      {/* Interactive Settings Modals */}
      {activeModal && (
        <div className="fixed inset-0 z-50 bg-black/60  flex items-center justify-center p-4 animate-in fade-in">
          <div className="glass-sheet rounded-[var(--r-sheet)] w-full max-w-sm p-6 shadow-soft relative max-h-[85vh] overflow-y-auto transition-[opacity,transform] [transition-duration:var(--dur-sheet)] [transition-timing-function:var(--ease-spring)]" role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'সেটিংস' : 'Settings'} >
            <button
              onClick={() => setActiveModal(null)}
              className="absolute top-2 right-2 min-w-[44px] min-h-[44px] flex items-center justify-center text-app-faint hover:text-app rounded-lg"
              aria-label={lang === 'bn' ? 'বন্ধ করুন' : 'Close'}
            >
              <X className="w-5 h-5" />
            </button>

            {activeModal === 'notification' && (
              <div className="space-y-4">
                <h3 className="text-base font-bold text-app">
                  {lang === 'bn' ? 'নোটিফিকেশন প্রেফারেন্স' : 'Notifications'}
                </h3>
                <div className="space-y-3 text-xs text-app">
                  <label className="flex items-center justify-between gap-3 min-h-[44px] px-3 py-2 rounded-xl bg-surface cursor-pointer">
                    <span>{lang === 'bn' ? 'মেসেজ নোটিফিকেশন' : 'Message notifications'}</span>
                    <input
                      type="checkbox"
                      checked={notifMessages}
                      onChange={(e) => void handleNotifMessagesChange(e.target.checked)}
                      className="accent-(--c-primary) w-5 h-5 shrink-0"
                      aria-label={lang === 'bn' ? 'মেসেজ নোটিফিকেশন' : 'Message notifications'}
                    />
                  </label>
                  <label className="flex items-center justify-between gap-3 min-h-[44px] px-3 py-2 rounded-xl bg-surface cursor-pointer">
                    <span>{lang === 'bn' ? 'নোটিফিকেশন সাউন্ড' : 'Notification sound'}</span>
                    <input
                      type="checkbox"
                      checked={notifSound}
                      onChange={(e) => handleNotifSoundChange(e.target.checked)}
                      className="accent-(--c-primary) w-5 h-5 shrink-0"
                      aria-label={lang === 'bn' ? 'নোটিফিকেশন সাউন্ড' : 'Notification sound'}
                    />
                  </label>
                  {notifBlocked && (
                    <p className="text-[11px] text-danger leading-snug px-1">
                      {lang === 'bn'
                        ? 'এই ব্রাউজারে নোটিফিকেশন ব্লক করা আছে। চালু করতে ব্রাউজারের সাইট সেটিংস থেকে নোটিফিকেশনের অনুমতি দিন।'
                        : 'Notifications are blocked in this browser. Allow notifications in the browser site settings to turn this on.'}
                    </p>
                  )}
                  <label className="flex items-center justify-between p-2 rounded-xl bg-surface cursor-pointer">
                    <span>{lang === 'bn' ? 'কল রিংটোন' : 'Call Ringtone'}</span>
                    <input
                      type="checkbox"
                      checked={ringtoneEnabled}
                      onChange={(e) => {
                        setRingtoneEnabled(e.target.checked);
                        try {
                          localStorage.setItem('chitthi_ringtone', e.target.checked ? '1' : '0');
                        } catch { /* storage unavailable */ }
                      }}
                      className="accent-(--c-primary) w-4 h-4"
                    />
                  </label>
                </div>
                <p className="text-[11px] text-app-faint leading-snug">
                  {lang === 'bn'
                    ? 'নোটিফিকেশন ও রিংটোন পছন্দ সাথে সাথে সংরক্ষিত হয়।'
                    : 'Notification and ringtone preferences are saved as soon as you change them.'}
                </p>
              </div>
            )}

            {activeModal === 'chat' && (
              <div className="space-y-4">
                <h3 className="text-base font-bold text-app">
                  {lang === 'bn' ? 'চ্যাট সেটিংস' : 'Chat Settings'}
                </h3>
                <div className="space-y-3 text-xs text-app">
                  <label className="flex items-center justify-between p-2 rounded-xl bg-surface cursor-pointer">
                    <span>{lang === 'bn' ? 'Enter চাপলে সেন্ড হবে' : 'Enter to Send'}</span>
                    <input
                      type="checkbox"
                      checked={enterToSend}
                      onChange={(e) => toggleEnterToSend(e.target.checked)}
                      className="accent-(--c-primary) w-4 h-4"
                    />
                  </label>
                </div>
                <p className="text-[11px] text-app-faint leading-snug">
                  {lang === 'bn'
                    ? 'পরিবর্তনটি সাথে সাথে সংরক্ষিত হয় এবং চ্যাটে প্রযোজ্য হয়।'
                    : 'Saved as soon as you change it, and applied in chats right away.'}
                </p>
              </div>
            )}

            {activeModal === 'storage' && (() => {
              const total = (storageGroups ?? []).reduce((a, g) => a + g.bytes, 0);
              const nonEmpty = (storageGroups ?? []).filter((g) => g.keys.length > 0);
              const keysOf = (id: string) => storageGroups?.find((g) => g.id === id)?.keys ?? [];
              const tr = (en: string, bn: string) => (lang === 'bn' ? bn : en);

              // Enumerate exactly what Clear-all destroys (Phase 0.10) —
              // counts read from the real keys, not guessed.
              const countItems = (raw: string | null, pred?: (item: any) => boolean): number => {
                try {
                  const parsed = raw ? JSON.parse(raw) : null;
                  if (!Array.isArray(parsed)) return 0;
                  return pred ? parsed.filter(pred).length : parsed.length;
                } catch {
                  return 0;
                }
              };
              const scheduledCount = countItems(localStorage.getItem('chitthi_scheduled_v1'));
              const savedCount = countItems(
                localStorage.getItem('chithi_messages_v5'),
                (m) => m?.roomId === 'saved_messages'
              );
              const draftCount = keysOf('drafts').length;
              const clearAllDetail: string[] = [
                `${tr('Messages & media', 'মেসেজ ও মিডিয়া')}: ${formatBytes(storageGroups?.find((g) => g.id === 'messages')?.bytes ?? 0)}`,
                `${tr('Scheduled messages', 'শিডিউল করা মেসেজ')}: ${scheduledCount}`,
                `${tr('Drafts', 'ড্রাফট')}: ${draftCount}`,
                `${tr('Saved Messages (on this device)', 'সেভ করা মেসেজ (এই ডিভাইসে)')}: ${savedCount}`,
                `${tr('Stories, call history, accounts & preferences on this device', 'এই ডিভাইসের স্টোরি, কল হিস্ট্রি, অ্যাকাউন্ট ও পছন্দসমূহ')}`,
              ];

              const ClearAction = ({
                scope,
                titleEn,
                titleBn,
                keys,
                danger,
                detail,
              }: {
                scope: 'messages' | 'calls' | 'all';
                titleEn: string;
                titleBn: string;
                keys: string[];
                danger?: boolean;
                detail?: string[];
              }) =>
                confirmClear === scope ? (
                  <div className="p-3 rounded-xl bg-surface  border border-token  space-y-2">
                    <p className="text-xs font-semibold text-danger ">
                      {tr('This cannot be undone. Continue?', 'এটা ফেরানো যাবে না। চালিয়ে যাবেন?')}
                    </p>
                    {detail && detail.length > 0 && (
                      <ul className="text-[11px] text-danger  space-y-0.5 list-disc pl-4">
                        {detail.map((d) => (
                          <li key={d}>{d}</li>
                        ))}
                      </ul>
                    )}
                    <div className="flex gap-2">
                      <button
                        onClick={() => setConfirmClear(null)}
                        className="flex-1 py-2 rounded-xl bg-app border border-token  text-xs font-bold text-app-2"
                      >
                        {tr('Cancel', 'বাতিল')}
                      </button>
                      <button
                        onClick={() => clearStorageKeys(keys)}
                        className="flex-1 py-2 rounded-xl bg-danger hover:brightness-110 text-white text-xs font-bold"
                      >
                        {tr('Yes, delete', 'হ্যাঁ, মুছুন')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => (keys.length > 0 ? setConfirmClear(scope) : setClearResult(tr('Nothing to clear — storage was already empty', 'খালি করার মতো কিছু ছিল না')))}
                    className={`w-full py-2.5 rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition-colors ${
                      danger
                        ? 'bg-danger hover:brightness-110 text-white'
                        : 'bg-surface hover:bg-pressed text-app'
                    }`}
                  >
                    <Trash2 className="w-4 h-4" />
                    <span>{tr(titleEn, titleBn)}</span>
                  </button>
                );

              return (
                <div className="space-y-4">
                  <h3 className="text-base font-bold text-app">
                    {lang === 'bn' ? 'ডাটা ও স্টোরেজ' : 'Data & Storage'}
                  </h3>

                  {/* Real usage, measured from localStorage */}
                  <div className="p-3 bg-surface rounded-xl space-y-2.5 text-xs">
                    <div className="flex items-center justify-between">
                      <p className="font-semibold text-app">
                        {lang === 'bn' ? 'মোট ব্যবহৃত স্টোরেজ:' : 'Local storage usage:'}
                      </p>
                      <p className="text-primary font-mono font-bold text-sm">
                        {storageError ? '—' : formatBytes(total)}
                      </p>
                    </div>
                    {storageError ? (
                      <p className="text-app-2">
                        {tr('Storage is not available in this browser.', 'এই ব্রাউজারে স্টোরেজ পাওয়া যাচ্ছে না।')}
                      </p>
                    ) : nonEmpty.length === 0 ? (
                      <p className="text-app-2">
                        {tr('Nothing stored yet.', 'এখনো কিছু সংরক্ষণ হয়নি।')}
                      </p>
                    ) : (
                      nonEmpty.map((g) => (
                        <div key={g.id} className="space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="text-app-2">
                              {lang === 'bn' ? g.labelBn : g.labelEn}
                            </span>
                            <span className="font-mono font-semibold text-app">
                              {formatBytes(g.bytes)}
                            </span>
                          </div>
                          <div className="h-1.5 rounded-full bg-pressed overflow-hidden">
                            <div
                              className="h-1.5 rounded-full bg-primary transition-colors"
                              style={{ width: `${total > 0 ? Math.max(2, (g.bytes / total) * 100) : 0}%` }}
                            />
                          </div>
                          <p className="text-[10px] text-app-faint">
                            {g.keys.length} {tr('items', 'টি আইটেম')}
                          </p>
                        </div>
                      ))
                    )}
                  </div>

                  {/* Honest result of the last clear action */}
                  {clearResult && (
                    <div className="p-3 rounded-xl bg-surface  border border-token ">
                      <p className="text-xs font-semibold text-online ">{clearResult}</p>
                    </div>
                  )}

                  {/* Data saver */}
                  <div className="flex items-center justify-between gap-3 p-3 rounded-xl bg-surface">
                    <div className="flex items-start gap-2.5 min-w-0">
                      <Wifi className="w-5 h-5 text-online shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <p className="text-xs font-bold text-app">
                          {tr('Data saver', 'ডেটা সেভার')}
                        </p>
                        <p className="text-[11px] text-app-2 leading-snug">
                          {tr(
                            'Images in chats load on tap instead of automatically',
                            'চ্যাটে ছবি অটো লোড না হয়ে ট্যাপ করলে লোড হবে'
                          )}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={toggleDataSaver}
                      className={`w-11 h-6 flex items-center rounded-full p-1 transition-colors shrink-0 ${
                        dataSaver ? 'bg-primary' : 'bg-pressed '
                      }`}
                      title={tr('Data saver', 'ডেটা সেভার')} aria-label={tr('Data saver', 'ডেটা সেভার')}
                     role="switch" aria-checked={dataSaver} >
                      <div
                        className={`bg-app w-4 h-4 rounded-full shadow-md transform transition-transform ${
                          dataSaver ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>

                  {/* Clear actions */}
                  <div className="space-y-2">
                    <ClearAction
                      scope="messages"
                      titleEn="Clear messages & media cache"
                      titleBn="মেসেজ ও মিডিয়া ক্যাশে মুছুন"
                      keys={keysOf('messages')}
                    />
                    <ClearAction
                      scope="calls"
                      titleEn="Clear call history"
                      titleBn="কল হিস্ট্রি মুছুন"
                      keys={keysOf('calls')}
                    />
                    <ClearAction
                      scope="all"
                      titleEn="Clear all local app data"
                      titleBn="সব লোকাল ডেটা মুছুন"
                      keys={appKeys}
                      danger
                      detail={clearAllDetail}
                    />
                  </div>
                  <p className="text-[11px] text-app-faint leading-snug">
                    {tr(
                      'Clearing only removes data on this device. Chats stay in memory until you reload the app.',
                      'শুধু এই ডিভাইসের ডেটা মুছবে। অ্যাপ রিলোড না করা পর্যন্ত চ্যাট মেমোরিতে থাকবে।'
                    )}
                  </p>
                </div>
              );
            })()}

            {activeModal === 'privacy' && (
              <div className="space-y-4">
                <h3 className="text-base font-bold text-app">
                  {lang === 'bn' ? 'প্রাইভেসি ও সিকিউরিটি' : 'Privacy & Security'}
                </h3>
                <div className="space-y-2 text-xs">
                  <p className="text-app-2">
                    {lang === 'bn'
                      ? 'মেসেজ এনক্রিপ্টেড সংযোগে পাঠানো হয় (HTTPS/WSS; কলে WebRTC DTLS-SRTP) এবং Chitthi সার্ভারে সংরক্ষিত থাকে যাতে আপনার সব ডিভাইসে sync হয়। এগুলো এখনো end-to-end encrypted নয় — end-to-end encryption roadmap-এ আছে।'
                      : 'Messages are sent over an encrypted connection (HTTPS/WSS; calls use WebRTC DTLS-SRTP) and stored on the Chitthi server so they can sync across your devices. They are not end-to-end encrypted yet — end-to-end encryption is on the roadmap.'}
                  </p>
                </div>

                {/* Privacy audiences (Phase 1.4.4, WhatsApp pattern).
                    "My contacts" = people you share a DM or group with —
                    Chitthi has no address book. Saved locally and to the
                    server directory on every change. */}
                <div className="space-y-3">
                  <h4 className="text-xs font-bold text-app">
                    {tr('Who can see my info', 'কারা আমার তথ্য দেখতে পারবে')}
                  </h4>
                  {(
                    [
                      {
                        field: 'photo',
                        label: tr('Profile photo', 'প্রোফাইল ছবি'),
                        options: ['everyone', 'contacts', 'nobody']
                      },
                      {
                        field: 'about',
                        label: tr('About', 'About'),
                        options: ['everyone', 'contacts', 'nobody']
                      },
                      {
                        field: 'lastSeen',
                        label: tr('Last seen & online', 'Last seen ও online'),
                        hint: tr(
                          'If you hide yours, you will not see other people\u2019s either.',
                          'নিজেরটা লুকালে অন্যদেরটাও দেখতে পারবেন না।'
                        ),
                        options: ['everyone', 'contacts', 'nobody']
                      },
                      {
                        field: 'findMe',
                        label: tr('Who can find me by @username', 'কে @username দিয়ে আমাকে খুঁজে পাবে'),
                        options: ['everyone', 'nobody']
                      },
                      {
                        field: 'groupAdd',
                        label: tr('Who can add me to groups', 'কে আমাকে গ্রুপে যোগ করতে পারবে'),
                        options: ['everyone', 'contacts', 'nobody']
                      }
                    ] as const
                  ).map((row) => (
                    <div key={row.field} className="space-y-1.5">
                      <p className="text-xs font-semibold text-app">{row.label}</p>
                      {'hint' in row && row.hint && (
                        <p className="text-[11px] text-app-faint leading-snug">{row.hint}</p>
                      )}
                      <div className="flex gap-1 p-1 rounded-xl bg-surface">
                        {row.options.map((opt) => {
                          const active = privacy[row.field] === opt;
                          return (
                            <button
                              key={opt}
                              onClick={() =>
                                updatePrivacy(
                                  row.field,
                                  opt as PrivacyAudiences[typeof row.field]
                                )
                              }
                              className={`flex-1 py-1.5 rounded-lg text-[11px] font-bold transition-colors ${
                                active
                                  ? 'bg-primary text-white shadow-xs'
                                  : 'text-app-2 hover:text-app'
                              }`}
                             aria-pressed={active} >
                              {opt === 'everyone'
                                ? tr('Everyone', 'সবাই')
                                : opt === 'contacts'
                                  ? tr('My contacts', 'আমার কন্টাক্ট')
                                  : tr('Nobody', 'কেউ না')}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                  <p className="text-[11px] text-app-faint leading-snug">
                    {tr(
                      '"My contacts" means people you already share a direct chat or a group with — Chitthi has no address book. A hidden photo shows your initials instead; a hidden last seen shows nothing.',
                      '"আমার কন্টাক্ট" মানে যাদের সাথে আপনার সরাসরি চ্যাট বা গ্রুপ আছে — Chitthi-তে কোনো address book নেই। ছবি লুকালে initials দেখাবে; last seen লুকালে কিছুই দেখাবে না।'
                    )}
                  </p>
                </div>

                {/* Manual presence picker (Phase 1 follow-up) */}
                <div className="space-y-2">
                  <h4 className="text-xs font-bold text-app">
                    {tr('My presence', 'আমার উপস্থিতি')}
                  </h4>
                  <div className="flex gap-1 p-1 rounded-xl bg-surface">
                    {(
                      [
                        { key: 'online', en: 'Online', bn: 'অনলাইন', dot: 'bg-online' },
                        { key: 'away', en: 'Away', bn: 'দূরে আছি', dot: 'bg-away' },
                        { key: 'invisible', en: 'Invisible', bn: 'অদৃশ্য', dot: 'bg-[var(--c-text-faint)]' }
                      ] as const
                    ).map((opt) => {
                      const active = presenceMode === opt.key;
                      return (
                        <button
                          key={opt.key}
                          onClick={() => setPresenceMode(opt.key)}
                          className={`flex-1 py-1.5 rounded-lg text-[11px] font-bold transition-colors flex items-center justify-center gap-1.5 ${
                            active
                              ? 'bg-primary text-white shadow-xs'
                              : 'text-app-2 hover:text-app'
                          }`}
                         aria-pressed={active} >
                          <span className={`w-2 h-2 rounded-full shrink-0 ${opt.dot}`} />
                          {tr(opt.en, opt.bn)}
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-[11px] text-app-faint leading-snug">
                    {tr(
                      'Invisible: you appear offline to everyone, but you still receive everything — all messages and calls as usual.',
                      'Invisible: সবাই আপনাকে অফলাইন দেখবে, কিন্তু আপনি সবকিছুই পাবেন — সব মেসেজ ও কল আগের মতোই।'
                    )}
                  </p>
                </div>

                {/* Blocked users (Phase 0.11) */}
                <div className="space-y-2">
                  <h4 className="text-xs font-bold text-app">
                    {lang === 'bn' ? 'ব্লক করা ব্যবহারকারী' : 'Blocked users'}
                  </h4>
                  {!blockedLoaded ? (
                    <p className="text-xs text-app-2">
                      {lang === 'bn' ? 'লোড হচ্ছে...' : 'Loading...'}
                    </p>
                  ) : blockedIds.length === 0 ? (
                    <p className="text-xs text-app-2">
                      {lang === 'bn'
                        ? 'আপনি কাউকে ব্লক করেননি। ব্লক করা ব্যবহারকারীরা আপনাকে মেসেজ বা কল করতে পারবে না।'
                        : 'You have not blocked anyone. Blocked users cannot message or call you.'}
                    </p>
                  ) : (
                    <div className="space-y-1.5">
                      {blockedIds.map((id) => {
                        const u = resolveKnownUser(id);
                        return (
                          <div
                            key={id}
                            className="flex items-center gap-2.5 p-2 rounded-xl bg-surface"
                          >
                            {u?.avatar ? (
                              <img
                                src={u.avatar}
                                alt={u.name}
                                className="w-8 h-8 rounded-full object-cover shrink-0"
                              />
                            ) : (
                              <span className="w-8 h-8 rounded-full bg-bubble-in text-primary flex items-center justify-center text-xs font-bold shrink-0">
                                {(u?.name || id).charAt(0).toUpperCase()}
                              </span>
                            )}
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-semibold text-app truncate bn-safe">
                                {u?.name || id}
                              </p>
                              {u?.username && (
                                <p className="text-[10px] text-app-2 truncate">@{u.username}</p>
                              )}
                            </div>
                            <button
                              onClick={() => void unblockUser(id)}
                              className="px-2.5 py-1.5 rounded-lg bg-app border border-token  text-[11px] font-bold text-primary shrink-0"
                            >
                              {lang === 'bn' ? 'আনব্লক' : 'Unblock'}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
                {/* Privacy policy (Phase 1.7) */}
                <button
                  onClick={() => setActiveModal('policy')}
                  className="w-full py-2.5 px-3 rounded-xl bg-surface hover:bg-pressed flex items-center justify-between transition-colors"
                >
                  <span className="flex items-center gap-2 text-xs font-bold text-app">
                    <FileText className="w-4 h-4 text-primary" />
                    {tr('Privacy Policy', 'প্রাইভেসি পলিসি')}
                  </span>
                  <ChevronRight className="w-4 h-4 text-app-faint" />
                </button>

                <button
                  onClick={() => setActiveModal(null)}
                  className="w-full py-2.5 bg-primary hover:brightness-110 text-white rounded-xl font-bold text-xs transition-colors"
                >
                  {lang === 'bn' ? 'ঠিক আছে' : 'OK'}
                </button>
              </div>
            )}

            {activeModal === 'account' && (
              <div className="space-y-5">
                <h3 className="text-base font-bold text-app">
                  {tr('Account', 'অ্যাকাউন্ট')}
                </h3>

                {/* Email on file */}
                <div className="p-3 rounded-xl bg-surface flex items-center gap-3">
                  <Mail className="w-5 h-5 text-primary shrink-0" />
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold text-app-faint uppercase tracking-wide">
                      {tr('Email', 'ইমেইল')}
                    </p>
                    <p className="text-xs font-semibold text-app truncate">
                      {accountEmail || tr('No email on this account', 'এই অ্যাকাউন্টে কোনো ইমেইল নেই')}
                    </p>
                  </div>
                </div>

                {fbUser ? (
                  <>
                    {/* Change password */}
                    <div className="space-y-2">
                      <h4 className="text-xs font-bold text-app flex items-center gap-1.5">
                        <KeyRound className="w-3.5 h-3.5 text-primary" />
                        {tr('Change password', 'পাসওয়ার্ড বদলান')}
                      </h4>
                      <input
                        type="password"
                        value={currentPw}
                        onChange={(e) => setCurrentPw(e.target.value)}
                        placeholder={tr('Current password', 'বর্তমান পাসওয়ার্ড')} aria-label={tr('Current password', 'বর্তমান পাসওয়ার্ড')}
                        className="w-full rounded-xl bg-surface px-3 py-2.5 text-xs text-app placeholder:text-app-faint    border border-transparent"
                      />
                      <input
                        type="password"
                        value={newPw}
                        onChange={(e) => setNewPw(e.target.value)}
                        placeholder={tr('New password (min. 6 characters)', 'নতুন পাসওয়ার্ড (কমপক্ষে ৬ অক্ষর)')} aria-label={tr('New password (min. 6 characters)', 'নতুন পাসওয়ার্ড (কমপক্ষে ৬ অক্ষর)')}
                        className="w-full rounded-xl bg-surface px-3 py-2.5 text-xs text-app placeholder:text-app-faint    border border-transparent"
                      />
                      {pwMsg && (
                        <p className={`text-[11px] leading-snug ${pwMsg.kind === 'ok' ? 'text-online ' : 'text-danger '}`}>
                          {pwMsg.text}
                        </p>
                      )}
                      <button
                        onClick={() => void handleChangePassword()}
                        disabled={pwBusy}
                        className="w-full py-2 rounded-xl bg-surface hover:bg-pressed text-app text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-50"
                      >
                        {pwBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                        {tr('Update password', 'পাসওয়ার্ড আপডেট করুন')}
                      </button>
                    </div>

                    {/* Change email */}
                    <div className="space-y-2">
                      <h4 className="text-xs font-bold text-app flex items-center gap-1.5">
                        <Mail className="w-3.5 h-3.5 text-primary" />
                        {tr('Change email', 'ইমেইল বদলান')}
                      </h4>
                      <input
                        type="email"
                        value={newEmail}
                        onChange={(e) => setNewEmail(e.target.value)}
                        placeholder={tr('New email address', 'নতুন ইমেইল অ্যাড্রেস')} aria-label={tr('New email address', 'নতুন ইমেইল অ্যাড্রেস')}
                        className="w-full rounded-xl bg-surface px-3 py-2.5 text-xs text-app placeholder:text-app-faint    border border-transparent"
                      />
                      <p className="text-[11px] text-app-faint leading-snug">
                        {tr(
                          'Uses your current password (entered above) to confirm it is you. A verification link is sent to the new address.',
                          'আপনিই কিনা নিশ্চিত করতে উপরে দেওয়া বর্তমান পাসওয়ার্ড ব্যবহৃত হবে। নতুন ঠিকানায় ভেরিফিকেশন লিংক পাঠানো হবে।'
                        )}
                      </p>
                      {emailMsg && (
                        <p className={`text-[11px] leading-snug ${emailMsg.kind === 'ok' ? 'text-online ' : 'text-danger '}`}>
                          {emailMsg.text}
                        </p>
                      )}
                      <button
                        onClick={() => void handleChangeEmail()}
                        disabled={emailBusy}
                        className="w-full py-2 rounded-xl bg-surface hover:bg-pressed text-app text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-50"
                      >
                        {emailBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                        {tr('Update email', 'ইমেইল আপডেট করুন')}
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="text-[11px] text-app-faint leading-snug">
                    {tr(
                      'This account is stored only on this device (no Firebase sign-in session), so password and email changes are not available here. You can remove it from this device with "Erase this device\u2019s data" below.',
                      'এই অ্যাকাউন্টটি শুধু এই ডিভাইসেই সংরক্ষিত (কোনো Firebase সাইন-ইন সেশন নেই), তাই এখানে পাসওয়ার্ড/ইমেইল বদলানো যাবে না। নিচের "Erase this device\u2019s data" দিয়ে ডিভাইস থেকে সরাতে পারেন।'
                    )}
                  </p>
                )}

                {/* Active sessions */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-bold text-app flex items-center gap-1.5">
                      <Smartphone className="w-3.5 h-3.5 text-primary" />
                      {tr('Active sessions', 'সক্রিয় সেশন')}
                    </h4>
                    <button
                      onClick={() => void loadSessions()}
                      className="min-w-[44px] min-h-[44px] flex items-center justify-center text-app-faint hover:text-app rounded-lg"
                      title={tr('Refresh', 'রিফ্রেশ')} aria-label={tr('Refresh', 'রিফ্রেশ')}
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${sessionsLoading ? 'animate-spin' : ''}`} />
                    </button>
                  </div>
                  {sessionsLoading && sessions === null ? (
                    <p className="text-xs text-app-2">{tr('Loading...', 'লোড হচ্ছে...')}</p>
                  ) : sessions === null ? (
                    <p className="text-xs text-app-2 leading-snug">
                      {tr(
                        'Could not load your sessions — the server could not be reached or does not recognise this sign-in.',
                        'সেশন লোড করা যায়নি — সার্ভারে পৌঁছানো যাচ্ছে না অথবা এই সাইন-ইনটি সার্ভার চিনতে পারছে না।'
                      )}
                    </p>
                  ) : sessions.length === 0 ? (
                    <div className="rounded-[var(--r-card)] border border-dashed border-token bg-surface px-4 py-6 text-center space-y-2">
                      <Smartphone className="w-8 h-8 mx-auto text-app-faint" />
                      <p className="text-xs text-app-2">
                        {tr('No active sessions found.', 'কোনো সক্রিয় সেশন পাওয়া যায়নি।')}
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {sessions.map((s) => (
                        <div key={s.sessionId} className="flex items-center gap-2.5 p-2.5 rounded-xl bg-surface">
                          <Smartphone className="w-4 h-4 text-app-faint shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-semibold text-app truncate flex items-center gap-1.5">
                              <span className="truncate bn-safe">{s.deviceLabel || tr('Unknown device', 'অজানা ডিভাইস')}</span>
                              {s.current && (
                                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-bubble-in  text-online  shrink-0">
                                  {tr('This device', 'এই ডিভাইস')}
                                </span>
                              )}
                            </p>
                            <p className="text-[10px] text-app-2">
                              {tr('Last active', 'শেষ সক্রিয়')}:{' '}
                              {s.lastActive
                                ? new Date(s.lastActive).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
                                : '—'}
                            </p>
                          </div>
                          {!s.current && (
                            <button
                              onClick={() => void handleRevokeSession(s.sessionId)}
                              disabled={revokingId === s.sessionId}
                              className="px-2.5 py-1.5 rounded-lg bg-app border border-token  text-[11px] font-bold text-danger  shrink-0 disabled:opacity-50"
                            >
                              {revokingId === s.sessionId
                                ? tr('Logging out...', 'লগআউট হচ্ছে...')
                                : tr('Log out', 'লগআউট')}
                            </button>
                          )}
                        </div>
                      ))}
                      {sessions.some((s) => !s.current) && (
                        <button
                          onClick={() => void handleRevokeOthers()}
                          disabled={revokingId === '__others__'}
                          className="w-full py-2 rounded-xl bg-surface hover:bg-pressed text-xs font-bold text-danger  disabled:opacity-50"
                        >
                          {tr('Log out all other devices', 'অন্য সব ডিভাইস থেকে লগআউট')}
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Erase this device */}
                <div className="space-y-2 pt-1 border-t border-token ">
                  <h4 className="text-xs font-bold text-app">
                    {tr('Erase this device\u2019s data', 'এই ডিভাইসের ডেটা মুছুন')}
                  </h4>
                  <p className="text-[11px] text-app-2 leading-snug">
                    {tr(
                      'Warning: logging out alone leaves this app\u2019s local data on the device — including chat copies and the on-device account store with password hashes. On a shared device, erase the data as well.',
                      'সতর্কতা: শুধু লগআউট করলে এই ডিভাইসে অ্যাপের লোকাল ডেটা থেকে যায় — চ্যাটের কপি এবং পাসওয়ার্ড হ্যাশসহ অন-ডিভাইস অ্যাকাউন্ট স্টোরসহ। শেয়ার করা ডিভাইসে ডেটাও মুছে ফেলুন।'
                    )}
                  </p>
                  {eraseArmed ? (
                    <div className="flex gap-2">
                      <button
                        onClick={() => setEraseArmed(false)}
                        className="flex-1 py-2 rounded-xl bg-surface text-xs font-bold text-app"
                      >
                        {tr('Cancel', 'বাতিল')}
                      </button>
                      <button
                        onClick={handleEraseDevice}
                        className="flex-1 py-2 rounded-xl bg-danger hover:brightness-110 text-white text-xs font-bold"
                      >
                        {tr('Yes, erase & log out', 'হ্যাঁ, মুছে লগআউট')}
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setEraseArmed(true)}
                      className="w-full py-2 rounded-xl bg-surface hover:bg-pressed text-xs font-bold text-app"
                    >
                      {tr('Erase this device\u2019s data', 'এই ডিভাইসের ডেটা মুছুন')}
                    </button>
                  )}
                </div>

                {/* Delete account */}
                <div className="space-y-2 pt-1 border-t border-token ">
                  <h4 className="text-xs font-bold text-danger  flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    {tr('Delete account', 'অ্যাকাউন্ট মুছে ফেলুন')}
                  </h4>
                  <p className="text-[11px] text-app-2 leading-snug">
                    {tr(
                      'Permanently deletes your account: sign-in, profile, @username claim and server sessions are removed, and this device\u2019s local data is erased. Messages you already sent stay visible in other people\u2019s chats. This cannot be undone.',
                      'আপনার অ্যাকাউন্ট স্থায়ীভাবে মুছে যাবে: সাইন-ইন, প্রোফাইল, @username দাবি ও সার্ভার সেশন সরিয়ে দেওয়া হবে এবং এই ডিভাইসের লোকাল ডেটা মুছে যাবে। ইতিমধ্যে পাঠানো মেসেজ অন্যদের চ্যাটে থেকে যাবে। এটা ফেরানো যাবে না।'
                    )}
                  </p>
                  {fbUser && (
                    <input
                      type="password"
                      value={deletePw}
                      onChange={(e) => setDeletePw(e.target.value)}
                      placeholder={tr('Current password (to confirm it is you)', 'বর্তমান পাসওয়ার্ড (নিশ্চিত করতে)')} aria-label={tr('Current password (to confirm it is you)', 'বর্তমান পাসওয়ার্ড (নিশ্চিত করতে)')}
                      className="w-full rounded-xl bg-surface px-3 py-2.5 text-xs text-app placeholder:text-app-faint    border border-transparent"
                    />
                  )}
                  <input
                    type="text"
                    value={deleteText}
                    onChange={(e) => setDeleteText(e.target.value)}
                    placeholder={tr('Type DELETE to confirm', 'নিশ্চিত করতে DELETE লিখুন')} aria-label={tr('Type DELETE to confirm', 'নিশ্চিত করতে DELETE লিখুন')}
                    className="w-full rounded-xl bg-surface px-3 py-2.5 text-xs text-app placeholder:text-app-faint    border border-transparent"
                  />
                  {deleteError && (
                    <p className="text-[11px] text-danger  leading-snug">{deleteError}</p>
                  )}
                  <button
                    onClick={() => void handleDeleteAccount()}
                    disabled={deleteText !== 'DELETE' || deleteBusy}
                    className="w-full py-2.5 rounded-xl bg-danger hover:brightness-110 text-white text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-40"
                  >
                    {deleteBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    {tr('Delete my account permanently', 'আমার অ্যাকাউন্ট স্থায়ীভাবে মুছুন')}
                  </button>
                </div>
              </div>
            )}

            {activeModal === 'scheduled' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-bold text-app">
                    {tr('Scheduled messages', 'শিডিউল করা মেসেজ')}
                  </h3>
                  <button
                    onClick={() => void loadScheduled()}
                    className="min-w-[44px] min-h-[44px] flex items-center justify-center text-app-faint hover:text-app rounded-lg"
                    title={tr('Refresh', 'রিফ্রেশ')} aria-label={tr('Refresh', 'রিফ্রেশ')}
                  >
                    <RefreshCw className={`w-4 h-4 ${schedLoading ? 'animate-spin' : ''}`} />
                  </button>
                </div>
                <p className="text-[11px] text-app-faint leading-snug">
                  {tr(
                    'These are scheduled on the server, so they are sent even if the app is closed.',
                    'এগুলো সার্ভারে শিডিউল করা, তাই অ্যাপ বন্ধ থাকলেও পাঠানো হবে।'
                  )}
                </p>
                {schedLoading && schedItems === null ? (
                  <p className="text-xs text-app-2">{tr('Loading...', 'লোড হচ্ছে...')}</p>
                ) : schedError ? (
                  <p className="text-xs text-app-2 leading-snug">
                    {tr(
                      'Could not load scheduled messages — the server could not be reached.',
                      'শিডিউল করা মেসেজ লোড করা যায়নি — সার্ভারে পৌঁছানো যাচ্ছে না।'
                    )}
                  </p>
                ) : !schedItems || schedItems.length === 0 ? (
                  <div className="rounded-[var(--r-card)] border border-dashed border-token bg-surface px-4 py-6 text-center space-y-2">
                    <CalendarClock className="w-8 h-8 mx-auto text-app-faint" />
                    <p className="text-xs text-app-2 leading-relaxed">
                      {tr(
                        'No scheduled messages. Long-press the send button in a chat to schedule one.',
                        'কোনো শিডিউল করা মেসেজ নেই। চ্যাটে সেন্ড বোতাম চেপে ধরে শিডিউল করুন।'
                      )}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {schedItems.map((item) => {
                      const roomUser = resolveKnownUser(item.roomId);
                      const roomLabel = roomUser?.name || item.roomId || tr('Chat', 'চ্যাট');
                      const dueValue = dueEdits[item.id] ?? toLocalInput(item.dueAt);
                      const busy = schedBusyId === item.id;
                      return (
                        <div key={item.id} className="p-3 rounded-xl bg-surface space-y-2">
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-xs font-semibold text-app break-words flex-1">
                              {item.content || tr('(media message)', '(মিডিয়া মেসেজ)')}
                            </p>
                            <span
                              className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full shrink-0 ${
                                item.status === 'failed'
                                  ? 'bg-bubble-in  text-danger '
                                  : item.status === 'sent'
                                    ? 'bg-bubble-in  text-online '
                                    : 'bg-bubble-in  text-away '
                              }`}
                            >
                              {item.status === 'failed'
                                ? tr('Failed', 'ব্যর্থ')
                                : item.status === 'sent'
                                  ? tr('Sent', 'পাঠানো হয়েছে')
                                  : tr('Pending', 'অপেক্ষমাণ')}
                            </span>
                          </div>
                          <p className="text-[11px] text-app-2">
                            {tr('To', 'প্রাপক')}: {roomLabel} ·{' '}
                            {item.dueAt
                              ? new Date(item.dueAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
                              : '—'}
                          </p>
                          {item.status === 'failed' && item.reason && (
                            <p className="text-[11px] text-danger ">
                              {tr('Reason', 'কারণ')}: {item.reason}
                            </p>
                          )}
                          {item.status === 'pending' && (
                            <div className="flex items-center gap-1.5">
                              <input
                                type="datetime-local"
                                value={dueValue}
                                onChange={(e) =>
                                  setDueEdits((prev) => ({ ...prev, [item.id]: e.target.value }))
                                }
                                className="flex-1 min-w-0 rounded-lg bg-app border border-token  px-2 py-1.5 text-[11px] text-app   "
                               aria-label={tr('Scheduled send time', 'শিডিউল করা পাঠানোর সময়')} />
                              <button
                                disabled={busy || dueEdits[item.id] === undefined}
                                onClick={() =>
                                  void schedAction(item.id, async () => {
                                    const headers = {
                                      'Content-Type': 'application/json',
                                      ...(await authHeaders(currentUser.id))
                                    };
                                    return fetch(`/api/scheduled/${encodeURIComponent(item.id)}`, {
                                      method: 'PATCH',
                                      headers,
                                      body: JSON.stringify({ dueAt: new Date(dueValue).getTime() })
                                    });
                                  })
                                }
                                className="px-2 py-1.5 rounded-lg bg-primary text-white text-[11px] font-bold disabled:opacity-40 shrink-0"
                              >
                                {tr('Save time', 'সময় সেভ')}
                              </button>
                            </div>
                          )}
                          <div className="flex items-center gap-1.5">
                            {item.status === 'failed' && (
                              <button
                                disabled={busy}
                                onClick={() =>
                                  void schedAction(item.id, async () =>
                                    fetch(`/api/scheduled/${encodeURIComponent(item.id)}/retry`, {
                                      method: 'POST',
                                      headers: await authHeaders(currentUser.id)
                                    })
                                  )
                                }
                                className="px-2.5 py-1.5 rounded-lg bg-primary text-white text-[11px] font-bold disabled:opacity-40"
                              >
                                {tr('Retry', 'আবার চেষ্টা')}
                              </button>
                            )}
                            {item.status !== 'sent' && (
                              <button
                                disabled={busy}
                                onClick={() =>
                                  void schedAction(item.id, async () =>
                                    fetch(`/api/scheduled/${encodeURIComponent(item.id)}`, {
                                      method: 'DELETE',
                                      headers: await authHeaders(currentUser.id)
                                    })
                                  )
                                }
                                className="px-2.5 py-1.5 rounded-lg bg-app border border-token  text-[11px] font-bold text-danger  disabled:opacity-40"
                              >
                                {tr('Cancel', 'বাতিল')}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                <button
                  onClick={() => setActiveModal(null)}
                  className="w-full py-2.5 bg-primary hover:brightness-110 text-white rounded-xl font-bold text-xs transition-colors"
                >
                  {tr('Done', 'হয়ে গেছে')}
                </button>
              </div>
            )}

            {activeModal === 'policy' && (
              <div className="space-y-4">
                <h3 className="text-base font-bold text-app">
                  {tr('Privacy Policy', 'প্রাইভেসি পলিসি')}
                </h3>
                <div className="space-y-3 text-xs text-app-2 leading-relaxed">
                  <p>
                    <strong className="text-app">{tr('What Chitthi collects. ', 'Chitthi যা সংগ্রহ করে। ')}</strong>
                    {tr(
                      'Your account details (name, email address, @username, profile photo, About and mood), the messages and media you send, your scheduled messages, call history metadata, and basic session information (device label and connection times) needed to show your active sessions.',
                      'আপনার অ্যাকাউন্টের তথ্য (নাম, ইমেইল, @username, প্রোফাইল ছবি, About ও মুড), আপনি যেসব মেসেজ ও মিডিয়া পাঠান, শিডিউল করা মেসেজ, কলের মেটাডেটা, এবং সক্রিয় সেশন দেখানোর জন্য প্রয়োজনীয় সেশন তথ্য (ডিভাইসের নাম ও সংযোগের সময়)।'
                    )}
                  </p>
                  <p>
                    <strong className="text-app">{tr('How messages are protected. ', 'মেসেজ যেভাবে সুরক্ষিত। ')}</strong>
                    {tr(
                      'Messages travel over encrypted connections (HTTPS/WSS; calls use WebRTC DTLS-SRTP) and are stored on the Chitthi server so they can sync across your devices and be delivered while you are offline. Chitthi is NOT end-to-end encrypted: the server stores messages in a form the service can read, so you should not treat Chitthi as a channel for highly sensitive information.',
                      'মেসেজ এনক্রিপ্টেড সংযোগে যায় (HTTPS/WSS; কলে WebRTC DTLS-SRTP) এবং Chitthi সার্ভারে সংরক্ষিত থাকে যাতে সব ডিভাইসে sync হয় এবং আপনি অফলাইনে থাকলেও পৌঁছায়। Chitthi end-to-end encrypted নয়: সার্ভার মেসেজ এমনভাবে রাখে যা সার্ভিস পড়তে পারে, তাই অত্যন্ত সংবেদনশীল তথ্যের জন্য Chitthi ব্যবহার করবেন না।'
                    )}
                  </p>
                  <p>
                    <strong className="text-app">{tr('What stays on your device. ', 'যা আপনার ডিভাইসেই থাকে। ')}</strong>
                    {tr(
                      'This app also keeps local copies of chats and app data in your browser storage so it works fast and offline. Logging out does not erase that local data — use Settings → Account → "Erase this device\u2019s data" on shared devices.',
                      'এই অ্যাপ ব্রাউজার স্টোরেজে চ্যাট ও অ্যাপ ডেটার লোকাল কপিও রাখে যাতে দ্রুত ও অফলাইনে কাজ করে। লগআউট করলেই সেই লোকাল ডেটা মুছে যায় না — শেয়ার করা ডিভাইসে Settings → Account → "Erase this device\u2019s data" ব্যবহার করুন।'
                    )}
                  </p>
                  <p>
                    <strong className="text-app">{tr('Sharing. ', 'শেয়ারিং। ')}</strong>
                    {tr(
                      'Your data is used to operate the service: delivering your messages to the people you send them to, and showing your profile only as your privacy audiences allow. Chitthi does not run ads and does not sell personal data.',
                      'আপনার ডেটা সার্ভিস চালাতেই ব্যবহৃত হয়: যাদের পাঠান তাদের কাছে মেসেজ পৌঁছানো, এবং আপনার প্রাইভেসি সেটিং অনুযায়ীই প্রোফাইল দেখানো। Chitthi বিজ্ঞাপন চালায় না এবং ব্যক্তিগত ডেটা বিক্রি করে না।'
                    )}
                  </p>
                  <p>
                    <strong className="text-app">{tr('Your controls. ', 'আপনার নিয়ন্ত্রণ। ')}</strong>
                    {tr(
                      'You can control who sees your photo, About and last seen, who can find you by @username and who can add you to groups (Privacy settings); block any user; sign out individual devices (Account → Active sessions); and delete your account entirely (Account → Delete account), which removes your profile, username and sessions from the server. Messages you already sent remain visible in other people\u2019s chats, as with any messenger.',
                      'আপনি নিয়ন্ত্রণ করতে পারেন কে আপনার ছবি, About ও last seen দেখবে, কে @username দিয়ে খুঁজে পাবে এবং কে গ্রুপে যোগ করতে পারবে (প্রাইভেসি সেটিংস); যেকোনো ব্যবহারকারীকে ব্লক করতে পারেন; আলাদা ডিভাইস থেকে সাইন আউট করতে পারেন (Account → Active sessions); এবং পুরো অ্যাকাউন্ট মুছে ফেলতে পারেন (Account → Delete account) — এতে সার্ভার থেকে আপনার প্রোফাইল, ইউজারনেম ও সেশন মুছে যায়। ইতিমধ্যে পাঠানো মেসেজ অন্যদের চ্যাটে থেকে যায়, যেকোনো মেসেঞ্জারের মতোই।'
                    )}
                  </p>
                  <p>
                    <strong className="text-app">{tr('Changes. ', 'পরিবর্তন। ')}</strong>
                    {tr(
                      'If this policy changes, the updated text will appear here. Questions about your data can be directed to the operator of this Chitthi deployment.',
                      'এই পলিসি বদলালে আপডেট করা লেখা এখানেই দেখা যাবে। আপনার ডেটা নিয়ে প্রশ্ন থাকলে এই Chitthi deployment-এর operator-এর সাথে যোগাযোগ করুন।'
                    )}
                  </p>
                </div>
                <button
                  onClick={() => setActiveModal('privacy')}
                  className="w-full py-2.5 bg-primary hover:brightness-110 text-white rounded-xl font-bold text-xs transition-colors"
                >
                  {tr('Back to Privacy', 'প্রাইভেসিতে ফিরুন')}
                </button>
              </div>
            )}

            {activeModal === 'about' && (
              <div className="space-y-4 text-center">
                <div className="w-12 h-12 bg-primary text-white rounded-2xl flex items-center justify-center mx-auto">
                  <MessageCircle className="w-6 h-6 fill-current" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-app">
                    Chitthi
                  </h3>
                  <p className="text-xs text-app-2 mt-1">Version 2.4.0 · Production</p>
                </div>
                <p className="text-xs text-app-2">
                  {lang === 'bn'
                    ? 'উন্নত রিয়েল-টাইম চ্যাট ও মাল্টিমিডিয়া প্ল্যাটফর্ম।'
                    : 'Advanced real-time multimedia chat platform.'}
                </p>
                <button
                  onClick={() => setActiveModal(null)}
                  className="w-full py-2.5 bg-primary hover:brightness-110 text-white rounded-xl font-bold text-xs transition-colors"
                >
                  {lang === 'bn' ? 'বন্ধ করুন' : 'Close'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
