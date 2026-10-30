# চিঠি · Chitthi — Architecture (one-pager)

## Shape

```
Browser (React + Vite SPA, src/)
  │  HTTPS  REST  ── /api/*  (channels, stories, blocks, users, usernames,
  │                          sessions, scheduled, reminders, uploads,
  │                          search, stars, call-logs, auth OTP, health)
  │  WSS    /ws   ── realtime frames (JSON, see below)
  ▼
server.ts — one Node process: Express + ws
  ├─ serves dist/ in production (SPA fallback); Vite middleware in dev
  ├─ in-memory state (Maps/arrays) ──debounced 500 ms──► $CHITTHI_DATA_DIR/store.json
  ├─ uploads ──► $CHITTHI_DATA_DIR/uploads/<24-hex>.<ext>
  ├─ email verification + login alerts ──► SMTP (nodemailer), when configured
  └─ verifies Firebase ID tokens against Google's secure-token JWKS (RS256)
Firebase (client-side, src/services/firebase.ts)
  ├─ Auth — sign-in identities; the ID token is the server credential
  └─ Firestore — users/{uid} profiles (+ private contact subcollection),
                 activities; Storage — avatars/{uid}.jpg
WebRTC (browser ⇄ browser) — media is P2P; only signalling rides the WS.
```

## Client / server split

- **Client (`src/`):** React SPA. Screens (chats, chat view, calls, stories,
  settings, profile), the WS client (`src/services/socketService.ts`),
  Firebase wrapper (`src/services/firebase.ts`), and per-device state in
  `localStorage` (see `docs/DATA_MODEL.md`). The client renders; it does not
  decide membership, blocks, or identity — the server does.
- **Server (`server.ts`):** the single source of truth for channels,
  messages, stories, blocks/reports, the public user directory, username
  claims, scheduled queue, reminders, stars, call logs, highlights and
  story mutes. In development it mounts Vite in middleware mode; in
  production (`NODE_ENV=production`) it serves the built `dist/`.

## WebSocket protocol shape

One socket per session at path `/ws` (max payload 12 MB). All frames are
JSON objects with a `type` discriminator:

- **Handshake:** client → `user:login {userId, username, idToken?,
  deviceLabel?, presenceMode?}` → server replies `session:ready` (stable
  session id) or `auth:error {error}` (`invalid_token` /
  `identity_mismatch` / `token_required` — identity errors are fatal, the
  client does not reconnect-loop on them).
- **Messaging:** `message:send` → server persists, broadcasts
  `message:new` **only to sessions with room access**, replies
  `message:ack {messageId, roomId}`; delivery/read tracked as
  `deliveredTo[]`/`readBy[]` and pushed as `message:receipts`;
  `message:read` marks read. `message:update` / `message:updated` carry
  edits, pins, polls and forwards; `message:react` carries reactions.
- **Rooms:** `room:join`; `room:history {roomId, before?, limit?}` →
  paged history (`hasMore`, `oldestId`) or `room:denied`. Room access:
  channel rooms check `memberIds`/owner/admins (empty = legacy open);
  DM room id is `[idA, idB].sort().join('__')` — only those two users.
- **Presence/typing:** `presence:update` (audience-filtered, with real
  `lastSeenAt`), `typing:indicator`, `user:heartbeat`.
- **Calls:** `call:signal` — invite/accept/offer/answer/ICE/end, always
  targeted or room-scoped, never a global broadcast. A send or invite
  across a block is dropped server-side.
- **Server pushes:** `channel:created` (upsert), `channel:deleted`,
  `scheduled:sent` / `scheduled:failed`, `reminder:due`,
  `session:revoked`.

REST and WS share one auth rule (below); new REST routes are listed in
`docs/DATA_MODEL.md` only where they shape stored data — the route table
itself lives in `server.ts`.

## Auth

- **Firebase ID-token verification (server):** when `user:login` (or a
  REST call's `Authorization: Bearer …`) carries an ID token, the server
  verifies it against Google's secure-token JWKS (RS256, project id read
  from `firebase-applet-config.json`, fallback `modern-patrol-vt3g1`),
  fail-closed. The session's `userId` must equal the token `sub`, else
  `auth:error identity_mismatch`. REST uses the same check via
  `requireAuth`; the client also sends `X-Session-Id` (mirrored to
  sessionStorage by the socket service) so session-scoped REST works.
- **Demo-mode gate:** with **no** token, a caller may assert an identity
  (`userId` / `X-Demo-User` header) **only** when
  `CHITTHI_ALLOW_UNAUTH_DEMO=true` **and** `NODE_ENV !== 'production'`.
  The bypass is hard-disabled in production. Email-verification codes are
  returned in the API response under the same pattern
  (`CHITTHI_DEMO_OTP=true`, non-production only); otherwise codes go by
  SMTP email only. See `docs/ENV_REFERENCE.md`.

## Server-authoritative areas

- **Groups:** channels (owner/`memberIds`/`adminIds`, sections,
  permissions, invite codes, join requests, events) persist in the
  snapshot; writes are owner/admin-checked; the send path enforces
  read-only sections and `permissions.post`.
- **Scheduling:** `scheduled[]` lives on the server; a 5 s sweeper fires
  due items through the normal send path (room ACL + block checks),
  exactly-once by schedule id.
- **Stories:** stories, reactions, mutes and highlights live on the
  server (24 h expiry; audience-filtered reads); the client's per-user
  cache is a mirror, replaced wholesale from GET — never a second source
  of truth.

## Persistence

Server state is in-memory Maps/arrays, snapshotted to disk on change
(debounced 500 ms) as one JSON file: `$CHITTHI_DATA_DIR/store.json`
(default `./data`). `CHITTHI_DATA_DIR` exists so hosts can point it at a
persistent folder outside the deployment directory (on Azure:
`/home/chitthi-data`) — redeploys then never wipe history. Shape:
`docs/DATA_MODEL.md`. Email-verification codes deliberately do **not**
persist (short-lived, in-memory, attempt-capped).

## Upload pipeline

`POST /api/uploads` (auth) takes JSON `{name, mime, dataBase64}`, caps at
25 MB, and stores the bytes as `$CHITTHI_DATA_DIR/uploads/<24-hex>.<ext>`
(12 random bytes, hex). It returns `{url: '/uploads/<file>', name, size,
mime}`; media messages carry that URL instead of base64. Files are served
at `GET /uploads/:file` with no auth check — the unguessable name is the
only barrier (documented limitation, see `docs/KNOWN_LIMITATIONS.md`).

## Calls: signalling + media

Signalling rides the WS `call:signal` frames above. Media is direct
WebRTC P2P (`RTCPeerConnection` in `VoiceCallModal.tsx`), with screen
share via `replaceTrack`. ICE servers are **hard-coded in the client**:
Google STUN (`stun.l.google.com:19302`, `stun1.…`) plus the free Open
Relay TURN pool (metered.ca, public `openrelayproject` credentials).
There is **no TURN environment variable** — a dedicated TURN service
means editing that ICE list (see `docs/KNOWN_LIMITATIONS.md`).

## Firestore usage

- `users/{uid}` — the public profile, keyed by **Firebase UID** (Phase 0
  fixed the legacy synthetic `user_<email>` keying; a legacy doc
  copy-migrates to the UID doc on login, untouched).
- `users/{uid}/private/contact` — owner-only subcollection holding the
  email; the public doc never carries it, and `fetchAllUsers` strips
  `email` defensively.
- `activities` — login/session activity records written by the client.
- Firestore is **not** used for chat history — messages live in the
  server snapshot (see `docs/KNOWN_LIMITATIONS.md`: no cloud sync yet).
  `firestore.rules` in the repo includes the owner-only `private/{…}`
  match; deploying it is an owner step (Firebase Console).
