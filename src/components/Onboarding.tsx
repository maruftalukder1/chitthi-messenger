import React, { useEffect, useState } from 'react';
import {
  MessageCircle,
  Phone,
  Sparkles,
  ShieldCheck,
  Ban,
  Eye,
  Info,
  AtSign,
  ChevronLeft,
  ChevronRight,
  Check,
} from 'lucide-react';

/**
 * Phase 2 — 3-screen first-run onboarding.
 *
 * Purely presentational: it owns NO storage and NO navigation state
 * outside its own step index. App.tsx decides when it is shown (the
 * per-user `chitthi_onboarded_v1_<userId>` flag) and what finishing
 * means (set the flag; "Choose username" also opens the existing
 * ClaimUsernameModal). Esc is the skip path — it calls onFinish,
 * exactly like the Skip button on the last screen.
 *
 * One `.glass-sheet` surface for the whole flow (one glass surface in
 * this viewport, per the Phase 2 performance law). Copy is bilingual:
 * English primary, Bangla secondary with `.bn-safe` matra headroom.
 */
export interface OnboardingProps {
  onFinish: () => void;
  onChooseUsername: () => void;
}

interface OnboardingFeature {
  icon: React.ReactNode;
  en: string;
  bn: string;
}

interface OnboardingScreen {
  icon: React.ReactNode;
  titleEn: string;
  titleBn: string;
  bodyEn: string;
  bodyBn: string;
  features: OnboardingFeature[];
}

const iconProps = { strokeWidth: 2 } as const;

const SCREENS: OnboardingScreen[] = [
  {
    icon: <Sparkles className="w-7 h-7" {...iconProps} />,
    titleEn: 'Welcome to চিঠি · Chitthi',
    titleBn: 'চিঠিতে স্বাগতম',
    bodyEn: 'Chats, calls and stories with the people who matter — all in one place.',
    bodyBn: 'প্রিয় মানুষদের সঙ্গে চ্যাট, কল আর স্টোরি — সব এক জায়গায়।',
    features: [
      {
        icon: <MessageCircle className="w-5 h-5" {...iconProps} />,
        en: 'Fast chats, groups, polls, stickers and scheduled messages',
        bn: 'দ্রুত চ্যাট, গ্রুপ, পোল, স্টিকার আর নির্ধারিত মেসেজ',
      },
      {
        icon: <Phone className="w-5 h-5" {...iconProps} />,
        en: 'Voice and video calls, with screen sharing',
        bn: 'ভয়েস ও ভিডিও কল, স্ক্রিন শেয়ারিংসহ',
      },
      {
        icon: <Sparkles className="w-5 h-5" {...iconProps} />,
        en: 'Stories that disappear in 24 hours',
        bn: 'স্টোরি, যা ২৪ ঘণ্টায় মুছে যায়',
      },
    ],
  },
  {
    icon: <ShieldCheck className="w-7 h-7" {...iconProps} />,
    titleEn: 'Your privacy, your controls',
    titleBn: 'আপনার প্রাইভেসি, আপনার নিয়ন্ত্রণে',
    bodyEn: 'You decide who can reach you and what they can see.',
    bodyBn: 'কে আপনার সঙ্গে যোগাযোগ করতে পারবে আর কী দেখতে পারবে — সিদ্ধান্ত আপনার।',
    features: [
      {
        icon: <Ban className="w-5 h-5" {...iconProps} />,
        en: 'Block or report anyone, any time, from their profile',
        bn: 'যেকোনো সময় প্রোফাইল থেকে ব্লক বা রিপোর্ট করুন',
      },
      {
        icon: <Eye className="w-5 h-5" {...iconProps} />,
        en: 'Privacy audiences for your profile, stories and last seen',
        bn: 'প্রোফাইল, স্টোরি আর লাস্ট সিনের জন্য প্রাইভেসি অডিয়েন্স',
      },
      {
        icon: <Info className="w-5 h-5" {...iconProps} />,
        en: 'Honest note: Chitthi is not end-to-end encrypted yet — please do not share passwords or financial details in chats.',
        bn: 'সৎ নোট: চিঠি এখনো এন্ড-টু-এন্ড এনক্রিপ্টেড নয় — চ্যাটে পাসওয়ার্ড বা আর্থিক তথ্য শেয়ার করবেন না।',
      },
    ],
  },
  {
    icon: <AtSign className="w-7 h-7" {...iconProps} />,
    titleEn: 'Pick your @username',
    titleBn: 'আপনার @username বেছে নিন',
    bodyEn:
      'A username lets people find and message you without ever seeing your email address or phone number. It is unique to you, and you can change it later in Profile settings.',
    bodyBn:
      'ইউজারনেম থাকলে মানুষ আপনার ইমেইল বা ফোন নম্বর না জেনেই আপনাকে খুঁজে পাবে। এটি শুধু আপনারই, পরে প্রোফাইল সেটিংস থেকে বদলাতেও পারবেন।',
    features: [],
  },
];

export const Onboarding: React.FC<OnboardingProps> = ({ onFinish, onChooseUsername }) => {
  const [step, setStep] = useState(0);
  const isLast = step === SCREENS.length - 1;
  const screen = SCREENS[step];

  // Esc = skip path (same as finishing without choosing a username).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onFinish();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onFinish]);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4 animate-in fade-in select-none">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Welcome to Chitthi — getting started"
        className="glass-sheet w-full max-w-md overflow-hidden text-app animate-in zoom-in-95"
        style={{ animationDuration: 'var(--dur-sheet)', animationTimingFunction: 'var(--ease-spring)' }}
      >
        <div className="p-6 sm:p-7 flex flex-col gap-5">
          {/* Screen body — keyed so each step springs in. */}
          <div
            key={step}
            className="flex flex-col gap-5 animate-in fade-in slide-in-from-right-2"
            style={{ animationDuration: 'var(--dur-sheet)', animationTimingFunction: 'var(--ease-spring)' }}
          >
            <div className="flex flex-col items-center text-center gap-2">
              <span className="w-14 h-14 rounded-[var(--r-control)] bg-brand-gradient text-white flex items-center justify-center shrink-0">
                {screen.icon}
              </span>
              <h2 className="text-xl font-bold text-app bn-safe">{screen.titleEn}</h2>
              <p className="text-sm font-semibold text-app-2 bn-safe">{screen.titleBn}</p>
              <p className="text-sm text-app-2 leading-relaxed">{screen.bodyEn}</p>
              <p className="text-xs text-app-faint leading-relaxed bn-safe">{screen.bodyBn}</p>
            </div>

            {screen.features.length > 0 && (
              <ul className="flex flex-col gap-3">
                {screen.features.map((f, i) => (
                  <li key={i} className="flex items-start gap-3">
                    <span className="w-11 h-11 rounded-[var(--r-control)] bg-bubble-in text-primary flex items-center justify-center shrink-0">
                      {f.icon}
                    </span>
                    <span className="flex-1 min-w-0 pt-0.5">
                      <span className="block text-sm font-medium text-app leading-snug">{f.en}</span>
                      <span className="block text-xs text-app-faint leading-snug bn-safe">{f.bn}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Dots */}
          <div className="flex items-center justify-center gap-2" role="tablist" aria-label="Onboarding progress">
            {SCREENS.map((s, i) => (
              <button
                key={i}
                type="button"
                role="tab"
                aria-selected={i === step}
                aria-label={`Step ${i + 1} of ${SCREENS.length}: ${s.titleEn}`}
                onClick={() => setStep(i)}
                className="min-w-11 min-h-11 flex items-center justify-center"
              >
                <span
                  className={`block h-2 rounded-[var(--r-pill)] transition-all [transition-duration:var(--dur-sheet)] [transition-timing-function:var(--ease-spring)] ${
                    i === step ? 'w-6 bg-primary' : 'w-2 bg-pressed'
                  }`}
                />
              </button>
            ))}
          </div>

          {/* Navigation */}
          {!isLast ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setStep((s) => Math.max(0, s - 1))}
                disabled={step === 0}
                className="min-h-11 px-4 rounded-[var(--r-pill)] bg-bubble-in text-app-2 text-sm font-semibold flex items-center gap-1 whitespace-nowrap transition-transform [transition-duration:var(--dur-press)] [transition-timing-function:var(--ease-spring)] active:scale-95 disabled:opacity-40"
              >
                <ChevronLeft className="w-4 h-4" {...iconProps} />
                Back
              </button>
              <button
                type="button"
                onClick={onFinish}
                className="min-h-11 px-4 rounded-[var(--r-pill)] text-app-faint text-sm font-semibold whitespace-nowrap shrink-0 transition-transform [transition-duration:var(--dur-press)] [transition-timing-function:var(--ease-spring)] active:scale-95"
              >
                Skip
              </button>
              <button
                type="button"
                onClick={() => setStep((s) => Math.min(SCREENS.length - 1, s + 1))}
                className="flex-1 min-h-11 px-5 rounded-[var(--r-pill)] bg-primary text-white text-sm font-bold flex items-center justify-center gap-1 whitespace-nowrap transition-transform [transition-duration:var(--dur-press)] [transition-timing-function:var(--ease-spring)] active:scale-95"
              >
                Next
                <span className="bn-safe">· পরেরটি</span>
                <ChevronRight className="w-4 h-4" {...iconProps} />
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={onChooseUsername}
                className="w-full min-h-11 px-5 rounded-[var(--r-pill)] bg-brand-gradient text-white text-sm font-bold flex items-center justify-center gap-2 whitespace-nowrap transition-transform [transition-duration:var(--dur-press)] [transition-timing-function:var(--ease-spring)] active:scale-95"
              >
                <AtSign className="w-4 h-4" {...iconProps} />
                Choose username
                <span className="bn-safe">· ইউজারনেম বেছে নিন</span>
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setStep((s) => Math.max(0, s - 1))}
                  className="min-h-11 px-4 rounded-[var(--r-pill)] bg-bubble-in text-app-2 text-sm font-semibold flex items-center gap-1 whitespace-nowrap transition-transform [transition-duration:var(--dur-press)] [transition-timing-function:var(--ease-spring)] active:scale-95"
                >
                  <ChevronLeft className="w-4 h-4" {...iconProps} />
                  Back
                </button>
                <button
                  type="button"
                  onClick={onFinish}
                  className="flex-1 min-h-11 px-5 rounded-[var(--r-pill)] text-app-2 text-sm font-semibold flex items-center justify-center gap-1 whitespace-nowrap transition-transform [transition-duration:var(--dur-press)] [transition-timing-function:var(--ease-spring)] active:scale-95"
                >
                  <Check className="w-4 h-4" {...iconProps} />
                  Skip for now
                  <span className="bn-safe">· এখন নয়</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Onboarding;
