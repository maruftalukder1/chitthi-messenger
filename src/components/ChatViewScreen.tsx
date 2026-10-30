import React, { useState, useRef, useEffect } from 'react';
import { Channel, ChatMessage, User, GroupSection, GroupRole } from '../types/chat';
import { formatClockTime } from '../utils/timeFormat';
import { getEffectiveUserPresence } from '../utils/presenceUtils';
import {
  ArrowLeft,
  Phone,
  Video,
  MoreVertical,
  Paperclip,
  Mic,
  Send,
  Image as ImageIcon,
  Camera,
  ChevronDown,
  Play,
  Pause,
  CheckCheck,
  FileText,
  Download,
  QrCode,
  Lock,
  Hash,
  Plus,
  X,
  CheckCircle2,
  Users,
  Trash2,
  Edit2,
  AlertTriangle,
  Info,
  Search,
  BarChart3,
  Reply as ReplyIcon,
  Pin,
  Copy,
  Forward,
  Check,
  Ban,
  Clock,
  Timer,
  Smile,
  Star,
  Bell,
  BookmarkCheck,
  ChevronUp,
  ChevronRight,
  Link2,
  User as UserIcon,
  Award
} from 'lucide-react';
import { socketService } from '../services/socketService';
import { authHeaders } from '../services/firebase';
import { ProfileCard, type ProfileCardUser } from './ProfileCard';
import { STICKER_PACKS } from '../data/stickerPacks';
import { gifConfig, searchGifs, trendingGifs, type GifResult } from '../services/gifService';
import { initialsAvatarDataUrl } from '../utils/avatar';

interface ChatViewScreenProps {
  roomId: string;
  isDm: boolean;
  channel?: Channel;
  recipientUser?: User;
  currentUser: User;
  messages: ChatMessage[];
  users?: User[];
  onSendMessage: (
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
      mimeType?: string;
      stickerPack?: string;
      stickerId?: string;
      contactCard?: string;
      storyRef?: string;
    }
  ) => void;
  /** Optional (Team CL wiring): open a DM with an arbitrary user — used by
   * ProfileCard "Message" actions for @mention / contact-card profiles. */
  onOpenUserChat?: (userId: string) => void;
  /** Optional (coordinator addendum): when this changes to a new non-empty
   * message id, jump to that message — switching sections first when the
   * message lives in another section of this room, then flashing it via
   * the same highlight machinery as pinned/reply jumps. */
  jumpToMessageId?: string;
  scheduledMessages?: { id: string; content: string; sendAt: number; failed?: boolean }[];
  onScheduleMessage?: (
    content: string,
    sendAt: number,
    sectionId?: string,
    replyTo?: ChatMessage['replyTo']
  ) => void;
  onCancelScheduled?: (id: string) => void;
  onRetryScheduled?: (id: string) => void;
  onUpdateMessage?: (messageId: string, patch: Partial<ChatMessage>) => void;
  onDeleteMessage?: (messageId: string) => void;
  onToggleReaction?: (msg: ChatMessage, emoji: string) => void;
  onForwardMessage?: (msg: ChatMessage, targetRoomId: string) => void;
  allChannels?: Channel[];
  onBack: () => void;
  onOpenGroupInfo: () => void;
  onStartCall: (callType: 'audio' | 'video') => void;
  onPreviewMedia: (url: string, type: 'image' | 'video', title?: string) => void;
  onOpenCamera: () => void;
  onOpenOfflineQr: () => void;
  onUpdateChannel?: (updatedChannel: Channel) => void;
  lang: 'bn' | 'en';
  activeSubchannelId?: string;
}

const CURATED_GROUP_AVATARS = [
  'https://images.unsplash.com/photo-1610832958506-aa56368176cf?auto=format&fit=crop&w=400&q=80',
  'https://images.unsplash.com/photo-1522071820081-009f0129c71c?auto=format&fit=crop&w=400&q=80',
  'https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?auto=format&fit=crop&w=400&q=80',
  'https://images.unsplash.com/photo-1556761175-5973dc0f32e7?auto=format&fit=crop&w=400&q=80',
  'https://images.unsplash.com/photo-1531403009284-440f080d1e12?auto=format&fit=crop&w=400&q=80'
];

// Phase 2 token discipline: generated artefacts (this initials-avatar SVG,
// the exported standalone HTML file) cannot read CSS variables once they
// leave the page, so resolve the live token values at generation time
// instead of embedding hex literals in source. The fallback is a named
// colour, used only if the token is somehow undefined.
const cssToken = (name: string, fallback: string): string => {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
};

// Honest avatar fallback (Phase 0.4): a generated initials tile (brand
// gradient + initials), never a stock photo of a stranger.

// Format a Date for an <input type="datetime-local"> value, in LOCAL time
// (toISOString() would shift it to UTC). Phase 4: the schedule presets used
// to each inline this construction.
function toDatetimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Upload guardrails: files are inlined as data URLs, and the server caps WS
// frames at 12 MB / message JSON at 8 MB — reject oversize files client-side
// with a visible error instead of letting them fail silently on the wire.
const MAX_FILE_BYTES = 6 * 1024 * 1024;
const MAX_DATA_URL_LEN = 8 * 1024 * 1024;

// ── Voice message waveform player ──────────────────────────────────────────
// Custom skin over a hidden <audio> element: waveform bars are decoded from
// the actual recorded audio (per-bucket peaks via AudioContext), progress
// driven by timeupdate, data-saver respected via preload="none".
const formatVoiceTime = (sec: number): string => {
  const safe = Number.isFinite(sec) && sec > 0 ? sec : 0;
  const m = Math.floor(safe / 60);
  const r = Math.floor(safe % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
};

const VoiceWaveformPlayer: React.FC<{
  src: string;
  messageId: string;
  isMe: boolean;
  durationHint?: number;
  dataSaver: boolean;
}> = ({ src, isMe, durationHint, dataSaver }) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState<number>(durationHint || 0);

  // Waveform bars (6–22px) from the REAL recorded audio: decode the blob and
  // take the peak amplitude of each of 32 buckets. Flat placeholder bars are
  // shown until decoding finishes (or if the codec can't be decoded here).
  const [barHeights, setBarHeights] = useState<number[]>(() => Array.from({ length: 32 }, () => 8));
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(src);
        const buf = await res.arrayBuffer();
        const AC: typeof AudioContext | undefined =
          window.AudioContext || (window as any).webkitAudioContext;
        if (!AC) return;
        const ctx = new AC();
        try {
          const audio = await ctx.decodeAudioData(buf.slice(0));
          if (Number.isFinite(audio.duration) && audio.duration > 0) setDuration(audio.duration);
          const data = audio.getChannelData(0);
          const bars = 32;
          const block = Math.max(1, Math.floor(data.length / bars));
          const peaks: number[] = [];
          for (let i = 0; i < bars; i++) {
            let max = 0;
            const start = i * block;
            const step = Math.max(1, Math.floor(block / 48));
            for (let j = start; j < Math.min(data.length, start + block); j += step) {
              const v = Math.abs(data[j]);
              if (v > max) max = v;
            }
            peaks.push(6 + Math.round(Math.min(1, max) * 16));
          }
          if (!cancelled) setBarHeights(peaks);
        } finally {
          ctx.close().catch(() => {});
        }
      } catch {
        /* undecodable here — keep the flat placeholder bars */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src]);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
    };
  }, []);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      // With data saver (preload="none") this first tap also loads the media.
      audio.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
    }
  };

  const playedBars = duration > 0 ? Math.floor((currentTime / duration) * barHeights.length) : 0;
  const showCurrent = isPlaying || currentTime > 0;

  return (
    <div className="flex items-center gap-2.5 min-w-[212px] max-w-[264px] py-0.5">
      <button
        type="button"
        onClick={togglePlay}
        className={`w-11 h-11 rounded-full flex items-center justify-center shrink-0 transition-all active:scale-95 ${
          isMe ? 'bg-white/20 text-white hover:bg-white/30' : 'bg-primary text-white hover:brightness-110'
        }`}
        title={isPlaying ? 'Pause' : 'Play'} aria-label={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current translate-x-[1px]" />}
      </button>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-[2px] h-[22px]" aria-hidden="true">
          {barHeights.map((h, i) => (
            <span
              key={i}
              style={{ height: `${h}px` }}
              className={`w-[3px] rounded-full shrink-0 transition-colors ${
                isMe
                  ? i < playedBars
                    ? 'bg-white'
                    : 'bg-white/35'
                  : i < playedBars
                  ? 'bg-primary'
                  : 'bg-pressed'
              }`}
            />
          ))}
        </div>
        <p className={`text-[11px] leading-tight mt-0.5 tabular-nums ${isMe ? 'text-white/70' : 'text-app-faint'}`}>
          {showCurrent ? `${formatVoiceTime(currentTime)} / ` : ''}{formatVoiceTime(duration)}
        </p>
      </div>
      <audio
        ref={audioRef}
        src={src}
        preload={dataSaver ? 'none' : 'metadata'}
        className="hidden"
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setDuration(d);
        }}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onEnded={() => {
          setIsPlaying(false);
          setCurrentTime(0);
        }}
        onPause={() => setIsPlaying(false)}
        onPlay={() => setIsPlaying(true)}
      />
    </div>
  );
};

export const ChatViewScreen: React.FC<ChatViewScreenProps> = ({
  roomId,
  isDm,
  channel,
  recipientUser,
  currentUser,
  messages,
  users = [],
  onSendMessage,
  onBack,
  onOpenGroupInfo,
  onStartCall,
  onPreviewMedia,
  onOpenCamera,
  onOpenOfflineQr,
  onUpdateChannel,
  onUpdateMessage,
  onDeleteMessage,
  onToggleReaction,
  onForwardMessage,
  scheduledMessages = [],
  onScheduleMessage,
  onCancelScheduled,
  onRetryScheduled,
  allChannels = [],
  lang,
  activeSubchannelId,
  onOpenUserChat,
  jumpToMessageId,
}) => {
  const [text, setText] = useState('');
  const [selectedSubChannelId, setSelectedSubChannelId] = useState<string>(activeSubchannelId || 'sec_gen');

  useEffect(() => {
    if (activeSubchannelId) {
      setSelectedSubChannelId(activeSubchannelId);
    }
  }, [activeSubchannelId]);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [showThreeDotMenu, setShowThreeDotMenu] = useState(false);

  // ── Flagship message interactions (reply / edit / actions / search / polls / typing) ──
  const [replyToMsg, setReplyToMsg] = useState<ChatMessage | null>(null);
  const [editingMsg, setEditingMsg] = useState<ChatMessage | null>(null);
  const [actionMsg, setActionMsg] = useState<ChatMessage | null>(null);
  const [forwardMsg, setForwardMsg] = useState<ChatMessage | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  // ── Phase 1 search v2 (1.9.2): scope, stepping, filter parsing ──
  const [searchScope, setSearchScope] = useState<'section' | 'room'>('section');
  const [searchIndex, setSearchIndex] = useState(0);
  // ── Phase 1 actions (1.9.5 / 1.8): stars, info panel, reminders ──
  const [starredIds, setStarredIds] = useState<Set<string>>(new Set());
  const [infoMsg, setInfoMsg] = useState<ChatMessage | null>(null);
  const [remindMsg, setRemindMsg] = useState<ChatMessage | null>(null);
  const [remindCustomAt, setRemindCustomAt] = useState('');
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  // ── Phase 1: ProfileCard mounts (1.4) + DM shared media (1.9.3) ──
  const [profileCardUser, setProfileCardUser] = useState<ProfileCardUser | null>(null);
  const [showSharedMedia, setShowSharedMedia] = useState(false);
  const [sharedMediaTab, setSharedMediaTab] = useState<'images' | 'videos' | 'docs' | 'links'>('images');
  // ── Phase 1: upload progress bubbles (1.6) + server-schedule notice (1.8) ──
  const [pendingUploads, setPendingUploads] = useState<
    { id: string; name: string; kind: 'image' | 'video' | 'file'; progress: number }[]
  >([]);
  const [scheduleNotice, setScheduleNotice] = useState<{ kind: 'server' | 'local'; text: string } | null>(null);
  const [scheduling, setScheduling] = useState(false);
  // Quiz-mode poll creation (1.2) + my local votes (reveal works even when
  // the server anonymises voterIds for non-privileged recipients).
  const [pollQuiz, setPollQuiz] = useState(false);
  const [pollCorrectIdx, setPollCorrectIdx] = useState(0);
  const [myPollVotes, setMyPollVotes] = useState<Record<string, string[]>>({});
  // Drafted reply (1.8): a reply ref restored from the draft store when the
  // full message object is no longer the live replyToMsg state.
  const [pendingReplyRef, setPendingReplyRef] = useState<ChatMessage['replyTo'] | null>(null);
  // Composer media panel (1.6): emoji / sticker packs / GIF tabs
  const [mediaPanelTab, setMediaPanelTab] = useState<'emoji' | 'packs' | 'gif'>('emoji');
  const [activePackId, setActivePackId] = useState<string>(STICKER_PACKS[0]?.id || '');
  const [gifQuery, setGifQuery] = useState('');
  const [gifResults, setGifResults] = useState<GifResult[]>([]);
  const [gifLoading, setGifLoading] = useState(false);
  const [showPollModal, setShowPollModal] = useState(false);
  const [pollQuestion, setPollQuestion] = useState('');
  const [pollOptions, setPollOptions] = useState<string[]>(['', '']);
  // Poll extras (multiple/anonymous/auto-close map straight onto PollData)
  const [pollMultiple, setPollMultiple] = useState(false);
  const [pollAnonymous, setPollAnonymous] = useState(false);
  const [pollCloseIn, setPollCloseIn] = useState<'' | '1' | '6' | '24'>('');
  // Upload guardrails + who-reacted sheet + reply-jump highlight
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [reactionSheetMsg, setReactionSheetMsg] = useState<ChatMessage | null>(null);
  const [highlightMsgId, setHighlightMsgId] = useState<string | null>(null);
  const [typingUsers, setTypingUsers] = useState<Record<string, { name: string; at: number }>>({});
  const typingSentRef = useRef<number>(0);

  // ── Round 2: stickers / scheduling / mentions / drafts / TTL / wallpaper / data saver ──
  const [showStickers, setShowStickers] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleAt, setScheduleAt] = useState('');
  const [dataSaver] = useState<boolean>(() => {
    try {
      return localStorage.getItem('chitthi_data_saver') === '1';
    } catch {
      return false;
    }
  });
  const [revealedMedia, setRevealedMedia] = useState<Set<string>>(new Set());
  const [roomTtl, setRoomTtlState] = useState<number>(0);
  const [wallpaper, setWallpaperState] = useState<string>('default');

  useEffect(() => {
    try {
      setRoomTtlState(Number(localStorage.getItem(`chitthi_ttl_${roomId}`) || 0));
      setWallpaperState(localStorage.getItem(`chitthi_wallpaper_${roomId}`) || 'default');
    } catch {
      /* ignore */
    }
  }, [roomId]);

  const setRoomTtl = (sec: number) => {
    setRoomTtlState(sec);
    try {
      if (sec > 0) localStorage.setItem(`chitthi_ttl_${roomId}`, String(sec));
      else localStorage.removeItem(`chitthi_ttl_${roomId}`);
    } catch {
      /* ignore */
    }
  };

  const setWallpaper = (id: string) => {
    setWallpaperState(id);
    try {
      localStorage.setItem(`chitthi_wallpaper_${roomId}`, id);
    } catch {
      /* ignore */
    }
  };

  // Phase 2: wallpaper tints resolve from tokens via color-mix (no colour
  // literals). Nearest-token notes: sunset's amber/rose stops use the danger
  // token (no warning token exists); forest's lime stop uses online.
  const WALLPAPERS: Record<string, React.CSSProperties> = {
    default: {},
    dots: {
      backgroundImage: 'radial-gradient(color-mix(in srgb, var(--c-text-2) 22%, transparent) 1.2px, transparent 1.2px)',
      backgroundSize: '18px 18px',
    },
    ocean: { background: 'linear-gradient(165deg, color-mix(in srgb, var(--c-primary) 16%, transparent), color-mix(in srgb, var(--c-primary) 5%, transparent) 55%, color-mix(in srgb, var(--c-primary) 14%, transparent))' },
    sunset: { background: 'linear-gradient(165deg, color-mix(in srgb, var(--c-danger) 12%, transparent), color-mix(in srgb, var(--c-danger) 7%, transparent) 55%, color-mix(in srgb, var(--c-away) 13%, transparent))' },
    forest: { background: 'linear-gradient(165deg, color-mix(in srgb, var(--c-online) 15%, transparent), color-mix(in srgb, var(--c-online) 5%, transparent) 55%, color-mix(in srgb, var(--c-online) 11%, transparent))' },
  };

  const STICKERS = ['😀', '😂', '🥰', '😎', '🤔', '😴', '🔥', '❤️', '👍', '🙏', '🎉', '🌙', '⭐', '🍕', '⚽', '🏏', '🇧🇩', '✨', '🚀', '💯'];

  // @mention autocomplete (groups): token being typed at the end of the composer
  const mentionMatch = channel?.isGroup && !editingMsg ? text.match(/@([\w.]{0,20})$/) : null;
  const canMentionAll =
    currentUser.isAdmin || currentUser.role === 'admin' || channel?.adminId === currentUser.id;
  const mentionCandidates = mentionMatch
    ? [
        ...(canMentionAll
          ? [{ id: 'all', username: 'all', name: lang === 'bn' ? 'সবাইকে মেনশন' : 'Mention everyone' }]
          : []),
        ...users
          .filter(
            (u) =>
              u.id !== currentUser.id &&
              ((u.username || '').toLowerCase().includes(mentionMatch[1].toLowerCase()) ||
                u.name.toLowerCase().includes(mentionMatch[1].toLowerCase()))
          )
          .slice(0, 5)
          .map((u) => ({ id: u.id, username: u.username || u.name.split(' ')[0].toLowerCase(), name: u.name })),
      ]
    : [];

  const pickMention = (username: string) => {
    setText((prev) => prev.replace(/@([\w.]{0,20})$/, `@${username} `));
  };

  // ── Search v2 filter parsing (1.9.2) ─────────────────────────────────────
  // Typed filters: from:<name> · has:link|file|image|poll · before:<date> ·
  // after:<date>; whatever remains is the free-text term.
  interface ParsedSearch {
    text: string;
    from?: string;
    has?: 'link' | 'file' | 'image' | 'poll';
    before?: number;
    after?: number;
  }
  const parseSearchQuery = (raw: string): ParsedSearch => {
    const parsed: ParsedSearch = { text: '' };
    const rest: string[] = [];
    for (const token of raw.split(/\s+/).filter(Boolean)) {
      const lower = token.toLowerCase();
      if (lower.startsWith('from:') && token.length > 5) parsed.from = token.slice(5).toLowerCase();
      else if (lower === 'has:link' || lower === 'has:file' || lower === 'has:image' || lower === 'has:poll')
        parsed.has = lower.slice(4) as ParsedSearch['has'];
      else if ((lower.startsWith('before:') || lower.startsWith('after:')) && token.length > 7) {
        const ts = new Date(token.slice(token.indexOf(':') + 1)).getTime();
        if (Number.isFinite(ts)) {
          if (lower.startsWith('before:')) parsed.before = ts;
          else parsed.after = ts;
        } else rest.push(token);
      } else rest.push(token);
    }
    parsed.text = rest.join(' ').trim().toLowerCase();
    return parsed;
  };
  const parsedSearch = parseSearchQuery(searchQuery);
  const searchTerm = searchOpen ? parsedSearch.text : '';

  // Map a directory User onto the ProfileCard contract (directory fields
  // like about/privacy ride along when the caller provided them).
  const profileCardForUser = (u: User): ProfileCardUser => {
    const extra = u as User & {
      about?: string;
      lastSeenAt?: number;
      privacy?: ProfileCardUser['privacy'];
    };
    return {
      id: u.id,
      name: u.name,
      username: u.username,
      avatar: u.avatar,
      about: extra.about,
      status: u.status,
      online: u.online,
      presence: u.presence,
      lastSeen: u.lastSeen,
      lastSeenAt: extra.lastSeenAt,
      privacy: extra.privacy,
      isContact: true, // profile cards here open for room co-members / the DM peer
    };
  };

  const openProfileForUsername = (username: string) => {
    const clean = username.replace(/^@/, '').toLowerCase();
    const found =
      users.find((u) => (u.username || '').toLowerCase() === clean) ||
      (recipientUser && (recipientUser.username || '').toLowerCase() === clean ? recipientUser : undefined) ||
      (currentUser.username && currentUser.username.toLowerCase() === clean ? currentUser : undefined);
    if (found) {
      if (found.id !== currentUser.id) setProfileCardUser(profileCardForUser(found));
      return;
    }
    // Unknown to this client's directory — still show an honest minimal card.
    setProfileCardUser({ id: clean, name: `@${clean}`, username: clean, isContact: false });
  };

  // Render message text with @mentions highlighted (@you and @all stand out;
  // tapping a person's @mention opens their ProfileCard) and plain
  // http/https URLs linkified. Only http/https may linkify — never
  // javascript:/data: (same allowlist discipline as safeMediaUrl below).
  // While in-chat search is active, free-text matches are <mark>-highlighted.
  const renderRichText = (content: string, isMe: boolean) => {
    const known = new Set(users.map((u) => (u.username || '').toLowerCase()).filter(Boolean));
    const highlightPlain = (text: string, keyPrefix: string): React.ReactNode => {
      if (!searchTerm || !text.toLowerCase().includes(searchTerm)) return text;
      const parts = text.split(new RegExp(`(${searchTerm.replace(/[.*+?^${'{}'}()|[\]\\]/g, '\\$&')})`, 'gi'));
      return parts.map((p, j) =>
        p.toLowerCase() === searchTerm ? (
          <mark key={`${keyPrefix}-h${j}`} className="bg-primary text-white rounded-[3px] px-px">
            {p}
          </mark>
        ) : (
          <React.Fragment key={`${keyPrefix}-h${j}`}>{p}</React.Fragment>
        )
      );
    };
    const renderTextPart = (text: string, keyPrefix: string) =>
      text.split(/(@[\w.]+)/g).map((part, i) => {
        if (!part.startsWith('@')) return <React.Fragment key={`${keyPrefix}-${i}`}>{highlightPlain(part, `${keyPrefix}-${i}`)}</React.Fragment>;
        const key = part.slice(1).toLowerCase();
        const isMention = key === 'all' || known.has(key);
        if (!isMention) return <React.Fragment key={`${keyPrefix}-${i}`}>{part}</React.Fragment>;
        const isForMe = key === 'all' || key === (currentUser.username || '').toLowerCase();
        const mentionClass = `px-1 rounded-md font-bold ${
          isForMe
            ? 'bg-[#F2A007]/40 text-inherit'
            : isMe
            ? 'bg-[#F2A007]/25 text-white'
            : 'bg-[#F2A007]/25 text-inherit'
        }`;
        if (key === 'all') {
          return (
            <span key={`${keyPrefix}-${i}`} className={mentionClass}>
              {part}
            </span>
          );
        }
        return (
          <button
            key={`${keyPrefix}-${i}`}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openProfileForUsername(key);
            }}
            className={`${mentionClass} cursor-pointer hover:underline`}
            title={lang === 'bn' ? 'প্রোফাইল দেখুন' : 'View profile'} aria-label={lang === 'bn' ? 'প্রোফাইল দেখুন' : 'View profile'}
          >
            {part}
          </button>
        );
      });
    return content.split(/(https?:\/\/[^\s]+)/g).map((part, i) => {
      if (/^https?:\/\//.test(part)) {
        return (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => e.stopPropagation()}
            className={`underline break-all ${
              isMe ? 'text-white/80 hover:text-white' : 'text-primary  hover:text-primary'
            }`}
          >
            {part}
          </a>
        );
      }
      return <React.Fragment key={i}>{renderTextPart(part, `t${i}`)}</React.Fragment>;
    });
  };

  // Media URLs come from message payloads, which any chat participant can
  // craft — a `javascript:` URL in an <a href> would execute on click in the
  // app origin (security lab finding). Allowlist safe schemes only.
  const safeMediaUrl = (u: string): string => (/^(data:|blob:|https?:)/i.test(u) ? u : '#');

  const ttlRemainingLabel = (expiresAt: number): string => {
    const ms = expiresAt - Date.now();
    if (ms <= 0) return '';
    const mins = Math.ceil(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.round(ms / 3600000);
    if (hrs < 48) return `${hrs}h`;
    return `${Math.round(hrs / 24)}d`;
  };

  // Date separator label for the message list (Today / Yesterday / full date)
  const sameCalendarDay = (a: Date, b: Date) =>
    a.getDate() === b.getDate() && a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
  const dateSeparatorLabel = (ts: number): string => {
    const d = new Date(ts);
    const now = new Date();
    if (sameCalendarDay(d, now)) return lang === 'bn' ? 'আজ' : 'Today';
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (sameCalendarDay(d, yesterday)) return lang === 'bn' ? 'গতকাল' : 'Yesterday';
    return d.toLocaleDateString(lang === 'bn' ? 'bn-BD' : 'en-US', { day: 'numeric', month: 'short', year: 'numeric' });
  };

  const snippetOf = (m: ChatMessage): string => {
    if (m.deletedAt) return lang === 'bn' ? 'মুছে ফেলা মেসেজ' : 'Deleted message';
    if (m.type === 'poll') return `📊 ${m.poll?.question || m.content}`;
    if (m.type === 'sticker' || (m.type === 'image' && m.sticker)) return '🖼️ ' + (lang === 'bn' ? 'স্টিকার' : 'Sticker');
    if (m.type === 'contact' || m.contactCard) return '👤 ' + (lang === 'bn' ? 'কন্টাক্ট কার্ড' : 'Contact card');
    if (m.type === 'text') return m.content.slice(0, 90);
    if (m.type === 'image') return '📷 ' + (m.fileName || (lang === 'bn' ? 'ছবি' : 'Photo'));
    if (m.type === 'video') return '🎬 ' + (lang === 'bn' ? 'ভিডিও' : 'Video');
    if (m.type === 'audio') return '🎤 ' + (lang === 'bn' ? 'ভয়েস মেসেজ' : 'Voice message');
    if (m.type === 'file') return '📄 ' + (m.fileName || 'File');
    return m.content.slice(0, 90);
  };

  // Universal quote-reply (1.2): the ReplyRef for ANY message type — the
  // snippet is always a human label (never "[object]"), and the render-side
  // chip enriches media quotes with a thumbnail/label from the original.
  const replyRefOf = (m: ChatMessage): NonNullable<ChatMessage['replyTo']> => ({
    id: m.id,
    senderName: m.senderName,
    snippet: snippetOf(m),
    type: m.type,
  });

  // The reply that will actually be attached on send: the live picked
  // message wins; a draft-restored ref is the fallback.
  const activeReplyRef: ChatMessage['replyTo'] | undefined = replyToMsg
    ? replyRefOf(replyToMsg)
    : pendingReplyRef || undefined;

  // Typing indicators from peers (protocol already existed in socketService — now consumed)
  useEffect(() => {
    const unsub = socketService.onTyping((data) => {
      if (data.roomId !== roomId || data.userId === currentUser.id) return;
      setTypingUsers((prev) => {
        const next = { ...prev };
        if (data.isTyping) next[data.userId] = { name: data.username, at: Date.now() };
        else delete next[data.userId];
        return next;
      });
    });
    const sweeper = setInterval(() => {
      setTypingUsers((prev) => {
        const now = Date.now();
        const next: typeof prev = {};
        let changed = false;
        for (const [k, v] of Object.entries(prev)) {
          if (now - v.at < 3500) next[k] = v;
          else changed = true;
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => {
      unsub();
      clearInterval(sweeper);
    };
  }, [roomId, currentUser.id]);

  // GIF picker data (1.6): trending on open, debounced search while typing.
  // Unconfigured provider → no fetch at all (the panel shows its empty state).
  useEffect(() => {
    if (!showStickers || mediaPanelTab !== 'gif') return;
    if (!gifConfig()) return;
    setGifLoading(true);
    const t = setTimeout(
      () => {
        const run = gifQuery.trim() ? searchGifs(gifQuery) : trendingGifs();
        run
          .then((results) => setGifResults(results))
          .finally(() => setGifLoading(false));
      },
      gifQuery.trim() ? 350 : 0
    );
    return () => clearTimeout(t);
  }, [showStickers, mediaPanelTab, gifQuery]);

  const notifyTyping = () => {
    const now = Date.now();
    if (now - typingSentRef.current < 2000) return;
    typingSentRef.current = now;
    socketService.sendTyping(roomId, currentUser.id, currentUser.name, true);
  };

  const votePoll = (msg: ChatMessage, optionId: string) => {
    if (!msg.poll || !onUpdateMessage) return;
    const poll = msg.poll;
    // My current votes: from voterIds when the server exposed them, merged
    // with my local record (anonymised polls strip voterIds for
    // non-privileged recipients — the local record keeps toggling and the
    // quiz reveal working regardless).
    const mineBefore = new Set<string>([
      ...poll.options.filter((o) => (o.voterIds || []).includes(currentUser.id)).map((o) => o.id),
      ...(myPollVotes[msg.id] || []),
    ]);
    const clickedHad = mineBefore.has(optionId);
    const mineAfter = new Set<string>(mineBefore);
    if (clickedHad) mineAfter.delete(optionId);
    else if (poll.multiple) mineAfter.add(optionId);
    else {
      mineAfter.clear();
      mineAfter.add(optionId);
    }
    setMyPollVotes((prev) => ({ ...prev, [msg.id]: Array.from(mineAfter) }));

    const options = poll.options.map((o) => {
      const voterIds = o.voterIds || [];
      const wasMine = voterIds.includes(currentUser.id);
      const isMine = mineAfter.has(o.id);
      // Anonymised polls carry voterCount instead of voterIds for
      // non-privileged recipients — keep the count in step with my vote.
      let voterCount = o.voterCount;
      if (voterCount !== undefined && wasMine !== isMine) {
        voterCount = Math.max(0, voterCount + (isMine ? 1 : -1));
      }
      return {
        ...o,
        voterIds: isMine ? (wasMine ? voterIds : [...voterIds, currentUser.id]) : voterIds.filter((v) => v !== currentUser.id),
        voterCount,
      };
    });
    onUpdateMessage(msg.id, { poll: { ...poll, options } });
  };

  /** Has the current user voted on this poll (either source of truth)? */
  const pollHasMyVote = (msg: ChatMessage): boolean => {
    if (!msg.poll) return false;
    if ((myPollVotes[msg.id] || []).length > 0) return true;
    return msg.poll.options.some((o) => (o.voterIds || []).includes(currentUser.id));
  };
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);

  // Group Image Change Modal
  const [showImageChangeModal, setShowImageChangeModal] = useState(false);
  const groupImageInputRef = useRef<HTMLInputElement | null>(null);

  // New Sub-channel Creation Modal
  const [showAddSectionModal, setShowAddSectionModal] = useState(false);
  const [newSectionName, setNewSectionName] = useState('');
  const [newSectionDesc, setNewSectionDesc] = useState('');
  const [newSectionPrivate, setNewSectionPrivate] = useState(false);
  const [newSectionAllowedRoles, setNewSectionAllowedRoles] = useState<GroupRole[]>(['admin', 'moderator']);
  const [newSectionAllowedMembers, setNewSectionAllowedMembers] = useState<string[]>([]);

  // Sub-channel Edit Modal
  const [sectionToEdit, setSectionToEdit] = useState<GroupSection | null>(null);
  const [editSectionName, setEditSectionName] = useState('');
  const [editSectionDesc, setEditSectionDesc] = useState('');
  const [editSectionPrivate, setEditSectionPrivate] = useState(false);
  const [editSectionAllowedRoles, setEditSectionAllowedRoles] = useState<GroupRole[]>(['admin', 'moderator']);

  // Sub-channel Deletion Confirmation Modal
  const [sectionToDelete, setSectionToDelete] = useState<GroupSection | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const docInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<any>(null);

  // Touch access to the message action sheet (Phase 0.5): long-press ~500ms
  // (cancelled by scroll/move or release) opens the SAME sheet as the hover
  // button; right-click (contextmenu) does the same on desktop.
  const longPressRef = useRef<any>(null);
  const startLongPress = (m: ChatMessage) => {
    if (m.deletedAt) return;
    cancelLongPress();
    longPressRef.current = setTimeout(() => setActionMsg(m), 500);
  };
  const cancelLongPress = () => {
    if (longPressRef.current) {
      clearTimeout(longPressRef.current);
      longPressRef.current = null;
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Available Discord-like sections for this channel
  const sections: GroupSection[] = channel?.sections || [
    { id: 'sec_gen', name: 'General', isPrivate: false, allowedRoles: ['admin', 'moderator', 'controller', 'member'], description: 'General announcements and team discussions' },
    { id: 'sec_design', name: 'Design Team', isPrivate: true, allowedRoles: ['admin', 'moderator', 'controller'], description: 'UI/UX mockups, prototypes, and Figma assets' },
    { id: 'sec_ux', name: 'UX Writer', isPrivate: false, allowedRoles: ['admin', 'moderator', 'controller', 'member'], description: 'Product copy, tone-of-voice, and microcopy' },
    { id: 'sec_proj', name: 'Projects', isPrivate: true, allowedRoles: ['admin', 'moderator'], description: 'Sprint roadmaps, deliverables, and architecture' }
  ];

  // Active selected section object
  const activeSection = sections.find((s) => s.id === selectedSubChannelId) || sections[0];

  // Determine user role in this group — real check against server-persisted
  // membership (Phase 0.2; the old `|| true` bypass made everyone admin):
  // owner, listed admin, legacy adminId (pre-contract channels), or a
  // persisted 'admin' member role.
  const isUserAdmin =
    currentUser.id === channel?.ownerId ||
    (channel?.adminIds ? channel.adminIds.includes(currentUser.id) : false) ||
    channel?.adminId === currentUser.id ||
    (channel?.memberRoles ? channel.memberRoles[currentUser.id] === 'admin' : false);

  // ── Phase 0.3: group state is persisted to the server ────────────────────
  // Membership is stored by user ID everywhere. Legacy channels may still
  // carry display names in `members` — resolve them to IDs via the users
  // list (unresolvable entries are kept verbatim; they may be IDs of users
  // not present in this client's list).
  const resolveMemberIds = (ch: Channel): string[] => {
    if (ch.memberIds && ch.memberIds.length) return Array.from(new Set(ch.memberIds));
    const ids: string[] = [];
    for (const m of ch.members || []) {
      const match = users.find((u) => u.id === m) || users.find((u) => u.name === m);
      const id = match ? match.id : m;
      if (id && !ids.includes(id)) ids.push(id);
    }
    const owner = ch.ownerId || ch.adminId;
    if (owner && !ids.includes(owner)) ids.unshift(owner);
    return ids;
  };

  const resolveAdminIds = (ch: Channel): string[] => {
    if (ch.adminIds && ch.adminIds.length) return Array.from(new Set(ch.adminIds));
    const ids: string[] = [];
    const owner = ch.ownerId || ch.adminId;
    if (owner) ids.push(owner);
    if (ch.memberRoles) {
      for (const [mid, role] of Object.entries(ch.memberRoles)) {
        if (role === 'admin' && !ids.includes(mid)) ids.push(mid);
      }
    }
    return ids;
  };

  // Every group-state change goes through here: local state updates via
  // onUpdateChannel AND the full updated channel (name, sections, memberIds,
  // adminIds, ownerId) is POSTed to /api/channels with contract auth headers
  // so a second device sees identical state.
  const persistChannelUpdate = (updated: Channel) => {
    const memberIds = resolveMemberIds(updated);
    const adminIds = resolveAdminIds(updated);
    const normalized: Channel = {
      ...updated,
      ownerId: updated.ownerId || updated.adminId || channel?.ownerId || channel?.adminId,
      memberIds,
      adminIds,
      members: memberIds,
      membersCount: memberIds.length || updated.membersCount,
    };
    onUpdateChannel?.(normalized);
    (async () => {
      try {
        const headers = {
          'Content-Type': 'application/json',
          ...(await authHeaders(currentUser.id)),
        };
        await fetch('/api/channels', {
          method: 'POST',
          headers,
          body: JSON.stringify(normalized),
        });
      } catch {
        /* best-effort sync — local state is already updated */
      }
    })();
  };

  // ── Phase 0.11: Block / Report ────────────────────────────────────────────
  const [blockedIds, setBlockedIds] = useState<string[]>([]);
  useEffect(() => {
    (async () => {
      try {
        const headers = await authHeaders(currentUser.id);
        const res = await fetch('/api/blocks', { headers });
        if (res.ok) {
          const data = await res.json();
          setBlockedIds(Array.isArray(data.blocked) ? data.blocked : []);
        }
      } catch {
        /* blocks list unavailable — menu still offers the actions */
      }
    })();
  }, [currentUser.id]);

  const blockUser = async (userId: string, userName: string) => {
    if (!window.confirm(lang === 'bn' ? `আপনি কি "${userName}" কে ব্লক করতে চান?` : `Block "${userName}"? They won't be able to message or call you.`)) return;
    try {
      const headers = { 'Content-Type': 'application/json', ...(await authHeaders(currentUser.id)) };
      const res = await fetch('/api/blocks', {
        method: 'POST',
        headers,
        body: JSON.stringify({ blockedId: userId }),
      });
      if (res.ok) setBlockedIds((prev) => (prev.includes(userId) ? prev : [...prev, userId]));
    } catch {
      /* ignore */
    }
  };

  const unblockUser = async (userId: string) => {
    try {
      const headers = await authHeaders(currentUser.id);
      const res = await fetch(`/api/blocks/${encodeURIComponent(userId)}`, {
        method: 'DELETE',
        headers,
      });
      if (res.ok) setBlockedIds((prev) => prev.filter((id) => id !== userId));
    } catch {
      /* ignore */
    }
  };

  const reportUser = async (userId: string, userName: string) => {
    const reason = window.prompt(
      lang === 'bn' ? `"${userName}" সম্পর্কে রিপোর্টের কারণ (ঐচ্ছিক):` : `Report "${userName}" — reason (optional):`,
      ''
    );
    if (reason === null) return; // cancelled
    try {
      const headers = { 'Content-Type': 'application/json', ...(await authHeaders(currentUser.id)) };
      const res = await fetch('/api/reports', {
        method: 'POST',
        headers,
        body: JSON.stringify({ reportedId: userId, reason: reason || undefined }),
      });
      // Report implies block server-side — reflect the blocked state here.
      if (res.ok) setBlockedIds((prev) => (prev.includes(userId) ? prev : [...prev, userId]));
    } catch {
      /* ignore */
    }
  };

  // ── Phase 1.9.5: Stars ───────────────────────────────────────────────────
  // Star state comes from GET /api/stars on room open; starring posts a full
  // message snapshot, unstarring deletes by message id.
  useEffect(() => {
    (async () => {
      try {
        const headers = await authHeaders(currentUser.id);
        const res = await fetch('/api/stars', { headers });
        if (res.ok) {
          const data = await res.json();
          const list = Array.isArray(data.stars) ? data.stars : [];
          setStarredIds(new Set(list.map((m: any) => m?.id).filter(Boolean)));
        }
      } catch {
        /* stars unavailable — action sheet still offers the toggle */
      }
    })();
  }, [currentUser.id, roomId]);

  const toggleStar = async (msg: ChatMessage) => {
    const isStarred = starredIds.has(msg.id);
    setStarredIds((prev) => {
      const next = new Set(prev);
      if (isStarred) next.delete(msg.id);
      else next.add(msg.id);
      return next;
    });
    try {
      const headers = { 'Content-Type': 'application/json', ...(await authHeaders(currentUser.id)) };
      if (isStarred) {
        await fetch(`/api/stars/${encodeURIComponent(msg.id)}`, { method: 'DELETE', headers });
      } else {
        await fetch('/api/stars', { method: 'POST', headers, body: JSON.stringify({ message: msg }) });
      }
    } catch {
      /* optimistic state kept; server list re-syncs on next room open */
    }
  };

  // ── Phase 1.9.5: Reminders (server-side, POST /api/reminders) ───────────
  const createReminder = async (msg: ChatMessage, dueAt: number) => {
    try {
      const headers = { 'Content-Type': 'application/json', ...(await authHeaders(currentUser.id)) };
      const res = await fetch('/api/reminders', {
        method: 'POST',
        headers,
        body: JSON.stringify({ roomId, messageId: msg.id, dueAt }),
      });
      setActionNotice(
        res.ok
          ? lang === 'bn'
            ? 'রিমাইন্ডার সেট হয়েছে'
            : 'Reminder set — we will nudge you in Saved Messages'
          : lang === 'bn'
            ? 'রিমাইন্ডার সেট করা যায়নি'
            : 'Could not set the reminder'
      );
    } catch {
      setActionNotice(lang === 'bn' ? 'রিমাইন্ডার সেট করা যায়নি' : 'Could not set the reminder');
    }
    setRemindMsg(null);
  };

  const reminderPresetDue = (preset: '1h' | 'tonight' | 'tomorrow' | 'week'): number => {
    const now = Date.now();
    if (preset === '1h') return now + 3600 * 1000;
    const d = new Date();
    if (preset === 'tonight') {
      d.setHours(21, 0, 0, 0);
      if (d.getTime() <= now) d.setDate(d.getDate() + 1);
      return d.getTime();
    }
    if (preset === 'tomorrow') {
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return d.getTime();
    }
    d.setDate(d.getDate() + 7);
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  };

  // ── Phase 1.9.4: Chat export (HTML / JSON / TXT, tombstones excluded) ───
  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  const exportChat = (format: 'html' | 'json' | 'txt') => {
    const rows = [...messages]
      .filter((m) => !m.deletedAt)
      .sort((a, b) => a.timestamp - b.timestamp);
    const stamp = new Date().toISOString().slice(0, 10);
    const baseName = `chitthi-chat-${roomId}-${stamp}`;
    const escapeHtml = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    // Exported HTML is standalone: apply the same scheme allowlist as
    // safeMediaUrl so a crafted javascript: media URL cannot survive as a
    // clickable href / img src in the exported file (Lens 10 finding).
    const safeExportUrl = (u: string): string => (/^(data:|blob:|https?:)/i.test(u) ? u : '#');
    if (format === 'json') {
      const payload = rows.map((m) => ({
        id: m.id,
        roomId: m.roomId,
        senderId: m.senderId,
        senderName: m.senderName,
        timestamp: new Date(m.timestamp).toISOString(),
        type: m.type,
        content: m.content,
        fileName: m.fileName,
        replyTo: m.replyTo,
        reactions: m.reactions,
      }));
      downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `${baseName}.json`);
      return;
    }
    if (format === 'txt') {
      const lines = rows.map((m) => {
        const d = new Date(m.timestamp);
        const date = d.toLocaleDateString('en-GB');
        const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `[${date}, ${time}] ${m.senderName}: ${snippetOf(m)}`;
      });
      downloadBlob(new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }), `${baseName}.txt`);
      return;
    }
    // The exported file is standalone (no app CSS), so token values are
    // resolved live via cssToken() rather than written as hex literals.
    const expPrimary = cssToken('--c-primary', '#0B6E4F');
    const expText = cssToken('--c-text', 'black');
    const expText2 = cssToken('--c-text-2', 'gray');
    const expBorder = cssToken('--c-border', 'gray');
    const body = rows
      .map((m) => {
        const when = new Date(m.timestamp).toLocaleString();
        let contentHtml: string;
        if (m.type === 'image' || m.type === 'sticker') {
          contentHtml = `<div><img src="${escapeHtml(safeExportUrl(m.content))}" alt="${escapeHtml(m.fileName || 'image')}" style="max-width:320px;border-radius:8px" /><div>${escapeHtml(m.fileName || '')}</div></div>`;
        } else if (m.type === 'video') {
          contentHtml = `<div>🎬 <a href="${escapeHtml(safeExportUrl(m.content))}">${escapeHtml(m.fileName || 'Video')}</a></div>`;
        } else if (m.type === 'file' || m.type === 'audio') {
          contentHtml = `<div>${m.type === 'audio' ? '🎤' : '📄'} <a href="${escapeHtml(safeExportUrl(m.content))}">${escapeHtml(m.fileName || m.content)}</a></div>`;
        } else if (m.type === 'poll' && m.poll) {
          const opts = m.poll.options
            .map((o) => `<li>${escapeHtml(o.text)} — ${o.voterCount ?? o.voterIds.length}</li>`)
            .join('');
          contentHtml = `<div>📊 <strong>${escapeHtml(m.poll.question)}</strong><ul>${opts}</ul></div>`;
        } else {
          contentHtml = `<div style="white-space:pre-wrap">${escapeHtml(m.content)}</div>`;
        }
        const reply = m.replyTo
          ? `<div style="border-left:3px solid ${expPrimary};padding-left:8px;color:${expText2};font-size:12px">↩ ${escapeHtml(m.replyTo.senderName)}: ${escapeHtml(m.replyTo.snippet)}</div>`
          : '';
        return `<div style="margin:0 0 14px"><div style="font-size:12px;color:${expText2}"><strong style="color:${expText}">${escapeHtml(m.senderName)}</strong> · ${escapeHtml(when)}</div>${reply}${contentHtml}</div>`;
      })
      .join('\n');
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Chitthi chat export — ${escapeHtml(roomId)}</title></head>
<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:${expText};line-height:1.5">
<h1 style="font-size:20px">Chitthi chat export</h1>
<p style="color:${expText2};font-size:13px">Room: ${escapeHtml(roomId)} · Exported ${escapeHtml(new Date().toLocaleString())} · ${rows.length} messages (deleted messages excluded; media referenced by URL/filename)</p>
<hr style="border:none;border-top:1px solid ${expBorder};margin:16px 0" />
${body}
</body></html>`;
    downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `${baseName}.html`);
  };

  const isRecipientBlocked = !!(isDm && recipientUser && blockedIds.includes(recipientUser.id));

  const userRole: GroupRole =
    (channel?.memberRoles && channel.memberRoles[currentUser.id]) ||
    (isUserAdmin ? 'admin' : 'member');

  // Compute Granular Permissions from channel settings
  const userPerms = channel?.memberPermissions?.[currentUser.id];
  const rolePerms = channel?.rolePermissions?.[userRole];

  const canEditSubchannel =
    isUserAdmin ||
    Boolean(
      userPerms?.canEditSubchannel ??
      rolePerms?.canEditSubchannel ??
      (userRole === 'admin' || userRole === 'moderator')
    );

  const canDeleteSubchannel =
    isUserAdmin ||
    Boolean(
      userPerms?.canDeleteSubchannel ??
      rolePerms?.canDeleteSubchannel ??
      (userRole === 'admin' || userRole === 'moderator')
    );

  const canCreateSubchannel =
    isUserAdmin ||
    Boolean(
      userPerms?.canCreateSubchannel ??
      rolePerms?.canCreateSubchannel ??
      (userRole === 'admin' || userRole === 'moderator')
    );

  const isUserAllowedInSection = (sec: GroupSection): boolean => {
    if (!sec.isPrivate) return true;
    if (isUserAdmin || userRole === 'admin') return true;
    if (userPerms?.canPostInLocked) return true;
    if (sec.allowedRoles && sec.allowedRoles.includes(userRole)) return true;
    if (sec.allowedMemberIds && sec.allowedMemberIds.includes(currentUser.id)) return true;
    return false;
  };

  const hasAccessToActiveSection = !channel?.isGroup || isUserAllowedInSection(activeSection);

  // Composer drafts: unsent text is kept per room + section (WhatsApp/Telegram-style).
  // Phase 1.8: the draft ALSO stores the pending reply ref — a drafted reply
  // stays a reply across room switches and reloads. Stored as JSON
  // {text, replyTo}; legacy plain-string drafts still load as text-only.
  const draftKey = `chitthi_draft_${roomId}_${activeSection.id}`;
  const readDraft = (): { text: string; replyTo: ChatMessage['replyTo'] | null } => {
    try {
      const raw = localStorage.getItem(draftKey);
      if (!raw) return { text: '', replyTo: null };
      if (raw.startsWith('{')) {
        const parsed = JSON.parse(raw);
        return {
          text: typeof parsed.text === 'string' ? parsed.text : '',
          replyTo: parsed.replyTo && parsed.replyTo.id ? parsed.replyTo : null,
        };
      }
      return { text: raw, replyTo: null };
    } catch {
      return { text: '', replyTo: null };
    }
  };
  const writeDraft = (value: string, reply: ChatMessage['replyTo'] | null) => {
    try {
      if (value || reply) localStorage.setItem(draftKey, JSON.stringify({ text: value, replyTo: reply }));
      else localStorage.removeItem(draftKey);
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    if (editingMsg) return;
    const d = readDraft();
    setText(d.text);
    setReplyToMsg(null);
    setPendingReplyRef(d.replyTo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);
  const saveDraft = (value: string) => {
    writeDraft(value, replyToMsg ? replyRefOf(replyToMsg) : pendingReplyRef);
  };
  /** Restore the room's stored draft into the composer (edit-cancel path). */
  const restoreDraftIntoComposer = () => {
    const d = readDraft();
    setText(d.text);
    setReplyToMsg(null);
    setPendingReplyRef(d.replyTo);
  };

  // =========================================================================
  // DEDICATED CHAT PANEL: Filter messages strictly by active sub-channel!
  // =========================================================================
  const subChannelMessages = messages.filter((m) => {
    if (!channel?.isGroup) return true;

    if (m.sectionId) {
      return (
        m.sectionId === activeSection.id ||
        m.sectionId === activeSection.name ||
        m.sectionId.toLowerCase() === activeSection.name.toLowerCase() ||
        m.sectionId === `# ${activeSection.name}`
      );
    }

    return activeSection.id === 'sec_gen' || activeSection.name.toLowerCase() === 'general';
  });

  // ── In-chat search v2 (1.9.2) ────────────────────────────────────────────
  // The conversation stays IN PLACE (no filtering): matches are computed
  // over a pool (this section or the whole room), highlighted in the text,
  // and stepped through with ↑/↓ / Enter / Shift+Enter + an "n of N" counter.
  // Tombstones never match. Content searched: text content, fileName, image
  // captions (fileName), poll questions and sender names.
  const visibleMessages = subChannelMessages;

  const messageMatchesSearch = (m: ChatMessage, p: typeof parsedSearch): boolean => {
    if (m.deletedAt) return false;
    if (p.from && !m.senderName.toLowerCase().includes(p.from)) return false;
    if (p.before !== undefined && m.timestamp >= p.before) return false;
    if (p.after !== undefined && m.timestamp < p.after) return false;
    if (p.has === 'link' && !(m.type === 'text' && /https?:\/\//i.test(m.content))) return false;
    if (p.has === 'file' && m.type !== 'file') return false;
    if (p.has === 'image' && m.type !== 'image') return false;
    if (p.has === 'poll' && m.type !== 'poll') return false;
    if (!p.text) return true;
    const haystacks = [
      m.type === 'text' ? m.content : '',
      m.fileName || '',
      m.poll?.question || '',
      m.senderName || '',
    ];
    return haystacks.some((h) => h.toLowerCase().includes(p.text));
  };

  const searchActive = searchOpen && searchQuery.trim().length > 0;
  const searchPool = searchScope === 'room' ? messages : subChannelMessages;
  const searchMatches = searchActive ? searchPool.filter((m) => messageMatchesSearch(m, parsedSearch)) : [];
  const searchMatchIds = new Set(searchMatches.map((m) => m.id));

  useEffect(() => {
    setSearchIndex(0);
  }, [searchQuery, searchScope, roomId]);

  /** Scroll + flash a message; switches section first when needed. */
  const jumpToMessage = (target: ChatMessage) => {
    const doScroll = () => {
      document.getElementById(`msg-${target.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightMsgId(target.id);
      setTimeout(() => setHighlightMsgId(null), 1400);
    };
    const targetSectionId = target.sectionId;
    if (channel?.isGroup && targetSectionId) {
      const sec = sections.find(
        (s) =>
          s.id === targetSectionId ||
          s.name === targetSectionId ||
          s.name.toLowerCase() === targetSectionId.toLowerCase() ||
          `# ${s.name}` === targetSectionId
      );
      if (sec && sec.id !== activeSection.id) {
        setSelectedSubChannelId(sec.id);
        setTimeout(doScroll, 120);
        return;
      }
    }
    doScroll();
  };

  const stepSearch = (dir: 1 | -1) => {
    if (searchMatches.length === 0) return;
    const next = (searchIndex + dir + searchMatches.length) % searchMatches.length;
    setSearchIndex(next);
    jumpToMessage(searchMatches[next]);
  };

  // External jump requests (coordinator addendum — e.g. the group
  // shared-media browser): a NEW non-empty id jumps with section switching.
  const lastJumpIdRef = useRef<string>('');
  useEffect(() => {
    if (!jumpToMessageId) { lastJumpIdRef.current = ''; return; }
    if (jumpToMessageId === lastJumpIdRef.current) return;
    lastJumpIdRef.current = jumpToMessageId;
    const target = messages.find((m) => m.id === jumpToMessageId);
    if (target) jumpToMessage(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpToMessageId, messages]);

  const pinnedMsg = [...subChannelMessages].reverse().find((m) => m.pinned && !m.deletedAt);

  // ── Composer gating (Team GI contract, 1.2) ──────────────────────────────
  // Channel-wide post permission 'admins' or a readOnly section: non
  // owner/admin users get a disabled composer with a clear notice. The
  // server enforces the same rules on the send path.
  const composerGateReason: string | null = !isDm && channel
    ? channel.permissions?.post === 'admins' && !isUserAdmin
      ? lang === 'bn'
        ? '🔒 এই গ্রুপে শুধুমাত্র অ্যাডমিনরা পোস্ট করতে পারবেন'
        : '🔒 Only admins can post in this group'
      : activeSection?.readOnly && !isUserAdmin
        ? lang === 'bn'
          ? '📢 এটি একটি ঘোষণা সেকশন — শুধুমাত্র অ্যাডমিনরা পোস্ট করতে পারবেন'
          : '📢 This is an announcement section — only admins can post'
        : null
    : null;
  const composerDisabled = !hasAccessToActiveSection || !!composerGateReason;

  useEffect(() => {
    scrollToBottom();
  }, [subChannelMessages.length, selectedSubChannelId]);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (composerDisabled) return;

    // Edit mode: save in place, keep the original timestamp, mark as edited
    if (editingMsg && onUpdateMessage) {
      onUpdateMessage(editingMsg.id, { content: trimmed, editedAt: Date.now() });
      setEditingMsg(null);
      setText('');
      saveDraft('');
      return;
    }

    onSendMessage(trimmed, 'text', {
      sectionId: activeSection.id,
      replyTo: activeReplyRef,
    });
    setUploadError(null);
    setReplyToMsg(null);
    setPendingReplyRef(null);
    setText('');
    saveDraft('');
  };

  // Scheduling (1.8): creation goes to the SERVER queue first
  // (POST /api/scheduled) — the server sweeper delivers even if Chitthi is
  // closed. Only when the server call fails do we fall back to the existing
  // local queue (which needs the app open) and say so honestly.
  const confirmSchedule = async () => {
    const trimmed = text.trim();
    if (!trimmed || scheduling) return;
    const ts = scheduleAt ? new Date(scheduleAt).getTime() : NaN;
    if (!ts || ts <= Date.now()) return;
    const reply = activeReplyRef;
    const clearComposer = () => {
      setReplyToMsg(null);
      setPendingReplyRef(null);
      setText('');
      saveDraft('');
      setShowSchedule(false);
      setScheduleAt('');
    };
    setScheduling(true);
    try {
      const headers = { 'Content-Type': 'application/json', ...(await authHeaders(currentUser.id)) };
      const res = await fetch('/api/scheduled', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          roomId,
          dueAt: ts,
          message: {
            senderId: currentUser.id,
            senderName: currentUser.name,
            senderAvatar: currentUser.avatar,
            roomId,
            sectionId: activeSection.id,
            type: 'text',
            content: trimmed,
            replyTo: reply,
          },
        }),
      });
      if (!res.ok) throw new Error(`scheduled ${res.status}`);
      clearComposer();
      setScheduleNotice({
        kind: 'server',
        text:
          lang === 'bn'
            ? 'সার্ভারে শিডিউল হয়েছে — Chitthi বন্ধ থাকলেও মেসেজটি পাঠানো হবে।'
            : 'Scheduled on the server — this message will send even if you close Chitthi.',
      });
    } catch {
      // Local fallback queue (App-owned): keeps the failed/retry UI working.
      onScheduleMessage?.(trimmed, ts, activeSection.id, reply);
      clearComposer();
      setScheduleNotice({
        kind: 'local',
        text:
          lang === 'bn'
            ? 'সার্ভারে পৌঁছানো যায়নি — এই ডিভাইসে কিউ হয়েছে। পাঠানোর সময় অ্যাপটি খোলা থাকতে হবে।'
            : 'Server unreachable — queued on this device instead. The app must stay open for it to send.',
      });
    } finally {
      setScheduling(false);
    }
  };

  const resetPollForm = () => {
    setPollQuestion('');
    setPollOptions(['', '']);
    setPollMultiple(false);
    setPollAnonymous(false);
    setPollCloseIn('');
    setPollQuiz(false);
    setPollCorrectIdx(0);
  };

  const createPoll = () => {
    const q = pollQuestion.trim();
    const rawOpts = pollOptions.map((o) => o.trim());
    const opts = rawOpts.filter(Boolean);
    if (!q || opts.length < 2) return;
    const stamp = Date.now();
    const entries = rawOpts
      .map((text, i) => ({ text, id: `opt_${i}_${stamp}`, originalIdx: i }))
      .filter((e) => e.text);
    // Quiz mode: the creator marks one correct option. NOTE — the
    // correctOptionId travels with the message payload to all recipients
    // (contract v2 has no server-side hiding for it); the client only
    // REVEALS it after the voter has voted.
    const correctOptionId = pollQuiz
      ? (entries.find((e) => e.originalIdx === pollCorrectIdx) || entries[0]).id
      : undefined;
    onSendMessage(q, 'poll', {
      sectionId: activeSection.id,
      poll: {
        question: q,
        options: entries.map((e) => ({ id: e.id, text: e.text, voterIds: [] })),
        multiple: pollQuiz ? false : pollMultiple,
        anonymous: pollAnonymous,
        closesAt: pollCloseIn ? Date.now() + Number(pollCloseIn) * 3600 * 1000 : undefined,
        quiz: pollQuiz || undefined,
        correctOptionId,
      },
    });
    setShowPollModal(false);
    resetPollForm();
  };

  // Composer is an auto-growing <textarea>. Send behaviour reads the
  // `enterToSend` pref from localStorage `chitthi_settings_v1` (contract):
  // on/unset → Enter sends, Shift+Enter inserts a newline; off → Enter
  // inserts a newline and the send button sends.
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [text]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    if ((e.nativeEvent as any)?.isComposing) return; // IME composition — not a send
    let enterToSend = true;
    try {
      const prefs = JSON.parse(localStorage.getItem('chitthi_settings_v1') || '{}');
      enterToSend = prefs.enterToSend !== false;
    } catch {
      enterToSend = true;
    }
    if (enterToSend) {
      e.preventDefault();
      handleSend();
    }
  };

  const uploadTooLargeMsg =
    lang === 'bn' ? 'ফাইলটি খুব বড় — সর্বোচ্চ ৬ MB' : 'File is too large — max 6 MB';

  const formatFileSize = (sizeBytes: number): string =>
    sizeBytes < 1024 * 1024
      ? `${Math.round(sizeBytes / 1024)} KB`
      : `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;

  // ── Phase 1.6: media sends go through POST /api/uploads ─────────────────
  // The file is base64-JSON-posted; XHR gives real upload progress, shown on
  // a pending bubble in the message list. Only when the upload request
  // itself fails do we fall back to the legacy inline data-URL path (which
  // is bound by the 6 MB honesty limit below).
  const uploadFileToServer = async (
    file: File,
    pendingId: string
  ): Promise<{ url: string; name: string; size: number; mime: string }> => {
    const dataUrl: string = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error('read failed'));
      reader.readAsDataURL(file);
    });
    const headers = await authHeaders(currentUser.id);
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/uploads');
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const pct = Math.min(1, e.loaded / e.total);
        setPendingUploads((prev) => prev.map((p) => (p.id === pendingId ? { ...p, progress: pct } : p)));
      };
      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText || '{}');
          if (xhr.status >= 200 && xhr.status < 300 && typeof data.url === 'string') resolve(data);
          else reject(new Error(data.error || `upload ${xhr.status}`));
        } catch {
          reject(new Error('bad upload response'));
        }
      };
      xhr.onerror = () => reject(new Error('upload network error'));
      xhr.send(JSON.stringify({ name: file.name, mime: file.type || 'application/octet-stream', dataBase64: dataUrl }));
    });
  };

  const sendMediaFile = async (
    file: File,
    type: 'image' | 'video' | 'file',
    legacySend: () => void
  ) => {
    if (composerDisabled) return;
    const pendingId = `up_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    setPendingUploads((prev) => [...prev, { id: pendingId, name: file.name, kind: type, progress: 0 }]);
    setShowAttachMenu(false);
    try {
      const up = await uploadFileToServer(file, pendingId);
      onSendMessage(up.url, type, {
        fileName: up.name || file.name,
        fileSize: formatFileSize(up.size ?? file.size),
        mimeType: up.mime || file.type || undefined,
        sectionId: activeSection.id,
        replyTo: activeReplyRef,
      });
      setReplyToMsg(null);
      setPendingReplyRef(null);
      setUploadError(null);
    } catch {
      // Upload request itself failed → legacy inline path (6 MB bound).
      legacySend();
    } finally {
      setPendingUploads((prev) => prev.filter((p) => p.id !== pendingId));
    }
  };

  // Shared send path for the LEGACY data-URL fallback: enforces the data-URL
  // backstop so an oversize payload never reaches the socket (it would fail
  // silently there).
  const sendUploadedDataUrl = (
    dataUrl: string,
    type: 'image' | 'video' | 'file',
    file: File,
    sizeBytes: number,
    inputRef: React.RefObject<HTMLInputElement | null>
  ) => {
    if (dataUrl.length > MAX_DATA_URL_LEN) {
      setUploadError(uploadTooLargeMsg);
    } else {
      onSendMessage(dataUrl, type, {
        fileName: file.name,
        fileSize:
          sizeBytes < 1024 * 1024
            ? `${Math.round(sizeBytes / 1024)} KB`
            : `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`,
        sectionId: activeSection.id,
      });
      setUploadError(null);
      setShowAttachMenu(false);
    }
    if (inputRef.current) inputRef.current.value = '';
  };

  // LEGACY image fallback — downscale BEFORE inlining (canvas pattern from
  // StoriesBar): a full-size phone photo as a data URL would exceed the
  // server frame caps and fail silently. Used only when POST /api/uploads
  // itself fails; the 6 MB honesty limit applies on this path.
  const legacySendImage = (file: File) => {
    const sendRawFallback = () => {
      const reader = new FileReader();
      reader.onload = () => {
        sendUploadedDataUrl(reader.result as string, 'image', file, file.size, fileInputRef);
      };
      reader.readAsDataURL(file);
    };

    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
        if (scale >= 1) {
          // Already small enough — send the original bytes untouched
          URL.revokeObjectURL(objectUrl);
          sendRawFallback();
          return;
        }
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        URL.revokeObjectURL(objectUrl);
        if (!ctx) throw new Error('no 2d context');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const downscaled = canvas.toDataURL('image/jpeg', 0.85);
        if (Math.round(downscaled.length * 0.75) >= file.size) {
          // Downscaled result isn't actually smaller (tiny/odd formats) —
          // use whichever representation is smaller: the raw file.
          sendRawFallback();
        } else {
          sendUploadedDataUrl(downscaled, 'image', file, Math.round(downscaled.length * 0.75), fileInputRef);
        }
      } catch {
        sendRawFallback();
      }
    };
    img.onerror = () => {
      // Undecodable image — fall back to the raw path (backstop still applies)
      URL.revokeObjectURL(objectUrl);
      sendRawFallback();
    };
    img.src = objectUrl;
  };

  // Image Upload — server upload first (25 MB cap), legacy inline fallback.
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const input = e.target;
    if (!file) return;
    input.value = '';
    if (fileInputRef.current) fileInputRef.current.value = '';
    void sendMediaFile(file, 'image', () => legacySendImage(file));
  };

  // Document Upload — server upload first; the legacy fallback enforces the
  // 6 MB limit (uploadTooLargeMsg stays accurate for that path).
  const handleDocUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    if (docInputRef.current) docInputRef.current.value = '';
    void sendMediaFile(file, 'file', () => {
      if (file.size > MAX_FILE_BYTES) {
        setUploadError(uploadTooLargeMsg);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        sendUploadedDataUrl(reader.result as string, 'file', file, file.size, docInputRef);
      };
      reader.readAsDataURL(file);
    });
  };

  // Video Upload — same upload-first / legacy-fallback shape as documents.
  const handleVideoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    if (videoInputRef.current) videoInputRef.current.value = '';
    void sendMediaFile(file, 'video', () => {
      if (file.size > MAX_FILE_BYTES) {
        setUploadError(uploadTooLargeMsg);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        sendUploadedDataUrl(reader.result as string, 'video', file, file.size, videoInputRef);
      };
      reader.readAsDataURL(file);
    });
  };

  // Voice Recording
  const recordingStartRef = useRef<number>(0);
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];
      // Pick the recorder mimeType from the SUPPORTED list (Phase 1.6):
      // Safari only offers audio/mp4, Chrome prefers webm/opus. Constructing
      // the recorder without an explicit type and trusting a webm label is
      // what mislabelled Safari clips before — the extension is derived
      // from the actually-chosen type.
      const MIME_CANDIDATES = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/ogg',
        'audio/mp4',
      ];
      const pickedMime =
        typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function'
          ? MIME_CANDIDATES.find((t) => {
              try {
                return MediaRecorder.isTypeSupported(t);
              } catch {
                return false;
              }
            })
          : undefined;
      const mr = pickedMime ? new MediaRecorder(stream, { mimeType: pickedMime }) : new MediaRecorder(stream);
      mediaRecorderRef.current = mr;
      const mimeType = mr.mimeType || pickedMime || 'audio/webm';
      const ext = mimeType.includes('mp4') ? 'm4a' : mimeType.includes('ogg') ? 'ogg' : 'webm';

      mr.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mr.onstop = () => {
        // Real recorded duration from the wall clock at stop time — the old
        // code read the `recordingSeconds` state inside this closure, which
        // was still the value from record-start (hence always ~2s).
        const durationSec = Math.max(1, Math.round((Date.now() - recordingStartRef.current) / 1000));
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        const reader = new FileReader();
        reader.onloadend = () => {
          onSendMessage(reader.result as string, 'audio', {
            fileName: `voice_${Date.now()}.${ext}`,
            duration: durationSec,
            mimeType,
            sectionId: activeSection.id
          });
        };
        reader.readAsDataURL(blob);
        stream.getTracks().forEach((t) => t.stop());
      };

      mr.start();
      recordingStartRef.current = Date.now();
      setIsRecording(true);
      setRecordingSeconds(0);
      timerRef.current = setInterval(
        () => setRecordingSeconds(Math.floor((Date.now() - recordingStartRef.current) / 1000)),
        250
      );
    } catch (err) {
      alert(lang === 'bn' ? 'মাইক্রোফোন পারমিশন পাওয়া যায়নি।' : 'Microphone permission not available.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      clearInterval(timerRef.current);
    }
  };

  // Handle Changing Group Image
  const handleGroupImageFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !channel || !onUpdateChannel) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      persistChannelUpdate({
        ...channel,
        avatar: dataUrl,
        bannerImage: dataUrl
      });
      setShowImageChangeModal(false);
    };
    reader.readAsDataURL(file);
  };

  const handleSelectCuratedAvatar = (url: string) => {
    if (!channel || !onUpdateChannel) return;
    persistChannelUpdate({
      ...channel,
      avatar: url,
      bannerImage: url
    });
    setShowImageChangeModal(false);
  };

  // Handle Creating New Discord-like Section
  const handleCreateNewSection = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSectionName.trim() || !channel || !onUpdateChannel) return;

    const formattedName = newSectionName.trim().replace(/^#\s*/, '');
    const newId = `sec_${Date.now()}`;
    const newSec: GroupSection = {
      id: newId,
      name: formattedName,
      description: newSectionDesc.trim() || `Discussion space for #${formattedName}`,
      isPrivate: newSectionPrivate,
      allowedRoles: newSectionPrivate ? newSectionAllowedRoles : ['admin', 'moderator', 'controller', 'member'],
      allowedMemberIds: newSectionPrivate ? newSectionAllowedMembers : undefined
    };

    const updatedSections = [...sections, newSec];
    persistChannelUpdate({
      ...channel,
      sections: updatedSections
    });

    setSelectedSubChannelId(newId);
    setNewSectionName('');
    setNewSectionDesc('');
    setNewSectionPrivate(false);
    setNewSectionAllowedMembers([]);
    setShowAddSectionModal(false);
  };

  // Open Edit Sub-channel Modal
  const openEditSubChannel = (sec: GroupSection) => {
    setSectionToEdit(sec);
    setEditSectionName(sec.name);
    setEditSectionDesc(sec.description || '');
    setEditSectionPrivate(sec.isPrivate || false);
    setEditSectionAllowedRoles(sec.allowedRoles || ['admin', 'moderator']);
  };

  // Save Edited Sub-channel
  const handleSaveEditedSection = (e: React.FormEvent) => {
    e.preventDefault();
    if (!sectionToEdit || !channel || !onUpdateChannel) return;

    const formattedName = editSectionName.trim().replace(/^#\s*/, '');
    const updatedSections = sections.map((s) => {
      if (s.id === sectionToEdit.id) {
        return {
          ...s,
          name: formattedName,
          description: editSectionDesc.trim(),
          isPrivate: editSectionPrivate,
          allowedRoles: editSectionPrivate ? editSectionAllowedRoles : (['admin', 'moderator', 'controller', 'member'] as GroupRole[])
        };
      }
      return s;
    });

    persistChannelUpdate({
      ...channel,
      sections: updatedSections
    });

    setSectionToEdit(null);
  };

  // Confirm Delete Sub-channel
  const confirmDeleteSubChannel = () => {
    if (!sectionToDelete || !channel || !onUpdateChannel) return;

    if (sectionToDelete.id === 'sec_gen' || sectionToDelete.name.toLowerCase() === 'general') {
      alert(lang === 'bn' ? '# General মূল চ্যানেলটি ডিলিট করা যাবে না।' : 'The # General default channel cannot be deleted.');
      setSectionToDelete(null);
      return;
    }

    const updatedSections = sections.filter((s) => s.id !== sectionToDelete.id);
    persistChannelUpdate({
      ...channel,
      sections: updatedSections
    });

    setSelectedSubChannelId('sec_gen');
    setSectionToDelete(null);
  };

  const displayName = isDm ? recipientUser?.name || 'User' : channel?.name || 'Fullsnack Designers';
  const effectivePresence = getEffectiveUserPresence(recipientUser);

  const getPresenceIndicator = () => {
    if (!isDm) {
      // Honest counts only: derive from the persisted member ID list; no
      // invented online/member numbers.
      const count = channel ? resolveMemberIds(channel).length || channel.membersCount || 0 : 0;
      return count > 0 ? `${count} ${lang === 'bn' ? 'জন সদস্য' : 'members'}` : '';
    }

    if (effectivePresence === 'online') {
      return (
        <span className="flex items-center gap-1.5 text-online font-medium">
          <span className="w-2 h-2 rounded-full bg-online animate-pulse" />
          <span>{lang === 'bn' ? 'সরাসরি অনলাইন আছেন' : 'Online now'}</span>
        </span>
      );
    }

    if (effectivePresence === 'away') {
      return (
        <span className="flex items-center gap-1.5 text-away font-semibold">
          <span className="w-2 h-2 rounded-full bg-away" />
          <span>{lang === 'bn' ? 'সম্প্রতি অ্যাক্টিভ ছিলেন' : 'Away'}</span>
        </span>
      );
    }

    return (
      <span className="text-app-faint">
        {recipientUser?.lastSeen || (lang === 'bn' ? 'অফলাইন' : 'Offline')}
      </span>
    );
  };

  const displayAvatar = isDm
    ? recipientUser?.avatar
    : channel?.avatar || initialsAvatarDataUrl(channel?.name || 'Group');

  return (
    <div className="flex-1 flex flex-col h-full bg-app overflow-hidden relative select-none">
      {/* Hidden File Inputs */}
      <input type="file" ref={fileInputRef} onChange={handleImageUpload} accept="image/*" className="hidden" />
      <input type="file" ref={videoInputRef} onChange={handleVideoUpload} accept="video/*" className="hidden" />
      <input type="file" ref={docInputRef} onChange={handleDocUpload} className="hidden" />
      <input type="file" ref={groupImageInputRef} onChange={handleGroupImageFile} accept="image/*" className="hidden" />

      {/* Top Header — Phase 2 signature move: SOLID header (no backdrop
          filter re-filtering on every scroll frame); the peer/group identity
          floats in a .glass-pill inside it. Glass count: pill only. */}
      <div className="h-16 px-3 sm:px-4 bg-header border-b border-token flex items-center justify-between z-10 shrink-0">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 px-3 py-1.5 min-h-[44px] bg-surface hover:bg-pressed text-app rounded-xl transition-all font-semibold text-xs sm:text-sm active:scale-95"
            title="Go Back" aria-label="Go Back"
          >
            <ArrowLeft className="w-4 h-4 text-primary" />
            <span>{lang === 'bn' ? 'তালিকায় ফিরে যান' : 'Back'}</span>
          </button>

          <div
            onClick={() => {
              // DM header tap opens the peer's ProfileCard (1.4); group
              // headers keep opening GroupInfo.
              if (isDm && recipientUser) setProfileCardUser(profileCardForUser(recipientUser));
              else onOpenGroupInfo();
            }}
            className="glass-pill flex items-center gap-2.5 min-w-0 cursor-pointer group pl-1.5 pr-3.5 py-1.5 -ml-1.5"
          >
            <div className="relative shrink-0">
              <img
                src={displayAvatar}
                alt={displayName}
                className="w-10 h-10 rounded-full bg-pressed object-cover ring-2 ring-transparent group-hover:ring-(--c-primary) transition-all"
              />
              {isDm && (
                <span
                  className={`absolute bottom-0 right-0 w-3 h-3 rounded-full ring-2 ring-white  ${
                    effectivePresence === 'online'
                      ? 'bg-online'
                      : effectivePresence === 'away'
                      ? 'bg-away'
                      : 'hidden'
                  }`}
                />
              )}
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-app truncate">
                {displayName}
              </h2>
              <div className="text-xs text-app-2 truncate">{getPresenceIndicator()}</div>
            </div>
          </div>
        </div>

        {/* Action icons & 3-Dot Menu */}
        <div className="flex items-center gap-1 sm:gap-1.5 relative">
          <button
            onClick={() => {
              setSearchOpen(!searchOpen);
              if (searchOpen) setSearchQuery('');
            }}
            className={`p-2 min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-full hover:bg-pressed transition-colors ${
              searchOpen ? 'text-primary' : 'text-app-2'
            }`}
            title="Search in conversation" aria-label="Search in conversation"
           aria-expanded={searchOpen} >
            <Search className="w-5 h-5" />
          </button>
          {/* Phase 0.7: calls are 1:1 only — group rooms get NO call buttons
              (the old group button rang every online user). */}
          {isDm && (
            <>
              <button
                onClick={() => onStartCall('video')}
                className="p-2 min-w-[44px] min-h-[44px] inline-flex items-center justify-center text-app-2 rounded-full hover:bg-pressed transition-colors"
                title="Video Call" aria-label="Video Call"
              >
                <Video className="w-5 h-5" />
              </button>
              <button
                onClick={() => onStartCall('audio')}
                className="p-2 min-w-[44px] min-h-[44px] inline-flex items-center justify-center text-app-2 rounded-full hover:bg-pressed transition-colors"
                title="Audio Call" aria-label="Audio Call"
              >
                <Phone className="w-5 h-5" />
              </button>
            </>
          )}

          {/* 3-Dot More Icon */}
          <div className="relative">
            <button
              onClick={() => setShowThreeDotMenu(!showThreeDotMenu)}
              className="p-2 min-w-[44px] min-h-[44px] inline-flex items-center justify-center text-app-2 rounded-full hover:bg-pressed transition-colors"
              title="More Actions" aria-label="More Actions"
             aria-expanded={showThreeDotMenu} aria-haspopup="menu" >
              <MoreVertical className="w-5 h-5" />
            </button>

            {/* 3-Dot Dropdown Context Menu */}
            {showThreeDotMenu && (
              <div
                className="glass-sheet absolute right-0 top-full mt-2 w-64 max-h-[70vh] overflow-y-auto rounded-[var(--r-sheet)] py-2 z-30 text-app text-xs animate-in fade-in"
                style={{ animationDuration: 'var(--dur-sheet)', animationTimingFunction: 'var(--ease-spring)' }}
                onMouseLeave={() => setShowThreeDotMenu(false)}
               role="menu" >
                {!isDm && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowThreeDotMenu(false);
                      setShowImageChangeModal(true);
                    }}
                    className="w-full text-left px-3.5 py-2.5 hover:bg-bubble-in flex items-center gap-2.5 font-bold text-primary "
                  >
                    <Camera className="w-4 h-4" />
                    <span>{lang === 'bn' ? 'গ্রুপের ছবি পরিবর্তন করুন' : 'Change Group Image'}</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => {
                    setShowThreeDotMenu(false);
                    if (isDm && recipientUser) setProfileCardUser(profileCardForUser(recipientUser));
                    else onOpenGroupInfo();
                  }}
                  className="w-full text-left px-3.5 py-2 hover:bg-bubble-in flex items-center gap-2.5 font-medium"
                >
                  <Users className="w-4 h-4 text-app-2" />
                  <span>{isDm ? (lang === 'bn' ? 'ইউজার প্রোফাইল' : 'User Profile') : (lang === 'bn' ? 'গ্রুপ ইনফো ও মেম্বার' : 'Group Info & Members')}</span>
                </button>

                {isDm && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowThreeDotMenu(false);
                      setShowSharedMedia(true);
                    }}
                    className="w-full text-left px-3.5 py-2 hover:bg-bubble-in flex items-center gap-2.5 font-medium"
                  >
                    <ImageIcon className="w-4 h-4 text-primary" />
                    <span>{lang === 'bn' ? 'শেয়ার করা মিডিয়া' : 'Shared media'}</span>
                  </button>
                )}

                <div className="px-3.5 py-2">
                  <p className="flex items-center gap-2.5 font-medium text-app ">
                    <Download className="w-4 h-4 text-online" />
                    <span>{lang === 'bn' ? 'চ্যাট এক্সপোর্ট' : 'Export chat'}</span>
                  </p>
                  <div className="flex gap-1.5 mt-2">
                    {(['html', 'json', 'txt'] as const).map((fmt) => (
                      <button
                        key={fmt}
                        type="button"
                        onClick={() => {
                          setShowThreeDotMenu(false);
                          exportChat(fmt);
                        }}
                        className="px-2.5 py-1 rounded-full bg-bubble-in text-[11px] font-bold uppercase text-app-2 hover:bg-pressed transition-colors"
                      >
                        {fmt}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-app-faint mt-1.5 leading-snug">
                    {lang === 'bn' ? 'মুছে ফেলা মেসেজ বাদে পুরো চ্যাট ডাউনলোড হয়।' : 'Downloads this chat (deleted messages excluded).'}
                  </p>
                </div>

                {isDm && recipientUser && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setShowThreeDotMenu(false);
                        if (isRecipientBlocked) unblockUser(recipientUser.id);
                        else blockUser(recipientUser.id, recipientUser.name);
                      }}
                      className="w-full text-left px-3.5 py-2 hover:bg-bubble-in flex items-center gap-2.5 font-medium text-danger "
                    >
                      <Ban className="w-4 h-4" />
                      <span>
                        {isRecipientBlocked
                          ? lang === 'bn'
                            ? 'আনব্লক করুন'
                            : 'Unblock user'
                          : lang === 'bn'
                          ? 'ব্লক করুন'
                          : 'Block user'}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowThreeDotMenu(false);
                        reportUser(recipientUser.id, recipientUser.name);
                      }}
                      className="w-full text-left px-3.5 py-2 hover:bg-bubble-in flex items-center gap-2.5 font-medium text-danger "
                    >
                      <AlertTriangle className="w-4 h-4" />
                      <span>{lang === 'bn' ? 'রিপোর্ট করুন' : 'Report user'}</span>
                    </button>
                  </>
                )}

                {!isDm && canCreateSubchannel && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowThreeDotMenu(false);
                      setShowAddSectionModal(true);
                    }}
                    className="w-full text-left px-3.5 py-2 hover:bg-bubble-in flex items-center gap-2.5 font-medium text-app "
                  >
                    <Plus className="w-4 h-4 text-online" />
                    <span>{lang === 'bn' ? 'নতুন সাবচ্যানেল তৈরি করুন' : 'Add New Sub-channel'}</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => {
                    setShowThreeDotMenu(false);
                    onOpenOfflineQr();
                  }}
                  className="w-full text-left px-3.5 py-2 hover:bg-bubble-in flex items-center gap-2.5 font-medium"
                >
                  <QrCode className="w-4 h-4 text-primary" />
                  <span>{lang === 'bn' ? 'অফলাইন কিউআর ট্রান্সফার' : 'Offline QR Transfer'}</span>
                </button>

                <div className="border-t border-token mt-1 pt-2 px-3.5 pb-1">
                  <p className="flex items-center gap-2 font-bold text-app ">
                    <Timer className="w-4 h-4 text-danger" />
                    {lang === 'bn' ? 'ডিসঅ্যাপিয়ারিং মেসেজ' : 'Disappearing messages'}
                  </p>
                  <div className="flex gap-1.5 mt-2">
                    {[
                      { sec: 0, label: lang === 'bn' ? 'বন্ধ' : 'Off' },
                      { sec: 3600, label: '1h' },
                      { sec: 86400, label: '24h' },
                      { sec: 604800, label: '7d' },
                    ].map((opt) => (
                      <button
                        key={opt.sec}
                        type="button"
                        onClick={() => setRoomTtl(opt.sec)}
                        className={`px-2.5 py-1 rounded-full text-[11px] font-bold transition-all active:scale-95 ${
                          roomTtl === opt.sec
                            ? 'bg-danger text-white shadow-sm'
                            : 'bg-bubble-in  text-app-2  hover:bg-pressed '
                        }`}
                       aria-pressed={roomTtl === opt.sec} >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-app-faint mt-1.5 leading-snug">
                    {lang === 'bn'
                      ? 'চালু থাকলে নতুন মেসেজগুলো টাইমার শেষে নিজে নিজে মুছে যাবে।'
                      : 'When on, new messages delete themselves after the timer.'}
                  </p>
                </div>

                <div className="border-t border-token mt-1 pt-2 px-3.5 pb-2">
                  <p className="flex items-center gap-2 font-bold text-app ">
                    <ImageIcon className="w-4 h-4 text-primary" />
                    {lang === 'bn' ? 'চ্যাট ওয়ালপেপার' : 'Chat wallpaper'}
                  </p>
                  <div className="flex gap-1.5 mt-2">
                    {[
                      { id: 'default', label: lang === 'bn' ? 'ডিফল্ট' : 'Default' },
                      { id: 'dots', label: 'Dots' },
                      { id: 'ocean', label: 'Ocean' },
                      { id: 'sunset', label: 'Sunset' },
                      { id: 'forest', label: 'Forest' },
                    ].map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setWallpaper(opt.id)}
                        className={`px-2.5 py-1 rounded-full text-[11px] font-bold transition-all active:scale-95 ${
                          wallpaper === opt.id
                            ? 'bg-primary text-white shadow-sm'
                            : 'bg-bubble-in  text-app-2  hover:bg-pressed '
                        }`}
                       aria-pressed={wallpaper === opt.id} >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* In-chat search bar (v2, 1.9.2) */}
      {searchOpen && (
        <div className="bg-app border-b border-token animate-in slide-in-from-top-1 z-10 shrink-0">
          <div className="px-3 py-2 flex items-center gap-2">
            <Search className="w-4 h-4 text-app-faint shrink-0" />
            <input
              autoFocus
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  stepSearch(e.shiftKey ? -1 : 1);
                } else if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  stepSearch(1);
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  stepSearch(-1);
                } else if (e.key === 'Escape') {
                  setSearchOpen(false);
                  setSearchQuery('');
                }
              }}
              placeholder={
                lang === 'bn'
                  ? 'খুঁজুন... (from:, has:, before:, after:)'
                  : 'Search... (try from:name, has:image, before:2026-01-01)'
              }
              className="flex-1 bg-transparent text-base text-app placeholder:text-app-faint"
             aria-label={lang === 'bn' ? 'এই কথোপকথনে খুঁজুন' : 'Search in this conversation'} />
            {searchQuery.trim() && (
              <span className="text-[11px] font-bold text-primary whitespace-nowrap tabular-nums">
                {searchMatches.length === 0
                  ? lang === 'bn'
                    ? '০ টি ফলাফল'
                    : '0 results'
                  : `${searchIndex + 1} of ${searchMatches.length}`}
              </span>
            )}
            <button
              onClick={() => stepSearch(-1)}
              disabled={searchMatches.length === 0}
              className="p-1 text-app-faint hover:text-app-2 disabled:opacity-30"
              title={lang === 'bn' ? 'আগের ফলাফল' : 'Previous match (Shift+Enter)'} aria-label={lang === 'bn' ? 'আগের ফলাফল' : 'Previous match (Shift+Enter)'}
            >
              <ChevronUp className="w-4 h-4" />
            </button>
            <button
              onClick={() => stepSearch(1)}
              disabled={searchMatches.length === 0}
              className="p-1 text-app-faint hover:text-app-2 disabled:opacity-30"
              title={lang === 'bn' ? 'পরের ফলাফল' : 'Next match (Enter)'} aria-label={lang === 'bn' ? 'পরের ফলাফল' : 'Next match (Enter)'}
            >
              <ChevronDown className="w-4 h-4" />
            </button>
            <button
              onClick={() => {
                setSearchOpen(false);
                setSearchQuery('');
              }}
              className="p-1 text-app-faint hover:text-app-2 "
              title="Close search" aria-label="Close search"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="px-3 pb-2 flex items-center gap-1.5 flex-wrap">
            <div className="flex rounded-full bg-bubble-in p-0.5">
              {(
                [
                  { id: 'section', label: lang === 'bn' ? 'এই সেকশন' : 'This section' },
                  { id: 'room', label: lang === 'bn' ? 'পুরো রুম' : 'Whole room' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setSearchScope(opt.id)}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-bold transition-all ${
                    searchScope === opt.id
                      ? 'bg-app  text-primary shadow-sm'
                      : 'text-app-2 '
                  }`}
                 aria-pressed={searchScope === opt.id} >
                  {opt.label}
                </button>
              ))}
            </div>
            {(
              [
                { token: 'has:image', label: '🖼️ ' + (lang === 'bn' ? 'ছবি' : 'Images') },
                { token: 'has:file', label: '📄 ' + (lang === 'bn' ? 'ফাইল' : 'Files') },
                { token: 'has:link', label: '🔗 ' + (lang === 'bn' ? 'লিংক' : 'Links') },
                { token: 'has:poll', label: '📊 ' + (lang === 'bn' ? 'পোল' : 'Polls') },
              ] as const
            ).map((chip) => (
              <button
                key={chip.token}
                type="button"
                onClick={() => setSearchQuery(chip.token)}
                className={`px-2.5 py-1 rounded-full text-[11px] font-bold transition-all ${
                  searchQuery.trim() === chip.token
                    ? 'bg-primary text-white'
                    : 'bg-bubble-in  text-app-2  hover:bg-pressed '
                }`}
               aria-pressed={searchQuery.trim() === chip.token} >
                {chip.label}
              </button>
            ))}
            {(parsedSearch.from || parsedSearch.has || parsedSearch.before || parsedSearch.after) && (
              <span className="text-[10px] text-app-faint font-medium">
                {lang === 'bn' ? 'ফিল্টার চালু আছে' : 'Filters active'}
                {parsedSearch.from ? ` · from:${parsedSearch.from}` : ''}
                {parsedSearch.has ? ` · has:${parsedSearch.has}` : ''}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Pinned message banner */}
      {pinnedMsg && !searchOpen && (
        <div className="px-3 py-2 bg-surface border-b border-token flex items-center gap-2 z-10 shrink-0 animate-in fade-in">
          <Pin className="w-3.5 h-3.5 text-primary fill-current shrink-0" />
          <button
            className="flex-1 min-w-0 text-left"
            onClick={() => document.getElementById(`msg-${pinnedMsg.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
            title={lang === 'bn' ? 'পিন করা মেসেজে যান' : 'Jump to pinned message'} aria-label={lang === 'bn' ? 'পিন করা মেসেজে যান' : 'Jump to pinned message'}
          >
            <span className="block text-[10px] font-bold uppercase tracking-wide text-primary">
              {lang === 'bn' ? 'পিন করা মেসেজ' : 'Pinned message'}
            </span>
            <span className="block text-xs text-app-2 truncate">{snippetOf(pinnedMsg)}</span>
          </button>
          {onUpdateMessage && (
            <button
              onClick={() => onUpdateMessage(pinnedMsg.id, { pinned: false })}
              className="p-1 text-app-faint hover:text-danger"
              title={lang === 'bn' ? 'আনপিন' : 'Unpin'} aria-label={lang === 'bn' ? 'আনপিন' : 'Unpin'}
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* DISCORD-LIKE SUB-CHANNELS TABS & PERMISSION ACTION BAR                    */}
      {/* ========================================================================= */}
      {!isDm && channel?.isGroup && (
        <div className="bg-header border-b border-token px-3 py-2 flex items-center justify-between gap-2 overflow-hidden z-10 shrink-0">
          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5">
            {sections.map((sec) => {
              const isActive = activeSection.id === sec.id;
              const isDefaultGeneral = sec.id === 'sec_gen' || sec.name.toLowerCase() === 'general';

              return (
                <div
                  key={sec.id}
                  className={`flex items-center rounded-xl transition-all shrink-0 ${
                    isActive
                      ? 'bg-primary text-white'
                      : 'bg-bubble-in  text-app  hover:bg-pressed '
                  }`}
                >
                  {/* Channel Tab Click */}
                  <button
                    onClick={() => setSelectedSubChannelId(sec.id)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold active:scale-95 transition-transform"
                   aria-pressed={isActive} >
                    <Hash className={`w-3.5 h-3.5 ${isActive ? 'text-white/70' : 'text-primary'}`} />
                    <span>{sec.name}</span>
                    {sec.isPrivate && (
                      <Lock className={`w-3 h-3 ${isActive ? 'text-primary' : 'text-primary'}`} />
                    )}
                  </button>

                  {/* EDIT BUTTON (for Admin / users with canEditSubchannel permission) */}
                  {canEditSubchannel && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openEditSubChannel(sec);
                      }}
                      className={`p-1 transition-colors ${
                        isActive
                          ? 'text-white/70 hover:text-white hover:bg-white/20'
                          : 'text-app-faint hover:text-primary hover:bg-pressed '
                      }`}
                      title={lang === 'bn' ? `এডিট #${sec.name}` : `Edit #${sec.name}`} aria-label={lang === 'bn' ? `এডিট #${sec.name}` : `Edit #${sec.name}`}
                    >
                      <Edit2 className="w-2.5 h-2.5" />
                    </button>
                  )}

                  {/* DELETE BUTTON (for Admin / users with canDeleteSubchannel permission) */}
                  {canDeleteSubchannel && !isDefaultGeneral && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSectionToDelete(sec);
                      }}
                      className={`p-1 pr-2 rounded-r-xl transition-colors ${
                        isActive
                          ? 'text-white/70 hover:text-white hover:bg-white/20'
                          : 'text-app-faint hover:text-danger hover:bg-pressed '
                      }`}
                      title={lang === 'bn' ? `ডিলিট #${sec.name}` : `Delete #${sec.name}`} aria-label={lang === 'bn' ? `ডিলিট #${sec.name}` : `Delete #${sec.name}`}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              );
            })}

            {/* + Add New Sub-channel (if user has canCreateSubchannel) */}
            {canCreateSubchannel && (
              <button
                type="button"
                onClick={() => setShowAddSectionModal(true)}
                className="px-2.5 py-1.5 rounded-xl text-xs font-semibold bg-bubble-in hover:bg-bubble-in text-primary border border-dashed border-(--c-primary) whitespace-nowrap transition-all flex items-center gap-1 shrink-0"
                title="Create New Sub-channel" aria-label="Create New Sub-channel"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{lang === 'bn' ? 'সাবচ্যানেল' : 'Add Sub-channel'}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* SUB-CHANNEL DEDICATED HEADER BANNER                                       */}
      {/* ========================================================================= */}
      {!isDm && channel?.isGroup && (
        <div className="px-4 py-2 bg-surface border-b border-token flex items-center justify-between text-xs shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-6 h-6 rounded-lg bg-bubble-in text-primary flex items-center justify-center shrink-0">
              <Hash className="w-3.5 h-3.5" />
            </div>
            <div className="min-w-0">
              <span className="font-bold text-app truncate flex items-center gap-1">
                <span>#{activeSection.name}</span>
                {activeSection.isPrivate && (
                  <span className="text-[10px] text-primary bg-surface px-1.5 py-0.2 rounded-md border border-token flex items-center gap-0.5">
                    <Lock className="w-2.5 h-2.5" />
                    <span>Locked</span>
                  </span>
                )}
              </span>
              <p className="text-[11px] text-app-faint truncate">
                {activeSection.description || `Dedicated channel conversation for #${activeSection.name}`}
              </p>
            </div>
          </div>

          {/* Sub-channel Action Buttons: Edit and Delete */}
          <div className="flex items-center gap-1 shrink-0">
            {canEditSubchannel && (
              <button
                type="button"
                onClick={() => openEditSubChannel(activeSection)}
                className="text-xs text-primary hover:underline flex items-center gap-1 font-semibold px-2 py-1 rounded-lg hover:bg-bubble-in transition-colors"
                title="Edit Subchannel" aria-label="Edit Subchannel"
              >
                <Edit2 className="w-3 h-3" />
                <span>{lang === 'bn' ? 'এডিট' : 'Edit'}</span>
              </button>
            )}

            {canDeleteSubchannel && activeSection.id !== 'sec_gen' && (
              <button
                type="button"
                onClick={() => setSectionToDelete(activeSection)}
                className="text-xs text-danger hover:text-danger flex items-center gap-1 font-semibold px-2 py-1 rounded-lg hover:bg-surface transition-colors"
                title="Delete this sub-channel" aria-label="Delete this sub-channel"
              >
                <Trash2 className="w-3 h-3" />
                <span>{lang === 'bn' ? 'ডিলিট' : 'Delete'}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Messages Scroll Area */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4" style={WALLPAPERS[wallpaper] || {}}>
        {!hasAccessToActiveSection ? (
          <div className="max-w-md mx-auto my-8 p-6 bg-app border border-token rounded-[var(--r-card)] text-center space-y-3 shadow-xl animate-in fade-in">
            <div className="w-12 h-12 mx-auto rounded-2xl bg-surface text-primary flex items-center justify-center">
              <Lock className="w-6 h-6" />
            </div>
            <h3 className="text-base font-bold text-app">
              {lang === 'bn' ? `লক করা সাবচ্যানেল (# ${activeSection.name})` : `Locked Sub-channel (# ${activeSection.name})`}
            </h3>
            <p className="text-xs text-app-2 leading-relaxed">
              {lang === 'bn'
                ? 'এই সাবচ্যানেলটি লক অবস্থায় রয়েছে। শুধুমাত্র গ্রুপ এডমিন বা এই চ্যানেলে অনুমোদিত সদস্যরাই এই চ্যাট দেখতে ও কথা বলতে পারবেন।'
                : 'This sub-channel is private. Only group Admins, Moderators, or specifically authorized members can view and chat here.'}
            </p>
            <div className="pt-1">
              <button
                type="button"
                onClick={() => setSelectedSubChannelId('sec_gen')}
                className="px-4 py-2 bg-primary text-white rounded-xl text-xs font-bold shadow-md "
              >
                {lang === 'bn' ? '# General চ্যানেলে যান' : 'Back to # General'}
              </button>
            </div>
          </div>
        ) : subChannelMessages.length === 0 ? (
          <div className="py-12 text-center space-y-2">
            <div className="w-12 h-12 mx-auto rounded-2xl bg-bubble-in text-primary flex items-center justify-center">
              <Hash className="w-6 h-6" />
            </div>
            <h4 className="text-sm font-bold text-app ">
              {lang === 'bn' ? `স্বাগতম #${activeSection.name} সাবচ্যানেলে!` : `Welcome to #${activeSection.name}!`}
            </h4>
            <p className="text-xs text-app-faint max-w-xs mx-auto">
              {lang === 'bn'
                ? 'এখানে এখনো কোনো মেসেজ দেওয়া হয়নি। আপনার প্রথম মেসেজ পাঠিয়ে চ্যাট শুরু করুন!'
                : 'No messages in this sub-channel yet. Send the first message to start the discussion!'}
            </p>
          </div>
        ) : (
          visibleMessages.map((msg, idx) => {
            const isMe = msg.senderId === currentUser.id;
            // Date chip whenever the calendar day changes (and before the first)
            const prevMsg = idx > 0 ? visibleMessages[idx - 1] : undefined;
            const showDateSeparator =
              !prevMsg || !sameCalendarDay(new Date(msg.timestamp), new Date(prevMsg.timestamp));

            return (
              <React.Fragment key={msg.id}>
                {showDateSeparator && (
                  <div className="flex justify-center my-2">
                    <span className="px-2.5 py-1 rounded-full bg-surface text-[11px] font-medium text-app-2">
                      {dateSeparatorLabel(msg.timestamp)}
                    </span>
                  </div>
                )}
              <div
                id={`msg-${msg.id}`}
                className={`animate-bubble-in flex flex-col ${isMe ? 'items-end' : 'items-start'} space-y-1 group/msg ${
                  highlightMsgId === msg.id
                    ? 'ring-2 ring-(--c-primary) rounded-2xl transition-all [transition-duration:var(--dur-sheet)] [transition-timing-function:var(--ease-spring)]'
                    : searchActive && searchMatchIds.has(msg.id)
                      ? 'ring-1 ring-(--c-primary) rounded-2xl'
                      : ''
                }`}
              >
                {!isMe && (
                  <div className="flex items-center gap-2 px-1">
                    <span className="text-xs font-semibold text-app-2">
                      {msg.senderName}
                    </span>
                    {msg.isAdmin && (
                      <span className="text-[10px] font-semibold text-app-faint lowercase">admin</span>
                    )}
                  </div>
                )}

                <div
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (!msg.deletedAt) setActionMsg(msg);
                  }}
                  onTouchStart={() => startLongPress(msg)}
                  onTouchEnd={cancelLongPress}
                  onTouchMove={cancelLongPress}
                  onTouchCancel={cancelLongPress}
                  className={`relative max-w-[85%] sm:max-w-[75%] px-3.5 py-2.5 text-[length:var(--fs-bubble)] leading-[var(--lh-bubble)] ${
                    isMe
                      ? 'bg-primary text-white rounded-[var(--r-bubble)] rounded-br-[4px]'
                      : 'bg-bubble-in text-app rounded-[var(--r-bubble)] rounded-bl-[4px]'
                  } ${msg.pinned ? 'ring-2 ring-(--c-primary)' : ''}`}
                >
                  {/* Hover action button — opens the message action sheet */}
                  {!msg.deletedAt && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setActionMsg(msg);
                      }}
                      className={`absolute -top-2 ${isMe ? '-left-2' : '-right-2'} w-6 h-6 rounded-full bg-app border border-token shadow-md flex items-center justify-center text-app-2 opacity-0 group-hover/msg:opacity-100 hover:text-primary transition-opacity z-10`}
                      title={lang === 'bn' ? 'মেসেজ অ্যাকশন' : 'Message actions'} aria-label={lang === 'bn' ? 'মেসেজ অ্যাকশন' : 'Message actions'}
                    >
                      <ChevronDown className="w-3.5 h-3.5" />
                    </button>
                  )}

                  {msg.deletedAt ? (
                    <p className={`flex items-center gap-1.5 italic ${isMe ? 'text-white/80' : 'text-app-faint'}`}>
                      <Ban className="w-3.5 h-3.5" />
                      {lang === 'bn' ? 'এই মেসেজটি মুছে ফেলা হয়েছে' : 'This message was deleted'}
                    </p>
                  ) : (
                    <>
                      {msg.forwardedFrom && (
                        <p className={`flex items-center gap-1 text-[10px] font-semibold mb-1 ${isMe ? 'text-white/70' : 'text-app-faint'}`}>
                          <Forward className="w-3 h-3" />
                          {lang === 'bn' ? 'ফরোয়ার্ড করা' : 'Forwarded'} · {msg.forwardedFrom}
                        </p>
                      )}

                      {msg.storyRef && !msg.replyTo && (
                        <p className={`mb-1.5 flex items-center gap-1 text-[10px] font-bold ${isMe ? 'text-white/80' : 'text-app-faint'}`}>
                          <ReplyIcon className="w-3 h-3" />
                          {lang === 'bn' ? 'একটি স্টোরির রিপ্লাই' : 'Reply to a story'}
                        </p>
                      )}

                      {msg.replyTo && (() => {
                        // Universal quote chip (1.2): every quoted type gets
                        // a faithful preview — media quotes show a thumbnail
                        // or a typed label from the ORIGINAL message (looked
                        // up by id), never a raw object dump.
                        const original = messages.find((m) => m.id === msg.replyTo!.id);
                        const qType = original?.type || msg.replyTo.type;
                        const thumbUrl =
                          original && (qType === 'image' || qType === 'sticker') && !original.deletedAt
                            ? safeMediaUrl(original.content)
                            : null;
                        return (
                          <div
                            onClick={() => {
                              if (original) jumpToMessage(original);
                            }}
                            title={lang === 'bn' ? 'মূল মেসেজে যান' : 'Jump to original'}
                            className={`mb-1.5 px-2.5 py-1.5 rounded-lg border-l-4 cursor-pointer flex items-center gap-2 ${isMe ? 'bg-white/15 border-white/60' : 'bg-white/60 dark:bg-white/10 border-(--c-primary)'}`}
                          >
                            {thumbUrl && (
                              <img src={thumbUrl} alt="" className="w-9 h-9 rounded-md object-cover shrink-0" />
                            )}
                            <div className="min-w-0">
                              <p className={`text-[10px] font-bold bn-safe ${isMe ? 'text-white' : 'text-primary'}`}>{msg.replyTo.senderName}</p>
                              <p className={`text-[11px] truncate bn-safe ${isMe ? 'text-white/85' : 'text-app-2'}`}>
                                {qType === 'audio'
                                  ? `🎤 ${lang === 'bn' ? 'ভয়েস মেসেজ' : 'Voice message'}${original?.duration ? ` · ${formatVoiceTime(original.duration)}` : ''}`
                                  : qType === 'video'
                                    ? `🎬 ${lang === 'bn' ? 'ভিডিও' : 'Video'}`
                                    : qType === 'file'
                                      ? `📄 ${original?.fileName || msg.replyTo.snippet}`
                                      : qType === 'poll'
                                        ? `📊 ${original?.poll?.question || msg.replyTo.snippet}`
                                        : msg.replyTo.snippet}
                              </p>
                            </div>
                          </div>
                        );
                      })()}
                    </>
                  )}

                  {!msg.deletedAt && msg.type === 'text' &&
                    (msg.sticker ? (
                      <p className="text-5xl leading-tight py-1 animate-in zoom-in-50 duration-300">{msg.content}</p>
                    ) : (
                      <p className="whitespace-pre-wrap bn-safe">{renderRichText(msg.content, isMe)}</p>
                    ))}

                  {/* Bundled-pack sticker messages (1.6): transparent image,
                      ~120px, no bubble fill emphasis */}
                  {!msg.deletedAt && (msg.type === 'sticker' || (msg.type === 'image' && msg.sticker)) && (
                    <img
                      src={safeMediaUrl(msg.content)}
                      alt={msg.fileName || 'Sticker'}
                      className="w-[120px] h-[120px] object-contain my-1 animate-in zoom-in-50 duration-300"
                      loading="lazy"
                    />
                  )}

                  {/* Contact card (1.4): tappable — opens the shared contact's
                      ProfileCard resolved by username */}
                  {!msg.deletedAt && (msg.type === 'contact' || msg.contactCard) && msg.contactCard && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openProfileForUsername(msg.contactCard!);
                      }}
                      className="flex items-center gap-3 p-2.5 pr-4 rounded-xl bg-white/70 dark:bg-white/10 text-app my-1 text-left hover:bg-white dark:hover:bg-white/15 transition-colors"
                    >
                      <span className="w-10 h-10 rounded-full bg-[#0B6E4F] text-white flex items-center justify-center shrink-0 overflow-hidden">
                        {(() => {
                          const cu = users.find((u) => (u.username || '').toLowerCase() === msg.contactCard!.toLowerCase());
                          return cu?.avatar ? (
                            <img src={cu.avatar} alt="" className="w-full h-full object-cover" />
                          ) : (
                            <UserIcon className="w-5 h-5" />
                          );
                        })()}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-xs font-bold truncate">
                          {users.find((u) => (u.username || '').toLowerCase() === msg.contactCard!.toLowerCase())?.name ||
                            `@${msg.contactCard}`}
                        </span>
                        <span className="block text-[11px] text-app-2 truncate">@{msg.contactCard}</span>
                        <span className="block text-[10px] font-semibold text-primary">
                          {lang === 'bn' ? 'প্রোফাইল দেখুন' : 'View profile'}
                        </span>
                      </span>
                    </button>
                  )}

                  {!msg.deletedAt && msg.type === 'poll' && msg.poll && (() => {
                    // Closed polls are read-only; anonymous polls never expose
                    // voterIds anywhere in the UI (counts/percentages only).
                    const pollClosed = !!(msg.poll.closesAt && Date.now() > msg.poll.closesAt);
                    // Server anonymises voterIds for non-admins (contract v1):
                    // counts come from voterCount when present; "you voted"
                    // can only be derived from voterIds when they are present.
                    const optCount = (o: NonNullable<ChatMessage['poll']>['options'][number]) =>
                      o.voterCount ?? o.voterIds.length;
                    const pollTotal = msg.poll.options.reduce((a, o) => a + optCount(o), 0);
                    // Quiz mode (1.2): correct/incorrect is revealed ONLY
                    // after this user has voted. correctOptionId travels
                    // with the message (see PollData note) — this reveal is
                    // a UX rule, not secrecy.
                    const quizRevealed = !!(msg.poll.quiz && msg.poll.correctOptionId && pollHasMyVote(msg));
                    const myQuizPickCorrect = quizRevealed && (myPollVotes[msg.id] || []).includes(msg.poll.correctOptionId!);
                    return (
                    <div className="min-w-55 sm:min-w-65">
                      <p className="font-bold flex items-center gap-1.5 mb-2">
                        <BarChart3 className="w-4 h-4" />
                        {msg.poll.question}
                        {msg.poll.quiz && (
                          <span className={`flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full ${isMe ? 'bg-white/20 text-white' : 'bg-bubble-in  text-primary '}`}>
                            <Award className="w-3 h-3" />
                            {lang === 'bn' ? 'কুইজ' : 'Quiz'}
                          </span>
                        )}
                      </p>
                      <div className="space-y-1.5">
                        {msg.poll.options.map((opt) => {
                          const total = pollTotal;
                          const count = optCount(opt);
                          const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                          const mine =
                            (opt.voterIds || []).includes(currentUser.id) ||
                            (myPollVotes[msg.id] || []).includes(opt.id);
                          const isQuizCorrect = quizRevealed && opt.id === msg.poll!.correctOptionId;
                          const isQuizWrongPick = quizRevealed && mine && opt.id !== msg.poll!.correctOptionId;
                          return (
                            <button
                              key={opt.id}
                              disabled={pollClosed}
                              onClick={() => votePoll(msg, opt.id)}
                              className={`relative w-full text-left px-2.5 py-2 rounded-xl overflow-hidden border transition-all active:scale-[0.99] ${
                                pollClosed ? 'opacity-60 cursor-not-allowed' : ''
                              } ${
                                isQuizCorrect
                                  ? 'border-(--c-online) ring-1 ring-(--c-online)'
                                  : isQuizWrongPick
                                    ? 'border-(--c-danger) ring-1 ring-(--c-danger)'
                                    : isMe
                                      ? 'border-white/50 hover:border-white'
                                      : 'border-token  hover:border-(--c-primary)'
                              }`}
                            >
                              <span
                                className={`absolute inset-y-0 left-0 transition-all duration-500 ${
                                  isQuizCorrect
                                    ? 'bg-online'
                                    : isQuizWrongPick
                                      ? 'bg-danger'
                                      : isMe
                                        ? 'bg-white/25'
                                        : 'bg-primary opacity-15'
                                }`}
                                style={{ width: `${pct}%` }}
                              />
                              <span className="relative flex items-center justify-between gap-2">
                                <span className="flex items-center gap-1.5 font-medium">
                                  {mine && <Check className="w-3.5 h-3.5" />}
                                  {opt.text}
                                  {isQuizCorrect && (
                                    <span className="text-[10px] font-bold text-online ">
                                      ✓ {lang === 'bn' ? 'সঠিক' : 'Correct'}
                                    </span>
                                  )}
                                  {isQuizWrongPick && (
                                    <span className="text-[10px] font-bold text-danger ">
                                      ✗ {lang === 'bn' ? 'আপনার উত্তর' : 'Your answer'}
                                    </span>
                                  )}
                                </span>
                                <span className="text-[11px] font-bold opacity-80">{total > 0 ? `${pct}% · ${count}` : '0'}</span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                      <p className={`mt-1.5 text-[10px] ${isMe ? 'text-white/75' : 'text-app-faint'}`}>
                        {pollClosed
                          ? lang === 'bn'
                            ? `পোল বন্ধ · ${pollTotal} ভোট`
                            : `Poll closed · ${pollTotal} votes`
                          : `${pollTotal} ${lang === 'bn' ? 'ভোট · ট্যাপ করে ভোট দিন' : 'votes · tap an option to vote'}`}
                      </p>
                      {!pollClosed && msg.poll.closesAt && (
                        <p className={`text-[10px] ${isMe ? 'text-white/70' : 'text-app-faint'}`}>
                          {lang === 'bn' ? 'বন্ধ হবে' : 'Closes'} {formatClockTime(msg.poll.closesAt, lang)} ·{' '}
                          {new Date(msg.poll.closesAt).toLocaleString(lang === 'bn' ? 'bn-BD' : 'en-US', { day: 'numeric', month: 'short' })}
                        </p>
                      )}
                      {msg.poll.anonymous && (
                        <p className={`text-[10px] ${isMe ? 'text-white/70' : 'text-app-faint'}`}>
                          {lang === 'bn' ? 'বেনামী ভোট' : 'Anonymous voting'}
                        </p>
                      )}
                      {msg.poll.quiz && (
                        <p className={`text-[10px] font-semibold ${isMe ? 'text-white/80' : 'text-primary '}`}>
                          {quizRevealed
                            ? myQuizPickCorrect
                              ? lang === 'bn'
                                ? '🎉 আপনি সঠিক উত্তর দিয়েছেন!'
                                : '🎉 You got it right!'
                              : lang === 'bn'
                                ? 'সঠিক উত্তরটি সবুজে দেখানো হয়েছে'
                                : 'The correct answer is highlighted'
                            : lang === 'bn'
                              ? 'ভোট দিলে সঠিক উত্তর দেখা যাবে'
                              : 'Vote to reveal the correct answer'}
                        </p>
                      )}
                    </div>
                    );
                  })()}

                  {!msg.deletedAt && msg.type === 'file' && (
                    <div className="flex items-center gap-3 p-2 bg-white/70 dark:bg-white/10 rounded-xl my-1 text-app">
                      <div className="p-2 bg-primary text-white rounded-lg">
                        <FileText className="w-5 h-5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-bold text-xs truncate">{msg.fileName || 'Shared Document'}</p>
                        <p className="text-[10px] text-app-faint font-mono">{msg.fileSize || 'File'}</p>
                      </div>
                      <a
                        href={safeMediaUrl(msg.content)}
                        download={msg.fileName || 'download'}
                        className="p-1.5 text-primary hover:bg-pressed rounded-lg transition-colors"
                        title="Download File"
                      >
                        <Download className="w-4 h-4" />
                      </a>
                    </div>
                  )}

                  {!msg.deletedAt && msg.type === 'offline_qr' && (
                    <div className="p-3 bg-white/70 dark:bg-white/10 rounded-xl my-1 space-y-2 text-app">
                      <div className="flex items-center gap-2 text-primary font-bold text-xs">
                        <QrCode className="w-4 h-4" />
                        <span>{lang === 'bn' ? 'অফলাইন কিউআর প্যাকেজ' : 'Offline QR Transferred Packet'}</span>
                      </div>
                      <div className="font-mono text-[11px] p-2 bg-app rounded-lg border border-token break-all">
                        {msg.content}
                      </div>
                    </div>
                  )}

                  {!msg.deletedAt && msg.type === 'image' && !msg.sticker &&
                    (dataSaver && !revealedMedia.has(msg.id) ? (
                      <button
                        onClick={() => setRevealedMedia((prev) => new Set(prev).add(msg.id))}
                        className="flex items-center gap-2 px-3 py-2.5 my-1 rounded-xl bg-white/70 dark:bg-white/10 text-app-2 text-xs font-semibold hover:bg-pressed transition-colors"
                      >
                        <ImageIcon className="w-4 h-4" />
                        {lang === 'bn' ? 'ছবি — লোড করতে ট্যাপ করুন (ডেটা সেভার)' : 'Photo — tap to load (data saver)'}
                      </button>
                    ) : (
                      <div
                        onClick={() => onPreviewMedia(safeMediaUrl(msg.content), 'image', msg.fileName)}
                        className="cursor-pointer rounded-xl overflow-hidden my-1 max-w-sm"
                      >
                        <img src={safeMediaUrl(msg.content)} alt="Shared" loading={dataSaver ? 'lazy' : undefined} className="w-full object-cover max-h-72 hover:scale-[1.02] transition-transform" />
                      </div>
                    ))}

                  {!msg.deletedAt && msg.type === 'video' && (
                    <div className="rounded-xl overflow-hidden my-1 max-w-sm">
                      <video src={safeMediaUrl(msg.content)} controls preload={dataSaver ? 'none' : undefined} className="w-full max-h-72 object-cover" />
                    </div>
                  )}

                  {!msg.deletedAt && msg.type === 'audio' && (
                    <VoiceWaveformPlayer src={safeMediaUrl(msg.content)} messageId={msg.id} isMe={isMe} durationHint={msg.duration} dataSaver={dataSaver} />
                  )}

                  <div
                    className={`flex items-center justify-end gap-1 mt-1 text-[11px] ${
                      isMe ? 'text-white/70' : 'text-app-2'
                    }`}
                  >
                    <span>
                      {formatClockTime(msg.timestamp, lang)}
                    </span>
                    {msg.editedAt && !msg.deletedAt && (
                      <span className="italic">{lang === 'bn' ? 'এডিট করা' : 'edited'}</span>
                    )}
                    {msg.expiresAt && !msg.deletedAt && (
                      <span className="flex items-center gap-0.5 font-semibold" title={lang === 'bn' ? 'এই মেসেজটি নিজে নিজে মুছে যাবে' : 'This message will disappear'}>
                        <Timer className="w-3 h-3" />
                        {ttlRemainingLabel(msg.expiresAt)}
                      </span>
                    )}
                    {msg.pinned && <Pin className={`w-3 h-3 fill-current ${isMe ? 'text-white/85' : 'text-primary'}`} />}
                    {starredIds.has(msg.id) && <Star className={`w-3 h-3 fill-current ${isMe ? 'text-white/85' : 'text-primary'}`} />}
                    {isMe &&
                      (msg.status === 'read' ? (
                        <CheckCheck className="w-3.5 h-3.5 text-white/80" />
                      ) : msg.status === 'delivered' ? (
                        <CheckCheck className="w-3.5 h-3.5 opacity-90" />
                      ) : (
                        <Check className="w-3.5 h-3.5 opacity-90" />
                      ))}
                  </div>
                </div>

                {/* Reaction chips */}
                {!msg.deletedAt && msg.reactions && Object.keys(msg.reactions).length > 0 && (
                  <div className={`flex flex-wrap gap-1 px-1 ${isMe ? 'justify-end' : 'justify-start'}`}>
                    {Object.entries(msg.reactions).map(([emoji, voterIds]) =>
                      voterIds.length > 0 ? (
                        <button
                          key={emoji}
                          onClick={() => setReactionSheetMsg(msg)}
                          className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] font-bold border transition-all active:scale-95 ${
                            voterIds.includes(currentUser.id)
                              ? 'bg-bubble-in border-(--c-primary) text-primary'
                              : 'bg-app border-token text-app-2'
                          }`}
                          title={lang === 'bn' ? 'রিঅ্যাকশন' : 'Reaction'} aria-label={lang === 'bn' ? 'রিঅ্যাকশন' : 'Reaction'}
                        >
                          <span>{emoji}</span>
                          <span>{voterIds.length}</span>
                        </button>
                      ) : null
                    )}
                  </div>
                )}
              </div>
              </React.Fragment>
            );
          })
        )}

        {searchActive && searchMatches.length === 0 && hasAccessToActiveSection && (
          <div className="py-10 text-center space-y-2 animate-in fade-in">
            <Search className="w-8 h-8 mx-auto text-app-faint " />
            <p className="text-sm font-bold text-app-2 ">
              {lang === 'bn' ? 'কিছু পাওয়া যায়নি' : 'No results found'}
            </p>
            <p className="text-xs text-app-faint">“{searchQuery}”</p>
          </div>
        )}

        {/* Typing indicator (live from socket) — names rendered for groups:
            "X is typing…" / "X and Y are typing…" / "X and N others…" */}
        {Object.values(typingUsers).length > 0 && (() => {
          const names = Object.values(typingUsers).map((t) => t.name);
          const typingLabel =
            names.length === 1
              ? lang === 'bn'
                ? `${names[0]} টাইপ করছেন...`
                : `${names[0]} is typing...`
              : names.length === 2
                ? lang === 'bn'
                  ? `${names[0]} ও ${names[1]} টাইপ করছেন...`
                  : `${names[0]} and ${names[1]} are typing...`
                : lang === 'bn'
                  ? `${names[0]} ও আরও ${names.length - 1} জন টাইপ করছেন...`
                  : `${names[0]} and ${names.length - 1} others are typing...`;
          return (
            <div className="flex items-center gap-2 animate-in fade-in">
              <div className="bg-bubble-in rounded-[var(--r-bubble)] rounded-bl-[4px] px-3.5 py-2.5 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
              <span className="text-[11px] text-app-2 font-medium">{typingLabel}</span>
            </div>
          );
        })()}

        {/* Pending upload bubbles (1.6): real XHR progress while the file
            goes to POST /api/uploads */}
        {pendingUploads.map((p) => (
          <div key={p.id} className="flex flex-col items-end space-y-1 animate-in fade-in">
            <div className="max-w-[85%] sm:max-w-[75%] px-3.5 py-2.5 rounded-[var(--r-bubble)] rounded-br-[4px] bg-primary text-white text-[length:var(--fs-bubble)] leading-[var(--lh-bubble)]">
              <p className="flex items-center gap-2 font-semibold">
                {p.kind === 'image' ? <ImageIcon className="w-4 h-4" /> : p.kind === 'video' ? <Video className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
                <span className="truncate max-w-[180px]">{p.name}</span>
                <span className="tabular-nums opacity-80">{Math.round(p.progress * 100)}%</span>
              </p>
              <div className="mt-1.5 h-1.5 rounded-full bg-white/25 overflow-hidden">
                <div className="h-full bg-white rounded-full transition-all duration-200" style={{ width: `${Math.round(p.progress * 100)}%` }} />
              </div>
              <p className="text-[10px] text-white/70 mt-1">{lang === 'bn' ? 'আপলোড হচ্ছে...' : 'Uploading...'}</p>
            </div>
          </div>
        ))}

        <div ref={messagesEndRef} />
      </div>

      {/* Bottom Bar: Chat Input Area for the active sub-channel */}
      <div className="px-3 pb-3 pt-2 space-y-2 shrink-0">
        {/* Server/local schedule outcome notice (1.8) */}
        {scheduleNotice && (
          <div
            className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-semibold animate-in slide-in-from-bottom-1 ${
              scheduleNotice.kind === 'server'
                ? 'bg-surface  border-token  text-online '
                : 'bg-surface  border-token  text-primary '
            }`}
          >
            <Clock className="w-4 h-4 shrink-0" />
            <span className="flex-1">{scheduleNotice.text}</span>
            <button onClick={() => setScheduleNotice(null)} className="p-0.5 opacity-70 hover:opacity-100" title={lang === 'bn' ? 'বন্ধ করুন' : 'Dismiss'} aria-label={lang === 'bn' ? 'বন্ধ করুন' : 'Dismiss'}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
        {/* Star / reminder / save feedback */}
        {actionNotice && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-bubble-in border border-(--c-primary) text-xs font-semibold text-primary animate-in slide-in-from-bottom-1">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span className="flex-1">{actionNotice}</span>
            <button onClick={() => setActionNotice(null)} className="p-0.5 opacity-70 hover:opacity-100" title={lang === 'bn' ? 'বন্ধ করুন' : 'Dismiss'} aria-label={lang === 'bn' ? 'বন্ধ করুন' : 'Dismiss'}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
        {/* Upload guardrail error (oversize file rejected before it hits the wire) */}
        {uploadError && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-surface border border-token text-xs font-semibold text-danger animate-in slide-in-from-bottom-1">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span className="flex-1">{uploadError}</span>
            <button onClick={() => setUploadError(null)} className="p-0.5 hover:text-danger" title={lang === 'bn' ? 'বন্ধ করুন' : 'Dismiss'} aria-label={lang === 'bn' ? 'বন্ধ করুন' : 'Dismiss'}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
        {/* Scheduled messages waiting to be sent in this room */}
        {scheduledMessages.length > 0 && (
          <div className="space-y-1.5">
            {scheduledMessages.map((s) =>
              s.failed ? (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    // Retry: prefer the owner's retry handler; otherwise
                    // re-fire the message now and clear the queued item.
                    if (onRetryScheduled) {
                      onRetryScheduled(s.id);
                    } else {
                      onSendMessage(s.content, 'text', { sectionId: activeSection.id });
                      onCancelScheduled?.(s.id);
                    }
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-xl bg-surface border-l-4 border-(--c-danger) animate-in slide-in-from-bottom-1 text-left"
                  title={lang === 'bn' ? 'আবার পাঠাতে ট্যাপ করুন' : 'Tap to retry'} aria-label={lang === 'bn' ? 'আবার পাঠাতে ট্যাপ করুন' : 'Tap to retry'}
                >
                  <AlertTriangle className="w-4 h-4 text-danger shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] font-bold text-danger ">
                      {lang === 'bn' ? 'পাঠানো যায়নি — আবার চেষ্টা করতে ট্যাপ করুন' : 'Failed — tap to retry'}
                    </p>
                    <p className="text-xs text-app-2 truncate">{s.content}</p>
                  </div>
                </button>
              ) : (
                <div key={s.id} className="flex items-center gap-2 px-3 py-2 rounded-xl bg-bubble-in border-l-4 border-(--c-primary) animate-in slide-in-from-bottom-1">
                  <Clock className="w-4 h-4 text-[#F2A007] shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] font-bold text-primary ">
                      {lang === 'bn' ? 'সময় নির্ধারিত' : 'Scheduled'} ·{' '}
                      {new Date(s.sendAt).toLocaleString(lang === 'bn' ? 'bn-BD' : undefined, {
                        day: 'numeric',
                        month: 'short',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </p>
                    <p className="text-xs text-app-2 truncate">{s.content}</p>
                  </div>
                  <button onClick={() => onCancelScheduled?.(s.id)} className="p-1 text-app-faint hover:text-danger" title={lang === 'bn' ? 'বাতিল' : 'Cancel scheduled message'} aria-label={lang === 'bn' ? 'বাতিল' : 'Cancel scheduled message'}>
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )
            )}
          </div>
        )}

        {/* @mention autocomplete */}
        {mentionCandidates.length > 0 && (
          <div className="glass rounded-[var(--r-card)] overflow-hidden animate-in slide-in-from-bottom-1">
            {mentionCandidates.map((c) => (
              <button
                key={c.id}
                onClick={() => pickMention(c.username)}
                className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-bubble-in transition-colors"
              >
                <span className="w-7 h-7 rounded-full bg-primary text-white flex items-center justify-center text-xs font-black shrink-0">
                  {c.username === 'all' ? '@' : c.name.charAt(0)}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-bold text-app truncate">@{c.username}</span>
                  <span className="block text-[11px] text-app-faint truncate">{c.name}</span>
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Composer media panel (1.6): emoji stickers / bundled SVG packs / GIFs */}
        {showStickers && (
          <div className="glass rounded-[var(--r-card)] p-3 animate-in slide-in-from-bottom-1">
            <div className="flex items-center gap-1.5 pb-2.5">
              {(
                [
                  { id: 'emoji', label: lang === 'bn' ? 'ইমোজি' : 'Emoji' },
                  { id: 'packs', label: lang === 'bn' ? 'স্টিকার প্যাক' : 'Sticker packs' },
                  { id: 'gif', label: 'GIF' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setMediaPanelTab(tab.id)}
                  className={`px-3 py-1.5 rounded-full text-[11px] font-bold transition-all ${
                    mediaPanelTab === tab.id
                      ? 'bg-primary text-white shadow-sm'
                      : 'bg-bubble-in  text-app-2  hover:bg-pressed '
                  }`}
                 aria-pressed={mediaPanelTab === tab.id} >
                  {tab.label}
                </button>
              ))}
            </div>

            {mediaPanelTab === 'emoji' && (
              <div className="grid grid-cols-5 sm:grid-cols-10 gap-1">
                {STICKERS.map((s) => (
                  <button
                    key={s}
                    onClick={() => {
                      onSendMessage(s, 'text', { sectionId: activeSection.id, sticker: true });
                      setShowStickers(false);
                    }}
                    className="text-3xl p-1.5 rounded-xl hover:bg-bubble-in hover:scale-110 active:scale-95 transition-transform"
                    title={lang === 'bn' ? 'স্টিকার পাঠান' : 'Send sticker'}
                   aria-label={lang === 'bn' ? `স্টিকার পাঠান ${s}` : `Send sticker ${s}`} >
                    {s}
                  </button>
                ))}
              </div>
            )}

            {mediaPanelTab === 'packs' && (
              <div>
                <div className="flex gap-1.5 pb-2 overflow-x-auto no-scrollbar">
                  {STICKER_PACKS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setActivePackId(p.id)}
                      className={`px-2.5 py-1 rounded-full text-[11px] font-bold whitespace-nowrap transition-all ${
                        activePackId === p.id
                          ? 'bg-primary text-white'
                          : 'bg-bubble-in  text-app-2 '
                      }`}
                     aria-pressed={activePackId === p.id} >
                      {lang === 'bn' ? p.nameBn : p.name}
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-4 sm:grid-cols-8 gap-1.5">
                  {(STICKER_PACKS.find((p) => p.id === activePackId) || STICKER_PACKS[0])?.stickers.map((st) => (
                    <button
                      key={st.id}
                      onClick={() => {
                        // Sent as image media carrying the sticker flag +
                        // pack provenance (App passes sticker through; the
                        // pack/id fields ride the extended meta).
                        onSendMessage(st.url, 'image', {
                          sectionId: activeSection.id,
                          sticker: true,
                          fileName: st.name,
                          stickerPack: activePackId,
                          stickerId: st.id,
                          mimeType: 'image/svg+xml',
                        });
                        setShowStickers(false);
                      }}
                      className="p-1.5 rounded-xl hover:bg-bubble-in hover:scale-110 active:scale-95 transition-transform"
                      title={st.name} aria-label={st.name}
                    >
                      <img src={st.url} alt={st.name} className="w-full aspect-square object-contain" loading="lazy" />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {mediaPanelTab === 'gif' &&
              (() => {
                const cfg = gifConfig();
                if (!cfg) {
                  // Designed empty state — GIFs need a provider key; there is
                  // deliberately NO fake feed here.
                  return (
                    <div className="py-8 text-center space-y-2">
                      <div className="w-11 h-11 mx-auto rounded-2xl bg-bubble-in text-primary flex items-center justify-center text-sm font-black">
                        GIF
                      </div>
                      <p className="text-sm font-bold text-app ">
                        {lang === 'bn' ? 'GIF কনফিগার করা হয়নি' : "GIFs aren't configured"}
                      </p>
                      <p className="text-xs text-app-faint max-w-xs mx-auto leading-relaxed">
                        {lang === 'bn'
                          ? 'GIF পাঠাতে একটি GIF প্রোভাইডার (Klipy বা Giphy) API কী দরকার। অ্যাডমিন VITE_GIF_PROVIDER ও VITE_GIF_API_KEY সেট করলে এখানে GIF খোঁজা যাবে।'
                          : 'Sending GIFs needs a GIF provider API key (Klipy or Giphy). Once an admin sets VITE_GIF_PROVIDER and VITE_GIF_API_KEY, search will appear here.'}
                      </p>
                    </div>
                  );
                }
                return (
                  <div>
                    <input
                      value={gifQuery}
                      onChange={(e) => setGifQuery(e.target.value)}
                      placeholder={lang === 'bn' ? 'GIF খুঁজুন...' : 'Search GIFs...'}
                      className="w-full bg-bubble-in rounded-xl px-3 py-2 text-base text-app placeholder:text-app-faint mb-2"
                     aria-label={lang === 'bn' ? 'GIF খুঁজুন' : 'Search GIFs'} />
                    {gifLoading ? (
                      <p className="py-8 text-center text-xs text-app-faint font-medium">
                        {lang === 'bn' ? 'লোড হচ্ছে...' : 'Loading GIFs...'}
                      </p>
                    ) : gifResults.length === 0 ? (
                      <p className="py-8 text-center text-xs text-app-faint font-medium">
                        {lang === 'bn' ? 'কোনো GIF পাওয়া যায়নি' : 'No GIFs found'}
                      </p>
                    ) : (
                      <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5 max-h-56 overflow-y-auto">
                        {gifResults.map((g) => (
                          <button
                            key={g.id}
                            onClick={() => {
                              onSendMessage(g.url, 'image', {
                                sectionId: activeSection.id,
                                fileName: g.title || 'GIF',
                                mimeType: 'image/gif',
                                replyTo: activeReplyRef,
                              });
                              setReplyToMsg(null);
                              setPendingReplyRef(null);
                              setShowStickers(false);
                            }}
                            className="rounded-xl overflow-hidden hover:opacity-85 active:scale-95 transition-all"
                            title={g.title} aria-label={g.title}
                          >
                            <img src={g.previewUrl} alt={g.title} className="w-full h-20 object-cover" loading="lazy" />
                          </button>
                        ))}
                      </div>
                    )}
                    <p className="text-[10px] text-app-faint pt-2 capitalize">
                      {lang === 'bn' ? 'প্রদানকারী' : 'Powered by'} {cfg.provider}
                    </p>
                  </div>
                );
              })()}
          </div>
        )}

        {/* Reply preview banner (also covers draft-restored reply refs) */}
        {(replyToMsg || pendingReplyRef) && !editingMsg && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-surface border-l-4 border-(--c-primary) animate-in slide-in-from-bottom-1">
            <ReplyIcon className="w-4 h-4 text-primary shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-bold text-primary bn-safe">
                {lang === 'bn' ? 'রিপ্লাই দিচ্ছেন' : 'Replying to'}{' '}
                {replyToMsg ? replyToMsg.senderName : pendingReplyRef!.senderName}
              </p>
              <p className="text-xs text-app-2 truncate bn-safe">
                {replyToMsg ? snippetOf(replyToMsg) : pendingReplyRef!.snippet}
              </p>
            </div>
            <button
              onClick={() => {
                setReplyToMsg(null);
                setPendingReplyRef(null);
                writeDraft(text, null);
              }}
              className="p-1 text-app-faint hover:text-danger"
              title="Cancel reply" aria-label="Cancel reply"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Edit banner */}
        {editingMsg && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-surface border-l-4 border-(--c-primary) animate-in slide-in-from-bottom-1">
            <Edit2 className="w-4 h-4 text-primary shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-bold text-primary ">{lang === 'bn' ? 'মেসেজ এডিট করছেন' : 'Editing message'}</p>
              <p className="text-xs text-app-2 truncate">{editingMsg.content}</p>
            </div>
            <button
              onClick={() => {
                // Cancelling an edit restores the room's stored draft into
                // the composer (1.8) instead of clearing it.
                setEditingMsg(null);
                restoreDraftIntoComposer();
              }}
              className="p-1 text-app-faint hover:text-danger"
              title="Cancel edit" aria-label="Cancel edit"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {isRecipientBlocked ? (
          <div className="flex items-center justify-between bg-surface border border-token rounded-full px-4 py-2.5 text-xs text-danger animate-in fade-in">
            <span className="flex items-center gap-2 font-semibold">
              <Ban className="w-4 h-4 shrink-0" />
              <span>{lang === 'bn' ? 'আপনি এই ব্যবহারকারীকে ব্লক করেছেন' : 'You blocked this user'}</span>
            </span>
            <button
              onClick={() => recipientUser && unblockUser(recipientUser.id)}
              className="px-3 py-1 bg-danger text-white rounded-full font-bold shadow-xs hover:bg-danger transition-colors"
            >
              {lang === 'bn' ? 'আনব্লক' : 'Unblock'}
            </button>
          </div>
        ) : composerGateReason ? (
          <div className="flex items-center gap-2.5 bg-bubble-in border border-token rounded-full px-4 py-3 text-xs font-semibold text-app-2 animate-in fade-in">
            <Lock className="w-4 h-4 shrink-0 text-app-faint" />
            <span>{composerGateReason}</span>
          </div>
        ) : isRecording ? (
          <div className="flex items-center justify-between bg-surface border border-token rounded-full px-4 py-2 text-xs text-danger animate-in fade-in">
            <span className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-danger animate-ping" />
              <span>
                {lang === 'bn' ? 'ভয়েস রেকর্ড হচ্ছে...' : 'Recording voice note...'} ({formatVoiceTime(recordingSeconds)})
              </span>
            </span>
            <button
              onClick={stopRecording}
              className="px-3 py-1 bg-danger text-white rounded-full font-bold shadow-xs hover:bg-danger transition-colors"
            >
              {lang === 'bn' ? 'পাঠান' : 'Send Voice'}
            </button>
          </div>
        ) : (
          // Composer bar — Phase 2: ONE glass surface; the textarea inside is
          // a solid token surface with concentric radius (inner = outer −
          // inset: var(--r-card) − 6px padding).
          <div className="glass flex items-center gap-1.5 relative rounded-[var(--r-card)] p-1.5">
            {showAttachMenu && (
              <div
                className="absolute bottom-full mb-2 left-0 glass rounded-[var(--r-card)] p-2 z-30 flex items-center gap-2 sm:gap-3 animate-in fade-in zoom-in-95 flex-wrap"
                onMouseLeave={() => setShowAttachMenu(false)}
              >
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex flex-col items-center gap-1 p-2 text-app hover:text-primary rounded-xl hover:bg-bubble-in transition-colors text-xs"
                  title="Send Image" aria-label="Send Image"
                >
                  <ImageIcon className="w-5 h-5 text-primary" />
                  <span>{lang === 'bn' ? 'ছবি' : 'Image'}</span>
                </button>

                <button
                  onClick={() => videoInputRef.current?.click()}
                  className="flex flex-col items-center gap-1 p-2 text-app hover:text-primary rounded-xl hover:bg-bubble-in transition-colors text-xs"
                  title="Send Video" aria-label="Send Video"
                >
                  <Video className="w-5 h-5 text-online" />
                  <span>{lang === 'bn' ? 'ভিডিও' : 'Video'}</span>
                </button>

                <button
                  onClick={() => {
                    setShowAttachMenu(false);
                    onOpenCamera();
                  }}
                  className="flex flex-col items-center gap-1 p-2 text-app hover:text-primary rounded-xl hover:bg-bubble-in transition-colors text-xs"
                  title="Take Camera Photo" aria-label="Take Camera Photo"
                >
                  <Camera className="w-5 h-5 text-primary" />
                  <span>{lang === 'bn' ? 'ক্যামেরা' : 'Camera'}</span>
                </button>

                <button
                  onClick={() => docInputRef.current?.click()}
                  className="flex flex-col items-center gap-1 p-2 text-app hover:text-primary rounded-xl hover:bg-bubble-in transition-colors text-xs"
                  title="Send Document" aria-label="Send Document"
                >
                  <FileText className="w-5 h-5 text-primary" />
                  <span>{lang === 'bn' ? 'ফাইল' : 'Document'}</span>
                </button>

                <button
                  onClick={() => {
                    setShowAttachMenu(false);
                    onOpenOfflineQr();
                  }}
                  className="flex flex-col items-center gap-1 p-2 text-app hover:text-primary rounded-xl hover:bg-bubble-in transition-colors text-xs"
                  title="Offline QR Share" aria-label="Offline QR Share"
                >
                  <QrCode className="w-5 h-5 text-danger" />
                  <span>{lang === 'bn' ? 'অফলাইন QR' : 'Offline QR'}</span>
                </button>

                <button
                  onClick={() => {
                    setShowAttachMenu(false);
                    setShowPollModal(true);
                  }}
                  className="flex flex-col items-center gap-1 p-2 text-app hover:text-primary rounded-xl hover:bg-bubble-in transition-colors text-xs"
                  title="Create Poll" aria-label="Create Poll"
                >
                  <BarChart3 className="w-5 h-5 text-primary" />
                  <span>{lang === 'bn' ? 'পোল' : 'Poll'}</span>
                </button>

                <button
                  onClick={() => {
                    setShowAttachMenu(false);
                    setShowStickers((prev) => !prev);
                  }}
                  className="flex flex-col items-center gap-1 p-2 text-app hover:text-primary rounded-xl hover:bg-bubble-in transition-colors text-xs"
                  title="Send Sticker" aria-label="Send Sticker"
                >
                  <Smile className="w-5 h-5 text-primary" />
                  <span>{lang === 'bn' ? 'স্টিকার' : 'Sticker'}</span>
                </button>
              </div>
            )}

            <button
              onClick={() => setShowAttachMenu(!showAttachMenu)}
              disabled={composerDisabled}
              className="p-2 min-w-[44px] min-h-[44px] inline-flex items-center justify-center text-app-2 rounded-full hover:bg-pressed transition-colors disabled:opacity-40"
              title="Attach File / Media" aria-label="Attach File / Media"
             aria-expanded={showAttachMenu} aria-haspopup="menu" >
              <Paperclip className="w-5 h-5" />
            </button>

            <textarea
              ref={composerRef}
              rows={1}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                // While editing an existing message, the text is not a draft —
                // saving it would resurrect the edited text as a "draft" later.
                if (!editingMsg) saveDraft(e.target.value);
                notifyTyping();
              }}
              onKeyDown={handleKeyDown}
              disabled={composerDisabled}
              placeholder={
                !hasAccessToActiveSection
                  ? lang === 'bn'
                    ? '🔒 এই সাবচ্যানেলটি আপনার রোলের জন্য লক করা'
                    : '🔒 This sub-channel is locked for your role'
                  : isDm
                  ? lang === 'bn'
                    ? `${channel?.name ?? ''} কে মেসেজ লিখুন...`
                    : `Message ${channel?.name ?? ''}...`
                  : lang === 'bn'
                  ? `# ${activeSection.name} এ মেসেজ লিখুন...`
                  : `Message in #${activeSection.name}...`
              }
              className="flex-1 bg-surface border-none rounded-[calc(var(--r-card)-6px)] px-3 py-2.5 text-base text-app placeholder:text-app-faint disabled:opacity-50 resize-none overflow-y-auto max-h-[120px] leading-snug"
             aria-label={lang === 'bn' ? 'মেসেজ লিখুন' : 'Type a message'} />

            {text.trim() && !editingMsg ? (
              <button
                onClick={() => {
                  const d = new Date(Date.now() + 3600000);
                  d.setSeconds(0, 0);
                  setScheduleAt(toDatetimeLocal(d));
                  setShowSchedule(true);
                }}
                disabled={composerDisabled}
                className="p-2 min-w-[44px] min-h-[44px] inline-flex items-center justify-center text-[#F2A007] hover:bg-pressed rounded-full transition-colors disabled:opacity-40"
                title={lang === 'bn' ? 'পরে পাঠান (শিডিউল)' : 'Schedule message'} aria-label={lang === 'bn' ? 'পরে পাঠান (শিডিউল)' : 'Schedule message'}
              >
                <Clock className="w-5 h-5" />
              </button>
            ) : null}

            {text.trim() ? (
              <button
                onClick={handleSend}
                disabled={composerDisabled}
                className="p-2.5 min-w-[44px] min-h-[44px] inline-flex items-center justify-center bg-[#0B6E4F] hover:bg-[#095C42] text-white rounded-full transition-all shadow-soft active:scale-95 disabled:opacity-40 shrink-0"
                title="Send Message" aria-label="Send Message"
              >
                <Send className="w-[18px] h-[18px]" />
              </button>
            ) : (
              <button
                onClick={startRecording}
                disabled={composerDisabled}
                className="p-2 min-w-[44px] min-h-[44px] inline-flex items-center justify-center text-app-2 rounded-full hover:bg-pressed transition-colors disabled:opacity-40"
                title="Record Voice Note" aria-label="Record Voice Note"
              >
                <Mic className="w-5 h-5" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Schedule message modal */}
      {showSchedule && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 animate-in fade-in">
          <div className="glass-sheet rounded-[var(--r-sheet)] w-full max-w-sm p-5 space-y-4" role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'মেসেজ শিডিউল করুন' : 'Schedule message'} >
            <div className="flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-black text-app">
                <Clock className="w-4.5 h-4.5 text-[#F2A007]" />
                {lang === 'bn' ? 'মেসেজ শিডিউল করুন' : 'Schedule message'}
              </h3>
              <button onClick={() => setShowSchedule(false)} className="p-1 text-app-faint hover:text-danger" aria-label={lang === 'bn' ? 'বন্ধ করুন' : 'Close'} >
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-xs text-app-2 bg-surface rounded-xl px-3 py-2 truncate">“{text.trim()}”</p>
            <p className="flex items-start gap-1.5 text-[11px] leading-snug text-online bg-surface border border-token rounded-xl px-3 py-2">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span>
                {lang === 'bn'
                  ? 'মেসেজটি সার্ভারে শিডিউল হবে — Chitthi বন্ধ থাকলেও নির্ধারিত সময়ে পাঠানো হবে। সার্ভারে পৌঁছানো না গেলে শুধুমাত্র তখনই এই ডিভাইসে কিউ হবে (সেক্ষেত্রে অ্যাপ খোলা থাকতে হবে)।'
                  : 'This message is scheduled on the server — it will send at the set time even if you close Chitthi. Only if the server is unreachable will it queue on this device instead (then the app must stay open).'}
              </span>
            </p>
            <div className="flex gap-1.5">
              {[
                { label: lang === 'bn' ? '১ ঘণ্টা পরে' : 'In 1 hour', ms: 3600000 },
                { label: lang === 'bn' ? 'আজ রাত ৯টা' : 'Tonight 9 PM', ms: -1 },
                { label: lang === 'bn' ? 'কাল সকাল ৯টা' : 'Tomorrow 9 AM', ms: -2 },
              ].map((chip) => (
                <button
                  key={chip.label}
                  onClick={() => {
                    const d = new Date();
                    if (chip.ms > 0) d.setTime(Date.now() + chip.ms);
                    else {
                      d.setHours(21, 0, 0, 0);
                      if (chip.ms === -2 || d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
                      if (chip.ms === -2) d.setHours(9, 0, 0, 0);
                    }
                    d.setSeconds(0, 0);
                    setScheduleAt(toDatetimeLocal(d));
                  }}
                  className="px-2.5 py-1.5 rounded-full bg-bubble-in text-primary text-[11px] font-bold hover:bg-bubble-in transition-colors"
                >
                  {chip.label}
                </button>
              ))}
            </div>
            <input
              type="datetime-local"
              value={scheduleAt}
              min={new Date(Date.now() + 60000).toISOString().slice(0, 16)}
              onChange={(e) => setScheduleAt(e.target.value)}
              className="w-full bg-surface border border-token rounded-xl px-3 py-2.5 text-sm text-app "
             aria-label={lang === 'bn' ? 'পাঠানোর সময়' : 'Scheduled send time'} />
            <button
              onClick={confirmSchedule}
              disabled={!scheduleAt || new Date(scheduleAt).getTime() <= Date.now() || scheduling}
              className="w-full py-2.5 bg-primary hover:bg-primary disabled:opacity-40 text-white rounded-xl text-sm font-bold shadow-md active:scale-[0.99] transition-all"
            >
              {scheduling
                ? lang === 'bn'
                  ? 'শিডিউল হচ্ছে...'
                  : 'Scheduling...'
                : lang === 'bn'
                  ? 'এই সময়ে পাঠাও'
                  : 'Send at this time'}
            </button>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* EDIT SUB-CHANNEL MODAL (For users with canEditSubchannel permission)      */}
      {/* ========================================================================= */}
      {sectionToEdit && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 animate-in fade-in select-none">
          <div className="glass-sheet rounded-[var(--r-sheet)] w-full max-w-md p-6 space-y-4" role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'সাবচ্যানেল এডিট' : 'Edit sub-channel'} >
            <div className="flex items-center justify-between pb-2 border-b border-token ">
              <div className="flex items-center gap-2">
                <Edit2 className="w-5 h-5 text-primary" />
                <h3 className="text-base font-bold text-app">
                  {lang === 'bn' ? `সাবচ্যানেল এডিট (${sectionToEdit.name})` : `Edit Sub-channel (#${sectionToEdit.name})`}
                </h3>
              </div>
              <button
                onClick={() => setSectionToEdit(null)}
                className="p-1 text-app-faint hover:text-app rounded-lg"
               aria-label={lang === 'bn' ? 'বন্ধ করুন' : 'Close'} >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveEditedSection} className="space-y-3.5">
              <div>
                <label className="block text-xs font-semibold text-app mb-1">
                  {lang === 'bn' ? 'সাবচ্যানেলের নাম' : 'Sub-channel Name'}
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-app-faint font-bold">#</span>
                  <input
                    type="text"
                    value={editSectionName}
                    onChange={(e) => setEditSectionName(e.target.value)}
                    required
                    className="w-full bg-surface border border-token rounded-xl pl-8 pr-4 py-2.5 text-xs text-app "
                   aria-label={lang === 'bn' ? 'সাবচ্যানেলের নাম' : 'Sub-channel Name'} />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-app mb-1">
                  {lang === 'bn' ? 'চ্যানেলের উদ্দেশ্য / বিবরণ' : 'Description / Topic'}
                </label>
                <input
                  type="text"
                  value={editSectionDesc}
                  onChange={(e) => setEditSectionDesc(e.target.value)}
                  placeholder="e.g. Design review discussions"
                  className="w-full bg-surface border border-token rounded-xl px-3 py-2 text-xs text-app "
                 aria-label={lang === 'bn' ? 'চ্যানেলের উদ্দেশ্য / বিবরণ' : 'Description / Topic'} />
              </div>

              {/* Private / Locked Channel Switch */}
              <div className="p-3 rounded-2xl bg-surface border border-token flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <Lock className="w-4 h-4 text-primary" />
                  <div>
                    <p className="text-xs font-bold text-app ">
                      {lang === 'bn' ? 'লকড / প্রাইভেট চ্যানেল' : 'Private Locked Channel'}
                    </p>
                    <p className="text-[10px] text-app-faint">
                      {lang === 'bn' ? 'অনুমোদিত ছাড়া কেউ ঢুকতে পারবে না' : 'Restricted access only'}
                    </p>
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={editSectionPrivate}
                  onChange={(e) => setEditSectionPrivate(e.target.checked)}
                  className="w-4 h-4 accent-(--c-primary) rounded cursor-pointer"
                 aria-label={lang === 'bn' ? 'লকড / প্রাইভেট চ্যানেল' : 'Private Locked Channel'} />
              </div>

              {/* Roles allowed */}
              {editSectionPrivate && (
                <div className="space-y-2 animate-in fade-in">
                  <label className="block text-xs font-semibold text-app ">
                    {lang === 'bn' ? 'অনুমোদিত রোলসমূহ:' : 'Allowed Roles:'}
                  </label>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    {(['admin', 'moderator', 'controller', 'member'] as GroupRole[]).map((role) => (
                      <label
                        key={role}
                        className="flex items-center gap-2 p-2 rounded-xl bg-surface border border-token cursor-pointer capitalize font-medium text-app "
                      >
                        <input
                          type="checkbox"
                          checked={editSectionAllowedRoles.includes(role)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setEditSectionAllowedRoles([...editSectionAllowedRoles, role]);
                            } else {
                              setEditSectionAllowedRoles(editSectionAllowedRoles.filter((r) => r !== role));
                            }
                          }}
                          className="w-3.5 h-3.5 accent-(--c-primary) rounded"
                        />
                        <span>{role}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setSectionToEdit(null)}
                  className="px-4 py-2 text-xs font-semibold text-app-2 hover:text-app"
                >
                  {lang === 'bn' ? 'বাতিল' : 'Cancel'}
                </button>
                <button
                  type="submit"
                  className="px-5 py-2.5 bg-primary hover:bg-primary text-white rounded-xl text-xs font-bold shadow-md transition-all"
                >
                  {lang === 'bn' ? 'সংরক্ষণ করুন' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* DELETE SUB-CHANNEL MODAL (For users with canDeleteSubchannel permission)   */}
      {/* ========================================================================= */}
      {sectionToDelete && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 animate-in fade-in select-none">
          <div className="glass-sheet rounded-[var(--r-sheet)] w-full max-w-sm p-6 space-y-4 text-center" role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'সাবচ্যানেল ডিলিট' : 'Delete sub-channel'} >
            <div className="w-14 h-14 mx-auto rounded-2xl bg-surface text-danger flex items-center justify-center shadow-inner">
              <Trash2 className="w-7 h-7" />
            </div>

            <div>
              <h3 className="text-base font-bold text-app">
                {lang === 'bn' ? `সাবচ্যানেল #${sectionToDelete.name} ডিলিট করবেন?` : `Delete #${sectionToDelete.name}?`}
              </h3>
              <p className="text-xs text-app-2 mt-1 leading-relaxed">
                {lang === 'bn'
                  ? `আপনি কি নিশ্চিতভাবে এই সাবচ্যানেলটি ডিলিট করতে চান? এই চ্যানেলের সকল মেসেজ স্থায়ীভাবে মুছে যাবে।`
                  : `Are you sure you want to delete this sub-channel? All messages within #${sectionToDelete.name} will be permanently removed.`}
              </p>
            </div>

            <div className="flex items-center gap-2 pt-2">
              <button
                type="button"
                onClick={() => setSectionToDelete(null)}
                className="flex-1 py-2.5 bg-bubble-in text-app rounded-xl text-xs font-semibold hover:bg-pressed transition-colors"
              >
                {lang === 'bn' ? 'বাতিল' : 'Cancel'}
              </button>
              <button
                type="button"
                onClick={confirmDeleteSubChannel}
                className="flex-1 py-2.5 bg-danger hover:bg-danger text-white rounded-xl text-xs font-bold shadow-md transition-all"
              >
                {lang === 'bn' ? 'ডিলিট করুন' : 'Delete Sub-channel'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* CHANGE GROUP IMAGE MODAL                                                  */}
      {/* ========================================================================= */}
      {showImageChangeModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 animate-in fade-in select-none">
          <div className="glass-sheet rounded-[var(--r-sheet)] w-full max-w-md p-6 space-y-4" role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'গ্রুপের ছবি পরিবর্তন করুন' : 'Change Group Image'} >
            <div className="flex items-center justify-between pb-2 border-b border-token ">
              <h3 className="text-base font-bold text-app flex items-center gap-2">
                <Camera className="w-5 h-5 text-primary" />
                <span>{lang === 'bn' ? 'গ্রুপের ছবি পরিবর্তন করুন' : 'Change Group Image'}</span>
              </h3>
              <button
                onClick={() => setShowImageChangeModal(false)}
                className="p-1 text-app-faint hover:text-app rounded-lg"
               aria-label={lang === 'bn' ? 'বন্ধ করুন' : 'Close'} >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div>
              <button
                type="button"
                onClick={() => groupImageInputRef.current?.click()}
                className="w-full py-3 bg-bubble-in border border-(--c-primary) text-primary hover:bg-bubble-in rounded-2xl text-xs font-bold flex items-center justify-center gap-2 transition-all shadow-xs"
              >
                <Camera className="w-4 h-4" />
                <span>{lang === 'bn' ? 'ডিভাইস থেকে ছবি আপলোড করুন' : 'Upload Image from Device'}</span>
              </button>
            </div>

            <div>
              <p className="text-xs font-semibold text-app-2 mb-2">
                {lang === 'bn' ? 'অথবা নিচের ছবিগুলো থেকে নির্বাচন করুন:' : 'Or choose from presets:'}
              </p>
              <div className="grid grid-cols-5 gap-2">
                {CURATED_GROUP_AVATARS.map((url, idx) => (
                  <div
                    key={idx}
                    onClick={() => handleSelectCuratedAvatar(url)}
                    className="aspect-square rounded-xl overflow-hidden cursor-pointer ring-2 ring-transparent hover:ring-(--c-primary) hover:scale-105 transition-all shadow-xs"
                  >
                    <img src={url} alt="Cover option" className="w-full h-full object-cover" />
                  </div>
                ))}
              </div>
            </div>

            <div className="pt-2 text-right">
              <button
                type="button"
                onClick={() => setShowImageChangeModal(false)}
                className="px-4 py-2 text-xs font-semibold text-app-2 hover:text-app"
              >
                {lang === 'bn' ? 'বন্ধ করুন' : 'Close'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MESSAGE ACTION SHEET (reactions, reply, pin, copy, edit, forward, delete) */}
      {/* ========================================================================= */}
      {actionMsg && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center p-0 sm:p-4 animate-in fade-in" onClick={() => setActionMsg(null)}>
          <div
            className="glass-sheet w-full sm:max-w-sm rounded-t-[var(--r-sheet)] sm:rounded-[var(--r-sheet)] p-4 animate-in slide-in-from-bottom-4 space-y-1" style={{ animationDuration: 'var(--dur-sheet)', animationTimingFunction: 'var(--ease-spring)' }}
            onClick={(e) => e.stopPropagation()}
           role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'মেসেজ অ্যাকশন' : 'Message actions'} >
            {/* Quick reactions */}
            <div className="flex items-center justify-between px-1 pb-3">
              {['❤️', '👍', '😂', '😮', '😢', '🙏'].map((emoji) => (
                <button
                  key={emoji}
                  onClick={() => {
                    onToggleReaction?.(actionMsg, emoji);
                    setActionMsg(null);
                  }}
                  className={`text-2xl p-2 rounded-full transition-all hover:scale-125 active:scale-95 ${
                    actionMsg.reactions?.[emoji]?.includes(currentUser.id) ? 'bg-bubble-in  ring-2 ring-(--c-primary)' : 'hover:bg-bubble-in '
                  }`}
                 aria-label={`React with ${emoji}`} aria-pressed={actionMsg.reactions?.[emoji]?.includes(currentUser.id)} >
                  {emoji}
                </button>
              ))}
            </div>

            <div className="border-t border-token pt-1">
              <button
                onClick={() => {
                  setReplyToMsg(actionMsg);
                  setPendingReplyRef(null);
                  // Drafts keep the reply (1.8): picking a reply writes it
                  // into the room's stored draft immediately.
                  writeDraft(text, replyRefOf(actionMsg));
                  setActionMsg(null);
                }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-pressed text-sm font-medium text-app"
              >
                <ReplyIcon className="w-4 h-4 text-primary" /> {lang === 'bn' ? 'রিপ্লাই' : 'Reply'}
              </button>

              <button
                onClick={() => {
                  void toggleStar(actionMsg);
                  setActionMsg(null);
                }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-pressed text-sm font-medium text-app"
              >
                <Star className={`w-4 h-4 text-primary ${starredIds.has(actionMsg.id) ? 'fill-current' : ''}`} />
                {starredIds.has(actionMsg.id)
                  ? lang === 'bn'
                    ? 'স্টার সরান'
                    : 'Unstar'
                  : lang === 'bn'
                    ? 'স্টার করুন'
                    : 'Star'}
              </button>

              <button
                onClick={() => {
                  // One-tap Save into Saved Messages via the existing
                  // saved-room send path (App's forward handler keeps the
                  // saved room local-only).
                  onForwardMessage?.(
                    { ...actionMsg, editedAt: undefined, expiresAt: undefined },
                    'saved_messages'
                  );
                  setActionNotice(lang === 'bn' ? 'সেভ করা মেসেজে সংরক্ষিত হয়েছে' : 'Saved to Saved Messages');
                  setActionMsg(null);
                }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-pressed text-sm font-medium text-app"
              >
                <BookmarkCheck className="w-4 h-4 text-primary" /> {lang === 'bn' ? 'সেভ করুন' : 'Save'}
              </button>

              <button
                onClick={() => {
                  setRemindMsg(actionMsg);
                  setActionMsg(null);
                }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-pressed text-sm font-medium text-app"
              >
                <Bell className="w-4 h-4 text-danger" /> {lang === 'bn' ? 'মনে করিয়ে দিন' : 'Remind me'}
              </button>

              {actionMsg.senderId === currentUser.id && (
                <button
                  onClick={() => {
                    setInfoMsg(actionMsg);
                    setActionMsg(null);
                  }}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-pressed text-sm font-medium text-app"
                >
                  <Info className="w-4 h-4 text-app-2" /> {lang === 'bn' ? 'মেসেজের তথ্য' : 'Info'}
                </button>
              )}

              <button
                onClick={() => {
                  onUpdateMessage?.(actionMsg.id, { pinned: !actionMsg.pinned });
                  setActionMsg(null);
                }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-pressed text-sm font-medium text-app"
              >
                <Pin className="w-4 h-4 text-primary" /> {actionMsg.pinned ? (lang === 'bn' ? 'আনপিন করুন' : 'Unpin message') : lang === 'bn' ? 'পিন করুন' : 'Pin message'}
              </button>

              {actionMsg.type === 'text' && (
                <button
                  onClick={() => {
                    navigator.clipboard?.writeText(actionMsg.content).catch(() => {});
                    setActionMsg(null);
                  }}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-pressed text-sm font-medium text-app"
                >
                  <Copy className="w-4 h-4 text-app-2" /> {lang === 'bn' ? 'কপি' : 'Copy text'}
                </button>
              )}

              <button
                onClick={() => {
                  setForwardMsg(actionMsg);
                  setActionMsg(null);
                }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-pressed text-sm font-medium text-app"
              >
                <Forward className="w-4 h-4 text-online" /> {lang === 'bn' ? 'ফরোয়ার্ড' : 'Forward'}
              </button>

              {actionMsg.senderId === currentUser.id && actionMsg.type === 'text' && Date.now() - actionMsg.timestamp <= 15 * 60 * 1000 && (
                <button
                  onClick={() => {
                    setEditingMsg(actionMsg);
                    setText(actionMsg.content);
                    setActionMsg(null);
                  }}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-pressed text-sm font-medium text-app"
                >
                  <Edit2 className="w-4 h-4 text-primary" /> {lang === 'bn' ? 'এডিট (১৫ মিনিটের মধ্যে)' : 'Edit (within 15 min)'}
                </button>
              )}

              {(actionMsg.senderId === currentUser.id || isUserAdmin) && (
                <button
                  onClick={() => {
                    onDeleteMessage?.(actionMsg.id);
                    setActionMsg(null);
                  }}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-surface text-sm font-medium text-danger "
                >
                  <Trash2 className="w-4 h-4" /> {lang === 'bn' ? 'সবার জন্য ডিলিট' : 'Delete for everyone'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Forward picker */}
      {forwardMsg && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center p-0 sm:p-4 animate-in fade-in" onClick={() => setForwardMsg(null)}>
          <div className="glass-sheet w-full sm:max-w-sm rounded-t-[var(--r-sheet)] sm:rounded-[var(--r-sheet)] p-4 animate-in slide-in-from-bottom-4 max-h-[75vh] flex flex-col" style={{ animationDuration: 'var(--dur-sheet)', animationTimingFunction: 'var(--ease-spring)' }} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'ফরোয়ার্ড করুন' : 'Forward message'} >
            <h3 className="text-sm font-bold text-app flex items-center gap-2 pb-2">
              <Forward className="w-4 h-4 text-online" /> {lang === 'bn' ? 'ফরোয়ার্ড করুন...' : 'Forward to...'}
            </h3>
            <p className="text-xs text-app-2 truncate pb-2 border-b border-token ">{snippetOf(forwardMsg)}</p>
            <div className="overflow-y-auto py-2 space-y-1">
              {allChannels
                .filter((c) => c.id !== roomId)
                .map((c) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      // Forward hygiene (Phase 0.5): never leak the original's
                      // edit marker or disappearing-message expiry into the copy.
                      onForwardMessage?.({ ...forwardMsg, editedAt: undefined, expiresAt: undefined }, c.id);
                      setForwardMsg(null);
                    }}
                    className="w-full flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-bubble-in text-left"
                  >
                    <img src={c.avatar || initialsAvatarDataUrl(c.name)} alt={c.name} className="w-9 h-9 rounded-full object-cover" />
                    <span className="text-sm font-semibold text-app truncate">{c.name}</span>
                  </button>
                ))}
              {allChannels.filter((c) => c.id !== roomId).length === 0 && (
                <p className="text-xs text-app-faint text-center py-4">{lang === 'bn' ? 'অন্য কোনো চ্যাট নেই' : 'No other chats yet'}</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Who-reacted sheet: lists reactors per emoji; tapping a row toggles my reaction */}
      {reactionSheetMsg && (() => {
        // Stay in sync with live updates while the sheet is open
        const sheetMsg = messages.find((m) => m.id === reactionSheetMsg.id) || reactionSheetMsg;
        const userById = new Map<string, User>(users.map((u) => [u.id, u]));
        if (!userById.has(currentUser.id)) userById.set(currentUser.id, currentUser);
        const entries = Object.entries(sheetMsg.reactions || {}).filter(([, ids]) => ids.length > 0);
        return (
          <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center p-0 sm:p-4 animate-in fade-in" onClick={() => setReactionSheetMsg(null)}>
            <div className="glass-sheet w-full sm:max-w-sm rounded-t-[var(--r-sheet)] sm:rounded-[var(--r-sheet)] p-5 animate-in slide-in-from-bottom-4 space-y-3 max-h-[75vh] overflow-y-auto" style={{ animationDuration: 'var(--dur-sheet)', animationTimingFunction: 'var(--ease-spring)' }} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'রিঅ্যাকশন' : 'Reactions'} >
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-app">
                  {lang === 'bn' ? 'রিঅ্যাকশনসমূহ' : 'Reactions'}
                </h3>
                <button onClick={() => setReactionSheetMsg(null)} className="p-1 text-app-faint hover:text-danger" title={lang === 'bn' ? 'বন্ধ করুন' : 'Close'} aria-label={lang === 'bn' ? 'বন্ধ করুন' : 'Close'}>
                  <X className="w-5 h-5" />
                </button>
              </div>
              <p className="text-[11px] text-app-faint">
                {lang === 'bn' ? 'আপনার রিঅ্যাকশন টগল করতে যেকোনো ইমোজিতে ট্যাপ করুন' : 'Tap an emoji to toggle your reaction'}
              </p>
              {entries.length === 0 ? (
                <p className="text-xs text-app-faint text-center py-3">{lang === 'bn' ? 'এখনো কোনো রিঅ্যাকশন নেই' : 'No reactions yet'}</p>
              ) : (
                entries.map(([emoji, voterIds]) => (
                  <div key={emoji} className="space-y-1.5">
                    <button
                      onClick={() => onToggleReaction?.(sheetMsg, emoji)}
                      className={`flex items-center gap-2 px-2.5 py-1.5 rounded-full text-xs font-bold border transition-all active:scale-95 ${
                        voterIds.includes(currentUser.id)
                          ? 'bg-bubble-in  border-(--c-primary) text-primary '
                          : 'bg-app  border-token  text-app-2 '
                      }`}
                     aria-label={`React with ${emoji}`} >
                      <span className="text-base">{emoji}</span>
                      <span>{voterIds.length}</span>
                    </button>
                    <div className="space-y-1 pl-1">
                      {voterIds.map((uid) => {
                        const u = userById.get(uid);
                        return (
                          <div key={uid} className="flex items-center gap-2.5 px-2 py-1">
                            <img
                              src={u?.avatar || initialsAvatarDataUrl(u?.name || 'Unknown')}
                              alt={u?.name || 'Unknown'}
                              className="w-7 h-7 rounded-full object-cover bg-pressed "
                            />
                            <span className="text-xs font-semibold text-app truncate">
                              {u?.name || (lang === 'bn' ? 'অজানা' : 'Unknown')}
                              {uid === currentUser.id && (
                                <span className="text-app-faint font-medium"> · {lang === 'bn' ? 'আপনি' : 'You'}</span>
                              )}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        );
      })()}

      {/* Message info panel (1.2): own messages — sent / delivered / read-by
          from the message's server receipt lists, names resolved via users */}
      {infoMsg && (() => {
        const live = messages.find((m) => m.id === infoMsg.id) || infoMsg;
        const nameOf = (id: string): string => {
          if (id === currentUser.id) return lang === 'bn' ? 'আপনি' : 'You';
          const u = users.find((x) => x.id === id) || (recipientUser?.id === id ? recipientUser : undefined);
          return u?.name || id;
        };
        const delivered = (live.deliveredTo || []).filter((id) => id !== currentUser.id);
        const read = (live.readBy || []).filter((id) => id !== currentUser.id);
        const pending =
          channel?.isGroup
            ? resolveMemberIds(channel).filter(
                (id) => id !== currentUser.id && !delivered.includes(id) && !read.includes(id)
              )
            : [];
        const Row = ({ id, badge, badgeClass }: { id: string; badge: string; badgeClass: string }) => (
          <div className="flex items-center gap-2.5 px-1 py-1.5">
            <img
              src={users.find((x) => x.id === id)?.avatar || (recipientUser?.id === id ? recipientUser.avatar : undefined) || initialsAvatarDataUrl(nameOf(id))}
              alt=""
              className="w-8 h-8 rounded-full object-cover bg-pressed "
            />
            <span className="flex-1 text-sm font-medium text-app truncate">{nameOf(id)}</span>
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${badgeClass}`}>{badge}</span>
          </div>
        );
        return (
          <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center p-0 sm:p-4 animate-in fade-in" onClick={() => setInfoMsg(null)}>
            <div className="glass-sheet w-full sm:max-w-sm rounded-t-[var(--r-sheet)] sm:rounded-[var(--r-sheet)] p-5 animate-in slide-in-from-bottom-4 space-y-3 max-h-[80vh] overflow-y-auto" style={{ animationDuration: 'var(--dur-sheet)', animationTimingFunction: 'var(--ease-spring)' }} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'মেসেজের তথ্য' : 'Message info'} >
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-app flex items-center gap-2">
                  <Info className="w-4 h-4 text-primary" /> {lang === 'bn' ? 'মেসেজের তথ্য' : 'Message info'}
                </h3>
                <button onClick={() => setInfoMsg(null)} className="p-1 text-app-faint hover:text-danger" title={lang === 'bn' ? 'বন্ধ করুন' : 'Close'} aria-label={lang === 'bn' ? 'বন্ধ করুন' : 'Close'}>
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="px-3 py-2 rounded-xl bg-surface ">
                <p className="text-xs text-app-2 truncate">{snippetOf(live)}</p>
                <p className="text-[11px] text-app-faint mt-1">
                  {lang === 'bn' ? 'পাঠানো হয়েছে' : 'Sent'} ·{' '}
                  {new Date(live.timestamp).toLocaleString(lang === 'bn' ? 'bn-BD' : 'en-US', {
                    day: 'numeric',
                    month: 'short',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </p>
              </div>
              {read.length > 0 && (
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-wide text-online pb-1">
                    {lang === 'bn' ? 'পড়েছেন' : 'Read by'}
                  </p>
                  {read.map((id) => (
                    <Row key={`r-${id}`} id={id} badge={lang === 'bn' ? 'পড়েছেন' : 'Read'} badgeClass="bg-surface  text-online " />
                  ))}
                </div>
              )}
              {delivered.filter((id) => !read.includes(id)).length > 0 && (
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-wide text-primary pb-1">
                    {lang === 'bn' ? 'পৌঁছেছে' : 'Delivered to'}
                  </p>
                  {delivered
                    .filter((id) => !read.includes(id))
                    .map((id) => (
                      <Row key={`d-${id}`} id={id} badge={lang === 'bn' ? 'পৌঁছেছে' : 'Delivered'} badgeClass="bg-bubble-in  text-primary " />
                    ))}
                </div>
              )}
              {pending.length > 0 && (
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-wide text-app-faint pb-1">
                    {lang === 'bn' ? 'বাকি আছে' : 'Not yet delivered'}
                  </p>
                  {pending.map((id) => (
                    <Row key={`p-${id}`} id={id} badge={lang === 'bn' ? 'বাকি' : 'Pending'} badgeClass="bg-bubble-in  text-app-2 " />
                  ))}
                </div>
              )}
              {read.length === 0 && delivered.length === 0 && pending.length === 0 && (
                <p className="text-xs text-app-faint leading-relaxed">
                  {isDm
                    ? live.status === 'read'
                      ? lang === 'bn'
                        ? `${recipientUser?.name || 'প্রাপক'} মেসেজটি পড়েছেন।`
                        : `Read by ${recipientUser?.name || 'the recipient'}.`
                      : live.status === 'delivered'
                        ? lang === 'bn'
                          ? 'প্রাপকের ডিভাইসে পৌঁছেছে।'
                          : 'Delivered to the recipient’s device.'
                        : lang === 'bn'
                          ? 'পাঠানো হয়েছে — এখনো পৌঁছায়নি।'
                          : 'Sent — not delivered yet.'
                    : lang === 'bn'
                      ? 'এখনো কোনো ডেলিভারি তথ্য পাওয়া যায়নি।'
                      : 'No delivery info yet.'}
                </p>
              )}
            </div>
          </div>
        );
      })()}

      {/* Remind-me presets (1.9.5): POST /api/reminders */}
      {remindMsg && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center p-0 sm:p-4 animate-in fade-in" onClick={() => setRemindMsg(null)}>
          <div className="glass-sheet w-full sm:max-w-sm rounded-t-[var(--r-sheet)] sm:rounded-[var(--r-sheet)] p-5 animate-in slide-in-from-bottom-4 space-y-3" style={{ animationDuration: 'var(--dur-sheet)', animationTimingFunction: 'var(--ease-spring)' }} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'রিমাইন্ডার' : 'Remind me'} >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-app flex items-center gap-2">
                <Bell className="w-4 h-4 text-danger" /> {lang === 'bn' ? 'কখন মনে করিয়ে দেব?' : 'Remind me…'}
              </h3>
              <button onClick={() => setRemindMsg(null)} className="p-1 text-app-faint hover:text-danger" title={lang === 'bn' ? 'বন্ধ করুন' : 'Close'} aria-label={lang === 'bn' ? 'বন্ধ করুন' : 'Close'}>
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-xs text-app-2 truncate px-1">{snippetOf(remindMsg)}</p>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  { id: '1h', label: lang === 'bn' ? '১ ঘণ্টা পরে' : 'In 1 hour' },
                  { id: 'tonight', label: lang === 'bn' ? 'আজ রাত ৯টা' : 'Tonight 9 PM' },
                  { id: 'tomorrow', label: lang === 'bn' ? 'কাল সকাল ৯টা' : 'Tomorrow 9 AM' },
                  { id: 'week', label: lang === 'bn' ? 'আগামী সপ্তাহ' : 'Next week' },
                ] as const
              ).map((preset) => (
                <button
                  key={preset.id}
                  onClick={() => void createReminder(remindMsg, reminderPresetDue(preset.id))}
                  className="py-2.5 rounded-xl bg-bubble-in hover:bg-surface text-xs font-bold text-app transition-colors"
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="datetime-local"
                value={remindCustomAt}
                min={new Date(Date.now() + 60000).toISOString().slice(0, 16)}
                onChange={(e) => setRemindCustomAt(e.target.value)}
                className="flex-1 bg-surface border border-token rounded-xl px-3 py-2 text-xs text-app "
               aria-label={lang === 'bn' ? 'রিমাইন্ডারের সময়' : 'Reminder time'} />
              <button
                onClick={() => {
                  const ts = remindCustomAt ? new Date(remindCustomAt).getTime() : NaN;
                  if (ts && ts > Date.now()) void createReminder(remindMsg, ts);
                }}
                disabled={!remindCustomAt || new Date(remindCustomAt).getTime() <= Date.now()}
                className="px-4 py-2 bg-danger hover:bg-danger disabled:opacity-40 text-white rounded-xl text-xs font-bold transition-colors"
              >
                {lang === 'bn' ? 'সেট করুন' : 'Set'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* DM shared-media panel (1.9.3): the room's REAL media — images,
          videos, docs, links — tap any item to jump to its message */}
      {showSharedMedia && (() => {
        const live = [...messages].filter((m) => !m.deletedAt).sort((a, b) => b.timestamp - a.timestamp);
        const images = live.filter((m) => m.type === 'image' && !m.sticker);
        const videos = live.filter((m) => m.type === 'video');
        const docs = live.filter((m) => m.type === 'file');
        const links = live
          .filter((m) => m.type === 'text' && /https?:\/\//i.test(m.content))
          .map((m) => {
            const url = (m.content.match(/https?:\/\/[^\s]+/) || [''])[0];
            let domain = url;
            try {
              domain = new URL(url).hostname;
            } catch {
              /* keep raw */
            }
            return { msg: m, url, domain };
          })
          .filter((l) => l.url);
        const counts = { images: images.length, videos: videos.length, docs: docs.length, links: links.length };
        const jump = (m: ChatMessage) => {
          setShowSharedMedia(false);
          jumpToMessage(m);
        };
        const Empty = ({ label }: { label: string }) => (
          <p className="py-10 text-center text-xs text-app-faint font-medium">{label}</p>
        );
        return (
          <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center p-0 sm:p-4 animate-in fade-in" onClick={() => setShowSharedMedia(false)}>
            <div className="glass-sheet w-full sm:max-w-md rounded-t-[var(--r-sheet)] sm:rounded-[var(--r-sheet)] p-5 animate-in slide-in-from-bottom-4 space-y-3 max-h-[82vh] flex flex-col" style={{ animationDuration: 'var(--dur-sheet)', animationTimingFunction: 'var(--ease-spring)' }} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'শেয়ার করা মিডিয়া' : 'Shared media'} >
              <div className="flex items-center justify-between shrink-0">
                <h3 className="text-sm font-bold text-app flex items-center gap-2">
                  <ImageIcon className="w-4 h-4 text-primary" /> {lang === 'bn' ? 'শেয়ার করা মিডিয়া' : 'Shared media'}
                </h3>
                <button onClick={() => setShowSharedMedia(false)} className="p-1 text-app-faint hover:text-danger" title={lang === 'bn' ? 'বন্ধ করুন' : 'Close'} aria-label={lang === 'bn' ? 'বন্ধ করুন' : 'Close'}>
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="flex gap-1.5 shrink-0">
                {(
                  [
                    { id: 'images', label: lang === 'bn' ? 'ছবি' : 'Images' },
                    { id: 'videos', label: lang === 'bn' ? 'ভিডিও' : 'Videos' },
                    { id: 'docs', label: lang === 'bn' ? 'ডকুমেন্ট' : 'Docs' },
                    { id: 'links', label: lang === 'bn' ? 'লিংক' : 'Links' },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setSharedMediaTab(tab.id)}
                    className={`px-3 py-1.5 rounded-full text-[11px] font-bold transition-all ${
                      sharedMediaTab === tab.id
                        ? 'bg-primary text-white'
                        : 'bg-bubble-in  text-app-2 '
                    }`}
                   aria-pressed={sharedMediaTab === tab.id} >
                    {tab.label} · {counts[tab.id]}
                  </button>
                ))}
              </div>
              <div className="overflow-y-auto min-h-0">
                {sharedMediaTab === 'images' &&
                  (images.length === 0 ? (
                    <Empty label={lang === 'bn' ? 'এখনো কোনো ছবি শেয়ার হয়নি' : 'No photos shared yet'} />
                  ) : (
                    <div className="grid grid-cols-3 gap-1.5">
                      {images.map((m) => (
                        <button key={m.id} onClick={() => jump(m)} className="rounded-xl overflow-hidden hover:opacity-85 active:scale-95 transition-all" title={m.fileName || 'Photo'} aria-label={m.fileName || 'Photo'}>
                          <img src={safeMediaUrl(m.content)} alt={m.fileName || 'Shared photo'} className="w-full h-24 object-cover" loading="lazy" />
                        </button>
                      ))}
                    </div>
                  ))}
                {sharedMediaTab === 'videos' &&
                  (videos.length === 0 ? (
                    <Empty label={lang === 'bn' ? 'এখনো কোনো ভিডিও শেয়ার হয়নি' : 'No videos shared yet'} />
                  ) : (
                    <div className="space-y-1.5">
                      {videos.map((m) => (
                        <button key={m.id} onClick={() => jump(m)} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-pressed text-left">
                          <span className="w-9 h-9 rounded-lg bg-surface text-online flex items-center justify-center shrink-0">
                            <Play className="w-4 h-4 fill-current" />
                          </span>
                          <span className="min-w-0">
                            <span className="block text-xs font-bold text-app truncate">{m.fileName || (lang === 'bn' ? 'ভিডিও' : 'Video')}</span>
                            <span className="block text-[11px] text-app-faint">
                              {m.senderName} · {new Date(m.timestamp).toLocaleDateString()}
                            </span>
                          </span>
                          <ChevronRight className="w-4 h-4 text-app-faint ml-auto shrink-0" />
                        </button>
                      ))}
                    </div>
                  ))}
                {sharedMediaTab === 'docs' &&
                  (docs.length === 0 ? (
                    <Empty label={lang === 'bn' ? 'এখনো কোনো ডকুমেন্ট শেয়ার হয়নি' : 'No documents shared yet'} />
                  ) : (
                    <div className="space-y-1.5">
                      {docs.map((m) => (
                        <div key={m.id} className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-pressed">
                          <button onClick={() => jump(m)} className="flex items-center gap-3 min-w-0 flex-1 text-left">
                            <span className="w-9 h-9 rounded-lg bg-bubble-in text-primary flex items-center justify-center shrink-0">
                              <FileText className="w-4 h-4" />
                            </span>
                            <span className="min-w-0">
                              <span className="block text-xs font-bold text-app truncate">{m.fileName || 'Document'}</span>
                              <span className="block text-[11px] text-app-faint">
                                {m.fileSize || ''} · {new Date(m.timestamp).toLocaleDateString()}
                              </span>
                            </span>
                          </button>
                          <a
                            href={safeMediaUrl(m.content)}
                            download={m.fileName || 'download'}
                            className="p-1.5 text-primary hover:bg-pressed rounded-lg transition-colors shrink-0"
                            title={lang === 'bn' ? 'ডাউনলোড' : 'Download'}
                          >
                            <Download className="w-4 h-4" />
                          </a>
                        </div>
                      ))}
                    </div>
                  ))}
                {sharedMediaTab === 'links' &&
                  (links.length === 0 ? (
                    <Empty label={lang === 'bn' ? 'এখনো কোনো লিংক শেয়ার হয়নি' : 'No links shared yet'} />
                  ) : (
                    <div className="space-y-1.5">
                      {links.map(({ msg: m, url, domain }) => (
                        <button key={m.id} onClick={() => jump(m)} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-pressed text-left">
                          <span className="w-9 h-9 rounded-lg bg-bubble-in text-primary flex items-center justify-center shrink-0">
                            <Link2 className="w-4 h-4" />
                          </span>
                          <span className="min-w-0">
                            <span className="block text-xs font-bold text-app truncate">{domain}</span>
                            <span className="block text-[11px] text-app-faint truncate">
                              {url} · {m.senderName}
                            </span>
                          </span>
                          <ChevronRight className="w-4 h-4 text-app-faint ml-auto shrink-0" />
                        </button>
                      ))}
                    </div>
                  ))}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ProfileCard mount (1.4): DM peer / @mention / contact card */}
      {profileCardUser && (
        <ProfileCard
          user={profileCardUser}
          lang={lang}
          onClose={() => setProfileCardUser(null)}
          onMessage={(u) => {
            setProfileCardUser(null);
            if (isDm && recipientUser && u.id === recipientUser.id) return; // already here
            onOpenUserChat?.(u.id);
          }}
          onCall={(u) => {
            setProfileCardUser(null);
            if (isDm && recipientUser && u.id === recipientUser.id) onStartCall('audio');
          }}
          onBlock={
            isDm && recipientUser && profileCardUser.id === recipientUser.id
              ? (u) => {
                  setProfileCardUser(null);
                  if (isRecipientBlocked) void unblockUser(u.id);
                  else void blockUser(u.id, u.name);
                }
              : undefined
          }
          sharedMediaCount={
            isDm && recipientUser && profileCardUser.id === recipientUser.id
              ? messages.filter((m) => !m.deletedAt && (m.type === 'image' || m.type === 'video' || m.type === 'file')).length
              : undefined
          }
          onOpenSharedMedia={
            isDm && recipientUser && profileCardUser.id === recipientUser.id
              ? () => {
                  setProfileCardUser(null);
                  setShowSharedMedia(true);
                }
              : undefined
          }
        />
      )}

      {/* Create poll modal */}
      {showPollModal && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 animate-in fade-in" onClick={() => { setShowPollModal(false); resetPollForm(); }}>
          <div className="glass-sheet w-full max-w-md rounded-[var(--r-sheet)] p-6 space-y-4" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'নতুন পোল তৈরি করুন' : 'Create a Poll'} >
            <h3 className="text-base font-bold text-app flex items-center gap-2">
              <BarChart3 className="w-5 h-5 text-primary" /> {lang === 'bn' ? 'নতুন পোল তৈরি করুন' : 'Create a Poll'}
            </h3>
            <input
              autoFocus
              value={pollQuestion}
              onChange={(e) => setPollQuestion(e.target.value)}
              placeholder={lang === 'bn' ? 'প্রশ্ন লিখুন...' : 'Ask a question...'}
              className="w-full bg-bubble-in rounded-xl px-3.5 py-2.5 text-sm text-app placeholder:text-app-faint "
             aria-label={lang === 'bn' ? 'পোলের প্রশ্ন' : 'Poll question'} />
            <div className="space-y-2">
              {pollOptions.map((opt, i) => (
                <div key={i} className="flex items-center gap-2">
                  {pollQuiz && (
                    <button
                      type="button"
                      onClick={() => setPollCorrectIdx(i)}
                      className={`w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0 transition-all ${
                        pollCorrectIdx === i
                          ? 'border-(--c-online) bg-online text-white'
                          : 'border-token  text-transparent hover:border-(--c-online)'
                      }`}
                      title={lang === 'bn' ? 'এটিকে সঠিক উত্তর হিসেবে চিহ্নিত করুন' : 'Mark as the correct answer'} aria-label={lang === 'bn' ? 'এটিকে সঠিক উত্তর হিসেবে চিহ্নিত করুন' : 'Mark as the correct answer'}
                    >
                      <Check className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <input
                    value={opt}
                    onChange={(e) => {
                      const next = [...pollOptions];
                      next[i] = e.target.value;
                      setPollOptions(next);
                    }}
                    placeholder={`${lang === 'bn' ? 'অপশন' : 'Option'} ${i + 1}`} aria-label={`${lang === 'bn' ? 'অপশন' : 'Option'} ${i + 1}`}
                    className="flex-1 bg-bubble-in rounded-xl px-3.5 py-2.5 text-sm text-app placeholder:text-app-faint "
                  />
                </div>
              ))}
              {pollQuiz && (
                <p className="text-[11px] text-app-faint leading-snug">
                  {lang === 'bn'
                    ? 'সবুজ টিক দিয়ে সঠিক উত্তরটি চিহ্নিত করুন। ভোটাররা ভোট দেওয়ার পরেই শুধু সঠিক উত্তর দেখতে পাবেন।'
                    : 'Tap the green check to mark the correct answer. Voters only see it after they vote.'}
                </p>
              )}
              {pollOptions.length < 5 && (
                <button
                  onClick={() => setPollOptions([...pollOptions, ''])}
                  className="text-xs font-bold text-primary hover:underline flex items-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5" /> {lang === 'bn' ? 'আরেকটা অপশন যোগ করুন' : 'Add an option'}
                </button>
              )}
            </div>
            <div className="space-y-2">
              <label className="flex items-center justify-between p-2.5 rounded-xl bg-surface cursor-pointer text-xs font-semibold text-app ">
                <span>{lang === 'bn' ? 'একাধিক পছন্দ অনুমোদন' : 'Allow multiple choices'}</span>
                <input
                  type="checkbox"
                  checked={pollMultiple}
                  onChange={(e) => setPollMultiple(e.target.checked)}
                  className="accent-(--c-primary) w-4 h-4"
                />
              </label>
              <label className="flex items-center justify-between p-2.5 rounded-xl bg-surface cursor-pointer text-xs font-semibold text-app ">
                <span>{lang === 'bn' ? 'বেনামী ভোট' : 'Anonymous voting'}</span>
                <input
                  type="checkbox"
                  checked={pollAnonymous}
                  onChange={(e) => setPollAnonymous(e.target.checked)}
                  className="accent-(--c-primary) w-4 h-4"
                />
              </label>
              <label className="flex items-center justify-between p-2.5 rounded-xl bg-surface cursor-pointer text-xs font-semibold text-app ">
                <span className="flex items-center gap-1.5">
                  <Award className="w-3.5 h-3.5 text-primary" />
                  {lang === 'bn' ? 'কুইজ মোড (একটি সঠিক উত্তর)' : 'Quiz mode (one correct answer)'}
                </span>
                <input
                  type="checkbox"
                  checked={pollQuiz}
                  onChange={(e) => {
                    setPollQuiz(e.target.checked);
                    if (e.target.checked) setPollMultiple(false);
                  }}
                  className="accent-(--c-primary) w-4 h-4"
                />
              </label>
              <label className="flex items-center justify-between p-2.5 rounded-xl bg-surface text-xs font-semibold text-app ">
                <span>{lang === 'bn' ? 'স্বয়ংক্রিয় বন্ধ' : 'Auto-close'}</span>
                <select
                  value={pollCloseIn}
                  onChange={(e) => setPollCloseIn(e.target.value as '' | '1' | '6' | '24')}
                  className="bg-app border border-token rounded-lg px-2 py-1.5 text-xs text-app "
                >
                  <option value="">{lang === 'bn' ? 'কখনো না' : 'Never'}</option>
                  <option value="1">{lang === 'bn' ? '১ ঘণ্টা' : '1 hour'}</option>
                  <option value="6">{lang === 'bn' ? '৬ ঘণ্টা' : '6 hours'}</option>
                  <option value="24">{lang === 'bn' ? '২৪ ঘণ্টা' : '24 hours'}</option>
                </select>
              </label>
            </div>
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => { setShowPollModal(false); resetPollForm(); }}
                className="flex-1 py-2.5 rounded-xl bg-bubble-in text-app text-sm font-bold"
              >
                {lang === 'bn' ? 'বাতিল' : 'Cancel'}
              </button>
              <button
                onClick={createPoll}
                disabled={
                  !pollQuestion.trim() ||
                  pollOptions.map((o) => o.trim()).filter(Boolean).length < 2 ||
                  (pollQuiz && !(pollOptions[pollCorrectIdx] || '').trim())
                }
                className="flex-1 py-2.5 rounded-xl bg-primary hover:bg-primary text-white text-sm font-bold shadow-md disabled:opacity-40"
              >
                {lang === 'bn' ? 'পোল পাঠান' : 'Send Poll'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* ADD NEW DISCORD SUB-CHANNEL MODAL                                         */}
      {/* ========================================================================= */}
      {showAddSectionModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 animate-in fade-in select-none">
          <div className="glass-sheet rounded-[var(--r-sheet)] w-full max-w-md p-6 space-y-4" role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'নতুন সাবচ্যানেল তৈরি করুন' : 'Create New Sub-channel'} >
            <div className="flex items-center justify-between pb-2 border-b border-token ">
              <div className="flex items-center gap-2">
                <Hash className="w-5 h-5 text-primary" />
                <h3 className="text-base font-bold text-app">
                  {lang === 'bn' ? 'নতুন ডিসকর্ড সাবচ্যানেল তৈরি করুন' : 'Create New Sub-channel'}
                </h3>
              </div>
              <button
                onClick={() => setShowAddSectionModal(false)}
                className="p-1 text-app-faint hover:text-app rounded-lg"
               aria-label={lang === 'bn' ? 'বন্ধ করুন' : 'Close'} >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateNewSection} className="space-y-3.5">
              <div>
                <label className="block text-xs font-semibold text-app mb-1">
                  {lang === 'bn' ? 'সাবচ্যানেলের নাম (Hashtag)' : 'Sub-channel Name'}
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-app-faint font-bold">#</span>
                  <input
                    type="text"
                    value={newSectionName}
                    onChange={(e) => setNewSectionName(e.target.value)}
                    placeholder="e.g. dev-team or client-discussions"
                    required
                    className="w-full bg-surface border border-token rounded-xl pl-8 pr-4 py-2.5 text-xs text-app "
                   aria-label={lang === 'bn' ? 'সাবচ্যানেলের নাম' : 'Sub-channel Name'} />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-app mb-1">
                  {lang === 'bn' ? 'বর্ণনা / উদ্দেশ্য (ঐচ্ছিক)' : 'Topic / Purpose (Optional)'}
                </label>
                <input
                  type="text"
                  value={newSectionDesc}
                  onChange={(e) => setNewSectionDesc(e.target.value)}
                  placeholder="e.g. Discussion regarding frontend tasks"
                  className="w-full bg-surface border border-token rounded-xl px-3 py-2 text-xs text-app "
                 aria-label={lang === 'bn' ? 'বিবরণ বা টপিক' : 'Description / Topic'} />
              </div>

              {/* Private / Locked Channel Switch */}
              <div className="p-3 rounded-2xl bg-surface border border-token flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <Lock className="w-4 h-4 text-primary" />
                  <div>
                    <p className="text-xs font-bold text-app ">
                      {lang === 'bn' ? 'লকড / প্রাইভেট সাবচ্যানেল' : 'Private Locked Sub-channel'}
                    </p>
                    <p className="text-[10px] text-app-faint">
                      {lang === 'bn' ? 'শুধুমাত্র অনুমোদিত রোল বা সদস্যরা চ্যাটে অংশগ্রহণ করতে পারবে' : 'Only authorized roles or members can view and chat'}
                    </p>
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={newSectionPrivate}
                  onChange={(e) => setNewSectionPrivate(e.target.checked)}
                  className="w-4 h-4 accent-(--c-primary) rounded cursor-pointer"
                 aria-label={lang === 'bn' ? 'প্রাইভেট বা লকড চ্যানেল' : 'Private / Locked Channel'} />
              </div>

              {/* Role Permissions (If Locked) */}
              {newSectionPrivate && (
                <div className="space-y-2 animate-in fade-in">
                  <label className="block text-xs font-semibold text-app ">
                    {lang === 'bn' ? 'কারা এই চ্যানেলে অ্যাক্সেস পাবে:' : 'Roles with Access:'}
                  </label>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    {(['admin', 'moderator', 'controller', 'member'] as GroupRole[]).map((role) => (
                      <label
                        key={role}
                        className="flex items-center gap-2 p-2 rounded-xl bg-surface border border-token cursor-pointer capitalize font-medium text-app "
                      >
                        <input
                          type="checkbox"
                          checked={newSectionAllowedRoles.includes(role)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setNewSectionAllowedRoles([...newSectionAllowedRoles, role]);
                            } else {
                              setNewSectionAllowedRoles(newSectionAllowedRoles.filter((r) => r !== role));
                            }
                          }}
                          className="w-3.5 h-3.5 accent-(--c-primary) rounded"
                        />
                        <span>{role}</span>
                      </label>
                    ))}
                  </div>

                  {/* Member allowlist — actually wired (Phase 0.3): the picked
                      member IDs become the section's allowedMemberIds. */}
                  <label className="block text-xs font-semibold text-app ">
                    {lang === 'bn' ? 'নির্দিষ্ট সদস্যদের অনুমতি দিন:' : 'Or allow specific members:'}
                  </label>
                  <div className="max-h-36 overflow-y-auto space-y-1">
                    {channel
                      ? resolveMemberIds(channel)
                          .map((mid) => users.find((u) => u.id === mid))
                          .filter((u): u is User => !!u && u.id !== currentUser.id)
                          .map((u) => (
                            <label
                              key={u.id}
                              className="flex items-center gap-2 p-2 rounded-xl bg-surface border border-token cursor-pointer text-xs font-medium text-app "
                            >
                              <input
                                type="checkbox"
                                checked={newSectionAllowedMembers.includes(u.id)}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setNewSectionAllowedMembers([...newSectionAllowedMembers, u.id]);
                                  } else {
                                    setNewSectionAllowedMembers(newSectionAllowedMembers.filter((id) => id !== u.id));
                                  }
                                }}
                                className="w-3.5 h-3.5 accent-(--c-primary) rounded"
                              />
                              <img src={u.avatar} alt={u.name} className="w-6 h-6 rounded-full object-cover" />
                              <span className="truncate">{u.name}</span>
                            </label>
                          ))
                      : null}
                    {channel && resolveMemberIds(channel).length <= 1 && (
                      <p className="text-[11px] text-app-faint">
                        {lang === 'bn' ? 'এখনো অন্য কোনো সদস্য নেই' : 'No other members yet'}
                      </p>
                    )}
                  </div>
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddSectionModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-app-2 hover:text-app"
                >
                  {lang === 'bn' ? 'বাতিল' : 'Cancel'}
                </button>
                <button
                  type="submit"
                  className="px-5 py-2.5 bg-primary hover:bg-primary text-white rounded-xl text-xs font-bold shadow-md transition-all"
                >
                  {lang === 'bn' ? 'সাবচ্যানেল তৈরি করুন' : 'Create Sub-channel'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
