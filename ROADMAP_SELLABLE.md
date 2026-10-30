# চিঠি · Chitthi — Sellable Roadmap ($10,000–12,000 Positioning)

**Merged from:** 10-team audit + cited web research (Stories, Chat Core, Calls, Profile & Identity, Groups, Media, Design/Liquid Glass, Security, Search/Productivity, Packaging) — all teams audited the actual code in `~/workspace/pulsechat-v2`, researched WhatsApp / Telegram / Discord / Signal / Instagram in 2025–2026, and inventoried dead code in their area.
**Date merged:** 2026-10-30
**Rule for implementation:** No team edited code. Implementation happens centrally, phase by phase, in the order below. After every removal or behaviour change: `tsc 0 · build green · WS suite ALL PASS · smoke test` before moving on.
**Owner:** Maruf Talukder. Light, clean design only — dark themes were rejected by the owner twice. Do not reintroduce a dark-first design.

---

## Executive Verdict — Why It Does Not Sell Yet

Chitthi *looks* like a flagship messenger in a single-device demo, and much of the surface is real (message actions, reactions, pins, polls, WebRTC signalling, stories UI, saved/scheduled/drafts, storage manager). A buyer doing first-hour diligence will catch, in roughly this order:

1. **Anyone is admin, anyone can be anyone, anyone can read everything** — `|| true` admin bypass in two files, WebSocket identity is self-asserted with no token verification, the server broadcasts globally and enforces no room membership, and `POST /api/channels` is unauthenticated.
2. **Fake data shipped as product** — 3 seeded stories from strangers, 6 seeded users with hard-coded presence, fake group gallery (3 Unsplash photos + a fake `Fullsnack_StyleGuide_v2.pdf` in every group), fabricated call logs, QA debris (`qa hello bob`, `dbg_room`, `qa_update_*`) in shipped `data/store.json`, 64 Unsplash hotlinks.
3. **Core promises that are cosmetic** — read receipts never transition, group admin actions never sync to the server, stories never leave localStorage, profile "about" never syncs, poll "anonymous" broadcasts voter IDs, disappearing messages resurrect from server history, several Settings toggles do nothing when saved.
4. **A live, broken group-call button** that rings *every* online user.
5. **No safety layer at all** — Block / Report do not exist anywhere in the codebase.
6. **Handover artefact fails inspection** — template README (mentions a `GEMINI_API_KEY` the code never uses), package named `react-example@0.0.0`, no LICENSE, `.env.example` documents 2 unused variables and omits all 8 real ones, no PWA manifest/icons, performance unmeasured (main bundle measured 1,240,255 B / gzip 357,177 B).

None of this is fatal. The fixes below are concrete, file-referenced, and sequenced so the app becomes demo-proof first, then genuinely better, then beautiful, then clean.

---

## PHASE 0 — SALE GATE: Bugs & Flaws a Buyer Catches in the First Demo

*Nothing in later phases matters if any item here is still open during a buyer demo. Do these first, in order.*

### 0.1 Server authority & identity (Security — Team 8, Groups — Team 5)

- [ ] **Verify identity on the wire.** `server.ts:521-525` — WebSocket login currently accepts a self-asserted `userId`. Require a Firebase ID token at WS connect and on REST calls; reject/close on missing or mismatched token. A client claiming another `userId` must not become that user.
- [ ] **Scope the broadcast.** Replace global broadcast with room-scoped delivery: `room:join` and `message:send` must check membership server-side; `room:history` must only be served to members. Today any connected client can join, read, and post anywhere.
- [ ] **Authenticate channel writes.** `POST /api/channels` is unauthenticated and can overwrite any channel. Require auth + creator/admin check for update/delete paths.
- [ ] **Remove the Firestore 2FA OR-path as an auth change (not a sweep delete).** The Firestore leg of `validateTwoFactorCode()` (`src/services/firebase.ts:128-152`) can return valid outside the server's burn/consume controls. Server-side OTP becomes the only path; run the full OTP regression suite after removal. Its write sibling `saveTwoFactorCode()` (`firebase.ts:111-125`) has zero callers and is blocked by rules (`allow write: if false`) — delete with it (see Dead Code, Tier 1).
- [ ] **Password storage upgrade.** Local accounts use unsalted single-round SHA-256 plus an FNV `insecure-fallback:` branch (`LoginScreen.tsx:~84-95`) for non-secure contexts. Move to a salted, iterated hash (or Firebase-only auth — see Risky item R-Auth). Do **not** delete the plaintext-migration branch (`StoredAccount.password?`, sign-in ~L377-392) until a version-gate/forced-reset decision exists — it is the only login path for pre-migration local accounts.
- [ ] **Gate the demo OTP.** Any code path that returns the OTP code in the API response in demo mode must be behind an explicit env flag, off by default in production builds.
- [ ] **Rename the claim.** The feature called "2FA" is registration email verification, not login MFA. Rename everywhere to **"Email verification"**. The only approved encryption wording in the product is the honest one already at `SettingsScreen.tsx:659` (transport-encrypted, server-stored, **not** end-to-end). E2EE is a post-sale architecture rewrite (libsignal-class) — never promise a date, never imply it exists.

### 0.2 The `|| true` admin bypass (Chat Core — Team 2, Groups — Team 5) — DUPLICATED FINDING, MERGED

- [ ] `src/components/ChatViewScreen.tsx:554` (`:553` in Group-audit numbering) and `src/components/GroupInfoScreen.tsx:135`: `isUserAdmin` ends in `|| true` in **both** files — every user passes every admin check. Replace with a real role check against server-persisted membership (depends on 0.3). This is the single most quotable line in a buyer's code review; it must not survive.

### 0.3 Groups must be real on the server (Team 5)

- [ ] Persist group admin actions server-side. Today create/rename/kick/promote/section changes are **local-only**: they never sync, never persist, and the `channel:created` handler discards updates. A second device must see the same group state.
- [ ] Record the creator as **owner** at creation (currently never recorded).
- [ ] Store members by **user ID**, not display name (currently by name — renames and duplicate names corrupt membership).
- [ ] Fix kick double-decrement (member count drops by 2 per kick).
- [ ] Private sections are currently client-hidden only — content is already delivered to all clients. Enforce section access server-side (ties to 0.1 room ACLs), and fix the dead member-allowlist: `newSectionAllowedMembers` setter is never called (`ChatViewScreen.tsx:512`, consumed at `:928`), so every private section is created with `allowedMemberIds: []` and the check at `:592` only passes via role/admin. Either ship the member picker or remove the field — do not leave the half-built state.
- [ ] Poll anonymity: voter IDs are broadcast to all clients while the UI says "anonymous". Stop sending `voterIds` to non-admin clients, or drop the anonymous label.
- [ ] Disappearing messages must not resurrect: server history must honour expiry — expired messages are excluded from `room:history` and purged, not re-delivered on join.

### 0.4 Remove ALL fabricated / seed data from the shipped build (Teams 1, 4, 5, 6, 9, 10) — MERGED

One sweep, verified by a fresh-install test (empty state everywhere, no strangers):

- [ ] **Stories:** delete `seedStories` — 3 fake stories (`user_mike` / `user_darlene` / `user_adina`, Unsplash images) seeded on first run (`StoriesBar.tsx:62ff`).
- [ ] **Users:** the 6 seeded people in `src/data/initialData.ts:3-78` (`INITIAL_USERS`: adina, mike, darlene, lee, ronald, albert) must not populate a fresh install. Blocked on: fixing the `currentUser → INITIAL_USERS[0]` fallback (`App.tsx:40-49`) — a logged-out browser currently *presents as "Adina Nurrahma"*, whose seed record is even marked `role: 'You'`.
- [ ] **Presence fabrication (3 copies, remove together with seed users):** the 15-second ticker (`App.tsx:~293-305`), the `users` initializer (`App.tsx:~67-84`), and the ID branches in `src/utils/presenceUtils.ts` (`getEffectiveUserPresence`: mike/darlene → always online, lee/ronald/albert → always offline). Presence must come only from the server registry, with real `lastActive` timestamps (today `lastSeen` is a free-form display string, not a timestamp).
- [ ] **Group Info fake tabs:** Images tab = 3 hard-coded Unsplash URLs (~L985-1005), Docs tab = one fake `Fullsnack_StyleGuide_v2.pdf · 2.4 MB` in every group (~L1018-1030), Videos tab = permanent placeholder, invented online counts (3 vs 7 in different places). Either wire to real messages (Phase 1.9) or remove the tabs before any demo. Bookmarks fallback rewrites every URL to `https://chithi.app/resources` (`GroupInfoScreen.tsx:123-127`) — same treatment.
- [ ] **Call logs:** seed logs are fake, and real logs resolve the peer by **name** and fabricate stranger-photo users on mismatch. Resolve by user ID; ship with an empty call history.
- [ ] **Camera:** fabricated `fileSize: '150 KB'` (`App.tsx:1000`) — report the real size or none.
- [ ] **Shipped data:** purge QA debris from `data/store.json` (`qa hello bob`, `dbg_room`, `qa_update_*` rooms/messages).
- [ ] **Hotlinks:** replace the 64 Unsplash hotlinks across seed/profile/avatar surfaces with bundled or user-provided media. Avatar preset lists are duplicated and already drifting (LoginScreen `DEFAULT_AVATARS` 5 items vs UserProfileModal `CLEAN_AVATAR_OPTIONS` 6 items, plus hard-coded fallbacks in `App.tsx` ~L957/~L1025 and `ChatViewScreen.tsx` ~L2488/~L2543) — consolidate to one shared constant as part of this sweep.
- [ ] **QR demo payload:** delete the hard-coded default `OFFLINE_SYNC://chithi/p2p_mesh?user=maruf&pkg=design_tokens_v2` (`OfflineQrModal.tsx:33`).

### 0.5 Chat core truthfulness (Team 2)

- [ ] **Real read receipts.** Message `status` never transitions — nothing in the code sets `delivered` or `read`; only seed data contains `'read'`. Implement: server ack → `delivered`; peer opens room → `read` receipts event; sender UI updates live. Until then, do not show ticks that lie.
- [ ] **Sort the chat list by recency.** It currently is not sorted by last-message time at all.
- [ ] **Touch access to message actions.** The action sheet is hover-only — on touch, Reply/Pin/Poll-vote/Forward/Edit/Delete are effectively unreachable. Add long-press (and right-click) opening the same sheet.
- [ ] **Forward hygiene.** Forwarded messages leak `editedAt` / `expiresAt` from the original. Strip both on forward.
- [ ] **Composer:** single-line `<input>` → auto-growing textarea (also unblocks draft quality, Phase 1.8).
- [ ] **Audit BroadcastChannel.** It is a second, un-audited transport alongside the WebSocket (same-browser tab sync). Document its message types, ensure it cannot inject messages the server would reject, and add the cross-tab leader guard needed for scheduled messages (0.8).

### 0.6 Stories must sync (Team 1)

- [ ] Stories are **localStorage-only with zero server sync** — a two-device demo fails instantly. Move stories to the server (create/list/view/expire), scoped per user.
- [ ] Storage keys are **not per-user** — stories leak across accounts on a shared browser. Namespace every story key by user ID (same audit for all `chithi_*` / `chitthi_*` keys).
- [ ] Viewer pause is broken: pausing empties the progress bar instead of freezing it. Fix the timer/progress state.
- [ ] The claimed "pulsing rings" do not exist in code. Either implement or remove the claim (real rings do exist on the chat list per Team 4's trace — reconcile the two surfaces to one implementation).
- [ ] Missing baseline behaviours that read as bugs in a demo: no story delete, no viewers list, no audience selector, no reply-to-story, no reaction, no video or text stories. Creation/viewing basics are Phase 0; the enrichment set is Phase 1.1.

### 0.7 Calls: stop the bleeding (Team 3)

- [ ] **Disable/hide the group-call button until it is replaced.** `App.tsx:863-873` starts a "group" call with `peerId: undefined` → the server broadcasts → **every online user rings**, and multiple accepts collide into one 1:1 peer connection. This is the most demo-destructive bug in the app. Group calling returns only on an SFU (Phase 3).
- [ ] **ICE restart is a no-op** — no `onnegotiationneeded` handler exists. Implement real ICE restart on connection failure.
- [ ] Do not send invite/accept when local media acquisition failed; add a connecting timeout with a visible failure state.
- [ ] **Echo bug:** video calls attach the remote stream to two audible elements. Attach to exactly one; the speaker toggle currently routes the wrong element — fix both together.
- [ ] **TURN honesty:** calls depend on the free Open Relay project with public credentials (`openrelayproject`) and a shared 20 GB/month pool. For the sale demo this is a reliability risk, not a code bug — paid TURN is an owner decision (see Owner Knocks).

### 0.8 Scheduled messages can silently vanish (Team 9)

- [ ] The sweeper deletes a due item from the queue **before** sending (`App.tsx:236`), and `socketService.send()` silently drops when the socket is not OPEN. Result: message appears in the sender's local history, never reaches anyone, no retry, no error. Fix: delete only after confirmed send; on failure keep the item with a visible **"failed — tap to retry"** state.
- [ ] **Cross-tab duplicate fire:** two open tabs each run the sweeper and generate different message IDs, defeating dedupe (`App.tsx:399`). Add a leader-tab guard (BroadcastChannel election or localStorage claim-before-fire).
- [ ] The schedule modal must state, in-product, that the app must stay open for delivery — until the server-side queue ships (Phase 1.8). The BUILD_REPORT admits this limit; the UI never tells the user.
- [ ] Overdue items currently fire late in a burst timestamped with fire time, not scheduled time — display the scheduled time or mark "sent late".

### 0.9 Profile sync & the rules-deploy trap (Team 4)

- [ ] **Status/about never syncs.** `syncUserProfile` (`firebase.ts:79-92`) writes `id, name, email, avatar, username?, online, lastSeen, updatedAt` — **not `status`**. The App save handler (`App.tsx:1108-1114`) passes none either. Add `status`, and add the missing read-back: nothing ever fetches your own profile on login, so a second device rebuilds you from local data with hard-coded `status: 'Available on Chitthi'`.
- [ ] **ID mismatch vs. firestore.rules — fix BEFORE deploying the rules.** Email/local accounts get synthetic IDs `` `user_${email.replace(/[^a-zA-Z0-9]/g,'_')}` `` (`LoginScreen.tsx` L325, L404, L589), but the rules allow `users/{userId}` writes only when `request.auth.uid == userId`. A Firebase UID never equals `user_…`: **the day the rules are deployed, profile writes break for every email/local account** (Google accounts, with real UIDs, survive). Key user docs to the Firebase UID for all login types and migrate existing `user_<email>` docs on next login. The duplicated email→ID derivation exists in 5 places (incl. `firebase.ts:113, 130`) — consolidate into one helper *as part of this migration*, never as a blind dedupe.
- [ ] **Avatar pipeline.** Custom photo upload is `FileReader.readAsDataURL` with no compression/resize/crop/validation (`UserProfileModal.tsx:43-52`) — a 3–5 MB phone photo becomes a ~4–7 MB base64 string in localStorage (quota ≈5 MB, shared with messages — can silently break *all* persistence) and risks Firestore's per-document limit, after which sync fails **silently** (`console.warn` + `.catch(()=>{})`). Fix: centre-crop square, resize to 512×512, compress (canvas — copy the Stories 1080px downscale approach), store in Firebase Storage at `avatars/{uid}.jpg`, keep only the URL in the profile doc, 5 MB input cap with a clear error, and add **Remove photo** → initials avatar (no remove option exists today).
- [ ] **Email exposure.** `firestore.rules` makes `users/{*}` readable by any signed-in user and `fetchAllUsers()` returns full docs **including email addresses** — any authenticated user can enumerate every user's email. Redact email from the readable profile doc (keep it on a private sub-doc or server-only).

### 0.10 Honesty fixes in copy & limits (Teams 6, 9, 10)

- [ ] **Saved Messages is not a cloud.** Its own description (`App.tsx:177`) says *"Your personal cloud"* — items live only in one browser's `chithi_messages_v5` and are destroyed by a storage clear. Change all copy (in-app and any sales material) to "on this device" until real sync ships.
- [ ] **Chat-list search placeholder lies.** *"Search by name or message…"* (`ChatsScreen.tsx:194`) — it matches only chat name, the single latest preview string, and (DMs) the peer's username. It does not search history. Fix the copy (Phase 1.9 does the real fix) and add the missing empty-results state (a no-match query currently renders a blank list).
- [ ] **The 200-message server cap is silent data loss.** Server keeps `roomMessages` capped at 200 on load (`server.ts:156`) and on send (`:582-585`, shift-out oldest). On any second device, everything older is invisible and unsearchable, undisclosed. Minimum for sale: disclose in-product; proper fix (paged history + archive store) is Phase 1.9's prerequisite.
- [ ] **Archived-chat unread trap.** Incoming messages to an archived chat increment its unread count (`App.tsx:418-422` checks `isMuted`, not `isArchived`) while the chat stays buried and the Archived row shows only a chat count (`ChatsScreen.tsx:251`). Fix: unarchive on new message (default) or surface an unread dot on the Archived row — plus a "Keep archived" setting (Phase 1.8).
- [ ] **Storage manager truthfulness.** Headline total counts *every* origin key but Clear-all only removes `^(chithi_|chitthi_)` keys (`SettingsScreen.tsx:54, 183-185`); drafts / scheduled / TTL / wallpaper keys have no group definitions (`:29-37`) and hide in "Other"; Clear-all silently destroys all scheduled messages, drafts, and Saved Messages under a generic confirm. Fix the total to app keys only, and make the confirm enumerate exactly what dies (incl. counts of scheduled messages and drafts).
- [ ] **Settings cosmetic toggles — wire or remove, per row.** Notifications modal "Message Sound" + "Group Alerts", Chat modal "Enter to Send" + "Media Auto-download" (`SettingsScreen.tsx:418, 436, 459, 463`) are uncontrolled `defaultChecked` checkboxes whose Save only fires a toast — values are never persisted or read. (Ringtone and Data Saver in the same modals are real — keep those.) A buyer toggling these proves they do nothing.
- [ ] **Privacy page must control something.** `SettingsScreen.tsx:650ff` is one honest paragraph and an OK button — zero controls. Phase 0 minimum: Block (0.11) plus the audience controls in Phase 1.4. Do not demo it as a "privacy centre" until then.
- [ ] **Media truthfulness.** All media is base64 data-URLs inside messages (no upload endpoint, no object storage), 6 MB cap, bytes stored ×3 (localStorage + server RAM + `store.json`). Voice messages: duration is always ~2s (stale-state closure), the timer can show `00:75`, the waveform is fake (hash-derived bars), Safari records webm mislabelled. "Stickers" are 20 enlarged emoji. Phase 0: fix duration/timer/waveform-from-real-samples or label honestly; the storage rework is Phase 1.6.

### 0.11 Block & Report — build the minimum (Teams 4, 8) — MERGED

- [ ] There is **no block or report code anywhere** (repo-wide grep: the only `block` hits are CSS). Minimum sellable set: Block from the other-user profile card and chat menu → blocked user cannot DM you (server relay drops, does not ring you), disappears from your lists; Blocked list in Privacy settings with unblock; Report = block + optional reason stored for the operator. This is a safety prerequisite for any public-facing sale.

### 0.12 Packaging quick kills (Team 10)

- [ ] Replace the template README (AI Studio banner; documents a `GEMINI_API_KEY` the code never uses) with a real product README: what Chitthi is, how to run/deploy, architecture, env table.
- [ ] Rename the package from `react-example@0.0.0`; add a LICENSE file; align all branding to চিঠি · Chitthi.
- [ ] Rewrite `.env.example`: it documents 2 unused variables and omits all 8 real ones — `PORT`, `NODE_ENV`, `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_PORT`, `CHITTHI_DATA_DIR`, `DISABLE_HMR`.
- [ ] Update or delete `docs/FEATURE_MATRIX.md` — it is stale and self-contradicting (predates usernames/stories; several ❌ rows are now partially built; its "privacy modal is informational only" verdict is still, embarrassingly, exact).

**Phase 0 exit gate:** fresh install shows no fake people/stories/media → two devices, two real accounts, find each other (1.4/1.9 dependency noted), exchange messages with real receipts, admin actions persist, blocked user cannot reach you, group-call button absent, zero console errors, `tsc 0 · build green · WS suite ALL PASS`.

---

## PHASE 1 — MISSING FLAGSHIP CONVENIENCES

*The features every competitor has and Chitthi's buyers will ask for by name. Ordered by value; effort S ≤1 day · M 2–5 days (Team 4 scale: M 2–4 days) · L >1 week / architectural.*

### 1.1 Stories enrichment (Team 1) — after 0.6 sync
- Viewers list (who saw each story, when) — **M / High**
- Audience selector per story + default (Everyone / Contacts / Close list / Nobody-for-photo equivalent) — **M / High**
- Reply-to-story (opens DM with story quoted) and emoji reactions — **S–M / High**
- Text stories (coloured/gradient backgrounds, font choices) and video stories — **M / High**
- Highlights (pin expired stories to profile) — **M / Med** (depends on Profile card, 1.4)
- Delete own story, mute another user's stories — **S / High**
- Per-user storage namespacing everywhere (completes 0.6)

### 1.2 Chat core enrichment (Team 2)
- Threads / structured replies everywhere (quote-reply exists in places; make it universal incl. in search results) — **M / High**
- Poll upgrades: multi-choice, quiz mode, poll in groups honours real anonymity (after 0.3) — **S–M / Med**
- Typing indicators: verify scope (room + section) and add group "X is typing" naming — **S / Med**
- Message info panel (sent / delivered / read-by list for groups, built on 0.5 receipts) — **M / High**
- Star message (personal bookmark) — delivered via 1.9 spec #6, owned there to avoid duplication.

### 1.3 Calls enrichment (Team 3)
- Screen share on the existing P2P path — feasible today via one `replaceTrack` — **M / High**
- Call UX completion: connecting timeout + failure state, redial that rings only the intended peer (Round-3 fix — regression-test it), camera flip, audio-only fallback, busy/declined states with correct tone handling (verify Round-3 additions hold under the Phase-0 auth changes) — **S–M / High**
- Call history that persists server-side and resolves peers by ID (after 0.4) — **M / Med**
- Quality handling: adaptive bitrate hints, "connection weak" indicator driven by ICE/stats — **M / Med**
- Speaker routing fix lands in 0.7; verify on a real two-device call (Owner Knocks).

### 1.4 Profile & identity system (Team 4) — the label becomes a system
Chitthi is email-based (no phone number to leak — a genuinely good position), but it shipped the *@username label* without the *system* every competitor built around it (Telegram: 5–32 chars, starts with a letter, `t.me/username`, QR on the username card; WhatsApp 2026: username reservations from 29 June 2026, 3–35 chars, reserved names held back against impersonation, optional username key; Signal: username as privacy shield + discoverability-off opt-in).

1. **Server-enforced usernames — M / High.** Claim/release via a `usernames/{handle}` claim doc or server endpoint, atomic and case-insensitive. Rules: 5–20 chars, `[a-z0-9_]`, must start with a letter, no leading/trailing/consecutive `_`, drop `.` entirely (kills `www.`/`.com` impersonation). Reserved list: `admin, support, chitthi, team, official, maruf` + brand terms. Live availability tick/cross in the edit modal while typing (debounced) — replacing today's post-save `alert()` + **fail-open** catch (`App.tsx:~1083-1105`: if the uniqueness fetch throws, the change is applied anyway; two simultaneous claims both pass). On any check failure, *block* the change. Release-on-change frees the old handle after a 14-day reclaim grace. Also: collect username (optionally) at sign-up and add a one-time post-login claim prompt — today sign-up collects none at all (zero `username` hits in `LoginScreen.tsx`), so new accounts are undiscoverable by default.
2. **Other-user profile card — S–M / High.** Read-only modal from chat header (DM), group member row, @mention tap, search result: large photo (tap → full-screen), name, @username, about, presence/last-seen (subject to audiences below), Message + Call actions, shared-media shortcut, Block. Today **no such view exists** — clicking a group member jumps straight into a DM (`App.tsx:905, 927`).
3. **Profile QR + shareable link — M / High.** "My QR" screen (Settings/profile header): QR encoding `chitthi://user/<username>` (or hosted `/u/<username>`), rendered with the existing `qrcode` dependency, avatar centred, name + @username beneath, Share/Download (reuse `OfflineQrModal`'s download code). Extend the existing `jsQR` scanner with a scheme check: a `chitthi://user/…` payload opens the profile card with "Add & Message"; anything else keeps today's offline-import behaviour, with the two modes clearly separated in UI ("Add contact" vs "Offline transfer" — today scanning *any* QR posts its raw text into the chat as an `offline_qr` message, unvalidated). No-username users get an ID-link QR + a nudge to claim a username. **QR add-friend and any shareable profile link do not exist today — state that plainly until this ships.**
4. **Privacy audiences — M / High.** WhatsApp-pattern pickers (Everyone / My contacts / Nobody), persisted per user and enforced on render *and* on presence broadcast: Profile photo, About, Last Seen & Online (reciprocal: hiding yours hides others' from you), Who can find me by @username (Everyone / Nobody — Signal-style discoverability-off), Who can add me to groups. Define "My contacts" in UI copy as users with an existing DM/group relationship (Chitthi has no address book). Hidden photo → initials avatar; hidden last-seen → nothing, not a fake string.
5. **Bio, properly — S / Med.** Split `status` into **About** (multi-line, 160 chars, linkified, shown on the profile card) + keep one-line status as a quick mood line. Migrate existing `status` → About on first load. Optional cover/banner on the profile card (Discord lesson — *not* paywalled) is a further S.
6. **Find & add people — M / Med.** "New chat" search querying users by exact @username and name prefix (respecting discoverability), result → profile card → Message creates the DM. Copy states the WhatsApp rule: no browsable directory; exact handle works. Without this, two real strangers who both install Chitthi **cannot find each other** unless already in the same seeded group.
7. **Account centre — M / Med.** Settings → Account becomes a real page: email display, Change password / Change email (Firebase, with re-verification), **Active sessions** list (server connection registry: device label, last active, per-session log-out), **Delete account** (type-to-confirm; deletes Auth user, profile doc, username claim, local stores), and an "Erase this device's data" action with an honest warning that logout alone leaves `chithi_users_v5`, messages, and the local registered-accounts store (incl. password hashes) intact on a shared device. (Fix Round 3's logout itself — Firebase `signOut` + socket disconnect + clearing auth keys, `App.tsx:~500-512` — is real; keep it.)
8. **Presence honesty — S–M / Med.** After 0.4: manual status picker (Online / Away / Invisible — invisible receives everything, broadcasts offline); last-seen rendered from real timestamps ("today at 14:32").
9. **Contact-card sharing — S / Low.** Share a profile card into a chat (username/link only — never email); tap opens the profile card.

### 1.5 Groups & communities enrichment (Team 5)
- Invite links (revocable, with join approval option) — **M / High** (depends on 0.1/0.3)
- Leave group / Delete group flows (both absent today) — **S / High**
- Add-member flow from contacts + via invite link (absent today) — **M / High**
- Group events (create event, RSVP) and group polls as first-class items — **M / Med**
- Permission matrix per role (who can post / pin / manage sections), enforced server-side — **M / High**
- Announcement (read-only) sections — **S–M / Med**

### 1.6 Media, stickers & files rework (Team 6)
- **Real upload pipeline — L / High.** Upload endpoint + object storage; messages carry URLs + metadata, not base64. Ends the ×3 storage duplication and the 6 MB ceiling. Until this ships, keep the cap and say so.
- **Real shared-media gallery** — see 1.9 spec #5 (one implementation serves both).
- **GIFs — M / High.** Tenor's API shut down 2026-06-30; use **Klipy** (free tier) or **GIPHY** (paid/attribution terms) — pick one, wire search + insert as real media, not enlarged emoji.
- **Sticker packs — M / Med.** A sticker becomes an asset type (transparent image, pack metadata), not an emoji at large font size. Ship 2–3 bundled packs; pack browser in the composer.
- **Voice messages fixed — S–M / High.** Duration from the recorded blob (not the stale-state ~2s), timer that cannot show `00:75`, waveform from real audio samples, correct container/mime per browser (Safari webm mislabel).
- **Camera capture honesty** — real file size (0.4), compression consistent with the avatar/stories downscale path (today three divergent downscale copies exist — consolidate to one helper).
- File sharing: progress indicator on send, resumable/large-file behaviour after the upload pipeline lands — **M / Med**

### 1.7 Security & privacy completion (Team 8)
- Session management UI (delivered via Account centre, 1.4.7) + "log out all other devices" — **M / High**
- Account deletion + data export (GDPR-shaped; export format shared with 1.9 spec #3) — **M / High**
- A real, published **privacy policy** page (none exists) — **S / High for sale**
- Login alerts (new-device email) — **S–M / Med**
- Disappearing-message timers per chat with the server purge from 0.3 — **S / Med**

### 1.8 Productivity completion (Team 9, part 1)
- **Server-side scheduled messages + message reminders — L / High.** Move the queue server-side (persisted table + server sweeper): fires while the app is closed, exactly once (idempotency key = schedule ID), with a delivery-failure state. The same migration adds **Remind me about this** on the message action sheet (presets 1h / tonight / tomorrow / next week / custom — the Slack pattern) delivering a Saved-Messages entry + in-app banner deep-linking to the original message, with snooze/done. This single change converts two demo-grade features into sellable ones. Scheduling gains media/polls/voice once server-side.
- **Scheduled-messages manager — S / Med.** One list across all rooms (Settings → Scheduled): content, target room, due time, edit-in-place, cancel.
- **Saved Messages v2 — S–M / Med-High.** One-tap "Save" on the action sheet (today saving is Forward → pick Saved, two steps, undiscoverable); `#hashtag` tags with a filter row; "view by source chat" grouping; remove Saved from the generic hover archive/mute row (`ChatsScreen.tsx:393-423`) so users can't archive their own notebook by accident. Keep the honest "on this device" label until sync exists.
- **Draft visibility — S / Med-High.** Chat list shows italic `Draft: …` in place of the last-message preview; cancel-edit restores the room's draft into the composer (today cancelling an edit clears the composer — `setText('')` ~L1905 — while the stored draft only reappears after leaving/re-entering the room); drafts store `replyTo` alongside text (today a drafted reply silently becomes a plain message); drafts appear as a labelled group in the storage manager.
- **Archive/mute done properly — S–M / Med.** Long-press + right-click context menu on chat rows (pin / mute 8h·1wk·always / archive / mark-unread) — today all three actions are hover-only (`opacity-0 group-hover:opacity-100`, `ChatsScreen.tsx:386, 400, 414`) and unreachable on touch; de-duplicate pinned chats (they currently render in the Pinned grid *and* the main list, `:254-309` + `:313+`, with no cap — add a cap).

### 1.9 Search & discovery (Team 9, part 2)
Current state, plainly: chat-list search = name + last-preview only; in-chat search = filter-not-navigate over the *active section only*, matching only text content, poll *questions*, and sender names (not file names, captions, or links), with tombstones polluting sender results; **global search does not exist** and no server endpoint could support one.

1. **Real global search — L / High.** One entry (chat-list header + Ctrl+K) over message bodies across all rooms the user belongs to; results grouped by chat with sender, date, highlighted snippet; tap → open room, scroll to and flash the message (reuse the existing `msg-${id}` scroll + `highlightMsgId` machinery). **Prerequisite:** lift/segment the 200-per-room cap (0.10) with paged history. A client-side-only v1 is acceptable *only if* the UI labels its scope honestly.
2. **In-chat search v2 — M / High.** Keep the conversation in place; highlight matches; ↑/↓ + Enter/Shift+Enter steps with "3 of 17"; scope toggle This section / Whole room; filter chips From… / Has: link·file·image·poll / Before·After — implemented as a small parser so typed `from:` / `has:` / `before:` also work (Discord parity: their documented model is filter chips + typed shortcuts + date ranges + newest/oldest sorting).
3. **Real shared-media browser — M / High.** Replace GroupInfo's fake tabs with data from the room's actual messages: Images grid, Videos, Docs (name/size/date/download), Links (extracted URLs with domain + sender); tap any item to jump to its message. DM info gets the same panel. (Serves 1.6.)
4. **Chat export — M / High.** Per-chat menu → Export: **HTML** (readable, media folder — Telegram-style), **JSON** (documented fields: id, roomId, senderId, senderName, timestamp ISO, type, content, fileName, replyTo, reactions), **TXT** (`[date, time] Name: text` — WhatsApp-style); with/without media; optional date range; tombstones excluded or marked. Buyer benchmark: WhatsApp .txt is the floor, Telegram HTML+JSON (documented schema at core.telegram.org/import-export) is the bar.
5. **Starred messages — M / High.** Action-sheet "Star" (personal, private per-user ID set, synced via a `message:update`-style patch or user-scoped store); "Starred" view grouped by chat with tap-to-jump; star filter in in-chat search. Complements shared pins and Saved — does not replace them.
6. **Custom folders / lists — M / High.** User-created named lists (Work, Family, Clients…); a chat may be in several; lists render as extra chips beside All/Unread/Groups/Personal with per-list unread counts. Storage shape: resurrect/replace the dead `Channel.category` field (see Dead Code D-Category) as a list-ID array per channel; local `chitthi_lists_v1` now, server-synced later. (WhatsApp custom Lists and Telegram folders are the reference patterns.)
7. **Keyboard & power shortcuts — S / Med.** Ctrl/Cmd+K global search, Ctrl/Cmd+F in-chat search, Esc closes search/sheets, ↑/↓ in results, Ctrl+Enter send option; publish the list in Settings → Help. (Today there is no Ctrl+F/Ctrl+K handling anywhere in the chat UI.)
8. **Search niceties — M / Low-Med.** Recent searches (last 8, clearable), "Mentions of me" / "My messages" one-tap global filters, jump-to-date calendar in a room.
9. **Chat-list search quick win — S / Med** (lands with 0.10 copy fix): also match channel `description` and DM peer `name`. Note: the *dead* legacy Sidebar search (`Sidebar.tsx:24-34`) already matched description + user status — the live screen regressed versus the dead code; consult it before deletion.

**Phase 1 exit gate:** two real accounts on two devices can find each other by @username or QR, star/save/schedule/search/export, share real media and GIFs, and administer a group whose state is identical on both devices.

---

## PHASE 2 — LIQUID GLASS REDESIGN (Light Theme)

*Spec from Team 7's token-level audit + the verified Liquid Glass research pass (full research: `~/workspace/research_notes/liquid-glass-premium-portfolio-research-20261030-1210/report.md`). The current UI is **not** Liquid Glass: one `.glass-bar` utility (`src/index.css:77-86`, ~9 usages) diverges from the verified recipe on 5 of 7 parameters, and most modals are solid.*

### 2.1 The verified material recipe (do not improvise)
- **Glass (light):** `background: rgba(255,255,255,0.45)`; `backdrop-filter: blur(14px) saturate(140%)` — saturate is essential, blur drains colour.
- **Border:** `1px rgba(255,255,255,0.18)`.
- **Specular rim:** inset shadows — top `0 1px 1px rgba(255,255,255,0.55)`, bottom `0.30`, sides `0.20` alpha.
- **Lift:** `0 8px 32px rgba(0,0,0,0.25)`.
- **Sheen:** `::after` diagonal `linear-gradient(135deg, white .45 → .08 → transparent)`, `mix-blend-mode: screen`; `isolation: isolate` on every glass element.
- **Radius:** cards ~28px; buttons capsule (~height/2); **concentric rule: inner radius = outer − inset**. Kill the current radius chaos with these tokens.
- **Refraction:** true refraction needs SVG `feDisplacementMap` in `backdrop-filter: url(#…)` — Chromium-only. If used at all, gate it in a separate `@supports` block with the plain-blur recipe underneath. Never ship it unguarded.
- **Motion:** springs, not easing — CSS `linear()` spring curve, fallback `cubic-bezier(0.25,0.1,0.25,1)`; all feedback **< 400ms**. Apple behaviour reference: tab bars shrink on scroll down, expand on scroll up.
- **Performance law:** `backdrop-filter` re-filters every frame the backdrop moves — **≤1–2 glass surfaces per viewport**, glass the container never list items, never animate blur, blur radius is the cost knob.

### 2.2 Token discipline (Team 7)
- Tokens exist but are **bypassed**: hundreds of hard-coded slate/blue values across components. Phase 2 includes a sweep: every colour/radius/shadow in components resolves to a token (primary gradient `#2563EB → #7C3AED` stays reserved for send button, story rings, brand marks — per the 2026-10-30 redesign round).
- **Contrast fix:** `--c-text-faint #9CA3AF` measures ≈2.5:1 — fails WCAG. Darken faint text to hold **4.5:1 against the worst-case backdrop** on glass.
- **Typography:** bubble body text is 12px on mobile — raise to the token scale (15–16px body). Fix line-height tokens.
- **Bangla matra clipping — root-caused:** `leading-tight` + `truncate` at `ChatsScreen.tsx:137`. Fix with adequate line-height + padding on Bangla-bearing rows (also check the login wordmark clipping noted in the redesign round).
- **Desktop truncation — root-caused:** ~90px of hover-only buttons per chat row squeeze the name column in the two-pane layout. Shrink/relocate row actions (ties to the 1.8 context menu).

### 2.3 Per-surface map
- **De-glass the sticky chat header** — it is the costliest pattern in the app (continuous backdrop re-filter while scrolling). Replace with the WhatsApp-iOS-26 pattern: solid/near-solid header + a floating glass *identity pill*. This is the redesign's signature move.
- **Keep & perfect:** the floating glass pill bottom nav (already shipped in the redesign round) — apply the exact recipe from 2.1 (rim, sheen, isolation).
- **Glass, sparingly:** bottom nav, identity pill, incoming-call overlay bar, story viewer chrome, modal sheets (convert the solid modals), composer bar. Everything else: clean solid light surfaces.
- **Focus states:** `focus-visible` is absent on the composer and most controls — add tokenised focus rings everywhere (WCAG, Phase 3 gate).
- **Skeletons & empty states:** zero skeleton components exist today; the chat list has **no empty state**; onboarding does not exist. Build: skeleton rows for chat list/calls, designed empty states for chats/search/stories/calls, and a 3-screen first-run onboarding ending in the username claim prompt (1.4.1).
- **Iconography:** one icon family (Lucide, already in use), one stroke weight, tokenised sizes.

### 2.4 Dark mode ruling (Team 7) — KEEP, DEMOTE, FREEZE
Dark mode generates 527 built-CSS selectors from 422 live `dark:` usages. Cutting it is the **riskiest** cleanup in the codebase and the owner prefers light. Ruling: light is the designed, demoed, sold theme; dark stays functional but receives no new design work, and no Phase-2 surface is blocked on dark parity.

### 2.5 Accessibility & motion preferences
- Honour `prefers-reduced-transparency` (glass → solid) and `prefers-reduced-motion` (springs → instant) on every glass/animated surface.
- 44px minimum touch targets; keyboard path through nav, chat list, composer, sheets.

**Phase 2 exit gate:** every screen matches the per-surface map; ≤2 glass surfaces per viewport in profiling; text-on-glass holds 4.5:1 on worst-case backdrops; reduced-transparency/motion modes verified; zero hard-coded colour values remain outside tokens (grep-verified).

---

## PHASE 3 — NICE-TO-HAVES & POST-SALE-SHAPING ITEMS

*Valuable, deliberately last. None of these may be promised in the sale listing until shipped.*

- **Group calls on an SFU** (LiveKit-class) replacing the disabled P2P group button — mesh breaks at ~4–6 video participants; SFU is the only credible path. **L**
- **Multiple accounts** (Team 4) — up to 3 signed-in identities, avatar-tap switching, per-account storage namespacing (`chithi_auth_user:<uid>`), per-account unread dots. Telegram's most-cited advantage. Do only after UID migration (0.9) and Account centre (1.4.7). **M**
- **Verified / role badges** — operator-set `verified: true` (never client-writable under rules), rendered on profile card, chat list, member rows; group role chips extended to the profile card. Scarce by design. **S**
- **Cloud drafts & cloud sync of Saved/stories** — the Firestore cloud-sync big step (see Owner Knocks) subsumes this; Telegram's cloud drafts are the reference. **L**
- **Mark-unread / mark-all-read, undo-send window, multi-select bulk actions, search history** — small productivity polish from Team 9's absent-list. **S each**
- **E2EE** — post-sale architecture programme (libsignal-class), separately scoped and priced. Never a roadmap date.
- **CppExplorer** — extraction from the bundle is a *product decision* (it is lazy-loaded, 131,587 B), not a cleanup item. Decide keep/remove as a product, then act.

---

## PHASE 4 — DEAD-CODE REMOVAL (Consolidated, Team 10 owns this list)

*User's explicit addition: "If there is any unnecessary code, remove it." Removal happens here, centrally, after the phases it touches — each item verified (`tsc · build · WS suite · smoke`) immediately after its removal. Ordered by safety: definitely-dead first.*

### Tier 1 — DEFINITELY-DEAD (no reachable caller; proven by import/reference tracing)

**The legacy island — 1,375 lines, one commit (Teams 2, 9, 10 — MERGED, counted once):**
A closed, self-referencing cluster superseded by ChatsScreen/ChatViewScreen; zero imports from live code; the only lazy import in the app is CppExplorer.
- `src/components/ChatArea.tsx` (237) · `ChatInput.tsx` (354, incl. its duplicate `formatFileSize`) · `MessageItem.tsx` (275) · `Sidebar.tsx` (185 — **read its search first**, see 1.9.9) · `Navbar.tsx` (178) · `UserActivityModal.tsx` (146 — also Team 4 D-1: internally dishonest if revived — user count floored at 12 via `Math.max(dbUsers.length, 12)`, "Firebase Status: Connected" hard-coded).

**Transitively dead with UserActivityModal:**
- `firebase.ts:63-76` `fetchUserActivities()` + `firebase.ts:36-43` `ActivityRecord` type (sole caller was the modal). Keep `logUserActivity` — the write side is live (6 calls in LoginScreen).

**Auth dead code (Team 4):**
- `firebase.ts:111-125` `saveTwoFactorCode()` — zero callers, and rules-blocked besides (removal coordinated with 0.1).
- `firebase.ts:154-162` re-export surface: `onAuthStateChanged` has zero importers from `firebase.ts`; the other pass-throughs are likewise never imported from the service (LoginScreen imports directly from `firebase/auth`; App imports only `signOut`). Drop individually after a fresh grep; keep `signOut`.
- `firebase.ts:12` `User as FirebaseUser` import; `firebase.ts:26` `onSnapshot` import — occurrence count 1 each.
- `LoginScreen.tsx` `verificationToken` (type L65, generation L296, stored L304) — write-only dead data in every stored account; plus the no-op `delete updatedAccount.otp;` (~L491) that exists only to service it.

**Seed-module dead code (Teams 4, 5, 9):**
- `src/data/initialData.ts:181ff` `createSynthesizedAudioDataUri()` (~35 lines) — definition only, zero callers.
- `GROUP_CHANNELS_LIST`: the export (`initialData.ts:330`) + both unused imports (`ChatViewScreen.tsx:3`, `GroupInfoScreen.tsx:3`, flagged TS6133). Keep `GROUP_BOOKMARKS` — it is live (fallback source, however problematic — see 0.4).
- Unreachable duplicate server seed block `server.ts:170-186`.

**Unused imports in live files (tsc TS6133 evidence, Teams 4, 5, 9):**
- `ChatsScreen.tsx:3` — `MessageSquare`, `ChevronUp`, `ChevronDown`
- `ChatViewScreen.tsx` — `Shield` (:27), `Bookmark` (:28), `CheckCircle2` (:29), `Settings` (:33), `UserPlus` (:35), `Info` (:36)
- `GroupInfoScreen.tsx` — `UserPlus` (:11), `Shield` (:18), `ShieldAlert` (:19), `Settings` (:32), `CheckCircle2` (:34), `Users` (:35), `Sparkles` (:37), `AlertTriangle` (:38)
- `SettingsScreen.tsx:16` — `Check`; `LoginScreen.tsx` — `ExternalLink`, `Send`; `OfflineQrModal.tsx:14-15` — `Radio`, `FileText`; `UserProfileModal.tsx:3` — `Upload` (the only other "Upload" is a title string)

**Write-only / dead logic:**
- `Channel.category` (`src/types/chat.ts:108`) — written at `App.tsx:179, 954` and in seed data; **zero reads** anywhere (live filter chips key off `isGroup`/`unreadCount`). Delete the type field + writes; persisted JSON carrying the extra property is harmless. (Phase 1.9.6 may resurrect the *concept* as a list-ID array — that is new code, not a reason to keep the dead field.)
- `SettingsScreen.tsx:36` storage-manager `prefs` regex alternative `settings` — no key containing `settings` is ever written.
- `canManageMembers` (Team 5) — a flag written 7×, never read.
- Root `server.js` (21 KB) — stale compiled copy, **not** byte-equivalent to `server.ts`, and `package.json` start runs `server.ts`. ⚠️ One verification first (Team 9 flagged it RISKY): confirm the Azure deploy bundle's `server.js` is regenerated independently of this root copy; the moment that is confirmed, this graduates to Tier 1 and goes. Until that check, treat as Tier 3.
- Dead dependencies (Team 10): `@google/genai`, `motion`, `dotenv` — declared, unused by shipped code. Remove + rebuild-verify.
- **Write-only state (decide-then-delete):** `LoginScreen.tsx` `firebaseEmailSent` (L126) + `firebaseConsoleNotice` (L127) — setters run and build a genuinely useful Firebase-Console help message (L288-295) that is **never rendered**. Central decision: wire it into the error banner, or delete state + setters. Do not silently delete the message text.

**Total Tier 1: ≈1,490–1,900 lines** across the teams' counts (the spread reflects whether the legacy island and the server seed block are counted once — they are, here).

### Tier 2 — PROBABLY-DEAD (unreachable under current wiring; remove after the named precondition)
- Seed identity data as shipped content (`INITIAL_USERS`, `INITIAL_CALL_LOGS`, seed stories) — code-live via fallbacks; removal is Phase 0.4, sequenced with the `currentUser` fallback fix and the fake-presence removal. Listed here so nobody double-counts it as a Tier 1 sweep.
- Duplicated CallsScreen rendering: `App.tsx:775-791` (`history` tab) and `:793-809` (`calls` tab) are byte-identical blocks, and BottomNav exposes both tabs. Consolidate to one tab + one block (product picks the surviving label).
- `ChatsScreen.tsx:40-53` current-user fallback branch (prop → localStorage → `users[0]`) — unreachable because App always passes the prop; the `users[0]` fallback is a wrong-user landmine. Remove the branch or make the prop required.
- Duplicated avatar preset lists + hard-coded fallback avatar URLs (4+ copies) — consolidate to one shared module (in 0.4), then delete the copies.
- `syncUserProfile` call-site duplication (5 in LoginScreen + 1 in App, with drifting payloads — the drift *caused* the status bug) — replace with one `loginAndSyncProfile()` helper preserving each call's activity-log string.
- Datetime-local construction written 3× in `ChatViewScreen.tsx` (:2048-2057, :2108-2125, `confirmSchedule`) — one `toDatetimeLocal()` helper.
- Orphaned per-room localStorage keys (`chitthi_draft_*`, `chitthi_ttl_*`, `chitthi_wallpaper_*` for deleted rooms/sections — never cleaned up): safe sweep rule — delete keys whose roomId/sectionId no longer exists in `chithi_channels_v5`, and add the labelled storage groups from 0.10.
- Stories: `seedStories` helper + the unused `users` prop on the stories surface (Team 1's removal pair — executed inside 0.4/0.6).

### Tier 3 — RISKY (looks dead or fake; removal breaks something real — verify per item, in writing, before touching)
- **Root `server.js`** — see Tier 1 note; Azure-bundle provenance check is the gate.
- **Firestore leg of `validateTwoFactorCode()`** — removal is the Phase 0.1 auth change with full OTP regression, never a sweep delete.
- **Legacy key renames** (`chithi_*` vs `chitthi_*` inconsistency) — renaming live localStorage keys without a migration orphans user data. Migration first, rename second, or leave the names.
- **Plaintext-password migration branch + FNV fallback** (Team 4 D-19/D-20) — see 0.1; deletion needs a version-gate / HTTPS-only policy decision.
- **Dual-auth overlap in LoginScreen** (local-registry-first with Firebase fallback; signup proceeds locally if Firebase throws) — not dead: it is what lets purely-local/demo accounts sign in at all. Collapsing to Firebase-only is the 0.9/1.4 architecture decision plus a data migration for `chithi_registered_accounts` holders.
- **`OfflineQrModal` payload path** — the profile-QR interpretation is absent, but the generate/scan/import machinery is live and is FEATURE_MATRIX's claimed differentiator. Reuse its scanner/download code for 1.4.3; do not delete the modal.
- **GroupInfo fake media-tab markup** — live placeholder code, not dead code: it is *replaced* by 1.9.3 or removed as the 0.4 fix, never swept as "unused".
- **Dark-mode CSS** — see 2.4 ruling: freeze, do not cut.
- **`animate-in` family** (Team 7) — ~70 usages with no obvious provider. Verify against the *built* CSS before touching; if the built CSS provides it, it is live.
- **`StoredAccount.otp?` field** (LoginScreen L61-65) — only legacy local records can carry it and current code ignores it; drop the field (records parse fine without it) after confirming no downgrade/compat requirement.
- **Server duplication generally** (Team 3) — `server.js` aside, apparent duplication in the server deploy path is risky for the same bundle-provenance reason.

**Negative results (checked by multiple teams — do not "clean up"):** no commented-out code blocks, TODO/FIXME piles, or disabled JSX in the scoped files; JSX `{/* */}` comments are live section labels; historical comments documenting already-removed code (old Direct-Link-Login bypass, former fail-open 2FA fallback at `firebase.ts:149`) are accurate — keep them.

**Removal protocol (every tier):** one logical removal per commit → `npx tsc --noEmit` (note: the project's tsconfig does not enable `noUnusedLocals/Parameters` — run them explicitly during the sweep) → production build → WS suite → smoke (login, send, call-signalling, stories, groups) → only then the next removal.

---

## PHASE 5 — PACKAGING & BUYER DUE DILIGENCE (Team 10)

*A buyer paying five figures inspects the artefact, not just the app. Current state: functionality > packaging, and the handover fails first-hour diligence.*

- [ ] **PWA:** no manifest, no icons, no favicon set, no service worker. Add manifest + icons + install prompt; define offline behaviour honestly (queued sends surface as failed/retry per 0.8, not as sent).
- [ ] **Performance budget (measured, then enforced):** main bundle measured 1,240,255 B (gzip 357,177 B); CppExplorer lazy chunk 131,587 B. Budgets: **LCP ≤2.5s, INP ≤200ms, CLS ≤0.1** on a mid-range Android over 4G; split the main bundle (route-level lazy for Calls/Stories/Settings), then publish the measurements in the README.
- [ ] **Accessibility gate:** 3 `aria` attributes vs ~250 buttons today. WCAG 2.2 AA pass: labels, roles, focus-visible (2.3), 44px targets, contrast (2.2).
- [ ] **Zero console errors** in a scripted full-surface walkthrough (every screen, every modal) — this is a checklist item, not a hope.
- [ ] **Docs pack a buyer expects:** real README (0.12), architecture one-pager, env reference (all 8 vars), deploy guide (incl. the Azure zip path), data-model notes (incl. the 200-cap and its Phase-1 fix), known-limitations page that matches in-product copy exactly.
- [ ] **Demo hygiene:** a scripted demo dataset that is *labelled* demo data and loadable on demand — never seeded into a fresh install (the inverse of today's 0.4 problem).
- [ ] **Licence & provenance:** LICENSE file, third-party notices, removal of template/AI-Studio artefacts from the repo root.

**Sale-readiness checklist (all must be YES):** Phase 0 gate passed · two-device test passed (below) · zero console errors · budgets measured and met · WCAG 2.2 AA spot-audit passed · README/env/LICENSE complete · fresh install contains no fake data · no marketing claim exists that the code doesn't keep (E2EE, cloud, anonymous, group calls).

---

## OWNER KNOCKS — Carried Open Items (not solvable by the implementation team)

1. **firestore.rules deploy** — rules are written, **not deployed**. Deploy only *after* the 0.9 UID-keying fix. Correct target: Firebase project `modern-patrol-vt3g1`, **non-default database** `ai-studio-cpulsechatrealti-c3cf2523-0804-4800-a1a6-a020b3625490` — deploy the rules to *that* database in the owner's Firebase Console session (owner login required). Verify project/DB identity on screen before pasting.
2. **Two-device in-call media test** — signalling is proven live; actual in-call audio/video between the owner's two devices is still unproven. Needed once for Phase 0.7/1.3 verification (echo, speaker routing, camera flip).
3. **Firestore cloud sync** — the next big architectural step after this roadmap's Phase 1 server work; it subsumes cloud Saved/stories/drafts. Scoped separately.
4. **Hosting session** — parked by the owner 2026-10-30 (Azure for Students verification trouble; the account had no subscription). Deploy zip + `AZURE_SETUP.md` checklist are ready in `~/workspace/your_files/chitthi/` for when he resumes it himself.
5. **SMTP live test** — OTP/email flows need one live send against real SMTP credentials (env vars in Phase 5 docs) to close the email-verification story.
6. **Paid TURN** — replacing the free Open Relay pool (public creds, shared 20 GB/month) with paid TURN credentials is a purchase decision for the owner; required for credible call reliability in the sale listing.
7. **GitHub push** — per the owner's standing rule, nothing is pushed to his GitHub without his explicit say-so, per push.

---

## Appendix — Team Map & Source Notes

| Team | Area | Headline |
|---|---|---|
| 1 | Stories/Status | LocalStorage-only, seeded fakes, no viewers/audience/reply |
| 2 | Chat core | Receipts cosmetic, list unsorted, `|| true`, hover-only actions, 1,375-line legacy island |
| 3 | Calls | Group-call button rings everyone, ICE restart no-op, echo, free TURN |
| 4 | Profile & Identity | Status never syncs, usernames fail-open, no profile card / QR / privacy / block, UID-vs-rules trap |
| 5 | Groups | `|| true` ×2, server enforces nothing, admin actions local-only, members by name, fake tabs |
| 6 | Media | Base64-in-messages ×3 storage, fake waveform/durations, stickers = emoji, no GIF path (Tenor dead 2026-06-30 → Klipy/GIPHY) |
| 7 | Design | One divergent `.glass-bar`, tokens bypassed, 2.5:1 faint text, matra clipping + desktop truncation root-caused, dark = keep/demote/freeze |
| 8 | Security | Self-asserted WS identity, global broadcast, no block/report, "2FA" misnomer, rules-deploy target identified |
| 9 | Search/Productivity | No global search, 200-cap, scheduled silent-loss + duplicate-fire, Saved "cloud" copy, fake media tabs, 1,375-line island (joint) |
| 10 | Packaging | Template README, `react-example@0.0.0`, no LICENSE/PWA, bundle 1.24 MB unmeasured-against-budget, Tier-1 removal ≈1,490+ lines |

Competitor references cited by the teams include: Discord search documentation (support.discord.com — filters `from:`/`in:`/`mentions:`/`has:`, date ranges, full-history search); Telegram export schema (core.telegram.org/import-export) and username/QR patterns; WhatsApp username reservations & rules (2026 reporting) and privacy-audience pattern; Signal username privacy model (2024); Slack reminder patterns; Tenor API shutdown (2026-06-30). Liquid Glass values are from Apple Newsroom material + code-complete implementations, cross-checked in the research report cited in Phase 2.
