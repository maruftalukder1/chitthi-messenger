# চিঠি · Chitthi — Data Model

Three stores, three jobs: the **server snapshot** (chat truth), the
browser's **localStorage** (per-device client state), and **Firestore**
(profiles/auth). See `docs/ARCHITECTURE.md` for how they connect.

## 1. Server snapshot — `$CHITTHI_DATA_DIR/store.json`

One JSON file, written by `server.ts` (`saveStoreNow`, debounced 500 ms
after any change) and loaded at boot (`loadStore`). Unknown/missing keys
are tolerated; a missing file means "start empty" — **a fresh install
contains no seed data**. Top-level shape (Phase 1 state):

| Key | Type | Contents |
|---|---|---|
| `version` | number | Snapshot format version (`1`). |
| `savedAt` | number (epoch ms) | When the snapshot was written. |
| `channels` | array | Server channels (`ServerChannel`): `id`, `name`, `description`, sections, `ownerId`, `memberIds[]`, `adminIds[]`, derived `membersCount`; Phase 1 additions: `inviteCode?`, `inviteEnabled?`, `joinApproval?`, `joinRequests[]`, `permissions {post, pin, manage}`, `events[]` (with per-user RSVPs), sections may carry `readOnly`. |
| `messages` | object: `roomId → ChatMessage[]` | All retained messages per room (DM room id = `[idA, idB].sort().join('__')`). Messages carry `deliveredTo[]` / `readBy[]` receipts and, per type, poll data, `mimeType?`, `storyRef?`, `contactCard?`, `stickerPack?`/`stickerId?`, `expiresAt?` for disappearing messages. |
| `stories` | array | Live stories: `{id, userId, userName, userAvatar, media, type, createdAt, expiresAt, viewers[{userId, viewedAt}]}` + Phase 1 `audience?`, `kind?` (`image`/`text`/`video`), `textData?`, `reactions[{userId, emoji}]`. Expired stories are dropped at load. |
| `blocks` | object: `userId → blockedId[]` | Per-user block lists (Phase 0). Enforced in the send/call paths. |
| `reports` | array | Report records `{id, reportedId, reason?, …}` (Phase 0). Submitting a report also blocks. |
| `directory` | array | Public user-directory entries (Phase 1): `{id, name, username?, avatar, about?, mood?, discoverable?, privacy {photo, about, lastSeen, findMe, groupAdd}}`. The server-side copy used for claims/search; profiles themselves live in Firestore. |
| `usernames` | object: `handle → userId` | Claimed usernames (Phase 1). Handles are validated (5–20, `[a-z0-9_]`, …) and claimed atomically. |
| `releasedHandles` | object: `handle → {userId, …}` | Handles in the 14-day reclaim grace after release — reclaimable only by the same user. |
| `scheduled` | array | Server-side scheduled messages (Phase 1): `{id, ownerId, roomId, message, dueAt, status}` — fired by the 5 s sweeper, exactly-once; failed items are kept with `status: 'failed'` for retry. |
| `reminders` | array | Message reminders (Phase 1): `{id, ownerId, roomId, messageId, dueAt, status}` — at due time the owner gets `reminder:due`; items auto-complete after firing (and are retained so a fired-while-away reminder can be recovered on login). |
| `stars` | object: `userId → message snapshot[]` | Starred messages, stored as full snapshots per user (Phase 1). |
| `callLogs` | object: `userId → log[]` | Server call logs (Phase 1), written for the caller and mirrored for the peer with direction flipped; latest 200 served per user. Live **sessions are not in the snapshot** — they are in-memory socket state; only the `seenDevices` memory (below) persists. |
| `storyMutes` | object: `userId → mutedUserId[]` | Story author mutes (Phase 1). |
| `highlights` | object: `userId → story snapshot[]` | Story highlights (Phase 1) — snapshots that survive story expiry. |
| `seenDevices` | object: `userId → deviceLabel[]` | Device labels already seen per user; a first-seen label triggers the login-alert email (SMTP, when configured). |
| `userLastSeen` | object: `userId → epoch ms` | Last real presence timestamp per user (audience-filtered when served). |
| `userEmails` | object: `userId → email` | Emails captured from verified Firebase tokens, used for login alerts. |

Not persisted, by design: email-verification codes (in-memory,
short-lived, attempt-capped) and live WebSocket sessions.

Alongside the snapshot, `$CHITTHI_DATA_DIR/uploads/` holds uploaded
media files (`<24-hex>.<ext>`), referenced from messages by URL.

The **shipped** `data/store.json` in the repo is the pristine empty
snapshot — `{"version":1, "channels":[], "messages":{}, "stories":[],
"blocks":{}, "reports":[]}` (later keys appear on the first save).
Demo data is never shipped; it is generated on demand
(`docs/DEMO_DATA.md`).

## 2. Browser localStorage — two historical prefix families

Honest note: the codebase uses **two** key families. Older code writes
`chithi_*` (one "t"); newer code (Phase 0/1) writes `chitthi_*`. Both
are live and load-bearing — the storage manager counts keys under both
prefixes. Per-key detail:

**`chithi_*` (legacy family):**

| Key | Contents |
|---|---|
| `chithi_auth_user`, `chithi_auth_logged_in` | Stored session (current user JSON + login flag). |
| `chithi_users_v5`, `chithi_channels_v5`, `chithi_messages_v5`, `chithi_call_logs_v5` | Client caches of users / channels / messages / call logs. |
| `chithi_registered_accounts` | Locally registered accounts (incl. PBKDF2 password hashes). |
| `chithi_theme` | `dark` when dark mode is on. |
| `chithi_offline_qr_…` | Offline QR transfer payloads. |

**`chitthi_*` (Phase 0/1 family):**

| Key | Contents |
|---|---|
| `chitthi_settings_v1` | Settings prefs JSON (e.g. `enterToSend`). |
| `chitthi_scheduled_v1` (+ `chitthi_sched_claim_<id>`, legacy `chitthi_scheduled`) | Legacy local schedule queue + cross-tab claim records. New schedules are server-side; the local queue migrates to the server on login and remains only as the creation-failure fallback. |
| `chitthi_stories_<userId>`, `chitthi_stories_seen_<userId>` | Per-user story cache + seen set (mirror of the server, replaced wholesale on GET). |
| `chitthi_story_audience_<userId>`, `chitthi_close_friends_<userId>`, `chitthi_story_mutes_<userId>`, `chitthi_highlights_<userId>` | Story prefs: remembered audience, close-friends list, mutes mirror, highlights mirror. |
| `chitthi_draft_<roomId>_<sectionId>` | Composer drafts (`{text, replyTo}`). |
| `chitthi_ttl_<roomId>` | Per-room disappearing-message timer. |
| `chitthi_wallpaper_<roomId>` | Per-room wallpaper choice. |
| `chitthi_lists_v1` | Custom chat lists/folders. |
| `chitthi_privacy_v1`, `chitthi_presence_mode` | Privacy audiences + presence mode (Online/Away/Invisible). |
| `chitthi_recent_searches_v1`, `chitthi_reminders_seen_v1` | Recent global searches; per-device seen set for fired reminders. |
| `chitthi_onboarded_v1_<uid>`, `chitthi_claim_prompted_<uid>` | Onboarding shown / username-claim prompted flags. |
| `chitthi_device_label`, `chitthi_ringtone`, `chitthi_data_saver` | This device's label (session list / login alerts), ringtone choice, data-saver toggle. |

Plus `chitthi_session_id` in **sessionStorage** (not localStorage): the
live WS session id, mirrored by the socket service so REST calls can
send `X-Session-Id`.

## 3. Firestore

| Path | Contents |
|---|---|
| `users/{uid}` | Public profile doc, keyed by **Firebase UID**: name, avatar, status/about/mood, username display fields. **Never carries the email.** Legacy `users/{user_<email>}` docs (pre-Phase 0 synthetic IDs) copy-migrate to the UID doc on login; the legacy doc is left untouched. |
| `users/{uid}/private/contact` | Owner-only subcollection doc holding the email address. `firestore.rules` has the matching owner-only `private/{document=**}` rule (written, deployment is an owner step). |
| `activities` | Activity records (user id/name, action, timestamp) written on login/session events. |

Firebase Storage holds avatars at `avatars/{uid}.jpg`. Firestore is
**not** a message store — chat history lives only in §1 + §2 (see
`docs/KNOWN_LIMITATIONS.md`).

## 4. The 200-message history cap — what changed

- **Before Phase 1 (and in the old README):** the server kept only the
  most recent **200 messages per room** — on load and on send, older
  messages were destructively trimmed and unrecoverable from the
  server. The Phase 0-era docs stated this as a limitation.
- **Phase 1 removed the cap.** `loadStore` retains **all** messages
  ("Phase 1 cap lift: ALL messages are retained (no destructive
  trim)"), and the send path no longer trims.
- **Current behaviour — paged history:** `room:history` accepts
  `{before?: messageId, limit?: number}`. With no `before`, it returns
  the newest page (default page size 200); with `before`, the page
  ending just before that message. The response adds `hasMore: boolean`
  and `oldestId?: string` so the client can page backwards (global
  search jumps fetch up to 5 pages to reach a match). So "200" is now
  a **page size**, not a retention limit: nothing is deleted for age —
  only expired disappearing messages are purged, and deleted-message
  tombstones remain tombstones.
