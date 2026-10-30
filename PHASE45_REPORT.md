# Phases 4 + 5 — Dead-Code Removal & Packaging — Implementation Report (running log)

**Spec:** `ROADMAP_SELLABLE.md` Phase 4 (Tier 1/2/3) + Phase 5 checklist.
**Coordinator gates after every removal group:** `npx tsc --noEmit` (plus one
explicit `noUnusedLocals/noUnusedParameters` run per group) · `npm run build` ·
WS suite · security suite · OTP suite · headless production smoke (CDP Chromium,
zero console errors). Test servers always run with a scratch `CHITTHI_DATA_DIR`;
shipped `data/store.json` must end as the pristine empty snapshot.

## Baseline (before any Phase 4/5 change) — 2026-10-30
- `npx tsc --noEmit` → **0 errors** · `npm run build` → **green**
- WS suite **ALL PASSED (6/6)** · security suite **31/31** · OTP suite **6/6**
- Production smoke (headless Chromium, fresh scratch store): login screen,
  **0 console problems**. Shipped `data/store.json` pristine.
- **Bundle BEFORE:** main JS `index-*.js` **1,507,676 B (gzip 424,228 B)** ·
  CppExplorer chunk 131,434 B (gzip 38,751 B) · CSS 85,983 B (gzip 14,370 B) ·
  dist total ≈ 1.74 MB. Only CppExplorer is lazy-loaded; every screen is in
  the main chunk.

## Pre-removal verifications (written, per protocol)

### V-1 — Sidebar search (roadmap 1.9.9: "read its search first")
Dead `Sidebar.tsx` search matched channel `name` + `description` and user
`name` + `status`. The live `ChatsScreen.tsx:673-680` filter already matches
name, **description**, lastMessage, DM peer name and peer username (the 1.9.9
quick win landed in Phase 1), and Phase 1 also shipped server-backed global
search — a strict superset of the dead behaviour. **Nothing to salvage;
Sidebar is safe to delete with the rest of the island.**

### V-2 — Root `server.js` provenance (Tier 3 gate)
- Root `server.js` (21,063 B, 599 lines) is **byte-identical** (md5
  `09670dac…`) to the `server.js` inside the current
  `chitthi-azure-deploy.zip`, and both predate Phases 0–2 (server.ts has since
  grown to 104 KB; a fresh esbuild bundle is 78.8 KB).
- The documented zip process (`REDESIGN_ROUND.md`, Azure package section)
  **rebundles `server.js` from `server.ts` with `esbuild --packages=external`
  at zip-build time**, stages it with a trimmed package.json + production
  node_modules, and smoke-tests the staged copy — the root file is an
  intermediate artefact of that process, not a source.
- Coordinator re-ran the rebundle from the current `server.ts`:
  `npx esbuild server.ts --bundle --platform=node --format=esm
  --packages=external` → succeeds (80,732 B). Standalone boot + suite proof of
  the regenerated bundle is executed in the Phase 5 Azure-zip step.
- **Verdict:** provenance confirmed — the deploy bundle's `server.js` is
  regenerated independently from `server.ts`. Root `server.js` graduates to
  Tier 1 and is removed in Group 4E; the Phase 5 zip rebuild regenerates it
  into the staging directory only.

### V-3 — `animate-in` family (Tier 3)
Checked in Group 4D against the built CSS before any decision (see log).

## Phase 4 removal log

### Group 4A — legacy island deletion — DONE, gates ALL PASS
- Fresh import trace: zero imports of `ChatArea / ChatInput / MessageItem /
  Sidebar / Navbar / UserActivityModal` anywhere in the live tree (only hit:
  a JSX comment in CppExplorer). Sidebar search checked per V-1.
- Deleted 6 files, **1,375 lines** (ChatArea 237 · ChatInput 354 ·
  MessageItem 275 · Sidebar 185 · Navbar 178 · UserActivityModal 146).
- Gates: tsc **0** · build **green** · WS **6/6** · security **31/31** ·
  OTP **6/6** · smoke **0 console problems**.
- The same run's explicit `noUnusedLocals/noUnusedParameters` tsc produced
  the fresh TS6133 census (30 findings) used as Group 4D's evidence base —
  list preserved in the coordinator log; highlights: ChatViewScreen
  Shield/Bookmark/Settings/UserPlus, GroupInfoScreen 6 icons + unused
  `onKickMember` destructure, CppExplorer 5 icons + one unused destructure,
  LoginScreen ExternalLink/Send + the two write-only states (Group 4F),
  ChatsScreen ChevronUp/ChevronDown + write-only `setShowSearchInput`,
  SettingsScreen Check + unused `showToast`, MediaPreviewModal ExternalLink,
  NewCategoryModal Plus, OfflineQrModal FileText.


### Group 4B — firebase.ts dead code + LoginScreen verificationToken/otp — DONE, gates ALL PASS
- `saveTwoFactorCode()` / `validateTwoFactorCode()`: **already removed in
  Phase 0** (grep: no trace) — nothing to do. Roadmap's `User as FirebaseUser`
  and `onSnapshot` imports likewise already gone.
- `fetchUserActivities()` + `ActivityRecord` interface: fresh grep showed the
  definition as the ONLY occurrence in the tree (sole caller was the deleted
  UserActivityModal). Removed (−28 lines). `logUserActivity` kept (live write
  side, 6 LoginScreen calls). Transitively unused Firestore imports
  `query/orderBy/limit` pruned (flagged by the group's noUnusedLocals run).
- Re-export surface, per-export fresh grep: **dropped 5** —
  `signInWithPopup`, `signInWithEmailAndPassword`,
  `createUserWithEmailAndPassword`, `updateProfile`, `onAuthStateChanged`
  (LoginScreen imports the first four directly from `firebase/auth`;
  onAuthStateChanged has zero importers). **KEPT 7 as live** (roadmap
  assumption corrected by evidence): SettingsScreen's Phase 1 account centre
  imports `reauthenticateWithCredential`, `EmailAuthProvider`,
  `updatePassword`, `updateEmail`, `sendEmailVerification`, `deleteUser`
  from the service, and App imports `signOut` from the service.
  firebase.ts 575 → 538 lines.
- LoginScreen: `verificationToken` type field + generation + stored property
  removed (write-only in every stored account; zero readers). Tier 3 item
  resolved with written verification: `StoredAccount.otp?` field + the no-op
  `delete updatedAccount.otp;` also removed — accounts load via `JSON.parse`
  (LoginScreen.tsx load path), so legacy records carrying `otp` still parse
  and the property is simply ignored; grep proves no code reads `.otp`
  anywhere; there is no downgrade/compat consumer of the field.
- Gates: tsc **0** · build **green** · WS **6/6** · security **31/31** ·
  OTP **6/6** · smoke **0 console problems**.


### Group 4C — seed-module dead code + server seed block — DONE, gates ALL PASS
- `GROUP_CHANNELS_LIST`: **already removed in Phase 0** (zero references).
- `src/data/initialData.ts` deleted whole (**50 lines**): fresh grep proved
  ZERO importers. `createSynthesizedAudioDataUri` had no callers, and —
  superseding the roadmap's "keep GROUP_BOOKMARKS" on fresh evidence —
  `GROUP_BOOKMARKS` is no longer consumed anywhere: Phase 1/2's GroupInfo
  reads server-persisted `channel.bookmarks` with an honest empty state
  (documented in GroupInfoScreen.tsx:202-204 itself).
- Server seed block (`server.ts:170-186` in audit numbering): **already
  removed in Phase 0.4** — current server.ts states "NO seeded/demo channels"
  and `loadStore()` seeds nothing. One stale log string ("starting with
  seeded defaults") corrected to "starting empty (no seeded data)" so server
  logs stay truthful.
- Gates: tsc **0** · build **green** · WS **6/6** · security **31/31** ·
  OTP **6/6** · smoke **0 console problems**.


### Group 4D — TS6133 sweep + write-only logic — DONE, gates ALL PASS
Fresh `noUnusedLocals/noUnusedParameters` census (30 findings at 4A) driven
to **zero except the two Group 4F states**:
- Unused icon imports removed (19): ChatViewScreen Shield/Bookmark/Settings/
  UserPlus · ChatsScreen ChevronUp/ChevronDown · CppExplorer
  Terminal/Play/Square/Layers/ArrowRight · GroupInfoScreen ShieldAlert/
  Settings/CheckCircle2/Users/Sparkles/AlertTriangle · LoginScreen
  ExternalLink/Send · MediaPreviewModal ExternalLink · NewCategoryModal Plus
  · OfflineQrModal FileText · SettingsScreen Check. (Several roadmap-listed
  names — ChatsScreen MessageSquare, GroupInfoScreen UserPlus/Shield,
  OfflineQrModal Radio — were NOT flagged by the fresh run: Phases 1–2 made
  them live or already removed them. Fresh evidence governed.)
- Dead state/logic removed: CppExplorer's never-read `serverRunning`
  useState · ChatsScreen write-only `setShowSearchInput` (value kept) ·
  SettingsScreen's entire notification-toast mechanism (state + `showToast`
  helper + render block — the helper had zero callers, so the toast could
  never appear) · ChatViewScreen `VoiceWaveformPlayer`'s unused `messageId`
  destructure (prop contract kept).
- **`onKickMember` chain removed end-to-end:** GroupInfoScreen prop +
  destructure, both App mount props, and App's `handleKickMember` (its own
  comment admitted GroupInfo no longer calls it; the Phase 0.3 double-
  decrement history is preserved in GroupInfo's updated comment). Kick still
  applies exactly once via `persistChannelUpdate` — security suite S/P
  checks cover the path and pass.
- **`Channel.category` removed:** type field + both App writes
  (Saved-Messages `'personal'`, group-create ternary). Fresh grep: zero
  readers (Phase 1 custom lists live in `chitthi_lists_v1`, not this field);
  the group-create callback's now-unused `tags` parameter kept as `_tags`
  (the modal's callback contract still passes it). Persisted JSON carrying
  the old property parses harmlessly.
- **`MemberPermissions.canManageMembers` removed:** type field + all 7
  role-literal writes in GroupInfoScreen. The other four permission fields
  ARE read in ChatViewScreen and stay; `canManageMembers` had no reader
  (GroupInfo's `canManageMembersByPermission` is a separate live computed).
- **KEPT with evidence (roadmap claim outdated):** SettingsScreen storage-
  manager `prefs` regex alternative `settings` — `chitthi_settings_v1` IS
  written (`localStorage.setItem(SETTINGS_KEY, …)` for enterToSend), so the
  alternative matches a real key. Not dead.
- **Tier 3 verification — `animate-in` family:** 101 usages in src, but the
  built CSS contains **zero** `animate-in`/`fade-in` rules and index.css
  defines none — the classes are inert no-ops today (same disease Phase 2
  cured for the semantic utilities). Decision: **leave in place**. They are
  not dead code paths; making them real would be a motion-design change
  (Phase 2 already set the spring-token motion system), and stripping 101
  inert strings is churn with zero behavioural effect. Recorded here so a
  future design pass can decide deliberately.
- Gates: tsc **0** · noUnused* run: only the 2 Group 4F states remain ·
  build **green** · WS **6/6** · security **31/31** · OTP **6/6** · smoke
  **0 console problems**.


### Group 4E — LoginScreen write-only states: CENTRAL DECISION — DONE, gates ALL PASS
**Decision: WIRE IN (not delete).** The `firebaseConsoleNotice` text is
genuinely useful — it is the only in-product guidance for the
`auth/operation-not-allowed` failure (Email/Password provider disabled in
Firebase Console), a state a buyer-admin can plausibly hit on first setup —
and it costs one conditional banner to surface. Deleting it would have
silently destroyed that guidance, which the brief forbids.
- `firebaseConsoleNotice` now renders in an alert banner (`role="alert"`,
  same visual language as the error banner) directly beneath it in
  LoginScreen.
- `firebaseEmailSent` now renders one honest line inside the verification
  modal's Email Dispatch Notice, shown only when Firebase's
  `sendEmailVerification` actually succeeded: "Firebase also sent a
  verification email to this address." / BN equivalent. No copy invented
  beyond that factual statement.
- Result: the project's explicit `noUnusedLocals/noUnusedParameters` tsc
  run is now **0 findings project-wide** (baseline census was 30).
- Gates: tsc **0** · build **green** · WS **6/6** · security **31/31** ·
  OTP **6/6** · smoke **0 console problems**.


### Group 4F — dead dependencies + root server.js — DONE, gates ALL PASS
- Fresh grep across `src/`, `server.ts`, `vite.config.ts`, `index.html`:
  `@google/genai`, `motion`, `dotenv` have **zero imports/references**.
  Removed via `npm uninstall @google/genai motion dotenv` (package.json +
  package-lock updated together; build re-verified).
- Root `server.js` deleted per verification V-2: it was a stale pre-Phase-0
  esbuild artefact, byte-identical to the old zip's copy; the documented
  Azure process rebundles it from `server.ts` at zip time (proven again in
  the Phase 5 zip rebuild, which regenerates it into the staging dir only).
  `package.json`'s `clean` script already treated it as a build artefact.
- Gates: tsc **0** · build **green** · WS **6/6** · security **31/31** ·
  OTP **6/6** · smoke **0 console problems**.

**Phase 4 Tier 1 subtotal:** legacy island 1,375 + firebase.ts ~37 +
initialData.ts 50 + TS6133/write-only sweep ~120 + LoginScreen token/otp
~10 ≈ **1,590 lines removed** (inside the roadmap's 1,490–1,900 estimate),
plus 3 dead dependencies and the 21 KB stale `server.js`.


### Group 4G — Tier 2 items + Phase 2 avatar-guard leftovers — DONE, gates ALL PASS
Each Tier 2 item's precondition was verified in writing before acting:
- **CallsScreen duplication — CONSOLIDATED.** Precondition confirmed: App
  rendered two byte-identical `CallsScreen` blocks for tabs `history` and
  `calls`, and BottomNav exposed both. Product call (coordinator): **Calls**
  survives (it is the screen's name and the WhatsApp-pattern label). Removed:
  the App `history` block, the BottomNav History button + its `Clock` icon
  import, and `'history'` from the `ScreenTab` union. `currentTab` is not
  persisted, so no state migration is needed.
- **ChatsScreen current-user fallback — KEPT with evidence.** The dangerous
  arm (`users[0]`) was already removed in Phase 0; what remains is
  prop → the signed-in user's OWN `chithi_auth_user` record (session
  restore), with an explicit in-code rationale. That branch is reachable
  and correct — not the roadmap's landmine. No change.
- **Avatar helper consolidation — DONE.** Precondition confirmed and worse
  than audited: THREE local `initialsAvatarDataUrl` copies (ChatViewScreen,
  ChatsScreen, UserProfileModal) had **drifted** (different gradient
  fallbacks; UserProfileModal used a different text fill). Single canonical
  copy now lives in `src/utils/avatar.ts` (null-safe name, token-resolved
  gradient via its own cssToken, white initials); all three files import it.
  UserProfileModal's local `cssToken` became unused as a side effect and was
  removed too, with its orphaned comments corrected. The single
  `CLEAN_AVATAR_OPTIONS` pick-list has only one copy — nothing to merge.
- **Datetime-local — CONSOLIDATED.** One `toDatetimeLocal()` helper in
  ChatViewScreen now serves both schedule-preset sites. The roadmap's third
  site no longer exists (Phase 1's server-side scheduling rework removed
  that construction); verified by grep — only two construction sites
  remained. (The `min=` attributes' UTC `toISOString().slice(0,16)` pattern
  was left untouched: changing it alters validation behaviour and is a
  product decision, not cleanup.)
- **Orphaned per-room key sweep — IMPLEMENTED** (roadmap's safe rule): in
  App's channels-persist effect, keys `chitthi_ttl_*`,
  `chitthi_wallpaper_*` and `chitthi_draft_*` whose roomId is absent from
  the channel list are deleted. Guards: the first (pre-sync, local-only)
  run never sweeps, an empty channel list never sweeps, and storage errors
  are swallowed (hygiene only).
- **Phase 2 avatar `src` guards — FIXED (all 3 listed spots):**
  SettingsScreen profile header, StoriesBar "My status" tile, ChatsScreen
  header avatar now fall back to `initialsAvatarDataUrl(name)` like their
  sibling spots.
- **`syncUserProfile` call-site consolidation — DEFERRED with reason:**
  8 live call sites on the auth-critical path (5 LoginScreen, 2 App,
  1 UserProfileModal). Phases 0–1 already re-unified the payload shape (the
  drift that caused the status bug is fixed and suite-covered); a wrapper
  saves ~30 lines but risks flows whose full proof needs live Firebase,
  which the sandbox cannot reach. Not worth it in a cleanup phase.
- Gates: tsc **0** · noUnused* run **0 findings** · build **green** ·
  WS **6/6** · security **31/31** · OTP **6/6** · smoke **0 console
  problems**.

### Tier 3 dispositions (verified in writing; default = leave)
| Item | Disposition |
|---|---|
| Root `server.js` | **REMOVED** — provenance verified (V-2): zip process rebundles from `server.ts` via esbuild; root copy was stale. |
| `StoredAccount.otp?` + no-op delete | **REMOVED** — JSON.parse load path; zero readers (Group 4B). |
| Firestore leg of `validateTwoFactorCode()` | Already removed in Phase 0; nothing remained. |
| Legacy `chithi_*`/`chitthi_*` key renames | **LEFT** — renaming without a migration orphans user data; no migration was in scope. |
| Plaintext-password migration branch + FNV fallback | **LEFT** — present and documented in LoginScreen as verify-only legacy support with transparent rehash (Phase 0); deletion needs an owner version-gate/HTTPS policy decision. |
| Dual-auth overlap (local-first + Firebase fallback) | **LEFT** — load-bearing: it is what lets local/demo accounts sign in at all. |
| `OfflineQrModal` machinery | **KEPT** — live: Phase 1's QR add-friend reuses its scanner. |
| Dark-mode CSS | **FROZEN** per Phase 2 ruling — untouched. |
| `animate-in` family | **LEFT** — verified inert in built CSS (Group 4D); making it real is a design decision, not cleanup. |
| Server duplication generally | **LEFT** — only the proven-stale root artefact was removed. |

## PHASE 4 COMPLETE — all groups gated green. Moving to Phase 5.

## Phase 5 log

### Team DOCS — docs pack + demo data + notices — DONE (team-local, coordinator-verified presence)
- `docs/FEATURE_MATRIX.md` refreshed to the true Phase 0–2 set (GIF row:
  "picker shipped — needs owner API key"; group calls: **Not present**).
- `README.md` refreshed (quickstart, production run, docs index, MIT);
  "Performance (measured)" section left as a marked placeholder for
  coordinator-measured numbers — no invented figures.
- New: `docs/ARCHITECTURE.md`, `docs/ENV_REFERENCE.md` (all 12 operator
  vars with file:line evidence; TURN documented as hard-coded ICE list —
  no TURN env var exists), `docs/DEPLOY_GUIDE.md` (incl. Azure zip layout),
  `docs/DATA_MODEL.md` (snapshot keys incl. Phase 1 additions, both
  localStorage families stated honestly, the 200-cap → paged-history
  story), `docs/KNOWN_LIMITATIONS.md` (matches in-product copy: not E2EE,
  no cloud sync, no group calls, GIF key, unguessable upload URLs, free
  TURN pool, rules = owner deploy).
- `scripts/demo-data.mjs` + `docs/DEMO_DATA.md`: builtins-only generator
  writing a clearly-labelled demo dataset (`Demo Alice`/`Demo Bob`,
  `_demoDataset` marker + `DEMO_DATASET.txt`) to an argv target dir;
  **refuses the repo's own data/ dir before any write** (tested both
  absolute and relative paths, exit 1). Shipped store.json md5
  `f79ef3ce…` identical before/after all tests — still pristine.
- `THIRD_PARTY_NOTICES.md`: licences read programmatically from installed
  packages (13 runtime + 12 dev, post-Phase-4 dependency list).
- Root template artefacts **deleted** (recoverable trash, restorable to
  2026-11-29): `metadata.json`, `firebase-blueprint.json` — repo-wide grep
  proved zero runtime/build references. `firebase-applet-config.json`
  confirmed live (read by server.ts + firebase.ts) — untouched.
- LICENSE verified: MIT, © 2026 Maruf Talukder, complete text.
- Env discrepancies: **none** (.env.example matches the code exactly).


### Team SPLIT — route-level code-splitting — DONE (team-local gates green)
- Lazy (React.lazy + Suspense, token skeleton fallbacks): CallsScreen,
  SettingsScreen, GroupInfoScreen, VoiceCallModal, OfflineQrModal,
  NewCategoryModal, CameraModal, MediaPreviewModal, UserProfileModal —
  modals now mount only while open (each component's effects were verified
  to gate on open/re-init on mount, so behaviour is equivalent).
  ChatViewScreen kept eager with a sound reason: App renders it
  unconditionally in the desktop right column, so laziness would only add
  a skeleton flash. ProfileCard stays eager (statically imported by
  ChatViewScreen — dynamic import would be ineffective).
- Vendor splitting (vite.config.ts rolldown groups): `vendor-react`
  218,759 B and `vendor-firebase` 567,935 B, modulepreloaded and now
  independently cacheable.
- **Numbers (fresh build):** main app chunk 1,505,864 → **343,293 B
  (−77.2%)**, gzip 423,738 → 87,693 B. Honest initial-load total
  (main + eager vendors + runtime): 1,505,864 → **1,131,103 B (−24.9%)** —
  React+Firebase are needed at login, so they are NOT counted as savings;
  their win is cacheability. **380,337 B deferred** into lazy chunks
  (OfflineQrModal alone 169,907 B). Total JS overhead of splitting: +0.35%.
- Caveat flagged to coordinator: ClaimUsernameModal's lazy import is
  ineffective because the module also exports `useUsernameAvailability`,
  statically imported by eager LoginScreen/UserProfileModal — fixing needs
  a hook extraction (coordinator integration item).


### Team PWA — manifest, icons, service worker, install prompt — DONE (team-local gates green)
- `public/manifest.webmanifest`: name "চিঠি · Chitthi", standalone,
  theme/background #FFFFFF (matches the light `--c-bg` token), icons
  192 + 512 + maskable 512. Icons rendered from one master SVG
  (brand-gradient tile, envelope glyph, চিঠি wordmark — legibility verified
  at 48px) via headless Chromium + PIL downscales; favicon.ico (16/32/48)
  + apple-touch-icon included and wired in index.html.
- `public/sw.js` (cache `chitthi-shell-v1`): precaches shell + manifest +
  icons; cache-first for `/assets/*`, `/stickers/*`, `/icons/*`;
  network-first navigations with cached-shell offline fallback; **never
  intercepts** non-GET, `/api/*`, `/ws`, `/uploads/*`, or any cross-origin
  request — no send queueing/replay, so offline sends keep surfacing as
  failed/retry through the app's own path (the honest-offline rule).
- `src/pwa.ts` + registration in `src/main.tsx` (production-only, fully
  guarded): `beforeinstallprompt` capture, `canInstall()`/`promptInstall()`
  returning the browser's real outcome, dismissal persisted
  (`chitthi_pwa_dismissed`), and a self-contained glass install banner.
  Coordinator integration item: App.tsx one-line `maybeShowInstallBanner()`
  wiring (the helper is tree-shaken until imported).
- Verified by the team: tsc 0, build green, dist/ contains manifest/sw/
  icons and index.html references them; store.json md5 unchanged.
  Real-device installability (Lighthouse/actual prompt) is owner-device
  territory — recorded in owner knocks.


### Team A11Y — WCAG 2.2 AA labelling pass — DONE (team-local gates green)
- Census (src/components): `aria-label`/`aria-labelledby` **13 → 260**,
  `role=` **7 → 54**, state attributes ~3 → 106; `<button` count unchanged
  (370) and the team verified programmatically that **no className value
  changed in any file** — attributes only.
- Call controls all named (decline/accept/mute/camera/flip/screen-share/
  end/speaker, `aria-pressed` on toggles; call surface is a labelled
  dialog). 37 sheet/modal containers got `role="dialog" aria-modal` +
  heading-matched labels; 3 context menus got `role="menu"`; BottomNav
  tabs got `aria-label` + `aria-current`; switches got `role="switch"` +
  `aria-checked`; every unlabelled form control got an aria-label.
  A post-pass classifier found zero unlabelled icon-only buttons.
- Deliberately left (attribute-only fixes would falsely promise keyboard
  operability — they need element/handler restructuring): Settings nav
  rows, chat rows, header identity pill, message-media preview divs,
  member-picker rows, avatar-picker imgs, the StoriesBar add-status span
  nested inside a button, and full tablist semantics (tabs use
  `aria-pressed` today). Recorded for a future structural a11y pass.


### Coordinator integration (after the four teams landed)
- **Install-banner wiring:** App.tsx now imports `maybeShowInstallBanner`
  from `./pwa` and offers it once per session, 4 s after sign-in (pwa.ts
  no-ops without a real browser prompt / after dismissal / in standalone).
- **Username-hook extraction (SPLIT caveat closed):** `useUsernameAvailability`
  + `UsernameCheckLine` + `UsernameCheckState` moved from
  ClaimUsernameModal.tsx to new `src/components/usernameAvailability.tsx`;
  LoginScreen/UserProfileModal repointed. ClaimUsernameModal now emits as
  its own lazy chunk (4,373 B) and the build's INEFFECTIVE_DYNAMIC_IMPORT
  warning is gone.
- **App.tsx aria:** audited — its only icon-only buttons (two banner ✕)
  already carry `aria-label="Dismiss"`; the remaining buttons have visible
  text. App needed no additions.

### Full-surface walkthrough — evidence
Method (Phase 2 precedent, honestly scoped): logged-in surfaces were driven
in demo mode on a scratch store via CDP Chromium (demo flags are
hard-disabled in production, so a production server cannot be driven this
way); the production build is covered by the login smoke (0 console
problems) + build/chunk inspection + the staged-package smoke below.
- Surfaces verified OK (19/19 with the noted proof swap): chat list ·
  stories bar · global search (opened; "Search messages in all chats…"
  input present) · new-group modal · group creation · chat view · message
  send rendered in room · in-chat search · **group info** (dedicated run:
  identity-pill click rendered the full GroupInfo surface — governance,
  invite link, join approval, permissions; the combined run's check raced
  the post-search UI state, the dedicated run is the proof) · calls tab +
  screen · settings screen · settings → Privacy / Data and storage /
  Scheduled / Account · profile editor · desktop two-pane chat view.
- Console accounting for the logged-in walkthrough: exactly 3 problems,
  all environmental with provenance — 2× Vite HMR websocket failures
  (dev-server-only machinery; production has no HMR) and 1× Firestore
  "could not reach backend" (the sandbox has no route to Google backends;
  identical limitation recorded in Phase 2). **Zero app-code console
  errors.** Production login smoke: **0 problems**.
- The PWA install banner was captured rendering on the production build
  ("Install চিঠি · Chitthi — Add Chitthi to your home screen…"), i.e.
  Chromium fired `beforeinstallprompt` — the installability criteria
  (manifest + SW + icons) are met in this environment; it is absent in
  dev runs by design (SW registers in production only).

### Performance — measured (also published in README)
- Initial-load JS 1,505,864 B (gzip 423,738) → **1,140,213 B (gzip
  324,254)**, main chunk 352,530 B; 527,420 B across 13 lazy chunks.
- Login surface, 390px emulation — throttled (4× CPU + Regular-4G, cold):
  LCP **7.44 s**, CLS **0.00**, INP ≤48 ms (3 synthetic taps). Warm:
  LCP 0.54 s, CLS 0.00, INP ≤16 ms.
- Budget verdicts, honestly: CLS **met** · INP **met** (small sample) ·
  LCP **NOT met** on the cold throttled run (met warm). Method limits:
  single cold sample, shared-CPU sandbox, headless Chromium — a
  pessimistic lab bound, not field data. Identified lever (eager Firebase
  chunk; Firestore deferral) recorded in README as a future architecture
  change, not smuggled into packaging.

### Azure deploy zip — REBUILT + smoke-tested
- New `chitthi-azure-deploy.zip` (**2,260,996 B**) at
  `~/workspace/your_files/chitthi/chitthi-azure-deploy.zip`, containing
  only `dist/` (Phases 1+2+4+5 build, incl. PWA assets) + regenerated
  `server.js` (esbuild `--packages=external` from current server.ts,
  80,732 B) + trimmed package.json (express/ws/nodemailer only) +
  package-lock + production node_modules. **No `data/` inside.**
- Staged-package smoke (run exactly as Azure runs it, scratch data dir):
  `/api/health` OK · page title correct · manifest + sw.js + main chunk
  all HTTP 200 · **unauthenticated WS login refused (fail-closed)** ·
  fresh data dir gained no seeded store. NOT deployed (owner's hosting
  session is parked).

### Fresh-install verification
Brand-new data dir + fresh browser profile against the production build:
login screen renders, **0 console problems**, and the server writes no
store file at all on boot — a fresh install contains no fake data and no
demo content. Shipped `data/store.json` md5 `f79ef3ce…` — unchanged from
the Phase 4/5 baseline; every test ran on scratch dirs.

## FINAL GATES — coordinator-run, Phases 4+5 complete — **ALL PASS**
- `npx tsc --noEmit` → **0 errors**; explicit noUnusedLocals/Parameters
  run → **0 findings project-wide** (baseline census: 30).
- `npm run build` → **green** (no ineffective-import warnings).
- WS suite **6/6** · security suite **31/31** · OTP suite **6/6**.
- Production smoke **0 console problems** · full-surface walkthrough:
  all surfaces verified, zero app-code console errors.
- Fresh-install boot verified pristine · bundle before/after recorded.

## Sale-readiness checklist (roadmap wording, answered honestly)
- Phase 0 gate passed: **YES**
- Two-device test passed: **NO — owner knock #2** (signalling proven;
  in-call media, screen share and the weak-connection badge still need
  the owner's two devices)
- Zero console errors: **YES** for the production build (login smoke +
  staged package); logged-in walkthrough noise was environmental only
  (itemised above)
- Budgets measured and met: **PARTIAL** — measured and published; CLS and
  INP met, cold-throttled LCP not met (7.44 s vs 2.5 s budget; warm
  0.54 s). Field data on a real device is the missing measurement.
- WCAG 2.2 AA spot-audit passed: **PARTIAL** — labelling pass complete
  (aria-labels 13→260+ in components, dialogs/roles/state attributes,
  focus rings + 44px targets + Phase 2 contrast maths all in place);
  structural items remain (clickable-div rows without keyboard handlers,
  full tablist semantics) and are listed in the A11Y section — an
  attribute-only fix would have falsely promised keyboard operability.
- README/env/LICENSE complete: **YES** (README refreshed + measured
  performance section; ENV_REFERENCE complete with zero discrepancies
  vs .env.example; LICENSE MIT © Maruf Talukder; THIRD_PARTY_NOTICES
  added)
- Fresh install contains no fake data: **YES** (verified three ways)
- No marketing claim the code doesn't keep: **YES** (FEATURE_MATRIX and
  KNOWN_LIMITATIONS aligned with in-product copy: no E2EE, no cloud
  sync, no group calls, GIF needs a key)

## Blocked / deferred — with reasons (nothing silently dropped)
- **Live GIF feed** — needs the owner's free Klipy/GIPHY API key
  (unchanged from Phase 1; picker + env slots + honest empty state ship).
- **Cold-LCP optimisation (Firestore deferral)** — architecture change to
  the auth path; documented in README as the identified next step.
- **Structural accessibility rework** (keyboard handlers for clickable
  rows, tablist semantics, StoriesBar nested-control) — needs element
  restructuring, explicitly out of the attribute-only pass's honesty
  rules; itemised in the A11Y section.
- **`syncUserProfile` helper consolidation** — deferred in Group 4G
  (auth-path risk vs ~30-line gain; payloads already re-unified).
- **Demo dataset** is a script + docs, never shipped data (by design).

## Owner knocks (updated)
1. Deploy `firestore.rules` via Firebase Console (unchanged; no Phase
   4/5 rules edits were made).
2. Two-device test — in-call media, screen share, weak-connection badge,
   **plus** the Phase 2 visual pass and the PWA install/banner on a real
   phone (sandbox Chromium proves the criteria; a real device is the
   final proof).
3. Create a free Klipy (or GIPHY) API key → `VITE_GIF_PROVIDER` +
   `VITE_GIF_API_KEY` to light up the GIF picker.
4. Firestore cloud sync (next architecture step; would also subsume the
   cold-LCP Firestore work).
5. Hosting session — **the deploy zip is now rebuilt** (post Phases
   1+2+4+5) and smoke-tested; ready whenever the owner resumes it.
6. SMTP live test (login-alert emails ride the same path).
7. Paid TURN decision. 8. GitHub push (per-push say-so).
