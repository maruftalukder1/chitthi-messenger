# চিঠি · Chitthi — v2 Build Report (18 Oct 2026)

App name confirmed by Maruf: **চিঠি · Chitthi** (all user-visible "Chithi"/"PulseChat"
branding renamed; internal storage keys and the Firebase project id were deliberately
left untouched so existing saved data keeps working).

Working source: `~/workspace/pulsechat-v2` · Research: `docs/RESEARCH.md` ·
Feature matrix (43 features): `docs/FEATURE_MATRIX.md` · WS QA script: `docs/qa-ws-test.mjs`

## What was built

### Security hardening (all five audit issues)
1. `POST /api/auth/send-2fa-code` no longer returns the code in its JSON response — retested live: response has no `code` field.
2. `validateTwoFactorCode()` fails **closed** (any Firestore error → `valid:false`); `valid:true` only on the real success path.
3. `firestore.rules` rewritten: everything requires auth; `users/{uid}` writable only by its owner; activities owner/admin read; `twoFactorVerifications` is **client-inaccessible (server-only)**. ⚠️ Rules must still be pasted/deployed in the Firebase Console — that step needs Maruf's login.
4. Local fallback accounts no longer store plaintext passwords: SHA-256 `passwordHash` (crypto.subtle), with transparent migration of old plaintext records on next successful login.
5. Login UI no longer displays/autofills the OTP anywhere ("the code is never shown inside this app").

### Flagship messenger features (WhatsApp + Discord + Telegram)
- **Message action sheet** on every message (hover ⋯ / tap): quick reactions ❤️👍😂😮😢🙏, Reply, Pin, Copy, Forward, Edit, Delete-for-everyone.
- **Reactions UI** — chips under bubbles with counts, my reaction highlighted, toggle on tap; still broadcast over the existing server `message:react` path.
- **Reply/quote** — quote block in the bubble + reply preview banner over the composer.
- **Edit** — own text messages within 15 minutes (WhatsApp rule), "edited" marker.
- **Delete for everyone** — soft-delete tombstone ("This message was deleted"), own messages or group admin.
- **Pin message** — amber ring + pinned banner under the header, tap to jump, X to unpin.
- **Forward** — chat picker, "Forwarded · <name>" label, polls forward with reset votes.
- **Polls (Telegram-style)** — create from the attach menu (question + 2–5 options), animated result bars, percentages + vote counts, single-choice vote moving, tap again to retract.
- **In-chat search** — header 🔍, live result count, sender/text/poll matching, empty state.
- **Typing indicators** — the `typing:indicator` protocol existed but was never consumed; now wired (2s throttle send, 3.5s expiry, animated dots + name).
- **Read receipts** — status-aware ticks: ✓ sent, ✓✓ delivered, blue ✓✓ read (model existed; static icon replaced).
- **Archive + Mute chats (WhatsApp-style)** — hover actions on chat list, Archived view with count, muted chats hide unread badges and show 🔕.
- **Call logs** — every finished/missed call is appended to History with direction, duration, type.
- **Saved-messages / stories / usernames** from the research list were *not* built in this round (see "Honest limits").

### Real WebRTC calls (was: simulated)
- Full rewrite of `VoiceCallModal`: real `RTCPeerConnection`, Google STUN + Open Relay TURN, ICE-restart hardening, pending-ICE queue.
- Signaling over the app's own WebSocket: new server `call:signal` relay (invite/accept/offer/answer/ICE/end, targetable per user, never stored).
- **Incoming calls ring on any screen** (global invite listener in App), Accept/Decline UI.
- PawMatch lessons applied: remote `<video>` always mounted for video calls; a dedicated always-mounted `<audio>` element plays remote audio in audio calls; "🔊 Tap for sound" fallback for autoplay blocks; ontrack `e.streams[0] ?? new MediaStream([track])` fallback.
- Honest states instead of a fake "connected": Calling…/Ringing/Connecting/Connected only on `connectionState === 'connected'`; **30s no-answer → missed call** logged exactly once.
- Controls: mute, camera on/off, speaker routing via `setSinkId` where the platform allows, end call. Duration timer runs only while connected.

### C++ Engine — live in the app
- `CppExplorer` was dead code; it is now reachable from the new **Engine** button in the bottom nav (full-screen overlay: source files, terminal simulator, build guide, project ZIP download).
- Bottom nav redesigned WhatsApp-style with labels: Chats · History · Calls · Engine · Profile.
- The embedded C++ project was renamed with the app (namespace `Chitthi`), re-extracted, recompiled and re-tested (below).

### Design / performance
- CppExplorer is `React.lazy`-split: main bundle 1.32 MB → **1.19 MB** (engine chunk 132 KB on demand).
- New motion utilities (`animate-float-slow`, shimmer) with `prefers-reduced-motion` respect; applied to the login brand mark and the new-chat FAB — continuous, clearly visible motion per Maruf's standing preference.
- Poll bars, typing dots, pinned banner, action sheet and banners all animate in consistently with the app's existing `animate-in` language.

## QA — six passes, all green (evidence, not vibes)

| Pass | Check | Result |
|---|---|---|
| 1 | `npx tsc --noEmit` | ✅ 0 errors |
| 2 | `npm run build` | ✅ built; main 1.19 MB / gzip 346 KB, CppExplorer chunk split |
| 3 | Production server smoke | ✅ `/` 200, `/api/health` ok, `/api/channels` ok |
| 4 | 2FA leak re-test | ✅ response contains **no** `code` |
| 5 | WebSocket live test (`docs/qa-ws-test.mjs`, 2 clients) | ✅ message broadcast, typing relay, reaction broadcast, call invite/accept/end relay — all PASS |
| 6 | C++ (renamed) compile + live relay | ✅ g++ C++20 clean; Alice↔Bob messages delivered both ways |
| + | Built-bundle marker sweep | ✅ "Create a Poll", "Pinned message", "is typing", "Forward to", tombstone text, "Tap for sound", "No answer", `Chitthi_CPP_Source_Project.zip`, `<title>চিঠি - Chitthi Messenger</title>` all present |

## Honest limits — what is NOT proven / not done
- **In-call media between two real devices is not machine-provable here** (sandbox blocks WebRTC/UDP, same as PawMatch). Signaling is proven end-to-end; Maruf's two-device test is the remaining proof for actual audio/video.
- Server state is still in-memory (rooms/channels/2FA reset on server restart) and the client still persists to localStorage. True multi-device cloud sync needs a database decision (Firestore is already connected for auth/activity and is the natural next step).
- Firestore rules file is ready but **not deployed** — needs Maruf's Firebase Console login (the one knock reserved for him).
- Real 2FA emails need SMTP env (`SMTP_HOST/USER/PASS`) on the host; without it the server falls back to a test transport.
- Not built this round: Stories/Status tab, Saved Messages, @mentions/@all, disappearing messages, message scheduling, usernames. All are in the research priority list for the next round.
- Legacy components (`Navbar`, `Sidebar`, `ChatArea`, `ChatInput`, `MessageItem`, `UserActivityModal`) remain in the source, unused — kept deliberately so no original code was destroyed; they cost nothing at runtime (tree-shaken out of the bundle).

## Run it
```bash
cd pulsechat-v2
npm install
npm run dev        # http://localhost:3000  (dev, Vite + WS server)
# production:
npm run build && NODE_ENV=production npm start
```

## Addendum — residual risks flagged by the security pass (honest leftovers)
1. **OTP is still client-generated.** The browser generates the 6-digit code and sends it to the server to email/store; a fully hardened design would generate it server-side only. The response-leak (the critical hole) is fixed, and the code is never shown in the UI — but "server-generated OTP" is a queued follow-up, not done.
2. **"Direct Link Login" demo button** in the 2FA modal can bypass code entry for local accounts on the same device (demo convenience carried over from the original code). It requires device/localStorage access to abuse, but it should be removed before any public deployment.
3. Under the new Firestore rules, the client's own Firestore 2FA read/write legs now get permission-denied by design (they degrade gracefully — the server verify endpoint + local check carry the flow).

---

# Addendum — Overnight Round 2 (2026-10-18 night, Maruf's "add everything" order)

## Security hardening completed (both round-1 residuals closed)
- **Server-generated OTP:** /api/auth/send-2fa-code now IGNORES any client-supplied code and always generates it server-side (verified live: a smuggled "000000" was rejected, the server's own code verified). Client no longer generates or stores an OTP; the localMatch bypass is gone.
- **Delivery honesty:** when SMTP is not configured the response is `delivery:'demo'` with `emailSent:false`, and ONLY in that case the code is returned and shown in a clearly-labeled amber "DEMO MODE — email is not configured" box. With real SMTP configured the code never leaves the server (that branch is code-reviewed; untested live — no SMTP in the sandbox).
- **Rate limit:** max 5 code requests per email per hour → 429 (verified live).
- **"Direct Link Login" bypass REMOVED** from the 2FA modal (button + handler + dead imports cleaned; source sweep confirms no trace).

## Persistence (server)
- roomMessages + serverChannels now persist to `data/store.json` (debounced saves, corrupt-file safe, 200-msg/room cap kept). Verified with my own restart test: posted a channel, restarted the server, the channel was loaded from disk and returned by GET /api/channels. Test data cleaned afterward.

## Features added
- **Stories/Status:** StoriesBar at the top of the chat list — gradient pulsing rings, 24h expiry, seen tracking, full-screen viewer (progress bars, 5s auto-advance, tap zones, pauses when tab hidden), post your own story with caption. Keys: chitthi_stories_v1 / chitthi_stories_seen_v1.
- **Saved Messages:** pinned personal room (forward anything there; only you see it).
- **Scheduled messages:** clock button next to Send, quick chips (in 1h / tonight 9 PM / tomorrow 9 AM) + exact datetime picker; queued chips with cancel; a 5s sweeper sends when due. Stored in chitthi_scheduled_v1. (App must be open for the send to fire — same model as Telegram's server would fix later with cloud sync.)
- **@mentions:** group composer autocomplete (usernames + admin-only @all), highlighted rendering, amber highlight when you or @all are mentioned.
- **Usernames:** @username on users (seeded for demo users), editable in Profile, chat search matches @username.
- **Stickers:** attach menu → sticker panel, big animated sticker bubbles.
- **Disappearing messages:** per-room timer (Off/1h/24h/7d) in the chat menu; new messages carry an expiry + countdown chip; a sweeper deletes them.
- **Chat wallpapers:** per-room (Default/Dots/Ocean/Sunset/Forest).
- **Composer drafts:** unsent text auto-saved per room+section.
- **Real storage manager (Settings):** true localStorage accounting by group with honest per-group clear actions (two-step confirm, reports actual bytes freed) — replaces the fake hardcoded panel. **Data saver toggle** (chitthi_data_saver) honored in chat: images load on tap, videos don't preload.

## QA (5 passes, all green)
1. tsc --noEmit: 0 errors. 2. Production build green (main 1.22 MB / gzip 355 KB). 3. Live server smoke: health, channel create, OTP (smuggled code ignored, wrong code rejected, server code accepted, 6th request → 429). 4. Persistence restart proof (above). 5. WS test: message/typing/reaction/call invite-accept-end all PASS; bundle marker sweep 9/9 R2 features present; "Direct Link" absent from source.

## Still open (unchanged from round 1)
- firestore.rules written, NOT deployed — needs Maruf's Firebase Console login (the one knock).
- In-call WebRTC media: two-device test by Maruf (sandbox blocks UDP).
- Real-SMTP OTP delivery branch untested until SMTP env exists on a host.
- Cloud sync across devices (Firestore) remains the next big architectural step; today: server disk persistence + client localStorage.

---

# Addendum — Professional Functional QA Session (2026-10-18 late night)

Maruf's order: "প্রত্যেকটা feature ধরে ধরে কাজ করো একজন professional-এর মতো — make sure everything is workable."
Three workstreams: reliability lab + security lab on isolated server copies (production untouched), plus a client functional trace. Full evidence: ~/workspace/chitthi-qa/RELIABILITY.md, SECURITY_LAB.md; summary: your_files/chitthi/FUNCTIONAL_QA.md.

## Reliability lab — ALL PASS, zero defects
Concurrency 150/150 delivered (0 loss, 0 duplicates); restart mid-conversation restored 20/20 history with no replay leak; 50-cycle presence churn returned connection count exactly to baseline; burst round-trip p50 19ms / p95 46ms, health p50 3ms. Design observations (not defects): server broadcasts globally, clients filter by room; server does not dedupe by id, the client does.

## Client trace — 3 bugs found & fixed
1. Saved Messages privacy leak (room id shared by all users + server relay) — fixed at client-send, server-relay and client-receive layers; live-proven.
2. Story photo localStorage quota overflow (silent loss) — downscale to 1080px JPEG on post.
3. Draft saved while editing (resurrected text) — drafts no longer save in edit mode.
Verified clean by trace: missed-call exactly-once (single-fire guard), edit ≤15-min window, stories persistence error handling, CppExplorer wiring.

## Security lab — 7 findings, ALL fixed & re-proven live
WS auth gate (no publish/ring before login); server stamps senderId/senderName from the login session (impersonation closed); ring-screen caller name resolved from the server-stamped id only; safeMediaUrl allowlist on file/image/video/audio URLs (javascript: XSS closed); 2FA codes consumed on success; verify brute-force cap (10 wrong = code burned); OTP via crypto.randomInt; WS maxPayload 12MB + per-message 8MB cap + 1000-room ceiling + channel name/count caps.
Note: docs/qa-ws-test.mjs was corrected — its reaction step itself used a spoofed userId (now asserts the stamped identity), and it uses unique message ids per run (persisted history made fixed ids collide).

## Regression after all patches
tsc 0 errors · production build green · WS suite ALL PASS against the patched server · targeted proofs for every fix · public (tunnel) server restarted onto the patched code + new dist and verified through the public link.

---

# Addendum — Audit + Fix Round 3 + Master Plan (2026-10-30)

Azure setup attempt (Maruf's decision): account talukdermaruf9@gmail.com has NO Azure subscription; he began Azure for Students signup, hit login/verification trouble, and parked hosting to do himself later. Prep stands: server.ts honors PORT + CHITTHI_DATA_DIR; deploy zip rebuilt AFTER Round 3 and re-smoke-tested (health + WS suite ALL PASS). Plan: your_files/chitthi/AZURE_SETUP.md.

Full 3-part audit (messaging / calls / surface-system) → 17 verified bugs, ALL fixed in Fix Round 3 (report: your_files/chitthi/FIX_ROUND_3.md): message:update sync protocol (edit/delete/pin/poll-vote), forward-to-room, unread badges + previews, room:history consumption, upload guardrails, date separators, who-reacted, linkify, quote-jump; calls: peerId targeting (redial rang everyone), call-log persistence + filters, busy/declined signals, ringtone+vibration, callee timeout, audio fallback, camera flip; account: fake Google fallback login removed, real logout, profile sync, false E2E claim corrected. Verification: tsc 0, build green, WS suite + 11-check update-protocol suite ALL PASS, restart persistence PASS.

Design research (Pinterest/Dribbble/Behance/products): your_files/chitthi/DESIGN_RESEARCH.md — light theme, blue-violet #2563EB→#7C3AED, floating pill bar, glass overlays only. Master synthesis + add/remove lists + staged $100M roadmap + approvals queue: your_files/chitthi/CHITTHI_MASTER_PLAN.md.

# Addendum — UI Redesign Round (2026-10-30, approved by Maruf from the queue)
Blueprint from DESIGN_RESEARCH.md applied across 5 workstreams (REDESIGN_ROUND.md): design tokens in index.css (primary #2563EB, gradient #2563EB→#7C3AED restricted to send/story-rings/brand/FAB, surfaces #FFF/#F6F7F9/#EEF1F5 + dark counterparts, .shadow-soft/.glass-bar utilities, Inter + Hind Siliguri kept), floating glass pill BottomNav, chat list (big title, search pill, REAL All/Unread/Groups/Personal filter chips, black unread pill, gradient story rings), conversation (20px bubbles + 4px tails, floating pill composer, glass sheets, waveform voice-message pill), calls (gradient incoming screen, floating glass in-call bar), settings grouped cards. Server/protocol untouched; QA: tsc 0, build green, WS suite ALL PASS, tokens present in built CSS, 527 .dark selectors. Live visual QA (browser pass) confirmed the look; 2 defects found there (DM placeholder leaking group section name; 2FA "Delivered" wording in demo mode) fixed immediately + rebuilt + Azure zip refreshed (3.17 MB) + tunnel server restarted on the new build.
