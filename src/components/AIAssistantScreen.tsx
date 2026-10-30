import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bookmark,
  Check,
  Copy,
  MoreVertical,
  RotateCcw,
  Send,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { authHeaders } from '../services/firebase';

// ─── Contract (App mounts this component with exactly these props) ──────────
export interface AIAssistantScreenProps {
  open: boolean;
  onClose: () => void;
  lang?: 'bn' | 'en';
  currentUserId: string;
  onSaveReply?: (text: string) => void;
}

interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
  ts: number;
}

const STORAGE_KEY = 'chitthi_ai_chat_v1';

function loadMessages(): AiMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is AiMessage =>
        !!m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        typeof m.ts === 'number'
    );
  } catch {
    return [];
  }
}

// ─── Minimal safe formatter ──────────────────────────────────────────────────
// Plain text only — NO dangerouslySetInnerHTML. Newlines become paragraphs /
// line breaks and **bold** segments become <strong>. Everything else is
// rendered as a React text node, so markup in a reply can never execute.
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter((p) => p.length > 0);
  return parts.map((part, i) => {
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
      return <strong key={`${keyPrefix}-b${i}`}>{part.slice(2, -2)}</strong>;
    }
    return <React.Fragment key={`${keyPrefix}-t${i}`}>{part}</React.Fragment>;
  });
}

function renderContent(content: string): React.ReactNode {
  const lines = content.split('\n');
  return lines.map((line, i) => {
    if (line.trim() === '') {
      return <div key={`l${i}`} className="h-2" aria-hidden="true" />;
    }
    return (
      <p key={`l${i}`} className="whitespace-pre-wrap break-words">
        {renderInline(line, `l${i}`)}
      </p>
    );
  });
}

// ─── Quick-action chips ──────────────────────────────────────────────────────
// Chips PREFILL the composer (English prompt text in both languages — the
// model follows the prompt language) and focus it; they never auto-send.
const CHIPS: { id: string; labelEn: string; labelBn: string; prefill: string }[] = [
  {
    id: 'write',
    labelEn: '✍️ Write for me',
    labelBn: '✍️ লিখে দাও',
    prefill: 'Write a short, friendly message for me about: ',
  },
  {
    id: 'translate',
    labelEn: '🌐 Translate',
    labelBn: '🌐 অনুবাদ',
    prefill: 'Translate the following to Bangla (or to English if it is already Bangla): ',
  },
  {
    id: 'note',
    labelEn: '📝 Make a note',
    labelBn: '📝 নোট বানাও',
    prefill: 'Turn this into a clear note with bullet points: ',
  },
  {
    id: 'ideas',
    labelEn: '💡 Ideas',
    labelBn: '💡 আইডিয়া',
    prefill: 'Give me 5 ideas for: ',
  },
];

type AiError = { kind: 'rate' | 'generic' } | null;

export const AIAssistantScreen: React.FC<AIAssistantScreenProps> = ({
  open,
  onClose,
  lang = 'en',
  currentUserId,
  onSaveReply,
}) => {
  const bn = lang === 'bn';

  const [messages, setMessages] = useState<AiMessage[]>(() => loadMessages());
  const [input, setInput] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [aiNotConfigured, setAiNotConfigured] = useState(false);
  const [error, setError] = useState<AiError>(null);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [activeMenuIdx, setActiveMenuIdx] = useState<number | null>(null);
  const [savedIdx, setSavedIdx] = useState<number | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const feedbackTimerRef = useRef<number | undefined>(undefined);

  // Persist the conversation (clearing it removes the key entirely).
  useEffect(() => {
    try {
      if (messages.length === 0) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    } catch {
      /* storage unavailable — chat still works for this session */
    }
  }, [messages]);

  const scrollToBottom = (smooth: boolean) => {
    const el = endRef.current;
    if (el) el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'end' });
  };

  // On open: reset transient server/menu state and jump to the latest message.
  useEffect(() => {
    if (!open) return;
    setAiNotConfigured(false);
    setError(null);
    setHeaderMenuOpen(false);
    setActiveMenuIdx(null);
    const t = window.setTimeout(() => scrollToBottom(false), 50);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open ]);

  // After each new message / thinking / error change → scroll to bottom.
  useEffect(() => {
    if (!open) return;
    scrollToBottom(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, isThinking, error, aiNotConfigured, open]);

  // Composer auto-grow to ~4 lines (mirrors ChatViewScreen's pattern).
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 104)}px`;
  }, [input, open]);

  useEffect(
    () => () => {
      if (feedbackTimerRef.current) window.clearTimeout(feedbackTimerRef.current);
    },
    []
  );

  const flashFeedback = (kind: 'saved' | 'copied', idx: number) => {
    if (feedbackTimerRef.current) window.clearTimeout(feedbackTimerRef.current);
    if (kind === 'saved') {
      setSavedIdx(idx);
      setCopiedIdx(null);
    } else {
      setCopiedIdx(idx);
      setSavedIdx(null);
    }
    feedbackTimerRef.current = window.setTimeout(() => {
      setSavedIdx(null);
      setCopiedIdx(null);
    }, 1800);
  };

  // ── Backend call: POST /api/ai/chat ───────────────────────────────────────
  // Auth mirrors ChatViewScreen / StoriesBar exactly:
  //   const headers = { 'Content-Type': 'application/json', ...(await authHeaders(currentUser.id)) }
  // here with the contracted `currentUserId` prop as the fallback id.
  const requestReply = async (conversation: AiMessage[]) => {
    setIsThinking(true);
    setError(null);
    try {
      const headers = {
        'Content-Type': 'application/json',
        ...(await authHeaders(currentUserId)),
      };
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          messages: conversation
            .slice(-20)
            .map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      let data: any = null;
      try {
        data = await res.json();
      } catch {
        /* empty / non-JSON body — handled as a generic error below */
      }
      if (res.ok && typeof data?.reply === 'string' && data.reply) {
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: data.reply, ts: Date.now() },
        ]);
        return;
      }
      if (res.status === 503 || data?.error === 'ai_not_configured') {
        setAiNotConfigured(true);
        return;
      }
      if (res.status === 429 || data?.error === 'rate_limited') {
        setError({ kind: 'rate' });
        return;
      }
      setError({ kind: 'generic' });
    } catch {
      // Network / transport failure — inline error bubble, never a crash.
      setError({ kind: 'generic' });
    } finally {
      setIsThinking(false);
    }
  };

  const handleSend = () => {
    const text = input.trim();
    if (!text || isThinking || aiNotConfigured) return;
    const userMsg: AiMessage = { role: 'user', content: text, ts: Date.now() };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput('');
    setActiveMenuIdx(null);
    void requestReply(next);
  };

  // Retry resends the SAME conversation (the last user message is already in
  // it) — no duplicate user bubble is appended.
  const handleRetry = () => {
    if (isThinking || aiNotConfigured) return;
    if (!messages.some((m) => m.role === 'user')) return;
    void requestReply(messages);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    if ((e.nativeEvent as any)?.isComposing) return; // IME composition — not a send
    e.preventDefault();
    handleSend();
  };

  const handleChip = (prefill: string) => {
    setInput(prefill);
    window.setTimeout(() => {
      const el = composerRef.current;
      if (!el) return;
      el.focus();
      try {
        el.setSelectionRange(prefill.length, prefill.length);
      } catch {
        /* selection unsupported — focus alone is enough */
      }
    }, 0);
  };

  const handleClearChat = () => {
    setHeaderMenuOpen(false);
    const ok = window.confirm(
      bn ? 'সব AI চ্যাট মুছে ফেলতে চান?' : 'Clear all AI chat messages?'
    );
    if (!ok) return;
    setMessages([]);
    setError(null);
    setActiveMenuIdx(null);
    setSavedIdx(null);
    setCopiedIdx(null);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  };

  const handleCopy = async (content: string, idx: number) => {
    setActiveMenuIdx(null);
    try {
      await navigator.clipboard.writeText(content);
      flashFeedback('copied', idx);
    } catch {
      /* clipboard unavailable — fail quietly, never crash the screen */
    }
  };

  const handleSave = (content: string, idx: number) => {
    setActiveMenuIdx(null);
    if (!onSaveReply) return;
    onSaveReply(content);
    flashFeedback('saved', idx);
  };

  if (!open) return null;

  const errorText =
    error?.kind === 'rate'
      ? bn
        ? 'অনেক বেশি অনুরোধ — একটু অপেক্ষা করে আবার চেষ্টা করুন।'
        : 'Too many requests — wait a moment and retry.'
      : bn
        ? 'কিছু একটা সমস্যা হয়েছে'
        : 'Something went wrong';

  const composerDisabled = aiNotConfigured || isThinking;
  const sendDisabled = composerDisabled || input.trim().length === 0;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-[#FFFFFF] dark:bg-[#0C1210]"
      role="dialog"
      aria-modal="true"
      aria-label="AI Assistant"
    >
      {/* Backdrop that closes any open menu on an outside tap */}
      {(headerMenuOpen || activeMenuIdx !== null) && (
        <button
          type="button"
          aria-hidden="true"
          tabIndex={-1}
          className="fixed inset-0 z-20 cursor-default"
          onClick={() => {
            setHeaderMenuOpen(false);
            setActiveMenuIdx(null);
          }}
        />
      )}

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="relative z-30 shrink-0 flex items-center gap-1.5 px-2 sm:px-3 py-2 border-b border-[#E5E9F0] dark:border-white/10 bg-[#FFFFFF] dark:bg-[#0C1210]">
        <button
          type="button"
          onClick={onClose}
          className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-full hover:bg-[#EDF2EE] dark:hover:bg-white/10 text-[#15211B] dark:text-[#EDF3EF] transition-colors active:scale-95"
          aria-label={bn ? 'পেছনে যান' : 'Back'}
          title={bn ? 'পেছনে যান' : 'Back'}
        >
          <ArrowLeft className="w-5 h-5" />
        </button>

        <div className="w-10 h-10 rounded-full bg-[#F2A007]/15 flex items-center justify-center shrink-0">
          <Sparkles className="w-5 h-5 text-[#F2A007]" />
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-[15px] font-bold leading-tight text-[#15211B] dark:text-[#EDF3EF] truncate">
            AI Assistant
          </p>
          <p className="text-xs leading-tight text-[#5C6B62] dark:text-[#9DB0A5] truncate">
            Powered by NVIDIA
          </p>
        </div>

        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => {
              setActiveMenuIdx(null);
              setHeaderMenuOpen((v) => !v);
            }}
            className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-full hover:bg-[#EDF2EE] dark:hover:bg-white/10 text-[#15211B] dark:text-[#EDF3EF] transition-colors active:scale-95"
            aria-label={bn ? 'আরও অপশন' : 'More options'}
            title={bn ? 'আরও অপশন' : 'More options'}
          >
            <MoreVertical className="w-5 h-5" />
          </button>
          {headerMenuOpen && (
            <div className="absolute right-0 top-full mt-1 w-56 rounded-2xl bg-white dark:bg-[#1C2621] border border-[#E5E9F0] dark:border-white/10 shadow-xl py-1.5 z-30 animate-in fade-in">
              <button
                type="button"
                onClick={handleClearChat}
                className="w-full min-h-[44px] flex items-center gap-2.5 px-4 py-2.5 text-left text-sm font-medium text-[#15211B] dark:text-[#EDF3EF] hover:bg-[#EDF2EE] dark:hover:bg-white/10 transition-colors"
              >
                <Trash2 className="w-4 h-4 shrink-0" />
                {bn ? 'চ্যাট মুছুন' : 'Clear chat'}
              </button>
            </div>
          )}
        </div>
      </header>

      {/* ── Chat area ──────────────────────────────────────────────────── */}
      {aiNotConfigured ? (
        <div className="flex-1 overflow-y-auto flex items-center justify-center px-4 py-8">
          <div className="max-w-sm w-full text-center rounded-[28px] bg-[#F7F6F1] dark:bg-[#131A17] px-6 py-8">
            <div className="w-14 h-14 mx-auto rounded-full bg-[#F2A007]/15 flex items-center justify-center">
              <Sparkles className="w-7 h-7 text-[#F2A007]" />
            </div>
            <p className="mt-4 text-base font-bold text-[#15211B] dark:text-[#EDF3EF]">
              {bn
                ? 'এই সার্ভারে AI এখনো সেটআপ হয়নি'
                : 'AI is not set up on this server yet'}
            </p>
            <p className="mt-1.5 text-sm leading-relaxed text-[#5C6B62] dark:text-[#9DB0A5]">
              {bn
                ? 'সার্ভার অ্যাডমিনকে NVIDIA API কী যোগ করতে হবে।'
                : 'The server admin needs to add the NVIDIA API key.'}
            </p>
          </div>
        </div>
      ) : (
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 sm:px-4 py-4">
          <div className="max-w-3xl mx-auto w-full flex flex-col gap-3">
            {messages.length === 0 && !isThinking && (
              <div className="mx-auto max-w-md w-full text-center rounded-[28px] bg-[#F7F6F1] dark:bg-[#131A17] px-6 py-8 my-4">
                <div className="w-14 h-14 mx-auto rounded-full bg-[#F2A007]/15 flex items-center justify-center">
                  <Sparkles className="w-7 h-7 text-[#F2A007]" />
                </div>
                <div className="mt-4 text-[15px] leading-relaxed text-[#15211B] dark:text-[#EDF3EF]">
                  {bn ? (
                    <p>
                      হাই! আমি আপনার Chitthi AI অ্যাসিস্ট্যান্ট। আমি আপনাকে মেসেজ
                      লিখতে, অনুবাদ করতে, নোট বানাতে, আইডিয়া দিতে এবং আরও অনেক
                      কিছুতে সাহায্য করতে পারি। নিচের একটি অপশন বেছে নিন অথবা
                      সরাসরি লিখে পাঠান — আপনি কীসে সাহায্য চান?
                    </p>
                  ) : (
                    <p>
                      Hi! I am your Chitthi AI assistant. I can help you write
                      messages, translate, make notes, brainstorm ideas and
                      more. Pick a quick action below or just type — what would
                      you like help with?
                    </p>
                  )}
                </div>
              </div>
            )}

            {messages.map((msg, idx) => {
              const isMe = msg.role === 'user';
              const menuOpen = activeMenuIdx === idx;
              return (
                <div
                  key={`${msg.ts}-${idx}`}
                  className={`flex flex-col ${isMe ? 'items-end' : 'items-start'} ${
                    menuOpen ? 'relative z-30' : ''
                  }`}
                >
                  <div
                    className={`relative max-w-[85%] sm:max-w-[75%] px-3.5 py-2.5 text-[16px] leading-[1.45] ${
                      isMe
                        ? 'bg-[#0B6E4F] text-white rounded-[20px] rounded-br-[4px]'
                        : 'bg-[#EDF2EE] dark:bg-[#1C2621] text-[#15211B] dark:text-[#EDF3EF] rounded-[20px] rounded-bl-[4px]'
                    }`}
                  >
                    {!isMe && (
                      <button
                        type="button"
                        onClick={() => {
                          setHeaderMenuOpen(false);
                          setActiveMenuIdx(menuOpen ? null : idx);
                        }}
                        className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-white dark:bg-[#1C2621] border border-[#E5E9F0] dark:border-white/15 shadow-md flex items-center justify-center text-[#5C6B62] dark:text-[#9DB0A5] hover:text-[#15211B] dark:hover:text-[#EDF3EF] transition-colors z-10"
                        aria-label={bn ? 'মেসেজ অ্যাকশন' : 'Message actions'}
                        title={bn ? 'মেসেজ অ্যাকশন' : 'Message actions'}
                      >
                        <MoreVertical className="w-3.5 h-3.5" />
                      </button>
                    )}

                    {menuOpen && !isMe && (
                      <div className="absolute -right-2 top-5 z-30 w-60 rounded-2xl bg-white dark:bg-[#1C2621] border border-[#E5E9F0] dark:border-white/10 shadow-xl py-1.5 animate-in fade-in text-[#15211B] dark:text-[#EDF3EF]">
                        <button
                          type="button"
                          onClick={() => void handleCopy(msg.content, idx)}
                          className="w-full min-h-[44px] flex items-center gap-2.5 px-4 py-2.5 text-left text-sm font-medium hover:bg-[#EDF2EE] dark:hover:bg-white/10 transition-colors"
                        >
                          <Copy className="w-4 h-4 shrink-0" />
                          {bn ? 'কপি' : 'Copy'}
                        </button>
                        {onSaveReply && (
                          <button
                            type="button"
                            onClick={() => handleSave(msg.content, idx)}
                            className="w-full min-h-[44px] flex items-center gap-2.5 px-4 py-2.5 text-left text-sm font-medium hover:bg-[#EDF2EE] dark:hover:bg-white/10 transition-colors"
                          >
                            <Bookmark className="w-4 h-4 shrink-0" />
                            {bn ? 'সেভড মেসেজে রাখুন' : 'Save to Saved Messages'}
                          </button>
                        )}
                      </div>
                    )}

                    <div className="space-y-0.5">{renderContent(msg.content)}</div>
                  </div>

                  {savedIdx === idx && (
                    <span className="mt-1.5 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#EDF2EE] dark:bg-[#1C2621] text-[11px] font-bold text-[#0B6E4F] dark:text-[#9DB0A5]">
                      <Check className="w-3 h-3" />
                      {bn ? 'সেভ হয়েছে' : 'Saved'}
                    </span>
                  )}
                  {copiedIdx === idx && (
                    <span className="mt-1.5 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#EDF2EE] dark:bg-[#1C2621] text-[11px] font-bold text-[#0B6E4F] dark:text-[#9DB0A5]">
                      <Check className="w-3 h-3" />
                      {bn ? 'কপি হয়েছে' : 'Copied'}
                    </span>
                  )}
                </div>
              );
            })}

            {/* Thinking — typing-dots pattern from ChatViewScreen */}
            {isThinking && (
              <div className="flex flex-col items-start">
                <div
                  className="max-w-[85%] sm:max-w-[75%] px-3.5 py-3 bg-[#EDF2EE] dark:bg-[#1C2621] rounded-[20px] rounded-bl-[4px] flex items-center gap-1"
                  role="status"
                  aria-label={bn ? 'AI ভাবছে…' : 'AI is thinking…'}
                >
                  <span
                    className="w-2 h-2 rounded-full bg-[#5C6B62] dark:bg-[#9DB0A5] animate-bounce"
                    style={{ animationDelay: '0ms' }}
                  />
                  <span
                    className="w-2 h-2 rounded-full bg-[#5C6B62] dark:bg-[#9DB0A5] animate-bounce"
                    style={{ animationDelay: '150ms' }}
                  />
                  <span
                    className="w-2 h-2 rounded-full bg-[#5C6B62] dark:bg-[#9DB0A5] animate-bounce"
                    style={{ animationDelay: '300ms' }}
                  />
                </div>
              </div>
            )}

            {/* Inline error bubble (429 / network / other) with Retry */}
            {error && !isThinking && (
              <div className="flex flex-col items-start">
                <div className="max-w-[85%] sm:max-w-[75%] px-3.5 py-2.5 text-[15px] leading-[1.45] bg-[#EDF2EE] dark:bg-[#1C2621] text-[#15211B] dark:text-[#EDF3EF] rounded-[20px] rounded-bl-[4px]">
                  <p>{errorText}</p>
                  <button
                    type="button"
                    onClick={handleRetry}
                    className="mt-2 inline-flex items-center gap-1.5 min-h-[36px] px-3.5 rounded-full bg-[#0B6E4F] text-white text-sm font-semibold transition-all active:scale-95 hover:opacity-90"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    {bn ? 'আবার চেষ্টা করুন' : 'Retry'}
                  </button>
                </div>
              </div>
            )}

            <div ref={endRef} />
          </div>
        </div>
      )}

      {/* ── Quick chips + composer ─────────────────────────────────────── */}
      <div className="shrink-0 border-t border-[#E5E9F0] dark:border-white/10 bg-[#FFFFFF] dark:bg-[#0C1210]">
        <div className="bg-[#F7F6F1] dark:bg-[#131A17] px-3 py-2 flex gap-2 overflow-x-auto">
          {CHIPS.map((chip) => (
            <button
              key={chip.id}
              type="button"
              disabled={composerDisabled}
              onClick={() => handleChip(chip.prefill)}
              className="min-h-[40px] shrink-0 whitespace-nowrap inline-flex items-center px-3.5 rounded-full bg-white dark:bg-[#1C2621] border border-black/5 dark:border-white/10 text-sm font-medium text-[#15211B] dark:text-[#EDF3EF] transition-all active:scale-95 hover:opacity-90 disabled:opacity-50 disabled:pointer-events-none"
            >
              {bn ? chip.labelBn : chip.labelEn}
            </button>
          ))}
        </div>

        <div
          className="flex items-end gap-2 px-3 pt-2"
          style={{ paddingBottom: 'max(10px, env(safe-area-inset-bottom))' }}
        >
          <div className="flex-1 rounded-[24px] bg-[#F7F6F1] dark:bg-[#131A17] px-4 py-2">
            <textarea
              ref={composerRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={composerDisabled}
              rows={1}
              placeholder={
                bn ? 'AI অ্যাসিস্ট্যান্টকে মেসেজ লিখুন…' : 'Message AI Assistant…'
              }
              aria-label={bn ? 'AI অ্যাসিস্ট্যান্টকে মেসেজ লিখুন' : 'Message AI Assistant'}
              className="w-full bg-transparent resize-none text-[16px] leading-6 text-[#15211B] dark:text-[#EDF3EF] placeholder:text-[#5C6B62] dark:placeholder:text-[#9DB0A5] disabled:opacity-50"
            />
          </div>
          <button
            type="button"
            onClick={handleSend}
            disabled={sendDisabled}
            className="w-11 h-11 shrink-0 rounded-full bg-[#0B6E4F] text-white flex items-center justify-center transition-all active:scale-95 hover:opacity-90 disabled:opacity-40 disabled:pointer-events-none"
            aria-label={bn ? 'পাঠান' : 'Send'}
            title={bn ? 'পাঠান' : 'Send'}
          >
            <Send className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default AIAssistantScreen;
