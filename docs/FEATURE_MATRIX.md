# চিঠি · Chitthi — Feature Matrix (Phases 0–2, shipped state)

What the code in this repository actually does, as verified in
`PHASE0_REPORT.md`, `PHASE1_REPORT.md` and `PHASE2_REPORT.md` (final gates:
`tsc` 0 errors, build green, WS suite 6/6, security suite 31/31, OTP suite
6/6, production smoke with zero console errors). This file describes shipped
behaviour only — nothing aspirational. For what is deliberately **not**
present, see `docs/KNOWN_LIMITATIONS.md`.

**Sync key:** **Server** = relayed/stored by `server.ts` (in-memory state
snapshotted to `$CHITTHI_DATA_DIR/store.json`) · **Local only** = one
browser's `localStorage`, does not reach another device · **Firestore** =
profile/auth data in Firebase/Firestore · **P2P** = media flows
peer-to-peer, signalling via the server.

## Messaging

| Feature | Status | Sync / notes |
|---|---|---|
| Text messages, DMs and groups | Present | Server — WebSocket relay; persisted to `store.json`. **No per-room cap:** the old destructive 200-message retention cap was removed in Phase 1; history is served in pages (see History paging below). |
| Image / video / audio / file messages, camera capture | Present | Server — new sends go through the upload pipeline (`POST /api/uploads`, 25 MB cap, unguessable `/uploads/<file>` URLs; message carries the URL + `fileName`/`fileSize`/`mimeType`). Legacy base64-in-message sends remain only as a fallback when an upload request fails. |
| Voice notes | Present | Server — recorded in the client (`MediaRecorder`, mime picked from `isTypeSupported` candidates) and sent as a message; real wall-clock duration and waveform decoded from the actual audio. |
| Message action sheet | Present | Server — Reply, Pin, Copy, Forward, Edit, Delete, quick reactions; opens on long-press (500 ms, scroll-safe) and right-click as well as tap. |
| Reactions | Present | Server — chips under bubbles with counts; broadcast via the server reaction path. |
| Reply / quote | Present | Server — universal quote-reply for every message type (human labels, media thumbnails); tap a quote to jump to the original. |
| Edit own message | Present | Server — "edited" marker; forward strips `editedAt`/`expiresAt` at hand-off. |
| Delete for everyone | Present | Server — soft-delete tombstone. |
| Pin a message | Present | Server — pinned banner under the chat header, tap to jump; pin state syncs via `message:update`. |
| Forward | Present | Server — chat picker, "Forwarded" label; polls forward with votes reset. |
| Polls | Present | Server — single- and multi-choice voting; quiz mode (correct option revealed after voting — the answer travels with the message payload, so this is a UX courtesy, not secrecy). Poll votes are anonymised per-recipient: sender + channel owner/admins see `voterIds`; everyone else gets `voterIds: []` + per-option `voterCount`. |
| Typing indicators | Present | Server — WebSocket `typing:indicator` relay; named group typing ("X and N others…"). |
| Delivery / read receipts | Present | Server — `deliveredTo[]`/`readBy[]` tracked per message and persisted; `message:ack` to the sender, `message:receipts` pushed on delivery and on `message:read`. Message Info panel lists read-by / delivered-to. |
| Message starring | Present | Server — `GET/POST/DELETE /api/stars`; full message snapshots persisted per user; ★ marker in chat. |
| Remind me about a message | Present | Server — `POST /api/reminders`; at due time the server sends the owner `reminder:due` and the client adds a Saved-Messages entry + banner; fired-while-away reminders are recovered on login. |
| In-chat search v2 | Present | Local over loaded history — in-place match rings + `<mark>` highlight, n-of-N stepping, section/room scope, `from:` / `has:` / `before:` / `after:` filter parser + chips. |
| Global search | Present | Server — `GET /api/search` (Ctrl/Cmd+K); up to 100 matches across rooms the caller may access; matches text content + fileName; results grouped by chat with highlighted snippets; tap pages history (≤5 pages) and jumps to the message. |
| Chat-list search | Present | Local — matches chat name, description, peer name / `@username`, latest-message preview; designed empty-results state. |
| @mentions / @all | Present | Server messages, client rendering — group composer autocomplete; mentions are highlighted and tappable (opens the user's ProfileCard). |
| Stickers | Present | Bundled original SVG sticker packs (2 packs × 8, `public/stickers/`) sent as `type: 'sticker'` messages with `content` = asset URL — plus enlarged-emoji sticker bubbles. |
| GIF picker | **Picker shipped — needs owner API key** | `gifService.ts` supports Klipy or GIPHY behind the build-time vars `VITE_GIF_PROVIDER` / `VITE_GIF_API_KEY`. Until the owner sets both, the picker shows a designed "not configured" empty state. **No fake feed is ever shown.** A picked GIF is sent as a real image media message. |
| Contact cards | Present | Server — `contactCard` (username) messages; tappable, opens that user's ProfileCard. |
| Disappearing messages | Present | Hybrid — per-room timer; new messages carry an `expiresAt` and expired messages are excluded from (and purged out of) server history. |
| Chat export | Present | Local — export a conversation as HTML / JSON / TXT (tombstones excluded). |
| History paging | Present | Server — `room:history` accepts `{before?, limit?}` (default page 200, newest page first) and returns `hasMore` + `oldestId`. All messages are retained in the store; paging is how older history is fetched, not a retention limit. |

## Calls (1-to-1 only)

| Feature | Status | Sync / notes |
|---|---|---|
| 1-to-1 voice and video calls | Present | P2P — real `RTCPeerConnection`; signalling (invite / accept / offer / answer / ICE / end) relayed per-user over the app WebSocket, room-scoped, never broadcast globally. In-call media between two real devices remains the owner's two-device test, not machine-proven. |
| Screen sharing | Present | P2P — `getDisplayMedia` + `replaceTrack` (added-sender + renegotiation path for audio calls); browser stop-sharing handled; camera track and mute state preserved. |
| Weak-connection badge | Present | Client — `getStats` polling (RTT > 600 ms or loss > 8%, 2 consecutive degraded polls to show). |
| ICE restart | Present | Client — `pc.restartIce()` + renegotiation on `failed`, 3 s grace on `disconnected`; ~20 s connecting timeout with an honest failure state. |
| Incoming-call ringing on any screen | Present | Server signalling — global invite listener, Accept / Decline; busy / declined states and tones. |
| Call controls | Present | Mute, camera on/off / flip, speaker routing (drives the single actual media element — the Phase 0 echo fix), end call; duration timer runs only while connected. |
| Call history | Present | Server + local merge — `POST/GET/DELETE /api/call-logs` (stored for the caller and mirrored for the peer, direction flipped; latest 200 served); the screen merges server + local logs with dedupe. |
| Group calls | **Not present** | Calling is 1-to-1 only. The group-call button was removed from group rooms in Phase 0 (the App handler also no-ops for non-DM rooms); SFU group calls are unbuilt (Phase 3 in the roadmap). |

Call media uses Google STUN plus the free Open Relay (metered.ca) TURN
service with its public credentials, hard-coded in
`src/components/VoiceCallModal.tsx`, unless replaced with dedicated TURN
credentials. See `docs/KNOWN_LIMITATIONS.md`.

## People, groups, and profiles

| Feature | Status | Sync / notes |
|---|---|---|
| Groups with sections (sub-channels) | Present | Server channels, persisted server-side; sections include private/locked sections (ID-only access check) and read-only announcement sections (non-owner/admin posts dropped server-side). |
| Group administration | Present | Server — admin is a real check (owner / `adminIds` / legacy `adminId` / member role), never bypassed; rename/avatar/sections/roles/permissions/kick all POST to `/api/channels` with auth and persist. Kick applies exactly once. |
| Group invite links | Present | Server — `POST /api/channels/:id/invite` (re)generates a code, `DELETE` revokes; join via `chitthi://join/<code>`, any URL ending in the code, or the bare code; join-approval queue (approve/reject) when enabled. |
| Leave / delete group | Present | Server — self-removal via channel update; delete is owner-only, type-to-confirm, and removes the channel + its messages. |
| Group permission matrix | Present | Server — `permissions: {post, pin, manage}` (`all` / `admins`); `post: 'admins'` is enforced in the server send path and gates the composer. |
| Group events | Present | Server — events with RSVP (`yes` / `no` / `maybe`) stored on the channel. |
| Group shared-media browser | Present | Local over the room's messages — Images grid, Videos, Docs (real download anchors), Links tab with real counts and designed empty states; member-row tap opens ProfileCard. |
| Stories / Status | Present | **Server** (since Phase 0) — `GET/POST /api/stories`, view recording, author-only delete, 24 h expiry, block-filtered. Per-user local cache only mirrors the server. |
| Story audiences | Present | Server — `everyone` / `contacts` / `close` / `custom` audiences, filtered on GET; remembered per-user default audience and close-friends list are local prefs. |
| Text / video stories | Present | Server — text stories (8 backgrounds, 5 fonts incl. বাংলা, `kind: 'text'` + `textData`); video stories (playback-tied progress, tap mute/unmute). |
| Story reactions & replies | Present | Server — one emoji reaction per user, toggle, `POST /api/stories/:id/react`; reply-to-story sends a DM message carrying `storyRef`. |
| Story highlights | Present | Server — snapshots (`GET/POST/DELETE /api/highlights`) that survive the 24 h story expiry; shown on own profile row and in other users' ProfileCards. |
| Story mutes | Present | Server — `GET/POST/DELETE /api/stories/mutes`; muted authors are excluded from the caller's story feed. |
| Usernames (`@username`) | Present | Server-enforced — validation 5–20 chars, `[a-z0-9_]`, starts with a letter, no leading/trailing/consecutive `_`; reserved-name list; atomic claim (`POST /api/usernames/claim`); a released handle sits in a 14-day reclaim grace reclaimable only by the same user. Fail-closed in the profile UI: a changed handle is claimed on the server before anything applies. |
| Find people | Present | Server — `GET /api/users/search` (exact-username, case-insensitive, or name-prefix) over the public directory, honouring `discoverable` and `privacy.findMe`; results open a ProfileCard → DM. |
| QR add-friend | Present | Local + server search — `chitthi://user/…` payloads route to add-contact (search → ProfileCard), kept separate from offline QR transfer mode; My QR uses the username payload. |
| ProfileCard (other-user card) | Present | Audience-aware rendering (photo/About/lastSeen hidden when the owner's privacy audience excludes the viewer), full-screen photo, linkified About, Message / Call / Block actions, shared-media row, highlights. |
| User profiles | Present | Firestore — `users/{uid}` keyed by **Firebase UID** (legacy `user_<email>` docs copy-migrate on login); the public doc never carries the email — it is written to the owner-only `users/{uid}/private/contact` subcollection. |
| Password storage (local accounts) | Present | Client — PBKDF2-HMAC-SHA-256, 100k iterations; legacy hashes verify-only with transparent re-hash on sign-in. |
| Avatar pipeline | Present | Centre-crop/resize to 512×512 JPEG, 5 MB cap; Firebase Storage `avatars/{uid}.jpg` with a data-URL fallback; Remove photo reverts to generated initials — no stranger-photo defaults anywhere. |
| Presence / online status | Present | Server — presence from real session snapshots only (no fabrication); modes Online / Away / Invisible (invisible appears offline but still receives everything); `lastSeenAt` is a real timestamp, audience-filtered by the subject's `privacy.lastSeen`. |
| Privacy audiences | Present | Server directory + local prefs — per-field audiences (`everyone` / `contacts` / `nobody`) for photo, About, lastSeen, find-me and group-add, posted to the directory on save. |
| Block / Report | Present | Server — `/api/blocks` + `/api/reports` (report implies block), persisted; a DM send or call invite across a block is **dropped server-side**. UI: DM menu, group member rows (Ban/Flag), Settings → Privacy blocked-users list. |
| Account centre | Present | Email display; Firebase change password / email with re-auth; **Active sessions** (`GET /api/sessions`, per-session revoke + revoke-others; a revoked socket gets `session:revoked` and logs out locally); first-seen-device login-alert email via SMTP when configured; Delete account (type-to-confirm, wipes directory entry, releases username, drops sessions); Erase-device-data with an honest warning. |
| Offline QR transfer | Present | Local — QR codes generated (`qrcode`) and scanned (`jsQR`) in the client to move content without the server. |

## Personal / productivity

| Feature | Status | Sync / notes |
|---|---|---|
| Saved Messages | Present | Hybrid — a pinned personal room; star snapshots and reminder-fired entries are server-backed; the room's contents also live in this browser's local message store. Copy is honest: "on this device". |
| Scheduled messages | Present | **Server** (since Phase 1) — `POST/GET/PATCH/DELETE /api/scheduled` + retry; a 5 s server sweeper delivers due items through the normal send path (room ACL + block checks), exactly-once, with `scheduled:sent` / `scheduled:failed` notices. **Fires even if the sender closes Chitthi.** The pre-Phase 1 local queue migrates to the server on login; a server failure at creation falls back to the local queue with a "must stay open" notice (honest dual path). Managed in Settings → Scheduled. |
| Reminders | Present | Server — see "Remind me about a message" above. |
| Composer drafts | Present | **Local only** — unsent text (and reply target) auto-saved per room + section; cancel-edit restores the draft; italic Draft previews on chat rows. |
| Chat archive and mute | Present | Local client state — Archived view with aggregate unread badge; mute for 8 h / 1 week / always (`mutedUntil`). |
| Chat pinning (chat list) | Present | Local client state — pinned chats in a grid, cap 5 (overflow pinned chats stay in the main list with a pin indicator). |
| Custom chat lists / folders | Present | **Local only** — `chitthi_lists_v1`; filter chips with unread counts; chat-row menu "add to list". |
| Recent searches | Present | **Local only** — global-search modal keeps recent searches on this device. |
| Chat wallpapers | Present | **Local only** — per-room choice. |
| Storage manager | Present | **Local only** — counts app keys only (`chithi_*` / `chitthi_*` prefixes) by group (incl. drafts / scheduled / TTL / wallpapers), per-group clear actions, clear-all confirm enumerating counts. |
| Data-saver toggle | Present | Local — when on, images load on tap and videos do not preload. |
| Enter-to-send setting | Present | Local — `chitthi_settings_v1`; Shift+Enter always inserts a newline; IME-safe. |
| Bangla / English UI | Present | Local — in-app language toggle with Bangla strings throughout. |
| Dark mode | Present (frozen) | Local — theme toggle; tokens flip under `.dark`. Kept functional in Phase 2 but received no new design work, per the Phase 2 ruling (light is the design target). |
| Liquid Glass (light) design | Present | Phase 2 — verified glass recipe (`blur(14px) saturate(140%)`, tint 0.45, specular rim + sheen) only on the bottom nav, chat identity pill, call bars, story chrome, modal sheets and composer; headers and rows are solid. ≤2 glass surfaces per viewport (measured). `prefers-reduced-transparency` (glass → solid) and `prefers-reduced-motion` honoured; light faint text #68707E = 4.99:1 on white / 4.70:1 on glass. |
| Onboarding | Present | Local — 3 screens (welcome EN/BN → privacy controls incl. the honest not-E2EE note → pick @username, opening the claim modal); per-user `chitthi_onboarded_v1_<uid>` flag; no double-prompt with the claim modal. |
| C++ Engine explorer ("Engine" tab) | Present | Local — lazy-loaded viewer for the bundled C++ project (source files, terminal simulator, project ZIP download); not a messaging feature. |

## Explicitly not present

- **End-to-end encryption** — messages are server-stored, not E2EE (the app
  says so in its own privacy UI — see `docs/KNOWN_LIMITATIONS.md`).
- **Group calls** — 1-to-1 calls only; no group-call button exists.
- **Live GIF feed without a key** — the picker ships, but a feed needs the
  owner's Klipy/GIPHY API key (see the GIF row above).
- **Cloud / multi-device sync of messages** — history comes from this
  server's `store.json` snapshot plus the client's local stores. Firestore
  is used for profiles/auth, not chat sync.
- **Fake / seed data** — a fresh install starts empty: no seed users,
  stories, channels or fabricated presence (purged in Phase 0; the shipped
  `data/store.json` is the empty snapshot). Demo data exists only via the
  opt-in generator in `docs/DEMO_DATA.md`.
