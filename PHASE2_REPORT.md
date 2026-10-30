# Phase 2 — Liquid Glass (Light) Redesign — Implementation Report (running log)

**Spec:** `ROADMAP_SELLABLE.md` Phase 2 (2.1–2.5) + Liquid Glass research
(`~/workspace/research_notes/liquid-glass-premium-portfolio-research-20261030-1210/report.md`).
**Coordinator gates after every fix-group:** `npx tsc --noEmit` · `npm run build` ·
WS suite · security suite · OTP suite · headless production smoke (CDP Chromium,
zero console errors) · token grep. Test servers always run with a scratch
`CHITTHI_DATA_DIR`; shipped `data/store.json` must stay the pristine empty snapshot.

## Baseline (before any Phase 2 change) — 2026-10-30
- `npx tsc --noEmit` → **0 errors** · `npm run build` → **green**
- WS suite **ALL PASSED (6/6)** · security suite **31/31** · OTP suite **6/6**
  (coordinator-run via scratch servers on :3000 demo / :3001 strict / :3002 no-flag)
- Hard-coded colour census (live source): **356 hex literals** across
  `src/components + src/App.tsx + src/index.css`; **2,411 Tailwind palette-shade
  class usages** (slate/blue/…) across components + App. One `.glass-bar`
  utility (index.css:77-86) diverging from the verified recipe; most modals solid.

## Token contract (dictated by coordinator; all teams build against this)

Existing semantic vars stay: `--c-primary --c-grad-from --c-grad-to --c-bg
--c-surface --c-bubble-in --c-pressed --c-text --c-text-2 --c-text-faint
--c-online --c-badge --c-badge-text --c-danger`.
New vars: `--c-border --c-glass-bg --c-glass-border --c-header-bg --c-focus
--c-skeleton --c-skeleton-shine` + glass shadow vars `--sh-glass-lift --sh-glass-rim`.
Radius: `--r-card:28px --r-sheet:28px --r-bubble:20px --r-control:14px --r-pill:999px`
(concentric: inner = outer − inset, via calc where nested).
Motion: `--ease-spring: linear(0,.18,.42,.72,.95,1.06,1.04,1.01,.99,1)`,
`--ease-out: cubic-bezier(0.25,0.1,0.25,1)`, `--dur-press:160ms --dur-sheet:320ms`.
Type: `--fs-bubble:16px --lh-bubble:1.45 --fs-body:15px --lh-body:1.55`.
Utilities (index.css): `.glass .glass-pill .glass-sheet` (verified recipe),
`.glass-bar` redefined onto the recipe, `.bg-header .border-token .text-primary
.bg-primary .text-danger .bg-danger .text-online .bg-online .skeleton
.bn-safe` (Bangla-safe line-height/padding), global `:focus-visible` ring from
`--c-focus`, reduced-transparency + reduced-motion media rules.

**Palette mapping for the sweep** (light-first; semantic tokens flip under
`.dark` automatically, so `bg-slate-100 dark:bg-slate-800`-style pairs collapse
to ONE token class): slate-50→surface · slate-100→bubble-in · slate-200→pressed/
border-token · slate-400→text-faint · slate-500→text-2 · slate-700/800/900→text ·
blue-600→primary · violet-600→grad-to (brand-only contexts) · red-500→danger ·
green-500→online · white surfaces→bg-app · black scrims→token scrim.
**Gate grep definition (honest scope):** hex/rgb/rgba/hsl literals must be ZERO
in live component files + App.tsx (allowed only in `src/index.css` and
content-data files, e.g. wallpaper/avatar colour data — centralised/documented);
palette-shade classes eliminated from all live files touched by Phase 2.
**Excluded, documented:** the legacy island (`ChatArea ChatInput MessageItem
Sidebar Navbar UserActivityModal`) is dead code owned by Phase 4 removal —
sweeping files scheduled for deletion is wasted churn; they are not imported
by the live tree (verify at final gate).
**Refraction (SVG feDisplacementMap): SKIPPED by coordinator decision** —
optional per spec, Chromium-only, heaviest perf layer; plain-blur recipe ships
everywhere. Recorded here so it is not silently dropped.

## Wave plan
- **Wave 1:** Team A `src/index.css` (foundation) · Team B `ChatsScreen.tsx` +
  `BottomNav.tsx` · Team C `ChatViewScreen.tsx` · Team D `VoiceCallModal.tsx` +
  `CallsScreen.tsx` · Team E `StoriesBar.tsx` + `LoginScreen.tsx`.
- **Wave 2:** Team F settings/profile/modals · Team G `App.tsx` + onboarding.
- **Wave 3 (coordinator):** full gates, visual QA screenshots, report close-out.

## Item log

### Team A — foundation (`src/index.css` only) — DONE
- Build green after the change; built CSS verified to contain `.glass-pill`,
  `prefers-reduced-transparency`, `:focus-visible`, new faint values.
- **Contrast fix with maths:** light `--c-text-faint` #9CA3AF (2.54:1 ✗) →
  **#68707E** = **4.99:1 vs #FFFFFF**, **4.70:1 vs #F7F8FA** (glass-tint
  composite) ✅. Dark #64748B (3.93:1 ✗) → **#6E7E95** = **4.53:1 vs #0B1220** ✅.
- All contract tokens/utilities landed: glass recipe shared by
  `.glass/.glass-pill/.glass-sheet/.glass-bar` (blur 14px saturate 140%, tint
  var, rim + lift vars, sheen ::after z-index:-1 under isolation, radii from
  tokens; `.glass-bar` deliberately radius-free — its existing usages supply
  their own `rounded-*`), `.bg-header .border-token .text-primary .bg-primary
  .text-danger .bg-danger .text-online .bg-online .bn-safe .skeleton
  .focus-ring`, global `:focus-visible`, reduced-transparency (glass→solid
  `var(--c-bg)`) and strengthened reduced-motion rules. `@theme` skipped
  (optional; hand utilities are the contract). No SVG refraction (per decision).

### Team D — calls (`VoiceCallModal.tsx` + `CallsScreen.tsx`) — DONE (team-local)
- Incoming-call action bar + in-call control bar → single `.glass-pill` each
  (≤1 glass surface per call state); gradient incoming backdrop kept (only
  gradient in the modal); weak-connection badge → solid `bg-badge` chip for
  contrast on glass/video.
- CallsScreen header solid `bg-header` + `border-token`; rows stay solid
  (no glass list items). New `CallsSkeleton` (6 `.skeleton` rows) driven by a
  real `logsLoading` flag off the existing merge fetch — no fake delay.
  Designed zero-history empty state (EN/BN), no fake calls.
- Sweep (both files): hex 23→0, palette-shade classes 22→0, `dark:` pairs 4→0;
  nearest-token choices documented by the team (amber family → `bg-badge`).
  `transition-all` eliminated; glass bars transition transform only with
  spring tokens (blur can never animate). Targets ≥44px verified/enlarged.
- Phase 1 integrity grep-verified by the team: `replaceTrack` ×6 incl.
  added-sender path, stop-sharing, camera/mute restore, getStats badge,
  single-audio echo fix, server log merge, redial/busy/declined untouched.
- Note: the team checked before Team A's CSS landed on disk; integration
  gates (coordinator) will verify the utilities in the built CSS.

### Team B — chat list (`ChatsScreen.tsx` + `BottomNav.tsx`) — DONE (team-local)
- tsc 0 project-wide at check time. Sweep: hex/rgba literals **82→0**,
  palette-shade classes **16→3** (justified below), `dark:` pairs →0,
  `focus:outline-none` 5→0.
- BottomNav → `.glass-pill` + `rounded-[var(--r-pill)]`, spring press
  micro-interaction (scale .96, dur-press token, transform only), ≥44px tabs.
- Header solid `bg-header` (per map). Phase 1 handlers untouched. Pinned cap
  implemented as grid `.slice(0,5)`; overflow pinned chats remain in the main
  list with pin indicator.
- Bangla clipping: `leading-tight` removed; `.bn-safe` applied to every
  Bangla-bearing truncated element (rows, chips, menus, search, BottomNav labels).
- Desktop truncation: the three hover-only Pin/Mute/Archive row buttons
  (~90px) deleted → one compact 44px ⋯ button opening the existing Phase 1
  context menu; long-press behaviour unchanged; keyboard-focusable.
- `ChatsSkeleton` (6 `.skeleton` rows) wired to initial mount via rAF (no fake
  delay). Zero-chats empty state (EN/BN, Find-people primary → existing flow).
  Context menu + search/join dialogs → `.glass-sheet` + spring tokens.
  Avatar SVG gradient stops now read from `--c-grad-from/to` at runtime.
- **Justified exception:** `amber-500` ×3 (Sun icon + two "away" presence
  dots) — no away token existed. **Coordinator fix planned:** add `--c-away`
  + `.bg-away/.text-away` to index.css and swap the 3 usages at integration.

### Team E — stories + login (`StoriesBar.tsx` + `LoginScreen.tsx`) — DONE (team-local)
- tsc 0 at check time. Sweep: StoriesBar hex 20→15 (all inside the
  centralised `STORY_TEXT_BACKGROUNDS` content palette + `isLightBg`),
  LoginScreen hex 42→4 (Google "G" logo brand SVG fills — third-party brand
  asset), palette-shade classes 91+57→0, `dark:` lines →0 in both files.
- Viewer chrome: top bars `.glass-pill`, whole bottom action area one
  `.glass` container = exactly 2 glass surfaces per viewer; progress fills
  `bg-primary`; creation sheets → `.glass-sheet`. Stories empty state: dashed
  hint tile (EN/BN, `.bn-safe`), no fake stories.
- Login: wordmark `tracking-tight` dropped, `.bn-safe px-2 py-1` (also OTP
  modal Bangla heading); card solid `bg-surface` + `var(--r-card)` (not
  glass, per map); gradient only on brand badge/rings.
- All focus suppressions removed from both files; viewer/login controls
  ≥44px; sheet/viewer motion on spring tokens; story progress logic untouched.
- Cross-team note: `TEXT_BGS` kept as a legacy alias of
  `STORY_TEXT_BACKGROUNDS` because ProfileCard (Wave 2) imports it.

### Team C — chat view (`ChatViewScreen.tsx`) — DONE (team-local)
- Handler/prop/id parity proven: onClick 121→121, `on*=` 167→167,
  `msg-${id}` anchors 3→3 — styling only, Phase 1 features untouched.
- Counts: hex/rgba literals 55→0, palette-shade tokens **743→0**, `dark:`
  301→6 (white-alpha, allowed), `outline-none` 12→0, `glass-bar`/
  `backdrop-blur` 10/13→0.
- **Signature move done:** header `glass-bar` → solid `bg-header` +
  `border-token`; identity block wrapped in `.glass-pill`; section tabs
  de-glassed. Composer → one `.glass` surface, concentric inner radius
  `calc(var(--r-card) − 6px)`, send keeps `bg-brand-gradient` (only gradient
  left, plus contact-card brand avatar — both allowed).
- Bubbles → `var(--fs-bubble)`/`var(--lh-bubble)` (12px mobile sizing gone),
  radius `var(--r-bubble)`; `.bn-safe` ×5 (bubble text, quote chips, reply banner).
- **13 sheets → `.glass-sheet`** + 3 popups → `.glass`; scrims lost
  `backdrop-blur-xs` (perf law). All focus suppressions removed; header/
  composer buttons ≥44px; sheets animate on spring tokens.
- Mapping notes: amber/yellow→primary (pin/star accents; no warning token),
  @me pill → `bg-badge`, search `<mark>` → `bg-primary`. Wallpapers rebuilt
  with `color-mix()` over token vars; avatar SVG + export-HTML resolve token
  values via a new `cssToken()` helper (getComputedStyle) — no embedded hex.

## WAVE 1 INTEGRATION GATES — coordinator-run, all Wave 1 in — **ALL PASS**
- Coordinator micro-fix first: `--c-away: #F59E0B` + `.bg-away/.text-away`
  added to index.css (light + dark); ChatsScreen's 3 justified `amber-500`
  usages swapped → ChatsScreen palette classes now **0**.
- `npx tsc --noEmit` → **0 errors** · `npm run build` → **green**
- WS suite **ALL PASSED (6/6)** · security suite **31/31** · OTP suite **6/6**
- Production smoke (headless Chromium, fresh scratch store): login screen,
  **0 console problems**.
- Built CSS verified to contain `.bg-away`, `.glass-pill`,
  `prefers-reduced-transparency`. Shipped `data/store.json` still pristine.
- Census after Wave 1: remaining literals concentrated exactly in the Wave 2
  files (SettingsScreen 66 hex, UserProfileModal 16, ProfileCard 12, App 8,
  ClaimUsernameModal 8, GroupInfoScreen 3, OfflineQrModal 3; StoriesBar's 15
  are the documented content palette). Wave 1 files: 0 hex/palette (B/C/D)
  or documented exceptions only (E).

### Team G — App shell + onboarding (`App.tsx` + new `Onboarding.tsx`) — DONE (team-local)
- tsc 0 project-wide at check time. App.tsx sweep: hex 8→0, palette classes
  20→0, `dark:` pairs 10→0. Shell panes → `bg-app/bg-surface/border-token`;
  session-revoked banner → `bg-danger` + `role="alert"`; reminder banner →
  token surface + `bg-primary` View; toast → `bg-badge` + `role="status"`;
  jump-flash ring hex → `cssToken('--c-away')` helper (Team C pattern).
- **Onboarding shipped:** `Onboarding.tsx` — 3 screens (welcome EN/BN →
  privacy controls incl. honest not-E2EE note → pick @username), one
  `.glass-sheet`, Esc→skip, `role="dialog"`, dots/Back/Next/Skip ≥44px,
  spring tokens, 0 hex / 0 palette classes in the new file.
- **No-double-prompt wiring (coordinator to verify):** claim-prompt effect
  returns early while `chitthi_onboarded_v1_<uid>` is unset; Skip/Esc sets
  BOTH the onboarded flag and `chitthi_claim_prompted_<uid>`; Choose-username
  sets the onboarded flag and opens the existing ClaimUsernameModal via the
  existing state (guarded if a username already exists). Login early-return
  untouched → smoke still lands on login.
- Search empty state: confirmed the global-search modal lives entirely in
  ChatsScreen (already has a designed EN/BN no-results state) — nothing to do
  in App, as briefed.

### Team F — settings/profile/modals (9 files) — DONE (team-local)
- tsc 0 project-wide at check time; handler parity vs pre-work backups
  identical in all swept files (GroupInfo onClick/onChange/fetch 75/29/8,
  Settings 38/8/6, …). `TEXT_BGS` import, `chitthi://` routing, fail-closed
  claim flows, session revoke, invite/approval/delete handlers untouched.
- **15 overlay panels → `.glass-sheet`** + spring tokens; MediaPreviewModal
  chrome → `.glass-pill` (viewer precedent); scrims keep black-alpha with
  **backdrop-blur utilities → 0** in all 9 files. Settings header sticky
  solid `bg-header`; cards solid token surfaces at `var(--r-card)`.
- Sweep totals: hex **105→0**, palette classes **1,152→0**, `dark:` lines
  →0 (one survivor is the qrcode lib's `color.dark` option KEY, value now a
  cssToken read), `transition-all` →0, focus suppressions →0. Generated
  artefacts use local `cssToken()` helpers in 3 files (SVG gradient stops,
  QR module colours). `.bn-safe` ×17. New designed empty states: Settings
  scheduled-manager + sessions lists, NewCategoryModal member list;
  GroupInfo bookmarks tab upgraded to the designed pattern.
- Mapping decisions noted: role chips → primary/online tints (labels carry
  meaning); GroupInfo gradient banner card → solid `bg-surface`;
  `bg-brand-gradient` remains only on true brand marks.
- **Process incident (team-reported, self-caught):** a first scripted pass
  corrupted string terminators in 4 files; caught by tsc, files restored
  from backup and re-swept affix-aware; final state is the clean tsc-0
  result. Coordinator final gates + visual QA below re-verify independently.

## COORDINATOR FIXES (after Wave 2, before final gates)
1. **Dead variant utilities — the phase's biggest find.** The semantic
  utilities (`bg-pressed`, `text-app`, …) were plain `@layer` CSS classes,
  which Tailwind v4 does NOT generate variant forms for: **266 usages** of
  `hover:bg-pressed`, `hover:text-primary`, `placeholder:text-app-faint`,
  `group-hover:*`, … compiled to NOTHING in the built CSS (verified: 0
  `hover\:bg-pressed` rules in dist). This predates Phase 2 (Phase 0 redesign
  round) and the sweep multiplied the usages. **Fix:** all 19 semantic colour
  utilities redefined as Tailwind v4 `@utility` in index.css → variants now
  generate (verified present in built CSS). Hover/placeholder states across
  the whole app are alive for the first time.
2. **Scrim blur sweep:** 13 remaining `backdrop-blur-*` utilities on modal
  scrims / over-media chips / the gradient FAB (CallsScreen, ChatsScreen,
  LoginScreen, StoriesBar) removed — scrims are pure black-alpha now, per
  the performance law. The live tree's only `backdrop-filter` is the token
  glass recipe in index.css. (4 usages remain in the legacy island — Phase 4.)
3. **CppExplorer tokenised** (it was unassigned in Wave scopes — coordinator
  catch): chrome slate scale → black/white-alpha per Team G's dark-code
  precedent, active tabs → `bg-primary`, run button → `bg-online`. 14
  palette classes remain, all simulated-terminal/code CONTENT (emerald
  terminal text, traffic-light dots, code-block accents) — documented
  exception, same class as the story-background palette.
4. **Chat-list header overflow (390px) fixed:** the Phase 1 presence picker
  made the single-row header wider than a phone viewport — the wordmark was
  squeezed out and the presence select ran off-screen. Header is now the
  iOS large-title pattern (wordmark row, then a full-width actions row on
  <sm; single row on sm+), presence select capped at 80px, language label
  icon-only below 420px. Verified by measurement (select right edge 373 ≤
  374 container edge; title at full 357px) and screenshot.
5. **Onboarding footer overflow fixed:** bilingual button labels first
  wrapped (stacked EN/BN), then overflowed with `nowrap` (Next cut off).
  Final: EN-only Back/Skip (body copy stays fully bilingual; Next keeps
  "Next · পরেরটি"), all single-line and inside the sheet — screenshot-verified.

## FINAL GATES — coordinator-run, all of Phase 2 in — **ALL PASS**
- `npx tsc --noEmit` → **0 errors** · `npm run build` → **green**
- WS suite **ALL PASSED (6/6)** · security suite **31/31** · OTP suite **6/6**
- Production smoke (headless Chromium, fresh scratch store): login screen,
  **0 console problems**. Shipped `data/store.json` still the pristine empty
  snapshot after every run. `firestore.rules` untouched, not deployed.

## VISUAL QA (CDP Chromium, demo-mode seeded session on a scratch store)
Screenshots in `phase2-screenshots/`: login-mobile, login-desktop,
onboarding-mobile, chats-mobile, calls-mobile, newgroup-modal-mobile,
chatview-mobile, chatview-mobile-msg, chatview-desktop,
chatview-desktop-reduced-transparency, settings-mobile.
Live-app measurements (not just pictures):
- **Glass recipe in the running app:** visible glass surfaces compute
  `backdrop-filter: blur(14px) saturate(1.4)` — the verified values.
- **Glass count:** chat view = exactly 2 (header identity `.glass-pill` +
  `.glass` composer); chat list + onboarding = 2 (`.glass-pill` nav +
  `.glass-sheet`). Per-surface map holds: headers solid, rows solid.
- **Bubble type:** sent-message paragraph computes **16px / 26.4px** —
  the 12px mobile sizing is gone.
- **Reduced transparency VERIFIED:** under `prefers-reduced-transparency:
  reduce`, the nav computes `backdrop-filter: none` on solid
  `rgb(255,255,255)`. **Reduced motion VERIFIED:** nav transition-duration
  computes `1e-05s` (springs → instant).
- **End-to-end in the real UI:** group created from the modal, message sent
  and rendered, settings screen, calls empty state, stories empty state,
  search no-results state — all screenshotted in their Phase 2 form.
- Environment note: real signup could not be driven in the sandbox browser
  (its TLS/tunnel path to Firebase fails — `ERR_TUNNEL_CONNECTION_FAILED` /
  SSL errors — while the shell reaches Google fine). QA therefore used the
  app's own demo-mode session restore (localStorage seed + demo server
  flags, scratch data dir). Production console cleanliness rests on the
  production smoke above; dev-mode console noise (Vite HMR, Firestore
  reachability) is environmental, itemised in the QA runs.

## FINAL TOKEN CENSUS (live tree)
- Hex/rgba literals in live components + App: **19 total**, all documented
  content exceptions — StoriesBar 15 (centralised `STORY_TEXT_BACKGROUNDS`)
  + LoginScreen 4 (Google "G" brand SVG). Everything else: **0**.
  (Baseline was 356 incl. index.css; all remaining values live in
  index.css tokens or the two content exceptions.)
- Palette-shade classes in live components + App: **14**, all in
  CppExplorer's simulated terminal/code content (see Coordinator fix 3).
  All UI chrome: **0** (baseline 2,411).
- Legacy island (`ChatArea/ChatInput/MessageItem/Sidebar/Navbar/
  UserActivityModal`) verified NOT imported anywhere in the live tree —
  untouched, owned by Phase 4.

## Phase 2 EXIT GATE — assessment
- Every screen matches the per-surface map: ✅ (screenshots + live glass
  audit; de-glassed header + identity pill is the signature move, visible
  in chatview-mobile-msg.png).
- ≤2 glass surfaces per viewport: ✅ measured in the running app.
- Text-on-glass 4.5:1 on worst-case backdrops: ✅ by token maths (faint
  4.70:1 on the glass-tint composite; primary text is #111827 on 0.45-white
  glass over light content — worst case ≈ white backdrop → >12:1).
- Reduced-transparency/motion verified: ✅ computed-style proof above.
- Zero hard-coded colours outside tokens: ✅ per the census + documented
  content exceptions (gate definition recorded at the top of this report).

## Blocked / deferred — with reasons (nothing silently dropped)
- **SVG refraction (feDisplacementMap):** skipped by coordinator decision —
  optional per spec, Chromium-only, heaviest perf layer; the plain-blur
  recipe ships everywhere. Revisit only as a gated enhancement.
- **Story viewer screenshot:** the viewer chrome was glass-converted by
  Team E and audited in source (exactly 2 glass surfaces), but no story
  existed in the QA store to open the viewer for a screenshot (creating one
  needs a media upload through the sandbox browser). All other key screens
  are screenshotted.
- **Avatar `src` guards (pre-existing, Phase 0/1 inconsistency):**
  `SettingsScreen.tsx:653`, `StoriesBar.tsx:1183`, `ChatsScreen.tsx:800`
  render `src={user.avatar}` without the `|| initialsAvatarDataUrl(name)`
  fallback sibling spots use. Real accounts carry initials data-URLs
  (remove-photo reverts to one), so impact is limited to externally-shaped
  user objects — but the one-line guards belong in a Phase 4/5 polish pass.
- **`docs/FEATURE_MATRIX.md`** still describes the Phase 0 feature set
  (carried from Phase 1) — packaging-phase doc refresh.
- **Dark mode:** frozen per ruling — kept functional (tokens flip, glass
  dark variant pinned), received no new design work, blocked nothing.

## Owner knocks (unchanged + Phase 2 additions in bold)
1. Deploy `firestore.rules` via Firebase Console (no Phase 2 rules changes).
2. Two-device in-call media test.
3. Create a free Klipy (or GIPHY) API key → `VITE_GIF_PROVIDER` +
   `VITE_GIF_API_KEY` to light up the GIF picker.
4. Firestore cloud sync (next architecture step).
5. Hosting session (parked by owner 2026-10-30; deploy zip predates
   Phase 1 AND Phase 2 — rebuild before use).
6. SMTP live test.
7. Paid TURN decision. 8. GitHub push (per-push say-so).
9. **Real-device visual pass of the Liquid Glass redesign** (the sandbox
   browser cannot reach Firebase, so logged-in QA ran in demo mode;
   a two-minute look on the owner's phone is the final visual proof).
