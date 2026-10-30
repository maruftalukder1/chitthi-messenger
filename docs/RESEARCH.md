# PulseChat / Chithi — Messenger Research, 18 Oct 2026

Research for rebuilding PulseChat as a professional, "million-dollar-app" level messenger that
combines the flagship strengths of **WhatsApp + Discord + Telegram**. All claims below are grounded
in the sources actually opened (listed at the end); where a claim is my inference from the sources,
it is marked **[inference]**.

## Part 1 — WhatsApp: what users expect (2026)

- **Message basics are non-negotiable.** Users expect the full message lifecycle: send ticks
  (clock → single tick → double tick → double *blue* tick for read), swipe/long-press **reply with
  quote preview**, **edit** (WhatsApp: 15 minutes after sending), **delete for everyone** (WhatsApp
  Help Center: two days; recipients see a "This message was deleted" placeholder), and **forward**.
  (Sources: messengerbot.app, aeanet.org, getkanal.com, gbyte.com)
- **Reactions** are now standard UI: any-emoji reactions, shown under the bubble; WhatsApp is even
  expanding reactions to wearables. (Source: wabetainfo.com)
- **Polls with controls**: deadlines that auto-close voting, anonymous voting, poll question editable
  within 15 minutes of posting. (Sources: themunicheye.com, indiatvnews.com, 91mobiles.com)
- **Group organization**: @all mentions (admin-only in groups >32 members, bypasses mute but can be
  disabled by recipients), pinned events with RSVPs, live-location sharing, spin-off sub-groups from
  an existing group. (Sources: themunicheye.com, moneycontrol.com, indiatvnews.com)
- **Status/stories**: photos, videos, GIFs, music stickers, auto-saved drafts, view-once media —
  WhatsApp's Updates tab serves 1.5B people/day. (Sources: gadgets360.com, top10-best.com,
  dedontech.blogspot.com)
- **Voice-first features**: voice notes, tap-to-voice chat rooms that work on slow networks, offline
  voice-to-text dictation via downloaded language packs. (Sources: dedontech.blogspot.com,
  wabetainfo.com)
- **Privacy controls users check for**: E2E encrypted by default, encrypted backups, read-receipt
  toggle (note: disabling it is reciprocal — you also lose others' receipts), last-seen/profile
  visibility, two-step verification. (Sources: flozic.ai, capgo.app, techsith.com, aeanet.org)
- **Identity beyond phone numbers**: WhatsApp is rolling out username reservation — users want to chat
  without sharing their number. (Sources: grabon.in, zoko.io, gadgets360.com)
- **Reliability on weak networks**: WhatsApp works reliably even on 2G; users in South Asia value
  fast-opening apps and low data usage. (Source: grabon.in) Discord's 2026 mobile rebuild cut open
  times 43% iOS / 55% Android and was explicitly framed around this. (Source: itraveledthere.io)

## Part 2 — Discord: what users expect (2026)

- **Server structure, not just groups**: nested servers → text channels → **threads** for organized
  discussion, **forum channels** with tags for topic-specific posts, and **pinned/favorited** DMs and
  channels. (Sources: communityone.io, yugatech.com, itraveledthere.io)
- **Persistent voice channels** you *join* without ringing (Discord's core differentiator), plus
  **Stage channels** for structured broadcasts and **Activities** (built-in games/mini-apps, up to
  10–25 participants) that run inside voice. (Sources: fcbuy.com, peakbot.pro, communityone.io)
- **Roles & moderation as product features**: granular per-role permissions, reaction roles, audit
  logs for kicks/bans, auto-moderation bots. (Sources: communityone.io, yugatech.com)
- **Bots are a platform**: music bots, moderation bots, polls, games, webhooks — they turn servers
  into interactive spaces. (Sources: fcbuy.com, communityone.io)
- **Expressive identity**: custom/animated emojis, animated avatars, 300-char bios, custom statuses.
  (Sources: fcbuy.com, yugatech.com)
- **Upload limits matter**: Discord's free tier caps file uploads (Nitro raises them) — large-file
  handling is a premium lever, not a core expectation. (Source: fcbuy.com)

## Part 3 — Telegram: what users expect (2026)

- **Cloud sync everywhere** with unlimited online storage ("Saved Messages"), full history on every
  device, and 2–4 GB file uploads — users trust it as a file locker, not just a chat app.
  (Sources: rankred.com, indiaeducationdiary.in)
- **Broadcast channels + supergroups**: channels with unlimited subscribers, supergroups up to
  200,000 members, Topics/threads inside supergroups, **Communities** linking channels/groups/bots
  around one topic, public post search across channels. (Sources: durovscode.com, appsgeyser.com,
  techspot.com)
- **Rich creator tooling**: Stories with albums, polls, quizzes, AI summaries of long posts, rich
  text editor with headings/lists/tables, Super Channels with post authorship, direct messages to
  channel subscribers. (Sources: appsgeyser.com, smm-e.ru, techspot.com)
- **Bots & Mini Apps as an ecosystem**: 500M MAU on Mini Apps; payments via bots; AI admin bots for
  group moderation. (Sources: durovscode.com, appsgeyser.com, androidgb.com)
- **Stickers/GIFs/customization**: dynamic chat wallpapers/themes, gifts, collectible economies —
  personalization is a daily-use driver, and animated emoji/stickers are treated as first-class
  content. (Source: techspot.com)

## Part 4 — Cross-cutting UX principles (2026)

1. **Reliable core first**: prompt, error-free delivery and correct presence/typing/receipt states;
   lapses in the core cause abandonment. (Source: netguru.com)
2. **Speed on low-end devices**: Messenger Lite-style philosophy — small install, low memory, low
   data — is what emerging markets reward; Discord now optimizes for older devices too.
   (Sources: avidemux.org, itraveledthere.io)
3. **Offline-first feedback**: show "Sending…" states, queue messages, auto-save drafts (WhatsApp's
   draft auto-save for Status and message drafts is cited as best practice). (Sources:
   numberanalytics.com, fastercapital.com, dedontech.blogspot.com)
4. **Privacy granularity**: per-setting visibility (last seen, profile photo, about, read receipts),
   not just on/off. Users also actively ask for per-chat receipt control — which WhatsApp still does
   *not* offer. (Sources: obnews.co, pickyassist.com) **[inference: per-chat controls would be a
   differentiator against WhatsApp.]**
5. **Discovery without exposure**: usernames, public post/channel search, invite links, QR — ways to
   connect and discover that don't require sharing a phone number. (Sources: grabon.in, techspot.com,
   appsgeyser.com)

## Part 5 — Priorities for PulseChat

### Must-have (the app feels broken-without-these in 2026)
1. **Real calls, not simulated** — VoiceCallModal currently plays no media peer-to-peer
   (getUserMedia local only, no RTCPeerConnection). Real voice/video calls are the #1 WhatsApp-class
   expectation. *(Code: src/components/VoiceCallModal.tsx)*
2. **Message actions: reply (quote), edit, delete-for-everyone, forward** — no message context menu
   exists today. *(Code: src/components/ChatViewScreen.tsx renders bubbles but has no per-message
   actions; ChatMessage type has no `editedAt`/`replyTo`/`deletedAt` fields — src/types/chat.ts)*
3. **Message status + read receipts that are honest** — `status: sending|sent|delivered|read`
   exists in the model but the UI renders only a static CheckCheck icon for own messages; nothing
   updates over time. *(Code: src/types/chat.ts, ChatViewScreen.tsx ~line 900)*
4. **Reactions UI** — `ReactionMap` + server `message:react` broadcast exist, but no picker and no
   reaction chips render in chat. *(Code: src/types/chat.ts, server.ts, services/socketService.ts)*
5. **Typing indicator UI** — protocol exists (`typing:indicator` events) but nothing shows it in the
   chat header. *(Code: services/socketService.ts — no consumer in ChatViewScreen.tsx)*
6. **Persistent, multi-device sync** — today all server state is in-memory and the client is
   localStorage-based; a "million-dollar" messenger needs real message history that survives
   restart and devices. (Cross-cutting, Part 4)

### Should-have (what puts PulseChat in the WhatsApp/Discord/Telegram tier)
7. **Polls with deadlines + anonymous voting** — polls don't exist yet; this is a 2026 flagship
   group feature. (Sources: indiatvnews.com, 91mobiles.com)
8. **Stories/Status tab** — no stories feature exists; WhatsApp's 1.5B/day Updates tab shows the
   scale of the expectation. (Sources: top10-best.com, gadgets360.com)
9. **Usernames + discovery** — reduces phone-number dependence; a WhatsApp 2026 trend and a
   natural fit with the app's login model. (Sources: grabon.in, zoko.io)
10. **@all mentions + admin controls** (mute @all, spin-off chats) — the app already has granular
    roles/permissions (GroupRole, MemberPermissions) but no @all/mention system.
11. **Stickers/GIFs + saved media** — expressiveness is a daily-use driver (Telegram/Discord); a
    "Saved Messages" cloud locker matches the app's localStorage-only reality.
12. **Disappearing / view-once messages** — privacy expectation on WhatsApp; pairs with the app's
    existing Offline QR feature story.
13. **Search & storage management**: media-type search, in-chat search, storage usage tooling —
    WhatsApp's advanced clearing tool shows users want storage control. (Sources:
    dedontech.blogspot.com, zoko.io)
14. **Call quality on weak networks**: voice-first, low-bitrate fallback, group call grid, missed-call
    logs with "call back" — the CallsScreen already has call logs + dialer; voice chat rooms
    (join-without-ringing) would add the Discord flavor.

### Delight (differentiators)
15. **Offline QR file sharing** — already exists and is genuinely unique (air-gapped transfer). Market
    it as a feature, not a quirk. *(Code: src/components/OfflineQrModal.tsx)*
16. **Bots & mini-activities** — Telegram/Discord's biggest moat; a simple bot API + in-app
    mini-games in group voice rooms would stand out.
17. **Bangla-first polish** — the app already has 300+ `lang==='bn'` strings and Bangla-English
    toggle; doubling down (Bangla voice-to-text dictation, Bangla onboarding) differentiates in
    Bangladesh where WhatsApp is default-but-generic. **[inference from Part 1 sources +
    existing code]**
18. **Data-saver mode / Lite behavior** — auto-download off, compressed previews, low-data indicator:
    matches South-Asian low-end device reality. (Sources: avidemux.org, itraveledthere.io)
19. **Custom themes/emoji per chat** — Telegram/WA theme culture; animated emoji would hit the user's
    "animations clearly visible" preference.

## Sources opened (cite list)
- https://capgo.app/blog/cross-platform-messaging-apps/
- https://www.groovyweb.co/blog/top-messaging-apps-chatting-apps
- https://www.scmgalaxy.com/tutorials/top-10-messaging-apps-tools-in-2025-features-pros-cons-comparison/
- https://www.flozic.ai/blog/best-chat-apps
- https://www.grabon.in/indulge/tech/best-text-messaging-apps-for-android-and-ios/
- https://top10-best.com/trends/top-10-most-used-messaging-apps-in-the-world-2026/
- https://www.gadgets360.com/apps/news/whatsapp-new-year-2026-features-stickers-video-call-effects-status-tools-10088720
- https://wabetainfo.com/page/4/?utm_pageloadtype=inline_link
- http://dedontech.blogspot.com/2026/01/new-whatsapp-features-nigerians-should-know-2026-update.html
- https://themunicheye.com/whatsapp-update-group-chat-features-34749
- https://www.zoko.io/post/whatsapp-ai-features-news-updates
- https://www.moneycontrol.com/technology/whatsapp-rolls-out-better-polls-all-mentions-and-faster-group-chat-creation-article-13994681.html
- https://messengerbot.app/whatsapp-blue-ticks-2026-what-they-mean-and-how-to-turn-them-off/
- https://www.aeanet.org/what-is-the-meaning-of-read-receipt-in-whatsapp/
- https://techsith.com/how-to-disable-read-receipts-on-whatsapp/
- https://pickyassist.com/blog/how-to-turn-off-blue-ticks-on-whatsapp/
- http://getkanal.com/blog/delete-whatsapp-message-for-everyone
- https://www.gbyte.com/blog/whatsapp-delete-for-everyone
- https://wasifahmed.dev/whatsapp-group-updates-polls-all-mentions/
- https://www.indiatvnews.com/technology/news/whatsapp-gets-smarter-for-group-chats-with-poll-deadlines-anonymous-voting-and-all-tag-2026-08-05-1050447
- https://www.91mobiles.com/hub/whatsapp-rolls-out-poll-deadlines-all-mentions-group-upgrades/
- https://appsgeyser.com/blog/telegram-marketing/
- https://www.techspot.com/downloads/6418-telegram.html
- https://indiaeducationdiary.in/how-to-monetize-telegram-channels-in-india-in-2026/
- https://www.rankred.com/features-of-telegram-messenger-app/?fbclid=IwAR0l5umS4-mC6UJkUujQDtPI0w17drGTL5Q8lTetYe-V8K_UijDdSfpnJ5s
- http://www.androidgb.com/download-telegram-messenger-android-whatsapp-alternative-934/
- https://smm-e.ru/en/articles/-superchannels-star-reactions-subscriptions-en/
- https://durovscode.com/telegram-features-security-business
- https://www.fcbuy.com/news/How-Discord-Works-in-2026-A-Complete-Guide-for-Gamers-and-Communities.html
- https://blog.communityone.io/discord-hidden-features-2026/
- https://peakbot.pro/blog/discord-activities-apps-guide-2026
- https://www.socialchamp.com/blog/what-is-discord/
- https://www.yugatech.com/news/discord-gets-new-user-requested-features/
- https://itraveledthere.io/knowledge/what_are_the_new_features_in_the_latest_discord_mobile_update.php
- https://www.netguru.com/blog/messaging-app-ux
- https://www.numberanalytics.com/blog/offline-centric-mobile-ux
- https://www.jtechhelp.com.ng/2026/10/how-to-reduce-mobile-data-usage-on.html
- https://avidemux.org/smif/index.php?topic=18502.0
- https://www.fastercapital.com/content/User-interaction--Mobile-User-Experience--Optimizing-Mobile-User-Experience-for-Greater-Interaction.html
- https://t-en-yd.obnews.co/Index/flowNewsDetail/id/13959656.html?val=85c6443eb5e3d230a1a7a58201b6e1cb
