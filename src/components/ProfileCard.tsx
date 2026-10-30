import React, { useState, useEffect } from 'react';
import { X, MessageCircle, Phone, ShieldBan, Image as ImageIcon, Share2 } from 'lucide-react';
import { authHeaders, type PrivacyAudiences } from '../services/firebase';
import {
  HighlightsRow,
  TEXT_BGS,
  TEXT_FONTS,
  textBgCss,
  textFontStyle,
  isLightBg,
  type Highlight,
  type Story
} from './StoriesBar';

// Read-only other-user profile card (Phase 1.4.2). Pure presentational:
// all audience decisions are made from the viewed user's own privacy
// audiences carried on the user object; actions are callbacks owned by
// the caller (App / chat surfaces).

export interface ProfileCardUser {
  id: string;
  name: string;
  username?: string;
  avatar?: string;
  /** Multi-line About (Phase 1.4.5). */
  about?: string;
  /** One-line mood/status. */
  status?: string;
  online?: boolean;
  presence?: 'online' | 'away' | 'offline';
  /** Pre-formatted last-seen string (legacy local users). */
  lastSeen?: string;
  /** Real last-seen timestamp, epoch ms (server presence, contract v2). */
  lastSeenAt?: number;
  privacy?: PrivacyAudiences;
  /** True when the viewer shares a DM/group relationship with this user —
   * the 'contacts' audience ≈ room co-members (contract v2). */
  isContact?: boolean;
}

interface ProfileCardProps {
  user: ProfileCardUser;
  onMessage: (user: ProfileCardUser) => void;
  onCall: (user: ProfileCardUser) => void;
  onClose: () => void;
  onBlock?: (user: ProfileCardUser) => void;
  /** Optional (Team CL wiring): when provided, a "Share contact" button is
   * shown; the caller opens its chat picker and sends a contactCard
   * message for this user. The card itself owns no picker. */
  onShareContact?: (user: ProfileCardUser) => void;
  sharedMediaCount?: number;
  onOpenSharedMedia?: (user: ProfileCardUser) => void;
  lang?: 'bn' | 'en';
}

type AudienceField = 'photo' | 'about' | 'lastSeen';

function audienceAllows(user: ProfileCardUser, field: AudienceField): boolean {
  const audience = user.privacy?.[field];
  if (!audience || audience === 'everyone') return true;
  if (audience === 'nobody') return false;
  // 'contacts'
  return !!user.isContact;
}

/** Map one raw GET /api/highlights entry to the HighlightsRow shape.
 * The server stores highlights as flat story snapshots (POST spreads the
 * snapshot, adding highlightedBy/highlightedAt); older/nested shapes carry
 * the snapshot under `story`/`snapshot`. Mirrors StoriesBar's fromServer /
 * fromHighlight normalisation, which are not exported. */
function mapHighlight(raw: unknown, fallback: ProfileCardUser): Highlight | null {
  try {
    const h = raw as Record<string, any>;
    const s = (h.story || h.snapshot || h) as Record<string, any>;
    if (!s || !(s.id || s.storyId)) return null;
    const rawKind = s.kind || s.type;
    let kind: Story['kind'];
    if (rawKind === 'video') kind = 'video';
    else if (rawKind === 'text')
      kind = s.textData ? 'text' : s.media || s.imageUrl ? 'image' : 'text';
    else kind = 'image';
    const storyCreated = typeof s.createdAt === 'number' ? s.createdAt : 0;
    const createdAt =
      typeof h.createdAt === 'number'
        ? h.createdAt
        : typeof h.highlightedAt === 'number'
          ? h.highlightedAt
          : storyCreated;
    const story: Story = {
      id: String(s.id || s.storyId),
      userId: String(s.userId || fallback.id),
      userName: typeof s.userName === 'string' ? s.userName : fallback.name,
      avatar: s.userAvatar || s.avatar || '',
      imageUrl: s.media || s.imageUrl || '',
      caption: kind === 'text' ? undefined : s.text || s.caption || undefined,
      createdAt: storyCreated || createdAt,
      // Highlights survive the story's 24h expiry by design.
      expiresAt: typeof s.expiresAt === 'number' ? s.expiresAt : Number.MAX_SAFE_INTEGER,
      viewers: Array.isArray(s.viewers) ? s.viewers : [],
      kind,
      audience: s.audience,
      textData:
        s.textData ||
        (kind === 'text'
          ? { text: s.text || s.caption || '', bg: TEXT_BGS[0].id, font: TEXT_FONTS[0].id }
          : undefined),
      reactions: Array.isArray(s.reactions) ? s.reactions : []
    };
    return {
      id: String(h.id || `hl_${story.id}`),
      userId: String(h.userId || story.userId),
      storyId: story.id,
      story,
      createdAt: createdAt || story.createdAt
    };
  } catch {
    return null;
  }
}

function initialsOf(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .map((part) => part[0])
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?'
  );
}

/** Render About text with http(s) links turned into anchors. */
export function linkifyAbout(text: string): React.ReactNode[] {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return parts.map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:underline break-all"
        onClick={(e) => e.stopPropagation()}
      >
        {part}
      </a>
    ) : (
      <React.Fragment key={i}>{part}</React.Fragment>
    )
  );
}

/** "last seen today at 14:32" / "yesterday at …" / "on 12 Oct at …" from a
 * real timestamp — never a fabricated string. */
export function formatLastSeen(ts: number, lang: 'bn' | 'en'): string {
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  if (lang === 'bn') {
    if (sameDay) return `আজ ${time}-এ শেষ দেখা গেছে`;
    if (isYesterday) return `গতকাল ${time}-এ শেষ দেখা গেছে`;
    return `${d.toLocaleDateString()} ${time}-এ শেষ দেখা গেছে`;
  }
  if (sameDay) return `last seen today at ${time}`;
  if (isYesterday) return `last seen yesterday at ${time}`;
  return `last seen on ${d.toLocaleDateString()} at ${time}`;
}

export const ProfileCard: React.FC<ProfileCardProps> = ({
  user,
  onMessage,
  onCall,
  onClose,
  onBlock,
  onShareContact,
  sharedMediaCount,
  onOpenSharedMedia,
  lang = 'en'
}) => {
  const [photoFullscreen, setPhotoFullscreen] = useState(false);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [viewHighlight, setViewHighlight] = useState<Highlight | null>(null);

  const showPhoto = audienceAllows(user, 'photo') && !!user.avatar;
  const showAbout = audienceAllows(user, 'about') && !!user.about?.trim();
  const showLastSeen = audienceAllows(user, 'lastSeen');
  // Highlights follow the profile's own audience logic: they are shown
  // only when the profile is not effectively private for this viewer —
  // i.e. neither the photo nor the About audience blocks them ('nobody',
  // or 'contacts' when the viewer is not a contact).
  const showHighlights = audienceAllows(user, 'photo') && audienceAllows(user, 'about');

  // Fetch this user's highlights when the card opens (best-effort: an
  // unreachable server or an older one without the endpoint just leaves
  // the section hidden). authHeaders() with no argument uses the viewer's
  // own session (Firebase token, or the stored demo user) — never the
  // viewed user's id.
  useEffect(() => {
    setHighlights([]);
    setViewHighlight(null);
    if (!showHighlights) return;
    let cancelled = false;
    (async () => {
      try {
        const headers = await authHeaders();
        const res = await fetch(`/api/highlights?userId=${encodeURIComponent(user.id)}`, {
          headers
        });
        if (!res.ok) return;
        const data = await res.json();
        const list: unknown = (data as any)?.highlights ?? data;
        if (cancelled || !Array.isArray(list)) return;
        const mapped = list
          .map((r) => mapHighlight(r, user))
          .filter(Boolean) as Highlight[];
        if (!cancelled) {
          setHighlights(
            mapped.filter((h) => h.userId === user.id || h.story.userId === user.id)
          );
        }
      } catch {
        /* highlights are best-effort — the card works without them */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id, showHighlights]);
  const isOnline = !!user.online || user.presence === 'online';

  let presenceLine: string | null = null;
  if (showLastSeen) {
    if (isOnline) {
      presenceLine = lang === 'bn' ? 'এখন সক্রিয়' : 'Active now';
    } else if (typeof user.lastSeenAt === 'number' && user.lastSeenAt > 0) {
      presenceLine = formatLastSeen(user.lastSeenAt, lang);
    } else if (user.lastSeen && user.lastSeen !== 'Active now') {
      presenceLine = user.lastSeen;
    }
  }

  const viewStory = viewHighlight?.story ?? null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60  flex items-center justify-center p-4 animate-in fade-in select-none"
      onClick={onClose}
    >
      <div
        className="glass-sheet rounded-[var(--r-sheet)] w-full max-w-sm overflow-hidden shadow-soft text-app max-h-[90vh] overflow-y-auto transition-[opacity,transform] [transition-duration:var(--dur-sheet)] [transition-timing-function:var(--ease-spring)]"
        onClick={(e) => e.stopPropagation()}
       role="dialog" aria-modal="true" aria-label={user.name} >
        {/* Header photo area */}
        <div className="relative bg-surface  px-6 pt-8 pb-5 flex flex-col items-center text-center">
          <button
            onClick={onClose}
            className="absolute top-1.5 right-1.5 min-w-[44px] min-h-[44px] flex items-center justify-center text-app-faint hover:text-app rounded-lg transition-colors"
            aria-label={lang === 'bn' ? 'বন্ধ করুন' : 'Close'}
          >
            <X className="w-5 h-5" />
          </button>

          {showPhoto ? (
            <img
              src={user.avatar}
              alt={user.name}
              onClick={() => setPhotoFullscreen(true)}
              className="w-28 h-28 rounded-full object-cover ring-4 ring-(--c-primary) cursor-pointer transition-shadow [transition-duration:var(--dur-press)]"
              title={lang === 'bn' ? 'বড় করে দেখুন' : 'View photo'}
            />
          ) : (
            <span className="w-28 h-28 rounded-full bg-brand-gradient text-white flex items-center justify-center text-4xl font-bold ring-4 ring-(--c-primary)">
              {initialsOf(user.name)}
            </span>
          )}

          <h3 className="text-xl font-bold text-app mt-4 truncate max-w-full bn-safe">{user.name}</h3>
          {user.username && <p className="text-sm text-app-2 mt-0.5">@{user.username}</p>}
          {user.status && <p className="text-xs text-app-2 mt-1 truncate max-w-full bn-safe">{user.status}</p>}
          {presenceLine && (
            <p className="text-xs mt-1.5 flex items-center gap-1.5 text-app-2">
              {isOnline && <span className="w-2 h-2 rounded-full bg-online inline-block" />}
              <span>{presenceLine}</span>
            </p>
          )}
        </div>

        {/* About */}
        {showAbout && (
          <div className="px-6 py-4 border-t border-token ">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-app-faint mb-1">
              {lang === 'bn' ? 'সম্পর্কে' : 'About'}
            </p>
            <p className="text-sm text-app whitespace-pre-wrap break-words leading-relaxed bn-safe">
              {linkifyAbout(user.about!.trim())}
            </p>
          </div>
        )}

        {/* Highlights (story snapshots that survive expiry) */}
        {showHighlights && highlights.length > 0 && (
          <div className="px-5 py-2 border-t border-token ">
            <HighlightsRow highlights={highlights} lang={lang} onOpen={setViewHighlight} />
          </div>
        )}

        {/* Shared media shortcut */}
        {typeof sharedMediaCount === 'number' && onOpenSharedMedia && (
          <button
            onClick={() => onOpenSharedMedia(user)}
            className="w-full px-6 py-3.5 border-t border-token  flex items-center justify-between hover:bg-surface  transition-colors"
          >
            <span className="flex items-center gap-2.5 text-sm font-medium text-app">
              <ImageIcon className="w-4 h-4 text-primary" />
              {lang === 'bn' ? 'শেয়ার করা মিডিয়া' : 'Shared media'}
            </span>
            <span className="text-xs font-bold text-primary bg-bubble-in px-2.5 py-1 rounded-full">
              {sharedMediaCount}
            </span>
          </button>
        )}

        {/* Actions */}
        <div className="px-6 py-4 border-t border-token  flex items-center gap-2">
          <button
            onClick={() => onMessage(user)}
            className="flex-1 py-2.5 bg-primary hover:brightness-110 text-white rounded-full text-xs font-bold shadow-md  flex items-center justify-center gap-1.5 transition-colors"
          >
            <MessageCircle className="w-4 h-4" />
            <span>{lang === 'bn' ? 'মেসেজ' : 'Message'}</span>
          </button>
          <button
            onClick={() => onCall(user)}
            className="flex-1 py-2.5 bg-surface hover:bg-pressed text-app rounded-full text-xs font-bold flex items-center justify-center gap-1.5 transition-colors"
          >
            <Phone className="w-4 h-4" />
            <span>{lang === 'bn' ? 'কল' : 'Call'}</span>
          </button>
        </div>

        {onShareContact && (
          <div className="px-6 pb-4">
            <button
              onClick={() => onShareContact(user)}
              className="w-full py-2.5 bg-surface hover:bg-pressed text-app rounded-full text-xs font-bold flex items-center justify-center gap-1.5 transition-colors"
            >
              <Share2 className="w-4 h-4" />
              <span>{lang === 'bn' ? 'কন্টাক্ট শেয়ার করুন' : 'Share contact'}</span>
            </button>
          </div>
        )}

        {onBlock && (
          <div className="px-6 pb-5">
            <button
              onClick={() => onBlock(user)}
              className="w-full py-2 text-xs font-semibold text-danger  hover:bg-surface  rounded-full flex items-center justify-center gap-1.5 transition-colors"
            >
              <ShieldBan className="w-4 h-4" />
              <span>
                {lang === 'bn' ? `${user.name}-কে ব্লক করুন` : `Block ${user.name}`}
              </span>
            </button>
          </div>
        )}
      </div>

      {/* Full-screen photo overlay */}
      {photoFullscreen && showPhoto && (
        <div
          className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center p-4 animate-in fade-in"
          onClick={(e) => {
            e.stopPropagation();
            setPhotoFullscreen(false);
          }}
         role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'প্রোফাইল ছবি' : 'Profile photo'} >
          <img src={user.avatar} alt={user.name} className="max-w-full max-h-full object-contain rounded-xl" />
          <button
            className="absolute top-2 right-2 min-w-[44px] min-h-[44px] flex items-center justify-center text-white/80 hover:text-white rounded-lg"
            aria-label={lang === 'bn' ? 'বন্ধ করুন' : 'Close'}
          >
            <X className="w-6 h-6" />
          </button>
        </div>
      )}

      {/* Simple highlight viewer (single snapshot; no auto-advance) */}
      {viewHighlight && viewStory && (
        <div
          className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center p-4 animate-in fade-in"
          onClick={(e) => {
            e.stopPropagation();
            setViewHighlight(null);
          }}
         role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'স্টোরি হাইলাইট' : 'Story highlight'} >
          {viewStory.kind === 'text' ? (
            <div
              className="w-full max-w-sm h-[70vh] rounded-2xl flex items-center justify-center px-8 overflow-hidden"
              style={{ background: textBgCss(viewStory.textData?.bg) }}
            >
              <p
                className={`text-center text-2xl leading-snug break-words ${
                  isLightBg(viewStory.textData?.bg) ? 'text-app' : 'text-white'
                }`}
                style={textFontStyle(viewStory.textData?.font)}
              >
                {viewStory.textData?.text}
              </p>
            </div>
          ) : viewStory.kind === 'video' ? (
            <video
              src={viewStory.imageUrl}
              autoPlay
              controls
              playsInline
              className="max-w-full max-h-[85vh] rounded-xl bg-black"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <img
              src={viewStory.imageUrl}
              alt={viewStory.caption || user.name}
              className="max-w-full max-h-[85vh] object-contain rounded-xl"
            />
          )}
          {viewStory.caption && viewStory.kind !== 'text' && (
            <p className="absolute bottom-6 left-1/2 -translate-x-1/2 max-w-[90%] text-center text-sm text-white bg-black/50 rounded-full px-4 py-1.5 truncate">
              {viewStory.caption}
            </p>
          )}
          <button
            className="absolute top-2 right-2 min-w-[44px] min-h-[44px] flex items-center justify-center text-white/80 hover:text-white rounded-lg"
            aria-label={lang === 'bn' ? 'বন্ধ করুন' : 'Close'}
          >
            <X className="w-6 h-6" />
          </button>
        </div>
      )}
    </div>
  );
};
