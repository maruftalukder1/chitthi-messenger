import React from 'react';
import { MessageSquare, Phone, User as UserIcon } from 'lucide-react';

export type ScreenTab = 'chats' | 'calls' | 'settings';

interface BottomNavProps {
  activeTab: ScreenTab;
  onTabChange: (tab: ScreenTab) => void;
  unreadCount?: number;
  lang?: 'bn' | 'en';
}

export const BottomNav: React.FC<BottomNavProps> = ({
  activeTab,
  onTabChange,
  unreadCount = 5,
  lang = 'en',
}) => {
  // Phase 2: tab press is a spring micro-interaction — scale .96 over
  // var(--dur-press) on var(--ease-spring); never animate blur. Touch
  // targets stay ≥44px (min-h/min-w 44px, width floor via min-w-14).
  const itemCls = (active: boolean) =>
    `relative p-2 rounded-2xl flex flex-col items-center justify-center gap-0.5 min-w-14 min-h-11 min-h-[44px] transition-transform [transition-duration:var(--dur-press)] [transition-timing-function:var(--ease-spring)] active:scale-[0.96] ${
      active
        ? 'text-primary scale-105'
        : 'text-app-faint hover:text-app-2'
    }`;
  // bn-safe: labels are Bangla-bearing (চ্যাট / হিস্ট্রি / কল …) — the old
  // leading-none clipped matras the same way ChatsScreen rows did.
  const labelCls = (active: boolean) =>
    `text-[10px] bn-safe ${active ? 'font-semibold' : 'font-medium'}`;
  const iconCls = (active: boolean) => `w-5 h-5 ${active ? 'fill-current' : ''}`;

  return (
    <nav aria-label={lang === 'bn' ? 'প্রধান নেভিগেশন' : 'Main navigation'} className="mx-3 mb-3 min-h-16 rounded-[var(--r-pill)] glass-pill safe-pb px-2 flex items-center justify-around shrink-0 select-none z-20">
      {/* 1. Chats Tab */}
      <button onClick={() => onTabChange('chats')} className={itemCls(activeTab === 'chats')} title="Recent Chats" aria-label="Recent Chats" aria-current={activeTab === 'chats' ? 'page' : undefined}>
        <MessageSquare className={iconCls(activeTab === 'chats')} />
        <span className={labelCls(activeTab === 'chats')}>{lang === 'bn' ? 'চ্যাট' : 'Chats'}</span>
        {unreadCount > 0 && activeTab !== 'chats' && (
          <span className="absolute top-1 right-2 w-2 h-2 rounded-full bg-[#F2A007] animate-pulse" />
        )}
      </button>

      {/* 2. Calls / Dial Tab */}
      <button onClick={() => onTabChange('calls')} className={itemCls(activeTab === 'calls')} title="Calls" aria-label="Calls" aria-current={activeTab === 'calls' ? 'page' : undefined}>
        <Phone className={iconCls(activeTab === 'calls')} />
        <span className={labelCls(activeTab === 'calls')}>{lang === 'bn' ? 'কল' : 'Calls'}</span>
      </button>

      {/* 3. Settings / Profile Tab */}
      <button onClick={() => onTabChange('settings')} className={itemCls(activeTab === 'settings')} title="Settings" aria-label="Settings" aria-current={activeTab === 'settings' ? 'page' : undefined}>
        <UserIcon className={iconCls(activeTab === 'settings')} />
        <span className={labelCls(activeTab === 'settings')}>{lang === 'bn' ? 'প্রোফাইল' : 'Profile'}</span>
      </button>
    </nav>
  );
};
