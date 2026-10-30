# Phase 0 — Implementation Report (running log)

**Spec:** `ROADMAP_SELLABLE.md` Phase 0 (0.1–0.12), implemented in roadmap order with
dependency adjustments noted per item. **Coordinator-owned gates after every fix-group:**
`npx tsc --noEmit` · `npm run build` · WS suite (`docs/qa-ws-test.mjs`) · OTP regression
(`docs/qa-otp-test.mjs`) · smoke (health + app boot). Test servers always run with a
scratch `CHITTHI_DATA_DIR` so the shipped `data/store.json` is never polluted by QA.

## Baseline (before any Phase 0 change) — 2026-10-30

- `npx tsc --noEmit` → **0 errors**
- `npm run build` → **green** (chunk-size warning only)
- WS suite vs scratch store → **ALL WS TESTS PASSED** (6 checks)
- `GET /api/health` → `{status:"ok"}`

## Protocol contract v1 (all teams build against this)

- **WS login:** `{type:'user:login', userId, username, idToken?}`.
  - `idToken` present → server verifies it (Firebase JWKS, project `modern-patrol-vt3g1`).
    Valid → `session.userId` must equal token `sub`; mismatch → `{type:'auth:error',
    error:'identity_mismatch'}`, socket NOT authenticated. Invalid → `auth:error 'invalid_token'`.
  - No `idToken` → authenticated as the asserted `userId` **only** when demo auth is enabled
    (`CHITTHI_ALLOW_UNAUTH_DEMO==='true'` AND `NODE_ENV!=='production'`); otherwise
    `auth:error 'token_required'`. Demo bypass is hard-disabled in production.
- **New WS events:** server→client `auth:error`, `message:ack {messageId, roomId}`,
  `message:receipts {roomId, messageId, deliveredTo[], readBy[]}`;
  client→server `message:read {roomId, messageIds?}`.
- **Room access:** known channel room → if `memberIds` non-empty, owner/admins/members only;
  empty/absent = open (legacy). DM room id = `[idA, idB].sort().join('__')` → only those two
  user IDs. Unknown room → any authenticated session (server logs it). Broadcasts
  (`message:new`, `message:updated`, `typing:indicator`) are filtered by room access.
  `room:history` is served only with access, excludes expired (`expiresAt <= now`) messages
  and purges them.
- **Channels REST:** `GET /api/channels` public. `POST /api/channels` requires auth:
  `Authorization: Bearer <Firebase ID token>` (verified), or — demo mode only —
  `X-Demo-User: <userId>`. Create → server forces `ownerId` = caller; `memberIds` from
  payload (owner always included). Update → caller must be owner or in `adminIds`, else 403.
  `ServerChannel` gains `ownerId`, `memberIds[]`, `adminIds[]`; `membersCount` derived from
  `memberIds` when present. Existing `channel:created` event = upsert broadcast to members.
- **Stories REST:** `GET /api/stories` (auth as above) → unexpired stories, excluding users
  the caller blocked. `POST /api/stories` creates with `authorId` = caller.
  `POST /api/stories/:id/view` records a viewer. `DELETE /api/stories/:id` author-only.
  Story shape: `{id, userId, userName, userAvatar, media, type, createdAt, expiresAt,
  viewers: [{userId, viewedAt}]}`.
- **Blocks/reports REST:** `GET /api/blocks` → caller's blocked user IDs;
  `POST /api/blocks {blockedId}`; `DELETE /api/blocks/:blockedId`;
  `POST /api/reports {reportedId, reason?}` (stored server-side). Enforcement: a DM
  `message:send` or call `invite` from a user blocked by the recipient is dropped server-side.
- **Receipts:** server stores `deliveredTo[]`/`readBy[]` on each message (persisted in the
  store snapshot). Delivery to a member session adds to `deliveredTo` and emits
  `message:receipts` to the sender; `message:read` adds to `readBy` (implies delivered).
- **Poll anonymity:** poll messages are serialised per-recipient — sender + channel
  owner/admins see `voterIds`; everyone else gets `voterIds: []` plus `voterCount` per
  option. Client poll UI must use `voterCount ?? voterIds.length` for counts.
- **OTP:** `POST /api/auth/send-2fa-code` includes `code` in the response **only** when
  `CHITTHI_DEMO_OTP==='true'` AND `NODE_ENV!=='production'`. Endpoint paths unchanged;
  all user-visible copy says **"Email verification"**, never "2FA".
- **Identity (client):** `firebase.ts` exports `getCurrentIdToken(): Promise<string|null>`,
  `deriveEmailUserId(email)` (the legacy `` `user_${email…}` `` derivation, single home),
  and profile helpers. Firestore `users/{docId}` key = **Firebase UID** for Firebase-backed
  accounts; on login, if a legacy `user_<email>` doc exists and no UID doc does, its fields
  are copied to the UID doc (legacy doc left untouched). `syncUserProfile` accepts optional
  `status`; new profile writes omit `email` from the public doc and write it to
  `users/{id}/private/contact` instead; `fetchAllUsers` strips `email` defensively.
- **REST auth helper (client):** `authHeaders()` in `firebase.ts` → Bearer token when a
  Firebase user exists, else `X-Demo-User: <current app userId>` (accepted by the server
  only in demo mode).
- **Settings prefs:** localStorage `chitthi_settings_v1` (JSON). ChatViewScreen reads
  `enterToSend` from it; SettingsScreen writes it.

## Item log

### Dispatch — 2026-10-30
- **Team B** (auth/profile client): firebase.ts, LoginScreen.tsx, UserProfileModal.tsx, firestore.rules — 0.1 Firestore OTP-leg removal + password upgrade, 0.9 identity/UID/avatar/email.
- **Team G** (packaging): README.md, package.json, LICENSE, .env.example, docs/FEATURE_MATRIX.md — 0.12.
- **Coordinator** (self): server.ts (0.1/0.3/0.5/0.6/0.11 server side, 0.4 server seed + store purge), test suites, gates.
- Client teams for App/ChatView/GroupInfo/Stories/Settings/Calls dispatch after the server lands.

_(gate evidence appended per fix-group below)_

### Server group — 0.1 / 0.3 / 0.5 / 0.6 / 0.11 (server.ts) + 0.4 server seed — DONE
- **0.1 identity:** Firebase ID tokens verified server-side (JWKS RS256, project
  `modern-patrol-vt3g1`, fail-closed). WS login binds session to token `sub`; claimed
  userId mismatch → `auth:error identity_mismatch`; garbage token → `invalid_token`;
  no token outside explicit demo mode (`CHITTHI_ALLOW_UNAUTH_DEMO=true`, hard-disabled
  when `NODE_ENV=production`) → `token_required`.
- **0.1 broadcast scoping:** `message:new`/`message:updated`/typing delivered only to
  sessions with room access (channel memberIds/owner/admins; DM pair; open legacy).
  `room:history` denied to non-members (`room:denied`). Untargeted call signals are
  room-scoped, never global.
- **0.1 channel writes:** `POST /api/channels` requires auth (Bearer or demo header);
  create forces `ownerId` = caller; update restricted to owner/admins (403 otherwise);
  `memberIds` sanitised to user IDs, `membersCount` derived.
- **0.1 OTP:** response includes the code only when `CHITTHI_DEMO_OTP=true` and not
  production; all user-visible copy renamed "2FA" → "Email verification" (subject, body,
  API messages). Server remains the only OTP path once Team B removes the Firestore leg.
- **0.3 server:** channel owner/members/admins persisted in the store snapshot;
  poll messages serialised per-recipient (non-privileged get `voterIds: []` +
  `voterCount`); expired messages purged and excluded from history.
- **0.5 server:** `deliveredTo`/`readBy` tracked per message and persisted;
  `message:ack` to sender; `message:receipts` pushed on delivery and on `message:read`.
- **0.6 server:** `/api/stories` GET/POST/view/DELETE (auth required, 24h expiry,
  block-filtered, author-only delete), persisted in the snapshot.
- **0.11 server:** `/api/blocks` GET/POST/DELETE + `/api/reports` POST (report implies
  block), persisted; DM sends and call invites across a block are dropped server-side.
- **0.4 server:** both `fullsnack_designers` seed blocks deleted (incl. the unreachable
  post-load duplicate); shipped `data/store.json` purged to a fresh-install state
  (removed debris inventory: `qa hello bob` ×5, rooms `dbg_room`, `qa_update_*`,
  `qa_persist_r3`, `user_darlene`, and the seeded channel with its fabricated
  lastMessage/Unsplash avatar).
- **Tests added:** `docs/qa-security-test.mjs` (18 checks), `docs/qa-otp-test.mjs`
  (6 checks).
### Packaging — 0.12 (Team G) — DONE
- README.md fully rewritten (product, run/prod, architecture, env table, honest
  limitations incl. no-E2EE + 200-cap + free TURN). package.json renamed
  `react-example@0.0.0` → `chitthi@1.0.0`. LICENSE created (MIT, © 2026 Maruf
  Talukder — coordinator's choice, reversible). .env.example rewritten with the
  8 code-verified vars (PORT, NODE_ENV, SMTP_HOST/USER/PASS/PORT,
  CHITTHI_DATA_DIR, DISABLE_HMR) + the 2 Phase-0 demo flags marked
  never-in-production; GEMINI_API_KEY/APP_URL removed as unused.
  docs/FEATURE_MATRIX.md rewritten to the shipped-v2 truth from BUILD_REPORT.
  Coordinator verified: both demo-flag strings present in server.ts (8 refs —
  Team G's grep predated the server edit), package name/version correct.

- **Gates:** `tsc --noEmit` **0** · `npm run build` **green** · WS suite **6/6 PASS** ·
  security suite **18/18 PASS** · OTP suite **6/6 PASS** · health OK on all instances.
  (First run note: an orphaned pre-change server held port 3000 and produced a false
  S1 failure; identified via EADDRINUSE in the new instance's log, killed, full
  re-run green — gates must always run via `/tmp/run-gates.sh`-style PID-managed
  starts.)

### Team B — 0.1 client (OTP leg + passwords) / 0.9 (identity, profile, avatar) — DONE
- **OTP OR-path removed:** `validateTwoFactorCode`/`saveTwoFactorCode` deleted from
  `src/services/firebase.ts` (verified single/zero callers first); LoginScreen
  `handleVerifyOtpSubmit` is now server-only and surfaces the server's error verbatim.
- **Password storage:** PBKDF2-HMAC-SHA-256, 100k iterations, `pbkdf2$iters$salt$hash`
  format; legacy `sha256:`/`insecure-fallback:` verify-only with transparent re-hash on
  successful sign-in; plaintext-migration branch kept. Algorithm verified in Node
  (roundtrip match / wrong-password mismatch).
- **Copy:** all user-visible "2FA" strings → "Email verification" (EN + BN); grep = 0 left.
  Endpoint paths unchanged per contract.
- **Identity/UID:** `firebase.ts` exports `deriveEmailUserId`, `getCurrentIdToken`,
  async `authHeaders(userIdFallback?)`, `fetchUserProfile`, `migrateLegacyUserDoc`.
  LoginScreen keys Firebase-backed accounts by Firebase UID (signup captures the
  credential UID; sign-in/activation resolve UID only when `auth.currentUser` email
  matches, else the synthetic id); legacy `user_<email>` docs copy-migrate to
  `users/{uid}` on login, legacy doc untouched. Repo-wide audit: no other `user_${…}`
  constructions remain in `src/` outside other teams' seed-data scope.
- **Profile sync:** `syncUserProfile` accepts optional `status`; public `users/{id}`
  writes omit `email` (moved to `users/{id}/private/contact`, best-effort);
  `fetchAllUsers` strips `email` defensively. `firestore.rules` gained the nested
  `private/{document=**}` owner-only match — **edit only, NOT deployed (owner knock)**.
- **Avatar:** `uploadAvatar(uid, blob)` → Firebase Storage `avatars/{uid}.jpg`;
  UserProfileModal centre-crops/resizes to 512×512 JPEG (0.85), 5 MB cap with bilingual
  error, data-URL fallback when no Firebase user / on Storage failure, Remove photo
  (generated initials SVG data-URL — no initials rendering exists in the app).
- **Gate (team-local):** `npx tsc --noEmit` **0 errors** at their check time. Full gate
  stack re-runs at integration, once all client teams land.
- **Cross-team note:** App.tsx `syncUserProfile` call site still needs `status:` +
  read-back merge — already in Team C1's assigned scope.

### Team C2 — 0.4 seed purge (chat list side) / 0.5 sort / 0.10 search — DONE
- `src/data/initialData.ts`: deleted `INITIAL_USERS` (6 fabricated people),
  `INITIAL_CALL_LOGS`, `INITIAL_CHANNELS` (seeded `fullsnack_designers` group + seed
  DMs), `INITIAL_MESSAGES`, `GROUP_CHANNELS_LIST` (zero live reads). Kept
  `GROUP_BOOKMARKS` (live) + `createSynthesizedAudioDataUri` (Phase-4 sweep candidate).
- `src/utils/presenceUtils.ts`: identity-based presence branches deleted; presence now
  derives only from real record data (flags / lastSeen / lastActiveTimestamp decay),
  unknown → offline.
- `ChatsScreen.tsx`: render-time recency sort (lastMessageTimestamp → createdAt);
  `users[0]` currentUser fallback removed (prop → stored session → undefined);
  honest search placeholder + description/peer-name matching + designed empty-results
  state; Archived row shows aggregate unread badge.
- **Gate (team-local):** tsc errors only in foreign files — the expected TS2305s for the
  removed exports in App.tsx (×4, Team C1), ChatViewScreen/GroupInfoScreen (×1 each,
  Team D import cleanup). Zero errors in C2's own files.

### Team E — 0.6 stories sync / 0.4 seeds+QR / 0.10 settings+storage / 0.11 privacy — DONE
- `StoriesBar.tsx` rewritten: server is source of truth — GET on mount/user change
  replaces state+cache wholesale (no resurrection of expired/deleted), POST create
  (local fallback only on network failure), POST view, DELETE own; cache + seen-set
  namespaced per user (`chitthi_stories_<userId>`). `seedStories()` + its 3 Unsplash
  fakes deleted (grep 0). Viewer: pause now freezes progress exactly (state-driven
  ticker), "Seen by N" viewers list, redesign-token rings (unviewed gradient / viewed
  neutral).
- `OfflineQrModal.tsx`: hard-coded `user=maruf` payload deleted; default payload built
  from the real stored session, bare payload when no session.
- `SettingsScreen.tsx`: Enter to Send is a controlled toggle persisted to
  `chitthi_settings_v1` (contract key); decorative Message Sound / Group Alerts /
  Media Auto-download rows removed (grep 0) along with both fake Save buttons;
  Ringtone + Data Saver untouched. Storage manager counts app keys only
  (`chithi_`/`chitthi_` prefix) with new drafts/scheduled/TTL/wallpaper groups;
  Clear-all confirm enumerates counts (scheduled, drafts, saved, messages size).
  Privacy page: working Blocked-users list (GET/DELETE `/api/blocks`, optimistic
  unblock); honest encryption paragraph kept byte-identical.
- **Gate (team-local):** tsc 0 errors in all three E files; remaining errors are the
  same foreign TS2305s owned by C1/D.

### Team F — 0.7 calls (ICE restart / media guard / echo) + 0.4 call logs — DONE
- `VoiceCallModal.tsx`: real ICE restart (`pc.restartIce()` + renegotiation offer via
  the existing `call:signal` path; `oniceconnectionstatechange` failed→restart,
  disconnected→3s grace restart; `onnegotiationneeded` gated by a restart flag so
  initial offers are never duplicated; glare handled politely/impolitely by direction).
  Media-failure guard: invite/accept never sent when `getUserMedia` fully failed —
  visible "Camera/microphone unavailable" failure state, no call-log entry for a
  never-signalled call. ~20s connecting timeout with honest failure state + cleanup.
  Echo fix: remote stream attached to exactly ONE element (video element for video
  calls, audio element for audio calls; the other explicitly nulled); speaker toggle
  now drives that actual element. Hard-coded Unsplash peer-avatar fallback replaced
  with initials.
- `CallsScreen.tsx`: peers resolved **by user ID**; unknown peers render initials with
  the stored name — no fabricated users/photos; direction read from stored `log.type`;
  honest empty states added.
- **Gate (team-local):** tsc 0 errors in both F files; remaining errors foreign
  (C1's in-flight App.tsx refactor + C2/D import fallout).
- **Pinpoint forwarded to Team C1:** App.tsx ~L1025–1027 call-log creation still
  resolves the peer by name and fabricates an Unsplash stranger on miss. F extended
  the `onCallEnded` payload with `peerId` so C1 can resolve by ID and store
  `avatar: ''` (CallsScreen renders initials) instead.
- **Owner-knock reminder:** WebRTC behaviour changes are code-verified only — the
  two-device in-call media test remains the owner's proof step.

### Team D — 0.2 admin bypass / 0.3 group persistence / 0.4 fake tabs / 0.5 touch / 0.8 schedule UI / 0.10 voice / 0.11 block-report UI — DONE
- `src/types/chat.ts`: `Channel` gains `ownerId?`/`memberIds?`/`adminIds?`;
  `PollOption.voterCount?` added.
- **`|| true` removed** in both files: `isUserAdmin` = owner / adminIds / legacy
  adminId / memberRoles match. All admin-gated UI keys off it.
- **Persistence:** identical `persistChannelUpdate` wrapper in both screens — normalises
  memberIds by ID (legacy name entries migrated via users list), derives adminIds,
  sets `membersCount = memberIds.length`, POSTs the full channel to `/api/channels`
  with `await authHeaders(currentUser.id)`. Covers rename/avatar/sections/roles/
  permissions/presets/bookmarks/kick.
- **Kick −2 root cause fixed:** GroupInfo previously decremented via onUpdateChannel
  AND via App's `onKickMember`; kick now applies exactly once through
  `persistChannelUpdate` (count = remaining memberIds.length) and no longer calls
  `onKickMember`.
- **Private sections:** member multi-select picker wired to the previously dead
  setter; access check is ID-only (name fallback dropped).
- **Polls:** counts use `voterCount ?? voterIds.length`; own-vote detection uses
  voterIds only; voting keeps voterCount in step.
- **Fake data purged:** GroupInfo media/docs/videos tabs → honest empty states;
  invented online counts removed from both headers; `chithi.app/resources` bookmark
  rewrite + `/pinned` fabrication deleted.
- **Touch:** long-press (500 ms, scroll-safe) + right-click open the same action sheet.
- **Forward/composer:** forward strips `editedAt`/`expiresAt` at hand-off; composer is
  an auto-growing textarea honouring `enterToSend` from `chitthi_settings_v1`
  (Shift+Enter newline; IME-safe).
- **Schedule UI:** modal carries the "app must stay open" amber notice; failed items
  render a retry affordance (needs App to pass `failed` through — forwarded to C1).
- **Voice:** real wall-clock duration, 250 ms timer, waveform decoded from the actual
  audio (placeholder only until decode), real MediaRecorder mimeType/extension.
- **Block/Report UI:** DM menu Block/Unblock + Report; composer replaced by a blocked
  bar with Unblock; GroupInfo member rows gain Ban/Flag actions; all via
  `/api/blocks` + `/api/reports` with authHeaders.
- **Gate (team-local):** tsc 0 errors in D's three files; remaining errors all in
  App.tsx (C1 mid-refactor).

### Team C1 — 0.1 client (WS token) / 0.4 Adina+presence / 0.5 receipts / 0.8 scheduled — DONE
- `socketService.ts`: WS login sends the Firebase ID token (1500 ms race, never blocks
  demo logins); `auth:error` registry — identity errors are fatal (no reconnect loop),
  network drops keep 3 s reconnect; `onAck`/`onReceipts`/`sendRead` added;
  BroadcastChannel restricted to a documented allowlist (login/call/auth/read/presence
  frames dropped both directions).
- `App.tsx`: `currentUser` is `User | null` from the stored session only — the Adina
  `INITIAL_USERS[0]` fallback is gone; users/channels/call-logs/messages all start
  empty on a fresh install; the 15 s presence-fabrication ticker is deleted (presence
  only from server snapshots, `lastSeen` formatted from real timestamps); camera
  fileSize is the real decoded byte length; channel POST carries `authHeaders` and is
  ID-native at creation (`ownerId`/`memberIds`/`adminIds`, count from memberIds);
  `channel:created` is an upsert; **group-call action neutralised** (`onStartCall`
  returns immediately for non-DM rooms — the ring-everyone hazard is dead);
  scheduled sweeper deletes only on `message:ack` (5 s timeout → persisted `failed`,
  retry wired), claim-before-fire cross-tab guard (150 ms re-read, 15 s stale),
  overdue items fire with the scheduled timestamp + `sentLate`; unarchive-on-message;
  Saved Messages copy is honest ("on this device"), incl. migrating persisted lists;
  profile save passes `status:` and a once-per-login read-back merges the server
  profile; receipts wired (DM peer / group all-members semantics, no backward
  movement) with `sendRead` on room open, history load, and arrival in the open room;
  call-log creation resolves the peer by `peerId` (no name match, no fabricated
  avatar); kick handler no longer decrements; forward strips `editedAt`/`expiresAt`
  in App too.
- **Gate (team-local):** `npx tsc --noEmit` **exit 0, zero errors project-wide**.

### Coordinator integration fixes (after all teams landed)
- **Stranger-photo avatar fallbacks purged (0.4, missed by team scopes):** the
  hard-coded Unsplash portrait (`photo-1534528741775…`) silently used as the default
  avatar in ChatsScreen (pinned card + chat row), ChatViewScreen (forward picker +
  poll voter list), the group-header fallback in ChatViewScreen, the GroupInfo banner
  fallback, the Saved Messages channel avatar and the new-group default avatar in
  App.tsx — all replaced with generated initials tiles (brand gradient, same pattern
  as Team B's) / a plain gradient banner / empty avatar. Remaining Unsplash references
  (21) are ONLY deliberate user-choice pick-lists: LoginScreen `DEFAULT_AVATARS`,
  UserProfileModal presets, `CURATED_GROUP_AVATARS` in both group screens — never
  presented as real people or content. (Replacing the pick-lists with generated tiles
  is a design call for Phase 2.)
- **Group-call button removed for group rooms (0.7):** C1 had neutralised the App
  handler; the header buttons in ChatViewScreen still rendered for groups. They now
  render only when `isDm` — group rooms show no call buttons at all.

## FINAL GATES — 2026-10-30 (coordinator-run, all teams + integration fixes in)
- `npx tsc --noEmit` → **0 errors**
- `npm run build` → **green** (bundle 1,287 kB / gzip 375 kB; chunk-size warning only —
  code-splitting is Phase 5)
- WS suite → **6/6 PASS** · Security suite → **18/18 PASS** · OTP suite → **6/6 PASS**
  · health OK on all three test instances
- **Production smoke** (headless Chromium, `NODE_ENV=production`, fresh scratch
  store): app boots to the login screen, **zero console messages/errors**, rendered
  DOM contains **no** "Adina"/"Nurrahma" — the logged-out fake-person bug is dead.

## Phase 0 EXIT GATE
- ✅ Fresh install shows no fake people/stories/media — shipped `data/store.json` is
  the empty snapshot (`channels: [], messages: {}, stories: [], blocks: {}, reports: []`);
  seed exports/IDs grep = 0 in `src/`; `seedStories` gone; avatar fallbacks are
  generated initials.
- ✅ Admin actions persist — group create/rename/kick/promote/sections POST to
  `/api/channels` with auth; server enforces owner/admin (suite S2/S3) and persists
  owner/memberIds/adminIds in the store snapshot.
- ✅ Blocked user cannot reach you — suite S6a (DM dropped) + S6b (call invite
  dropped), enforced server-side; Block/Report UI shipped in DM menu, group member
  rows, and the Settings → Privacy blocked-users list.
- ✅ Group-call button absent — not rendered in group rooms; App handler also no-ops
  for non-DM as belt-and-braces.
- ✅ Zero console errors — production headless boot, clean console.

## Known leftovers (honest, non-blocking)
- `sentLate` is attached to scheduled messages via a cast — `ChatMessage` doesn't
  declare the field yet (Phase 4 type cleanup).
- NewCategoryModal's outward callback still passes member names; App resolves
  names→IDs (duplicate display names resolve to all matches). Passing
  `selectedMemberIds` directly is a later-phase tidy-up.
- Avatar pick-lists still hotlink Unsplash (see above) — deliberate, flagged.
- WebRTC restart/echo changes are code-verified only; the two-device in-call media
  test remains the owner's proof step.

## Owner knocks (unchanged, out of Phase 0 scope)
1. Deploy `firestore.rules` via Firebase Console (project `modern-patrol-vt3g1`,
   non-default DB) — the 0.9 UID fix it depends on is now verified, and the rules
   include the new owner-only `private/contact` match.
2. Two-device in-call media test (ICE restart / echo / speaker proof).
3. Firestore cloud sync (next architecture step).
4. Hosting session (parked by owner 2026-10-30; deploy zip ready).
5. SMTP live test. 6. Paid TURN decision. 7. GitHub push (per-push say-so).
