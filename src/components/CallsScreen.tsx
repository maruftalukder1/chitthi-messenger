import React, { useEffect, useMemo, useState } from 'react';
import { CallLog, User } from '../types/chat';
import { fetchCallLogs, type ServerCallLog } from '../services/callLogService';
import {
  Phone,
  Video,
  Search,
  ArrowUpRight,
  ArrowDownLeft,
  PhoneOff,
  X,
  Trash2
} from 'lucide-react';

interface CallsScreenProps {
  callLogs: CallLog[];
  onStartCall: (callType: 'audio' | 'video', target: { id: string; name: string }) => void;
  users: User[];
  currentUser: User;
  onDeleteCallLog: (id: string) => void;
  onClearCallLogs: () => void;
  lang: 'bn' | 'en';
}

// Phase 2: skeleton rows shown while server call logs load/merge on mount.
// Solid token surfaces only — no glass list items (performance law).
export const CallsSkeleton: React.FC = () => (
  <div
    className="flex-1 overflow-hidden px-4 py-2 space-y-1.5"
    role="status"
    aria-label="Loading call history"
  >
    {Array.from({ length: 6 }).map((_, i) => (
      <div key={i} className="p-3 bg-surface rounded-2xl flex items-center gap-3">
        <div className="skeleton w-12 h-12 rounded-full shrink-0" />
        <div className="flex-1 min-w-0 space-y-2">
          <div className="skeleton h-3.5 w-2/5 rounded-full" />
          <div className="skeleton h-3 w-3/5 rounded-full" />
        </div>
        <div className="skeleton w-11 h-11 rounded-full shrink-0" />
      </div>
    ))}
  </div>
);

export const CallsScreen: React.FC<CallsScreenProps> = ({
  callLogs,
  onStartCall,
  users,
  currentUser,
  onDeleteCallLog,
  onClearCallLogs,
  lang,
}) => {
  const [activeTab, setActiveTab] = useState<'recent' | 'contacts'>('recent');
  const [selectedCall, setSelectedCall] = useState<CallLog | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [logFilter, setLogFilter] = useState<'all' | 'missed'>('all');
  const [contactQuery, setContactQuery] = useState('');

  // ── Server call history (Phase 1.3) ──────────────────────────────────────
  // Local logs (the `callLogs` prop, persisted by App) are merged with the
  // server's copy (fetchCallLogs — the server also mirrors each entry to
  // the peer, so a call the OTHER side logged still shows up here).
  // Dedupe key: `peerId + startedAt`. Local CallLog rows carry no epoch
  // field, so their startedAt is reconstructed from the stored date+time
  // strings; both sides are bucketed to the minute, which absorbs the
  // local strings' minute precision. Local rows whose date cannot be
  // parsed are always kept (keyed by their own id instead).
  const [serverLogs, setServerLogs] = useState<ServerCallLog[]>([]);
  // Rows the user deleted from THIS screen. Local rows are also removed via
  // onDeleteCallLog (App owns that list); server rows exist only here, so
  // without this set their delete button would silently do nothing. (The
  // contract has no DELETE /api/call-logs, so a hidden server row returns
  // on the next mount — coordinator note in PHASE1 handoff.)
  const [hiddenLogIds, setHiddenLogIds] = useState<string[]>([]);
  // Phase 2: true from mount until the first server-log fetch resolves and
  // merges — drives CallsSkeleton. No artificial delay: fetchCallLogs is
  // best-effort and always resolves ([] on failure), so this always clears.
  const [logsLoading, setLogsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await fetchCallLogs(currentUser.id);
      if (!cancelled) {
        setServerLogs(entries);
        setLogsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentUser.id]);

  const dedupeKey = (peerId: string, startedAt: number): string =>
    `${peerId}|${Math.floor(startedAt / 60000)}`;

  const localStartedAt = (log: CallLog): number | null => {
    const parsed = Date.parse(`${log.date} ${log.time}`.trim());
    return Number.isFinite(parsed) ? parsed : null;
  };

  const serverToCallLog = (entry: ServerCallLog): CallLog => {
    const started = new Date(entry.startedAt);
    return {
      id: entry.id,
      // Peer identity travels by ID only; name is the server's hint and the
      // avatar stays empty — resolvePeer below swaps in the live user (and
      // its avatar) when the ID is known, initials otherwise. No photos
      // are ever fabricated for an unknown peer (Phase 0 behaviour).
      user: {
        id: entry.peerId,
        name: entry.peerName || 'Unknown',
        avatar: '',
        status: '',
        online: false,
      } as User,
      type: entry.type,
      callType: entry.callType,
      date: started.toLocaleDateString(),
      time: started.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      duration:
        entry.durationSec > 0
          ? `${Math.floor(entry.durationSec / 60)}:${String(entry.durationSec % 60).padStart(2, '0')}`
          : undefined,
    };
  };

  const mergedLogs = useMemo<CallLog[]>(() => {
    const seen = new Set<string>();
    const rows: { log: CallLog; startedAt: number | null }[] = [];
    for (const entry of serverLogs) {
      seen.add(dedupeKey(entry.peerId, entry.startedAt));
      rows.push({ log: serverToCallLog(entry), startedAt: entry.startedAt });
    }
    for (const log of callLogs) {
      const startedAt = localStartedAt(log);
      const key = startedAt !== null ? dedupeKey(log.user.id, startedAt) : `local|${log.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ log, startedAt });
    }
    // Newest first; rows without a parseable timestamp keep their relative
    // order at the end (Array.prototype.sort is stable).
    rows.sort((a, b) => (b.startedAt ?? Number.MIN_SAFE_INTEGER) - (a.startedAt ?? Number.MIN_SAFE_INTEGER));
    return rows.map((r) => r.log).filter((log) => !hiddenLogIds.includes(log.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverLogs, callLogs, hiddenLogIds]);

  // Call-log truthfulness (0.4): resolve the peer by user ID against the
  // live users list. On a mismatch/missing user, fall back to the name
  // stored on the log itself with an initials avatar — NEVER fabricate a
  // replacement user with a stranger's photo. Direction (incoming /
  // outgoing / missed / declined) is read from the stored log.type field
  // as-is; nothing here defaults or re-derives it.
  const resolvePeer = (log: CallLog): { id: string; name: string; avatar: string | null } => {
    const byId = users.find((u) => u.id === log.user.id);
    if (byId) return { id: byId.id, name: byId.name, avatar: byId.avatar };
    return { id: log.user.id, name: log.user.name, avatar: null };
  };

  const getInitials = (name: string): string =>
    name
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w.charAt(0).toUpperCase())
      .join('') || '?';

  const resolvedLogs = mergedLogs.map((log) => ({ log, peer: resolvePeer(log) }));

  const filteredLogs = resolvedLogs.filter(({ log, peer }) => {
    const matchesSearch = peer.name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesFilter = logFilter === 'all' || log.type === 'missed';
    return matchesSearch && matchesFilter;
  });

  const selectedPeer = selectedCall ? resolvePeer(selectedCall) : null;

  const filteredContacts = users
    .filter((u) => u.id !== currentUser.id)
    .filter((u) => {
      const q = contactQuery.toLowerCase();
      return u.name.toLowerCase().includes(q) || (u.username || '').toLowerCase().includes(q);
    });

  return (
    <div className="flex-1 flex flex-col h-full bg-app overflow-hidden relative select-none">
      {/* Top Header */}
      <div className="pt-4 pb-3 px-5 flex items-center justify-between border-b border-token bg-header">
        <div>
          <h1 className="text-[28px] font-bold tracking-tight text-app flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-online" />
            <span>{lang === 'bn' ? 'কল ও কন্টাক্ট' : 'Calls & Contacts'}</span>
          </h1>
        </div>

        {/* Tab switch between Recent and Contacts */}
        <div className="flex items-center gap-1 bg-surface p-1 rounded-full">
          <button
            onClick={() => setActiveTab('recent')}
            className={`px-3.5 py-1.5 rounded-full text-xs font-bold transition-colors duration-[var(--dur-press)] ease-[var(--ease-spring)] ${
              activeTab === 'recent'
                ? 'bg-badge shadow-soft'
                : 'text-app-2 hover:text-app'
            }`}
           aria-pressed={activeTab === 'recent'} >
            {lang === 'bn' ? 'সাম্প্রতিক' : 'Recent'}
          </button>
          <button
            onClick={() => setActiveTab('contacts')}
            className={`px-3.5 py-1.5 rounded-full text-xs font-bold transition-colors duration-[var(--dur-press)] ease-[var(--ease-spring)] ${
              activeTab === 'contacts'
                ? 'bg-badge shadow-soft'
                : 'text-app-2 hover:text-app'
            }`}
           aria-pressed={activeTab === 'contacts'} >
            {lang === 'bn' ? 'কন্টাক্ট' : 'Contacts'}
          </button>
        </div>
      </div>

      {/* VIEW 1: Recent Calls */}
      {activeTab === 'recent' && (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Search Box */}
          <div className="px-5 pt-3 pb-2 space-y-2">
            <div className="relative">
              <Search className="w-4 h-4 text-app-faint absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={lang === 'bn' ? 'কল হিস্ট্রি খুঁজুন...' : 'Search recent calls...'} aria-label={lang === 'bn' ? 'কল হিস্ট্রি খুঁজুন...' : 'Search recent calls...'}
                className="w-full bg-surface rounded-full pl-10 pr-4 py-2.5 text-base text-app placeholder:text-app-faint"
              />
            </div>

            {/* Filter chips + clear all */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setLogFilter('all')}
                className={`px-3.5 py-1.5 rounded-full text-[11px] font-bold transition-colors duration-[var(--dur-press)] ease-[var(--ease-spring)] ${
                  logFilter === 'all'
                    ? 'bg-badge shadow-soft'
                    : 'bg-surface text-app-2 hover:text-app'
                }`}
               aria-pressed={logFilter === 'all'} >
                {lang === 'bn' ? 'সব' : 'All'}
              </button>
              <button
                onClick={() => setLogFilter('missed')}
                className={`px-3.5 py-1.5 rounded-full text-[11px] font-bold transition-colors duration-[var(--dur-press)] ease-[var(--ease-spring)] ${
                  logFilter === 'missed'
                    ? 'bg-badge shadow-soft'
                    : 'bg-surface text-app-2 hover:text-app'
                }`}
               aria-pressed={logFilter === 'missed'} >
                {lang === 'bn' ? 'মিসড' : 'Missed'}
              </button>
              {mergedLogs.length > 0 && (
                <button
                  onClick={() => {
                    // Hide the server rows too — App's clear only empties
                    // its local list (same contract gap as single delete).
                    setHiddenLogIds((prev) => Array.from(new Set([...prev, ...serverLogs.map((e) => e.id)])));
                    onClearCallLogs();
                  }}
                  className="ml-auto text-[11px] font-bold text-danger hover:opacity-80 transition-opacity"
                >
                  {lang === 'bn' ? 'সব মুছুন' : 'Clear all'}
                </button>
              )}
            </div>
          </div>

          {logsLoading ? (
            <CallsSkeleton />
          ) : (
          <div className="flex-1 overflow-y-auto px-4 py-2 space-y-1.5 pb-24">
            {mergedLogs.length === 0 && (
              <div className="flex flex-col items-center text-center px-6 py-12">
                <div className="w-16 h-16 rounded-full bg-bubble-in text-app-faint flex items-center justify-center mb-4">
                  <PhoneOff className="w-7 h-7" />
                </div>
                <h3 className="text-base font-bold text-app">
                  {lang === 'bn' ? 'এখনো কোনো কল হয়নি' : 'No calls yet'}
                </h3>
                <p className="text-sm text-app-2 mt-1 max-w-xs">
                  {lang === 'bn'
                    ? 'আপনার কল হিস্ট্রি এখানে আসবে — কন্টাক্ট ট্যাব থেকে কল শুরু করুন'
                    : 'Your call history will appear here — start a call from the Contacts tab'}
                </p>
              </div>
            )}
            {mergedLogs.length > 0 && filteredLogs.length === 0 && (
              <p className="text-center text-xs text-app-faint py-8">
                {lang === 'bn' ? 'কোনো কল পাওয়া যায়নি' : 'No calls match your search'}
              </p>
            )}
            {filteredLogs.map(({ log, peer }) => {
              return (
                <div
                  key={log.id}
                  onClick={() => setSelectedCall(log)}
                  className="p-3 bg-surface rounded-2xl flex items-center justify-between hover:bg-pressed transition-colors duration-[var(--dur-press)] ease-[var(--ease-spring)] cursor-pointer group"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {peer.avatar ? (
                      <img
                        src={peer.avatar}
                        alt={peer.name}
                        className="w-12 h-12 rounded-full bg-pressed object-cover shrink-0 ring-2 ring-transparent transition-colors duration-[var(--dur-press)] ease-[var(--ease-spring)]"
                      />
                    ) : (
                      <div className="w-12 h-12 rounded-full bg-pressed text-app-2 flex items-center justify-center text-sm font-bold shrink-0 ring-2 ring-transparent transition-colors duration-[var(--dur-press)] ease-[var(--ease-spring)]">
                        {getInitials(peer.name)}
                      </div>
                    )}

                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-app truncate">
                        {peer.name}
                      </h3>
                      <div className="flex items-center flex-wrap gap-x-1.5 gap-y-0.5 text-xs mt-0.5">
                        {log.type === 'outgoing' && (
                          <span className="flex items-center gap-1 text-online font-semibold">
                            <ArrowUpRight className="w-3.5 h-3.5" />
                            <span>{lang === 'bn' ? 'আউটগোয়িং' : 'Outgoing'}</span>
                          </span>
                        )}
                        {log.type === 'incoming' && (
                          <span className="flex items-center gap-1 text-online font-semibold">
                            <ArrowDownLeft className="w-3.5 h-3.5" />
                            <span>{lang === 'bn' ? 'ইনকামিং' : 'Incoming'}</span>
                          </span>
                        )}
                        {log.type === 'missed' && (
                          <span className="flex items-center gap-1 text-danger font-semibold">
                            <ArrowDownLeft className="w-3.5 h-3.5" />
                            <span>{lang === 'bn' ? 'মিসড' : 'Missed'}</span>
                          </span>
                        )}
                        {log.type === 'declined' && (
                          <span className="flex items-center gap-1 text-danger font-semibold">
                            <PhoneOff className="w-3.5 h-3.5" />
                            <span>{lang === 'bn' ? 'প্রত্যাখ্যাত' : 'Declined'}</span>
                          </span>
                        )}
                        <span className="text-app-faint">·</span>
                        <span className="text-xs text-app-faint">{log.date}, {log.time}</span>
                        {log.duration && (
                          <>
                            <span className="text-app-faint">·</span>
                            <span className="text-app-2">{log.duration}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Quick Action Buttons — peer resolved by ID above: peer.id → App sets peerId, type is explicit per button */}
                  <div className="flex items-center gap-1 shrink-0 ml-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onStartCall('audio', { id: peer.id, name: peer.name });
                      }}
                      className="w-11 h-11 flex items-center justify-center text-app-2 hover:text-online rounded-full bg-app shadow-soft transition-colors"
                      title="Audio Call"
                     aria-label={`Voice call ${peer.name}`} >
                      <Phone className="w-4 h-4" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onStartCall('video', { id: peer.id, name: peer.name });
                      }}
                      className="w-11 h-11 flex items-center justify-center text-app-2 hover:text-primary rounded-full bg-app shadow-soft transition-colors"
                      title="Video Call"
                     aria-label={`Video call ${peer.name}`} >
                      <Video className="w-4 h-4" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setHiddenLogIds((prev) => (prev.includes(log.id) ? prev : [...prev, log.id]));
                        onDeleteCallLog(log.id);
                      }}
                      className="w-11 h-11 flex items-center justify-center text-app-faint hover:text-danger rounded-full hover:bg-app transition-colors"
                      title={lang === 'bn' ? 'মুছুন' : 'Delete'}
                     aria-label={lang === 'bn' ? 'কল লগ মুছুন' : 'Delete call log entry'} >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          )}
        </div>
      )}

      {/* VIEW 2: Contact Search Dialing */}
      {activeTab === 'contacts' && (
        <div className="flex-1 flex flex-col overflow-hidden animate-in fade-in">
          <div className="px-5 pt-3 pb-2">
            <div className="relative">
              <Search className="w-4 h-4 text-app-faint absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={contactQuery}
                onChange={(e) => setContactQuery(e.target.value)}
                placeholder={lang === 'bn' ? 'কন্টাক্ট খুঁজুন...' : 'Search contacts...'} aria-label={lang === 'bn' ? 'কন্টাক্ট খুঁজুন...' : 'Search contacts...'}
                className="w-full bg-surface rounded-full pl-10 pr-4 py-2.5 text-base text-app placeholder:text-app-faint"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-2 space-y-1.5 pb-24">
            {filteredContacts.length === 0 && (
              <p className="text-center text-xs text-app-faint py-8">
                {lang === 'bn' ? 'কোনো কন্টাক্ট পাওয়া যায়নি' : 'No contacts found'}
              </p>
            )}
            {filteredContacts.map((u) => (
              <div
                key={u.id}
                className="p-3 bg-surface rounded-2xl flex items-center justify-between hover:bg-pressed transition-colors duration-[var(--dur-press)] ease-[var(--ease-spring)] group"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="relative shrink-0">
                    <img
                      src={u.avatar}
                      alt={u.name}
                      className="w-12 h-12 rounded-full bg-pressed object-cover"
                    />
                    <span
                      className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-white ${
                        u.online ? 'bg-online' : 'bg-pressed'
                      }`}
                    />
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-app truncate">{u.name}</h3>
                    <p className="text-xs text-app-2 truncate">
                      {u.username ? `@${u.username}` : u.online ? (lang === 'bn' ? 'অনলাইন' : 'Online') : (lang === 'bn' ? 'অফলাইন' : 'Offline')}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0 ml-2">
                  <button
                    onClick={() => onStartCall('audio', { id: u.id, name: u.name })}
                    className="w-11 h-11 flex items-center justify-center text-app-2 hover:text-online rounded-full bg-app shadow-soft transition-colors"
                    title="Audio Call"
                   aria-label={`Voice call ${u.name}`} >
                    <Phone className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => onStartCall('video', { id: u.id, name: u.name })}
                    className="w-11 h-11 flex items-center justify-center text-app-2 hover:text-primary rounded-full bg-app shadow-soft transition-colors"
                    title="Video Call"
                   aria-label={`Video call ${u.name}`} >
                    <Video className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Call History Details Modal */}
      {selectedCall && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 animate-in fade-in">
          <div className="bg-app rounded-[var(--r-sheet)] w-full max-w-sm p-6 space-y-4 shadow-soft animate-in zoom-in-95 duration-[var(--dur-sheet)] ease-[var(--ease-spring)]" role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'কলের বিবরণ' : 'Call details'} >
            <div className="flex items-center justify-between pb-2 border-b border-token">
              <div className="flex items-center gap-3">
                {selectedPeer?.avatar ? (
                  <img
                    src={selectedPeer.avatar}
                    alt={selectedPeer.name}
                    className="w-10 h-10 rounded-full object-cover"
                  />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-pressed text-app-2 flex items-center justify-center text-xs font-bold">
                    {getInitials(selectedPeer?.name ?? selectedCall.user.name)}
                  </div>
                )}
                <div>
                  <p className="text-[11px] text-app-faint">Call Details</p>
                  <p className="text-sm font-bold text-app">
                    {selectedPeer?.name ?? selectedCall.user.name}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setSelectedCall(null)}
                className="w-11 h-11 shrink-0 flex items-center justify-center text-app-faint hover:text-app rounded-full bg-surface"
               aria-label={lang === 'bn' ? 'বন্ধ করুন' : 'Close'} >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-2 py-1 text-xs">
              <div className="flex items-center justify-between p-2 rounded-xl bg-surface">
                <span className="text-app-2">Duration:</span>
                <span className="font-bold text-app">{selectedCall.duration ?? '—'}</span>
              </div>
              {selectedCall.dataUsed && (
                <div className="flex items-center justify-between p-2 rounded-xl bg-surface">
                  <span className="text-app-2">Data Used:</span>
                  <span className="font-bold text-app">{selectedCall.dataUsed}</span>
                </div>
              )}
              <div className="flex items-center justify-between p-2 rounded-xl bg-surface">
                <span className="text-app-2">Type:</span>
                {/* Direction comes from the stored log.type field, call kind from stored log.callType */}
                <span className="font-bold text-primary capitalize">
                  {selectedCall.type} · {selectedCall.callType} Call
                </span>
              </div>
            </div>

            <div className="pt-2">
              <button
                onClick={() => {
                  if (selectedPeer) {
                    onStartCall(selectedCall.callType, { id: selectedPeer.id, name: selectedPeer.name });
                  }
                  setSelectedCall(null);
                }}
                className="w-full py-2.5 bg-[#0B6E4F] hover:bg-[#095C42] text-white rounded-full font-bold text-xs shadow-soft transition-transform duration-[var(--dur-press)] ease-[var(--ease-spring)] active:scale-[0.99]"
              >
                {lang === 'bn' ? 'আবার কল করুন' : 'Call Again'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
