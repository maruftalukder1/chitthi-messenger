import React, { useEffect, useState } from 'react';
import { Check, X, Loader2, AlertCircle } from 'lucide-react';
import {
  checkUsername,
  validateUsernameFormat,
  usernameProblemText
} from '../services/firebase';

// Shared username-availability machinery (Phase 5 extraction): the debounced
// live-availability hook + status line used by the sign-up form, the profile
// editor and the claim modal. Split out of ClaimUsernameModal.tsx so the
// modal itself can be lazy-loaded without dragging the hook into the
// initial bundle (LoginScreen imports the hook eagerly).

export type UsernameCheckState =
  | { kind: 'idle' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'checking' }
  | { kind: 'available' }
  | { kind: 'unavailable'; reason?: string }
  | { kind: 'unreachable' };

/**
 * Debounced live availability for a handle being typed. `enabled=false`
 * (e.g. the field still holds the user's current username) parks the hook
 * at 'idle' and no request is made.
 */
export function useUsernameAvailability(handle: string, enabled: boolean = true): UsernameCheckState {
  const [state, setState] = useState<UsernameCheckState>({ kind: 'idle' });

  useEffect(() => {
    const h = (handle || '').trim().toLowerCase();
    if (!enabled || !h) {
      setState({ kind: 'idle' });
      return;
    }
    const problem = validateUsernameFormat(h);
    if (problem) {
      setState({ kind: 'invalid', reason: problem });
      return;
    }
    setState({ kind: 'checking' });
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const result = await checkUsername(h);
        if (cancelled) return;
        if (!result.reachable) setState({ kind: 'unreachable' });
        else if (result.available) setState({ kind: 'available' });
        else setState({ kind: 'unavailable', reason: result.reason });
      })();
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [handle, enabled]);

  return state;
}

/** Small tick/cross/status line rendered under a username field. */
export const UsernameCheckLine: React.FC<{
  state: UsernameCheckState;
  lang: 'bn' | 'en';
  className?: string;
}> = ({ state, lang, className }) => {
  if (state.kind === 'idle') return null;
  const base = `flex items-center gap-1.5 text-[11px] ${className || ''}`;
  if (state.kind === 'checking') {
    return (
      <p className={`${base} text-app-faint`}>
        <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
        <span>{lang === 'bn' ? 'পাওয়া যাচ্ছে কিনা দেখা হচ্ছে...' : 'Checking availability...'}</span>
      </p>
    );
  }
  if (state.kind === 'available') {
    return (
      <p className={`${base} text-online  font-semibold`}>
        <Check className="w-3.5 h-3.5 shrink-0" />
        <span>{lang === 'bn' ? 'এই ইউজারনেমটি পাওয়া যাচ্ছে' : 'This username is available'}</span>
      </p>
    );
  }
  if (state.kind === 'invalid') {
    return (
      <p className={`${base} text-danger `}>
        <X className="w-3.5 h-3.5 shrink-0" />
        <span>{usernameProblemText(state.reason, lang)}</span>
      </p>
    );
  }
  if (state.kind === 'unavailable') {
    return (
      <p className={`${base} text-danger `}>
        <X className="w-3.5 h-3.5 shrink-0" />
        <span>{usernameProblemText(state.reason, lang)}</span>
      </p>
    );
  }
  // unreachable
  return (
    <p className={`${base} text-away `}>
      <AlertCircle className="w-3.5 h-3.5 shrink-0" />
      <span>
        {lang === 'bn'
          ? 'সার্ভারে পৌঁছানো যাচ্ছে না — ইউজারনেম যাচাই করা যাচ্ছে না।'
          : "Can't reach the server — this username can't be verified right now."}
      </span>
    </p>
  );
};
