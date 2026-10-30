import React, { useState } from 'react';
import { AtSign, Check, X, Loader2, AlertCircle } from 'lucide-react';
import {
  claimUsername,
  validateUsernameFormat,
  usernameProblemText
} from '../services/firebase';
import { useUsernameAvailability, UsernameCheckLine } from './usernameAvailability';

// One-time post-login username claim prompt (Phase 1.4.1). The shared
// debounced live-availability hook lives in ./usernameAvailability.
// Username changes are FAIL-CLOSED: any check or claim
// failure keeps the modal open with a visible error — nothing is applied
// locally on an unverified claim.

interface ClaimUsernameModalProps {
  open: boolean;
  /** Called after the server has confirmed the claim. */
  onClaim: (handle: string) => void;
  onSkip: () => void;
  lang?: 'bn' | 'en';
}

export const ClaimUsernameModal: React.FC<ClaimUsernameModalProps> = ({
  open,
  onClaim,
  onSkip,
  lang = 'en'
}) => {
  const [handle, setHandle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isClaiming, setIsClaiming] = useState(false);
  const check = useUsernameAvailability(handle, open);

  if (!open) return null;

  const clean = handle.trim().toLowerCase();

  const handleClaim = async () => {
    setError(null);
    const problem = validateUsernameFormat(clean);
    if (problem) {
      setError(usernameProblemText(problem, lang));
      return;
    }
    // Fail closed: only a server-confirmed claim applies the username.
    setIsClaiming(true);
    try {
      const result = await claimUsername(clean);
      if (!result.ok) {
        setError(usernameProblemText(result.reason, lang));
        return;
      }
      onClaim(clean);
    } finally {
      setIsClaiming(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60  flex items-center justify-center p-4 animate-in fade-in select-none">
      <div className="glass-sheet rounded-[var(--r-sheet)] w-full max-w-md overflow-hidden shadow-soft text-app transition-[opacity,transform] [transition-duration:var(--dur-sheet)] [transition-timing-function:var(--ease-spring)]" role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'আপনার @username বেছে নিন' : 'Choose your @username'} >
        <div className="p-6 space-y-5">
          <div className="flex flex-col items-center text-center gap-2">
            <span className="w-12 h-12 rounded-2xl bg-bubble-in text-primary flex items-center justify-center">
              <AtSign className="w-6 h-6" />
            </span>
            <h3 className="text-lg font-bold text-app">
              {lang === 'bn' ? 'আপনার @username বেছে নিন' : 'Choose your @username'}
            </h3>
            <p className="text-xs text-app-2 leading-relaxed">
              {lang === 'bn'
                ? 'মানুষ আপনার ইমেইল না জেনেই @username দিয়ে আপনাকে খুঁজে পাবে ও মেসেজ পাঠাতে পারবে।'
                : 'People can find and message you by @username — without ever seeing your email address.'}
            </p>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center rounded-[var(--r-control)] bg-surface px-3.5 border border-transparent overflow-hidden transition-colors">
              <span className="text-sm font-bold text-app-faint select-none">@</span>
              <input
                type="text"
                value={handle}
                onChange={(e) => {
                  setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20));
                  setError(null);
                }}
                placeholder="username"
                maxLength={20}
                autoFocus
                className="flex-1 bg-transparent px-1 py-2.5 text-sm text-app placeholder:text-app-faint "
               aria-label={lang === 'bn' ? 'ইউজারনেম' : 'Username'} />
              {check.kind === 'available' && <Check className="w-4 h-4 text-online shrink-0" />}
              {(check.kind === 'unavailable' || check.kind === 'invalid') && (
                <X className="w-4 h-4 text-danger shrink-0" />
              )}
              {check.kind === 'checking' && <Loader2 className="w-4 h-4 text-app-faint animate-spin shrink-0" />}
            </div>
            <UsernameCheckLine state={check} lang={lang} />
            <p className="text-[11px] text-app-faint leading-snug">
              {lang === 'bn'
                ? '৫–২০ অক্ষর, ছোট হাতের অক্ষর/সংখ্যা/আন্ডারস্কোর, অক্ষর দিয়ে শুরু। পরে প্রোফাইল সেটিংস থেকে বদলাতে পারবেন।'
                : '5–20 characters: lowercase letters, numbers and underscores, starting with a letter. You can change it later in Profile settings.'}
            </p>
          </div>

          {error && (
            <div className="p-2.5 rounded-xl bg-surface  border border-token  text-xs text-danger  flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={onSkip}
              disabled={isClaiming}
              className="flex-1 px-4 py-2.5 text-xs font-semibold text-app-2 hover:text-app rounded-full transition-colors disabled:opacity-50"
            >
              {lang === 'bn' ? 'পরে করব' : 'Maybe later'}
            </button>
            <button
              type="button"
              onClick={() => void handleClaim()}
              disabled={isClaiming || !clean}
              className="flex-1 flex items-center justify-center gap-1.5 px-5 py-2.5 bg-primary hover:brightness-110 text-white rounded-full text-xs font-bold shadow-md  transition-colors disabled:opacity-50"
            >
              {isClaiming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              <span>{lang === 'bn' ? 'ইউজারনেম নিন' : 'Claim username'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
