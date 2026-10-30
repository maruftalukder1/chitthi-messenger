import React, { useState, useEffect } from 'react';
import { User } from '../types/chat';
import {
  auth,
  googleProvider,
  logUserActivity,
  syncUserProfile,
  syncDirectoryProfile,
  claimUsername,
  validateUsernameFormat,
  usernameProblemText,
  deriveEmailUserId,
  migrateLegacyUserDoc
} from '../services/firebase';
import { useUsernameAvailability, UsernameCheckLine } from './usernameAvailability';
import {
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  sendEmailVerification
} from 'firebase/auth';
import {
  Mail,
  Lock,
  User as UserIcon,
  ArrowRight,
  AlertCircle,
  Loader2,
  CheckCircle2,
  Eye,
  EyeOff,
  Globe,
  RefreshCw,
  KeyRound,
  ClipboardPaste,
  Inbox
} from 'lucide-react';

interface LoginScreenProps {
  onLogin: (user: User) => void;
  lang: 'bn' | 'en';
  onToggleLang?: () => void;
}

const DEFAULT_AVATARS = [
  'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=200&q=80',
  'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=200&q=80',
  'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=200&q=80',
  'https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=200&q=80',
  'https://images.unsplash.com/photo-1570295999919-56ceb5ecca61?auto=format&fit=crop&w=200&q=80'
];

interface StoredAccount {
  name: string;
  email: string;
  // Current format: PBKDF2-HMAC-SHA-256 with a per-password random salt,
  // stored as `pbkdf2$<iters>$<saltB64>$<hashB64>`. Legacy values
  // (`sha256:` unsalted, `insecure-fallback:` FNV) are still accepted by
  // verifyPassword() and transparently upgraded on successful sign-in.
  // Never stores the plaintext password.
  passwordHash?: string;
  // Legacy plaintext field — verified once, then transparently migrated to
  // passwordHash and deleted on the next successful login.
  password?: string;
  avatar: string;
  /** Optional @username chosen at sign-up (Phase 1.4.1). Claimed on the
   * server at activation; only kept on the account when the claim succeeds. */
  username?: string;
  verified: boolean;
  createdAt?: number;
}

// Password storage (Phase 0.1 upgrade): new hashes are PBKDF2-HMAC-SHA-256
// via Web Crypto with a per-password random salt and 100,000 iterations,
// stored as `pbkdf2$<iters>$<saltB64>$<hashB64>`.
// verifyPassword() additionally accepts the two legacy formats VERIFY-ONLY —
// unsalted single-round `sha256:` and the `insecure-fallback:` FNV hash used
// in non-secure contexts — so no existing account is locked out; a successful
// legacy sign-in is transparently re-hashed with PBKDF2 by the caller.
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_KEY_BITS = 256;

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function pbkdf2Derive(pw: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const subtle = globalThis.crypto.subtle;
  const key = await subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    PBKDF2_KEY_BITS
  );
  return new Uint8Array(bits);
}

// The legacy non-crypto FNV-1a hash, kept verify-only for accounts created
// in insecure contexts (where crypto.subtle was unavailable). New hashes use
// it ONLY as a last-resort fallback when crypto.subtle is missing entirely,
// so sign-up never crashes on plain http:// — deploy over HTTPS.
function insecureFallbackHash(pw: string): string {
  let h1 = 0xcbf29ce4;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < pw.length; i++) {
    const ch = pw.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x1000193);
    h2 = Math.imul(h2 ^ (ch >>> 8), 0x1000193);
  }
  return `insecure-fallback:${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

async function hashPassword(pw: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
    const derived = await pbkdf2Derive(pw, salt, PBKDF2_ITERATIONS);
    return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(derived)}`;
  }
  return insecureFallbackHash(pw);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Verify a password against any stored format. Returns false for unknown or
// malformed values — never throws, never fails open.
async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  try {
    if (stored.startsWith('pbkdf2$')) {
      const parts = stored.split('$');
      if (parts.length !== 4) return false;
      const iterations = Number.parseInt(parts[1], 10);
      if (!Number.isFinite(iterations) || iterations < 1) return false;
      if (!globalThis.crypto?.subtle) return false;
      const salt = base64ToBytes(parts[2]);
      const expected = base64ToBytes(parts[3]);
      const derived = await pbkdf2Derive(pw, salt, iterations);
      return timingSafeEqual(derived, expected);
    }
    if (stored.startsWith('sha256:')) {
      const subtle = globalThis.crypto?.subtle;
      if (!subtle) return false;
      const digest = await subtle.digest('SHA-256', new TextEncoder().encode(pw));
      const hex = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      return `sha256:${hex}` === stored;
    }
    if (stored.startsWith('insecure-fallback:')) {
      return insecureFallbackHash(pw) === stored;
    }
    return false;
  } catch {
    return false;
  }
}

// True when a stored hash uses a legacy (pre-PBKDF2) format and should be
// transparently upgraded after a successful verification.
function isLegacyPasswordHash(stored: string): boolean {
  return stored.startsWith('sha256:') || stored.startsWith('insecure-fallback:');
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ onLogin, lang: parentLang, onToggleLang }) => {
  const [localLang, setLocalLang] = useState<'bn' | 'en'>(parentLang || 'en');
  const lang = localLang;

  const toggleLanguage = () => {
    const nextLang = lang === 'bn' ? 'en' : 'bn';
    setLocalLang(nextLang);
    if (onToggleLang) onToggleLang();
  };

  const [isSignUp, setIsSignUp] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [selectedAvatar, setSelectedAvatar] = useState(DEFAULT_AVATARS[0]);
  // Optional @username at sign-up (Phase 1.4.1), live-checked when the
  // server is reachable; skipped silently when it is not.
  const [signupUsername, setSignupUsername] = useState('');
  const signupUsernameCheck = useUsernameAvailability(
    signupUsername,
    isSignUp && !!signupUsername.trim()
  );

  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Email Verification Modal State
  const [verificationPending, setVerificationPending] = useState<StoredAccount | null>(null);
  const [enteredOtp, setEnteredOtp] = useState('');
  const [otpError, setOtpError] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  // Demo-mode code: set ONLY when the server responds delivery:'demo' (no SMTP
  // configured, so no real email was sent). Shown in a clearly-labeled box.
  const [demoCode, setDemoCode] = useState<string | null>(null);
  // True whenever the server reports delivery:'demo' (no SMTP), even when it
  // withholds the code (no CHITTHI_DEMO_OTP): no email was sent, so the modal
  // must show the demo label — never "Delivered" (Lens-3 honesty fix).
  const [demoNoDelivery, setDemoNoDelivery] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [firebaseEmailSent, setFirebaseEmailSent] = useState(false);
  const [firebaseConsoleNotice, setFirebaseConsoleNotice] = useState<string | null>(null);

  // Cooldown countdown for Resend verification code
  useEffect(() => {
    let timer: any;
    if (resendCooldown > 0) {
      timer = setInterval(() => {
        setResendCooldown((prev) => prev - 1);
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [resendCooldown]);

  // Load existing accounts registered in localStorage
  const getRegisteredAccounts = (): Record<string, StoredAccount> => {
    try {
      const data = localStorage.getItem('chithi_registered_accounts');
      return data ? JSON.parse(data) : {};
    } catch {
      return {};
    }
  };

  const saveAccount = (acc: StoredAccount) => {
    const accounts = getRegisteredAccounts();
    accounts[acc.email.toLowerCase().trim()] = acc;
    localStorage.setItem('chithi_registered_accounts', JSON.stringify(accounts));
  };

  // Resolve the app user id for an email (Phase 0.9 UID keying): when a
  // Firebase Auth user for THIS email exists, the id is the Firebase UID and
  // any legacy `users/{user_<email>}` doc is migrated to `users/{uid}`.
  // Purely local accounts (no matching Firebase user) keep the synthetic id,
  // so local-registry sign-ins keep working exactly as before.
  const resolveAppUserId = async (forEmail: string): Promise<string> => {
    const fbUser = auth.currentUser;
    if (fbUser && fbUser.email && fbUser.email.toLowerCase().trim() === forEmail.toLowerCase().trim()) {
      await migrateLegacyUserDoc(fbUser.uid, forEmail);
      return fbUser.uid;
    }
    return deriveEmailUserId(forEmail);
  };

  // Google Sign-In with robust fallback
  const handleGoogleSignIn = async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const result = await signInWithPopup(auth, googleProvider);
      const fbUser = result.user;
      // Phase 0.9: copy any legacy user_<email> profile doc to the UID doc.
      if (fbUser.email) await migrateLegacyUserDoc(fbUser.uid, fbUser.email);
      const appUser: User = {
        id: fbUser.uid,
        name: fbUser.displayName || 'Google User',
        email: fbUser.email || undefined,
        avatar: fbUser.photoURL || selectedAvatar,
        status: 'Available on Chitthi',
        online: true,
        presence: 'online',
        role: 'You'
      };

      await syncUserProfile({
        id: fbUser.uid,
        name: appUser.name,
        email: fbUser.email || '',
        avatar: appUser.avatar
      });
      await logUserActivity(fbUser.uid, appUser.name, fbUser.email || '', 'Google Login');

      onLogin(appUser);
    } catch (err: any) {
      // Never fabricate an identity on failure — surface the real error so
      // the user can retry; a fake login would impersonate another account.
      console.warn('Google sign-in failed:', err);
      setErrorMessage(
        lang === 'bn'
          ? 'Google দিয়ে লগইন ব্যর্থ হয়েছে। আবার চেষ্টা করুন।'
          : 'Google sign-in failed. Please try again.'
      );
    } finally {
      setLoading(false);
    }
  };

  // Parse the server's send-2fa response. With real SMTP the code is delivered
  // by email and never returned; in demo mode (no SMTP) the server responds
  // delivery:'demo' with the code, which we surface in a clearly-labeled box.
  const handleSend2faResponse = async (res: Response | null, label: string) => {
    if (!res) return;
    try {
      const data = await res.json();
      if (data.delivery === 'demo') {
        // No SMTP on the server: no email was delivered, whether or not the
        // server disclosed a demo code in this response.
        setDemoNoDelivery(true);
        if (typeof data.code === 'string' && data.code.length > 0) {
          setDemoCode(data.code);
        }
      } else if (data.delivery === 'email') {
        setDemoNoDelivery(false);
      }
    } catch {
      console.warn(`Could not parse ${label} send-2fa response`);
    }
  };

  // Handle Form Submit: Sign Up or Sign In
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);

    const cleanEmail = email.toLowerCase().trim();

    if (!cleanEmail) {
      setErrorMessage(
        lang === 'bn' ? 'অনুগ্রহ করে ইমেইল অ্যাড্রেস লিখুন।' : 'Please enter your email address.'
      );
      return;
    }

    if (isSignUp) {
      // 1. Validation checks for registration
      if (!name.trim()) {
        setErrorMessage(
          lang === 'bn' ? 'অনুগ্রহ করে আপনার পুরো নাম লিখুন।' : 'Please enter your full name.'
        );
        return;
      }

      if (password.length < 6) {
        setErrorMessage(
          lang === 'bn'
            ? 'পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে।'
            : 'Password must be at least 6 characters long.'
        );
        return;
      }

      // Optional username: the format rules are deterministic, so an
      // invalid handle blocks sign-up. A server-confirmed "taken/reserved"
      // also blocks; an unreachable server does NOT (the claim is retried
      // at activation and can be changed later in Profile settings).
      const cleanUsername = signupUsername.trim().toLowerCase();
      if (cleanUsername) {
        const problem = validateUsernameFormat(cleanUsername);
        if (problem) {
          setErrorMessage(usernameProblemText(problem, lang));
          return;
        }
        if (signupUsernameCheck.kind === 'unavailable') {
          setErrorMessage(usernameProblemText(signupUsernameCheck.reason, lang));
          return;
        }
      }

      // 2. Password Confirmation Check
      if (password !== confirmPassword) {
        setErrorMessage(
          lang === 'bn'
            ? 'পাসওয়ার্ড এবং কনফার্ম পাসওয়ার্ড মিলছে না।'
            : 'Password and Confirm Password do not match.'
        );
        return;
      }

      setLoading(true);

      // Check if account already exists
      const accounts = getRegisteredAccounts();
      if (accounts[cleanEmail] && accounts[cleanEmail].verified) {
        setErrorMessage(
          lang === 'bn'
            ? 'এই ইমেইল দিয়ে আগেই অ্যাকাউন্ট তৈরি করা হয়েছে। অনুগ্রহ করে সাইন ইন করুন।'
            : 'An account with this email already exists. Please sign in.'
        );
        setLoading(false);
        return;
      }

      // Firebase UID captured from signup when Firebase creates the user;
      // stays null when Firebase signup fails and the account is local-only.
      let firebaseUid: string | null = null;

      try {
        setFirebaseConsoleNotice(null);
        setFirebaseEmailSent(false);

        try {
          const userCredential = await createUserWithEmailAndPassword(auth, cleanEmail, password);
          firebaseUid = userCredential.user.uid;
          await updateProfile(userCredential.user, {
            displayName: name.trim(),
            photoURL: selectedAvatar
          });
          try {
            await sendEmailVerification(userCredential.user);
            setFirebaseEmailSent(true);
          } catch (evErr) {
            console.warn('Firebase sendEmailVerification note:', evErr);
          }
        } catch (_firebaseErr: any) {
          console.warn('Firebase email auth note:', _firebaseErr);
          if (_firebaseErr?.code === 'auth/operation-not-allowed') {
            setFirebaseConsoleNotice(
              lang === 'bn'
                ? 'ফায়ারবেস কনসোলে Email/Password প্রোভাইডার এখনও সক্রিয় (Enable) করা হয়নি। সমাধান: Firebase Console -> Authentication -> Sign-in method এ গিয়ে "Email/Password" প্রোভাইডার Enable করুন। চিঠি মেসেঞ্জার আপনার অ্যাকাউন্টের জন্য ইমেইল ভেরিফিকেশন সক্রিয় করেছে।'
                : 'Email/Password provider is disabled in Firebase Console. (To enable: Firebase Console -> Authentication -> Sign-in method -> Click "Email/Password" and toggle "Enable"). Chitthi has activated email verification for your account.'
            );
          }
        }

        const newAccount: StoredAccount = {
          name: name.trim(),
          email: cleanEmail,
          passwordHash: await hashPassword(password),
          avatar: selectedAvatar,
          username: cleanUsername || undefined,
          verified: false,
          createdAt: Date.now()
        };

        saveAccount(newAccount);

        // 1. Request a SERVER-GENERATED email verification code via the backend API. The client
        // never creates, sends, or stores the code — only the server knows it.
        setDemoCode(null);
        setDemoNoDelivery(false);
        try {
          const res = await fetch('/api/auth/send-2fa-code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: cleanEmail, name: newAccount.name })
          });
          await handleSend2faResponse(res, 'send');
        } catch (apiErr) {
          console.warn('API send-2fa-code note:', apiErr);
        }

        // Also register the profile in Firestore. Keyed by the Firebase UID
        // when Firebase signup created a user (migrating any legacy doc
        // first); local-only signups keep the synthetic id.
        if (firebaseUid) await migrateLegacyUserDoc(firebaseUid, cleanEmail);
        const userId = firebaseUid ?? deriveEmailUserId(cleanEmail);
        await syncUserProfile({
          id: userId,
          name: newAccount.name,
          email: newAccount.email,
          avatar: newAccount.avatar
        });
        await logUserActivity(userId, newAccount.name, newAccount.email, 'Account Created (Email Verification Code Dispatched to Email)');

        setEnteredOtp('');
        setOtpError(null);
        setResendCooldown(30);
        setVerificationPending(newAccount);
      } catch (err: any) {
        setErrorMessage(
          lang === 'bn'
            ? 'অ্যাকাউন্ট তৈরি করতে সমস্যা হয়েছে। অনুগ্রহ করে আবার চেষ্টা করুন।'
            : 'Failed to create account. Please try again.'
        );
      } finally {
        setLoading(false);
      }
    } else {
      // 2. Sign In Flow
      setLoading(true);
      const accounts = getRegisteredAccounts();
      const existing = accounts[cleanEmail];

      if (existing) {
        if (!existing.verified) {
          // If not verified, request a fresh SERVER-GENERATED email verification code so a
          // real email is sent and a server-side record exists.
          setDemoCode(null);
          setDemoNoDelivery(false);
          try {
            const res = await fetch('/api/auth/send-2fa-code', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email: cleanEmail, name: existing.name })
            });
            await handleSend2faResponse(res, 'send');
          } catch (e) {
            console.warn('API send-2fa-code note:', e);
          }

          setVerificationPending(existing);
          setEnteredOtp('');
          setOtpError(null);
          setResendCooldown(30);
          setLoading(false);
          return;
        }

        // Verify against the stored hash (PBKDF2, plus legacy sha256: /
        // insecure-fallback: values verify-only). A successful legacy-hash
        // sign-in is transparently re-hashed with PBKDF2. Legacy accounts
        // that still carry a plaintext `password` are verified once, then
        // transparently migrated to the hashed format and the plaintext
        // field is deleted.
        let passwordOk = false;
        if (existing.passwordHash) {
          passwordOk = await verifyPassword(password, existing.passwordHash);
          if (passwordOk && isLegacyPasswordHash(existing.passwordHash)) {
            existing.passwordHash = await hashPassword(password);
            saveAccount(existing);
          }
        } else if (existing.password !== undefined) {
          passwordOk = existing.password === password;
          if (passwordOk) {
            existing.passwordHash = await hashPassword(password);
            delete existing.password;
            saveAccount(existing);
          }
        }

        if (!passwordOk) {
          setErrorMessage(
            lang === 'bn'
              ? 'ভুল পাসওয়ার্ড। দয়া করে সঠিক পাসওয়ার্ড দিন।'
              : 'Incorrect password. Please enter the correct password.'
          );
          setLoading(false);
          return;
        }

        // Successfully logged in with registered account. The id is the
        // Firebase UID when a matching Firebase user exists, otherwise the
        // legacy synthetic id (purely local sign-in — unchanged behaviour).
        const resolvedId = await resolveAppUserId(cleanEmail);
        const appUser: User = {
          id: resolvedId,
          name: existing.name,
          email: existing.email,
          username: existing.username,
          avatar: existing.avatar,
          status: 'Available on Chitthi',
          online: true,
          presence: 'online',
          lastSeen: 'Active now',
          role: 'You'
        };

        await syncUserProfile({
          id: appUser.id,
          name: appUser.name,
          email: appUser.email || cleanEmail,
          avatar: appUser.avatar
        });
        await logUserActivity(appUser.id, appUser.name, cleanEmail, 'Email Sign-in');
        setLoading(false);
        onLogin(appUser);
      } else {
        // Try Firebase Authentication
        try {
          const cred = await signInWithEmailAndPassword(auth, cleanEmail, password);
          // Phase 0.9: copy any legacy user_<email> profile doc to the UID doc.
          await migrateLegacyUserDoc(cred.user.uid, cleanEmail);
          const appUser: User = {
            id: cred.user.uid,
            name: cred.user.displayName || cleanEmail.split('@')[0],
            email: cred.user.email || cleanEmail,
            avatar: cred.user.photoURL || selectedAvatar,
            status: 'Available on Chitthi',
            online: true,
            presence: 'online',
            lastSeen: 'Active now',
            role: 'You'
          };
          await syncUserProfile({
            id: appUser.id,
            name: appUser.name,
            email: appUser.email || cleanEmail,
            avatar: appUser.avatar
          });
          await logUserActivity(appUser.id, appUser.name, cleanEmail, 'Firebase Sign-in');
          setLoading(false);
          onLogin(appUser);
        } catch (_fbErr: any) {
          setLoading(false);
          setErrorMessage(
            lang === 'bn'
              ? 'এই ইমেইল দিয়ে কোনো অ্যাকাউন্ট পাওয়া যায়নি। অনুগ্রহ করে "ক্রিয়েট নিউ অ্যাকাউন্ট" এ ক্লিক করে নতুন অ্যাকাউন্ট খুলুন।'
              : 'No account found with this email. Please click "Create New Account" to register.'
          );
        }
      }
    }
  };

  // Paste the email verification code from the user's clipboard (copied from their real
  // email client). No auto-fill from local state — the user enters the code
  // they received in their inbox.
  const handlePasteCode = async () => {
    if (!verificationPending) return;
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        const digits = text.replace(/[^0-9]/g, '').slice(0, 6);
        if (digits) {
          setEnteredOtp(digits);
          setOtpError(null);
          return;
        }
      }
    } catch {
      // ignore clipboard permission error
    }
    setOtpError(
      lang === 'bn'
        ? 'ক্লিপবোর্ডে কোনো কোড পাওয়া যায়নি। অনুগ্রহ করে আপনার ইমেইল থেকে কোডটি কপি করে আবার চেষ্টা করুন।'
        : 'No code found in your clipboard. Please copy the code from your email and try again.'
    );
  };

  // Resend verification code — the server generates a fresh code each time; the client
  // never creates or sends one. Any stale client-side code is discarded.
  const handleResendCode = async () => {
    if (!verificationPending || resendCooldown > 0) return;
    setDemoCode(null);
    setDemoNoDelivery(false);
    const updatedAccount: StoredAccount = { ...verificationPending };
    saveAccount(updatedAccount);

    try {
      const res = await fetch('/api/auth/send-2fa-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: verificationPending.email,
          name: verificationPending.name
        })
      });
      await handleSend2faResponse(res, 'resend');
    } catch (e) {
      console.warn('API resend note:', e);
    }

    setVerificationPending(updatedAccount);
    setEnteredOtp('');
    setOtpError(null);
    setResendCooldown(30);
  };

  // Submit and verify the entered email verification code.
  // The code is verified ONLY against the server-side record — the server is
  // the sole authority (its burn/consume and attempt limits apply). There is
  // no Firestore leg, no local bypass: a locally stored code is never
  // accepted, and a network failure is reported honestly — never treated as
  // a silent pass.
  const handleVerifyOtpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!verificationPending) return;

    const trimmed = enteredOtp.trim().replace(/\s+/g, '');

    if (!trimmed) {
      setOtpError(
        lang === 'bn' ? 'অনুগ্রহ করে ৬-সংখ্যার কোডটি লিখুন বা পেস্ট করুন।' : 'Please enter or paste the 6-digit code.'
      );
      return;
    }

    setIsVerifying(true);
    setOtpError(null);

    // Validate with the backend API endpoint ONLY (server-generated codes,
    // server-side verdict). The error shown comes from the server's response.
    let apiValid = false;
    let serverError: string | null = null;
    let networkFailed = false;
    try {
      const res = await fetch('/api/auth/verify-2fa-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: verificationPending.email,
          code: trimmed
        })
      });
      const data = await res.json();
      if (data.valid) {
        apiValid = true;
      } else if (typeof data.error === 'string' && data.error.length > 0) {
        serverError = data.error;
      }
    } catch {
      networkFailed = true;
    }

    if (networkFailed) {
      setIsVerifying(false);
      setOtpError(
        lang === 'bn'
          ? 'সার্ভারের সাথে সংযোগ করা যায়নি। অনুগ্রহ করে ইন্টারনেট সংযোগ যাচাই করে আবার চেষ্টা করুন।'
          : 'Could not reach the verification server. Please check your connection and try again.'
      );
      return;
    }

    if (!apiValid) {
      setIsVerifying(false);
      setOtpError(
        serverError ||
          (lang === 'bn'
            ? 'ভুল ভেরিফিকেশন কোড। দয়া করে আপনার মেইলে পাঠানো সঠিক ৬-সংখ্যার কোডটি লিখুন।'
            : 'Invalid verification code. Please enter the correct 6-digit code sent to your email.')
      );
      return;
    }

    // Verify account and log in
    await executeAccountActivation(verificationPending);
  };

  // User activates account via email verification -> IMMEDIATELY LOGS IN!
  // The id is the Firebase UID when signup created a matching Firebase user
  // (still signed in at this point); otherwise the legacy synthetic id.
  const executeAccountActivation = async (account: StoredAccount) => {
    setIsVerifying(true);
    setOtpError(null);
    account.verified = true;
    saveAccount(account);

    const resolvedId = await resolveAppUserId(account.email);

    // Claim the sign-up @username on the server now that the account is
    // verified (Phase 1.4.1). Best-effort and silent: if the server is
    // unreachable or the handle was taken in the meantime, the account
    // simply starts without a username — it can be claimed later from
    // Profile settings or the post-login claim prompt.
    let claimedUsername: string | undefined;
    if (account.username) {
      try {
        const claim = await claimUsername(account.username);
        if (claim.ok) claimedUsername = account.username;
      } catch {
        /* silent — username is optional */
      }
    }

    const appUser: User = {
      id: resolvedId,
      name: account.name,
      email: account.email,
      username: claimedUsername,
      avatar: account.avatar,
      status: 'Available on Chitthi',
      online: true,
      presence: 'online',
      lastSeen: 'Active now',
      role: 'You'
    };

    try {
      await syncUserProfile({
        id: appUser.id,
        name: appUser.name,
        email: appUser.email || account.email,
        avatar: appUser.avatar,
        username: claimedUsername
      });
      void syncDirectoryProfile({
        name: appUser.name,
        avatar: appUser.avatar,
        mood: appUser.status
      });
      await logUserActivity(appUser.id, appUser.name, account.email, 'Email Verification Code Verified & Logged In');
    } catch (e) {
      console.warn('Firestore sync note:', e);
    }

    setSuccessMessage(
      lang === 'bn'
        ? `অভিনন্দন! আপনার অ্যাকাউন্ট (${account.email}) ভেরিফিকেশন কোড দিয়ে সফলভাবে ভেরিফাই হয়েছে।`
        : `Congratulations! Your account (${account.email}) is verified with your email verification code.`
    );

    setTimeout(() => {
      setIsVerifying(false);
      setVerificationPending(null);
      onLogin(appUser);
    }, 600);
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center p-4 bg-app text-app transition-colors duration-200 select-none relative">
      {/* Background Decorative Blobs */}
      <div className="absolute top-10 left-10 w-72 h-72 bg-[#0B6E4F]/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-10 right-10 w-72 h-72 bg-[#F2A007]/15 rounded-full blur-3xl pointer-events-none" />

      {/* Language Switcher in Top Right */}
      <div className="absolute top-5 right-5 z-20">
        <button
          type="button"
          onClick={toggleLanguage}
          className="flex items-center gap-1.5 px-3 py-1.5 min-h-[44px] rounded-full bg-app border border-token text-xs font-semibold text-app-2 hover:text-primary shadow-xs transition-all active:scale-95"
        >
          <Globe className="w-3.5 h-3.5" />
          <span>{lang === 'bn' ? 'English' : 'বাংলা'}</span>
        </button>
      </div>

      <div className="w-full max-w-md bg-surface border border-token rounded-[var(--r-card)] p-6 sm:p-8 shadow-soft relative z-10 transition-all">
        {/* Brand Header */}
        <div className="text-center mb-6">
          <div className="w-12 h-12 rounded-2xl bg-[#0B6E4F] text-white mx-auto flex items-center justify-center shadow-soft mb-3 animate-float-slow">
            <Mail className="w-6 h-6" />
          </div>
          <h1 className="text-2xl font-bold text-app flex items-center justify-center gap-2 bn-safe bn-text px-2 py-1.5" style={{ lineHeight: 1.5 }}>
            <span>চিঠি · Chitthi</span>
          </h1>
          <p className="text-xs text-app-2 mt-1">
            {isSignUp
              ? lang === 'bn'
                ? 'নতুন অ্যাকাউন্ট খুলে মেসেঞ্জারে যুক্ত হন'
                : 'Create an account to start messaging'
              : lang === 'bn'
              ? 'আপনার অ্যাকাউন্টে সাইন ইন করুন'
              : 'Sign in to access your conversations'}
          </p>
        </div>

        {/* Global Error Banner */}
        {errorMessage && (
          <div className="mb-4 p-3 rounded-2xl bg-app border border-token flex items-start gap-2.5 text-xs text-app animate-in fade-in">
            <AlertCircle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
            <div className="flex-1 font-medium leading-relaxed">{errorMessage}</div>
          </div>
        )}

        {/* Firebase Console guidance (Phase 4 decision: the operation-not-allowed
            help text was previously built into state and never rendered — it is
            wired into this alert banner so a stuck admin actually sees it). */}
        {firebaseConsoleNotice && (
          <div role="alert" className="mb-4 p-3 rounded-2xl bg-app border border-token flex items-start gap-2.5 text-xs text-app">
            <AlertCircle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
            <div className="flex-1 font-medium leading-relaxed">{firebaseConsoleNotice}</div>
          </div>
        )}

        {/* Success Banner */}
        {successMessage && (
          <div className="mb-4 p-3 rounded-2xl bg-app border border-token flex items-start gap-2.5 text-xs text-app animate-in fade-in">
            <CheckCircle2 className="w-4 h-4 text-online shrink-0 mt-0.5" />
            <div className="flex-1 font-medium leading-relaxed">{successMessage}</div>
          </div>
        )}

        {/* Google Sign-In Quick Action */}
        <button
          type="button"
          onClick={handleGoogleSignIn}
          disabled={loading}
          className="w-full py-2.5 px-4 min-h-[44px] bg-app hover:bg-bubble-in border border-token rounded-2xl text-xs font-semibold text-app flex items-center justify-center gap-2.5 transition-all shadow-xs active:scale-[0.99] disabled:opacity-50 mb-5"
        >
          <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24">
            <path
              fill="#4285F4"
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
            />
            <path
              fill="#34A853"
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            />
            <path
              fill="#FBBC05"
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
            />
            <path
              fill="#EA4335"
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
            />
          </svg>
          <span>{lang === 'bn' ? 'গুগল দিয়ে দ্রুত সাইন ইন' : 'Continue with Google'}</span>
        </button>

        {/* Divider */}
        <div className="flex items-center my-4">
          <div className="flex-1 border-t border-token" />
          <span className="px-3 text-[11px] font-semibold text-app-faint uppercase tracking-wider">
            {lang === 'bn' ? 'অথবা ইমেইল' : 'or email'}
          </span>
          <div className="flex-1 border-t border-token" />
        </div>

        {/* Email & Password Form */}
        <form onSubmit={handleSubmit} className="space-y-3.5">
          {/* Full Name for Registration */}
          {isSignUp && (
            <div className="animate-in fade-in space-y-1">
              <label className="block text-xs font-semibold text-app">
                {lang === 'bn' ? 'আপনার পুরো নাম' : 'Full Name'}
              </label>
              <div className="relative">
                <UserIcon className="w-4 h-4 text-app-faint absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={lang === 'bn' ? 'যেমন: মারুফ তালুকদার' : 'e.g. Alex Morgan'}
                  required={isSignUp}
                  className="w-full bg-app border border-transparent rounded-xl pl-9 pr-4 py-2.5 text-xs text-app placeholder:text-app-faint transition-all"
                 aria-label={lang === 'bn' ? 'আপনার পুরো নাম' : 'Full Name'} />
              </div>

              {/* Avatar Selector */}
              <div className="pt-2">
                <span className="block text-[11px] font-semibold text-app-2 mb-1.5">
                  {lang === 'bn' ? 'প্রোফাইল ছবি নির্বাচন করুন:' : 'Choose Profile Picture:'}
                </span>
                <div className="flex items-center gap-2 overflow-x-auto py-1">
                  {DEFAULT_AVATARS.map((url, i) => (
                    <img
                      key={i}
                      src={url}
                      alt="Avatar"
                      onClick={() => setSelectedAvatar(url)}
                      className={`w-9 h-9 rounded-full object-cover cursor-pointer transition-all ${
                        selectedAvatar === url
                          ? 'ring-2 ring-[var(--c-primary)] scale-105'
                          : 'opacity-70 hover:opacity-100 hover:scale-105'
                      }`}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Optional Username for Registration (Phase 1.4.1) */}
          {isSignUp && (
            <div className="animate-in fade-in space-y-1">
              <label className="block text-xs font-semibold text-app">
                {lang === 'bn' ? 'ইউজারনেম (ঐচ্ছিক)' : 'Username (optional)'}
              </label>
              <div className="flex items-center bg-app border border-transparent rounded-xl pl-3 pr-4 overflow-hidden transition-all">
                <span className="text-xs font-bold text-app-faint select-none">@</span>
                <input
                  type="text"
                  value={signupUsername}
                  onChange={(e) =>
                    setSignupUsername(
                      e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20)
                    )
                  }
                  placeholder="username"
                  maxLength={20}
                  className="flex-1 bg-transparent pl-1 pr-2 py-2.5 text-xs text-app placeholder:text-app-faint"
                 aria-label={lang === 'bn' ? 'ইউজারনেম (ঐচ্ছিক)' : 'Username (optional)'} />
                {signupUsernameCheck.kind === 'available' && (
                  <CheckCircle2 className="w-4 h-4 text-online shrink-0" />
                )}
                {(signupUsernameCheck.kind === 'unavailable' ||
                  signupUsernameCheck.kind === 'invalid') && (
                  <AlertCircle className="w-4 h-4 text-danger shrink-0" />
                )}
              </div>
              <UsernameCheckLine state={signupUsernameCheck} lang={lang} />
              <p className="text-[11px] text-app-faint">
                {lang === 'bn'
                  ? 'মানুষ @username দিয়ে আপনাকে খুঁজে পাবে — ইমেইল দেখাতে হবে না।'
                  : 'People can find you by @username — no email sharing needed.'}
              </p>
            </div>
          )}

          {/* Email Field */}
          <div className="space-y-1">
            <label className="block text-xs font-semibold text-app">
              {lang === 'bn' ? 'ইমেইল অ্যাড্রেস' : 'Email Address'}
            </label>
            <div className="relative">
              <Mail className="w-4 h-4 text-app-faint absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
                required
                className="w-full bg-app border border-transparent rounded-xl pl-9 pr-4 py-2.5 text-xs text-app placeholder:text-app-faint transition-all"
               aria-label={lang === 'bn' ? 'ইমেইল অ্যাড্রেস' : 'Email Address'} />
            </div>
          </div>

          {/* Password Field */}
          <div className="space-y-1">
            <label className="block text-xs font-semibold text-app">
              {lang === 'bn' ? 'পাসওয়ার্ড' : 'Password'}
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 text-app-faint absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                className="w-full bg-app border border-transparent rounded-xl pl-9 pr-10 py-2.5 text-xs text-app placeholder:text-app-faint transition-all"
               aria-label={lang === 'bn' ? 'পাসওয়ার্ড' : 'Password'} />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-app-faint hover:text-app"
               aria-label={showPassword ? (lang === 'bn' ? 'পাসওয়ার্ড লুকান' : 'Hide password') : (lang === 'bn' ? 'পাসওয়ার্ড দেখান' : 'Show password')} aria-pressed={showPassword} >
                {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>

          {/* Confirm Password Field for Sign Up */}
          {isSignUp && (
            <div className="animate-in fade-in space-y-1">
              <label className="block text-xs font-semibold text-app">
                {lang === 'bn' ? 'কনফার্ম পাসওয়ার্ড' : 'Confirm Password'}
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-app-faint absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type={showConfirmPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="••••••••"
                  required={isSignUp}
                  className={`w-full bg-app border rounded-xl pl-9 pr-10 py-2.5 text-xs text-app placeholder:text-app-faint transition-all ${
                    confirmPassword
                      ? password === confirmPassword
                        ? 'border-[var(--c-online)]'
                        : 'border-[var(--c-danger)]'
                      : 'border-transparent'
                  }`}
                 aria-label={lang === 'bn' ? 'কনফার্ম পাসওয়ার্ড' : 'Confirm Password'} />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-app-faint hover:text-app"
                 aria-label={showConfirmPassword ? (lang === 'bn' ? 'পাসওয়ার্ড লুকান' : 'Hide password') : (lang === 'bn' ? 'পাসওয়ার্ড দেখান' : 'Show password')} aria-pressed={showConfirmPassword} >
                  {showConfirmPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
          )}

          {/* Submit Button */}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 min-h-[44px] bg-[#0B6E4F] hover:bg-[#095C42] text-white font-bold text-xs sm:text-sm rounded-full shadow-soft transition-all flex items-center justify-center gap-2 hover:scale-[1.01] active:scale-[0.99] mt-3 disabled:opacity-50 cursor-pointer"
          >
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <>
                <span>
                  {isSignUp
                    ? lang === 'bn'
                      ? 'ক্রিয়েট নিউ অ্যাকাউন্ট'
                      : 'Create New Account'
                    : lang === 'bn'
                    ? 'সাইন ইন করুন'
                    : 'Sign In'}
                </span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>

        {/* Toggle Sign Up / Sign In */}
        <div className="text-center mt-5">
          <button
            type="button"
            onClick={() => {
              setIsSignUp(!isSignUp);
              setErrorMessage(null);
              setSuccessMessage(null);
            }}
            className="text-xs text-primary hover:underline font-semibold"
          >
            {isSignUp
              ? lang === 'bn'
                ? 'আগে থেকেই অ্যাকাউন্ট আছে? সাইন ইন করুন'
                : 'Already have an account? Sign in'
              : lang === 'bn'
              ? 'অ্যাকাউন্ট নেই? ক্রিয়েট নিউ অ্যাকাউন্ট'
              : "Don't have an account? Create new account"}
          </button>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 🔐 EMAIL VERIFICATION MODAL                                                  */}
      {/* (Verification code sent to the email and user pastes it to log in)          */}
      {/* ========================================================================= */}
      {verificationPending && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 animate-in fade-in select-none">
          <div className="bg-app border border-token rounded-[var(--r-card)] w-full max-w-lg p-6 sm:p-7 shadow-soft relative text-left space-y-4 animate-in zoom-in-95 duration-200 max-h-[92vh] overflow-y-auto" role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'ইমেইল ভেরিফিকেশন' : 'Email Verification'} >
            {/* Modal Header */}
            <div className="flex items-center gap-3 pb-2 border-b border-token">
              <div className="w-12 h-12 rounded-2xl bg-bubble-in text-primary flex items-center justify-center shrink-0 shadow-inner">
                <KeyRound className="w-6 h-6 animate-pulse" />
              </div>
              <div>
                <h3 className="text-base sm:text-lg font-bold text-app flex items-center gap-2 bn-safe bn-text">
                  <span>{lang === 'bn' ? 'ইমেইল ভেরিফিকেশন' : 'Email Verification'}</span>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-bubble-in text-online uppercase">
                    Security
                  </span>
                </h3>
                <p className="text-xs text-app-2 mt-0.5">
                  {lang === 'bn'
                    ? 'আপনার মেইলে পাঠানো ৬-সংখ্যার ভেরিফিকেশন কোডটি নিচে পেস্ট করে অ্যাকাউন্ট ওপেন করুন।'
                    : 'Paste the 6-digit verification code sent to your email to verify and log in.'}
                </p>
              </div>
            </div>

            {/* Email Dispatch Notice — the 6-digit code is delivered ONLY via the
                user's real inbox and is never displayed inside the app. */}
            <div className="p-4 rounded-2xl bg-surface border border-token space-y-2.5 shadow-xs">
              <div className="flex items-center justify-between text-[11px] text-app-2 border-b border-token pb-2">
                <div className="flex items-center gap-1.5 font-semibold text-app">
                  <Inbox className="w-3.5 h-3.5 text-primary" />
                  <span>ইমেইল ডেলিভারি: <strong className="text-primary">{verificationPending.email}</strong></span>
                </div>
                {demoCode || demoNoDelivery ? (
                  <span className="font-mono text-[10px] text-[#8A5A00] dark:text-[#F2A007] font-bold flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#F2A007]" />
                    {lang === 'bn' ? 'ডেমো — ইমেইল পাঠানো হয়নি' : 'Demo — no email sent'}
                  </span>
                ) : (
                  <span className="font-mono text-[10px] text-online font-bold flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-online animate-ping" />
                    {lang === 'bn' ? 'সদ্য প্রাপ্ত' : 'Delivered'}
                  </span>
                )}
              </div>

              <div>
                <p className="text-xs text-app">
                  {demoCode || demoNoDelivery
                    ? lang === 'bn'
                      ? demoCode
                        ? `প্রিয় ${verificationPending.name}, সার্ভারে ইমেইল সেটআপ নেই বলে কোনো ইমেইল পাঠানো হয়নি। নিচের ডেমো বাক্সের কোডটি ব্যবহার করুন।`
                        : `প্রিয় ${verificationPending.name}, সার্ভারে ইমেইল সেটআপ নেই বলে কোনো ইমেইল পাঠানো হয়নি। নিচের ডেমো নোটিশটি দেখুন।`
                      : demoCode
                      ? `Hi ${verificationPending.name}, email is not configured on the server, so no email was sent. Use the code shown in the demo box below.`
                      : `Hi ${verificationPending.name}, email is not configured on the server, so no email was sent. See the demo notice below.`
                    : lang === 'bn'
                    ? `প্রিয় ${verificationPending.name}, আপনার মেইলে একটি ৬-সংখ্যার ভেরিফিকেশন কোড পাঠানো হয়েছে। ইনবক্স (প্রয়োজনে স্প্যাম ফোল্ডার) থেকে কোডটি নিয়ে নিচে লিখুন বা পেস্ট করুন।`
                    : `Hi ${verificationPending.name}, a 6-digit verification code was sent to your email. Open your inbox (check spam too), then type or paste the code below.`}
                </p>
                {firebaseEmailSent && (
                  <p className="text-xs text-app-2">
                    {lang === 'bn'
                      ? 'ফায়ারবেসও এই ঠিকানায় একটি ভেরিফিকেশন ইমেইল পাঠিয়েছে।'
                      : 'Firebase also sent a verification email to this address.'}
                  </p>
                )}
              </div>
            </div>

            {/* DEMO MODE — shown ONLY when the server has no SMTP configured, so
                no real email was sent. The server returned the code for testing;
                it is never shown here when real email delivery is configured. */}
            {demoCode && (
              <div className="p-4 rounded-2xl bg-[#F2A007]/10 border-2 border-dashed border-[#F2A007]/50 space-y-1.5">
                <p className="text-xs font-bold text-[#8A5A00] dark:text-[#F2A007] uppercase tracking-wide">
                  ⚠️ {lang === 'bn' ? 'ডেমো মোড — ইমেইল কনফিগার করা নেই' : 'Demo Mode — email is not configured'}
                </p>
                <p className="text-xs text-app">
                  {lang === 'bn'
                    ? 'এই সার্ভারে SMTP সেট করা হয়নি, তাই আসল ইমেইল পাঠানো হয়নি। শুধু পরীক্ষার জন্য কোডটি এখানে দেওয়া হলো:'
                    : 'This server has no SMTP configured, so no real email was sent. Your test code is:'}
                </p>
                <p className="text-center font-mono text-3xl font-bold tracking-[0.3em] text-app select-all">
                  {demoCode}
                </p>
              </div>
            )}

            {/* DEMO MODE WITHOUT A DISCLOSED CODE — the server has no SMTP and
                did not return a demo code, so there is nothing in any inbox.
                Say so plainly instead of implying an email is on its way. */}
            {demoNoDelivery && !demoCode && (
              <div className="p-4 rounded-2xl bg-[#F2A007]/10 border-2 border-dashed border-[#F2A007]/50 space-y-1.5">
                <p className="text-xs font-bold text-[#8A5A00] dark:text-[#F2A007] uppercase tracking-wide">
                  ⚠️ {lang === 'bn' ? 'ডেমো মোড — ইমেইল কনফিগার করা নেই' : 'Demo Mode — email is not configured'}
                </p>
                <p className="text-xs text-app">
                  {lang === 'bn'
                    ? 'এই সার্ভারে SMTP সেট করা হয়নি, তাই কোনো ইমেইল পাঠানো হয়নি এবং এখানে কোনো কোডও দেওয়া হয়নি। সার্ভারে ইমেইল ডেলিভারি চালু করে আবার কোড পাঠান।'
                    : 'This server has no SMTP configured, so no email was sent and no code is available here. Ask the server operator to configure email delivery, then resend the code.'}
                </p>
              </div>
            )}

            {/* Error Message for OTP */}
            {otpError && (
              <div className="p-2.5 rounded-xl bg-surface border border-token text-xs text-danger flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{otpError}</span>
              </div>
            )}

            {/* Verification Code Input Form with Paste Button */}
            <form onSubmit={handleVerifyOtpSubmit} className="space-y-3 pt-1">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-bold text-app">
                    {lang === 'bn' ? '৬-সংখ্যার কোডটি লিখুন বা পেস্ট করুন:' : 'Enter or Paste 6-Digit Verification Code:'}
                  </label>
                  <button
                    type="button"
                    onClick={handlePasteCode}
                    className="text-xs text-primary hover:underline font-bold flex items-center gap-1 cursor-pointer"
                  >
                    <ClipboardPaste className="w-3.5 h-3.5" />
                    <span>{lang === 'bn' ? 'পেস্ট করুন (Paste)' : 'Paste Code'}</span>
                  </button>
                </div>

                <div className="relative">
                  <input
                    type="text"
                    maxLength={6}
                    value={enteredOtp}
                    onChange={(e) => {
                      setEnteredOtp(e.target.value.replace(/[^0-9]/g, ''));
                      setOtpError(null);
                    }}
                    placeholder="e.g. 592814"
                    autoFocus
                    required
                    className="w-full bg-surface border border-transparent rounded-2xl px-4 py-3 text-center text-xl sm:text-2xl font-mono font-bold tracking-widest text-app transition-all placeholder:text-app-faint placeholder:text-base placeholder:tracking-normal"
                   aria-label={lang === 'bn' ? 'ভেরিফিকেশন কোড' : 'Verification code'} />
                  {enteredOtp.length === 6 && (
                    <div className="absolute right-3 top-1/2 -translate-y-1/2 text-online">
                      <CheckCircle2 className="w-5 h-5" />
                    </div>
                  )}
                </div>
              </div>

              {/* Verify & Complete Login Button */}
              <button
                type="submit"
                disabled={isVerifying}
                className="w-full py-3 min-h-[44px] bg-[#0B6E4F] hover:bg-[#095C42] text-white font-bold text-xs sm:text-sm rounded-full shadow-soft transition-all flex items-center justify-center gap-2 active:scale-[0.99] disabled:opacity-50 cursor-pointer"
              >
                {isVerifying ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>{lang === 'bn' ? 'যাচাই করা হচ্ছে...' : 'Verifying Code...'}</span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-4 h-4" />
                    <span>{lang === 'bn' ? 'যাচাই করে লগইন সম্পন্ন করুন' : 'Verify & Complete Login'}</span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </form>

            {/* Resend code (code entry itself can no longer be bypassed) */}
            <div className="pt-2 border-t border-token flex items-center text-xs">
              <button
                type="button"
                onClick={handleResendCode}
                disabled={resendCooldown > 0}
                className="font-semibold text-app-2 hover:text-primary disabled:opacity-50 flex items-center gap-1 cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${resendCooldown > 0 ? 'animate-spin' : ''}`} />
                <span>
                  {resendCooldown > 0
                    ? `${lang === 'bn' ? 'পুনরায় পাঠান' : 'Resend in'} (${resendCooldown}s)`
                    : lang === 'bn'
                    ? 'আবার কোড পাঠান'
                    : 'Resend Code'}
                </span>
              </button>
            </div>

            {/* Cancel & Return to Login */}
            <div className="text-center pt-1">
              <button
                type="button"
                onClick={() => {
                  setVerificationPending(null);
                  setDemoCode(null);
                  setDemoNoDelivery(false);
                  setIsSignUp(false);
                }}
                className="text-xs text-app-faint hover:text-app"
              >
                {lang === 'bn' ? '← মেইল পরিবর্তন বা লগইন ফর্মে ফিরে যান' : '← Change email or back to login'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
