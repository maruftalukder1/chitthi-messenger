import React, { useEffect, useMemo, useState } from 'react';
import { X, Search, Loader2, AlertCircle } from 'lucide-react';
import { searchUsers, type DirectoryUser as ServerDirectoryUser } from '../services/firebase';

// People Directory (MEGA ROUND — Workstream 9): "New message" picker.
// Empty query shows the caller's own contacts (passed in by App — this
// component invents NO people). A non-empty query additionally searches
// the server directory via searchUsers() (GET /api/users/search) and
// merges the two sources, de-duplicated by id, self always excluded.

export interface DirectoryUser {
  id: string;
  name: string;
  username?: string;
  avatar?: string;
}

export interface PeopleDirectoryProps {
  open: boolean;
  onClose: () => void;
  lang?: 'bn' | 'en';
  currentUserId: string;
  contacts: DirectoryUser[];
  onSelect: (u: DirectoryUser) => void;
}

function initialsOf(name: string): string {
  return (
    (name || '')
      .trim()
      .split(/\s+/)
      .map((part) => part[0])
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?'
  );
}

function toLocalUser(u: ServerDirectoryUser): DirectoryUser {
  return { id: u.id, name: u.name, username: u.username, avatar: u.avatar };
}

export const PeopleDirectory: React.FC<PeopleDirectoryProps> = ({
  open,
  onClose,
  lang = 'en',
  currentUserId,
  contacts,
  onSelect,
}) => {
  const bn = lang === 'bn';
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DirectoryUser[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [brokenAvatars, setBrokenAvatars] = useState<ReadonlySet<string>>(new Set());

  // Contacts: de-duplicated by id, self excluded, order preserved.
  const dedupedContacts = useMemo<DirectoryUser[]>(() => {
    const seen = new Set<string>();
    const out: DirectoryUser[] = [];
    for (const c of contacts || []) {
      if (!c || !c.id || c.id === currentUserId || seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
    return out;
  }, [contacts, currentUserId]);

  // Reset whenever the sheet closes, so a reopen starts clean.
  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setIsSearching(false);
      setHasSearched(false);
      setSearchError(false);
    }
  }, [open ]);

  // Escape closes (backdrop click + X button are handled in the JSX).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Debounced directory search (~300ms). Empty query never hits the
  // network — the contacts list below is what gets shown instead.
  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setIsSearching(false);
      setHasSearched(false);
      setSearchError(false);
      return;
    }
    setIsSearching(true);
    setSearchError(false);
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        // Local contact matches (name / @username contains, case-insensitive).
        const needle = trimmed.replace(/^@/, '').toLowerCase();
        const byId = new Map<string, DirectoryUser>();
        for (const c of dedupedContacts) {
          const name = (c.name || '').toLowerCase();
          const username = (c.username || '').toLowerCase();
          if (name.includes(needle) || username.includes(needle)) byId.set(c.id, c);
        }
        try {
          // Offline is a real error state, not an empty result.
          if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            throw new Error('offline');
          }
          // NOTE: searchUsers() resolves [] on ANY server/transport error
          // (its documented contract), so a rejected/unreachable directory
          // that still resolves cannot be told apart from "no matches"
          // here; the try/catch + offline check cover every failure mode
          // the helper actually surfaces. Never fabricate people either way.
          const found = await searchUsers(trimmed);
          for (const d of found) {
            if (!d || !d.id || d.id === currentUserId) continue;
            const local = toLocalUser(d);
            const existing = byId.get(d.id);
            if (existing) {
              // Already a contact — don't duplicate; only fill gaps in
              // the contact's own fields from the directory entry.
              byId.set(d.id, {
                ...existing,
                username: existing.username || local.username,
                avatar: existing.avatar || local.avatar,
              });
            } else {
              byId.set(d.id, local);
            }
          }
          if (!cancelled) {
            setResults(Array.from(byId.values()));
            setHasSearched(true);
            setSearchError(false);
            setIsSearching(false);
          }
        } catch {
          if (!cancelled) {
            setResults(Array.from(byId.values()));
            setHasSearched(true);
            setSearchError(true);
            setIsSearching(false);
          }
        }
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, open, dedupedContacts, currentUserId]);

  if (!open) return null;

  const trimmedQuery = query.trim();
  const isQueryMode = trimmedQuery.length > 0;
  const visibleUsers = isQueryMode ? results : dedupedContacts;

  const handleSelect = (u: DirectoryUser) => {
    onSelect(u);
    onClose();
  };

  const renderAvatar = (u: DirectoryUser) => {
    const avatarUrl = (u.avatar || '').trim();
    if (avatarUrl && !brokenAvatars.has(u.id)) {
      return (
        <img
          src={avatarUrl}
          alt={u.name}
          className="w-12 h-12 rounded-full object-cover bg-[#F7F6F1] dark:bg-white/10 shrink-0"
          onError={() =>
            setBrokenAvatars((prev) => {
              const next = new Set(prev);
              next.add(u.id);
              return next;
            })
          }
        />
      );
    }
    return (
      <span
        aria-hidden="true"
        className="w-12 h-12 rounded-full bg-[#E3EDE7] dark:bg-[#1E3A2F] text-[#0B6E4F] dark:text-[#2FA37C] flex items-center justify-center text-base font-bold shrink-0"
      >
        {initialsOf(u.name)}
      </span>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center sm:p-4 animate-in fade-in select-none"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-[#FFFFFF] dark:bg-[#131A17] rounded-t-[28px] sm:rounded-[28px] overflow-hidden shadow-soft text-[#15211B] dark:text-[#EDF3EF] max-h-[88vh] flex flex-col transition-[opacity,transform] [transition-duration:var(--dur-sheet)] [transition-timing-function:var(--ease-spring)]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={bn ? 'নতুন মেসেজ' : 'New message'}
      >
        {/* Header */}
        <div className="flex items-center justify-between pl-5 pr-2 py-2 border-b border-black/5 dark:border-white/10 shrink-0">
          <h3
            className="text-base font-bold text-[#15211B] dark:text-[#EDF3EF] bn-safe"
            style={bn ? { lineHeight: 1.5 } : undefined}
          >
            {bn ? 'নতুন মেসেজ' : 'New message'}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="min-w-[44px] min-h-[44px] flex items-center justify-center text-[#5C6B62] dark:text-[#9DB0A5] hover:text-[#15211B] dark:hover:text-[#EDF3EF] rounded-lg transition-colors"
            aria-label={bn ? 'বন্ধ করুন' : 'Close'}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Search */}
        <div className="px-4 pt-3 pb-2 shrink-0">
          <div className="relative">
            <Search className="w-4 h-4 text-[#5C6B62] dark:text-[#9DB0A5] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={bn ? 'নাম বা @username খুঁজুন' : 'Search name or @username'}
              aria-label={bn ? 'নাম বা @username খুঁজুন' : 'Search name or @username'}
              className="w-full bg-[#F7F6F1] dark:bg-[#1C2621] border-0 rounded-full pl-10 pr-10 py-2.5 text-base text-[#15211B] dark:text-[#EDF3EF] placeholder:text-[#5C6B62] dark:placeholder:text-[#9DB0A5]"
              style={bn ? { lineHeight: 1.5 } : undefined}
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center text-[#5C6B62] dark:text-[#9DB0A5] hover:text-[#15211B] dark:hover:text-[#EDF3EF] rounded-full transition-colors"
                aria-label={bn ? 'খোঁজ মুছুন' : 'Clear search'}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-2 pb-4 min-h-[120px]">
          <p
            className="text-[11px] font-bold uppercase tracking-wide text-[#5C6B62] dark:text-[#9DB0A5] px-3 pt-2 pb-1 bn-safe"
            style={bn ? { lineHeight: 1.5 } : undefined}
          >
            {isQueryMode
              ? bn
                ? 'Chitthi-তে আছেন'
                : 'People on Chitthi'
              : bn
                ? 'আপনার পরিচিতজন'
                : 'Your contacts'}
          </p>

          {isQueryMode && isSearching && (
            <div className="flex items-center gap-2.5 px-3 py-3 text-sm text-[#5C6B62] dark:text-[#9DB0A5]">
              <Loader2 className="w-4 h-4 animate-spin text-[#0B6E4F] dark:text-[#2FA37C] shrink-0" />
              <span className="bn-safe" style={bn ? { lineHeight: 1.5 } : undefined}>
                {bn ? 'খোঁজা হচ্ছে...' : 'Searching...'}
              </span>
            </div>
          )}

          {!isSearching &&
            visibleUsers.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => handleSelect(u)}
                className="w-full flex items-center gap-3 px-3 py-2 min-h-[56px] rounded-2xl hover:bg-[#F7F6F1] dark:hover:bg-white/5 transition-colors text-left"
              >
                {renderAvatar(u)}
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-semibold text-[#15211B] dark:text-[#EDF3EF] truncate bn-safe">
                    {u.name}
                  </span>
                  {u.username && (
                    <span className="block text-sm text-[#5C6B62] dark:text-[#9DB0A5] truncate bn-safe">
                      <span className="text-[#F2A007]">@</span>
                      {u.username}
                    </span>
                  )}
                </span>
              </button>
            ))}

          {isQueryMode && searchError && (
            <div className="mx-1 mt-2 p-3 rounded-xl bg-[#F7F6F1] dark:bg-white/5 text-sm text-[#5C6B62] dark:text-[#9DB0A5] flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 text-[#F2A007]" />
              <span className="bn-safe" style={bn ? { lineHeight: 1.5 } : undefined}>
                {bn ? 'এখন খোঁজা যাচ্ছে না' : 'Could not search right now'}
              </span>
            </div>
          )}

          {isQueryMode && !isSearching && !searchError && hasSearched && results.length === 0 && (
            <p
              className="text-sm text-[#5C6B62] dark:text-[#9DB0A5] px-3 py-3 bn-safe"
              style={bn ? { lineHeight: 1.5 } : undefined}
            >
              {bn
                ? `"${trimmedQuery}" নামে কাউকে পাওয়া যায়নি`
                : `No one found for "${trimmedQuery}"`}
            </p>
          )}

          {!isQueryMode && dedupedContacts.length === 0 && (
            <p
              className="text-sm text-[#5C6B62] dark:text-[#9DB0A5] px-3 py-3 bn-safe"
              style={bn ? { lineHeight: 1.5 } : undefined}
            >
              {bn ? 'এখনো কোনো পরিচিতজন নেই' : 'No contacts yet'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

export default PeopleDirectory;
