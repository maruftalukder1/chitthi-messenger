# Phase 1 — Implementation Report (running log)

**Spec:** `ROADMAP_SELLABLE.md` Phase 1 (1.1–1.9), implemented in roadmap order with
wave parallelisation by file ownership. **Coordinator-owned gates after every
fix-group:** `npx tsc --noEmit` · `npm run build` · WS suite · security suite ·
OTP suite · headless production smoke (CDP Chromium, zero console errors).
Test servers always run with a scratch `CHITTHI_DATA_DIR` (Phase 0 rule).

## Baseline (before any Phase 1 change) — 2026-10-30
- `npx tsc --noEmit` → **0 errors** · `npm run build` → **green**
- WS suite **6/6 PASS** · security suite **18/18 PASS** · OTP suite **6/6 PASS**
- Production smoke (headless Chromium, fresh scratch store): login screen,
  **0 console problems**.

## Protocol contract v2 (Phase 1 additions; all teams build against this)

Auth on all new REST: same as Phase 0 (`Authorization: Bearer <Firebase ID token>`,
or `X-Demo-User` in demo mode only). Caller identity = server session userId.

- **User directory (server):** profiles live in Firestore, but the server keeps a
  public directory for claims/search: `POST /api/users/register {name, avatar?,
  about?, mood?, discoverable?, privacy?}` upserts the caller's entry (username is
  NEVER set here). `privacy = {photo, about, lastSeen, findMe, groupAdd}` each
  `'everyone'|'contacts'|'nobody'` (findMe: `'everyone'|'nobody'`).
  `GET /api/users/search?q=` (auth) → exact-username (case-insensitive) or
  name-prefix matches over directory entries with `discoverable !== false` and
  `privacy.findMe !== 'nobody'`; returns `{id, name, username, avatar, about,
  mood, privacy}` (client applies audience rendering; `contacts` ≈ room
  co-members). `DELETE /api/users/me` → deletes directory entry, releases
  username, drops sessions (account-delete support).
- **Usernames:** validation 5–20 chars, `[a-z0-9_]`, starts with a letter, no
  leading/trailing/consecutive `_`. Reserved: admin, support, chitthi, team,
  official, maruf, help, system, root, null, undefined, about, login, signup,
  settings, api, www. `GET /api/usernames/check?handle=` → `{available, reason?}`
  (format | reserved | taken | grace). `POST /api/usernames/claim {handle}` →
  atomic claim; caller's previous handle moves to a 14-day reclaim grace
  (reclaimable only by the same user). `DELETE /api/usernames` releases (grace
  applies). Store: `usernames{}`, `releasedHandles{}` persisted in snapshot.
- **Sessions:** WS login payload gains optional `deviceLabel`, `presenceMode`
  (`online|away|invisible`; invisible → presence broadcast as offline, still
  receives everything). Server tracks live sessions per user.
  `GET /api/sessions` (auth) → caller's live sessions `[{sessionId, deviceLabel,
  connectedAt, lastActive, current}]`. `POST /api/sessions/revoke {sessionId}`
  → server sends that socket `session:revoked` and closes it (client logs out
  locally). `POST /api/sessions/revoke-others`. **Login alerts:** first-seen
  deviceLabel for a user → best-effort email via existing SMTP config (silent
  skip when SMTP unset).
- **Presence:** server presence payloads include `lastSeenAt` (real timestamp)
  only when the subject's `privacy.lastSeen` allows the viewer (everyone → all;
  contacts → room co-members; nobody → field omitted).
- **Scheduled (server-side):** store `scheduled[]` persisted.
  `POST /api/scheduled {roomId, message, dueAt}` (owner = caller; message is a
  full ChatMessage payload minus id/timestamp, server assigns both at fire
  time), `GET /api/scheduled` (caller's, any status), `PATCH /api/scheduled/:id
  {dueAt?, message?}` (pending only), `DELETE /api/scheduled/:id`,
  `POST /api/scheduled/:id/retry`. Server sweeper (5 s): due → delivered through
  the normal send path (room ACL + block checks apply); exactly-once by
  schedule id; owner notified `scheduled:sent {id, messageId}` or
  `scheduled:failed {id, reason}` (item kept, status `failed`).
- **Reminders:** store `reminders[]` persisted. `POST /api/reminders {roomId,
  messageId, dueAt}` (owner = caller), `GET /api/reminders`,
  `PATCH /api/reminders/:id {dueAt}` (snooze), `DELETE /api/reminders/:id`.
  At due time server sends the owner `reminder:due {reminder}` (client adds the
  Saved-Messages entry + banner). Item auto-completes after firing.
- **Uploads:** `POST /api/uploads` (auth) JSON `{name, mime, dataBase64}` →
  stored under `$CHITTHI_DATA_DIR/uploads/<24-hex>.<ext>`, cap 25 MB, returns
  `{url: '/uploads/<file>', name, size, mime}`. Files served at `GET
  /uploads/:file` (unguessable names; member-check is a documented Phase-1
  limitation). Media messages carry `content = url` plus existing
  `fileName/fileSize`; new optional message fields: `mimeType?`, `storyRef?`,
  `contactCard?` (username), `stickerPack?/stickerId?` via type `'sticker'`
  with `content` = asset URL.
- **History paging (cap lift):** the destructive 200-message caps are REMOVED
  (all messages retained in the store). `room:history` request gains
  `{before?: messageId, limit?: number}` (default page 200, newest first page);
  response gains `hasMore: boolean`, `oldestId?: string`. Backward compatible:
  no `before` → latest page, same shape as before plus the two fields.
- **Global search:** `GET /api/search?q=&roomId?` (auth) → up to 100 matches
  across rooms the caller may access; matches text content + fileName; returns
  `[{roomId, message: {id, senderId, senderName, timestamp, type, content,
  fileName}}]`.
- **Stars:** snapshot-based, per user: `GET /api/stars`, `POST /api/stars
  {message}` (full snapshot), `DELETE /api/stars/:messageId`. Persisted.
- **Call logs:** `POST /api/call-logs {peerId, type, direction, durationSec,
  startedAt}` → stored for caller AND mirrored for the peer (direction
  flipped). `GET /api/call-logs` → caller's latest 200.
- **Channels:** gains `inviteCode?`, `inviteEnabled?`, `joinApproval?`,
  `joinRequests?: string[]`, `permissions?: {post, pin, manage}` (values
  `'all'|'admins'`), `events?: [{id, title, startsAt, createdBy, rsvps:
  Record<userId,'yes'|'no'|'maybe'>}]`, sections may gain `readOnly?: boolean`.
  `POST /api/channels/:id/invite` (owner/admin) → (re)generates code.
  `DELETE /api/channels/:id/invite` (owner/admin) → revokes.
  `POST /api/channels/join {code}` (auth) → approval off: caller added to
  memberIds, returns channel; approval on: caller added to joinRequests,
  returns `{pending: true}`. `DELETE /api/channels/:id` (owner only) →
  deletes channel + its messages. Server send-path: message to a `readOnly`
  section by a non-owner/admin is dropped; `permissions.post === 'admins'`
  applies the same to the whole channel.
- **Stories:** story gains `audience?: {mode:'everyone'|'contacts'|'close'|
  'custom', userIds?}`, `kind?: 'image'|'text'|'video'` (existing `type` field
  keeps its current meaning if already used — implementer maps carefully),
  `textData?: {text, bg, font}`, `reactions: [{userId, emoji}]`.
  GET /api/stories filters by audience (contacts ≈ co-members; close/custom by
  list). `POST /api/stories/:id/react {emoji}` toggles caller's reaction.
  Story mutes: `GET/POST/DELETE /api/stories/mutes` (`{userId}`) — muted
  authors excluded from caller's GET. Highlights (snapshots, survive expiry):
  `GET /api/highlights?userId=`, `POST /api/highlights {story}` ,
  `DELETE /api/highlights/:id`.

## Wave plan
- **Wave 1 (parallel, disjoint files):** Team S `server.ts` (+ suite
  extensions) · Team ST `StoriesBar.tsx` · Team CA `VoiceCallModal.tsx` +
  `CallsScreen.tsx` · Team GI `GroupInfoScreen.tsx` · Team I `firebase.ts`,
  `LoginScreen.tsx`, `UserProfileModal.tsx`, `SettingsScreen.tsx`,
  `OfflineQrModal.tsx`, new `ProfileCard.tsx`, new `ClaimUsernameModal.tsx`.
- **Wave 2 (after Wave 1 gates):** Team CV `ChatViewScreen.tsx` · Team CL
  `ChatsScreen.tsx` + `App.tsx` (+ glue notes from Wave 1 teams).

## Item log

### Team GI — 1.5 groups — DONE (team-local)
- `src/types/chat.ts`: contract fields added (`ChannelPermissions`,
  `GroupEvent`, `inviteCode/inviteEnabled/joinApproval/joinRequests/
  permissions/events`, `GroupSection.readOnly`).
- `GroupInfoScreen.tsx`: invite links (generate/regenerate/revoke via server
  endpoints, copy), join-approval toggle + request approve/reject, leave group
  (self-removal via persistChannelUpdate), delete group (owner, type-to-confirm,
  `DELETE /api/channels/:id`), permission matrix UI (post/pin/manage),
  announcement (readOnly) section toggle in create/edit, NEW add-member picker
  by user ID (none existed — the import was dead), group events with RSVP.
- **Wiring notes:** (1) App must wire new optional `onLeaveGroup`/
  `onDeleteGroup` props on both GroupInfo instances (fallback today:
  `onBack()`). (2) Team S addendum sent: member self-removal + events/RSVP
  updates must be allowed by channel-update auth (narrow relaxation). (3) Team
  CV: composer gating for `permissions.post`/`section.readOnly`. (4) Team CL:
  join-by-code entry point in ChatsScreen/App.
- **Gate (team-local):** tsc 0 errors in GI's files (StoriesBar errors are Team
  ST mid-edit, expected).

### Team ST — 1.1 stories enrichment — DONE (team-local)
- `StoriesBar.tsx` (only file): viewers list polish (newest-first, exact +
  relative times, per-viewer reaction emoji); audience selector on both
  composers (Everyone/Contacts/Close/Custom + searchable picker; per-user
  remembered default `chitthi_story_audience_<userId>`, close list
  `chitthi_close_friends_<userId>`); emoji reactions (one per user, toggle,
  optimistic + server reconcile via `POST /api/stories/:id/react`); text
  stories (8 backgrounds, 5 fonts incl. বাংলা, `kind:'text'` + `textData`);
  video stories (playback-tied progress, tap mute/unmute, onEnded advance);
  highlights (snapshot POST survives 24h expiry, own-highlights row + viewer +
  delete, reusable `HighlightsRow` export); story mutes (avatar menu + viewer
  button, quiet "Muted (n)" management row with unmute); delete-own verified.
  All new server fields mapped defensively; every new endpoint best-effort
  with local fallback until Team S lands.
- **Wiring notes (Team CL):** reply-to-story chain — StoriesBar's new optional
  `onReplyToStory(payload)` prop → ChatsScreen forwards `onStoryReply` → App
  `handleStoryReply` opens the DM (roomId = authorId) and sends with
  `storyRef` once the ChatMessage field lands (interim: `replyTo` quote).
  Nothing is silently dropped pre-wiring (draft kept + hint shown).
  ProfileCard should consume `HighlightsRow` for other users' highlights.
- **Gate (team-local):** `npx tsc --noEmit` **0 errors project-wide**.

### Team S — server (all contract items + addenda #1/#2) — DONE
- `server.ts`: user directory + search + DELETE /api/users/me; username
  check/claim/release with 14-day grace (atomic, persisted); sessions
  (`session:ready`, list/revoke/revoke-others, first-seen-device login alerts
  via SMTP when configured — Firebase-token logins only, email from token);
  per-viewer presence (invisible → offline, lastSeenAt audience-filtered,
  real timestamps); server scheduled queue (5 s sweeper through the normal
  send path, exactly-once, sent/failed notices); reminders (due → 
  `reminder:due`, auto-complete); uploads (25 MB cap, unguessable names,
  unauthenticated serving per contract); **200-message caps removed** +
  paged `room:history`; global search endpoint; stars; call logs (verbatim
  `callType`/`logType` after addendum #2, DELETE single + clear); channels
  (invite generate/revoke/join incl. approval queue, owner-only delete,
  readOnly + permissions.post send-path enforcement, member-only-update
  narrow relaxation from addendum #1); stories (audience filter, reactions
  toggle, mutes, highlights).
- Suite extended: `docs/qa-security-test.mjs` now **31 checks** (13 new:
  usernames, member events/leave, scheduled delivery, search scoping,
  uploads, stars) — all passing in S's own run and the coordinator's.

## WAVE 1 GATES — coordinator-run, all Wave 1 teams in
- `npx tsc --noEmit` → **0 errors** · `npm run build` → **green**
- WS suite **6/6 PASS** · security suite **31/31 PASS** · OTP suite **6/6 PASS**
- Production smoke (headless Chromium, fresh scratch store): login screen,
  **0 console problems**.
- (Gate-tooling note: the security suite needs three servers — demo :3000,
  strict :3001, no-flag :3002; the runner now starts all three.)

### Team CA — 1.3 calls enrichment — DONE (team-local)
- `VoiceCallModal.tsx`: screen share via getDisplayMedia + replaceTrack
  (added-sender + renegotiation path for audio calls; browser stop-sharing
  handled; camera track preserved incl. mute state; peer share renders in a
  muted display-only element — Phase 0 single-audio-element echo fix intact);
  connection-weak badge from getStats polling (RTT >600 ms or loss >8%, 2
  consecutive degraded polls to show). Regression pass: redial verified
  peer-only end-to-end + hardened (no peerId → visible failure, never an
  untargeted invite; no untargeted 'end' signal); camera flip fixed twice
  (no-op while sharing; re-acquired track inherits mute state); audio-only
  fallback + busy/declined/tones verified unchanged.
- `src/services/callLogService.ts` (new): postCallLog/fetchCallLogs via
  authHeaders, never-throw; `CallsScreen.tsx` merges server + local logs
  (dedupe peerId+startedAt), delete/clear hides server rows locally.
- **Contract mismatch (resolved client-side, S follow-up sent):** landed
  server treats `type` as call kind and collapses `declined`→`missed` in the
  server copy (local log stays precise); client round-trip vs the landed
  transform proven by stubbed-fetch test. Addendum #2 to Team S: persist
  `callType`/`logType` verbatim + add `DELETE /api/call-logs/:id` and
  `DELETE /api/call-logs` (today hidden server rows return on remount).
- **Wiring note (Team CL):** App `onCallEnded` gains one `postCallLog(...)`
  call after `setCallLogs` + a `callStartedAtRef` captured at session open
  (exact snippet in CA's report).
- **Known quirk (accepted, Phase 0 design):** the ~20 s connecting timeout
  starts at invite-send and can fail a still-ringing call before the 30 s
  no-answer timer.
- **Gate (team-local):** tsc **0 errors project-wide** · `vite build` green.

### Team I — 1.4 identity system + 1.7 UI + scheduled manager — DONE (team-local)
- `firebase.ts`: directory/username/session helpers via a non-throwing
  `apiRequest` wrapper (`reachable` flag distinguishes offline from empty);
  `PrivacyAudiences` load/save (`chitthi_privacy_v1`); `syncUserProfile`
  extended with optional `about` (existing callers unaffected); Firebase
  re-auth/update/delete re-exports.
- `UserProfileModal.tsx`: username field with debounced live availability;
  save is **fail-closed** — a changed handle is claimed via the server BEFORE
  anything applies; any failure blocks the save with inline error. About split
  shipped (multi-line About, 160 cap, factory-default `status` NOT migrated;
  mood line kept).
- `LoginScreen.tsx`: optional username at sign-up (live check; unreachable
  server skipped silently), best-effort claim at OTP activation.
- `ClaimUsernameModal.tsx` (new): self-contained post-login claim prompt
  (performs the server claim itself).
- `ProfileCard.tsx` (new): other-user card — audience-aware rendering (photo
  hidden → initials; About/lastSeen omitted when hidden), full-screen photo,
  linkified About, Message/Call/Block, shared-media row.
- `SettingsScreen.tsx`: privacy audience pickers (persisted locally + posted
  to directory); real Account centre (email, Firebase change password/email
  with re-auth, Active sessions with per-session + all-others revoke, Delete
  account type-to-confirm full wipe path, Erase-device-data with honest
  warning); Scheduled manager page (server queue: list/edit/cancel/retry);
  honest Privacy Policy view (not-E2EE stated plainly).
- `OfflineQrModal.tsx`: `chitthi://user/…` scheme routing via new
  `onAddContact` prop (never posted as a chat message), Add-contact vs
  Offline-transfer mode separation, My QR uses the username payload.
- **Wiring notes (Wave 2):** (CL/App) remove App's fail-open uniqueness block
  (~L1469–1494) + add `about` to its syncUserProfile call; mount
  ClaimUsernameModal post-login with a per-user prompted flag; wire QR
  `onAddContact` → searchUsers → ProfileCard; socketService `session:revoked`
  dispatch + `onSessionRevoked` → App handleLogout; ProfileCard mounts at DM
  header / @mention (CV), directory search + QR (CL), group member rows (GI
  follow-up), plus HighlightsRow consumption in ProfileCard (I follow-up).
- **Gate (team-local):** `npx tsc --noEmit` **0 errors project-wide**.

## WAVE 2 — log

### Team I-followup — ProfileCard highlights/share + presence picker — DONE
- `ProfileCard.tsx`: Highlights section (fetches `GET /api/highlights` with
  the viewer's own auth; hidden when photo/about audience blocks; local
  snapshot viewer for image/video/text highlights); optional `onShareContact`
  prop + button (picker is Team CL's wiring).
- `SettingsScreen.tsx`: presence picker (Online/Away/Invisible) in the
  Privacy modal, persisted to `chitthi_presence_mode`, calls
  `socketService.setPresenceMode` via a guarded dynamic access once Team CL
  provides it. Invisible semantics stated in EN + BN copy.
- **Gate (team-local):** tsc **0 errors project-wide**.

### Team CL — App/ChatsScreen/socketService glue + 1.8/1.9.1/1.9.6 — DONE
- All Wave 1 wiring landed: App fail-open username block REMOVED (+ `about`
  in syncUserProfile); ClaimUsernameModal mounted post-login with prompted
  flag; QR `onAddContact` → searchUsers → ProfileCard; `session:revoked`
  registry → forced logout + "signed out from another device" banner;
  story-reply chain (ChatsScreen forwards, App sends with `storyRef`);
  `postCallLog` in onCallEnded with `callStartedAtRef`; GroupInfo
  onLeaveGroup/onDeleteGroup + messages/onJumpToMessage/onCallMember on
  both mounts; ChatView meta pass-through (mimeType/sticker/contactCard/
  storyRef) + receipts arrays retained on messages; `onOpenUserChat` wired.
- Global search modal (header + Ctrl/Cmd+K): GET /api/search grouped by
  chat, highlighted snippets, recent searches; tap → open room + page
  history via new `socketService.fetchHistoryPage()` (≤5 pages) + jump/flash.
  Find-people panel (searchUsers → ProfileCard → DM). Chat-row context menu
  (pin/mute 8h·1wk·always via `mutedUntil`/archive/mark-unread/add-to-list),
  italic Draft previews, pinned only in the grid (cap 5), Saved panel with
  hashtag filters + source grouping, custom lists (`chitthi_lists_v1`,
  chips with unread counts). Scheduling migration on login (local queue →
  server, no double-fire; saved_messages items + server rejections stay
  local by design); `reminder:due` → Saved entry + View/Dismiss banner;
  fired-while-away reminders recovered via on-login fetch + per-device seen
  set (NOT lost — server retains `done` reminders). Presence picker wired
  (`setPresenceMode` re-sends login frame; server has no dedicated frame).
- **Coordinator micro-fixes (from CL's notes):** (1) X-Session-Id for REST —
  socketService persists the session id to sessionStorage and firebase.ts
  `authHeaders` reads it (no import cycle); (2) ChatViewScreen
  `lastJumpIdRef` reset when `jumpToMessageId` clears, so repeat jumps to
  the same message re-scroll. **Follow-up dispatched to CL:** join-by-code
  entry point (roadmap 1.5) — the one GI note CL's brief didn't number.
- **Gate (team-local):** tsc **0 errors project-wide** · build green.

### Team CV — ChatViewScreen (1.2, 1.6 composer, 1.8, 1.9.2/1.9.4/1.9.5) — DONE
- Universal quote-reply for every message type (human labels, media
  thumbnails, tap-to-jump via a shared `jumpToMessage()`); poll multi-choice
  voting rewrite + quiz mode (reveal after voting; `correctOptionId` travels
  with the message — UX courtesy, not secrecy, noted in code); named group
  typing ("X and N others…"); Message Info panel (read-by/delivered lists
  from receipt arrays, status fallback); composer gating for
  `permissions.post`/readOnly sections.
- In-chat search v2: in-place match rings + `<mark>` highlight, n-of-N
  stepping, section/room scope, `from:`/`has:`/`before:`/`after:` parser +
  chips. Chat export HTML/JSON/TXT (spec fields, tombstones excluded).
  Star (server snapshots, ★ marker), one-tap Save, Remind-me presets →
  `POST /api/reminders`. Drafts store `{text, replyTo}`; cancel-edit restores
  the draft.
- Composer media: uploads via `POST /api/uploads` (XHR progress bubble,
  legacy fallback only on request failure); GIF picker via new
  `gifService.ts` (Klipy/GIPHY behind `VITE_GIF_PROVIDER`/`VITE_GIF_API_KEY`;
  unconfigured → designed empty state, NO fake feed); 2 bundled original SVG
  sticker packs ×8 (`public/stickers/`, verified in dist); voice recorder
  mime picked from `isTypeSupported` candidates (Safari mislabel fixed).
- Scheduling creation posts to `POST /api/scheduled` (success copy: "will
  send even if you close Chitthi"); server failure → local queue + stay-open
  notice (honest dual path).
- ProfileCard mounts: DM header + menu, tappable @mentions, contact-card
  rendering; DM shared-media panel (1.9.3 parity) with jump-to-message;
  `jumpToMessageId` prop per addendum.
- **Wiring notes (Team CL, addendum #2 sent):** App meta pass-through for
  mimeType/stickerPack/stickerId/contactCard/storyRef; App onReceipts must
  also store the deliveredTo/readBy arrays; wire `onOpenUserChat`.
  Coordinator: add the two GIF env vars to `.env.example`.
- **Gate (team-local):** tsc **0 errors project-wide** · build green.

### Team GI-followup — 1.9.3 group media browser + member ProfileCard — DONE
- `GroupInfoScreen.tsx`: real shared-media tabs from the room's messages
  (Images grid incl. multi-image messages, Videos, Docs with real download
  anchors, new Links tab with domain/sender) with real counts and designed
  empty states; member-row tap opens ProfileCard (Message → existing DM
  flow, Block → Phase 0 flow, shared-media count + jump-to-tab).
- **Gap found:** GroupInfoScreen received NO messages prop — App computes
  `activeRoomMessages` but never passed it. Addenda sent: Team CL wires
  `messages` + `onJumpToMessage` (+ `jumpToMessageId` state) + `onCallMember`
  into both mounts; Team CV adds the consuming `jumpToMessageId` prop
  (section switch + highlight + scroll). Until CL lands, tabs honestly show
  empty states.
- **Gate (team-local):** tsc **0 errors project-wide**.

### Join-by-code micro-team — 1.5 entry point — DONE
- `ChatsScreen.tsx`: "Join group" header action + dialog; exported
  `extractInviteCode` (accepts `chitthi://join/<code>`, any URL ending in
  the code, or the bare code); POST /api/channels/join with inline
  invalid/revoked errors (EN/BN). `App.tsx`: `handleJoinChannel` reuses the
  `channel:created` upsert; pending → approval toast. tsc 0.

### Coordinator integration micro-fixes — DONE
- `socketService.ts`: `session:ready` id mirrored to sessionStorage
  (cleared on disconnect); `firebase.ts` `authHeaders()` sends
  `X-Session-Id` from sessionStorage (no import cycle) — Settings' "This
  device" session tag now works.
- `ChatViewScreen.tsx`: `lastJumpIdRef` resets when `jumpToMessageId`
  clears — repeat jumps to the same message re-scroll.
- `.env.example`: `VITE_GIF_PROVIDER` / `VITE_GIF_API_KEY` documented
  (owner creates the key; picker stays an honest empty state until then).

## FINAL GATES — 2026-10-30 (coordinator-run, all of Phase 1 in)
- `npx tsc --noEmit` → **0 errors**
- `npm run build` → **green** (dist 1.8 MB incl. sticker assets; chunk-size
  warning only — code-splitting is Phase 5)
- WS suite → **6/6 PASS** · Security suite → **31/31 PASS** · OTP suite →
  **6/6 PASS**
- **Production smoke** (headless Chromium, fresh scratch store): login
  screen, **0 console problems**.
- Shipped `data/store.json` verified still the pristine empty snapshot
  (0 channels / 0 rooms / 0 stories) — all QA ran on scratch data dirs.
- `firestore.rules` was NOT edited in Phase 1 (no new match block was
  needed — identity runs through the app server) and NOT deployed.

## Phase 1 EXIT GATE (roadmap wording) — assessment
"Two real accounts on two devices can find each other by @username or QR,
star/save/schedule/search/export, share real media and GIFs, and administer
a group whose state is identical on both devices."
- Find by @username / QR: ✅ server-enforced claims + directory search +
  QR add-contact routing (code-complete; two-device proof is the owner's).
- Star / save / schedule / search / export: ✅ all shipped; scheduling is
  server-side now (fires with the app closed, exactly-once).
- Share real media: ✅ upload pipeline ends base64-in-messages for new
  sends (legacy fallback only on upload failure). **GIFs: ⚠️ picker ships
  with the config slot + honest empty state — a live GIF feed needs the
  owner's free Klipy/GIPHY API key (owner knock, per Phase 1 rules).**
- Group administration identical on both devices: ✅ server-persisted
  (Phase 0) + Phase 1 invite/leave/delete/permissions/events, with the
  member-update relaxation proven by suite checks P2a–P2c.

## Blocked / deferred — with reasons (nothing silently dropped)
- **Live GIF feed** — needs an owner-created Klipy/GIPHY API key. Picker,
  service, and env slots are in; zero fake data shown meanwhile.
- **Highlights on OTHER users' profiles from group member rows** — done via
  ProfileCard (highlights included); the group media tabs depend on App
  passing `messages`, which is wired (CL addendum #1).
- **`docs/FEATURE_MATRIX.md`** still describes the Phase 0 feature set —
  doc refresh recommended before any buyer demo (packaging task, not a
  Phase 1 gate).

## Owner knocks (Phase 1 additions in bold)
1. Deploy `firestore.rules` via Firebase Console (unchanged from Phase 0;
   Phase 1 added NO rules changes).
2. Two-device in-call media test — now also covers screen share +
   connection-weak badge (code-verified only).
3. **Create a free Klipy (or GIPHY) API key and set `VITE_GIF_PROVIDER` +
   `VITE_GIF_API_KEY` at build time to light up the GIF picker.**
4. Firestore cloud sync (next architecture step).
5. Hosting session (parked by owner 2026-10-30; deploy zip predates
   Phase 1 — rebuild before use).
6. SMTP live test (login-alert emails ride the same SMTP path).
7. Paid TURN decision. 8. GitHub push (per-push say-so).
