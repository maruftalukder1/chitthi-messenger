import React, { useState, useEffect } from 'react';
import { User } from '../types/chat';
import {
  auth,
  uploadAvatar,
  claimUsername,
  releaseUsername,
  syncDirectoryProfile,
  syncUserProfile,
  validateUsernameFormat,
  usernameProblemText
} from '../services/firebase';
import { initialsAvatarDataUrl } from '../utils/avatar';
import { useUsernameAvailability, UsernameCheckLine } from './usernameAvailability';
import { X, Check, Camera, Trash2, AlertCircle, Loader2 } from 'lucide-react';

interface UserProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: User;
  onSave: (updated: Partial<User> & { about?: string }) => void | Promise<void>;
  lang: 'bn' | 'en';
}

// The User type predates the About split (Phase 1.4.5); about rides along
// as an optional extra field until the shared type grows it.
type UserWithAbout = User & { about?: string };

const CLEAN_AVATAR_OPTIONS = [
  'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=200&q=80',
  'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=200&q=80',
  'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=200&q=80',
  'https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=200&q=80',
  'https://images.unsplash.com/photo-1522075469751-3a6694fb2f61?auto=format&fit=crop&w=200&q=80',
  'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=200&q=80'
];

// Custom-photo limits (Phase 0.9 avatar pipeline): reject inputs over 5 MB,
// centre-crop to a square and downscale to 512x512 JPEG before anything is
// stored, so a multi-MB phone photo can never land raw in localStorage or in
// the Firestore profile doc.
const MAX_AVATAR_INPUT_BYTES = 5 * 1024 * 1024;
const AVATAR_OUTPUT_SIZE = 512;

// The initials avatar shown when a user removes their photo comes from the
// shared generator in utils/avatar.ts (Phase 4 consolidation).

export const UserProfileModal: React.FC<UserProfileModalProps> = ({
  isOpen,
  onClose,
  currentUser,
  onSave,
  lang,
}) => {
  const [name, setName] = useState(currentUser.name);
  const [username, setUsername] = useState(currentUser.username || '');
  const [status, setStatus] = useState(currentUser.status);
  // About (Phase 1.4.5): multi-line bio, separate from the one-line mood.
  // First load migration: a user-written legacy `status` becomes the About
  // (factory defaults like "Available on Chitthi" are not migrated).
  const initialAbout = (): string => {
    const existing = (currentUser as UserWithAbout).about;
    if (existing && existing.trim()) return existing;
    const legacy = (currentUser.status || '').trim();
    if (legacy && legacy !== 'Available' && legacy !== 'Available on Chitthi') return legacy;
    return '';
  };
  const [about, setAbout] = useState<string>(initialAbout);
  const [avatar, setAvatar] = useState(currentUser.avatar);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [isProcessingPhoto, setIsProcessingPhoto] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Re-sync the form from the profile every time the modal opens, so an
  // externally-updated profile (or the About migration) is what gets edited.
  useEffect(() => {
    if (!isOpen) return;
    setName(currentUser.name);
    setUsername(currentUser.username || '');
    setStatus(currentUser.status);
    setAbout(initialAbout());
    setAvatar(currentUser.avatar);
    setPhotoError(null);
    setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Live availability (debounced) — only while the field differs from the
  // username the user already owns.
  const usernameChanged =
    username.trim().toLowerCase() !== (currentUser.username || '').toLowerCase();
  const usernameCheck = useUsernameAvailability(username, usernameChanged && !!username.trim());

  // Sanitize (contract v2): lowercase letters, digits, underscore — dots are
  // dropped entirely (kills www./.com impersonation), max 20 chars.
  const handleUsernameChange = (value: string) => {
    setUsername(value.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20));
    setSaveError(null);
  };

  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  if (!isOpen) return null;

  // Custom photo: validate (<= 5 MB) -> centre-crop square -> resize to
  // 512x512 -> JPEG compress -> upload to Firebase Storage when a Firebase
  // user exists. Fallback (no Firebase user, or Storage fails): keep the
  // small resized data-URL instead of the raw multi-MB original.
  const handleCustomPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so picking the same file again still fires onChange.
    e.target.value = '';
    if (!file) return;

    if (file.size > MAX_AVATAR_INPUT_BYTES) {
      setPhotoError(
        lang === 'bn'
          ? 'ছবিটি ৫ MB এর চেয়ে বড়। অনুগ্রহ করে ছোট একটি ছবি নির্বাচন করুন।'
          : 'That photo is larger than 5 MB. Please choose a smaller photo.'
      );
      return;
    }

    setPhotoError(null);
    setIsProcessingPhoto(true);
    try {
      const objectUrl = URL.createObjectURL(file);
      try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const el = new Image();
          el.onload = () => resolve(el);
          el.onerror = () => reject(new Error('image decode failed'));
          el.src = objectUrl;
        });
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        const sx = (img.naturalWidth - side) / 2;
        const sy = (img.naturalHeight - side) / 2;
        const canvas = document.createElement('canvas');
        canvas.width = AVATAR_OUTPUT_SIZE;
        canvas.height = AVATAR_OUTPUT_SIZE;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('canvas unavailable');
        ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE);
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/jpeg', 0.85)
        );
        if (!blob) throw new Error('image encode failed');

        const fbUser = auth.currentUser;
        if (fbUser) {
          try {
            const downloadUrl = await uploadAvatar(fbUser.uid, blob);
            setAvatar(downloadUrl);
            return;
          } catch (uploadErr) {
            console.warn('Avatar upload failed, keeping resized local copy:', uploadErr);
          }
        }
        setAvatar(canvas.toDataURL('image/jpeg', 0.85));
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    } catch {
      setPhotoError(
        lang === 'bn'
          ? 'ছবিটি প্রসেস করা যায়নি। অনুগ্রহ করে অন্য একটি ছবি চেষ্টা করুন।'
          : 'Could not process that photo. Please try a different photo.'
      );
    } finally {
      setIsProcessingPhoto(false);
    }
  };

  // Remove photo: revert to the initials avatar.
  const handleRemovePhoto = () => {
    setPhotoError(null);
    setAvatar(initialsAvatarDataUrl(name || currentUser.name));
  };

  // Save is FAIL-CLOSED on username changes (Phase 1.4.1): a changed handle
  // is claimed on the server FIRST (atomic claim endpoint) and any failure —
  // taken, reserved, format, offline — blocks the whole save with a visible
  // error. Nothing is applied locally on an unverified claim. (This replaces
  // the old post-save Firestore check in App.tsx whose catch applied the
  // change anyway — see the coordinator wiring notes.)
  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || isSaving) return;
    setSaveError(null);

    const nextUsername = username.trim().toLowerCase();
    const prevUsername = (currentUser.username || '').toLowerCase();
    const trimmedAbout = about.trim();
    const trimmedStatus = status.trim() || 'Available';

    setIsSaving(true);
    try {
      if (nextUsername !== prevUsername) {
        if (nextUsername) {
          const problem = validateUsernameFormat(nextUsername);
          if (problem) {
            setSaveError(usernameProblemText(problem, lang));
            return;
          }
          const claim = await claimUsername(nextUsername);
          if (!claim.ok) {
            setSaveError(
              lang === 'bn'
                ? `ইউজারনেম বদলানো যায়নি: ${usernameProblemText(claim.reason, lang)}`
                : `Username not changed: ${usernameProblemText(claim.reason, lang)}`
            );
            return;
          }
        } else {
          const released = await releaseUsername();
          if (!released) {
            setSaveError(
              lang === 'bn'
                ? 'ইউজারনেম ছাড়া যায়নি — সার্ভারে পৌঁছানো যাচ্ছে না। আবার চেষ্টা করুন।'
                : 'Could not release your username — the server could not be reached. Please try again.'
            );
            return;
          }
        }
      }

      await onSave({
        name: name.trim(),
        username: nextUsername || undefined,
        status: trimmedStatus,
        avatar,
        about: trimmedAbout,
      });

      // Server directory + Firestore profile carry About/mood/privacy too
      // (best-effort; the local save above already succeeded).
      void syncUserProfile({
        id: currentUser.id,
        name: name.trim(),
        email: currentUser.email || '',
        avatar,
        username: nextUsername !== prevUsername ? nextUsername : nextUsername || undefined,
        status: trimmedStatus,
        about: trimmedAbout,
      });
      void syncDirectoryProfile({
        name: name.trim(),
        avatar,
        about: trimmedAbout,
        mood: trimmedStatus,
      });

      onClose();
    } finally {
      setIsSaving(false);
    }
  };

  const inputClass =
    'w-full rounded-[var(--r-control)] bg-surface px-3.5 py-2.5 text-sm text-app placeholder:text-app-faint border border-transparent transition-colors';

  return (
    <div className="fixed inset-0 z-50 bg-black/60  flex items-center justify-center p-4 animate-in fade-in select-none">
      <div className="glass-sheet rounded-[var(--r-sheet)] w-full max-w-md overflow-hidden shadow-soft text-app transition-[opacity,transform] [transition-duration:var(--dur-sheet)] [transition-timing-function:var(--ease-spring)] max-h-[92vh] overflow-y-auto" role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'প্রোফাইল সম্পাদনা' : 'Edit profile'} >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-token ">
          <h3 className="text-base font-bold text-app">
            {lang === 'bn' ? 'প্রোফাইল সেটিংস' : 'Edit Profile'}
          </h3>
          <button
            onClick={onClose}
            className="min-w-[44px] min-h-[44px] flex items-center justify-center text-app-faint hover:text-app rounded-lg transition-colors"
           aria-label={lang === 'bn' ? 'বন্ধ করুন' : 'Close'} >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSave} className="p-6 space-y-5">
          {/* Profile header + avatar selector */}
          <div className="flex flex-col items-center text-center gap-3">
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleCustomPhoto}
              accept="image/*"
              className="hidden"
            />
            <div className="relative group">
              <img
                src={avatar}
                alt={name}
                className="w-24 h-24 rounded-full bg-surface object-cover ring-4 ring-[#0B6E4F]"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="absolute bottom-0 right-0 w-9 h-9 flex items-center justify-center bg-[#0B6E4F] hover:bg-[#095C42] text-white rounded-full shadow-md transition-colors"
                title="Upload Photo"
               aria-label={lang === 'bn' ? 'প্রোফাইল ছবি বদলান' : 'Change profile photo'} >
                <Camera className="w-4 h-4" />
              </button>
            </div>

            {/* Identity preview — reflects the live edits below */}
            <div className="min-w-0">
              <p className="text-xl font-bold text-app truncate bn-safe bn-text">{name || currentUser.name}</p>
              {username && <p className="text-sm text-app-2 truncate mt-0.5">@{username}</p>}
              <p className="text-xs text-app-2 truncate mt-1 bn-safe bn-text">{status}</p>
            </div>

            {/* Clean Avatar Presets without weird words */}
            <div className="flex items-center gap-2 justify-center pt-1">
              {CLEAN_AVATAR_OPTIONS.map((picUrl, idx) => (
                <img
                  key={idx}
                  src={picUrl}
                  alt={`Preset ${idx + 1}`}
                  onClick={() => {
                    setPhotoError(null);
                    setAvatar(picUrl);
                  }}
                  className={`w-8 h-8 rounded-full object-cover cursor-pointer transition-[transform,opacity] [transition-duration:var(--dur-press)] [transition-timing-function:var(--ease-spring)] ${
                    avatar === picUrl
                      ? 'ring-2 ring-[#0B6E4F] scale-105'
                      : 'opacity-60 hover:opacity-100'
                  }`}
                />
              ))}
            </div>

            {/* Remove photo -> back to the initials avatar */}
            <div className="flex items-center justify-center gap-3 pt-1">
              <button
                type="button"
                onClick={handleRemovePhoto}
                disabled={isProcessingPhoto}
                className="flex items-center gap-1 text-xs font-semibold text-danger  hover:underline disabled:opacity-50 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>{lang === 'bn' ? 'ছবি সরান' : 'Remove photo'}</span>
              </button>
              {isProcessingPhoto && (
                <span className="flex items-center gap-1 text-xs text-app-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>{lang === 'bn' ? 'ছবি প্রসেস হচ্ছে...' : 'Processing photo...'}</span>
                </span>
              )}
            </div>

            {photoError && (
              <div className="w-full p-2.5 rounded-xl bg-surface  border border-token  text-xs text-danger  flex items-center gap-2 text-left">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{photoError}</span>
              </div>
            )}
          </div>

          {/* Name input */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-app">
              {lang === 'bn' ? 'ইউজার নাম' : 'Display Name'}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
              required
             aria-label={lang === 'bn' ? 'ইউজার নাম' : 'Display Name'} />
          </div>

          {/* Username input */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-app">
              {lang === 'bn' ? 'ইউজারনেম' : 'Username'}
            </label>
            <div className="flex items-center rounded-[var(--r-control)] bg-surface px-3.5 border border-transparent overflow-hidden transition-colors">
              <span className="text-sm font-bold text-app-faint select-none">@</span>
              <input
                type="text"
                value={username}
                onChange={(e) => handleUsernameChange(e.target.value)}
                placeholder="username"
                maxLength={20}
                className="flex-1 bg-transparent px-1 py-2.5 text-sm text-app placeholder:text-app-faint "
               aria-label={lang === 'bn' ? 'ইউজারনেম' : 'Username'} />
            </div>
            <UsernameCheckLine state={usernameCheck} lang={lang} />
            <p className="text-[11px] text-app-faint">
              {lang === 'bn'
                ? 'মানুষ @username দিয়ে আপনাকে খুঁজে পাবে। ৫–২০ অক্ষর, অক্ষর দিয়ে শুরু।'
                : 'People can find you by @username. 5–20 characters, starting with a letter.'}
            </p>
          </div>

          {/* Mood: one-line status */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-app">
              {lang === 'bn' ? 'স্ট্যাটাস / মুড' : 'Status / Mood'}
            </label>
            <input
              type="text"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className={inputClass}
              placeholder="e.g. Available, In a meeting..."
              maxLength={60}
             aria-label={lang === 'bn' ? 'স্ট্যাটাস / মুড' : 'Status / Mood'} />
          </div>

          {/* About: multi-line bio (Phase 1.4.5), 160 chars, linkified wherever displayed */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-app">
                {lang === 'bn' ? 'সম্পর্কে (About)' : 'About'}
              </label>
              <span className="text-[10px] text-app-faint">{about.length}/160</span>
            </div>
            <textarea
              value={about}
              onChange={(e) => setAbout(e.target.value.slice(0, 160))}
              className={`${inputClass} resize-none`}
              placeholder={
                lang === 'bn'
                  ? 'নিজের সম্পর্কে কিছু লিখুন...'
                  : 'Write a little about yourself...'
              }
              rows={3}
              maxLength={160}
             aria-label={lang === 'bn' ? 'সম্পর্কে (About)' : 'About'} />
          </div>

          {saveError && (
            <div className="p-2.5 rounded-xl bg-surface  border border-token  text-xs text-danger  flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{saveError}</span>
            </div>
          )}

          <div className="pt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isSaving}
              className="px-4 py-2 text-xs font-semibold text-app-2 hover:text-app rounded-full transition-colors disabled:opacity-50"
            >
              {lang === 'bn' ? 'বাতিল' : 'Cancel'}
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="flex items-center gap-1.5 px-5 py-2 bg-[#0B6E4F] hover:bg-[#095C42] text-white rounded-full text-xs font-bold shadow-md  transition-colors disabled:opacity-50"
            >
              {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              <span>{lang === 'bn' ? 'সংরক্ষণ' : 'Save Changes'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
