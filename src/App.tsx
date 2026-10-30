import React, { useState, useEffect, useCallback, useRef } from 'react';
import { BottomNav, ScreenTab } from './components/BottomNav';
import { ChatsScreen } from './components/ChatsScreen';
import { ChatViewScreen } from './components/ChatViewScreen';
import { LoginScreen } from './components/LoginScreen';
import { Onboarding } from './components/Onboarding';
import type { CallSession } from './components/VoiceCallModal';
import { ProfileCard } from './components/ProfileCard';
import type { ProfileCardUser } from './components/ProfileCard';
import type { StoryReplyPayload } from './components/StoriesBar';

// ── Phase 5: route-level code-splitting ──────────────────────────────────
// Heavy surfaces that are only rendered on demand are loaded lazily so
// their code (and their exclusive dependencies) stay out of the initial
// bundle: the Calls / Settings tabs, the Group Info panes, the call
// modal, and every modal that mounts only when opened. All of these
// components are named exports, so each lazy loader uses the
// named-export adapter instead of editing the component files.
// Deliberately kept EAGER: ChatsScreen + BottomNav (always-on shell),
// LoginScreen (logged-out entry), Onboarding (task ruling), and
// ChatViewScreen — it is NOT mounted only when a room opens: it renders
// unconditionally in the right-hand column (CSS-hidden on mobile list
// view, always visible on desktop), so lazily loading it would only add
// a skeleton flash on every app start without deferring any work.
// ProfileCard likewise stays eager: the eager ChatViewScreen statically
// imports it, so a lazy wrapper in App could not move it out of the
// initial bundle anyway (rolldown flags that INEFFECTIVE_DYNAMIC_IMPORT).
const CallsScreen = React.lazy(() =>
  import('./components/CallsScreen').then((m) => ({ default: m.CallsScreen }))
);
const SettingsScreen = React.lazy(() =>
  import('./components/SettingsScreen').then((m) => ({ default: m.SettingsScreen }))
);
const GroupInfoScreen = React.lazy(() =>
  import('./components/GroupInfoScreen').then((m) => ({ default: m.GroupInfoScreen }))
);
const VoiceCallModal = React.lazy(() =>
  import('./components/VoiceCallModal').then((m) => ({ default: m.VoiceCallModal }))
);
const NewCategoryModal = React.lazy(() =>
  import('./components/NewCategoryModal').then((m) => ({ default: m.NewCategoryModal }))
);
const MediaPreviewModal = React.lazy(() =>
  import('./components/MediaPreviewModal').then((m) => ({ default: m.MediaPreviewModal }))
);
const CameraModal = React.lazy(() =>
  import('./components/CameraModal').then((m) => ({ default: m.CameraModal }))
);
const UserProfileModal = React.lazy(() =>
  import('./components/UserProfileModal').then((m) => ({ default: m.UserProfileModal }))
);
const OfflineQrModal = React.lazy(() =>
  import('./components/OfflineQrModal').then((m) => ({ default: m.OfflineQrModal }))
);
// NOTE: ClaimUsernameModal's module also exports the username-availability
// hook that the eager LoginScreen statically imports, so rolldown cannot
// move this module out of the initial bundle yet (INEFFECTIVE_DYNAMIC_IMPORT
// warning at build time) — splitting the hook into its own module is
// outside this team's file ownership. The lazy + conditional mount here
// is still correct: the modal component only instantiates while the
// claim prompt is actually open.
const ClaimUsernameModal = React.lazy(() =>
  import('./components/ClaimUsernameModal').then((m) => ({ default: m.ClaimUsernameModal }))
);
const PeopleDirectory = React.lazy(() =>
  import('./components/PeopleDirectory').then((m) => ({ default: m.PeopleDirectory }))
);
const AIAssistantScreen = React.lazy(() =>
  import('./components/AIAssistantScreen').then((m) => ({ default: m.AIAssistantScreen }))
);

/** Phase 5: skeleton fallback for lazily-loaded tab screens and panes.
 * Existing `.skeleton` utility + token surfaces only — same list-row
 * rhythm as CallsSkeleton, so a tab switch never flashes blank or
 * shifts layout. */
const ScreenFallback: React.FC = () => (
  <div
    className="flex-1 overflow-hidden px-4 py-2 space-y-1.5"
    role="status"
    aria-label="Loading"
  >
    {Array.from({ length: 6 }).map((_, i) => (
      <div key={i} className="p-3 bg-surface rounded-2xl flex items-center gap-3">
        <div className="skeleton w-12 h-12 rounded-full shrink-0" />
        <div className="flex-1 min-w-0 space-y-2">
          <div className="skeleton h-3.5 w-2/5 rounded-full" />
          <div className="skeleton h-3 w-3/5 rounded-full" />
        </div>
      </div>
    ))}
  </div>
);

/** Phase 5: minimal centred-skeleton fallback for lazily-loaded modals
 * and the call surface — the real modal replaces it as soon as its
 * chunk arrives; no fake modal chrome, no layout explosion. */
const ModalFallback: React.FC = () => (
  <div
    className="fixed inset-0 z-50 flex items-center justify-center"
    role="status"
    aria-label="Loading"
  >
    <div className="skeleton w-12 h-12 rounded-full" />
  </div>
);

import { Channel, ChatMessage, User, CallLog } from './types/chat';
import { socketService } from './services/socketService';
import { getNotifSettings, notifyIncoming, playBlip, updateTitleBadge } from './utils/notify';
import { maybeShowInstallBanner } from './pwa';
import { postCallLog } from './services/callLogService';
import {
  auth,
  signOut,
  syncUserProfile,
  fetchAllUsers,
  fetchUserProfile,
  searchUsers,
  authHeaders
} from './services/firebase';

/**
 * Honest last-seen label derived from a REAL last-active timestamp
 * (server presence registry — Phase 0.4). Never invent a value: callers
 * only invoke this when an actual timestamp exists.
 */
/** Phase 1.8 timed mute: a channel counts as muted while `isMuted` is set
 * and its optional `mutedUntil` timestamp has not yet passed. */
function isChannelMutedNow(c: Channel): boolean {
  const until = (c as Channel & { mutedUntil?: number }).mutedUntil;
  if (typeof until === 'number' && until <= Date.now()) return false;
  return !!c.isMuted;
}

/** Phase 2: resolve a design-token value at runtime for the rare place
 * a literal feeds a generated artefact (here: the jump-to-message flash
 * ring set via el.style). Keyword fallback only — no hex in this file. */
function cssToken(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function formatLastSeenFromTimestamp(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'Active just now';
  if (diff < 3_600_000) return `Active ${Math.max(1, Math.floor(diff / 60_000))}m ago`;
  if (diff < 86_400_000) return `Active ${Math.floor(diff / 3_600_000)}h ago`;
  return `Active ${new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' })}`;
}

export default function App() {
  const [lang, setLang] = useState<'bn' | 'en'>('en'); // Default to English as instructed
  const [isDarkMode, setIsDarkMode] = useState<boolean>(() => {
    return localStorage.getItem('chithi_theme') === 'dark';
  });

  // Authentication State
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(() => {
    return localStorage.getItem('chithi_auth_logged_in') === 'true';
  });

  // Phase 0.4: logged out means NO user. There is deliberately no seed
  // fallback here — a logged-out browser must land on the LoginScreen,
  // never present itself as a fabricated person.
  const [currentUser, setCurrentUser] = useState<User | null>(() => {
    const saved = localStorage.getItem('chithi_auth_user');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed.id === 'string' && typeof parsed.name === 'string') {
          return parsed as User;
        }
      } catch (e) {
        console.error(e);
      }
    }
    return null;
  });

  // Navigation tabs: chats | history | calls | settings
  const [currentTab, setCurrentTab] = useState<ScreenTab>('chats');
  // For mobile navigation
  const [mobileScreen, setMobileScreen] = useState<'list' | 'chat_view' | 'group_info'>('list');

  // Desktop side drawer toggle for Group Info
  const [desktopShowGroupInfo, setDesktopShowGroupInfo] = useState<boolean>(false);

  // Data Stores
  // Phase 0.4: the people list starts EMPTY — no seed users. It fills only
  // from real sources: fetchAllUsers() (registered profiles) after login
  // and the server presence registry (see the socket effect below).
  const [users, setUsers] = useState<User[]>([]);

  const [channels, setChannels] = useState<Channel[]>(() => {
    const saved = localStorage.getItem('chithi_channels_v5');
    if (saved) {
      try {
        const parsed: Channel[] = JSON.parse(saved);
        return parsed.map((c) => {
          const now = Date.now();
          const createdAt = typeof c.createdAt === 'number' && c.createdAt > 0 ? c.createdAt : (now - 3 * 24 * 3600 * 1000);
          const lastMessageTimestamp = typeof c.lastMessageTimestamp === 'number' && c.lastMessageTimestamp > 0 ? c.lastMessageTimestamp : createdAt;
          return {
            ...c,
            createdAt,
            lastMessageTimestamp,
          };
        });
      } catch {
        return [];
      }
    }
    return [];
  });

  const [callLogs, setCallLogs] = useState<CallLog[]>(() => {
    const saved = localStorage.getItem('chithi_call_logs_v5');
    // Phase 0.4: no fabricated seed call history — a fresh install is empty.
    return saved ? JSON.parse(saved) : [];
  });

  const [activeRoomId, setActiveRoomId] = useState<string>('fullsnack_designers');
  const [activeSubchannelId, setActiveSubchannelId] = useState<string | undefined>(undefined);
  const [isDm, setIsDm] = useState<boolean>(false);
  const [recipientUser, setRecipientUser] = useState<User | undefined>(undefined);

  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    const saved = localStorage.getItem('chithi_messages_v5');
    return saved ? JSON.parse(saved) : [];
  });

  // Mirror of messages for callbacks that need the current list without stale closures.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Same mirror for channels (receipts/group logic reads membership).
  const channelsRef = useRef(channels);
  channelsRef.current = channels;

  // Same mirror for users (jump/profile flows resolve people by id).
  const usersRef = useRef(users);
  usersRef.current = users;

  // Modals & Overlays
  const [isNewCategoryOpen, setIsNewCategoryOpen] = useState(false);
  const [isOfflineQrOpen, setIsOfflineQrOpen] = useState(false);
  const [previewMedia, setPreviewMedia] = useState<{ url: string; type: 'image' | 'video'; title?: string } | null>(null);
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [isVoiceCallOpen, setIsVoiceCallOpen] = useState(false);
  const [callSession, setCallSession] = useState<CallSession | null>(null);
  const callOpenRef = useRef(false);
  /** Phase 1.3 (Team CA wiring): when the current call session opened
   * (ring/invite moment) — postCallLog's `startedAt`. Set at every
   * setCallSession site. */
  const callStartedAtRef = useRef<number>(0);
  const channelsSweepArmedRef = useRef(false);
  const [callType, setCallType] = useState<'audio' | 'video'>('audio');
  const [callTargetName, setCallTargetName] = useState<string>('Fullsnack Designers');
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isDirectoryOpen, setIsDirectoryOpen] = useState(false);
  const [isAiOpen, setIsAiOpen] = useState(false);

  // ── Phase 1 (Team CL) UI state ───────────────────────────────────────────
  /** Lightweight toast for async outcomes (scheduled sent/failed, pin cap,
   * group leave/delete, contact lookup, …). */
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((message: string, ms = 4200) => {
    setToast(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), ms);
  }, []);
  /** Set when THIS session was revoked from another device — rendered
   * over the login screen after the forced logout lands there. */
  const [revokedNotice, setRevokedNotice] = useState(false);
  /** Post-login @username claim prompt (Team I wiring). */
  const [claimPromptOpen, setClaimPromptOpen] = useState(false);
  /** Phase 2 first-run onboarding (Team G): shown after login while the
   * per-user `chitthi_onboarded_v1_<uid>` flag is unset. */
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  /** Shared other-user ProfileCard (QR add-contact, find-people). */
  const [profileCardUser, setProfileCardUser] = useState<ProfileCardUser | null>(null);
  /** Phase 1.9.1/1.9.3: message to scroll to + flash in ChatViewScreen
   * (consumed by Team CV's jumpToMessageId prop) / GroupInfo media tabs. */
  const [jumpToMessageId, setJumpToMessageId] = useState<string | null>(null);
  /** Reminder banner (Phase 1.8): a fired reminder deep-links to the
   * original message. */
  const [reminderBanner, setReminderBanner] = useState<{
    reminderId: string;
    roomId: string;
    messageId: string;
    snippet: string;
  } | null>(null);

  // Sync to local storage
  useEffect(() => {
    localStorage.setItem('chithi_auth_logged_in', String(isLoggedIn));
  }, [isLoggedIn]);

  useEffect(() => {
    // Logged out (null user) must not persist a phantom identity.
    if (currentUser) {
      localStorage.setItem('chithi_auth_user', JSON.stringify(currentUser));
    } else {
      localStorage.removeItem('chithi_auth_user');
    }
  }, [currentUser]);

  useEffect(() => {
    localStorage.setItem('chithi_users_v5', JSON.stringify(users));
  }, [users]);

  // PWA install banner (Phase 5): offer it once per session, shortly after
  // sign-in. pwa.ts no-ops unless the browser actually fired
  // beforeinstallprompt and the user has not dismissed it before.
  const installBannerTriedRef = useRef(false);
  useEffect(() => {
    if (!currentUser || installBannerTriedRef.current) return;
    installBannerTriedRef.current = true;
    const t = setTimeout(() => {
      try { maybeShowInstallBanner(); } catch { /* PWA is progressive enhancement */ }
    }, 4000);
    return () => clearTimeout(t);
  }, [currentUser]);

  useEffect(() => {
    localStorage.setItem('chithi_channels_v5', JSON.stringify(channels));
    // Phase 4 (roadmap Tier 2): sweep orphaned per-room keys — drafts,
    // disappearing-message timers and wallpapers keyed by rooms that no
    // longer exist. Guarded twice: the first run is the initial local load
    // (server-persisted channels have not merged yet, so the local list is
    // not yet the truth), and an empty list never sweeps.
    if (!channelsSweepArmedRef.current) {
      channelsSweepArmedRef.current = true;
      return;
    }
    if (channels.length === 0) return;
    try {
      const roomIds = new Set(channels.map((c) => c.id));
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (!key) continue;
        let orphan = false;
        if (key.startsWith('chitthi_ttl_')) orphan = !roomIds.has(key.slice('chitthi_ttl_'.length));
        else if (key.startsWith('chitthi_wallpaper_')) orphan = !roomIds.has(key.slice('chitthi_wallpaper_'.length));
        else if (key.startsWith('chitthi_draft_')) {
          const rest = key.slice('chitthi_draft_'.length);
          orphan = ![...roomIds].some((id) => rest.startsWith(`${id}_`));
        }
        if (orphan) localStorage.removeItem(key);
      }
    } catch {
      /* storage unavailable — hygiene only, never fatal */
    }
  }, [channels]);

  useEffect(() => {
    localStorage.setItem('chithi_messages_v5', JSON.stringify(messages));
  }, [messages]);

  useEffect(() => {
    localStorage.setItem('chithi_call_logs_v5', JSON.stringify(callLogs));
  }, [callLogs]);

  // MEGA round: document-title unread badge — total unread across all
  // channels, kept in sync with the channel list.
  useEffect(() => {
    const total = channels.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
    updateTitleBadge(total);
  }, [channels]);

  // Saved Messages: a personal notes room kept ON THIS DEVICE only
  // (Phase 0.10 — it is not a cloud; items live in this browser's storage
  // and are gone if that storage is cleared). Always present in the list.
  useEffect(() => {
    setChannels((prev) => {
      const existingSaved = prev.find((c) => c.id === 'saved_messages');
      if (existingSaved) {
        // Rewrite the old "personal cloud" copy on already-persisted lists.
        if (!existingSaved.description?.includes('on this device')) {
          return prev.map((c) =>
            c.id === 'saved_messages'
              ? {
                  ...c,
                  description:
                    'Saved on this device — forward anything here to keep it. Only you can see this, and only on this device.',
                }
              : c
          );
        }
        return prev;
      }
      const savedChannel: Channel = {
        id: 'saved_messages',
        name: 'Saved Messages',
        description: 'Saved on this device — forward anything here to keep it. Only you can see this, and only on this device.',
        iconType: 'general',
        isGroup: false,
        avatar: '',
        membersCount: 1,
        lastMessage: 'Nothing saved yet — forward a message here',
        lastMessageTimestamp: Date.now(),
        createdAt: Date.now(),
        unreadCount: 0,
        isPinned: true,
      };
      return [savedChannel, ...prev];
    });
  }, []);

  // Scheduled messages (Telegram-style): queued locally, sent when due.
  // Phase 0.8: an item is removed from the queue ONLY after the server acks
  // its message; a send that is not acked within 5 s keeps the item and
  // marks it `failed` (persisted) so the UI can offer "tap to retry".
  interface ScheduledItem {
    id: string;
    roomId: string;
    content: string;
    sendAt: number;
    sectionId?: string;
    replyTo?: ChatMessage['replyTo'];
    /** Persisted delivery-failure flag (Phase 0.8). */
    failed?: boolean;
  }
  const [scheduled, setScheduled] = useState<ScheduledItem[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('chitthi_scheduled_v1') || '[]');
    } catch {
      return [];
    }
  });
  useEffect(() => {
    localStorage.setItem('chitthi_scheduled_v1', JSON.stringify(scheduled));
  }, [scheduled]);

  const scheduledRef = useRef<ScheduledItem[]>(scheduled);
  scheduledRef.current = scheduled;

  // Phase 0.8 cross-tab guard: every tab runs the sweeper, so a due item is
  // CLAIMED via localStorage before it fires (see claimScheduledItem).
  const tabIdRef = useRef(
    `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  );
  /** Item ids this tab is currently trying to deliver (awaiting ack). */
  const inFlightSchedRef = useRef<Set<string>>(new Set());
  /** Phase 1.8 migration guard: while the on-login local→server scheduled
   * migration is in flight, the local sweeper must not fire the same items
   * (the server is about to own them — double delivery otherwise). */
  const schedMigrationInFlightRef = useRef(false);

  /**
   * Claim-before-fire (Phase 0.8): write our claim for the item, wait
   * 150 ms, then re-read — we may fire only if we still own the claim.
   * Claims older than 15 s are stale and may be taken over (e.g. the
   * claiming tab crashed mid-send).
   */
  const claimScheduledItem = useCallback(async (itemId: string): Promise<boolean> => {
    const key = `chitthi_sched_claim_${itemId}`;
    try {
      const now = Date.now();
      const raw = localStorage.getItem(key);
      if (raw) {
        const existing = JSON.parse(raw);
        if (existing && typeof existing.at === 'number' && now - existing.at < 15_000) {
          if (existing.tabId === tabIdRef.current) return true; // already ours
          return false; // another live tab owns it
        }
      }
      localStorage.setItem(key, JSON.stringify({ tabId: tabIdRef.current, at: now }));
      await new Promise((r) => setTimeout(r, 150));
      const after = JSON.parse(localStorage.getItem(key) || 'null');
      return !!after && after.tabId === tabIdRef.current;
    } catch {
      // Storage unavailable — claims are impossible; fire rather than lose
      // the message (single-tab is the overwhelmingly common case).
      return true;
    }
  }, []);

  const releaseScheduledClaim = useCallback((itemId: string) => {
    try {
      const key = `chitthi_sched_claim_${itemId}`;
      const raw = localStorage.getItem(key);
      if (raw && JSON.parse(raw)?.tabId === tabIdRef.current) {
        localStorage.removeItem(key);
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Disappearing-message sweeper: remove expired messages every 20s
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      setMessages((prev) =>
        prev.some((m) => m.expiresAt && m.expiresAt < now)
          ? prev.filter((m) => !m.expiresAt || m.expiresAt >= now)
          : prev
      );
    }, 20000);
    return () => clearInterval(t);
  }, []);

  /**
   * Deliver ONE scheduled item (Phase 0.8). The item stays in the queue
   * until the server acks its message id; on a 5 s ack timeout the item is
   * kept and marked `failed` (the scheduled-list UI renders it as
   * "failed — tap to retry"; the next sweep also re-attempts it).
   * Overdue items (>60 s late) keep their SCHEDULED time as the message
   * timestamp and carry `sentLate: true` instead of bursting in stamped
   * with the fire time.
   */
  const fireScheduledItem = useCallback(
    async (item: ScheduledItem) => {
      const me = currentUser;
      if (!me) return;
      if (inFlightSchedRef.current.has(item.id)) return;
      if (!(await claimScheduledItem(item.id))) return;
      // Cancelled (or already delivered) while we were claiming — bail.
      if (!scheduledRef.current.some((s) => s.id === item.id)) {
        releaseScheduledClaim(item.id);
        return;
      }
      inFlightSchedRef.current.add(item.id);
      const isLate = Date.now() - item.sendAt > 60_000;
      const msg: ChatMessage = {
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        senderId: me.id,
        senderName: me.name,
        senderAvatar: me.avatar,
        roomId: item.roomId,
        sectionId: item.sectionId,
        type: 'text',
        content: item.content,
        timestamp: item.sendAt,
        reactions: {},
        status: 'sent',
        replyTo: item.replyTo,
      };
      if (isLate) {
        // `sentLate` rides along to the server (it stores the frame
        // verbatim); the field is not yet declared on ChatMessage, whose
        // type is owned outside this file.
        (msg as ChatMessage & { sentLate?: boolean }).sentLate = true;
      }
      // Optimistic: clear any previous failure while this attempt runs.
      setScheduled((prev) =>
        prev.map((s) => (s.id === item.id ? { ...s, failed: false } : s))
      );
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      setChannels((prev) =>
        prev.map((c) =>
          c.id === item.roomId
            ? { ...c, lastMessage: item.content, lastMessageTimestamp: msg.timestamp }
            : c
        )
      );
      const acked = await new Promise<boolean>((resolve) => {
        let unsub: () => void = () => {};
        const timeout = setTimeout(() => {
          unsub();
          resolve(false);
        }, 5000);
        unsub = socketService.onAck(({ messageId }) => {
          if (messageId === msg.id) {
            clearTimeout(timeout);
            unsub();
            resolve(true);
          }
        });
        socketService.sendMessage(msg);
      });
      inFlightSchedRef.current.delete(item.id);
      releaseScheduledClaim(item.id);
      if (acked) {
        // Confirmed by the server — NOW the queue item may be deleted.
        setScheduled((prev) => prev.filter((s) => s.id !== item.id));
      } else {
        // No ack: keep the item, visibly failed, for tap / next-sweep retry.
        setScheduled((prev) =>
          prev.map((s) => (s.id === item.id ? { ...s, failed: true } : s))
        );
      }
    },
    [currentUser, claimScheduledItem, releaseScheduledClaim]
  );
  const fireScheduledItemRef = useRef(fireScheduledItem);
  fireScheduledItemRef.current = fireScheduledItem;

  // Scheduled-message sweeper: attempt anything due every 5 seconds.
  // Failed items are re-attempted by later sweeps; nothing is deleted here
  // — deletion happens only on ack, inside fireScheduledItem.
  useEffect(() => {
    const t = setInterval(() => {
      // Phase 1.8: hold fire while the server migration owns the queue.
      if (schedMigrationInFlightRef.current) return;
      const now = Date.now();
      const due = scheduledRef.current.filter(
        (s) => s.sendAt <= now && !inFlightSchedRef.current.has(s.id)
      );
      for (const item of due) {
        void fireScheduledItemRef.current(item);
      }
    }, 5000);
    return () => clearInterval(t);
  }, []);

  const handleScheduleMessage = useCallback(
    (content: string, sendAt: number, sectionId?: string, replyTo?: ChatMessage['replyTo']) => {
      setScheduled((prev) => [
        ...prev,
        {
          id: `sched_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
          roomId: activeRoomId,
          content,
          sendAt,
          sectionId,
          replyTo,
          failed: false,
        },
      ]);
    },
    [activeRoomId]
  );

  const handleCancelScheduled = useCallback((id: string) => {
    setScheduled((prev) => prev.filter((s) => s.id !== id));
  }, []);

  /** "Failed — tap to retry": clear the failure and re-attempt delivery now
   *  (later sweeps also re-attempt failed items on their own). */
  const handleRetryScheduled = useCallback((id: string) => {
    const item = scheduledRef.current.find((s) => s.id === id);
    if (!item) return;
    setScheduled((prev) =>
      prev.map((s) => (s.id === id ? { ...s, failed: false } : s))
    );
    void fireScheduledItemRef.current({ ...item, failed: false });
  }, []);

  // Phase 0.4: the old 15-second presence ticker is GONE. It fabricated
  // presence locally (seed users forced online/offline on a timer). Presence
  // now comes ONLY from the server presence registry — see the
  // socketService.onPresence subscription in the socket effect below.

  // Incoming calls ring on ANY screen (invite arrives over the call-signaling relay)
  useEffect(() => {
    if (!isLoggedIn || !currentUser) return;
    const myId = currentUser.id;
    const unsub = socketService.onCallSignal((data) => {
      if (data.signalType !== 'invite') return;
      if (data.targetUserId && data.targetUserId !== myId) return;
      if (data.fromUserId === myId) return;
      if (callOpenRef.current) {
        // Already in a call — tell the caller we're busy instead of silently ringing out.
        socketService.sendCallSignal({ signalType: 'busy', targetUserId: data.fromUserId, roomId: data.roomId });
        return;
      }
      // Prefer the server-stamped fromUserId; the copy inside the signal
      // payload is sender-controlled and only a last-resort fallback.
      const fromId = data.fromUserId || data.signal?.fromId;
      // NEVER trust signal.fromName for the caller display name (security lab:
      // it is attacker-controlled, so an anonymous caller could make the ring
      // screen read any name). Resolve from the server-stamped id only.
      const fromName = users.find((u) => u.id === fromId)?.name || 'Unknown caller';
      callStartedAtRef.current = Date.now();
      setCallSession({
        direction: 'in',
        peerId: fromId,
        peerName: fromName,
        callType: data.signal?.callType === 'video' ? 'video' : 'audio',
      });
      setCallTargetName(fromName);
      callOpenRef.current = true;
      setIsVoiceCallOpen(true);
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn, currentUser?.id]);

  // Dark mode effect with class on <html>
  useEffect(() => {
    localStorage.setItem('chithi_theme', isDarkMode ? 'dark' : 'light');
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDarkMode]);

  // Sync server-persisted channels on mount
  useEffect(() => {
    fetch('/api/channels')
      .then((res) => res.json())
      .then((data) => {
        if (data.channels && Array.isArray(data.channels) && data.channels.length > 0) {
          setChannels((prev) => {
            const map = new Map<string, Channel>();
            // Add server channels first
            for (const sCh of data.channels) {
              map.set(sCh.id, sCh);
            }
            // Retain local client channels if any
            for (const p of prev) {
              if (!map.has(p.id)) {
                map.set(p.id, p);
              }
            }
            return Array.from(map.values());
          });
        }
      })
      .catch((err) => console.warn('Could not fetch server channels:', err));
  }, []);

  // Connect to Socket Service when logged in
  useEffect(() => {
    if (!isLoggedIn || !currentUser) return;
    const me = currentUser;

    socketService.connect(me, activeRoomId);

    // Heartbeat to keep active online status accurate
    const heartbeatTimer = setInterval(() => {
      socketService.send({ type: 'user:heartbeat', userId: me.id });
    }, 30000);

    const unsubMsg = socketService.onMessage((newMsg: ChatMessage) => {
      // Saved Messages is local-only: never accept another user's saved items
      // into this device's Saved Messages (defense in depth — the relay also
      // refuses to store/broadcast that room, and our sender never sends it).
      if (newMsg.roomId === 'saved_messages' && newMsg.senderId !== me.id) return;
      // Dedupe before any state updates — sendMessage echoes locally, so our
      // own messages arrive twice (local delivery + server broadcast).
      if (messagesRef.current.some((m) => m.id === newMsg.id)) return;
      // MEGA round notifications: only genuinely new incoming messages
      // reach this point (own messages, duplicates/history replays are
      // excluded above; reaction/update events use separate handlers).
      // Fire for other people's messages outside the saved room when the
      // room is not open-and-visible and the channel is not muted. Sound
      // fires under exactly the same conditions as the popup.
      if (newMsg.senderId !== me.id && newMsg.roomId !== 'saved_messages') {
        const notifChannel = channelsRef.current.find((c) => c.id === newMsg.roomId);
        const roomNotVisible = newMsg.roomId !== activeRoomId || document.hidden;
        if (roomNotVisible && !(notifChannel && isChannelMutedNow(notifChannel))) {
          const preview =
            newMsg.type === 'text'
              ? newMsg.content.length > 80
                ? `${newMsg.content.slice(0, 80)}…`
                : newMsg.content
              : newMsg.type === 'image'
                ? 'Sent a photo'
                : newMsg.type === 'video'
                  ? 'Sent a video'
                  : newMsg.type === 'audio'
                    ? 'Sent a voice message'
                    : newMsg.type === 'file'
                      ? 'Sent a file'
                      : newMsg.type === 'poll'
                        ? 'Sent a poll'
                        : newMsg.type === 'sticker'
                          ? 'Sent a sticker'
                          : 'Sent a message';
          notifyIncoming({
            title: newMsg.senderName || notifChannel?.name || 'New message',
            body: preview,
          });
          if (getNotifSettings().sound) playBlip();
        }
      }
      setMessages((prev) => {
        if (prev.some((m) => m.id === newMsg.id)) return prev;
        return [...prev, newMsg];
      });
      // Phase 0.5 receipts: a message arriving in the room we are looking
      // at is read the moment it lands — tell the server.
      if (newMsg.senderId !== me.id && newMsg.roomId === activeRoomId) {
        socketService.sendRead(newMsg.roomId, [newMsg.id]);
      }
      // Channel preview + unread badge for incoming messages (own messages
      // already update the channel in handleSendMessage).
      if (newMsg.senderId !== me.id) {
        setChannels((prev) =>
          prev.map((c) =>
            c.id !== newMsg.roomId
              ? c
              : {
                  ...c,
                  lastMessage: newMsg.type === 'text' ? newMsg.content : `[${newMsg.type}]`,
                  lastMessageTimestamp: newMsg.timestamp || Date.now(),
                  lastMessageTime: new Date(newMsg.timestamp || Date.now()).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  }),
                  // Phase 0.10: a new message UNARCHIVES its chat (default
                  // behaviour) — an archived chat must not silently pile up
                  // unread messages where the user never looks.
                  isArchived: false,
                  // Muted rooms still get the preview, just no badge bump
                  // (a timed mute whose mutedUntil passed no longer mutes).
                  unreadCount:
                    newMsg.roomId !== activeRoomId && !isChannelMutedNow(c)
                      ? (c.unreadCount || 0) + 1
                      : c.unreadCount,
                }
          )
        );
      }
    });

    const unsubHistory = socketService.onHistory((roomId, histMsgs) => {
      // Saved Messages never comes from the server, but guard anyway (local-only room).
      if (roomId === 'saved_messages') return;
      if (!histMsgs.length) return;
      setMessages((prev) => {
        const ids = new Set(prev.map((m) => m.id));
        const fresh = histMsgs.filter((m) => !ids.has(m.id));
        if (!fresh.length) return prev;
        return [...prev, ...fresh].sort((a, b) => a.timestamp - b.timestamp);
      });
      // Phase 0.5 receipts: history is served when a room is opened —
      // opening a room means its messages have been seen.
      if (roomId === activeRoomId) {
        socketService.sendRead(
          roomId,
          histMsgs.filter((m) => m.senderId !== me.id).map((m) => m.id)
        );
      }
    });

    const unsubReaction = socketService.onReaction((updatedMsg: ChatMessage) => {
      setMessages((prev) => prev.map((m) => (m.id === updatedMsg.id ? updatedMsg : m)));
    });

    // Phase 0.5 receipts wiring: the server pushes delivered/read state per
    // message; translate it into the sender-side status ticks.
    const unsubReceipts = socketService.onReceipts(({ roomId, messageId, deliveredTo, readBy }) => {
      setMessages((prev) => {
        const target = prev.find((m) => m.id === messageId && m.roomId === roomId);
        if (!target || target.senderId !== me.id) return prev;
        const channel = channelsRef.current.find((c) => c.id === roomId);
        let status: ChatMessage['status'];
        if (!channel?.isGroup) {
          // DM: the peer is everyone-not-me in the receipt lists.
          const peerRead = readBy.some((id) => id !== me.id);
          const peerDelivered = deliveredTo.some((id) => id !== me.id);
          status = peerRead ? 'read' : peerDelivered ? 'delivered' : undefined;
        } else {
          // Group: 'read' only when EVERY non-sender member has read it;
          // membership comes from the channel's memberIds/members when the
          // server has provided them, otherwise from whoever appears in
          // the receipt lists for this message.
          const memberIds = (
            (channel as Channel & { memberIds?: string[] }).memberIds ||
            channel.members ||
            []
          ).filter((id) => id !== me.id);
          const others = memberIds.length
            ? memberIds
            : Array.from(new Set([...deliveredTo, ...readBy])).filter((id) => id !== me.id);
          const allRead =
            others.length > 0 && others.every((id) => readBy.includes(id));
          const anyDelivered = deliveredTo.some((id) => id !== me.id);
          status = allRead ? 'read' : anyDelivered ? 'delivered' : undefined;
        }
        // Phase 1 retention (coordinator addendum #2): the delivered/read
        // ARRAYS are stored on the message too — ChatViewScreen's Message
        // Info panel renders the full group read-by list from them, not
        // just the derived tick. Arrays only ever grow (union-merged) and
        // are retained even when the tick itself does not advance.
        const mergedDeliveredTo = Array.from(
          new Set([...(target.deliveredTo || []), ...deliveredTo])
        );
        const mergedReadBy = Array.from(new Set([...(target.readBy || []), ...readBy]));
        const arraysChanged =
          mergedDeliveredTo.length !== (target.deliveredTo || []).length ||
          mergedReadBy.length !== (target.readBy || []).length;
        if (!status) {
          if (!arraysChanged) return prev;
          return prev.map((m) =>
            m.id === messageId
              ? { ...m, deliveredTo: mergedDeliveredTo, readBy: mergedReadBy }
              : m
          );
        }
        // Never move a tick backwards (read stays read).
        const rank = { sending: 0, sent: 1, delivered: 2, read: 3 } as const;
        const statusAdvances = rank[status] > rank[target.status || 'sent'];
        if (!statusAdvances && !arraysChanged) return prev;
        return prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                deliveredTo: mergedDeliveredTo,
                readBy: mergedReadBy,
                ...(statusAdvances ? { status } : {}),
              }
            : m
        );
      });
    });

    // Real-time presence sync — the server registry is the ONLY source of
    // presence in the app (Phase 0.4). `presence:update` is a full snapshot
    // of who is authenticated right now; `presence:user_offline` is a
    // single-user partial event carrying that user's real lastActive time.
    const unsubPresence = socketService.onPresence((presenceUsers, meta) => {
      setUsers((prevUsers) => {
        const next = prevUsers.map((u) => {
          const match = presenceUsers.find((ou) => ou.id === u.id);
          if (match) {
            return {
              ...u,
              ...(match.name ? { name: match.name } : {}),
              online: match.online,
              presence: (match.online ? 'online' : 'offline') as User['presence'],
              lastSeen: match.online
                ? 'Active now'
                : typeof match.lastActive === 'number'
                  ? formatLastSeenFromTimestamp(match.lastActive)
                  : u.lastSeen,
            };
          }
          // Full snapshot: anyone not in it (and not us) is offline. Their
          // lastSeen is left untouched — we have no real timestamp for the
          // moment they left, so we do not invent one.
          if (meta?.full && u.id !== me.id) {
            return { ...u, online: false, presence: 'offline' as User['presence'] };
          }
          return u;
        });
        // People can also ARRIVE via presence (e.g. a user we have never
        // loaded a profile for comes online): add a minimal real entry.
        for (const ou of presenceUsers) {
          if (!ou.online || ou.id === me.id) continue;
          if (next.some((u) => u.id === ou.id)) continue;
          next.push({
            id: ou.id,
            name: ou.name || 'User',
            avatar: '',
            status: '',
            online: true,
            presence: 'online',
            lastSeen: 'Active now',
          });
        }
        return next;
      });
    });

    // Real-time channel sync from server — UPSERT (Phase 0.3): an event for
    // a channel we already have REPLACES its stored fields (name, owner,
    // membership, admins, sections, …) instead of being discarded, so group
    // admin actions become visible on every device.
    const unsubChannel = socketService.onChannelCreated((newCh) => {
      setChannels((prev) => {
        const idx = prev.findIndex((c) => c.id === newCh.id);
        if (idx === -1) return [newCh, ...prev];
        const incoming = newCh as Channel & {
          ownerId?: string;
          memberIds?: string[];
          adminIds?: string[];
        };
        const next = [...prev];
        next[idx] = { ...prev[idx], ...incoming };
        return next;
      });
    });

    return () => {
      clearInterval(heartbeatTimer);
      unsubMsg();
      unsubReaction();
      unsubPresence();
      unsubChannel();
      unsubHistory();
      unsubReceipts();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn, currentUser?.id, activeRoomId]);

  // Handle Login
  const handleLogin = (user: User) => {
    setCurrentUser(user);
    setIsLoggedIn(true);
    setUsers((prev) => {
      if (prev.some((u) => u.id === user.id)) return prev;
      return [user, ...prev];
    });
  };

  // After login (once per user per session): (a) Phase 0.9 read-back —
  // fetch OUR OWN profile and merge name/avatar/status so a second device
  // shows the real profile instead of rebuilt local defaults; (b) Phase 0.4
  // — fill the people list from fetchAllUsers (registered profiles). Their
  // `online` doc field is NOT trusted: presence comes only from the server
  // registry, so fetched people start offline until a presence event says
  // otherwise.
  const profileSyncForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isLoggedIn || !currentUser) return;
    const uid = currentUser.id;
    if (profileSyncForRef.current === uid) return;
    profileSyncForRef.current = uid;
    let cancelled = false;
    (async () => {
      const profile = await fetchUserProfile(uid);
      if (!cancelled && profile) {
        const mergeProfile = (u: User): User => ({
          ...u,
          name: typeof profile.name === 'string' && profile.name ? profile.name : u.name,
          avatar:
            typeof profile.avatar === 'string' && profile.avatar ? profile.avatar : u.avatar,
          status:
            typeof profile.status === 'string' && profile.status ? profile.status : u.status,
          username:
            typeof profile.username === 'string' && profile.username
              ? profile.username
              : u.username,
        });
        setCurrentUser((prev) => (prev && prev.id === uid ? mergeProfile(prev) : prev));
        setUsers((prev) => prev.map((u) => (u.id === uid ? mergeProfile(u) : u)));
      }
      const all = await fetchAllUsers();
      if (!cancelled && Array.isArray(all) && all.length > 0) {
        setUsers((prev) => {
          const byId = new Map<string, User>();
          for (const d of all) {
            if (!d || typeof d.id !== 'string') continue;
            byId.set(d.id, {
              id: d.id,
              name: typeof d.name === 'string' && d.name ? d.name : 'User',
              username: typeof d.username === 'string' ? d.username : undefined,
              avatar: typeof d.avatar === 'string' ? d.avatar : '',
              status: typeof d.status === 'string' ? d.status : '',
              online: false,
              presence: 'offline',
              lastSeen:
                typeof d.lastSeen === 'string' && !Number.isNaN(Date.parse(d.lastSeen))
                  ? formatLastSeenFromTimestamp(Date.parse(d.lastSeen))
                  : typeof d.lastSeen === 'string'
                    ? d.lastSeen
                    : undefined,
            });
          }
          // Live state (presence, our own profile) already in the list wins
          // over the fetched snapshot for the same id.
          for (const u of prev) {
            const fetched = byId.get(u.id);
            byId.set(u.id, fetched ? { ...fetched, ...u } : u);
          }
          return Array.from(byId.values());
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isLoggedIn, currentUser?.id]);

  const handleDeleteCallLog = useCallback((id: string) => {
    setCallLogs((prev) => prev.filter((l) => l.id !== id));
  }, []);

  const handleClearCallLogs = useCallback(() => {
    setCallLogs([]);
  }, []);

  // Handle Logout — real sign-out: Firebase session + socket teardown + local state.
  const handleLogout = async () => {
    try {
      await signOut(auth);
    } catch {
      /* local/fallback accounts have no Firebase session */
    }
    socketService.disconnect();
    profileSyncForRef.current = null;
    setCurrentUser(null);
    setIsVoiceCallOpen(false);
    setCallSession(null);
    callOpenRef.current = false;
    setIsLoggedIn(false);
    localStorage.removeItem('chithi_auth_logged_in');
    localStorage.removeItem('chithi_auth_user');
  };

  // ── Phase 1.4 (Team I wiring): post-login @username claim prompt ────────
  // Shown once per user per device when the account has no username yet;
  // the `chitthi_claim_prompted_<uid>` flag is set on claim AND on skip.
  useEffect(() => {
    if (!isLoggedIn || !currentUser) return;
    if (currentUser.username) return;
    try {
      // Phase 2 (Team G): first-run users meet the claim prompt INSIDE
      // onboarding instead — the bare prompt waits until onboarding has
      // completed, and completing onboarding sets the claim-prompted flag
      // too (see handleFinishOnboarding), so it never double-prompts.
      if (!localStorage.getItem(`chitthi_onboarded_v1_${currentUser.id}`)) return;
      if (localStorage.getItem(`chitthi_claim_prompted_${currentUser.id}`)) return;
    } catch {
      return;
    }
    setClaimPromptOpen(true);
  }, [isLoggedIn, currentUser?.id, currentUser?.username]);

  // ── Phase 2 first-run onboarding (Team G wiring) ───────────────────────
  // Shown once per user per device: after login, while the user's
  // `chitthi_onboarded_v1_<uid>` flag is unset. Logged-out users never
  // reach this branch (the login early-return renders first), and demo
  // users are keyed by their own user id like everyone else.
  useEffect(() => {
    if (!isLoggedIn || !currentUser) return;
    try {
      if (localStorage.getItem(`chitthi_onboarded_v1_${currentUser.id}`)) return;
    } catch {
      return;
    }
    setOnboardingOpen(true);
  }, [isLoggedIn, currentUser?.id]);

  /** Finish/skip onboarding (incl. the Esc path in Onboarding.tsx):
   * set the onboarded flag AND the claim-prompted flag — onboarding
   * supersedes the bare claim prompt for first-run users, so they are
   * never prompted twice. A username can still be claimed later from
   * Profile settings. */
  const handleFinishOnboarding = useCallback(() => {
    if (currentUser) {
      try {
        localStorage.setItem(`chitthi_onboarded_v1_${currentUser.id}`, '1');
        localStorage.setItem(`chitthi_claim_prompted_${currentUser.id}`, '1');
      } catch {
        /* ignore */
      }
    }
    setOnboardingOpen(false);
  }, [currentUser]);

  /** "Choose username" on onboarding screen 3: onboarding is complete
   * (flag set, so it never re-shows), then the EXISTING claim modal
   * opens via its existing state. The claim-prompted flag is left to
   * the modal's own handlers (handleClaimUsername / handleSkipClaim
   * both set it on claim/skip). No double prompt: the claim-prompt
   * effect's deps (login / user id / username) do not change when
   * onboarding closes, so it does not re-run; and this handler is the
   * single place that opens the modal for first-run users. */
  const handleOnboardingChooseUsername = useCallback(() => {
    if (currentUser) {
      try {
        localStorage.setItem(`chitthi_onboarded_v1_${currentUser.id}`, '1');
      } catch {
        /* ignore */
      }
    }
    setOnboardingOpen(false);
    // Already has a username (e.g. claimed on another device) — nothing
    // to claim; onboarding simply completes.
    if (!currentUser?.username) setClaimPromptOpen(true);
  }, [currentUser]);

  const handleClaimUsername = useCallback(
    (handle: string) => {
      if (!currentUser) return;
      try {
        localStorage.setItem(`chitthi_claim_prompted_${currentUser.id}`, '1');
      } catch {
        /* ignore */
      }
      setClaimPromptOpen(false);
      const newU = { ...currentUser, username: handle };
      setCurrentUser(newU);
      setUsers((prev) => prev.map((u) => (u.id === currentUser.id ? newU : u)));
      syncUserProfile({
        id: newU.id,
        name: newU.name,
        email: newU.email || '',
        avatar: newU.avatar,
        username: handle,
        status: newU.status,
      }).catch(() => {});
      showToast(lang === 'bn' ? `আপনার ইউজারনেম এখন @${handle}` : `Your username is now @${handle}`);
    },
    [currentUser, lang, showToast]
  );

  const handleSkipClaim = useCallback(() => {
    if (currentUser) {
      try {
        localStorage.setItem(`chitthi_claim_prompted_${currentUser.id}`, '1');
      } catch {
        /* ignore */
      }
    }
    setClaimPromptOpen(false);
  }, [currentUser]);

  // ── Phase 1.4 (Team I wiring): shared ProfileCard ────────────────────────
  const openProfileCardFor = useCallback((u: User) => {
    const extra = u as User & { about?: string; privacy?: ProfileCardUser['privacy'] };
    const isContact = channelsRef.current.some(
      (c) => c.id === u.id || (c.memberIds || []).includes(u.id)
    );
    setProfileCardUser({
      id: u.id,
      name: u.name,
      username: u.username,
      avatar: u.avatar,
      about: extra.about,
      status: u.status,
      online: u.online,
      presence: u.presence,
      lastSeen: u.lastSeen,
      privacy: extra.privacy,
      isContact,
    });
  }, []);

  // ── Phase 1.4.3 (Team I wiring): QR add-contact ──────────────────────────
  // The scanned segment is an @username (or a raw user id from an
  // unclaimed account's QR). Resolve via the local people list first, then
  // the server directory (searchUsers); found → ProfileCard, whose Message
  // action opens the DM. Not found → toast, never a silent drop.
  const handleAddContact = useCallback(
    async (segment: string) => {
      const clean = segment.trim();
      if (!clean) return;
      const needle = clean.toLowerCase();
      let found: User | undefined =
        usersRef.current.find((u) => u.id === clean) ||
        usersRef.current.find((u) => (u.username || '').toLowerCase() === needle);
      if (!found) {
        try {
          const results = await searchUsers(clean);
          const dir =
            results.find((r) => r.id === clean || (r.username || '').toLowerCase() === needle) ||
            results[0];
          if (dir) {
            const local = usersRef.current.find((u) => u.id === dir.id);
            found = {
              id: dir.id,
              name: dir.name,
              username: dir.username,
              avatar: dir.avatar || local?.avatar || '',
              status: dir.mood || local?.status || '',
              online: local?.online ?? false,
              presence: local?.presence ?? 'offline',
              lastSeen: local?.lastSeen,
              ...({ about: dir.about, privacy: dir.privacy } as Partial<User>),
            } as User;
          }
        } catch {
          /* directory unreachable — fall through to the not-found toast */
        }
      }
      if (found) {
        if (!usersRef.current.some((u) => u.id === found!.id)) {
          const f = found;
          setUsers((prev) => (prev.some((u) => u.id === f.id) ? prev : [...prev, f]));
        }
        openProfileCardFor(found);
      } else {
        showToast(
          lang === 'bn'
            ? `'${clean}' নামে কাউকে পাওয়া যায়নি`
            : `No user found for '${clean}'`
        );
      }
    },
    [lang, openProfileCardFor, showToast]
  );

  // ── Phase 1.8 reminders ──────────────────────────────────────────────────
  // Seen reminder ids persist per device so the on-login catch-up fetch
  // never re-banners a reminder the user already saw live.
  const REMINDERS_SEEN_KEY = 'chitthi_reminders_seen_v1';
  const loadSeenReminders = useCallback((): Set<string> => {
    try {
      const parsed = JSON.parse(localStorage.getItem(REMINDERS_SEEN_KEY) || '[]');
      return new Set(Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : []);
    } catch {
      return new Set();
    }
  }, []);
  const markReminderSeen = useCallback(
    (id: string) => {
      try {
        const seen = loadSeenReminders();
        seen.add(id);
        localStorage.setItem(REMINDERS_SEEN_KEY, JSON.stringify(Array.from(seen).slice(-200)));
      } catch {
        /* ignore */
      }
    },
    [loadSeenReminders]
  );

  /** reminder:due (live or caught up on login): add the Saved-Messages
   * entry linking back to the original message + show the banner. */
  const handleReminderDue = useCallback(
    (rem: { id: string; roomId: string; messageId: string; dueAt: number }) => {
      const me = currentUser;
      if (!me) return;
      if (loadSeenReminders().has(rem.id)) return;
      markReminderSeen(rem.id);
      const orig = messagesRef.current.find((m) => m.id === rem.messageId);
      const sourceChannel = channelsRef.current.find((c) => c.id === rem.roomId);
      const snippet = orig
        ? orig.type === 'text'
          ? orig.content.slice(0, 100)
          : `[${orig.type}] ${orig.fileName || ''}`.trim()
        : '';
      const entry: ChatMessage = {
        id: `rem_${rem.id}`,
        senderId: me.id,
        senderName: orig?.senderName || me.name,
        senderAvatar: orig?.senderAvatar || me.avatar,
        roomId: 'saved_messages',
        type: 'text',
        content: snippet ? `⏰ Reminder: ${snippet}` : '⏰ Reminder',
        timestamp: Date.now(),
        reactions: {},
        status: 'sent',
        // The link back: replyTo renders the quoted original, and the
        // reminderRef/sourceRoomId metadata records where it lives (the
        // same extra-field pattern forwarded saved items use).
        replyTo: orig
          ? { id: orig.id, senderName: orig.senderName, snippet: orig.content.slice(0, 80), type: orig.type }
          : undefined,
        forwardedFrom: sourceChannel ? `Reminder · ${sourceChannel.name}` : 'Reminder',
      };
      const entryMeta = entry as ChatMessage & {
        reminderRef?: { roomId: string; messageId: string; reminderId: string };
        sourceRoomId?: string;
        sourceRoomName?: string;
      };
      entryMeta.reminderRef = { roomId: rem.roomId, messageId: rem.messageId, reminderId: rem.id };
      entryMeta.sourceRoomId = rem.roomId;
      entryMeta.sourceRoomName = sourceChannel?.name;
      setMessages((prev) =>
        prev.some((m) => m.id === entry.id) ? prev : [...prev, entry]
      );
      setChannels((prev) =>
        prev.map((c) =>
          c.id === 'saved_messages'
            ? { ...c, lastMessage: entry.content, lastMessageTimestamp: entry.timestamp }
            : c
        )
      );
      setReminderBanner({
        reminderId: rem.id,
        roomId: rem.roomId,
        messageId: rem.messageId,
        snippet: snippet || (lang === 'bn' ? 'রিমাইন্ডার' : 'Reminder due'),
      });
    },
    [currentUser, lang, loadSeenReminders, markReminderSeen]
  );
  const handleReminderDueRef = useRef(handleReminderDue);
  handleReminderDueRef.current = handleReminderDue;

  // WS outcomes (Phase 1): session revoked → forced logout + notice;
  // scheduled sent/failed → toast; reminder due → saved entry + banner.
  useEffect(() => {
    if (!isLoggedIn || !currentUser) return;
    const unsubRevoked = socketService.onSessionRevoked(() => {
      setRevokedNotice(true);
      void handleLogout();
    });
    const unsubScheduled = socketService.onScheduledEvent((ev) => {
      showToast(
        ev.kind === 'sent'
          ? lang === 'bn'
            ? 'নির্ধারিত মেসেজ পাঠানো হয়েছে'
            : 'Scheduled message sent'
          : lang === 'bn'
            ? `নির্ধারিত মেসেজ পাঠানো যায়নি${ev.reason ? `: ${ev.reason}` : ''}`
            : `Scheduled message failed${ev.reason ? `: ${ev.reason}` : ''}`
      );
    });
    const unsubReminder = socketService.onReminderDue((rem) => {
      handleReminderDueRef.current(rem);
    });
    return () => {
      unsubRevoked();
      unsubScheduled();
      unsubReminder();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn, currentUser?.id]);

  // On-login catch-up for reminders that fired while this device was away:
  // the server keeps fired reminders with status 'done' (auto-completed,
  // NOT deleted), so GET /api/reminders surfaces them; the per-device
  // seen set keeps already-bannered ones from repeating.
  const remindersFetchForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isLoggedIn || !currentUser) return;
    const uid = currentUser.id;
    if (remindersFetchForRef.current === uid) return;
    remindersFetchForRef.current = uid;
    let cancelled = false;
    (async () => {
      try {
        const headers = await authHeaders(uid);
        const res = await fetch('/api/reminders', { headers });
        if (!res.ok) return;
        const data = await res.json().catch(() => null);
        const list: any[] = Array.isArray(data?.reminders) ? data.reminders : [];
        if (cancelled) return;
        for (const r of list) {
          if (
            r &&
            r.status === 'done' &&
            typeof r.id === 'string' &&
            typeof r.roomId === 'string' &&
            typeof r.messageId === 'string'
          ) {
            handleReminderDueRef.current({
              id: r.id,
              roomId: r.roomId,
              messageId: r.messageId,
              dueAt: typeof r.dueAt === 'number' ? r.dueAt : Date.now(),
            });
          }
        }
      } catch {
        /* reminders endpoint unreachable — live events still apply */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn, currentUser?.id]);

  // ── Phase 1.8 scheduled migration (local queue → server queue) ──────────
  // Once per login: every local `chitthi_scheduled_v1` item is POSTed to
  // /api/scheduled, then removed locally (the state effect clears the
  // localStorage queue), so the local sweeper never fires a migrated item
  // and the server sweeper owns delivery — including while the app is
  // closed. saved_messages items stay local (the server rejects that
  // room; it is device-only by design). Items the server rejects stay in
  // the local queue rather than being lost.
  const schedMigratedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isLoggedIn || !currentUser) return;
    const uid = currentUser.id;
    if (schedMigratedForRef.current === uid) return;
    schedMigratedForRef.current = uid;
    const items = scheduledRef.current.filter((s) => s.roomId !== 'saved_messages');
    if (!items.length) return;
    let cancelled = false;
    schedMigrationInFlightRef.current = true;
    (async () => {
      try {
        const headers = await authHeaders(uid);
        const migratedIds: string[] = [];
        for (const item of items) {
          if (cancelled) break;
          try {
            const res = await fetch('/api/scheduled', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...headers },
              body: JSON.stringify({
                roomId: item.roomId,
                dueAt: item.sendAt,
                message: {
                  senderId: uid,
                  senderName: currentUser.name,
                  senderAvatar: currentUser.avatar,
                  type: 'text',
                  content: item.content,
                  sectionId: item.sectionId,
                  replyTo: item.replyTo,
                },
              }),
            });
            if (res.ok) migratedIds.push(item.id);
          } catch {
            /* item stays in the local queue — never lost */
          }
        }
        if (!cancelled && migratedIds.length) {
          setScheduled((prev) => prev.filter((s) => !migratedIds.includes(s.id)));
        }
      } finally {
        schedMigrationInFlightRef.current = false;
      }
    })();
    return () => {
      cancelled = true;
      schedMigrationInFlightRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn, currentUser?.id]);

  // Select a chat: Clears unread badge immediately (fixes user's bug report!)
  const handleSelectChat = (roomId: string, dm: boolean, user?: User) => {
    // Saved Messages is a personal room, not a DM with another user.
    if (roomId === 'saved_messages') {
      dm = false;
      user = undefined;
    }
    setActiveRoomId(roomId);
    setIsDm(dm);
    const targetUser = user || users.find((u) => u.id === roomId);
    setRecipientUser(targetUser);
    setMobileScreen('chat_view');
    setDesktopShowGroupInfo(false);

    // FIX: Clear unread badge when user sees/opens the chat
    setChannels((prev) =>
      prev.map((c) => (c.id === roomId ? { ...c, unreadCount: 0 } : c))
    );

    socketService.switchRoom(roomId);
    // Phase 0.5 receipts: opening a room means its messages are read
    // (no messageIds = everything in the room). sendRead itself refuses
    // the local-only saved_messages room.
    socketService.sendRead(roomId);
  };

  // Toggle Pin on any chat dynamically (Requested by User!)
  // Phase 1.8: pinning is capped at 5 chats (the system-pinned Saved
  // Messages row does not consume a slot); hitting the cap shows a notice
  // instead of silently pinning a sixth.
  const handleTogglePin = (roomId: string) => {
    const target = channelsRef.current.find((c) => c.id === roomId);
    if (target && !target.isPinned && roomId !== 'saved_messages') {
      const pinnedCount = channelsRef.current.filter(
        (c) => c.isPinned && c.id !== 'saved_messages'
      ).length;
      if (pinnedCount >= 5) {
        showToast(
          lang === 'bn'
            ? 'সর্বোচ্চ ৫টি চ্যাট পিন করা যাবে — আগে একটি আনপিন করুন'
            : 'You can pin up to 5 chats — unpin one first'
        );
        return;
      }
    }
    setChannels((prev) =>
      prev.map((c) => (c.id === roomId ? { ...c, isPinned: !c.isPinned } : c))
    );
  };

  /** Phase 1.9.1/1.9.3: open a room and jump to one message — pages
   * `room:history` backwards (up to ~5 pages via socketService) until the
   * message is loaded, then hands the id to ChatViewScreen's
   * jumpToMessageId (scroll + flash) with a DOM fallback. */
  const jumpToMessage = useCallback(
    async (roomId: string, messageId: string) => {
      const channel = channelsRef.current.find((c) => c.id === roomId);
      const isDmRoom = roomId === 'saved_messages' ? false : channel ? !channel.isGroup : true;
      const peer = isDmRoom ? usersRef.current.find((u) => u.id === roomId) : undefined;
      handleSelectChat(roomId, isDmRoom, peer);
      if (roomId !== 'saved_messages' && !messagesRef.current.some((m) => m.id === messageId)) {
        const roomMsgs = messagesRef.current
          .filter((m) => m.roomId === roomId)
          .sort((a, b) => a.timestamp - b.timestamp);
        let before: string | undefined = roomMsgs.length ? roomMsgs[0].id : undefined;
        for (let page = 0; page < 5; page++) {
          const res = await socketService.fetchHistoryPage(roomId, { before, limit: 200 });
          // The page also merges via the onHistory listener; give state a
          // beat to land before checking for the target.
          await new Promise((r) => setTimeout(r, 60));
          if (messagesRef.current.some((m) => m.id === messageId)) break;
          if (!res.hasMore || !res.oldestId || res.oldestId === before) break;
          before = res.oldestId;
        }
      }
      setJumpToMessageId(messageId);
      // Fallback: if the consuming prop is not wired in this build, still
      // scroll + flash via the message's DOM id (msg-<id>).
      setTimeout(() => {
        const el = document.getElementById(`msg-${messageId}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.style.transition = 'box-shadow 0.3s';
          el.style.boxShadow = `0 0 0 2px ${cssToken('--c-away', 'orange')}`;
          setTimeout(() => {
            el.style.boxShadow = '';
          }, 1400);
        }
      }, 400);
      setTimeout(() => {
        setJumpToMessageId((cur) => (cur === messageId ? null : cur));
      }, 2000);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  /** Phase 1.1 (Team ST wiring): a story reply opens the author's DM and
   * sends the text carrying `storyRef` (the story id — Team CV's
   * ChatMessage field, which ChatView renders as the story-reply chip;
   * it is set WITHOUT replyTo, which is what CV's renderer keys on).
   * The StoriesBar draft is consumed only here, on an actual send —
   * never silently dropped. */
  const handleStoryReply = useCallback(
    (payload: StoryReplyPayload) => {
      const me = currentUser;
      if (!me) return;
      const author = usersRef.current.find((u) => u.id === payload.authorId);
      handleSelectChat(payload.authorId, true, author);
      const msg: ChatMessage = {
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        senderId: me.id,
        senderName: me.name,
        senderAvatar: me.avatar,
        roomId: payload.authorId,
        type: 'text',
        content: payload.text,
        timestamp: Date.now(),
        reactions: {},
        status: 'sent',
        storyRef: payload.storyId,
      };
      socketService.sendMessage(msg);
      const now = Date.now();
      setChannels((prev) =>
        prev.map((c) =>
          c.id === payload.authorId
            ? {
                ...c,
                lastMessage: payload.text,
                lastMessageTimestamp: now,
                lastMessageTime: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                unreadCount: 0,
              }
            : c
        )
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentUser]
  );

  /** Phase 1.5 (Team GI wiring): leaving/deleting a group drops the
   * channel (and its messages) locally and returns to the chat list. */
  const removeChannelLocally = useCallback(
    (channelId: string) => {
      setChannels((prev) => prev.filter((c) => c.id !== channelId));
      setMessages((prev) => prev.filter((m) => m.roomId !== channelId));
      setDesktopShowGroupInfo(false);
      setMobileScreen('list');
      if (activeRoomId === channelId) {
        setActiveRoomId('saved_messages');
        setIsDm(false);
        setRecipientUser(undefined);
      }
    },
    [activeRoomId]
  );
  const handleLeaveGroup = useCallback(
    (channelId: string) => {
      removeChannelLocally(channelId);
      showToast(lang === 'bn' ? 'গ্রুপ ছেড়ে দেওয়া হয়েছে' : 'You left the group');
    },
    [removeChannelLocally, lang, showToast]
  );
  const handleDeleteGroup = useCallback(
    (channelId: string) => {
      removeChannelLocally(channelId);
      showToast(lang === 'bn' ? 'গ্রুপ মুছে ফেলা হয়েছে' : 'Group deleted');
    },
    [removeChannelLocally, lang, showToast]
  );

  /** Phase 1.5 (roadmap 1.5): join-by-invite upsert — reuses the exact
   * channel:created upsert logic from the socket effect above: prepend
   * when new, otherwise merge the incoming channel over the stored one. */
  const handleJoinChannel = useCallback((newCh: Channel) => {
    setChannels((prev) => {
      const idx = prev.findIndex((c) => c.id === newCh.id);
      if (idx === -1) return [newCh, ...prev];
      const incoming = newCh as Channel & {
        ownerId?: string;
        memberIds?: string[];
        adminIds?: string[];
      };
      const next = [...prev];
      next[idx] = { ...prev[idx], ...incoming };
      return next;
    });
  }, []);
  const handleJoinPending = useCallback(() => {
    showToast(
      lang === 'bn'
        ? 'যোগদানের অনুরোধ পাঠানো হয়েছে — অনুমোদনের অপেক্ষায়'
        : 'Join request sent — waiting for approval'
    );
  }, [lang, showToast]);

  // Update Channel details (images, sections, bookmarks, roles)
  const handleUpdateChannel = (updatedChannel: Channel) => {
    setChannels((prev) =>
      prev.map((c) => (c.id === updatedChannel.id ? updatedChannel : c))
    );
  };

  // Send message
  const handleSendMessage = useCallback(
    (
      content: string,
      type: 'text' | 'image' | 'video' | 'audio' | 'file' | 'offline_qr' | 'poll',
      meta?: {
        fileName?: string;
        fileSize?: string;
        duration?: number;
        images?: string[];
        sectionId?: string;
        replyTo?: ChatMessage['replyTo'];
        poll?: ChatMessage['poll'];
        sticker?: boolean;
        // Phase 1 meta pass-through (coordinator addendum #2): media MIME,
        // sticker-pack provenance, contact cards, story replies — copied
        // onto the constructed message below instead of being dropped.
        mimeType?: string;
        stickerPack?: string;
        stickerId?: string;
        contactCard?: string;
        storyRef?: string;
      }
    ) => {
      const me = currentUser;
      if (!me) return;
      // Disappearing messages: per-room TTL chosen in the chat menu (0 = off)
      let expiresAt: number | undefined;
      try {
        const ttlSec = Number(localStorage.getItem(`chitthi_ttl_${activeRoomId}`) || 0);
        if (ttlSec > 0) expiresAt = Date.now() + ttlSec * 1000;
      } catch {
        /* ignore */
      }
      const newMsg: ChatMessage = {
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        senderId: me.id,
        senderName: me.name,
        senderAvatar: me.avatar,
        roomId: activeRoomId,
        sectionId: meta?.sectionId,
        type,
        content,
        images: meta?.images,
        fileName: meta?.fileName,
        fileSize: meta?.fileSize,
        duration: meta?.duration,
        timestamp: Date.now(),
        reactions: {},
        status: 'sent',
        replyTo: meta?.replyTo,
        poll: meta?.poll,
        sticker: meta?.sticker,
        mimeType: meta?.mimeType,
        stickerPack: meta?.stickerPack,
        stickerId: meta?.stickerId,
        contactCard: meta?.contactCard,
        storyRef: meta?.storyRef,
        expiresAt,
      };

      socketService.sendMessage(newMsg);

      // Update last message in channels list
      const now = Date.now();
      setChannels((prev) =>
        prev.map((c) =>
          c.id === activeRoomId
            ? {
                ...c,
                lastMessage: type === 'text' ? content : `[${type}]`,
                lastMessageTimestamp: now,
                lastMessageTime: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                unreadCount: 0,
              }
            : c
        )
      );
    },
    [currentUser, activeRoomId]
  );

  // Patch a message in place (edit text, pin/unpin, poll votes, …)
  const handleUpdateMessage = useCallback((messageId: string, patch: Partial<ChatMessage>) => {
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, ...patch } : m)));
    // Sync the patch to peers/server — a local-only patch never left this device.
    const msg = messagesRef.current.find((m) => m.id === messageId);
    if (msg) socketService.sendMessageUpdate(messageId, msg.roomId, patch);
  }, []);

  // Soft-delete: content is wiped, a tombstone remains (WhatsApp-style)
  const handleDeleteMessage = useCallback((messageId: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId
          ? { ...m, content: '', images: undefined, poll: undefined, reactions: {}, deletedAt: Date.now() }
          : m
      )
    );
    // Tombstone the server copy too so deletes survive reloads and reach peers.
    const msg = messagesRef.current.find((m) => m.id === messageId);
    if (msg) socketService.sendMessageUpdate(messageId, msg.roomId, { deletedAt: Date.now() });
  }, []);

  // Toggle my reaction on a message (local + broadcast to peers)
  const handleToggleReaction = useCallback(
    (msg: ChatMessage, emoji: string) => {
      const me = currentUser;
      if (!me) return;
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== msg.id) return m;
          const reactions = { ...(m.reactions || {}) };
          const list = [...(reactions[emoji] || [])];
          const idx = list.indexOf(me.id);
          if (idx > -1) list.splice(idx, 1);
          else list.push(me.id);
          if (list.length === 0) delete reactions[emoji];
          else reactions[emoji] = list;
          return { ...m, reactions };
        })
      );
      socketService.sendReaction(msg.id, msg.roomId, emoji, me.id);
    },
    [currentUser]
  );

  // Forward a copy of a message into another room/channel
  const handleForwardMessage = useCallback(
    (msg: ChatMessage, targetRoomId: string) => {
      const me = currentUser;
      if (!me) return;
      const copy: ChatMessage = {
        ...msg,
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        senderId: me.id,
        senderName: me.name,
        senderAvatar: me.avatar,
        roomId: targetRoomId,
        sectionId: undefined,
        timestamp: Date.now(),
        reactions: {},
        status: 'sent',
        pinned: false,
        replyTo: undefined,
        // Forward hygiene (Phase 0.5, belt-and-braces with ChatView's
        // hand-off strip): a forward is a NEW message — it must not inherit
        // the original's edit marker or disappearing-message expiry.
        editedAt: undefined,
        expiresAt: undefined,
        forwardedFrom: msg.senderName,
        poll: msg.poll
          ? { ...msg.poll, options: msg.poll.options.map((o) => ({ ...o, voterIds: [] })) }
          : undefined,
      };
      setMessages((prev) => [...prev, copy]);
      // Always relay — sendMessage itself refuses saved_messages, so forwarding
      // INTO Saved Messages stays local-only by design.
      socketService.sendMessage(copy);
      const now = Date.now();
      setChannels((prev) =>
        prev.map((c) =>
          c.id === targetRoomId
            ? { ...c, lastMessage: copy.type === 'text' ? copy.content : `[${copy.type}]`, lastMessageTimestamp: now }
            : c
        )
      );
    },
    [currentUser]
  );

  /** MEGA round (AI Assistant wiring): save an AI reply into Saved
   * Messages. Mirrors handleForwardMessage's saved-room path exactly —
   * construct the message with roomId 'saved_messages', append it
   * locally, then hand it to socketService.sendMessage, which is
   * triple-guarded for that room (it never leaves this device; its local
   * echo is deduped by the onMessage handler). No active-room switch is
   * needed and the user's current conversation is never disturbed. */
  const handleSaveAiReply = useCallback(
    (text: string) => {
      const me = currentUser;
      if (!me) return;
      const content = text.trim();
      if (!content) return;
      const msg: ChatMessage = {
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        senderId: me.id,
        senderName: me.name,
        senderAvatar: me.avatar,
        roomId: 'saved_messages',
        type: 'text',
        content,
        timestamp: Date.now(),
        reactions: {},
        status: 'sent',
        forwardedFrom: 'AI Assistant',
      };
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      socketService.sendMessage(msg);
      const now = Date.now();
      setChannels((prev) =>
        prev.map((c) =>
          c.id === 'saved_messages'
            ? { ...c, lastMessage: content, lastMessageTimestamp: now }
            : c
        )
      );
      showToast(lang === 'bn' ? 'সেভড মেসেজে রাখা হয়েছে' : 'Saved to Saved Messages');
    },
    [currentUser, lang, showToast]
  );

  // Archive / mute a chat (WhatsApp-style list management)
  const handleToggleArchive = useCallback((roomId: string) => {
    setChannels((prev) => prev.map((c) => (c.id === roomId ? { ...c, isArchived: !c.isArchived } : c)));
  }, []);
  const handleToggleMute = useCallback((roomId: string) => {
    setChannels((prev) =>
      prev.map((c) =>
        c.id === roomId
          ? ({ ...c, isMuted: !c.isMuted, mutedUntil: undefined } as Channel)
          : c
      )
    );
  }, []);

  /** Phase 1.8 timed mute (context menu): `until` epoch ms, null = always.
   * Stored as `mutedUntil` on the channel (persisted with the channel
   * list); an expired timestamp simply stops muting (isChannelMutedNow). */
  const handleSetMuted = useCallback((roomId: string, until: number | null) => {
    setChannels((prev) =>
      prev.map((c) =>
        c.id === roomId
          ? ({ ...c, isMuted: true, mutedUntil: until ?? undefined } as Channel)
          : c
      )
    );
  }, []);

  /** Phase 1.8: mark a chat as unread from the row context menu. */
  const handleMarkUnread = useCallback((roomId: string) => {
    setChannels((prev) =>
      prev.map((c) =>
        c.id === roomId ? { ...c, unreadCount: Math.max(1, c.unreadCount || 0) } : c
      )
    );
  }, []);

  const activeChannel = channels.find((c) => c.id === activeRoomId) || channels[0];
  const activeRoomMessages = messages.filter((m) => m.roomId === activeRoomId);

  // MEGA round (People Directory): deduped contacts from the users state
  // plus channel membership — DM channels contribute their peer (channel
  // id + name/avatar), group memberIds / member names resolve back to
  // known users. The current user is always excluded.
  const directoryContacts = (() => {
    const byId = new Map<
      string,
      { id: string; name: string; username?: string; avatar?: string }
    >();
    const addUser = (u: User) => {
      if (!currentUser || u.id === currentUser.id) return;
      const existing = byId.get(u.id);
      byId.set(u.id, {
        id: u.id,
        name: u.name || existing?.name || 'User',
        username: u.username ?? existing?.username,
        avatar: u.avatar || existing?.avatar,
      });
    };
    for (const u of users) addUser(u);
    for (const c of channels) {
      if (!currentUser) break;
      if (!c.isGroup && c.id !== 'saved_messages' && c.id !== currentUser.id) {
        if (!byId.has(c.id)) {
          byId.set(c.id, { id: c.id, name: c.name, avatar: c.avatar || undefined });
        }
      }
      const memberIds = (c as Channel & { memberIds?: string[] }).memberIds || [];
      for (const mid of memberIds) {
        const known = users.find((u) => u.id === mid);
        if (known) addUser(known);
      }
      for (const entry of c.members || []) {
        const byIdMatch = users.find((u) => u.id === entry);
        if (byIdMatch) addUser(byIdMatch);
        else {
          const byNameMatch = users.find((u) => u.name === entry);
          if (byNameMatch) addUser(byNameMatch);
        }
      }
    }
    return Array.from(byId.values());
  })();

  // If user is not logged in, show Authentic Login Screen. Phase 0.4:
  // a null user ALWAYS lands here — never a seed/fallback person.
  if (!isLoggedIn || !currentUser) {
    return (
      <>
        <LoginScreen
          onLogin={handleLogin}
          lang={lang}
          onToggleLang={() => setLang((prev) => (prev === 'bn' ? 'en' : 'bn'))}
        />
        {/* Phase 1 (Team I wiring): this session was revoked from another
            device — the notice survives the forced logout so the user
            landing here knows why they were signed out. */}
        {revokedNotice && (
          <div role="alert" className="fixed top-4 left-1/2 -translate-x-1/2 z-50 max-w-sm w-[calc(100%-2rem)] rounded-[var(--r-card)] bg-danger text-white px-4 py-3 shadow-2xl flex items-start gap-3 animate-in fade-in">
            <p className="flex-1 text-xs font-semibold leading-relaxed">
              {lang === 'bn'
                ? 'এই ডিভাইসটি অন্য ডিভাইস থেকে সাইন আউট করা হয়েছে। এটি আপনি না হয়ে থাকলে পাসওয়ার্ড বদলে ফেলুন।'
                : 'You were signed out from another device. If that was not you, change your password after signing back in.'}
            </p>
            <button
              onClick={() => setRevokedNotice(false)}
              className="min-w-11 min-h-11 -my-1 flex items-center justify-center shrink-0 text-white/80 hover:text-white text-sm font-bold leading-none"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <div
      className={`h-screen w-screen flex flex-col ${
        isDarkMode ? 'dark' : ''
      } bg-app text-app font-sans antialiased overflow-hidden`}
    >
      {/* Main Responsive Application Shell */}
      <div className="flex-1 flex overflow-hidden w-full h-full">
        {/* ============================================================ */}
        {/* LEFT COLUMN: Main Navigation & Chat List (Desktop & Mobile)  */}
        {/* On mobile: visible when mobileScreen === 'list'              */}
        {/* On desktop (md:): always visible as left column (width 380px)*/}
        {/* ============================================================ */}
        <div
          className={`${
            mobileScreen === 'list' ? 'flex' : 'hidden md:flex'
          } w-full md:w-[360px] lg:w-[380px] md:min-w-[300px] md:max-w-[420px] h-full flex-col border-r border-token bg-app shrink-0 z-10`}
        >
          {/* Active Tab Screen on Left */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {currentTab === 'chats' && (
              <ChatsScreen
                channels={channels}
                users={users}
                currentUser={currentUser}
                activeRoomId={activeRoomId}
                onSelectChat={handleSelectChat}
                onTogglePin={handleTogglePin}
                onToggleArchive={handleToggleArchive}
                onToggleMute={handleToggleMute}
                onSetMuted={handleSetMuted}
                onMarkUnread={handleMarkUnread}
                onOpenNewCategory={() => setIsNewCategoryOpen(true)}
                isDarkMode={isDarkMode}
                onToggleDarkMode={() => setIsDarkMode(!isDarkMode)}
                lang={lang}
                onToggleLang={() => setLang((prev) => (prev === 'bn' ? 'en' : 'bn'))}
                onStoryReply={handleStoryReply}
                onOpenProfileCard={openProfileCardFor}
                onJumpToMessage={jumpToMessage}
                messages={messages}
                onJoinChannel={handleJoinChannel}
                onJoinPending={handleJoinPending}
                onShowToast={showToast}
                onNewMessage={() => setIsDirectoryOpen(true)}
                onOpenAI={() => setIsAiOpen(true)}
              />
            )}

            {currentTab === 'calls' && (
              <React.Suspense fallback={<ScreenFallback />}>
              <CallsScreen
                callLogs={callLogs}
                users={users}
                currentUser={currentUser}
                onDeleteCallLog={handleDeleteCallLog}
                onClearCallLogs={handleClearCallLogs}
                onStartCall={(type, target) => {
                  setCallType(type);
                  setCallTargetName(target.name);
                  callStartedAtRef.current = Date.now();
                  setCallSession({ direction: 'out', peerId: target.id, peerName: target.name, callType: type });
                  callOpenRef.current = true;
                  setIsVoiceCallOpen(true);
                }}
                lang={lang}
              />
              </React.Suspense>
            )}

            {currentTab === 'settings' && (
              <React.Suspense fallback={<ScreenFallback />}>
              <SettingsScreen
                currentUser={currentUser}
                onEditProfile={() => setIsProfileOpen(true)}
                isDarkMode={isDarkMode}
                onToggleDarkMode={() => setIsDarkMode(!isDarkMode)}
                lang={lang}
                onToggleLang={() => setLang((prev) => (prev === 'bn' ? 'en' : 'bn'))}
                onLogout={handleLogout}
              />
              </React.Suspense>
            )}
          </div>

          {/* Bottom Navigation Bar */}
          <BottomNav
            activeTab={currentTab}
            onTabChange={(tab) => {
              setCurrentTab(tab);
              setMobileScreen('list');
            }}
            lang={lang}
          />
        </div>

        {/* ============================================================ */}
        {/* RIGHT COLUMN: Active Chat Conversation & Shared Media        */}
        {/* On mobile: visible when mobileScreen === 'chat_view'        */}
        {/* On desktop: always visible as main chat area                */}
        {/* ============================================================ */}
        <div
          className={`${
            mobileScreen === 'chat_view' ? 'flex' : 'hidden md:flex'
          } flex-1 min-w-0 flex flex-col h-full bg-surface overflow-hidden relative`}
        >
          <ChatViewScreen
            roomId={activeRoomId}
            isDm={isDm}
            channel={activeChannel}
            recipientUser={recipientUser}
            currentUser={currentUser}
            messages={activeRoomMessages}
            users={users}
            onSendMessage={handleSendMessage}
            onBack={() => setMobileScreen('list')}
            onOpenGroupInfo={() => {
              if (window.innerWidth < 768) {
                setMobileScreen('group_info');
              } else {
                setDesktopShowGroupInfo(!desktopShowGroupInfo);
              }
            }}
            onStartCall={(type) => {
              // Phase 0.7: GROUP CALLS ARE DISABLED. Starting a "group" call
              // here used peerId: undefined, which made the server broadcast
              // the invite — EVERY online user rang and multiple accepts
              // collided into one 1:1 connection. Group calling returns only
              // on an SFU (Phase 3). 1:1 (DM) calls are unaffected.
              if (!isDm) return;
              setCallType(type);
              setCallTargetName(recipientUser?.name || 'User');
              callStartedAtRef.current = Date.now();
              setCallSession({
                direction: 'out',
                peerId: recipientUser?.id,
                peerName: recipientUser?.name || 'User',
                callType: type,
              });
              callOpenRef.current = true;
              setIsVoiceCallOpen(true);
            }}
            onPreviewMedia={(url, type, title) => setPreviewMedia({ url, type, title })}
            onOpenCamera={() => setIsCameraOpen(true)}
            onOpenOfflineQr={() => setIsOfflineQrOpen(true)}
            onUpdateChannel={handleUpdateChannel}
            onUpdateMessage={handleUpdateMessage}
            onDeleteMessage={handleDeleteMessage}
            onToggleReaction={handleToggleReaction}
            onForwardMessage={handleForwardMessage}
            scheduledMessages={scheduled
              .filter((s) => s.roomId === activeRoomId)
              .map((s) => ({
                id: s.id,
                content: s.content,
                sendAt: s.sendAt,
                // Phase 0.8: the failure flag rides through so ChatView can
                // render "Failed — tap to retry".
                failed: !!s.failed,
              }))}
            onScheduleMessage={handleScheduleMessage}
            onCancelScheduled={handleCancelScheduled}
            onRetryScheduled={handleRetryScheduled}
            allChannels={channels}
            lang={lang}
            activeSubchannelId={activeSubchannelId}
            jumpToMessageId={jumpToMessageId ?? undefined}
            onOpenUserChat={(userId) => {
              const u = usersRef.current.find((x) => x.id === userId);
              handleSelectChat(userId, true, u);
            }}
          />
        </div>

        {/* ============================================================ */}
        {/* GROUP INFO: On Mobile full-screen view, on Desktop slideover */}
        {/* ============================================================ */}
        {/* Mobile Full-Screen Group Info with Back button */}
        {mobileScreen === 'group_info' && (
          <div className="fixed inset-0 z-30 flex md:hidden bg-app">
            <React.Suspense fallback={<ScreenFallback />}>
            <GroupInfoScreen
              channel={activeChannel}
              users={users}
              currentUser={currentUser}
              onBack={() => setMobileScreen('chat_view')}
              onSelectMember={(u) => {
                handleSelectChat(u.id, true, u);
              }}
              onUpdateChannel={handleUpdateChannel}
              onSelectSubchannel={(secId) => {
                setActiveSubchannelId(secId);
                setMobileScreen('chat_view');
              }}
              messages={activeRoomMessages}
              onJumpToMessage={(id) => {
                setMobileScreen('chat_view');
                setDesktopShowGroupInfo(false);
                setJumpToMessageId(id);
              }}
              onCallMember={(u) => {
                setCallType('audio');
                setCallTargetName(u.name);
                callStartedAtRef.current = Date.now();
                setCallSession({ direction: 'out', peerId: u.id, peerName: u.name, callType: 'audio' });
                callOpenRef.current = true;
                setIsVoiceCallOpen(true);
              }}
              onLeaveGroup={handleLeaveGroup}
              onDeleteGroup={handleDeleteGroup}
              lang={lang}
            />
            </React.Suspense>
          </div>
        )}

        {/* Desktop Slideover Group Info Drawer */}
        {desktopShowGroupInfo && (
          <div className="hidden lg:flex w-88 h-full border-l border-token bg-app overflow-y-auto shrink-0 z-20 animate-in slide-in-from-right duration-[var(--dur-sheet)]">
            <React.Suspense fallback={<ScreenFallback />}>
            <GroupInfoScreen
              channel={activeChannel}
              users={users}
              currentUser={currentUser}
              onBack={() => setDesktopShowGroupInfo(false)}
              onSelectMember={(u) => {
                handleSelectChat(u.id, true, u);
              }}
              onUpdateChannel={handleUpdateChannel}
              onSelectSubchannel={(secId) => {
                setActiveSubchannelId(secId);
                setDesktopShowGroupInfo(false);
              }}
              messages={activeRoomMessages}
              onJumpToMessage={(id) => {
                setMobileScreen('chat_view');
                setDesktopShowGroupInfo(false);
                setJumpToMessageId(id);
              }}
              onCallMember={(u) => {
                setCallType('audio');
                setCallTargetName(u.name);
                callStartedAtRef.current = Date.now();
                setCallSession({ direction: 'out', peerId: u.id, peerName: u.name, callType: 'audio' });
                callOpenRef.current = true;
                setIsVoiceCallOpen(true);
              }}
              onLeaveGroup={handleLeaveGroup}
              onDeleteGroup={handleDeleteGroup}
              lang={lang}
            />
            </React.Suspense>
          </div>
        )}
      </div>

      {/* New Category & Group Creation Modal (Phase 5: lazy, mounts only when opened) */}
      {isNewCategoryOpen && (
        <React.Suspense fallback={<ModalFallback />}>
      <NewCategoryModal
        isOpen={isNewCategoryOpen}
        onClose={() => setIsNewCategoryOpen(false)}
        users={users}
        onCreateCategory={async (name, memberNames, _tags) => {
          const now = Date.now();
          // Phase 0.3: membership is by USER ID, never display name. The
          // modal hands us the chosen members' names, so resolve them to
          // IDs against the people list (its selection is ID-based
          // internally; names are only its outward callback shape today).
          const selectedUserIds = Array.from(
            new Set(
              users.filter((u) => memberNames.includes(u.name)).map((u) => u.id)
            )
          );
          const memberIds = Array.from(new Set([...selectedUserIds, currentUser.id]));
          const newCh: Channel = {
            id: `group_${now}`,
            name,
            description: `${name} (${memberIds.length} members)`,
            iconType: 'general',
            isGroup: true,
            isPinned: false,
            avatar: '',
            lastMessage: lang === 'bn' ? 'গ্রুপ তৈরি হয়েছে' : 'Group created',
            lastMessageTimestamp: now,
            createdAt: now,
            membersCount: memberIds.length,
            members: memberNames
          };
          // Server-contract fields (Phase 0.3): owner + ID-based membership
          // + admins. They ride on the object alongside the Channel fields.
          const channelPayload = {
            ...newCh,
            ownerId: currentUser.id,
            memberIds,
            adminIds: [currentUser.id],
          };
          setChannels((prev) => [channelPayload as Channel, ...prev]);
          handleSelectChat(newCh.id, false);

          // Persist to server (authenticated — Phase 0.1/0.3) so creation
          // is authoritative; the server also forces ownerId = caller.
          try {
            const headers = await authHeaders(currentUser.id);
            await fetch('/api/channels', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...headers },
              body: JSON.stringify(channelPayload)
            });
          } catch (err) {
            console.warn('Failed to sync channel to server:', err);
          }
        }}
        lang={lang}
      />
        </React.Suspense>
      )}

      {/* Offline QR File Sharing Modal (Phase 5: lazy, mounts only when opened) */}
      {isOfflineQrOpen && (
        <React.Suspense fallback={<ModalFallback />}>
      <OfflineQrModal
        isOpen={isOfflineQrOpen}
        onClose={() => setIsOfflineQrOpen(false)}
        onSendOfflineMessage={(content, type, meta) => {
          handleSendMessage(content, type, meta);
        }}
        onAddContact={(segment) => {
          setIsOfflineQrOpen(false);
          void handleAddContact(segment);
        }}
        lang={lang}
      />
        </React.Suspense>
      )}

      {/* Media Lightbox Preview Modal (Phase 5: lazy, mounts only when media is previewed) */}
      {previewMedia && (
        <React.Suspense fallback={<ModalFallback />}>
      <MediaPreviewModal
        media={previewMedia}
        onClose={() => setPreviewMedia(null)}
        lang={lang}
      />
        </React.Suspense>
      )}

      {/* Camera Capture Modal (Phase 5: lazy, mounts only when opened) */}
      {isCameraOpen && (
        <React.Suspense fallback={<ModalFallback />}>
      <CameraModal
        isOpen={isCameraOpen}
        onClose={() => setIsCameraOpen(false)}
        onCapture={(dataUrl) => {
          // Phase 0.4: report the REAL captured size. The capture is a
          // base64 JPEG data URL, so the decoded byte length is exact —
          // no fabricated '150 KB'.
          const commaIdx = dataUrl.indexOf(',');
          const b64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
          const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
          const bytes = Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
          const fileSize =
            bytes < 1024
              ? `${bytes} B`
              : bytes < 1024 * 1024
                ? `${(bytes / 1024).toFixed(1)} KB`
                : `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
          handleSendMessage(dataUrl, 'image', {
            fileName: `photo_${Date.now()}.jpg`,
            fileSize,
          });
        }}
        lang={lang}
      />
        </React.Suspense>
      )}

      {/* Voice & Video Call Modal with Real Camera/Mic Controls
          (Phase 5: lazy, mounts only while a call is open — every effect
          in VoiceCallModal is already gated on `isOpen`, and its session
          lifecycle effect re-initialises all call state on mount) */}
      {isVoiceCallOpen && (
        <React.Suspense fallback={<ModalFallback />}>
      <VoiceCallModal
        isOpen={isVoiceCallOpen}
        onClose={() => {
          setIsVoiceCallOpen(false);
          setCallSession(null);
          callOpenRef.current = false;
        }}
        targetUser={isDm ? recipientUser : null}
        targetRoomName={callTargetName}
        callType={callType}
        lang={lang}
        currentUser={currentUser}
        roomId={activeRoomId}
        session={callSession}
        onCallEnded={(info) => {
          // Phase 0.4: resolve the peer by ID (Team F now includes peerId
          // in the payload) — never by display name, and never fabricate a
          // stranger with a stock photo on a miss. Unknown peers are stored
          // with an empty avatar; CallsScreen renders initials for them.
          const peerUser =
            (info.peerId ? users.find((u) => u.id === info.peerId) : undefined) ||
            ({
              id: info.peerId || `call_${Date.now()}`,
              name: info.peerName,
              avatar: '',
              status: '',
              online: false,
            } as User);
          // MEGA round: real measured data usage from VoiceCallModal
          // (optional — persisted verbatim when present, omitted when
          // absent; never invented). Read via a widened view so this
          // compiles whether or not the modal's payload type has landed.
          const dataUsedRaw = (info as { dataUsed?: unknown }).dataUsed;
          const dataUsed =
            typeof dataUsedRaw === 'string' && dataUsedRaw ? dataUsedRaw : undefined;
          const log: CallLog = {
            id: `call_${Date.now()}`,
            user: peerUser,
            // Declined is distinct; busy/no-answer/unconnected all read as missed.
            type: info.connected
              ? info.direction === 'in'
                ? 'incoming'
                : 'outgoing'
              : info.endReason === 'declined'
                ? 'declined'
                : 'missed',
            callType: info.callType,
            date: new Date().toLocaleDateString(),
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            duration: info.connected
              ? `${Math.floor(info.durationSec / 60)}:${String(info.durationSec % 60).padStart(2, '0')}`
              : undefined,
            ...(dataUsed ? { dataUsed } : {}),
          };
          setCallLogs((prev) => [log, ...prev]);
          // Phase 1.3 (Team CA wiring): mirror the finished call to the
          // server log (it also writes the peer's copy, direction
          // flipped). Best-effort — the local log above stays authoritative
          // on this device. `startedAt` is the moment the session opened,
          // captured at every setCallSession site in callStartedAtRef.
          void postCallLog(
            {
              peerId: info.peerId || peerUser.id,
              peerName: info.peerName,
              type: log.type,
              direction: info.direction,
              callType: info.callType,
              durationSec: info.durationSec,
              startedAt: callStartedAtRef.current || Date.now(),
              // Forwarded for a server that persists it; the current
              // callLogService wire builder ignores unknown fields, so
              // the local log above remains the authoritative copy.
              ...(dataUsed ? ({ dataUsed } as { dataUsed: string }) : {}),
            },
            currentUser.id
          );
        }}
      />
        </React.Suspense>
      )}

      {/* People Directory (MEGA round: lazy, mounts only when opened).
          Selecting a person reuses the exact DM-open mechanism Group
          Info uses — handleSelectChat(userId, true, user). */}
      {isDirectoryOpen && (
        <React.Suspense fallback={<ModalFallback />}>
          <PeopleDirectory
            open={isDirectoryOpen}
            onClose={() => setIsDirectoryOpen(false)}
            lang={lang}
            currentUserId={currentUser.id}
            contacts={directoryContacts}
            onSelect={(u) => {
              const full =
                usersRef.current.find((x) => x.id === u.id) ||
                ({
                  id: u.id,
                  name: u.name,
                  username: u.username,
                  avatar: u.avatar || '',
                  status: '',
                  online: false,
                } as User);
              setIsDirectoryOpen(false);
              handleSelectChat(u.id, true, full as User);
            }}
          />
        </React.Suspense>
      )}

      {/* AI Assistant (MEGA round: lazy, mounts only when opened) */}
      {isAiOpen && (
        <React.Suspense fallback={<ModalFallback />}>
          <AIAssistantScreen
            open={isAiOpen}
            onClose={() => setIsAiOpen(false)}
            lang={lang}
            currentUserId={currentUser.id}
            onSaveReply={handleSaveAiReply}
          />
        </React.Suspense>
      )}

      {/* User Profile Settings Modal (Phase 5: lazy, mounts only when opened —
          its form re-syncs from the profile on every open) */}
      {isProfileOpen && (
        <React.Suspense fallback={<ModalFallback />}>
      <UserProfileModal
        isOpen={isProfileOpen}
        onClose={() => setIsProfileOpen(false)}
        currentUser={currentUser}
        onSave={async (updated) => {
          // Phase 1.4 (Team I wiring): the old fail-open uniqueness block is
          // REMOVED. UserProfileModal is now fail-CLOSED — a changed handle
          // is claimed via the server (claimUsername) before onSave is ever
          // called, and any failure blocks the save there. Re-checking here
          // against Firestore and applying the change anyway on error was
          // the bypass Team I replaced.
          const newU = { ...currentUser, ...updated };
          setCurrentUser(newU);
          setUsers((prev) => prev.map((u) => (u.id === currentUser.id ? newU : u)));
          // Phase 0.9: `status` must be passed through — without it the
          // about/status text never syncs and other devices fall back to
          // hard-coded defaults. Phase 1.4.5: `about` (the multi-line About,
          // split from the one-line mood `status`) rides along the same way.
          syncUserProfile({
            id: newU.id,
            name: newU.name,
            email: newU.email || '',
            avatar: newU.avatar,
            username: newU.username,
            status: newU.status,
            about: (updated as { about?: string }).about,
          }).catch(() => {});
        }}
        lang={lang}
      />
        </React.Suspense>
      )}

      {/* Phase 2 first-run onboarding (Team G): one glass-sheet flow;
          finishing sets the onboarded + claim-prompted flags, choosing a
          username hands off to the existing ClaimUsernameModal below. */}
      {onboardingOpen && (
        <Onboarding
          onFinish={handleFinishOnboarding}
          onChooseUsername={handleOnboardingChooseUsername}
        />
      )}

      {/* Post-login @username claim prompt (Phase 1.4, Team I wiring;
          Phase 5: lazy, mounts only while the prompt is open) */}
      {claimPromptOpen && (
        <React.Suspense fallback={<ModalFallback />}>
      <ClaimUsernameModal
        open={claimPromptOpen}
        onClaim={handleClaimUsername}
        onSkip={handleSkipClaim}
        lang={lang}
      />
        </React.Suspense>
      )}

      {/* Shared other-user ProfileCard (Phase 1.4: QR add-contact +
          find-people). Message opens the DM; Call starts an audio call. */}
      {profileCardUser && (
        <ProfileCard
          user={profileCardUser}
          onClose={() => setProfileCardUser(null)}
          onMessage={(pu) => {
            setProfileCardUser(null);
            const full = usersRef.current.find((u) => u.id === pu.id) || {
              id: pu.id,
              name: pu.name,
              username: pu.username,
              avatar: pu.avatar || '',
              status: pu.status || '',
              online: !!pu.online,
              presence: pu.presence,
              lastSeen: pu.lastSeen,
            };
            handleSelectChat(pu.id, true, full as User);
          }}
          onCall={(pu) => {
            setProfileCardUser(null);
            setCallType('audio');
            setCallTargetName(pu.name);
            callStartedAtRef.current = Date.now();
            setCallSession({ direction: 'out', peerId: pu.id, peerName: pu.name, callType: 'audio' });
            callOpenRef.current = true;
            setIsVoiceCallOpen(true);
          }}
          onBlock={async (pu) => {
            try {
              const headers = await authHeaders(currentUser.id);
              const res = await fetch('/api/blocks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...headers },
                body: JSON.stringify({ blockedId: pu.id }),
              });
              if (res.ok) {
                setProfileCardUser(null);
                showToast(
                  lang === 'bn' ? `${pu.name}-কে ব্লক করা হয়েছে` : `${pu.name} blocked`
                );
              }
            } catch {
              /* block request failed — card stays open, nothing faked */
            }
          }}
          lang={lang}
        />
      )}

      {/* Reminder banner (Phase 1.8): deep-links to the original message */}
      {reminderBanner && (
        <div role="alert" className="fixed top-4 left-1/2 -translate-x-1/2 z-50 max-w-sm w-[calc(100%-2rem)] rounded-[var(--r-card)] bg-app border border-token px-4 py-3 shadow-2xl flex items-center gap-3 animate-in fade-in">
          <span className="text-lg shrink-0">⏰</span>
          <p className="flex-1 min-w-0 text-xs font-semibold text-app truncate">
            {lang === 'bn' ? 'রিমাইন্ডার: ' : 'Reminder: '}
            <span className="font-normal text-app-2">{reminderBanner.snippet}</span>
          </p>
          <button
            onClick={() => {
              const banner = reminderBanner;
              setReminderBanner(null);
              void jumpToMessage(banner.roomId, banner.messageId);
            }}
            className="min-h-11 px-3 bg-primary text-white rounded-[var(--r-pill)] text-[11px] font-bold shrink-0 flex items-center"
          >
            {lang === 'bn' ? 'দেখুন' : 'View'}
          </button>
          <button
            onClick={() => setReminderBanner(null)}
            className="min-w-11 min-h-11 -my-1 flex items-center justify-center text-app-faint hover:text-app text-sm font-bold leading-none shrink-0"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* Lightweight toast (Phase 1 outcomes) */}
      {toast && (
        <div role="status" className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 max-w-sm w-auto rounded-[var(--r-pill)] bg-badge px-4 py-2.5 shadow-2xl text-xs font-semibold text-center animate-in fade-in pointer-events-none">
          {toast}
        </div>
      )}
    </div>
  );
}
