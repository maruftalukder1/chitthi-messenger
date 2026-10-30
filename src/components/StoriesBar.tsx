import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Plus, X, ChevronLeft, ChevronRight, Send, Trash2, Eye, Pause, Play,
  Type, Video, Image as ImageIcon, Users, Globe, Star, Volume2, VolumeX,
  MoreVertical, BellOff, Bell, Check, MessageCircle,
} from 'lucide-react';
import type { User } from '../types/chat';
import { authHeaders } from '../services/firebase';
import { initialsAvatarDataUrl } from '../utils/avatar';

// ── Phase 1 (roadmap 1.1) story contract additions ─────────────────────────
// audience {mode, userIds?} · kind image|text|video · textData {text,bg,font}
// reactions [{userId, emoji}] · POST /api/stories/:id/react · story mutes
// (GET/POST/DELETE /api/stories/mutes) · highlights snapshots
// (GET/POST /api/highlights, DELETE /api/highlights/:id).

export type StoryKind = 'image' | 'text' | 'video';
export type StoryAudienceMode = 'everyone' | 'contacts' | 'close' | 'custom';

export interface StoryAudience {
  mode: StoryAudienceMode;
  userIds?: string[];
}

export interface StoryTextData {
  text: string;
  /** CSS background value (solid colour or gradient) chosen at creation. */
  bg: string;
  /** Font-choice id from TEXT_FONTS (falls back to using it as fontFamily). */
  font: string;
}

export interface StoryReaction {
  userId: string;
  emoji: string;
}

export interface StoryViewer {
  userId: string;
  viewedAt: number;
}

export interface Story {
  id: string;
  userId: string;
  userName: string;
  avatar: string;
  imageUrl: string;
  caption?: string;
  createdAt: number;
  expiresAt?: number;
  viewers?: StoryViewer[];
  kind: StoryKind;
  audience?: StoryAudience;
  textData?: StoryTextData;
  reactions: StoryReaction[];
}

/** Snapshot story as stored inside a highlight (survives story expiry). */
export interface Highlight {
  id: string;
  userId: string;
  storyId?: string;
  story: Story;
  createdAt: number;
}

/** Payload handed to the coordinator-wired DM opener when a user replies
 * to someone else's story from the viewer. */
export interface StoryReplyPayload {
  storyId: string;
  authorId: string;
  authorName: string;
  kind: StoryKind;
  /** Short quote of the story for the DM's story-quoted bubble. */
  snippet: string;
  text: string;
  story: Story;
}

interface StoriesBarProps {
  currentUser: User;
  users: User[];
  lang: 'bn' | 'en';
  /**
   * NEW (Phase 1.1) — coordinator wiring required in ChatsScreen + App.tsx:
   * called when the viewer submits a reply to another user's story. The
   * coordinator should open the DM with `authorId` and send `text` as a
   * message carrying a story quote (Phase 1 contract: ChatMessage.storyRef /
   * replyTo built from `storyId` + `snippet`). When omitted, the viewer
   * shows a short "open the chat to reply" hint instead of sending.
   */
  onReplyToStory?: (payload: StoryReplyPayload) => void;
}

const STORY_TTL_MS = 24 * 60 * 60 * 1000;
const VIEW_MS = 5000;

export const QUICK_REACTIONS = ['❤️', '😂', '😮', '😢', '🔥', '👏'];

/** CONTENT DATA (not theme tokens): user-chosen text-story background
 * palettes. These hex/gradient values are story content, exempt from the
 * Phase-2 token sweep — do not tokenise. Centralised here as the single
 * source; TEXT_BGS is kept as a legacy alias for ProfileCard's import. */
export const STORY_TEXT_BACKGROUNDS: { id: string; css: string; label: string }[] = [
  { id: 'ocean', css: 'linear-gradient(135deg,#0B6E4F,#2A9D8F)', label: 'Ocean' },
  { id: 'sunset', css: 'linear-gradient(135deg,#F97316,#EC4899)', label: 'Sunset' },
  { id: 'forest', css: 'linear-gradient(135deg,#059669,#84CC16)', label: 'Forest' },
  { id: 'rose', css: 'linear-gradient(135deg,#E11D48,#F59E0B)', label: 'Rose' },
  { id: 'night', css: 'linear-gradient(135deg,#0F172A,#334155)', label: 'Night' },
  { id: 'sky', css: 'linear-gradient(135deg,#38BDF8,#818CF8)', label: 'Sky' },
  { id: 'paper', css: '#F8FAFC', label: 'Paper' },
  { id: 'ink', css: '#111827', label: 'Ink' },
];

/** Legacy alias — ProfileCard imports TEXT_BGS. */
export const TEXT_BGS = STORY_TEXT_BACKGROUNDS;

export const TEXT_FONTS: { id: string; label: string; style: React.CSSProperties }[] = [
  { id: 'modern', label: 'Modern', style: { fontFamily: 'Inter, system-ui, sans-serif', fontWeight: 700 } },
  { id: 'serif', label: 'Serif', style: { fontFamily: 'Georgia, "Times New Roman", serif', fontWeight: 600 } },
  { id: 'rounded', label: 'Rounded', style: { fontFamily: '"Comic Sans MS", "Baloo 2", cursive', fontWeight: 700 } },
  { id: 'mono', label: 'Mono', style: { fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontWeight: 600 } },
  { id: 'bangla', label: 'বাংলা', style: { fontFamily: '"Hind Siliguri", "Noto Sans Bengali", sans-serif', fontWeight: 700 } },
];

export function textBgCss(bg: string | undefined): string {
  if (!bg) return STORY_TEXT_BACKGROUNDS[0].css;
  return STORY_TEXT_BACKGROUNDS.find((b) => b.id === bg)?.css || bg;
}
export function textFontStyle(font: string | undefined): React.CSSProperties {
  if (!font) return TEXT_FONTS[0].style;
  return TEXT_FONTS.find((f) => f.id === font)?.style || { fontFamily: font, fontWeight: 700 };
}
export function isLightBg(bg: string | undefined): boolean {
  return bg === 'paper' || bg === '#F8FAFC';
}

// Phase 0.6: the story cache is namespaced per user so stories never leak
// across accounts on a shared browser. The server is the source of truth —
// the cache gives an instant first render, then applyServerStories merges
// it with the server list (dedupe by id, server wins, 24h freshness), so
// other users' expired/deleted stories can never resurrect; only the
// user's own not-yet-synced offline posts survive the merge (see there).
const cacheKey = (userId: string) => `chitthi_stories_${userId}`;
const seenKey = (userId: string) => `chitthi_stories_seen_${userId}`;
const audienceKey = (userId: string) => `chitthi_story_audience_${userId}`;
const closeKey = (userId: string) => `chitthi_close_friends_${userId}`;
const mutesKey = (userId: string) => `chitthi_story_mutes_${userId}`;
const highlightsKey = (userId: string) => `chitthi_highlights_${userId}`;

interface ServerStory {
  id: string;
  userId: string;
  userName: string;
  userAvatar?: string;
  avatar?: string;
  media: string;
  imageUrl?: string;
  type?: string;
  kind?: string;
  text?: string;
  caption?: string;
  createdAt: number;
  expiresAt: number;
  viewers?: StoryViewer[];
  audience?: StoryAudience;
  textData?: StoryTextData;
  reactions?: StoryReaction[];
}

function mapKind(s: ServerStory): StoryKind {
  const k = s.kind || s.type;
  if (k === 'video') return 'video';
  if (k === 'text') {
    // Legacy Phase-0 'text' rows carried no media; a row WITH media + a
    // caption is an image story whose caption lives in `text`.
    if (s.textData) return 'text';
    return s.media ? 'image' : 'text';
  }
  return 'image';
}

function fromServer(s: ServerStory): Story {
  const kind = mapKind(s);
  const textData: StoryTextData | undefined =
    s.textData ||
    (kind === 'text'
      ? { text: s.text || s.caption || '', bg: STORY_TEXT_BACKGROUNDS[0].id, font: TEXT_FONTS[0].id }
      : undefined);
  return {
    id: s.id,
    userId: s.userId,
    userName: s.userName,
    avatar: s.userAvatar || s.avatar || '',
    imageUrl: s.media || s.imageUrl || '',
    caption: kind === 'text' ? undefined : s.text || s.caption,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    viewers: s.viewers || [],
    kind,
    audience: s.audience,
    textData,
    reactions: Array.isArray(s.reactions) ? s.reactions : [],
  };
}

/** Shape sent to POST /api/highlights — a full snapshot so the highlight
 * survives the story's 24h expiry. Carries both client and server field
 * names so either store shape round-trips through fromServer(). */
function toSnapshot(story: Story): Record<string, unknown> {
  return {
    id: story.id,
    userId: story.userId,
    userName: story.userName,
    userAvatar: story.avatar,
    avatar: story.avatar,
    media: story.imageUrl,
    imageUrl: story.imageUrl,
    type: story.kind,
    kind: story.kind,
    text: story.caption,
    caption: story.caption,
    createdAt: story.createdAt,
    expiresAt: story.expiresAt,
    viewers: story.viewers || [],
    audience: story.audience,
    textData: story.textData,
    reactions: story.reactions || [],
  };
}

function fromHighlight(raw: unknown): Highlight | null {
  try {
    const h = raw as Record<string, any>;
    const storyRaw = (h.story || h.snapshot || h) as ServerStory;
    if (!storyRaw || !storyRaw.id) return null;
    const story = fromServer({ ...storyRaw, expiresAt: storyRaw.expiresAt ?? Number.MAX_SAFE_INTEGER });
    return {
      id: String(h.id || `hl_${story.id}`),
      userId: String(h.userId || story.userId),
      storyId: story.id,
      story,
      createdAt: typeof h.createdAt === 'number' ? h.createdAt : story.createdAt,
    };
  } catch {
    return null;
  }
}

function isFresh(s: Story): boolean {
  if (typeof s.expiresAt === 'number') return s.expiresAt > Date.now();
  return Date.now() - s.createdAt < STORY_TTL_MS;
}

function loadCache(userId: string): Story[] {
  try {
    const raw = localStorage.getItem(cacheKey(userId));
    if (raw) {
      const parsed: Story[] = JSON.parse(raw);
      if (Array.isArray(parsed))
        return parsed.filter(isFresh).map((s) => ({ ...s, kind: s.kind || 'image', reactions: s.reactions || [] }));
    }
  } catch {
    /* ignore corrupt data */
  }
  return [];
}

function saveCache(userId: string, stories: Story[]) {
  try {
    localStorage.setItem(cacheKey(userId), JSON.stringify(stories.filter(isFresh)));
  } catch {
    /* ignore quota errors */
  }
}

function loadSeen(userId: string): string[] {
  try {
    const raw = localStorage.getItem(seenKey(userId));
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch {
    /* ignore */
  }
  return fallback;
}
function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

function timeAgo(ts: number, lang: 'bn' | 'en'): string {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return lang === 'bn' ? 'এইমাত্র' : 'Just now';
  if (mins < 60) return lang === 'bn' ? `${mins} মিনিট আগে` : `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return lang === 'bn' ? `${hrs} ঘণ্টা আগে` : `${hrs}h ago`;
  return lang === 'bn' ? 'গতকাল' : 'Yesterday';
}

/** Exact timestamp for the viewers list ("Oct 30, 2:14 PM"). */
function formatExact(ts: number, lang: 'bn' | 'en'): string {
  try {
    return new Intl.DateTimeFormat(lang === 'bn' ? 'bn-BD' : 'en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toLocaleString();
  }
}

function storySnippet(story: Story, lang: 'bn' | 'en'): string {
  if (story.kind === 'text') return (story.textData?.text || '').slice(0, 80);
  if (story.caption) return story.caption.slice(0, 80);
  if (story.kind === 'video') return lang === 'bn' ? 'ভিডিও স্টোরি' : 'Video story';
  return lang === 'bn' ? 'ছবির স্টোরি' : 'Photo story';
}

function reactionCounts(
  reactions: StoryReaction[],
  currentUserId: string
): { emoji: string; count: number; mine: boolean }[] {
  const byEmoji = new Map<string, { count: number; mine: boolean }>();
  for (const r of reactions || []) {
    const cur = byEmoji.get(r.emoji) || { count: 0, mine: false };
    cur.count += 1;
    if (r.userId === currentUserId) cur.mine = true;
    byEmoji.set(r.emoji, cur);
  }
  return Array.from(byEmoji.entries())
    .map(([emoji, v]) => ({ emoji, count: v.count, mine: v.mine }))
    .sort((a, b) => b.count - a.count);
}

// ── HighlightsRow (reusable) ───────────────────────────────────────────────
// The profile card (Team I's ProfileCard) can render this directly with the
// highlights returned by GET /api/highlights?userId=<id>. Clicking a tile
// calls onOpen(highlight); own rows may pass onRemove for the delete action
// (the delete button itself lives in the highlight viewer in StoriesBar).
export const HighlightsRow: React.FC<{
  highlights: Highlight[];
  lang: 'bn' | 'en';
  onOpen?: (highlight: Highlight) => void;
}> = ({ highlights, lang, onOpen }) => {
  if (!highlights.length) return null;
  return (
    <div className="px-1 pt-1">
      <p className="text-[13px] font-semibold text-app-2 flex items-center gap-1.5">
        <Star className="w-3.5 h-3.5" /> {lang === 'bn' ? 'হাইলাইটস' : 'Highlights'}
      </p>
      <div className="stories-row flex gap-4 overflow-x-auto py-3">
        {highlights.map((h) => {
          const s = h.story;
          const label =
            s.kind === 'text' ? (s.textData?.text || '').slice(0, 14) : s.caption?.slice(0, 14) || formatExact(h.createdAt, lang);
          return (
            <div key={h.id} className="flex flex-col items-center gap-1.5 shrink-0 w-16">
              <button
                onClick={() => onOpen?.(h)}
                className="block rounded-full bg-[#0B6E4F] p-[2.5px]"
                title={label} aria-label={label}
              >
                <span className="block rounded-full bg-app p-[2px]">
                  {s.kind === 'text' ? (
                    <span
                      className="w-14 h-14 rounded-full flex items-center justify-center text-white text-lg overflow-hidden"
                      style={{ background: textBgCss(s.textData?.bg), ...textFontStyle(s.textData?.font) }}
                    >
                      {(s.textData?.text || 'T').charAt(0)}
                    </span>
                  ) : s.kind === 'video' ? (
                    <span className="relative block w-14 h-14 rounded-full overflow-hidden bg-black">
                      <video src={s.imageUrl} muted playsInline preload="metadata" className="w-full h-full object-cover" />
                      <span className="absolute inset-0 flex items-center justify-center text-white">
                        <Play className="w-5 h-5 fill-current" />
                      </span>
                    </span>
                  ) : (
                    <img src={s.imageUrl} alt={label} className="w-14 h-14 rounded-full object-cover bg-surface" />
                  )}
                </span>
              </button>
              <span className="text-xs text-app-2 truncate w-full text-center">{label || '•'}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ── Audience selector (creation) ───────────────────────────────────────────
const AudienceSelector: React.FC<{
  lang: 'bn' | 'en';
  users: User[];
  currentUserId: string;
  mode: StoryAudienceMode;
  onModeChange: (mode: StoryAudienceMode) => void;
  selectedIds: string[];
  onSelectedIdsChange: (ids: string[]) => void;
}> = ({ lang, users, currentUserId, mode, onModeChange, selectedIds, onSelectedIdsChange }) => {
  const [query, setQuery] = useState('');
  const people = users.filter((u) => u.id !== currentUserId);
  const filtered = people.filter((u) => u.name.toLowerCase().includes(query.trim().toLowerCase()));
  const modes: { key: StoryAudienceMode; en: string; bn: string; icon: React.ReactNode }[] = [
    { key: 'everyone', en: 'Everyone', bn: 'সবাই', icon: <Globe className="w-3.5 h-3.5" /> },
    { key: 'contacts', en: 'Contacts', bn: 'পরিচিতজন', icon: <Users className="w-3.5 h-3.5" /> },
    { key: 'close', en: 'Close friends', bn: 'ঘনিষ্ঠ বন্ধু', icon: <Star className="w-3.5 h-3.5" /> },
    { key: 'custom', en: 'Custom', bn: 'কাস্টম', icon: <Check className="w-3.5 h-3.5" /> },
  ];
  const togglePerson = (id: string) =>
    onSelectedIdsChange(selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-app-2">
        {lang === 'bn' ? 'কারা দেখতে পারবে' : 'Who can see this'}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {modes.map((m) => (
          <button
            key={m.key}
            type="button"
            onClick={() => onModeChange(m.key)}
            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-semibold transition-colors ${
              mode === m.key
                ? 'bg-primary text-white'
                : 'bg-bubble-in text-app-2'
            }`}
           aria-pressed={mode === m.key} >
            {m.icon} {lang === 'bn' ? m.bn : m.en}
          </button>
        ))}
      </div>
      {(mode === 'close' || mode === 'custom') && (
        <div className="rounded-xl bg-surface p-2 space-y-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={lang === 'bn' ? 'মানুষ খুঁজুন...' : 'Search people...'} aria-label={lang === 'bn' ? 'মানুষ খুঁজুন...' : 'Search people...'}
            className="w-full bg-app rounded-lg px-3 py-1.5 text-xs text-app placeholder:text-app-faint"
          />
          <div className="max-h-32 overflow-y-auto space-y-0.5">
            {filtered.length === 0 && (
              <p className="text-[11px] text-app-faint px-1 py-1">{lang === 'bn' ? 'কাউকে পাওয়া যায়নি' : 'No people found'}</p>
            )}
            {filtered.map((u) => {
              const checked = selectedIds.includes(u.id);
              return (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => togglePerson(u.id)}
                  className="w-full flex items-center gap-2 px-1.5 py-1 rounded-lg hover:bg-app text-left"
                 aria-pressed={selectedIds.includes(u.id)} >
                  <img src={u.avatar} alt={u.name} className="w-6 h-6 rounded-full object-cover bg-surface" />
                  <span className="flex-1 text-xs font-medium text-app truncate">{u.name}</span>
                  <span
                    className={`w-4.5 h-4.5 w-[18px] h-[18px] rounded-full flex items-center justify-center ${
                      checked ? 'bg-primary text-white' : 'bg-pressed text-transparent'
                    }`}
                  >
                    <Check className="w-3 h-3" />
                  </span>
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-app-faint px-1">
            {mode === 'close'
              ? lang === 'bn'
                ? 'ঘনিষ্ঠ তালিকা মনে রাখা হবে।'
                : 'Your close-friends list is remembered.'
              : lang === 'bn'
                ? `${selectedIds.length} জন নির্বাচিত`
                : `${selectedIds.length} selected`}
          </p>
        </div>
      )}
    </div>
  );
};

export const StoriesBar: React.FC<StoriesBarProps> = ({ currentUser, users, lang, onReplyToStory }) => {
  // Instant render from this user's cache; merged with the server list below.
  const [stories, setStories] = useState<Story[]>(() => loadCache(currentUser.id));
  const [seen, setSeen] = useState<string[]>(() => loadSeen(currentUser.id));
  const [viewer, setViewer] = useState<{ userId: string; storyIdx: number } | null>(null);
  const [paused, setPaused] = useState(false);
  const [showViewers, setShowViewers] = useState(false);
  // Accumulated progress (0..1) for the active story. Pausing stops the
  // ticker, so the bar FREEZES at its current position and resumes from it.
  // For video stories progress is driven by the <video> element instead.
  const [progress, setProgress] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // ── Phase 1.1 state ──────────────────────────────────────────────────────
  const [mutedIds, setMutedIds] = useState<string[]>(() => loadJson<string[]>(mutesKey(currentUser.id), []));
  const [highlights, setHighlights] = useState<Highlight[]>(() =>
    loadJson<unknown[]>(highlightsKey(currentUser.id), []).map(fromHighlight).filter(Boolean) as Highlight[]
  );
  const [highlightViewer, setHighlightViewer] = useState<Highlight | null>(null);
  const [muteMenuFor, setMuteMenuFor] = useState<string | null>(null);
  const [showMutedPanel, setShowMutedPanel] = useState(false);
  const [chooserOpen, setChooserOpen] = useState(false);
  // Composer: media (image/video) OR text story.
  const [pendingMedia, setPendingMedia] = useState<{ url: string; kind: 'image' | 'video' } | null>(null);
  const [textComposer, setTextComposer] = useState(false);
  const [caption, setCaption] = useState('');
  const [textDraft, setTextDraft] = useState('');
  const [textBg, setTextBg] = useState(STORY_TEXT_BACKGROUNDS[0].id);
  const [textFont, setTextFont] = useState(TEXT_FONTS[0].id);
  // Audience: remembered default per user; the close-friends selection has
  // its own remembered list so 'close' stays one tap after first setup.
  const [audienceMode, setAudienceMode] = useState<StoryAudienceMode>(() => {
    const saved = loadJson<StoryAudience | null>(audienceKey(currentUser.id), null);
    return saved?.mode || 'everyone';
  });
  const [audienceIds, setAudienceIds] = useState<string[]>(() => {
    const saved = loadJson<StoryAudience | null>(audienceKey(currentUser.id), null);
    if (saved?.mode === 'close') return loadJson<string[]>(closeKey(currentUser.id), saved.userIds || []);
    return saved?.userIds || loadJson<string[]>(closeKey(currentUser.id), []);
  });
  // Viewer extras: reply draft, video mute, transient notices.
  const [replyText, setReplyText] = useState('');
  const [replyNotice, setReplyNotice] = useState(false);
  const [videoMuted, setVideoMuted] = useState(true);
  const [highlightNotice, setHighlightNotice] = useState(false);

  const composerOpen = !!pendingMedia || textComposer;

  const currentAudience = useCallback((): StoryAudience => {
    if (audienceMode === 'close' || audienceMode === 'custom') {
      return { mode: audienceMode, userIds: [...audienceIds] };
    }
    return { mode: audienceMode };
  }, [audienceMode, audienceIds]);

  const rememberAudience = useCallback(
    (aud: StoryAudience) => {
      saveJson(audienceKey(currentUser.id), aud);
      if (aud.mode === 'close') saveJson(closeKey(currentUser.id), aud.userIds || []);
    },
    [currentUser.id]
  );

  const applyServerStories = useCallback(
    (serverStories: ServerStory[]) => {
      // Merge server list with the cache: dedupe by id (the server copy
      // wins on conflict), 24h freshness filter (isFresh) on every entry.
      // Other users' stories come ONLY from the server — a server-deleted
      // story can never resurrect from cache. The one merge-in exception
      // is the current user's OWN local-only stories (posted offline/demo
      // in addStory's fallback, which the server never stored): without
      // this they would silently vanish on the next successful fetch.
      const byId = new Map<string, Story>();
      for (const s of serverStories.map(fromServer).filter(isFresh)) byId.set(s.id, s);
      for (const local of loadCache(currentUser.id)) {
        if (local.userId === currentUser.id && !byId.has(local.id)) byId.set(local.id, local);
      }
      const mapped = Array.from(byId.values()).filter(isFresh);
      setStories(mapped);
      saveCache(currentUser.id, mapped);
      // Server viewer records are authoritative for "seen" state too.
      setSeen((prev) => {
        const next = new Set(prev);
        for (const s of mapped) {
          if (s.viewers?.some((v) => v.userId === currentUser.id)) next.add(s.id);
        }
        const arr = Array.from(next);
        try {
          localStorage.setItem(seenKey(currentUser.id), JSON.stringify(arr));
        } catch {
          /* ignore */
        }
        return arr;
      });
    },
    [currentUser.id]
  );

  // Load from the server on mount / user change (Phase 0.6 sync) + Phase 1.1
  // mutes and own highlights. All best-effort: older servers without the new
  // endpoints simply leave the local state in place.
  useEffect(() => {
    setStories(loadCache(currentUser.id));
    setSeen(loadSeen(currentUser.id));
    setMutedIds(loadJson<string[]>(mutesKey(currentUser.id), []));
    setHighlights(
      loadJson<unknown[]>(highlightsKey(currentUser.id), []).map(fromHighlight).filter(Boolean) as Highlight[]
    );
    let cancelled = false;
    (async () => {
      try {
        const headers = await authHeaders(currentUser.id);
        const res = await fetch('/api/stories', { headers });
        if (res.ok) {
          const data = await res.json();
          if (!cancelled && Array.isArray(data?.stories)) applyServerStories(data.stories);
        }
      } catch {
        /* offline/demo — keep showing the cache */
      }
      try {
        const headers = await authHeaders(currentUser.id);
        const res = await fetch('/api/stories/mutes', { headers });
        if (res.ok) {
          const data = await res.json();
          const list: unknown = data?.mutes ?? data?.muted ?? data?.userIds;
          if (!cancelled && Array.isArray(list)) {
            const ids = list
              .map((m: any) => (typeof m === 'string' ? m : m?.userId))
              .filter((x: unknown): x is string => typeof x === 'string');
            setMutedIds(ids);
            saveJson(mutesKey(currentUser.id), ids);
          }
        }
      } catch {
        /* mutes endpoint unavailable — keep local list */
      }
      try {
        const headers = await authHeaders(currentUser.id);
        const res = await fetch(`/api/highlights?userId=${encodeURIComponent(currentUser.id)}`, { headers });
        if (res.ok) {
          const data = await res.json();
          const list: unknown = data?.highlights ?? data;
          if (!cancelled && Array.isArray(list)) {
            const mapped = list.map(fromHighlight).filter(Boolean) as Highlight[];
            setHighlights(mapped.filter((h) => h.userId === currentUser.id));
            saveJson(highlightsKey(currentUser.id), mapped.filter((h) => h.userId === currentUser.id));
          }
        }
      } catch {
        /* highlights endpoint unavailable — keep local snapshots */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentUser.id, applyServerStories]);

  const grouped = useMemo(() => {
    const byUser = new Map<string, Story[]>();
    for (const s of stories) {
      // Muted authors' rings disappear (server also excludes them from GET;
      // this covers the local cache + accounts muted mid-session).
      if (s.userId !== currentUser.id && mutedIds.includes(s.userId)) continue;
      const list = byUser.get(s.userId) || [];
      list.push(s);
      byUser.set(s.userId, list);
    }
    const groups = Array.from(byUser.entries()).map(([userId, list]) => ({
      userId,
      list: list.sort((a, b) => a.createdAt - b.createdAt),
      latest: Math.max(...list.map((s) => s.createdAt)),
      hasUnseen: list.some((s) => !seen.includes(s.id)),
    }));
    // Unseen-first, then newest
    groups.sort((a, b) => {
      if (a.hasUnseen !== b.hasUnseen) return a.hasUnseen ? -1 : 1;
      return b.latest - a.latest;
    });
    return groups;
  }, [stories, seen, mutedIds, currentUser.id]);

  const markSeen = useCallback(
    (id: string) => {
      setSeen((prev) => {
        if (prev.includes(id)) return prev;
        const next = [...prev, id];
        try {
          localStorage.setItem(seenKey(currentUser.id), JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    [currentUser.id]
  );

  // ── Create ───────────────────────────────────────────────────────────────
  const addStory = async (input: {
    media: string;
    kind: StoryKind;
    text: string;
    textData?: StoryTextData;
  }) => {
    const trimmed = input.text.trim();
    const audience = currentAudience();
    rememberAudience(audience);
    try {
      const headers = await authHeaders(currentUser.id);
      const res = await fetch('/api/stories', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          media: input.kind === 'text' ? '' : input.media,
          type: input.kind,
          kind: input.kind,
          text: input.kind === 'text' ? input.textData?.text : trimmed || undefined,
          caption: trimmed || undefined,
          textData: input.textData,
          audience,
          userName: currentUser.name,
          userAvatar: currentUser.avatar,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.story) {
          const story = fromServer(data.story);
          // Trust the server copy, but keep the audience/kind we sent if an
          // older server dropped the new fields.
          const merged: Story = {
            ...story,
            kind: story.kind || input.kind,
            audience: story.audience || audience,
            textData: story.textData || input.textData,
            reactions: story.reactions || [],
          };
          setStories((prev) => {
            const next = [...prev.filter((s) => s.id !== merged.id && isFresh(s)), merged];
            saveCache(currentUser.id, next);
            return next;
          });
          return;
        }
      }
      throw new Error('story post failed');
    } catch {
      // Server unreachable (offline/demo): keep the story locally in this
      // user's cache only; applyServerStories preserves own local-only
      // stories across later server fetches until they expire (24h).
      const story: Story = {
        id: `story_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        userId: currentUser.id,
        userName: currentUser.name,
        avatar: currentUser.avatar,
        imageUrl: input.kind === 'text' ? '' : input.media,
        caption: input.kind === 'text' ? undefined : trimmed || undefined,
        createdAt: Date.now(),
        expiresAt: Date.now() + STORY_TTL_MS,
        viewers: [],
        kind: input.kind,
        audience,
        textData: input.textData,
        reactions: [],
      };
      setStories((prev) => {
        const next = [...prev.filter(isFresh), story];
        saveCache(currentUser.id, next);
        return next;
      });
    }
  };

  const deleteStory = async (story: Story) => {
    // Optimistic local removal; the next server load confirms it.
    setStories((prev) => {
      const next = prev.filter((s) => s.id !== story.id);
      saveCache(currentUser.id, next);
      return next;
    });
    setViewer(null);
    setShowViewers(false);
    try {
      const headers = await authHeaders(currentUser.id);
      await fetch(`/api/stories/${encodeURIComponent(story.id)}`, {
        method: 'DELETE',
        headers,
      });
    } catch {
      /* already removed locally; server copy expires within 24h */
    }
  };

  // ── Reactions ────────────────────────────────────────────────────────────
  const toggleReaction = async (story: Story, emoji: string) => {
    const mine = story.reactions.some((r) => r.userId === currentUser.id && r.emoji === emoji);
    // One reaction per user (WhatsApp-style): picking another emoji moves it.
    const optimistic = mine
      ? story.reactions.filter((r) => !(r.userId === currentUser.id && r.emoji === emoji))
      : [...story.reactions.filter((r) => r.userId !== currentUser.id), { userId: currentUser.id, emoji }];
    setStories((prev) => prev.map((s) => (s.id === story.id ? { ...s, reactions: optimistic } : s)));
    try {
      const headers = await authHeaders(currentUser.id);
      const res = await fetch(`/api/stories/${encodeURIComponent(story.id)}/react`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji }),
      });
      if (res.ok) {
        const data = await res.json();
        const serverReactions: StoryReaction[] | undefined = Array.isArray(data?.reactions)
          ? data.reactions
          : data?.story?.reactions;
        if (serverReactions) {
          setStories((prev) => prev.map((s) => (s.id === story.id ? { ...s, reactions: serverReactions } : s)));
        }
      }
    } catch {
      /* keep the optimistic reaction; it re-syncs on next story load */
    }
  };

  // ── Mutes ────────────────────────────────────────────────────────────────
  const muteUser = async (userId: string) => {
    setMutedIds((prev) => {
      const next = prev.includes(userId) ? prev : [...prev, userId];
      saveJson(mutesKey(currentUser.id), next);
      return next;
    });
    setMuteMenuFor(null);
    if (viewer?.userId === userId) setViewer(null);
    try {
      const headers = await authHeaders(currentUser.id);
      await fetch('/api/stories/mutes', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
    } catch {
      /* local mute still applies to this device */
    }
  };

  const unmuteUser = async (userId: string) => {
    setMutedIds((prev) => {
      const next = prev.filter((x) => x !== userId);
      saveJson(mutesKey(currentUser.id), next);
      return next;
    });
    try {
      const headers = await authHeaders(currentUser.id);
      await fetch('/api/stories/mutes', {
        method: 'DELETE',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
    } catch {
      /* local unmute still applies; server list re-syncs on next load */
    }
    // Their stories were excluded server-side while muted — refetch so the
    // rings come back immediately.
    try {
      const headers = await authHeaders(currentUser.id);
      const res = await fetch('/api/stories', { headers });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data?.stories)) applyServerStories(data.stories);
      }
    } catch {
      /* ignore */
    }
  };

  // ── Highlights ───────────────────────────────────────────────────────────
  const addToHighlights = async (story: Story) => {
    const snapshot = toSnapshot(story);
    try {
      const headers = await authHeaders(currentUser.id);
      const res = await fetch('/api/highlights', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ story: snapshot }),
      });
      if (res.ok) {
        const data = await res.json();
        const created = fromHighlight(data?.highlight || data?.story || data);
        if (created) {
          setHighlights((prev) => {
            const next = [created, ...prev.filter((h) => h.id !== created.id && h.storyId !== story.id)];
            saveJson(highlightsKey(currentUser.id), next);
            return next;
          });
          setHighlightNotice(true);
          return;
        }
      }
      throw new Error('highlight post failed');
    } catch {
      // Endpoint unavailable (older server): keep the snapshot locally so it
      // still survives the story's expiry on this device.
      const local: Highlight = {
        id: `hl_${story.id}`,
        userId: currentUser.id,
        storyId: story.id,
        story: { ...story },
        createdAt: Date.now(),
      };
      setHighlights((prev) => {
        const next = [local, ...prev.filter((h) => h.storyId !== story.id)];
        saveJson(highlightsKey(currentUser.id), next);
        return next;
      });
      setHighlightNotice(true);
    }
  };

  const removeHighlight = async (highlight: Highlight) => {
    setHighlights((prev) => {
      const next = prev.filter((h) => h.id !== highlight.id);
      saveJson(highlightsKey(currentUser.id), next);
      return next;
    });
    setHighlightViewer(null);
    try {
      const headers = await authHeaders(currentUser.id);
      await fetch(`/api/highlights/${encodeURIComponent(highlight.id)}`, { method: 'DELETE', headers });
    } catch {
      /* already removed locally */
    }
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const isVideo = file.type.startsWith('video/');
    const reader = new FileReader();
    reader.onload = () => {
      const raw = reader.result as string;
      setCaption('');
      if (isVideo) {
        setPendingMedia({ url: raw, kind: 'video' });
        return;
      }
      // Downscale images before storing: a full-size phone photo (3–6 MB) as
      // a data URL would blow the shared localStorage quota (messages live
      // there too) and the story would silently vanish on reload. Max 1080px.
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, 1080 / Math.max(img.width, img.height));
          if (scale >= 1) {
            setPendingMedia({ url: raw, kind: 'image' });
          } else {
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('no 2d context');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            setPendingMedia({ url: canvas.toDataURL('image/jpeg', 0.85), kind: 'image' });
          }
        } catch {
          setPendingMedia({ url: raw, kind: 'image' });
        }
      };
      img.onerror = () => setPendingMedia({ url: raw, kind: 'image' });
      img.src = raw;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const myStories = grouped.find((g) => g.userId === currentUser.id)?.list || [];
  const isHighlighted = (storyId: string) => highlights.some((h) => h.storyId === storyId);

  // ── Viewer ────────────────────────────────────────────────────────────────
  const viewerGroupIdx = viewer ? grouped.findIndex((g) => g.userId === viewer.userId) : -1;
  const viewerGroup = viewerGroupIdx >= 0 ? grouped[viewerGroupIdx] : null;
  const viewerStory = viewerGroup && viewer ? viewerGroup.list[viewer.storyIdx] : null;
  const isOwnStory = !!viewerStory && viewerStory.userId === currentUser.id;
  const isVideoStory = viewerStory?.kind === 'video';

  // On opening a story: mark seen locally and record the view server-side.
  useEffect(() => {
    if (!viewerStory) return;
    markSeen(viewerStory.id);
    setShowViewers(false);
    setReplyText('');
    setReplyNotice(false);
    setHighlightNotice(false);
    setVideoMuted(true);
    if (viewerStory.userId !== currentUser.id) {
      (async () => {
        try {
          const headers = await authHeaders(currentUser.id);
          const res = await fetch(`/api/stories/${encodeURIComponent(viewerStory.id)}/view`, {
            method: 'POST',
            headers,
          });
          if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data?.viewers)) {
              setStories((prev) =>
                prev.map((s) => (s.id === viewerStory.id ? { ...s, viewers: data.viewers } : s))
              );
            }
          }
        } catch {
          /* view recording is best-effort */
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerStory?.id]);

  // Pause auto-advance while the tab is hidden
  useEffect(() => {
    const onVis = () => setPaused(document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const stepViewer = useCallback(
    (dir: 1 | -1) => {
      if (!viewer || !viewerGroup) return;
      if (dir === 1) {
        if (viewer.storyIdx < viewerGroup.list.length - 1) {
          setViewer({ userId: viewer.userId, storyIdx: viewer.storyIdx + 1 });
        } else if (viewerGroupIdx < grouped.length - 1) {
          const next = grouped[viewerGroupIdx + 1];
          setViewer({ userId: next.userId, storyIdx: 0 });
        } else {
          setViewer(null);
        }
      } else {
        if (viewer.storyIdx > 0) {
          setViewer({ userId: viewer.userId, storyIdx: viewer.storyIdx - 1 });
        } else if (viewerGroupIdx > 0) {
          const prev = grouped[viewerGroupIdx - 1];
          setViewer({ userId: prev.userId, storyIdx: prev.list.length - 1 });
        }
      }
    },
    [viewer, viewerGroup, viewerGroupIdx, grouped]
  );

  // Progress ticker: runs only while an image/text story is open and not
  // paused. Video stories drive progress from playback instead (below).
  useEffect(() => {
    setProgress(0);
  }, [viewerStory?.id]);

  useEffect(() => {
    if (!viewerStory || paused || isVideoStory) return;
    const step = 50;
    const t = setInterval(() => {
      setProgress((p) => Math.min(1, p + step / VIEW_MS));
    }, step);
    return () => clearInterval(t);
  }, [viewerStory?.id, paused, isVideoStory]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (viewerStory && !isVideoStory && progress >= 1) stepViewer(1);
  }, [progress, viewerStory, isVideoStory, stepViewer]);

  // Keep the <video> element in sync with the viewer's pause state.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !isVideoStory) return;
    if (paused) v.pause();
    else void v.play().catch(() => undefined);
  }, [paused, isVideoStory, viewerStory?.id]);

  useEffect(() => {
    if (!viewer && !highlightViewer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setViewer(null);
        setHighlightViewer(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewer, highlightViewer]);

  const submitReply = () => {
    if (!viewerStory || isOwnStory) return;
    const text = replyText.trim();
    if (!text) return;
    if (onReplyToStory) {
      onReplyToStory({
        storyId: viewerStory.id,
        authorId: viewerStory.userId,
        authorName: viewerStory.userName,
        kind: viewerStory.kind,
        snippet: storySnippet(viewerStory, lang),
        text,
        story: viewerStory,
      });
      setReplyText('');
      setViewer(null);
    } else {
      // No DM wiring yet (coordinator): keep the draft and tell the user
      // exactly how to complete the reply instead of dropping it silently.
      setReplyNotice(true);
    }
  };

  // Story rings (owner palette — SOLID colours, no gradients):
  // unviewed (others) = solid amber #F2A007, 3px; viewed = muted
  // gray-green #94A39A; own story = solid emerald #0B6E4F. Each ring is a
  // padded wrapper with an inner bg-app gap around the avatar.
  const ringWrapperCls = (hasUnseen: boolean, isOwn = false) => {
    if (isOwn) return hasUnseen ? 'bg-[#0B6E4F] p-[2.5px]' : 'bg-[#94A39A] p-[2.5px]';
    return hasUnseen ? 'bg-[#F2A007] p-[3px]' : 'bg-[#94A39A] p-[2.5px]';
  };

  const resolveUser = (userId: string): User | undefined => users.find((u) => u.id === userId);

  /** The story surface itself (image / video / text), shared by the story
   * viewer and the highlight viewer. `forHighlight` swaps the live video
   * element for a plain one (no shared ref / progress wiring). */
  const renderSurface = (story: Story, forHighlight = false) => {
    if (story.kind === 'text') {
      const td = story.textData || { text: story.caption || '', bg: STORY_TEXT_BACKGROUNDS[0].id, font: TEXT_FONTS[0].id };
      return (
        <div
          className="absolute inset-0 w-full h-full flex items-center justify-center px-8"
          style={{ background: textBgCss(td.bg) }}
        >
          <p
            className={`text-center text-2xl leading-snug break-words ${isLightBg(td.bg) ? 'text-black' : 'text-white'}`}
            style={textFontStyle(td.font)}
          >
            {td.text}
          </p>
        </div>
      );
    }
    if (story.kind === 'video') {
      return (
        <video
          ref={forHighlight ? undefined : videoRef}
          src={story.imageUrl}
          autoPlay
          muted={forHighlight ? true : videoMuted}
          playsInline
          className="absolute inset-0 w-full h-full object-cover bg-black"
          onTimeUpdate={
            forHighlight
              ? undefined
              : (e) => {
                  const v = e.currentTarget;
                  if (v.duration > 0) setProgress(Math.min(1, v.currentTime / v.duration));
                }
          }
          onEnded={forHighlight ? undefined : () => stepViewer(1)}
          onClick={
            forHighlight
              ? undefined
              : (e) => {
                  e.stopPropagation();
                  setVideoMuted((m) => !m);
                }
          }
        />
      );
    }
    return (
      <img src={story.imageUrl} alt={story.caption || 'Story'} className="absolute inset-0 w-full h-full object-cover" />
    );
  };

  const sortedViewers = useMemo(() => {
    const list = [...(viewerStory?.viewers || [])];
    return list.sort((a, b) => b.viewedAt - a.viewedAt);
  }, [viewerStory?.viewers]);

  const viewerReactionCounts = viewerStory ? reactionCounts(viewerStory.reactions, currentUser.id) : [];

  return (
    <div className="shrink-0 select-none">
      <input ref={fileInputRef} type="file" accept="image/*,video/*" onChange={handleFile} className="hidden" />

      {/* Section label */}
      <p className="px-1 text-[13px] font-semibold text-app-2">{lang === 'bn' ? 'স্টোরি' : 'Stories'}</p>

      {/* Horizontal story circles */}
      <style>{`.stories-row::-webkit-scrollbar { display: none; } .stories-row { scrollbar-width: none; }`}</style>
      <div className="stories-row flex gap-4 overflow-x-auto px-1 py-3">
        {/* My status / add */}
        <div className="flex flex-col items-center gap-1.5 shrink-0 w-16">
          <button
            onClick={() => (myStories.length > 0 ? setViewer({ userId: currentUser.id, storyIdx: 0 }) : setChooserOpen(true))}
            className="relative"
            title={lang === 'bn' ? 'আমার স্ট্যাটাস' : 'My status'} aria-label={lang === 'bn' ? 'আমার স্ট্যাটাস' : 'My status'}
          >
            <span className={`block rounded-full ${ringWrapperCls(myStories.length > 0, true)}`}>
              <span className="block rounded-full bg-app p-[2px]">
                <img
                  src={currentUser.avatar || initialsAvatarDataUrl(currentUser.name)}
                  alt={currentUser.name}
                  className="w-14 h-14 rounded-full object-cover bg-surface"
                />
              </span>
            </span>
            <span
              onClick={(e) => {
                e.stopPropagation();
                setChooserOpen(true);
              }}
              className="absolute -bottom-0.5 -right-0.5 w-6 h-6 rounded-full bg-[#0B6E4F] text-white flex items-center justify-center ring-2 ring-[var(--c-bg)] hover:scale-110 transition-transform"
              title={lang === 'bn' ? 'নতুন স্ট্যাটাস যোগ করুন' : 'Add new status'}
            >
              <Plus className="w-4 h-4" />
            </span>
          </button>
          <span className="text-xs text-app-2 truncate w-full text-center">
            {lang === 'bn' ? 'আমার স্ট্যাটাস' : 'My status'}
          </span>
        </div>

        {/* Empty state: no stories at all — a designed hint next to the
            own-story add tile instead of a bare rail. No fake stories. */}
        {stories.length === 0 && (
          <div className="flex items-center shrink-0 self-center max-w-[240px] rounded-[var(--r-card)] border border-dashed border-token px-4 py-3">
            <p className="text-xs text-app-2 leading-relaxed bn-safe">
              {lang === 'bn'
                ? 'এখনো কোনো স্টোরি নেই — + চাপ দিয়ে আপনার প্রথম মুহূর্তটি শেয়ার করুন।'
                : 'No stories yet — tap + to share your first moment.'}
            </p>
          </div>
        )}

        {/* Other users' stories (muted authors are filtered out in `grouped`) */}
        {grouped
          .filter((g) => g.userId !== currentUser.id)
          .map((g) => (
            <div key={g.userId} className="relative flex flex-col items-center gap-1.5 shrink-0 w-16">
              <button onClick={() => setViewer({ userId: g.userId, storyIdx: 0 })} title={g.list[0]?.userName} aria-label={lang === 'bn' ? `${g.list[0]?.userName}-এর স্টোরি` : `${g.list[0]?.userName}'s story`} >
                <span className={`block rounded-full ${ringWrapperCls(g.hasUnseen)}`}>
                  <span className="block rounded-full bg-app p-[2px]">
                    <img
                      src={g.list[0]?.avatar}
                      alt={g.list[0]?.userName}
                      className="w-14 h-14 rounded-full object-cover bg-surface"
                    />
                  </span>
                </span>
              </button>
              <span className="text-xs text-app-2 truncate w-full text-center">
                {g.list[0]?.userName?.split(' ')[0]}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setMuteMenuFor((cur) => (cur === g.userId ? null : g.userId));
                }}
                className="absolute -top-1 -right-0.5 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full bg-surface shadow-soft text-app-2 hover:text-app"
                title={lang === 'bn' ? 'স্টোরি অপশন' : 'Story options'} aria-label={lang === 'bn' ? 'স্টোরি অপশন' : 'Story options'}
               aria-expanded={muteMenuFor === g.userId} >
                <MoreVertical className="w-3.5 h-3.5" />
              </button>
              {muteMenuFor === g.userId && (
                <div className="absolute top-14 left-1/2 -translate-x-1/2 z-30 w-44 rounded-2xl bg-app shadow-2xl border border-token p-1.5 animate-in zoom-in-95">
                  <button
                    onClick={() => {
                      setMuteMenuFor(null);
                      setViewer({ userId: g.userId, storyIdx: 0 });
                    }}
                    className="w-full text-left px-2.5 py-2 rounded-xl text-xs font-semibold text-app hover:bg-bubble-in"
                  >
                    {lang === 'bn' ? 'স্টোরি দেখুন' : 'View stories'}
                  </button>
                  <button
                    onClick={() => void muteUser(g.userId)}
                    className="w-full flex items-center gap-2 text-left px-2.5 py-2 rounded-xl text-xs font-semibold text-danger hover:bg-bubble-in"
                  >
                    <BellOff className="w-3.5 h-3.5" />
                    {lang === 'bn' ? 'স্টোরি মিউট করুন' : 'Mute stories'}
                  </button>
                </div>
              )}
            </div>
          ))}
      </div>

      {/* Muted management: muted rings disappear, so unmuting needs its own
          surface — a quiet text row, only when someone is muted. */}
      {mutedIds.length > 0 && (
        <div className="px-1 pb-1">
          <button
            onClick={() => setShowMutedPanel((v) => !v)}
            className="flex items-center gap-1.5 text-[11px] font-semibold text-app-faint hover:text-app-2"
          >
            <BellOff className="w-3 h-3" />
            {lang === 'bn' ? `মিউট করা (${mutedIds.length})` : `Muted (${mutedIds.length})`}
          </button>
          {showMutedPanel && (
            <div className="mt-2 rounded-2xl bg-surface p-2 space-y-1">
              {mutedIds.map((id) => {
                const u = resolveUser(id);
                return (
                  <div key={id} className="flex items-center gap-2.5 px-2 py-1.5">
                    {u?.avatar ? (
                      <img src={u.avatar} alt={u.name} className="w-8 h-8 rounded-full object-cover" />
                    ) : (
                      <span className="w-8 h-8 rounded-full bg-pressed text-app-2 flex items-center justify-center text-xs font-bold">
                        {(u?.name || id).charAt(0).toUpperCase()}
                      </span>
                    )}
                    <span className="flex-1 text-xs font-semibold text-app truncate">{u?.name || id}</span>
                    <button
                      onClick={() => void unmuteUser(id)}
                      className="flex items-center gap-1 text-[11px] font-bold text-primary hover:underline"
                    >
                      <Bell className="w-3 h-3" /> {lang === 'bn' ? 'আনমিউট' : 'Unmute'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Own highlights row (snapshots survive story expiry) */}
      <HighlightsRow highlights={highlights} lang={lang} onOpen={(h) => setHighlightViewer(h)} />

      {/* Story viewer */}
      {viewer && viewerStory && (
        <div className="fixed inset-0 z-50 bg-black/95 flex items-center justify-center animate-in fade-in" style={{ animationDuration: 'var(--dur-sheet)', animationTimingFunction: 'var(--ease-spring)' }} role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'স্টোরি' : 'Story viewer'} >
          {/* Tap zones (bottom action bar is z-30 and stops propagation) */}
          <button
            aria-label="Previous"
            onClick={() => stepViewer(-1)}
            className="absolute left-0 top-0 bottom-0 w-1/3 z-10 cursor-w-resize"
          />
          <button
            aria-label="Next"
            onClick={() => stepViewer(1)}
            className="absolute right-0 top-0 bottom-0 w-2/3 z-10 cursor-e-resize"
          />

          <div className="relative w-full max-w-md h-full sm:h-[92vh] sm:rounded-3xl overflow-hidden bg-black select-none">
            {renderSurface(viewerStory)}
            <div className="absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/70 to-transparent pointer-events-none" />
            <div className="absolute inset-x-0 bottom-0 h-36 bg-gradient-to-t from-black/70 to-transparent pointer-events-none" />

            {/* Progress bars — driven by accumulated progress (image/text)
                or by video playback position (video). Pausing freezes them. */}
            <div className="absolute top-3 inset-x-3 flex gap-1.5 z-20">
              {viewerGroup!.list.map((s, i) => (
                <div key={s.id} className="flex-1 h-1 rounded-full bg-white/30 overflow-hidden">
                  {i < viewer.storyIdx && <div className="h-full w-full bg-[#F2A007] rounded-full" />}
                  {i === viewer.storyIdx && (
                    <div
                      className="h-full bg-[#F2A007] rounded-full"
                      style={{ width: `${Math.round(progress * 100)}%` }}
                    />
                  )}
                </div>
              ))}
            </div>

            {/* Header */}
            <div className="absolute top-6 inset-x-3 flex items-center gap-2.5 z-20 glass-pill px-3 py-1.5">
              <img src={viewerStory.avatar} alt={viewerStory.userName} className="w-9 h-9 rounded-full object-cover ring-2 ring-white/50" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-app truncate">{viewerStory.userName}</p>
                <p className="text-[11px] text-app-2">
                  {timeAgo(viewerStory.createdAt, lang)} · {formatExact(viewerStory.createdAt, lang)}
                </p>
              </div>
              {isVideoStory && (
                <span className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full text-app z-30" title={videoMuted ? 'Muted' : 'Sound on'}>
                  {videoMuted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
                </span>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setPaused((p) => !p);
                }}
                className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full text-app hover:bg-pressed transition-colors z-30"
                title={paused ? (lang === 'bn' ? 'চালান' : 'Play') : (lang === 'bn' ? 'থামান' : 'Pause')} aria-label={paused ? (lang === 'bn' ? 'চালান' : 'Play') : (lang === 'bn' ? 'থামান' : 'Pause')}
              >
                {paused ? <Play className="w-5 h-5" /> : <Pause className="w-5 h-5" />}
              </button>
              {isOwnStory && (
                <>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!isHighlighted(viewerStory.id)) void addToHighlights(viewerStory);
                    }}
                    className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full text-app hover:bg-pressed transition-colors z-30"
                    title={
                      isHighlighted(viewerStory.id)
                        ? lang === 'bn'
                          ? 'হাইলাইটে আছে'
                          : 'In highlights'
                        : lang === 'bn'
                          ? 'হাইলাইটে যোগ করুন'
                          : 'Add to highlights'
                    } aria-label={
                      isHighlighted(viewerStory.id)
                        ? lang === 'bn'
                          ? 'হাইলাইটে আছে'
                          : 'In highlights'
                        : lang === 'bn'
                          ? 'হাইলাইটে যোগ করুন'
                          : 'Add to highlights'
                    }
                  >
                    <Star className={`w-5 h-5 ${isHighlighted(viewerStory.id) ? 'fill-current text-primary' : ''}`} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteStory(viewerStory);
                    }}
                    className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full text-app hover:bg-danger hover:text-white transition-colors z-30"
                    title={lang === 'bn' ? 'স্টোরি মুছুন' : 'Delete story'} aria-label={lang === 'bn' ? 'স্টোরি মুছুন' : 'Delete story'}
                  >
                    <Trash2 className="w-5 h-5" />
                  </button>
                </>
              )}
              {!isOwnStory && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void muteUser(viewerStory.userId);
                  }}
                  className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full text-app hover:bg-pressed transition-colors z-30"
                  title={lang === 'bn' ? 'এই ব্যবহারকারীর স্টোরি মিউট করুন' : "Mute this user's stories"} aria-label={lang === 'bn' ? 'এই ব্যবহারকারীর স্টোরি মিউট করুন' : "Mute this user's stories"}
                >
                  <BellOff className="w-5 h-5" />
                </button>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setViewer(null);
                }}
                className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full text-app hover:bg-pressed transition-colors z-30"
                title={lang === 'bn' ? 'বন্ধ করুন' : 'Close'} aria-label={lang === 'bn' ? 'বন্ধ করুন' : 'Close'}
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Caption (image/video only; text stories ARE the surface) */}
            {viewerStory.caption && viewerStory.kind !== 'text' && (
              <div className="absolute bottom-32 inset-x-4 z-20 text-center pointer-events-none">
                <p className="text-white text-sm font-semibold bg-black/45 rounded-2xl px-4 py-2.5 inline-block">
                  {viewerStory.caption}
                </p>
              </div>
            )}

            {highlightNotice && isOwnStory && (
              <div className="absolute top-20 inset-x-0 z-30 flex justify-center pointer-events-none">
                <span className="flex items-center gap-1.5 text-white text-xs font-semibold bg-black/55 rounded-full px-3 py-1.5">
                  <Star className="w-3.5 h-3.5 fill-current text-primary" />
                  {lang === 'bn' ? 'হাইলাইটে যোগ হয়েছে' : 'Added to highlights'}
                </span>
              </div>
            )}

            {/* Bottom action area */}
            <div className="absolute bottom-4 inset-x-4 z-30 space-y-2.5 glass rounded-[var(--r-sheet)] p-3" onClick={(e) => e.stopPropagation()}>
              {/* Reaction counts received (own) / given (others) */}
              {viewerReactionCounts.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {viewerReactionCounts.map((r) => (
                    <span
                      key={r.emoji}
                      className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${
                        r.mine ? 'bg-app text-app' : 'bg-white/25 text-app'
                      }`}
                    >
                      <span>{r.emoji}</span> {r.count}
                    </span>
                  ))}
                </div>
              )}

              {isOwnStory ? (
                /* Own story: viewers affordance + polished list (who + when) */
                <div>
                  <button
                    onClick={() => setShowViewers((v) => !v)}
                    className="flex items-center gap-1.5 text-app text-xs font-semibold bg-app rounded-full px-3 min-h-[44px] hover:bg-surface transition-colors"
                   aria-expanded={showViewers} >
                    <Eye className="w-4 h-4" />
                    {lang === 'bn' ? `দেখেছেন ${sortedViewers.length} জন` : `Seen by ${sortedViewers.length}`}
                  </button>
                  {showViewers && (
                    <div className="mt-2 max-h-56 overflow-y-auto rounded-2xl bg-white/25 p-2 space-y-1">
                      {sortedViewers.length === 0 ? (
                        <p className="text-app-2 text-xs px-2 py-1.5">
                          {lang === 'bn' ? 'এখনো কেউ দেখেনি' : 'No views yet'}
                        </p>
                      ) : (
                        sortedViewers.map((v) => {
                          const u = resolveUser(v.userId);
                          const theirReaction = (viewerStory.reactions || []).find((r) => r.userId === v.userId);
                          return (
                            <div key={v.userId} className="flex items-center gap-2.5 px-2 py-1.5">
                              {u?.avatar ? (
                                <img src={u.avatar} alt={u.name} className="w-8 h-8 rounded-full object-cover" />
                              ) : (
                                <span className="w-8 h-8 rounded-full bg-pressed text-app flex items-center justify-center text-xs font-bold">
                                  {(u?.name || v.userId).charAt(0).toUpperCase()}
                                </span>
                              )}
                              <div className="min-w-0 flex-1">
                                <p className="text-app text-xs font-semibold truncate">{u?.name || v.userId}</p>
                                <p className="text-app-2 text-[10px]">
                                  {timeAgo(v.viewedAt, lang)} · {formatExact(v.viewedAt, lang)}
                                </p>
                              </div>
                              {theirReaction && <span className="text-base" title="Reaction">{theirReaction.emoji}</span>}
                            </div>
                          );
                        })
                      )}
                      {/* Reactions from people not in the viewers list (edge) */}
                      {(viewerStory.reactions || [])
                        .filter((r) => !sortedViewers.some((v) => v.userId === r.userId))
                        .map((r) => {
                          const u = resolveUser(r.userId);
                          return (
                            <div key={`rx-${r.userId}`} className="flex items-center gap-2.5 px-2 py-1.5">
                              <span className="w-8 h-8 rounded-full bg-pressed text-app flex items-center justify-center text-xs font-bold">
                                {(u?.name || r.userId).charAt(0).toUpperCase()}
                              </span>
                              <p className="flex-1 text-app text-xs font-semibold truncate">{u?.name || r.userId}</p>
                              <span className="text-base">{r.emoji}</span>
                            </div>
                          );
                        })}
                    </div>
                  )}
                </div>
              ) : (
                /* Others' story: quick reactions + reply-to-story */
                <>
                  <div className="flex items-center gap-1.5">
                    {QUICK_REACTIONS.map((emoji) => {
                      const mine = viewerStory.reactions.some((r) => r.userId === currentUser.id && r.emoji === emoji);
                      const count = viewerStory.reactions.filter((r) => r.emoji === emoji).length;
                      return (
                        <button
                          key={emoji}
                          onClick={() => void toggleReaction(viewerStory, emoji)}
                          className={`flex items-center gap-1 rounded-full px-2.5 py-1.5 min-h-[44px] text-base transition-all hover:scale-110 ${
                            mine ? 'bg-app shadow-soft' : 'bg-white/25'
                          }`}
                          title={lang === 'bn' ? 'রিঅ্যাক্ট করুন' : 'React'}
                         aria-label={`React with ${emoji}`} >
                          <span>{emoji}</span>
                          {count > 0 && <span className="text-[11px] font-bold text-app">{count}</span>}
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 flex items-center gap-2 bg-app rounded-full pl-4 pr-1.5 py-1.5">
                      <MessageCircle className="w-4 h-4 text-app-faint shrink-0" />
                      <input
                        value={replyText}
                        onChange={(e) => {
                          setReplyText(e.target.value);
                          setReplyNotice(false);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') submitReply();
                        }}
                        placeholder={
                          lang === 'bn'
                            ? `${viewerStory.userName}-কে রিপ্লাই দিন...`
                            : `Reply to ${viewerStory.userName.split(' ')[0]}...`
                        }
                        className="flex-1 min-w-0 bg-transparent text-app text-sm placeholder:text-app-faint"
                       aria-label={lang === 'bn' ? 'স্টোরিতে রিপ্লাই দিন' : 'Reply to story'} />
                      <button
                        onClick={submitReply}
                        disabled={!replyText.trim()}
                        className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full bg-primary text-white disabled:opacity-40 hover:scale-105 transition-transform"
                        title={lang === 'bn' ? 'পাঠান' : 'Send reply'} aria-label={lang === 'bn' ? 'পাঠান' : 'Send reply'}
                      >
                        <Send className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  {replyNotice && (
                    <p className="text-app-2 text-[11px] bg-surface rounded-xl px-3 py-2">
                      {lang === 'bn'
                        ? `রিপ্লাই পাঠাতে ${viewerStory.userName}-এর চ্যাট খুলুন — স্টোরিটি সেখানে উদ্ধৃত হবে।`
                        : `Open your chat with ${viewerStory.userName} to send this reply with the story quoted.`}
                    </p>
                  )}
                </>
              )}
            </div>

            {/* Desktop prev/next arrows */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                stepViewer(-1);
              }}
              className="hidden sm:flex items-center justify-center min-w-[44px] min-h-[44px] absolute left-2 top-1/2 -translate-y-1/2 z-30 p-2 rounded-full bg-black/40 text-white hover:bg-black/60 transition-colors"
              title={lang === 'bn' ? 'আগেরটি' : 'Previous'} aria-label={lang === 'bn' ? 'আগেরটি' : 'Previous'}
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                stepViewer(1);
              }}
              className="hidden sm:flex items-center justify-center min-w-[44px] min-h-[44px] absolute right-2 top-1/2 -translate-y-1/2 z-30 p-2 rounded-full bg-black/40 text-white hover:bg-black/60 transition-colors"
              title={lang === 'bn' ? 'পরেরটি' : 'Next'} aria-label={lang === 'bn' ? 'পরেরটি' : 'Next'}
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>
        </div>
      )}

      {/* Highlight viewer (snapshot; no expiry, no progress timer) */}
      {highlightViewer && (
        <div className="fixed inset-0 z-50 bg-black/95 flex items-center justify-center animate-in fade-in" style={{ animationDuration: 'var(--dur-sheet)', animationTimingFunction: 'var(--ease-spring)' }} role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'স্টোরি হাইলাইট' : 'Story highlight'} >
          <div className="relative w-full max-w-md h-full sm:h-[92vh] sm:rounded-3xl overflow-hidden bg-black select-none">
            {renderSurface(highlightViewer.story, true)}
            <div className="absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/70 to-transparent pointer-events-none" />
            <div className="absolute top-6 inset-x-3 flex items-center gap-2.5 z-20 glass-pill px-3 py-1.5">
              <img
                src={highlightViewer.story.avatar}
                alt={highlightViewer.story.userName}
                className="w-9 h-9 rounded-full object-cover ring-2 ring-white/50"
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-app truncate">{highlightViewer.story.userName}</p>
                <p className="text-[11px] text-app-2 flex items-center gap-1">
                  <Star className="w-3 h-3 fill-current text-primary" />
                  {lang === 'bn' ? 'হাইলাইট' : 'Highlight'} · {formatExact(highlightViewer.story.createdAt, lang)}
                </p>
              </div>
              {highlightViewer.userId === currentUser.id && (
                <button
                  onClick={() => void removeHighlight(highlightViewer)}
                  className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full text-app hover:bg-danger hover:text-white transition-colors z-30"
                  title={lang === 'bn' ? 'হাইলাইট সরান' : 'Remove highlight'} aria-label={lang === 'bn' ? 'হাইলাইট সরান' : 'Remove highlight'}
                >
                  <Trash2 className="w-5 h-5" />
                </button>
              )}
              <button
                onClick={() => setHighlightViewer(null)}
                className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full text-app hover:bg-pressed transition-colors z-30"
                title={lang === 'bn' ? 'বন্ধ করুন' : 'Close'} aria-label={lang === 'bn' ? 'বন্ধ করুন' : 'Close'}
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            {highlightViewer.story.caption && highlightViewer.story.kind !== 'text' && (
              <div className="absolute bottom-16 inset-x-4 z-20 text-center pointer-events-none">
                <p className="text-white text-sm font-semibold bg-black/45 rounded-2xl px-4 py-2.5 inline-block">
                  {highlightViewer.story.caption}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Create chooser: Photo/Video · Text */}
      {chooserOpen && !composerOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center p-4 animate-in fade-in">
          <div className="glass-sheet w-full max-w-sm p-4 animate-in zoom-in-95" style={{ animationDuration: 'var(--dur-sheet)', animationTimingFunction: 'var(--ease-spring)' }} role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'স্টোরি যোগ করুন' : 'Add story'} >
            <div className="flex items-center justify-between pb-2">
              <p className="text-sm font-bold text-app">
                {lang === 'bn' ? 'নতুন স্টোরি' : 'New story'}
              </p>
              <button
                onClick={() => setChooserOpen(false)}
                className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full text-app-faint hover:bg-bubble-in"
                title={lang === 'bn' ? 'বন্ধ করুন' : 'Close'} aria-label={lang === 'bn' ? 'বন্ধ করুন' : 'Close'}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex flex-col items-center gap-2 rounded-2xl bg-bubble-in py-5 text-app hover:bg-pressed transition-colors"
              >
                <span className="flex gap-1.5">
                  <ImageIcon className="w-6 h-6" />
                  <Video className="w-6 h-6" />
                </span>
                <span className="text-xs font-bold">{lang === 'bn' ? 'ছবি / ভিডিও' : 'Photo / Video'}</span>
              </button>
              <button
                onClick={() => {
                  setTextDraft('');
                  setTextComposer(true);
                }}
                className="flex flex-col items-center gap-2 rounded-2xl text-white py-5 hover:opacity-90 transition-opacity"
                style={{ background: textBgCss(textBg) }}
              >
                <Type className="w-6 h-6" />
                <span className="text-xs font-bold">{lang === 'bn' ? 'টেক্সট স্টোরি' : 'Text story'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Media composer: preview + caption + audience + post */}
      {pendingMedia && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 animate-in fade-in">
          <div className="glass-sheet w-full max-w-sm overflow-hidden animate-in zoom-in-95 max-h-[92vh] overflow-y-auto" style={{ animationDuration: 'var(--dur-sheet)', animationTimingFunction: 'var(--ease-spring)' }} role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'নতুন স্টোরি' : 'New story'} >
            {pendingMedia.kind === 'video' ? (
              <video src={pendingMedia.url} autoPlay muted loop playsInline className="w-full aspect-square object-cover bg-black" />
            ) : (
              <img src={pendingMedia.url} alt="New status" className="w-full aspect-square object-cover" />
            )}
            <div className="p-4 space-y-3">
              <input
                autoFocus
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    void addStory({ media: pendingMedia.url, kind: pendingMedia.kind, text: caption });
                    setPendingMedia(null);
                    setChooserOpen(false);
                  }
                }}
                placeholder={lang === 'bn' ? 'ক্যাপশন লিখুন (ঐচ্ছিক)...' : 'Add a caption (optional)...'} aria-label={lang === 'bn' ? 'ক্যাপশন লিখুন (ঐচ্ছিক)...' : 'Add a caption (optional)...'}
                className="w-full bg-bubble-in rounded-xl px-3.5 py-2.5 text-sm text-app placeholder:text-app-faint"
              />
              <AudienceSelector
                lang={lang}
                users={users}
                currentUserId={currentUser.id}
                mode={audienceMode}
                onModeChange={setAudienceMode}
                selectedIds={audienceIds}
                onSelectedIdsChange={setAudienceIds}
              />
              {(audienceMode === 'close' || audienceMode === 'custom') && audienceIds.length === 0 && (
                <p className="text-[11px] text-danger">
                  {lang === 'bn' ? 'কমপক্ষে একজনকে বেছে নিন।' : 'Pick at least one person for this audience.'}
                </p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setPendingMedia(null);
                    setChooserOpen(false);
                  }}
                  className="flex-1 py-2.5 rounded-xl bg-bubble-in text-app text-sm font-bold"
                >
                  {lang === 'bn' ? 'বাতিল' : 'Cancel'}
                </button>
                <button
                  onClick={() => {
                    void addStory({ media: pendingMedia.url, kind: pendingMedia.kind, text: caption });
                    setPendingMedia(null);
                    setChooserOpen(false);
                  }}
                  disabled={(audienceMode === 'close' || audienceMode === 'custom') && audienceIds.length === 0}
                  className="flex-1 py-2.5 rounded-xl bg-primary text-white text-sm font-bold shadow-soft flex items-center justify-center gap-1.5 disabled:opacity-40"
                >
                  <Send className="w-4 h-4" /> {lang === 'bn' ? 'পোস্ট করুন' : 'Post'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Text story composer: live preview + bg/font choices + audience */}
      {textComposer && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 animate-in fade-in">
          <div className="glass-sheet w-full max-w-sm overflow-hidden animate-in zoom-in-95 max-h-[92vh] overflow-y-auto" style={{ animationDuration: 'var(--dur-sheet)', animationTimingFunction: 'var(--ease-spring)' }} role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'নতুন টেক্সট স্টোরি' : 'New text story'} >
            <div className="relative w-full aspect-[4/3] flex items-center justify-center px-8" style={{ background: textBgCss(textBg) }}>
              <p
                className={`text-center text-2xl leading-snug break-words ${isLightBg(textBg) ? 'text-black' : 'text-white'}`}
                style={textFontStyle(textFont)}
              >
                {textDraft || (lang === 'bn' ? 'আপনার লেখা...' : 'Your text...')}
              </p>
            </div>
            <div className="p-4 space-y-3">
              <textarea
                autoFocus
                value={textDraft}
                onChange={(e) => setTextDraft(e.target.value)}
                rows={2}
                maxLength={300}
                placeholder={lang === 'bn' ? 'স্টোরির লেখা লিখুন...' : 'Write your story...'} aria-label={lang === 'bn' ? 'স্টোরির লেখা লিখুন...' : 'Write your story...'}
                className="w-full bg-bubble-in rounded-xl px-3.5 py-2.5 text-sm text-app placeholder:text-app-faint resize-none"
              />
              <div>
                <p className="text-xs font-semibold text-app-2 pb-1.5">
                  {lang === 'bn' ? 'ব্যাকগ্রাউন্ড' : 'Background'}
                </p>
                <div className="flex gap-2">
                  {STORY_TEXT_BACKGROUNDS.map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() => setTextBg(b.id)}
                      title={b.label} aria-label={b.label}
                      className={`w-9 h-9 rounded-full shrink-0 transition-transform ${
                        textBg === b.id ? 'ring-2 ring-[var(--c-focus)] scale-110' : 'hover:scale-105'
                      }`}
                      style={{ background: b.css }}
                     aria-pressed={textBg === b.id} />
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs font-semibold text-app-2 pb-1.5">
                  {lang === 'bn' ? 'ফন্ট' : 'Font'}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {TEXT_FONTS.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setTextFont(f.id)}
                      className={`px-3 py-1.5 rounded-full text-xs transition-colors ${
                        textFont === f.id
                          ? 'bg-primary text-white'
                          : 'bg-bubble-in text-app-2'
                      }`}
                      style={{ fontFamily: f.style.fontFamily }}
                     aria-pressed={textFont === f.id} >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
              <AudienceSelector
                lang={lang}
                users={users}
                currentUserId={currentUser.id}
                mode={audienceMode}
                onModeChange={setAudienceMode}
                selectedIds={audienceIds}
                onSelectedIdsChange={setAudienceIds}
              />
              {(audienceMode === 'close' || audienceMode === 'custom') && audienceIds.length === 0 && (
                <p className="text-[11px] text-danger">
                  {lang === 'bn' ? 'কমপক্ষে একজনকে বেছে নিন।' : 'Pick at least one person for this audience.'}
                </p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setTextComposer(false);
                    setChooserOpen(false);
                  }}
                  className="flex-1 py-2.5 rounded-xl bg-bubble-in text-app text-sm font-bold"
                >
                  {lang === 'bn' ? 'বাতিল' : 'Cancel'}
                </button>
                <button
                  onClick={() => {
                    void addStory({
                      media: '',
                      kind: 'text',
                      text: textDraft,
                      textData: { text: textDraft.trim(), bg: textBg, font: textFont },
                    });
                    setTextComposer(false);
                    setChooserOpen(false);
                  }}
                  disabled={!textDraft.trim() || ((audienceMode === 'close' || audienceMode === 'custom') && audienceIds.length === 0)}
                  className="flex-1 py-2.5 rounded-xl bg-primary text-white text-sm font-bold shadow-soft flex items-center justify-center gap-1.5 disabled:opacity-40"
                >
                  <Send className="w-4 h-4" /> {lang === 'bn' ? 'পোস্ট করুন' : 'Post'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
