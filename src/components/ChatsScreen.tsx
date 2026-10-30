import React, { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import { Channel, User, ChatMessage } from '../types/chat';
import { Search, Plus, MessageSquare, Pin, Moon, Sun, Globe, X, Move, Archive, BellOff, Bell, UserPlus, Clock, Hash, Trash2, Pencil, Check, ChevronRight, ListPlus, Link2, MoreVertical, Sparkles, Users } from 'lucide-react';
import { formatRelativeTime } from '../utils/timeFormat';
import { getEffectiveUserPresence } from '../utils/presenceUtils';
import { StoriesBar, StoryReplyPayload } from './StoriesBar';
import { authHeaders, searchUsers, DirectoryUser } from '../services/firebase';
import { initialsAvatarDataUrl } from '../utils/avatar';
import { socketService, PresenceMode, loadPresenceMode } from '../services/socketService';

// ── Phase 1.9.6 custom folders / lists (local to this device) ─────────────
export interface ChatListFolder {
  id: string;
  name: string;
  channelIds: string[];
}
const LISTS_KEY = 'chitthi_lists_v1';
function loadLists(): ChatListFolder[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(LISTS_KEY) || '[]');
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (l) => l && typeof l.id === 'string' && typeof l.name === 'string' && Array.isArray(l.channelIds)
      );
    }
  } catch {
    /* corrupt storage — start empty */
  }
  return [];
}
function saveLists(lists: ChatListFolder[]) {
  try {
    localStorage.setItem(LISTS_KEY, JSON.stringify(lists));
  } catch {
    /* ignore quota errors */
  }
}

// ── Phase 1.9.1 global search: recent queries (last 8, clearable) ─────────
const RECENT_SEARCH_KEY = 'chitthi_recent_searches_v1';
function loadRecentSearches(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_SEARCH_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

interface GlobalSearchResult {
  roomId: string;
  message: { id: string; senderId: string; senderName: string; timestamp: number; type: string; content: string; fileName?: string };
}

/** A channel is effectively muted while isMuted is set and its timed
 * mute (Phase 1.8 `mutedUntil`) has not yet expired. */
export function isEffectivelyMuted(channel: Channel): boolean {
  const until = (channel as Channel & { mutedUntil?: number }).mutedUntil;
  if (typeof until === 'number' && until <= Date.now()) return false;
  return !!channel.isMuted;
}

// Honest avatar fallback (Phase 0.4): a generated initials tile (brand
// gradient + initials), never a stock photo of a stranger.

/** Phase 2: chat-list loading skeleton — avatar circle + two text lines
 * per row, built on the .skeleton token utility. Shown only for the
 * initial mount until the first data render commits (see isLoading). */
export const ChatsSkeleton: React.FC<{ rows?: number }> = ({ rows = 6 }) => (
  <div className="space-y-1 px-2" aria-hidden="true" data-testid="chats-skeleton">
    {Array.from({ length: rows }).map((_, i) => (
      <div key={i} className="flex items-center gap-3 px-2 py-2 min-h-[68px]">
        <div className="skeleton w-[52px] h-[52px] rounded-full shrink-0" />
        <div className="flex-1 min-w-0 space-y-2">
          <div className="skeleton h-3.5 w-2/5 rounded-full" />
          <div className="skeleton h-3 w-3/5 rounded-full" />
        </div>
        <div className="skeleton h-3 w-10 rounded-full shrink-0" />
      </div>
    ))}
  </div>
);

interface ChatsScreenProps {
  channels: Channel[];
  users: User[];
  activeRoomId: string;
  /** Signed-in user. If omitted, resolved from localStorage 'chithi_auth_user' only — never another user. */
  currentUser?: User;
  onSelectChat: (roomId: string, isDm: boolean, user?: User) => void;
  onTogglePin: (roomId: string) => void;
  onToggleArchive?: (roomId: string) => void;
  onToggleMute?: (roomId: string) => void;
  /** Phase 1.8: timed mute — `until` epoch ms, or null = mute always.
   * Unmuting goes through onToggleMute. */
  onSetMuted?: (roomId: string, until: number | null) => void;
  /** Phase 1.8: mark a chat as unread from the row context menu. */
  onMarkUnread?: (roomId: string) => void;
  onOpenNewCategory: () => void;
  isDarkMode: boolean;
  onToggleDarkMode: () => void;
  lang: 'bn' | 'en';
  onToggleLang: () => void;
  /** Phase 1.1 (Team ST wiring): story replies from StoriesBar. */
  onStoryReply?: (payload: StoryReplyPayload) => void;
  /** Phase 1.4.6 / 1.4.3: open the shared ProfileCard for a person
   * (find-people results, QR add-contact results routed via App). */
  onOpenProfileCard?: (user: User) => void;
  /** Phase 1.9.1: open a room and scroll/flash a specific message. */
  onJumpToMessage?: (roomId: string, messageId: string) => void;
  /** All loaded messages (Phase 1.8 Saved Messages panel: hashtags +
   * group-by-source over the saved room's items). */
  messages?: ChatMessage[];
  /** Phase 1.5 (roadmap 1.5): join-by-invite — App upserts the returned
   * channel into its channels state (same upsert as channel:created). */
  onJoinChannel?: (channel: Channel) => void;
  /** Phase 1.5: join approval is on — App shows the pending toast. */
  onJoinPending?: () => void;
  /** Phase 1.5: reuse App's toast mechanism for join outcomes. */
  onShowToast?: (message: string) => void;
  /** Mega round: open the AI assistant (App-owned surface). When provided,
   * a pinned AI card renders at the very top of the chat list. */
  onOpenAI?: () => void;
  /** Mega round: start a new message (App-owned people/new-chat flow).
   * When provided, a round people button renders directly above the FAB. */
  onNewMessage?: () => void;
}

/** Extract an invite code from a pasted invite link or bare code.
 * Accepts `chitthi://join/<code>`, any URL/path ending in the code,
 * or the raw code itself. Trims whitespace and trailing slashes. */
export function extractInviteCode(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  const withoutQuery = trimmed.split(/[?#]/)[0].replace(/\/+$/, '').trim();
  if (!withoutQuery) return '';
  if (withoutQuery.includes('/')) {
    const parts = withoutQuery.split('/').filter(Boolean);
    return (parts[parts.length - 1] || '').trim();
  }
  return withoutQuery;
}

export const ChatsScreen: React.FC<ChatsScreenProps> = ({
  channels,
  users,
  activeRoomId,
  currentUser,
  onSelectChat,
  onTogglePin,
  onToggleArchive,
  onToggleMute,
  onSetMuted,
  onMarkUnread,
  onOpenNewCategory,
  isDarkMode,
  onToggleDarkMode,
  lang,
  onToggleLang,
  onStoryReply,
  onOpenProfileCard,
  onJumpToMessage,
  messages,
  onJoinChannel,
  onJoinPending,
  onShowToast,
  onOpenAI,
  onNewMessage,
}) => {
  // Resolve the signed-in user: prop → localStorage 'chithi_auth_user'. Crash-proof.
  // No users[0] fallback: presenting as somebody else is worse than no user —
  // when nothing resolves, header avatar / stories simply render nothing.
  const resolvedCurrentUser: User | undefined = useMemo(() => {
    if (currentUser) return currentUser;
    try {
      const saved = localStorage.getItem('chithi_auth_user');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed.id === 'string') return parsed as User;
      }
    } catch {
      /* ignore corrupt storage */
    }
    return undefined;
  }, [currentUser]);
  const [activeFilter, setActiveFilter] = useState<'all' | 'unread' | 'groups' | 'personal'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearchInput] = useState(true);
  // Phase 2 skeleton: true for the initial mount only — it flips on the
  // first animation frame after mount, i.e. as soon as the first data
  // render has committed. No artificial delay is introduced.
  const [isLoading, setIsLoading] = useState(true);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setIsLoading(false));
    return () => cancelAnimationFrame(raf);
  }, []);
  const [showArchived, setShowArchived] = useState(false);
  const archivedCount = channels.filter((c) => c.isArchived).length;
  // Aggregate unread across archived chats so unread mail isn't invisible (0.10)
  const archivedUnreadCount = channels
    .filter((c) => c.isArchived)
    .reduce((sum, c) => sum + (c.unreadCount ?? 0), 0);

  // ── Phase 1.9.6 custom lists ─────────────────────────────────────────────
  const [lists, setLists] = useState<ChatListFolder[]>(loadLists);
  const [activeListId, setActiveListId] = useState<string | null>(null);
  useEffect(() => saveLists(lists), [lists]);
  const activeList = lists.find((l) => l.id === activeListId) || null;
  const listUnreadCount = (list: ChatListFolder) =>
    channels
      .filter((c) => list.channelIds.includes(c.id) && !isEffectivelyMuted(c))
      .reduce((sum, c) => sum + (c.unreadCount ?? 0), 0);
  const createList = (name: string): ChatListFolder | null => {
    const clean = name.trim();
    if (!clean) return null;
    const list: ChatListFolder = {
      id: `list_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: clean,
      channelIds: [],
    };
    setLists((prev) => [...prev, list]);
    return list;
  };
  const toggleChannelInList = (listId: string, channelId: string) => {
    setLists((prev) =>
      prev.map((l) =>
        l.id !== listId
          ? l
          : {
              ...l,
              channelIds: l.channelIds.includes(channelId)
                ? l.channelIds.filter((id) => id !== channelId)
                : [...l.channelIds, channelId],
            }
      )
    );
  };

  // ── Phase 1.4.8 presence picker ──────────────────────────────────────────
  const [presenceMode, setPresenceModeState] = useState<PresenceMode>(() => loadPresenceMode());
  const handlePresenceChange = (mode: PresenceMode) => {
    setPresenceModeState(mode);
    socketService.setPresenceMode(mode);
  };

  // ── Phase 1.8 row context menu (long-press + right-click) ───────────────
  const [ctxMenu, setCtxMenu] = useState<{
    channel: Channel;
    x: number;
    y: number;
    section: 'main' | 'mute' | 'lists';
  } | null>(null);
  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);
  const openCtxMenu = (channel: Channel, x: number, y: number) => {
    setCtxMenu({
      channel,
      x: Math.max(8, Math.min(x, window.innerWidth - 240)),
      y: Math.max(8, Math.min(y, window.innerHeight - 340)),
      section: 'main',
    });
  };
  const startLongPress = (channel: Channel, x: number, y: number) => {
    longPressFiredRef.current = false;
    if (pressTimerRef.current) clearTimeout(pressTimerRef.current);
    pressTimerRef.current = setTimeout(() => {
      longPressFiredRef.current = true;
      openCtxMenu(channel, x, y);
    }, 550);
  };
  const cancelLongPress = () => {
    if (pressTimerRef.current) clearTimeout(pressTimerRef.current);
    pressTimerRef.current = null;
  };
  /** Row click wrapper: a click that follows a long-press (which opened
   * the context menu) must not also open the chat. */
  const handleRowClick = (channel: Channel) => {
    if (longPressFiredRef.current) {
      longPressFiredRef.current = false;
      return;
    }
    onSelectChat(channel.id, !channel.isGroup);
  };

  // ── Phase 1.8 draft previews ─────────────────────────────────────────────
  // ChatView stores drafts per room+section as `chitthi_draft_<room>_<sec>`.
  // The list re-reads them on focus / a slow tick (drafts change in another
  // component, so there is no shared state to subscribe to).
  const [, setDraftTick] = useState(0);
  useEffect(() => {
    const bump = () => setDraftTick((t) => t + 1);
    window.addEventListener('focus', bump);
    const iv = setInterval(bump, 4000);
    return () => {
      window.removeEventListener('focus', bump);
      clearInterval(iv);
    };
  }, []);
  const getDraftFor = useCallback((roomId: string): string | null => {
    try {
      const prefix = `chitthi_draft_${roomId}_`;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(prefix)) {
          const value = (localStorage.getItem(key) || '').trim();
          if (value) return value;
        }
      }
    } catch {
      /* storage unavailable */
    }
    return null;
  }, []);

  // ── Phase 1.9.1 global search modal ──────────────────────────────────────
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [globalQuery, setGlobalQuery] = useState('');
  const [globalResults, setGlobalResults] = useState<GlobalSearchResult[]>([]);
  const [globalLoading, setGlobalLoading] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>(loadRecentSearches);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setGlobalSearchOpen(true);
      }
      if (e.key === 'Escape') setGlobalSearchOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    const q = globalQuery.trim();
    if (!globalSearchOpen || q.length < 2) {
      setGlobalResults([]);
      setGlobalLoading(false);
      return;
    }
    setGlobalLoading(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const headers = await authHeaders(resolvedCurrentUser?.id);
          const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { headers });
          const data = res.ok ? await res.json().catch(() => null) : null;
          const list: GlobalSearchResult[] = Array.isArray(data?.results)
            ? data.results
            : Array.isArray(data)
              ? data
              : [];
          if (!cancelled) setGlobalResults(list);
        } catch {
          if (!cancelled) setGlobalResults([]);
        } finally {
          if (!cancelled) setGlobalLoading(false);
        }
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [globalQuery, globalSearchOpen, resolvedCurrentUser?.id]);
  const rememberSearch = (q: string) => {
    const clean = q.trim();
    if (!clean) return;
    setRecentSearches((prev) => {
      const next = [clean, ...prev.filter((s) => s.toLowerCase() !== clean.toLowerCase())].slice(0, 8);
      try {
        localStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };
  const clearRecentSearches = () => {
    setRecentSearches([]);
    try {
      localStorage.removeItem(RECENT_SEARCH_KEY);
    } catch {
      /* ignore */
    }
  };
  const groupedGlobalResults = useMemo(() => {
    const groups = new Map<string, GlobalSearchResult[]>();
    for (const r of globalResults) {
      const list = groups.get(r.roomId) || [];
      list.push(r);
      groups.set(r.roomId, list);
    }
    return Array.from(groups.entries());
  }, [globalResults]);
  const highlightSnippet = (text: string, q: string): React.ReactNode => {
    const query = q.trim();
    if (!query) return text;
    const lower = text.toLowerCase();
    const needle = query.toLowerCase();
    const parts: React.ReactNode[] = [];
    let idx = 0;
    let pos = lower.indexOf(needle, idx);
    let k = 0;
    while (pos > -1) {
      if (pos > idx) parts.push(<React.Fragment key={k++}>{text.slice(idx, pos)}</React.Fragment>);
      parts.push(
        <mark key={k++} className="bg-bubble-in text-inherit rounded px-0.5">
          {text.slice(pos, pos + query.length)}
        </mark>
      );
      idx = pos + query.length;
      pos = lower.indexOf(needle, idx);
    }
    if (idx < text.length) parts.push(<React.Fragment key={k++}>{text.slice(idx)}</React.Fragment>);
    return parts.length ? parts : text;
  };

  // ── Phase 1.4.6 find people (directory search, no browsable directory) ──
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [peopleQuery, setPeopleQuery] = useState('');
  const [peopleResults, setPeopleResults] = useState<User[]>([]);
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [peopleSearched, setPeopleSearched] = useState(false);
  useEffect(() => {
    const q = peopleQuery.trim();
    if (!peopleOpen || !q) {
      setPeopleResults([]);
      setPeopleSearched(false);
      setPeopleLoading(false);
      return;
    }
    setPeopleLoading(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const byId = new Map<string, User>();
        // Local people: exact @username or name-prefix matches.
        const needle = q.replace(/^@/, '').toLowerCase();
        for (const u of users) {
          if (resolvedCurrentUser && u.id === resolvedCurrentUser.id) continue;
          const username = (u.username || '').toLowerCase();
          if (username === needle || u.name.toLowerCase().startsWith(needle)) byId.set(u.id, u);
        }
        // Server directory: exact @username (case-insensitive) + name prefix.
        try {
          const found: DirectoryUser[] = await searchUsers(q);
          for (const d of found) {
            if (resolvedCurrentUser && d.id === resolvedCurrentUser.id) continue;
            if (!byId.has(d.id)) {
              const local = users.find((u) => u.id === d.id);
              byId.set(d.id, {
                id: d.id,
                name: d.name,
                username: d.username,
                avatar: d.avatar || local?.avatar || '',
                status: d.mood || local?.status || '',
                online: local?.online ?? false,
                presence: local?.presence ?? 'offline',
                lastSeen: local?.lastSeen,
                ...({ about: d.about, privacy: d.privacy } as Partial<User>),
              } as User);
            }
          }
        } catch {
          /* directory unreachable — local matches still shown */
        }
        if (!cancelled) {
          setPeopleResults(Array.from(byId.values()).slice(0, 12));
          setPeopleSearched(true);
          setPeopleLoading(false);
        }
      })();
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [peopleQuery, peopleOpen, users, resolvedCurrentUser]);
  const handlePersonTap = (person: User) => {
    if (onOpenProfileCard) onOpenProfileCard(person);
    else onSelectChat(person.id, true, person);
  };

  // ── Phase 1.5 (roadmap 1.5) join group by invite link ──────────────────
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinInput, setJoinInput] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joinLoading, setJoinLoading] = useState(false);
  const openJoinDialog = () => {
    setJoinError(null);
    setJoinOpen(true);
  };
  const closeJoinDialog = () => {
    if (joinLoading) return;
    setJoinOpen(false);
    setJoinError(null);
  };
  const handleJoinGroup = async () => {
    const code = extractInviteCode(joinInput);
    if (!code) {
      setJoinError(
        lang === 'bn' ? 'ইনভাইট লিংক বা কোড দিন' : 'Invalid or revoked invite link'
      );
      return;
    }
    setJoinLoading(true);
    setJoinError(null);
    try {
      const headers = await authHeaders(resolvedCurrentUser?.id);
      const res = await fetch('/api/channels/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ code }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setJoinError(
          lang === 'bn' ? 'অবৈধ বা বাতিল করা ইনভাইট লিংক' : 'Invalid or revoked invite link'
        );
        return;
      }
      if (data?.pending) {
        setJoinOpen(false);
        setJoinInput('');
        if (onJoinPending) onJoinPending();
        else
          onShowToast?.(
            lang === 'bn'
              ? 'যোগদানের অনুরোধ পাঠানো হয়েছে — অনুমোদনের অপেক্ষায়'
              : 'Join request sent — waiting for approval'
          );
        return;
      }
      const channel: Channel | null =
        data?.channel && typeof data.channel === 'object'
          ? (data.channel as Channel)
          : data && typeof data.id === 'string'
            ? (data as Channel)
            : null;
      if (!channel) {
        setJoinError(
          lang === 'bn' ? 'অবৈধ বা বাতিল করা ইনভাইট লিংক' : 'Invalid or revoked invite link'
        );
        return;
      }
      onJoinChannel?.(channel);
      setJoinOpen(false);
      setJoinInput('');
      onShowToast?.(
        lang === 'bn' ? `'${channel.name}'-এ যোগ দিয়েছেন` : `Joined ${channel.name}`
      );
    } catch {
      setJoinError(
        lang === 'bn' ? 'অবৈধ বা বাতিল করা ইনভাইট লিংক' : 'Invalid or revoked invite link'
      );
    } finally {
      setJoinLoading(false);
    }
  };

  // ── Phase 1.8 Saved Messages panel (hashtags + group-by-source) ─────────
  const [savedTag, setSavedTag] = useState<string | null>(null);
  const [savedGroupBySource, setSavedGroupBySource] = useState(false);
  const savedMessages = useMemo(
    () => (messages || []).filter((m) => m.roomId === 'saved_messages' && !m.deletedAt),
    [messages]
  );
  const savedTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of savedMessages) {
      const tags = new Set((m.content || '').match(/#[\p{L}\p{N}_-]+/gu) || []);
      for (const t of tags) counts.set(t, (counts.get(t) || 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [savedMessages]);
  const savedSourceOf = useCallback(
    (m: ChatMessage): string => {
      const extra = m as ChatMessage & { sourceRoomName?: string; sourceRoomId?: string; reminderRef?: { roomId: string } };
      if (extra.sourceRoomName) return extra.sourceRoomName;
      const roomId = extra.sourceRoomId || extra.reminderRef?.roomId;
      if (roomId) {
        const ch = channels.find((c) => c.id === roomId);
        if (ch) return ch.name;
        const peer = users.find((u) => u.id === roomId);
        if (peer) return peer.name;
      }
      return m.forwardedFrom || m.senderName || (lang === 'bn' ? 'নোট' : 'Note');
    },
    [channels, users, lang]
  );
  const visibleSavedMessages = useMemo(() => {
    if (!savedTag) return savedMessages;
    return savedMessages.filter((m) => (m.content || '').includes(savedTag));
  }, [savedMessages, savedTag]);
  const groupedSavedMessages = useMemo(() => {
    if (!savedGroupBySource) return null;
    const groups = new Map<string, ChatMessage[]>();
    for (const m of visibleSavedMessages) {
      const key = savedSourceOf(m);
      const list = groups.get(key) || [];
      list.push(m);
      groups.set(key, list);
    }
    return Array.from(groups.entries());
  }, [visibleSavedMessages, savedGroupBySource, savedSourceOf]);

  // FAB Dragging & Positioning State (User requested: can move up/down/side so pin icon is never covered!)
  const [fabBottomOffset, setFabBottomOffset] = useState<number>(20); // bottom in px
  const [fabSide, setFabSide] = useState<'right' | 'left'>('right');
  const [isDraggingFab, setIsDraggingFab] = useState<boolean>(false);
  const dragStartYRef = useRef<number>(0);
  const dragStartOffsetRef = useRef<number>(20);

  const handleFabPointerDown = (e: React.PointerEvent) => {
    setIsDraggingFab(true);
    dragStartYRef.current = e.clientY;
    dragStartOffsetRef.current = fabBottomOffset;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handleFabPointerMove = (e: React.PointerEvent) => {
    if (!isDraggingFab) return;
    const deltaY = dragStartYRef.current - e.clientY; // pulling up increases bottom offset
    const newOffset = Math.max(16, Math.min(320, dragStartOffsetRef.current + deltaY));
    setFabBottomOffset(newOffset);
  };

  const handleFabPointerUp = (e: React.PointerEvent) => {
    setIsDraggingFab(false);
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  // Toggle side if user double clicks or clicks side toggle
  const toggleFabSide = () => {
    setFabSide((prev) => (prev === 'right' ? 'left' : 'right'));
  };

  // Filter channels based on filter chip & search query (archived chats live in their own view)
  // DM vs group signal used across the codebase: Channel.isGroup (true = group/channel, falsy = DM).
  const filteredChannels = channels.filter((c) => {
    if (showArchived ? !c.isArchived : c.isArchived) return false;
    const matchesFilter = activeList
      ? activeList.channelIds.includes(c.id)
      : activeFilter === 'all' ||
        (activeFilter === 'unread' && (c.unreadCount ?? 0) > 0) ||
        (activeFilter === 'groups' && !!c.isGroup) ||
        (activeFilter === 'personal' && !c.isGroup);

    const q = searchQuery.replace(/^@/, '').toLowerCase();
    // DM channels also match the peer's username (new optional User field; defensive for old data)
    const dmPeer = !c.isGroup ? users.find((u) => u.id === c.id) : undefined;
    const peerUsername = dmPeer ? String((dmPeer as unknown as { username?: unknown }).username || '') : '';
    // 1.9.9 quick win: also match channel description + DM peer name
    const matchesQuery =
      !q ||
      c.name.toLowerCase().includes(q) ||
      (c.description && c.description.toLowerCase().includes(q)) ||
      (c.lastMessage && c.lastMessage.toLowerCase().includes(q)) ||
      (dmPeer && dmPeer.name.toLowerCase().includes(q)) ||
      (peerUsername && peerUsername.toLowerCase().includes(q));

    return matchesFilter && matchesQuery;
  });

  // Recency sort (0.5): newest last-message first, applied at render so any
  // data-source order is corrected. Falls back to createdAt when a channel
  // has no last-message timestamp yet.
  const sortedChannels = [...filteredChannels].sort((a, b) => {
    const ta = a.lastMessageTimestamp || a.createdAt || 0;
    const tb = b.lastMessageTimestamp || b.createdAt || 0;
    return tb - ta;
  });

  // Dynamic Pinned Chats (any chat marked isPinned: true).
  // Choice: pinned grid is filtered consistently with the main list — it is
  // derived from sortedChannels, so search text + active filter chip +
  // archived view all apply to pinned chats in exactly the same way.
  // Phase 1.8: pinned chats render ONLY in this grid — the main list below
  // excludes them (mainListChannels) so a pinned chat never appears twice.
  // Phase 2: the pinned grid is capped at 5 — any further pinned chats
  // stay visible in the main list below (with their pin indicator)
  // instead of growing the grid without bound or vanishing entirely.
  const pinnedChannels = sortedChannels.filter((c) => c.isPinned).slice(0, 5);
  const pinnedGridIds = new Set(pinnedChannels.map((c) => c.id));
  const mainListChannels = sortedChannels.filter((c) => !pinnedGridIds.has(c.id));

  // One row of the Saved Messages panel (Phase 1.8).
  const SavedEntryRow: React.FC<{ m: ChatMessage }> = ({ m }) => (
    <button
      onClick={() => (onJumpToMessage ? onJumpToMessage('saved_messages', m.id) : onSelectChat('saved_messages', false))}
      className="w-full text-left px-2 py-1.5 rounded-xl hover:bg-pressed transition-colors block"
    >
      <span className="block text-xs font-semibold text-app truncate bn-safe">{m.senderName}</span>
      <span className="block text-xs text-app-2 truncate bn-safe">
        {m.type === 'text' ? m.content : `[${m.type}] ${m.fileName || ''}`}
      </span>
    </button>
  );

  // Helper to get presence of recipient in DM using accurate decay
  const getUserPresence = (channel: Channel) => {
    if (channel.isGroup) return null;
    const user = users.find((u) => u.id === channel.id);
    if (!user) return null;
    return getEffectiveUserPresence(user);
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-app text-app overflow-hidden relative select-none">
      {/* Clean Top Header — Phase 2 per-surface map: SOLID / near-solid
          (bg-header), never glass: a glass sticky header re-filters its
          backdrop on every scroll frame. */}
      <div className="pt-4 pb-2 px-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3 bg-header">
        <div className="min-w-0">
          <h1 className="text-[28px] font-bold tracking-tight text-app flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-primary shrink-0" />
            <span className="truncate bn-safe">চিঠি · Chitthi</span>
          </h1>
        </div>

        {/* Header Actions */}
        <div className="flex items-center gap-0.5 sm:gap-2 shrink-0 w-full sm:w-auto justify-between sm:justify-normal">
          {/* Global search (Phase 1.9.1): opens the message search modal.
              Ctrl/Cmd+K opens it too. The inline input below still filters
              the chat list by name. */}
          <button
            onClick={() => setGlobalSearchOpen(true)}
            className="h-11 w-11 flex items-center justify-center shrink-0 text-app-2 hover:text-primary rounded-full hover:bg-pressed transition-colors"
            title={lang === 'bn' ? 'সব মেসেজে খুঁজুন (Ctrl+K)' : 'Search all messages (Ctrl+K)'} aria-label={lang === 'bn' ? 'সব মেসেজে খুঁজুন (Ctrl+K)' : 'Search all messages (Ctrl+K)'}
          >
            <Search className="w-5 h-5" />
          </button>

          {/* Find people (Phase 1.4.6) */}
          <button
            onClick={() => setPeopleOpen((v) => !v)}
            className={`h-11 w-11 flex items-center justify-center shrink-0 rounded-full hover:bg-pressed transition-colors ${
              peopleOpen ? 'text-primary' : 'text-app-2 hover:text-primary'
            }`}
            title={lang === 'bn' ? 'মানুষ খুঁজুন' : 'Find people'} aria-label={lang === 'bn' ? 'মানুষ খুঁজুন' : 'Find people'}
           aria-expanded={peopleOpen} >
            <UserPlus className="w-5 h-5" />
          </button>

          {/* Join group by invite link (Phase 1.5 / roadmap 1.5) */}
          <button
            onClick={openJoinDialog}
            className="h-11 w-11 flex items-center justify-center shrink-0 text-app-2 hover:text-primary rounded-full hover:bg-pressed transition-colors"
            title={lang === 'bn' ? 'ইনভাইট লিংক দিয়ে গ্রুপে যোগ দিন' : 'Join group'} aria-label={lang === 'bn' ? 'ইনভাইট লিংক দিয়ে গ্রুপে যোগ দিন' : 'Join group'}
          >
            <Link2 className="w-5 h-5" />
          </button>

          {/* Dark Mode Toggle */}
          <button
            onClick={onToggleDarkMode}
            className="h-11 w-11 flex items-center justify-center shrink-0 text-app-2 hover:text-primary rounded-full hover:bg-pressed transition-colors"
            title={isDarkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode'} aria-label={isDarkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
           aria-pressed={isDarkMode} >
            {isDarkMode ? <Sun className="w-5 h-5 text-away" /> : <Moon className="w-5 h-5 text-primary" />}
          </button>

          {/* Language Toggle */}
          <button
            onClick={onToggleLang}
            className="flex items-center gap-1 min-h-[44px] px-3 py-1 text-xs font-semibold text-app-2 hover:text-primary rounded-full hover:bg-pressed transition-colors"
            title="Toggle Language" aria-label="Toggle Language"
          >
            <Globe className="w-3.5 h-3.5" />
            <span className="hidden min-[420px]:inline">{lang === 'bn' ? 'বাং' : 'EN'}</span>
          </button>

          {/* Current user's own avatar + presence picker (Phase 1.4.8).
              Invisible still receives everything — it only appears offline
              to others (server-side, contract v2). */}
          {resolvedCurrentUser && (
            <div className="flex items-center gap-1.5 shrink-0">
              <div className="relative shrink-0">
                <img
                  src={resolvedCurrentUser.avatar || initialsAvatarDataUrl(resolvedCurrentUser.name)}
                  alt={resolvedCurrentUser.name}
                  title={resolvedCurrentUser.name}
                  className="w-10 h-10 rounded-full object-cover bg-surface shrink-0"
                />
                <span
                  className={`absolute bottom-0 right-0 w-3 h-3 rounded-full ring-2 ring-[var(--c-bg)] ${
                    presenceMode === 'online'
                      ? 'bg-online'
                      : presenceMode === 'away'
                        ? 'bg-away'
                        : 'bg-[var(--c-text-faint)]'
                  }`}
                />
              </div>
              <select
                value={presenceMode}
                onChange={(e) => handlePresenceChange(e.target.value as PresenceMode)}
                className="text-[11px] font-semibold bg-surface text-app-2 rounded-full pl-2 pr-1 py-1 min-h-[44px] max-w-[80px] cursor-pointer"
                title={lang === 'bn' ? 'আপনার উপস্থিতি' : 'Your presence'}
               aria-label={lang === 'bn' ? 'আপনার উপস্থিতি' : 'Your presence'} >
                <option value="online">{lang === 'bn' ? 'অনলাইন' : 'Online'}</option>
                <option value="away">{lang === 'bn' ? 'দূরে' : 'Away'}</option>
                <option value="invisible">{lang === 'bn' ? 'অদৃশ্য' : 'Invisible'}</option>
              </select>
            </div>
          )}
        </div>
      </div>

      {/* Find people panel (Phase 1.4.6): directory search by exact
          @username or name prefix. There is deliberately NO browsable
          directory — an exact handle always works. */}
      {peopleOpen && (
        <div className="px-4 pb-2 animate-in fade-in">
          <div className="rounded-[var(--r-card)] bg-surface p-3 space-y-2">
            <div className="relative">
              <UserPlus className="w-4 h-4 text-app-faint absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={peopleQuery}
                onChange={(e) => setPeopleQuery(e.target.value)}
                placeholder={lang === 'bn' ? '@username বা নাম দিয়ে খুঁজুন...' : 'Search by @username or name...'} aria-label={lang === 'bn' ? '@username বা নাম দিয়ে খুঁজুন...' : 'Search by @username or name...'}
                className="w-full bg-app border-0 rounded-full pl-9 pr-9 py-2 text-base text-app placeholder:text-app-faint "
                autoFocus
              />
              {peopleQuery && (
                <button
                  onClick={() => setPeopleQuery('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-app-faint hover:text-app-2"
                 aria-label={lang === 'bn' ? 'খোঁজ মুছুন' : 'Clear search'} >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            <p className="text-[11px] text-app-faint px-1">
              {lang === 'bn'
                ? 'কোনো খোলা তালিকা নেই — সঠিক @username দিলে সবসময় পাওয়া যাবে।'
                : 'No browsable directory — an exact @username always works.'}
            </p>
            {peopleLoading && (
              <p className="text-xs text-app-faint px-1 py-1">{lang === 'bn' ? 'খোঁজা হচ্ছে...' : 'Searching...'}</p>
            )}
            {!peopleLoading &&
              peopleResults.map((person) => (
                <button
                  key={person.id}
                  onClick={() => handlePersonTap(person)}
                  className="w-full flex items-center gap-3 px-2 py-2 rounded-xl hover:bg-pressed transition-colors text-left"
                >
                  <img
                    src={person.avatar || initialsAvatarDataUrl(person.name)}
                    alt={person.name}
                    className="w-10 h-10 rounded-full object-cover bg-pressed shrink-0"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-app truncate bn-safe">{person.name}</span>
                    <span className="block text-xs text-app-faint truncate bn-safe">
                      {person.username ? `@${person.username}` : ''}
                      {(person as User & { about?: string }).about
                        ? `${person.username ? ' · ' : ''}${(person as User & { about?: string }).about}`
                        : ''}
                    </span>
                  </span>
                </button>
              ))}
            {!peopleLoading && peopleSearched && peopleResults.length === 0 && (
              <p className="text-xs text-app-faint px-1 py-1">
                {lang === 'bn'
                  ? `'${peopleQuery.trim()}' নামে কাউকে পাওয়া যায়নি`
                  : `No one found for '${peopleQuery.trim()}'`}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Search row — compact চিঠি wordmark (owner's favourite, restored
          Mega round) at the LEFT of the search pill; the pill takes flex-1.
          Bangla gets line-height 1.5 + vertical padding so the matra can
          never clip (bn-text class AND inline style, belt and braces). */}
      {showSearchInput && (
        <div className="px-4 pb-2 animate-in fade-in flex items-center gap-2.5">
          <div className="flex items-center gap-1 shrink-0 py-1">
            <span style={{ lineHeight: 1.5 }} className="bn-text font-bold text-[15px] text-[#15211B] dark:text-[#EDF3EF]">চিঠি</span>
            <span className="w-1 h-1 rounded-full bg-[#F2A007] shrink-0" aria-hidden="true" />
            <span className="text-[9px] font-semibold tracking-[0.18em] text-[#5C6B62] dark:text-[#9DB0A5]">CHITTHI</span>
          </div>
          <div className="relative flex-1 min-w-0">
            <Search className="w-4 h-4 text-app-faint absolute left-4 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={lang === 'bn' ? 'নাম দিয়ে চ্যাট খুঁজুন...' : 'Search chats by name...'} aria-label={lang === 'bn' ? 'নাম দিয়ে চ্যাট খুঁজুন...' : 'Search chats by name...'}
              className="w-full bg-bubble-in border-0 rounded-full pl-11 pr-10 py-2.5 text-base text-app placeholder:text-app-faint "
              autoFocus
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-app-faint hover:text-app-2"
               aria-label={lang === 'bn' ? 'খোঁজ মুছুন' : 'Clear search'} >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Filter Chips Row — All / Unread / Groups / Personal + custom lists
          (Phase 1.9.6). Active = solid emerald pill (bg-primary,
          Mega-round palette); inactive = surface. Selecting a built-in chip clears the
          active list and vice versa. */}
      <div className="flex items-center px-4 py-2 gap-2 overflow-x-auto no-scrollbar shrink-0">
        {(
          [
            { key: 'all', bn: 'সব', en: 'All' },
            { key: 'unread', bn: 'অপঠিত', en: 'Unread' },
            { key: 'groups', bn: 'গ্রুপ', en: 'Groups' },
            { key: 'personal', bn: 'ব্যক্তিগত', en: 'Personal' },
          ] as const
        ).map((chip) => (
          <button
            key={chip.key}
            onClick={() => {
              setActiveFilter(chip.key);
              setActiveListId(null);
            }}
            className={`min-h-11 px-3 py-1.5 rounded-full text-[13px] font-semibold whitespace-nowrap transition-all bn-safe inline-flex items-center ${
              !activeList && activeFilter === chip.key ? 'bg-primary text-white shadow-soft' : 'bg-surface text-app-2 hover:bg-pressed'
            }`}
           aria-pressed={activeFilter === chip.key} >
            {lang === 'bn' ? chip.bn : chip.en}
          </button>
        ))}
        {lists.map((list) => {
          const unread = listUnreadCount(list);
          return (
            <button
              key={list.id}
              onClick={() => setActiveListId(list.id)}
              className={`min-h-11 px-3 py-1.5 rounded-full text-[13px] font-semibold whitespace-nowrap transition-all bn-safe flex items-center gap-1.5 ${
                activeListId === list.id ? 'bg-primary text-white shadow-soft' : 'bg-surface text-app-2 hover:bg-pressed'
              }`}
             aria-pressed={activeListId === list.id} >
              <span>{list.name}</span>
              {unread > 0 && (
                <span className="min-w-4 h-4 px-1 rounded-full bg-[#F2A007] text-[#15211B] text-[10px] font-bold flex items-center justify-center">
                  {unread}
                </span>
              )}
            </button>
          );
        })}
        <button
          onClick={() => {
            const name = window.prompt(lang === 'bn' ? 'নতুন তালিকার নাম:' : 'Name for the new list:');
            if (name) createList(name);
          }}
          className="min-h-11 px-3 py-1.5 rounded-full text-[13px] font-semibold whitespace-nowrap bg-surface text-primary hover:bg-pressed transition-all flex items-center gap-1"
          title={lang === 'bn' ? 'নতুন তালিকা তৈরি করুন' : 'Create a new list'} aria-label={lang === 'bn' ? 'নতুন তালিকা তৈরি করুন' : 'Create a new list'}
        >
          <ListPlus className="w-3.5 h-3.5" />
          <span>{lang === 'bn' ? 'তালিকা' : 'List'}</span>
        </button>
      </div>

      {/* Active list management (rename / delete) */}
      {activeList && (
        <div className="flex items-center gap-2 px-4 pb-1 shrink-0">
          <span className="text-[11px] font-semibold text-app-faint truncate">
            {lang === 'bn' ? 'তালিকা:' : 'List:'} {activeList.name} ({activeList.channelIds.length})
          </span>
          <button
            onClick={() => {
              const name = window.prompt(lang === 'bn' ? 'তালিকার নতুন নাম:' : 'Rename list:', activeList.name);
              if (name && name.trim()) {
                setLists((prev) => prev.map((l) => (l.id === activeList.id ? { ...l, name: name.trim() } : l)));
              }
            }}
            className="text-[11px] font-semibold text-primary hover:underline flex items-center gap-0.5"
          >
            <Pencil className="w-3 h-3" /> {lang === 'bn' ? 'নাম বদলান' : 'Rename'}
          </button>
          <button
            onClick={() => {
              if (window.confirm(lang === 'bn' ? `'${activeList.name}' তালিকাটি মুছে ফেলবেন?` : `Delete the list '${activeList.name}'?`)) {
                setLists((prev) => prev.filter((l) => l.id !== activeList.id));
                setActiveListId(null);
              }
            }}
            className="text-[11px] font-semibold text-danger hover:underline flex items-center gap-0.5"
          >
            <Trash2 className="w-3 h-3" /> {lang === 'bn' ? 'মুছুন' : 'Delete'}
          </button>
          <span className="text-[11px] text-app-faint">
            {lang === 'bn' ? 'চ্যাটে ডান-ক্লিক/লং-প্রেস করে তালিকায় যোগ করুন' : 'Right-click / long-press a chat to add it'}
          </span>
        </div>
      )}

      {/* Main Scrollable Chat List with Generous pb-32 so pin icons are NEVER obscured! */}
      <div className="flex-1 overflow-y-auto bg-app px-2 py-2 pb-32 space-y-4">
        {/* Mega round: pinned AI Assistant entry — the very top of the
            chat list, above Stories and the Pinned Chats section. Only
            rendered when App wires onOpenAI. */}
        {onOpenAI && (
          <button
            type="button"
            onClick={onOpenAI}
            className="w-full min-h-[56px] flex items-center gap-3 px-3 py-2 rounded-[var(--r-card)] bg-surface hover:bg-pressed active:bg-pressed transition-colors text-left"
            aria-label={lang === 'bn' ? 'AI Assistant — যেকোনো কিছু জিজ্ঞেস করুন' : 'AI Assistant — Ask me anything'}
          >
            <span className="w-12 h-12 rounded-full bg-[#F2A007]/15 flex items-center justify-center shrink-0">
              <Sparkles className="w-6 h-6 text-[#F2A007]" />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-base font-semibold text-app truncate bn-safe">AI Assistant</span>
              <span className="block text-sm text-app-2 truncate bn-safe">
                {lang === 'bn' ? 'যেকোনো কিছু জিজ্ঞেস করুন' : 'Ask me anything'}
              </span>
            </span>
            <ChevronRight className="w-5 h-5 text-app-2 shrink-0" />
          </button>
        )}

        {/* Stories / Status row (WhatsApp-style, self-contained).
            Phase 1.1 wiring: story replies forward to App's handleStoryReply. */}
        {resolvedCurrentUser && (
          <StoriesBar currentUser={resolvedCurrentUser} users={users} lang={lang} onReplyToStory={onStoryReply} />
        )}

        {/* Saved Messages panel (Phase 1.8): shown while the Saved room is
            open — #hashtag filter row + group-by-source-chat toggle over
            this device's saved items. */}
        {activeRoomId === 'saved_messages' && (
          <div className="mx-2 rounded-[var(--r-card)] bg-surface p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] font-semibold text-app flex items-center gap-1.5">
                <Hash className="w-3.5 h-3.5 text-app-faint" />
                {lang === 'bn' ? 'সেভ করা মেসেজ' : 'Saved Messages'}
                <span className="text-[11px] text-app-faint">({visibleSavedMessages.length})</span>
              </span>
              <button
                onClick={() => setSavedGroupBySource((v) => !v)}
                className={`px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors ${
                  savedGroupBySource ? 'bg-primary text-white shadow-soft' : 'bg-pressed text-app-2 hover:text-app'
                }`}
               aria-pressed={savedGroupBySource} >
                {lang === 'bn' ? 'সোর্স চ্যাট অনুযায়ী' : 'By source chat'}
              </button>
            </div>
            {savedTags.length > 0 && (
              <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
                <button
                  onClick={() => setSavedTag(null)}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-semibold whitespace-nowrap transition-colors ${
                    savedTag === null ? 'bg-primary text-white shadow-soft' : 'bg-pressed text-app-2'
                  }`}
                 aria-pressed={savedTag === null} >
                  {lang === 'bn' ? 'সব' : 'All'}
                </button>
                {savedTags.map(([tag, count]) => (
                  <button
                    key={tag}
                    onClick={() => setSavedTag((cur) => (cur === tag ? null : tag))}
                    className={`px-2.5 py-1 rounded-full text-[11px] font-semibold whitespace-nowrap transition-colors ${
                      savedTag === tag ? 'bg-primary text-white shadow-soft' : 'bg-pressed text-app-2'
                    }`}
                   aria-pressed={savedTag === tag} >
                    {tag} · {count}
                  </button>
                ))}
              </div>
            )}
            <div className="max-h-56 overflow-y-auto space-y-1">
              {visibleSavedMessages.length === 0 && (
                <p className="text-xs text-app-faint px-1 py-2">
                  {savedTag
                    ? lang === 'bn'
                      ? `'${savedTag}' দিয়ে কোনো সেভ করা মেসেজ নেই`
                      : `No saved messages tagged '${savedTag}'`
                    : lang === 'bn'
                      ? 'এখনো কিছু সেভ করা হয়নি'
                      : 'Nothing saved yet'}
                </p>
              )}
              {groupedSavedMessages
                ? groupedSavedMessages.map(([source, items]) => (
                    <div key={source} className="space-y-1">
                      <p className="text-[11px] font-bold text-app-faint uppercase tracking-wide px-1 pt-1.5">{source}</p>
                      {items.map((m) => (
                        <SavedEntryRow key={m.id} m={m} />
                      ))}
                    </div>
                  ))
                : visibleSavedMessages.map((m) => <SavedEntryRow key={m.id} m={m} />)}
            </div>
          </div>
        )}
        {/* Archived chats entry (WhatsApp-style) */}
        {(archivedCount > 0 || showArchived) && (
          <button
            onClick={() => setShowArchived(!showArchived)}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-[var(--r-card)] bg-surface hover:bg-pressed transition-all text-left"
           aria-expanded={showArchived} >
            <span className="p-2 rounded-full bg-pressed text-app-2">
              <Archive className="w-4 h-4" />
            </span>
            <span className="flex-1 text-sm font-semibold text-app">
              {showArchived ? (lang === 'bn' ? 'সব চ্যাটে ফিরুন' : 'Back to all chats') : lang === 'bn' ? 'আর্কাইভ করা' : 'Archived'}
            </span>
            {!showArchived && <span className="text-xs font-semibold text-app-faint">{archivedCount}</span>}
            {!showArchived && archivedUnreadCount > 0 && (
              <span
                className="min-w-5 h-5 px-1.5 rounded-full bg-[#F2A007] text-[#15211B] font-semibold text-[11px] flex items-center justify-center"
                title={lang === 'bn' ? 'আর্কাইভে অপঠিত মেসেজ' : 'Unread in archived chats'}
              >
                {archivedUnreadCount}
              </span>
            )}
          </button>
        )}
        {/* Phase 2: initial-mount skeleton replaces the list region until
            the first data render commits (isLoading, first rAF). */}
        {isLoading ? (
          <ChatsSkeleton />
        ) : (
          <>
        {/* Phase 2: designed empty state when there are no chats at all
            (the list-search no-match state further down stays separate).
            Primary action opens the existing find-people flow; the
            secondary action is the existing new-group flow. */}
        {!showArchived && channels.length === 0 && !searchQuery.trim() && (
          <div className="flex flex-col items-center justify-center text-center px-6 py-12 space-y-3">
            <span className="p-4 rounded-full bg-surface text-app-faint">
              <MessageSquare className="w-7 h-7" />
            </span>
            <p className="text-base font-semibold text-app bn-safe">
              {lang === 'bn' ? 'এখনো কোনো চ্যাট নেই' : 'No chats yet'}
            </p>
            <p className="text-sm text-app-2 bn-safe max-w-[260px]">
              {lang === 'bn'
                ? '@username দিয়ে কাউকে খুঁজে প্রথম কথোপকথন শুরু করুন'
                : 'Find someone by @username and start your first conversation'}
            </p>
            <button
              onClick={() => setPeopleOpen(true)}
              className="min-h-[44px] px-5 rounded-full bg-primary text-white text-sm font-semibold hover:opacity-90 transition-opacity flex items-center gap-2"
            >
              <UserPlus className="w-4 h-4" />
              {lang === 'bn' ? 'মানুষ খুঁজুন' : 'Find people'}
            </button>
            <button
              onClick={onOpenNewCategory}
              className="min-h-[44px] px-2 text-xs font-semibold text-primary hover:underline flex items-center"
            >
              {lang === 'bn' ? 'অথবা নতুন গ্রুপ তৈরি করুন' : 'Or create a new group'}
            </button>
          </div>
        )}
        {/* Dynamic Pinned Chats Grid — filtered consistently with the main list (see pinnedChannels) */}
        {pinnedChannels.length > 0 && (
          <div className="space-y-2 px-2">
            <div className="flex items-center justify-between px-1">
              <span className="text-[13px] font-semibold text-app-2 tracking-tight flex items-center gap-1.5">
                <Pin className="w-3.5 h-3.5 text-app-faint" />
                <span>{lang === 'bn' ? 'পিন করা চ্যাট' : 'Pinned Chats'}</span>
                <span className="text-[11px] text-app-faint">({pinnedChannels.length})</span>
              </span>
              <button
                onClick={onOpenNewCategory}
                className="text-[11px] font-semibold text-primary hover:underline"
              >
                {lang === 'bn' ? '+ নতুন গ্রুপ/ক্যাটাগরি' : '+ New Group / Category'}
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              {pinnedChannels.map((card) => {
                const cardDraft = getDraftFor(card.id);
                const cardMuted = isEffectivelyMuted(card);
                return (
                <div
                  key={card.id}
                  onClick={() => handleRowClick(card)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    openCtxMenu(card, e.clientX, e.clientY);
                  }}
                  onPointerDown={(e) => startLongPress(card, e.clientX, e.clientY)}
                  onPointerUp={cancelLongPress}
                  onPointerLeave={cancelLongPress}
                  className="p-3 bg-surface rounded-[var(--r-card)] shadow-soft hover:bg-pressed transition-all cursor-pointer flex items-center justify-between group relative"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <img
                      src={card.avatar || initialsAvatarDataUrl(card.name)}
                      alt={card.name}
                      className="w-9 h-9 rounded-full bg-pressed object-cover shrink-0"
                    />
                    <div className="min-w-0 pr-5">
                      <p className="text-xs font-semibold text-app truncate bn-safe group-hover:text-primary transition-colors">
                        {card.name}
                      </p>
                      {cardDraft ? (
                        <p className="text-[11px] text-app-2 truncate bn-safe italic">
                          <span className="font-semibold text-primary">Draft:</span> {cardDraft}
                        </p>
                      ) : (
                        <p className={`text-[11px] text-app-2 truncate bn-safe ${cardMuted ? 'opacity-50' : ''}`}>
                          {card.lastMessage || 'Open chat'}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Unpin Button on Hover */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onTogglePin(card.id);
                    }}
                    className="absolute top-2.5 right-2.5 p-1 rounded-md text-app-faint hover:text-danger hover:bg-pressed opacity-60 group-hover:opacity-100 transition-all"
                    title="Unpin this chat" aria-label="Unpin this chat"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Empty-results state for search (0.10): a no-match query must not render a blank list */}
        {searchQuery.trim() && sortedChannels.length === 0 && (
          <div className="flex flex-col items-center justify-center text-center px-6 py-12 space-y-2">
            <span className="p-3 rounded-full bg-surface text-app-faint">
              <Search className="w-5 h-5" />
            </span>
            <p className="text-sm font-semibold text-app bn-safe">
              {lang === 'bn'
                ? `'${searchQuery.trim()}'-এর জন্য কোনো চ্যাট পাওয়া যায়নি`
                : `No chats found for '${searchQuery.trim()}'`}
            </p>
            <p className="text-xs text-app-faint bn-safe">
              {lang === 'bn' ? 'অন্য নাম দিয়ে খুঁজে দেখুন' : 'Try searching with a different name'}
            </p>
            <button
              onClick={() => setSearchQuery('')}
              className="text-xs font-semibold text-primary hover:underline pt-1"
            >
              {lang === 'bn' ? 'খোঁজ পরিষ্কার করুন' : 'Clear search'}
            </button>
          </div>
        )}

        {/* Regular Chat Items List — recency-sorted (see sortedChannels).
            Phase 1.8: pinned chats are excluded here (grid-only) and rows
            carry the long-press / right-click context menu. */}
        <div className="space-y-1">
          {mainListChannels.map((channel) => {
            const isActive = activeRoomId === channel.id;
            const presence = getUserPresence(channel);
            const draft = getDraftFor(channel.id);
            const mutedNow = isEffectivelyMuted(channel);

            return (
              <div
                key={channel.id}
                onClick={() => handleRowClick(channel)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openCtxMenu(channel, e.clientX, e.clientY);
                }}
                onPointerDown={(e) => startLongPress(channel, e.clientX, e.clientY)}
                onPointerUp={cancelLongPress}
                onPointerLeave={cancelLongPress}
                className={`px-4 py-2 min-h-[68px] rounded-2xl flex items-center justify-between transition-all cursor-pointer group bg-app ${
                  isActive ? 'bg-pressed' : 'hover:bg-pressed active:bg-pressed'
                }`}
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <div className="relative shrink-0">
                    <img
                      src={channel.avatar || initialsAvatarDataUrl(channel.name)}
                      alt={channel.name}
                      className="w-[52px] h-[52px] rounded-full bg-surface object-cover"
                    />

                    {channel.isGroup ? (
                      <span className="absolute bottom-0 right-0 w-3.5 h-3.5 rounded-full bg-primary ring-2 ring-[var(--c-bg)]" />
                    ) : presence === 'online' ? (
                      <span className="absolute bottom-0 right-0 w-3.5 h-3.5 rounded-full bg-online ring-2 ring-[var(--c-bg)]" title="Online" />
                    ) : presence === 'away' ? (
                      <span className="absolute bottom-0 right-0 w-3.5 h-3.5 rounded-full bg-away ring-2 ring-[var(--c-bg)]" title="Recently active" />
                    ) : null}
                  </div>

                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-base font-semibold text-app truncate bn-safe">
                        {channel.name}
                      </h3>
                      {mutedNow && (
                        <BellOff className="w-3 h-3 text-app-faint shrink-0" />
                      )}
                      {channel.isGroup && (
                        <span className="text-[10px] font-semibold text-app-2 bg-surface px-1.5 py-0.5 rounded-md">
                          Group
                        </span>
                      )}
                    </div>
                    {/* Phase 1.8: an existing draft replaces the last-message
                        preview with an italic `Draft: …` line. */}
                    {draft ? (
                      <p className="text-sm text-app-2 truncate bn-safe mt-0.5 italic">
                        <span className="font-semibold text-primary">Draft:</span> {draft}
                      </p>
                    ) : (
                      <p className={`text-sm text-app-2 truncate bn-safe mt-0.5 ${mutedNow ? 'opacity-50' : ''}`}>
                        {channel.lastMessage || channel.description}
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0 ml-3">
                  <div className="flex flex-col items-end gap-1">
                    <span className="flex items-center gap-1 text-xs text-app-2">
                      {channel.isPinned && <Pin className="w-3 h-3 text-app-faint shrink-0" />}
                      <span>
                        {formatRelativeTime(channel.lastMessageTimestamp || channel.createdAt, lang, channel.lastMessageTime)}
                      </span>
                    </span>
                    {/* Unread badge — black pill (suppressed while effectively muted, WhatsApp-style) */}
                    {!mutedNow && channel.unreadCount && channel.unreadCount > 0 ? (
                      <span className="min-w-5 h-5 px-1.5 rounded-full bg-[#F2A007] text-[#15211B] font-semibold text-[11px] flex items-center justify-center">
                        {channel.unreadCount}
                      </span>
                    ) : null}
                  </div>

                  {/* Phase 2 desktop fix: the old ~90px strip of hover-only
                      Pin / Mute / Archive buttons squeezed the name column
                      in the two-pane layout. Every row action now lives
                      behind this single compact overflow (⋯) button, which
                      opens the SAME Phase 1.8 context menu used by
                      long-press (touch, unchanged) and right-click — pin,
                      mute (8h / 1wk / always), archive, mark-unread and
                      list membership, with Saved Messages still excluded
                      from mute/archive inside the menu itself. */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const rect = e.currentTarget.getBoundingClientRect();
                      openCtxMenu(channel, rect.left, rect.bottom);
                    }}
                    className="h-11 w-11 shrink-0 flex items-center justify-center rounded-full text-app-faint hover:text-app hover:bg-pressed opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity [transition-duration:var(--dur-press)]"
                    title={lang === 'bn' ? 'আরও' : 'More actions'}
                    aria-label={lang === 'bn' ? 'আরও' : 'More actions'}
                  >
                    <MoreVertical className="w-5 h-5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
          </>
        )}
      </div>

      {/* Floating Action Button (FAB) Container with Drag & Reposition Controls */}
      <div
        style={{
          bottom: `${fabBottomOffset}px`,
          [fabSide]: '16px'
        }}
        className="absolute z-20 flex flex-col items-center gap-1.5 transition-all duration-75 select-none"
      >
        {/* Drag handle & Side Nudge Buttons */}
        <div className="flex items-center gap-1 opacity-0 hover:opacity-100 transition-opacity bg-black/60 rounded-full px-1.5 py-0.5 text-white text-[10px]">
          <button
            type="button"
            onClick={toggleFabSide}
            title={fabSide === 'right' ? 'Move to Left' : 'Move to Right'} aria-label={fabSide === 'right' ? 'Move to Left' : 'Move to Right'}
            className="hover:text-white p-0.5"
          >
            ⇄
          </button>
          <span
            onPointerDown={handleFabPointerDown}
            onPointerMove={handleFabPointerMove}
            onPointerUp={handleFabPointerUp}
            className="cursor-ns-resize px-1 text-[11px] flex items-center"
            title="Drag Up or Down"
          >
            <Move className="w-2.5 h-2.5" />
          </span>
        </div>

        {/* Mega round: the FAB is a single-action button (no menu), so the
            New message entry is a separate round people button (44px)
            directly above it, wired to App's onNewMessage. */}
        {onNewMessage && (
          <button
            type="button"
            onClick={() => onNewMessage()}
            className="w-11 h-11 rounded-full bg-[#FFFFFF] dark:bg-[#131A17] border border-token text-[#0B6E4F] dark:text-[#2FA37C] shadow-soft flex items-center justify-center transition-all hover:bg-[#E3EDE7] dark:hover:bg-[#243129] active:scale-95"
            title={lang === 'bn' ? 'নতুন মেসেজ' : 'New message'} aria-label={lang === 'bn' ? 'নতুন মেসেজ' : 'New message'}
          >
            <Users className="w-5 h-5" />
          </button>
        )}

        {/* Translucent Glassmorphic FAB Button — Mega round: SOLID emerald
            #0B6E4F (no gradient), pressed #095C42 */}
        <button
          onClick={onOpenNewCategory}
          onPointerDown={handleFabPointerDown}
          onPointerMove={handleFabPointerMove}
          onPointerUp={handleFabPointerUp}
          className="w-13 h-13 rounded-full bg-[#0B6E4F] hover:bg-[#095C42] border border-white/25 text-white shadow-soft flex items-center justify-center transition-all active:scale-95 cursor-grab active:cursor-grabbing group relative animate-float-slow"
          title={lang === 'bn' ? 'নতুন গ্রুপ বা ক্যাটাগরি তৈরি করুন (ড্র্যাগ করে সরাতে পারেন)' : 'New Group / Category (Drag to move)'} aria-label={lang === 'bn' ? 'নতুন গ্রুপ বা ক্যাটাগরি তৈরি করুন (ড্র্যাগ করে সরাতে পারেন)' : 'New Group / Category (Drag to move)'}
        >
          <Plus className="w-6 h-6 stroke-[2.5]" />
        </button>
      </div>

      {/* ── Phase 1.8 row context menu (long-press / right-click) ──────────
          Saved Messages never offers archive/mute (it is the user's own
          notebook, not a chat). */}
      {ctxMenu && (
        <div className="fixed inset-0 z-40" onClick={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }}>
          <div
            className="absolute w-56 rounded-[var(--r-sheet)] glass-sheet p-1.5 animate-in zoom-in-95 transition-[opacity,transform] [transition-duration:var(--dur-sheet)] [transition-timing-function:var(--ease-spring)]"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
            onClick={(e) => e.stopPropagation()}
           role="menu" >
            <p className="px-2.5 py-1.5 text-[11px] font-bold text-app-faint truncate bn-safe">{ctxMenu.channel.name}</p>
            {ctxMenu.section === 'main' && (
              <>
                <button
                  onClick={() => { onTogglePin(ctxMenu.channel.id); setCtxMenu(null); }}
                  className="w-full flex items-center gap-2 text-left px-2.5 py-2 rounded-xl text-xs font-semibold text-app hover:bg-pressed"
                >
                  <Pin className="w-3.5 h-3.5" />
                  {ctxMenu.channel.isPinned ? (lang === 'bn' ? 'আনপিন করুন' : 'Unpin') : lang === 'bn' ? 'পিন করুন' : 'Pin'}
                </button>
                {ctxMenu.channel.id !== 'saved_messages' && onToggleArchive && (
                  <button
                    onClick={() => { onToggleArchive(ctxMenu.channel.id); setCtxMenu(null); }}
                    className="w-full flex items-center gap-2 text-left px-2.5 py-2 rounded-xl text-xs font-semibold text-app hover:bg-pressed"
                  >
                    <Archive className="w-3.5 h-3.5" />
                    {ctxMenu.channel.isArchived
                      ? lang === 'bn' ? 'আর্কাইভ থেকে তুলুন' : 'Unarchive'
                      : lang === 'bn' ? 'আর্কাইভ করুন' : 'Archive'}
                  </button>
                )}
                {ctxMenu.channel.id !== 'saved_messages' && (onSetMuted || onToggleMute) &&
                  (isEffectivelyMuted(ctxMenu.channel) ? (
                    <button
                      onClick={() => { onToggleMute?.(ctxMenu.channel.id); setCtxMenu(null); }}
                      className="w-full flex items-center gap-2 text-left px-2.5 py-2 rounded-xl text-xs font-semibold text-app hover:bg-pressed"
                    >
                      <Bell className="w-3.5 h-3.5" />
                      {lang === 'bn' ? 'আনমিউট করুন' : 'Unmute'}
                    </button>
                  ) : (
                    <button
                      onClick={() => setCtxMenu({ ...ctxMenu, section: 'mute' })}
                      className="w-full flex items-center justify-between gap-2 text-left px-2.5 py-2 rounded-xl text-xs font-semibold text-app hover:bg-pressed"
                    >
                      <span className="flex items-center gap-2">
                        <BellOff className="w-3.5 h-3.5" />
                        {lang === 'bn' ? 'মিউট করুন' : 'Mute'}
                      </span>
                      <ChevronRight className="w-3.5 h-3.5 text-app-faint" />
                    </button>
                  ))}
                {onMarkUnread && (ctxMenu.channel.unreadCount ?? 0) === 0 && (
                  <button
                    onClick={() => { onMarkUnread(ctxMenu.channel.id); setCtxMenu(null); }}
                    className="w-full flex items-center gap-2 text-left px-2.5 py-2 rounded-xl text-xs font-semibold text-app hover:bg-pressed"
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                    {lang === 'bn' ? 'অপঠিত হিসেবে চিহ্নিত করুন' : 'Mark as unread'}
                  </button>
                )}
                <button
                  onClick={() => setCtxMenu({ ...ctxMenu, section: 'lists' })}
                  className="w-full flex items-center justify-between gap-2 text-left px-2.5 py-2 rounded-xl text-xs font-semibold text-app hover:bg-pressed"
                >
                  <span className="flex items-center gap-2">
                    <ListPlus className="w-3.5 h-3.5" />
                    {lang === 'bn' ? 'তালিকায় যোগ করুন' : 'Add to list'}
                  </span>
                  <ChevronRight className="w-3.5 h-3.5 text-app-faint" />
                </button>
              </>
            )}
            {ctxMenu.section === 'mute' && (
              <>
                {(
                  [
                    { label: lang === 'bn' ? '৮ ঘণ্টা' : '8 hours', until: Date.now() + 8 * 3600 * 1000 },
                    { label: lang === 'bn' ? '১ সপ্তাহ' : '1 week', until: Date.now() + 7 * 24 * 3600 * 1000 },
                    { label: lang === 'bn' ? 'সবসময়' : 'Always', until: null },
                  ] as { label: string; until: number | null }[]
                ).map((opt) => (
                  <button
                    key={opt.label}
                    onClick={() => {
                      if (onSetMuted) onSetMuted(ctxMenu.channel.id, opt.until);
                      else onToggleMute?.(ctxMenu.channel.id);
                      setCtxMenu(null);
                    }}
                    className="w-full flex items-center gap-2 text-left px-2.5 py-2 rounded-xl text-xs font-semibold text-app hover:bg-pressed"
                  >
                    <Clock className="w-3.5 h-3.5" />
                    {opt.label}
                  </button>
                ))}
                <button
                  onClick={() => setCtxMenu({ ...ctxMenu, section: 'main' })}
                  className="w-full text-left px-2.5 py-2 rounded-xl text-xs font-semibold text-app-faint hover:bg-pressed"
                >
                  ← {lang === 'bn' ? 'ফিরুন' : 'Back'}
                </button>
              </>
            )}
            {ctxMenu.section === 'lists' && (
              <>
                {lists.map((list) => {
                  const inList = list.channelIds.includes(ctxMenu.channel.id);
                  return (
                    <button
                      key={list.id}
                      onClick={() => toggleChannelInList(list.id, ctxMenu.channel.id)}
                      className="w-full flex items-center justify-between gap-2 text-left px-2.5 py-2 rounded-xl text-xs font-semibold text-app hover:bg-pressed"
                    >
                      <span className="truncate">{list.name}</span>
                      {inList && <Check className="w-3.5 h-3.5 text-primary shrink-0" />}
                    </button>
                  );
                })}
                <button
                  onClick={() => {
                    const name = window.prompt(lang === 'bn' ? 'নতুন তালিকার নাম:' : 'Name for the new list:');
                    if (name) {
                      const created = createList(name);
                      if (created) toggleChannelInList(created.id, ctxMenu.channel.id);
                    }
                    setCtxMenu(null);
                  }}
                  className="w-full flex items-center gap-2 text-left px-2.5 py-2 rounded-xl text-xs font-semibold text-primary hover:bg-pressed"
                >
                  <ListPlus className="w-3.5 h-3.5" />
                  {lang === 'bn' ? 'নতুন তালিকা…' : 'New list…'}
                </button>
                <button
                  onClick={() => setCtxMenu({ ...ctxMenu, section: 'main' })}
                  className="w-full text-left px-2.5 py-2 rounded-xl text-xs font-semibold text-app-faint hover:bg-pressed"
                >
                  ← {lang === 'bn' ? 'ফিরুন' : 'Back'}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Phase 1.9.1 global search modal (Ctrl/Cmd+K) ───────────────────
          Queries GET /api/search (server-scoped to rooms the caller may
          access); results are grouped by chat with highlighted snippets. */}
      {globalSearchOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center p-4 pt-[10vh] animate-in fade-in"
          onClick={() => setGlobalSearchOpen(false)}
        >
          <div
            className="glass-sheet rounded-[var(--r-sheet)] w-full max-w-lg overflow-hidden text-app max-h-[75vh] flex flex-col transition-[opacity,transform] [transition-duration:var(--dur-sheet)] [transition-timing-function:var(--ease-spring)]"
            onClick={(e) => e.stopPropagation()}
           role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'সব মেসেজে খুঁজুন' : 'Search all messages'} >
            <div className="p-4 pb-2">
              <div className="relative">
                <Search className="w-4 h-4 text-app-faint absolute left-4 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={globalQuery}
                  onChange={(e) => setGlobalQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') rememberSearch(globalQuery);
                  }}
                  placeholder={lang === 'bn' ? 'সব চ্যাটে মেসেজ খুঁজুন...' : 'Search messages in all chats...'} aria-label={lang === 'bn' ? 'সব চ্যাটে মেসেজ খুঁজুন...' : 'Search messages in all chats...'}
                  className="w-full bg-bubble-in border-0 rounded-full pl-11 pr-10 py-2.5 text-base text-app placeholder:text-app-faint "
                  autoFocus
                />
                <button
                  onClick={() => setGlobalSearchOpen(false)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-app-faint hover:text-app-2"
                 aria-label={lang === 'bn' ? 'বন্ধ করুন' : 'Close search'} >
                  <X className="w-4 h-4" />
                </button>
              </div>
              {globalQuery.trim().length < 2 && recentSearches.length > 0 && (
                <div className="pt-3 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold text-app-faint uppercase tracking-wide">
                      {lang === 'bn' ? 'সাম্প্রতিক খোঁজ' : 'Recent searches'}
                    </span>
                    <button onClick={clearRecentSearches} className="text-[11px] font-semibold text-primary hover:underline">
                      {lang === 'bn' ? 'সব মুছুন' : 'Clear all'}
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {recentSearches.map((s) => (
                      <button
                        key={s}
                        onClick={() => setGlobalQuery(s)}
                        className="px-3 py-1 rounded-full bg-surface text-xs font-semibold text-app-2 hover:bg-pressed transition-colors flex items-center gap-1"
                      >
                        <Clock className="w-3 h-3 text-app-faint" />
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="flex-1 overflow-y-auto px-2 pb-3">
              {globalLoading && (
                <p className="text-xs text-app-faint px-3 py-4">{lang === 'bn' ? 'খোঁজা হচ্ছে...' : 'Searching...'}</p>
              )}
              {!globalLoading && globalQuery.trim().length >= 2 && groupedGlobalResults.length === 0 && (
                <p className="text-xs text-app-faint px-3 py-4">
                  {lang === 'bn' ? `'${globalQuery.trim()}'-এর জন্য কোনো মেসেজ পাওয়া যায়নি` : `No messages found for '${globalQuery.trim()}'`}
                </p>
              )}
              {!globalLoading &&
                groupedGlobalResults.map(([roomId, items]) => {
                  const roomChannel = channels.find((c) => c.id === roomId);
                  const roomPeer = users.find((u) => u.id === roomId);
                  const roomName = roomChannel?.name || roomPeer?.name || roomId;
                  return (
                    <div key={roomId} className="pt-2">
                      <p className="px-3 py-1 text-[11px] font-bold text-app-faint uppercase tracking-wide truncate bn-safe">{roomName}</p>
                      {items.map((r) => (
                        <button
                          key={r.message.id}
                          onClick={() => {
                            rememberSearch(globalQuery);
                            setGlobalSearchOpen(false);
                            if (onJumpToMessage) onJumpToMessage(r.roomId, r.message.id);
                            else onSelectChat(r.roomId, roomChannel ? !roomChannel.isGroup : true);
                          }}
                          className="w-full text-left px-3 py-2 rounded-xl hover:bg-pressed transition-colors"
                        >
                          <span className="flex items-baseline justify-between gap-2">
                            <span className="text-xs font-semibold text-app truncate bn-safe">{r.message.senderName}</span>
                            <span className="text-[10px] text-app-2 shrink-0">
                              {new Date(r.message.timestamp).toLocaleDateString([], { day: 'numeric', month: 'short' })}
                            </span>
                          </span>
                          <span className="block text-xs text-app-2 truncate bn-safe mt-0.5">
                            {highlightSnippet(
                              r.message.type === 'text' ? r.message.content : `[${r.message.type}] ${r.message.fileName || ''}`,
                              globalQuery
                            )}
                          </span>
                        </button>
                      ))}
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
      )}

      {/* ── Phase 1.5 (roadmap 1.5) join group by invite link dialog ───────
          Paste a chitthi://join/<code> link, any URL ending in the code,
          or the bare code. POST /api/channels/join: a returned channel is
          upserted via onJoinChannel; {pending:true} means join approval
          is on; 404/invalid shows the inline error below. */}
      {joinOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center p-4 pt-[10vh] animate-in fade-in"
          onClick={closeJoinDialog}
        >
          <div
            className="glass-sheet rounded-[var(--r-sheet)] w-full max-w-md overflow-hidden text-app transition-[opacity,transform] [transition-duration:var(--dur-sheet)] [transition-timing-function:var(--ease-spring)]"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={lang === 'bn' ? 'গ্রুপে যোগ দিন' : 'Join group'}
          >
            <div className="p-5 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-base font-bold text-app">
                    {lang === 'bn' ? 'গ্রুপে যোগ দিন' : 'Join group'}
                  </h2>
                  <p className="text-xs text-app-faint mt-0.5">
                    {lang === 'bn'
                      ? 'ইনভাইট লিংক বা কোড পেস্ট করুন'
                      : 'Paste an invite link or code to join a group.'}
                  </p>
                </div>
                <button
                  onClick={closeJoinDialog}
                  className="p-1.5 text-app-faint hover:text-app-2 rounded-full hover:bg-pressed transition-colors shrink-0"
                  title={lang === 'bn' ? 'বন্ধ করুন' : 'Close'} aria-label={lang === 'bn' ? 'বন্ধ করুন' : 'Close'}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="relative">
                <Link2 className="w-4 h-4 text-app-faint absolute left-4 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={joinInput}
                  onChange={(e) => {
                    setJoinInput(e.target.value);
                    if (joinError) setJoinError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !joinLoading) void handleJoinGroup();
                    if (e.key === 'Escape') closeJoinDialog();
                  }}
                  placeholder="chitthi://join/…"
                  className="w-full bg-bubble-in border-0 rounded-full pl-11 pr-4 py-2.5 text-base text-app placeholder:text-app-faint "
                  autoFocus
                 aria-label={lang === 'bn' ? 'ইনভাইট লিংক বা কোড' : 'Invite link or code'} />
              </div>
              {joinError && (
                <p className="text-xs font-semibold text-danger px-1" role="alert">
                  {joinError}
                </p>
              )}
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  onClick={closeJoinDialog}
                  disabled={joinLoading}
                  className="px-4 py-2 rounded-full text-[13px] font-semibold bg-surface text-app-2 hover:bg-pressed transition-colors disabled:opacity-50"
                >
                  {lang === 'bn' ? 'বাতিল' : 'Cancel'}
                </button>
                <button
                  onClick={() => void handleJoinGroup()}
                  disabled={joinLoading || !joinInput.trim()}
                  className="px-4 py-2 rounded-full text-[13px] font-semibold bg-primary text-white hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center gap-1.5"
                >
                  <Link2 className="w-3.5 h-3.5" />
                  {joinLoading
                    ? lang === 'bn'
                      ? 'যোগ দেওয়া হচ্ছে...'
                      : 'Joining...'
                    : lang === 'bn'
                      ? 'যোগ দিন'
                      : 'Join group'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
