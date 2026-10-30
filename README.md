# চিঠি · Chitthi

Chitthi is a realtime messenger: direct messages (DMs), group chats with
sections, stories/status, 1-to-1 WebRTC voice and video calls with screen
sharing, and server-side scheduled messages — plus reactions, replies,
pins, polls (incl. quiz mode), starred and saved messages, reminders,
global search, chat export, and a full identity system (server-enforced
@usernames, QR add-friend, privacy audiences, account centre).

The interface is bilingual (English / বাংলা), with a light "Liquid
Glass" design (Phase 2) and a functional dark mode. A fresh install
starts completely empty — no seed users, stories or fake data.

## Feature summary

- **Messaging** — text/media/voice messages via a real upload pipeline
  (25 MB cap), reactions, quote-reply, edit, delete-for-everyone, pins,
  forwards, polls, typing indicators, server-tracked delivery/read
  receipts, disappearing messages, bundled SVG sticker packs, and a GIF
  picker (needs an owner API key — see Limitations).
- **History & search** — no message-retention cap; paged history
  (`room:history`), global search (Ctrl/Cmd+K), in-chat search with
  `from:`/`has:`/`before:`/`after:` filters, chat export (HTML/JSON/TXT).
- **Calls** — 1-to-1 voice/video WebRTC calls: screen share, ICE
  restart, weak-connection badge, server-synced call logs. No group
  calls.
- **Groups** — server-persisted channels with sections (incl. read-only
  announcements), owner/admin permissions enforced server-side, invite
  links with optional join approval, permission matrix, events with
  RSVP, shared-media browser.
- **Stories** — server-synced stories with audiences
  (everyone/contacts/close/custom), text & video stories, reactions,
  replies, highlights and mutes.
- **Identity & safety** — Firebase-UID-keyed profiles, server-claimed
  @usernames with a 14-day reclaim grace, find-people by username or
  QR, audience-aware ProfileCards, block/report enforced server-side,
  active-session management with remote revoke, login-alert emails.
- **Scheduling** — scheduled messages fire from the **server** (the app
  does not need to stay open), plus per-message reminders.
- **AI assistant** — server-proxied AI chat (`POST /api/ai/chat`,
  auth-required, rate-limited; the provider key stays server-side).
  Available only when `NVIDIA_API_KEY` is configured — otherwise the
  endpoint returns an honest not-configured state.

Full detail: [docs/FEATURE_MATRIX.md](docs/FEATURE_MATRIX.md).

## Architecture

- **Client** — React + Vite single-page app (`src/`). It renders the UI,
  talks to the server over REST and WebSocket, and uses Firebase only
  for authentication and profile storage (see below).
- **Server** — one Node process (`server.ts`): Express for the REST API
  (`/api/*` — channels, stories, blocks, users, usernames, sessions,
  scheduled messages, reminders, uploads, search, call logs, auth OTP,
  `GET /api/config`, `POST /api/ai/chat`) plus a `ws` WebSocket server
  for realtime messaging, presence, typing and call signalling. In
  development it mounts Vite in middleware mode; in production it
  serves the built `dist/` with an SPA fallback.
- **Auth & rules** — Firebase Authentication issues the ID token the
  server verifies on every REST/WS call; profiles are keyed by Firebase
  UID. `firestore.rules` governs direct Firestore access (user profiles
  and the owner-only private contact subcollection; chat history is
  **not** stored in Firestore).
- **Persistence** — server state is held in memory and snapshotted to
  `store.json` under `CHITTHI_DATA_DIR` (default `./data`), with media
  uploads in the `uploads/` folder inside that same directory. There is
  no external database to provision for the chat data itself.

Full detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quickstart

**Prerequisite:** Node.js

```bash
npm install
npm run dev
```

`npm run dev` runs `server.ts`, which serves the app (in development it
mounts Vite in middleware mode). Open the address it prints (default
`http://localhost:3000`).

No environment variables are required for a basic local run. Copy
`.env.example` to `.env` / `.env.local` only for the optional settings
(for example, real SMTP so email-verification codes are actually
emailed instead of using the server's test transport, or the GIF picker
key). Every variable the code reads is documented in
[docs/ENV_REFERENCE.md](docs/ENV_REFERENCE.md).

## Production

```bash
npm install
npm run build
NODE_ENV=production npm start
```

`npm run build` builds the client into `dist/`. In production mode
(`NODE_ENV=production`), `server.ts` serves `dist/` as static files
with an SPA fallback, alongside the API and WebSocket server, on `PORT`
(default `3000`). Set `CHITTHI_DATA_DIR` to a persistent folder so
redeploys don't wipe chat history. Hosting on Azure App Service:
[docs/DEPLOY_GUIDE.md](docs/DEPLOY_GUIDE.md).

The bundled deployment package (see the deploy guide) instead runs the
esbuild-bundled server directly — `NODE_ENV=production node server.js`
— with no `tsx` or build step on the host. From a source checkout, use
`npm start` above.

## Environment variables

No variable is required for a basic local run. Every name below was
verified against `process.env` in `server.ts` (plus the two client-side
GIF variables, read via `import.meta.env` in `src/`); the full
reference is [docs/ENV_REFERENCE.md](docs/ENV_REFERENCE.md).

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | Port the server listens on. | `3000` |
| `NODE_ENV` | `production` serves `dist/` and hard-disables both demo flags; anything else is development mode. | unset (development) |
| `CHITTHI_DATA_DIR` | Directory for the server snapshot (`store.json`) and its `uploads/` folder. Point it at persistent storage so redeploys don't wipe history. | `./data` |
| `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` | SMTP credentials for verification and login-alert email. All three must be set for real delivery; otherwise a test transport is used and mail is not really delivered. | unset |
| `SMTP_PORT` | SMTP port; `465` is treated as secure (TLS). | `587` |
| `TURN_URL` / `TURN_USER` / `TURN_PASS` | Dedicated TURN server for call media, served to clients by `GET /api/config`. `TURN_URL` may be a comma-separated URL list. When `TURN_URL` is unset, the public Open Relay demo pool is used instead. | unset |
| `NVIDIA_API_KEY` | Provider key for the AI assistant (`POST /api/ai/chat`). Server-side only — never sent to clients. When unset, that endpoint returns `503 ai_not_configured`. | unset |
| `AI_MODEL` | Model used by the AI assistant endpoint. | `nvidia/nemotron-3.5-lightning-30b-a3b` |
| `CHITTHI_DEMO_OTP` | **Demo / local only — never in production.** When `true` (and not production), the verification endpoint may return the code in its response for local testing. | unset (`false`) |
| `CHITTHI_ALLOW_UNAUTH_DEMO` | **Demo / local only — never in production.** When `true` (and not production), callers may authenticate with a self-asserted/demo user instead of a verified Firebase ID token. | unset (`false`) |
| `VITE_GIF_PROVIDER` / `VITE_GIF_API_KEY` | Client build-time GIF picker provider (`klipy` or `giphy`) and its owner-created key. Both must be set or the picker shows its not-configured empty state. | unset |

## Screenshots

_Screenshots coming soon._

## Performance (measured)

Measured by the coordinator in Phase 5 (2026-10-30) on the production build
in headless Chromium; method + limits are stated with the numbers because
they matter.

**Bundle (after Phase 4 dead-code removal + Phase 5 code-splitting):**

| Chunk | Bytes | gzip | When it loads |
|---|---|---|---|
| Main app | 352,530 | 88,977 | initial |
| vendor-react | 218,759 | 67,537 | initial (preloaded) |
| vendor-firebase | 567,935 | 167,142 | initial (preloaded) |
| rolldown runtime | 989 | 598 | initial |
| **Initial-load total** | **1,140,213** | **324,254** | |
| 13 lazy chunks (calls, settings, group info, voice call, QR, C++ explorer, modals…) | 527,420 combined | — | on demand |

Before Phase 5 the initial load was a single 1,505,864 B chunk (gzip
423,738 B): initial JS fell 24% and 380 KB of app code moved behind
tabs/modals that a chat-list session may never open. Vendor chunks are
counted in the initial total on purpose — React and Firebase are needed
at login; their win is independent caching, not disappearance.

**Web Vitals (login surface, mobile 390px emulation):**

| Metric | Budget | Throttled run* | Warm run | Verdict |
|---|---|---|---|---|
| LCP | ≤ 2.5 s | 7.44 s | 0.54 s | **Not met cold** under harsh emulation; met warm |
| CLS | ≤ 0.1 | 0.00 | 0.00 | Met |
| INP | ≤ 200 ms | ≤ 48 ms (3 synthetic taps) | ≤ 16 ms | Met (small sample) |

\* 4× CPU slowdown + "Regular 4G" (1.6 Mbps / 150 ms RTT) emulation, cold
profile, shared-CPU sandbox VM, headless Chromium. A single cold sample —
treat it as a pessimistic lab bound, not a field measurement. The main
lever for cold LCP is the eager Firebase chunk; deferring Firestore
behind a dynamic import is the identified next optimisation and is an
architecture change, deliberately not smuggled into a packaging pass.
The service worker (Phase 5) caches the shell, so repeat visits skip the
network cost entirely.

## Documentation

| Doc | What it covers |
|---|---|
| [docs/FEATURE_MATRIX.md](docs/FEATURE_MATRIX.md) | The true shipped feature set (Phases 0–2), feature by feature, with sync notes. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Client/server split, WS protocol, auth, persistence, uploads, calls, Firestore. |
| [docs/ENV_REFERENCE.md](docs/ENV_REFERENCE.md) | Every environment variable the code reads: purpose, default, required/optional. |
| [docs/DEPLOY_GUIDE.md](docs/DEPLOY_GUIDE.md) | Local production run + the Azure App Service path + post-deploy smoke checklist. |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | `store.json` snapshot shape, localStorage key families, Firestore collections, the history-cap story. |
| [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) | Honest limits: no E2EE, no cloud sync, no group calls, GIF key, TURN pool, and more. |
| [docs/DEMO_DATA.md](docs/DEMO_DATA.md) | Generate a clearly-labelled demo dataset (`scripts/demo-data.mjs`) for demos/QA. |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | Dependency licences; [LICENSE](LICENSE) is Chitthi's own (MIT). |
| `PHASE0_REPORT.md` · `PHASE1_REPORT.md` · `PHASE2_REPORT.md` | Implementation reports with gate evidence for each phase. |

## Honest limitations (short version)

- **Not end-to-end encrypted** — messages are stored on the server in a
  form the service can read; the app says so in its own privacy UI.
- **No cloud sync yet** — history is server-local (this server's disk
  snapshot) plus per-browser local stores.
- **No group calls** — calling is 1-to-1 only.
- **GIF picker needs an owner API key** (Klipy/GIPHY); until then it
  shows an honest empty state, never a fake feed.

Full list: [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md).

## Licence

MIT — see [LICENSE](LICENSE). © 2026 Maruf Talukder.
