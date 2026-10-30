# চিঠি · Chitthi — Known Limitations

Honest limits of the shipped Phases 0–2 build. Where the app itself
makes a claim to users, this file matches that claim in substance —
Chitthi's privacy UI and onboarding say the same things.

## Security & privacy

- **Not end-to-end encrypted.** In the app's own words (Settings →
  Privacy, and the Privacy Policy view): *"Messages are sent over an
  encrypted connection (HTTPS/WSS; calls use WebRTC DTLS-SRTP) and
  stored on the Chitthi server so they can sync across your devices.
  They are not end-to-end encrypted yet — end-to-end encryption is on
  the roadmap."* The fuller policy text adds: *"Chitthi is NOT
  end-to-end encrypted: the server stores messages in a form the
  service can read, so you should not treat Chitthi as a channel for
  highly sensitive information."* Onboarding repeats the short version:
  *"Chitthi is not end-to-end encrypted yet — please do not share
  passwords or financial details in chats."*
- **`firestore.rules` is written but not deployed by this repo.** The
  rules (including the Phase 0 owner-only `private/contact` match) are
  complete in the repo and the UID keying they depend on is verified —
  but deploying them is an **owner step** in the Firebase Console
  (project `modern-patrol-vt3g1`). Until that deploy happens, the
  deployed rules are whatever the Console currently holds.
- **Uploads are served by unguessable URL.** `GET /uploads/:file`
  performs no membership/auth check (a documented Phase 1 limitation):
  files are protected only by their 24-hex-character random names.
  Anyone with the link can fetch the file.

## Sync & storage

- **No cloud sync yet.** Chat history is **server-local**: it lives in
  the single server's disk snapshot (`store.json`, § DATA_MODEL) plus
  each browser's local stores. Firestore holds profiles/auth only —
  there is no Firestore/cloud sync of messages, so history follows the
  server instance, not a multi-device cloud mailbox. (The in-product
  "sync across your devices" wording above refers to devices talking
  to the same server.)
- **One server, one snapshot file.** Persistence is a single JSON
  snapshot on the server's disk (debounced writes). There is no
  database, replication, or backup story beyond the host's disk —
  point `CHITTHI_DATA_DIR` at durable storage and back it up yourself.
- **Per-device data stays per-device.** Drafts, wallpapers, chat lists,
  archive/mute/pin state, wallpapers and settings live in one browser's
  `localStorage` and do not follow the user to another device.

## Calls

- **No group calls — 1:1 only.** There is no group-call button (it was
  removed in Phase 0) and no SFU/multi-party calling; group calls are
  unbuilt (Phase 3 in the roadmap).
- **Free public TURN pool limits call reliability.** Calls use Google
  STUN plus the free Open Relay (metered.ca) TURN service with its
  public credentials, hard-coded in the client. A shared free relay
  can be slow, rate-limited or unavailable, and symmetric-NAT pairs may
  fail to connect; a dedicated (paid) TURN service is an owner decision
  and requires editing the ICE list in `VoiceCallModal.tsx` — there is
  no TURN env var.
- **In-call media is code-verified, not device-proven.** Signalling is
  proven end-to-end by the test suites; audio/video between two real
  devices (including the Phase 1 screen share and weak-connection
  badge) still awaits the owner's two-device test.
- **Connecting-timeout quirk (accepted):** the ~20 s connecting timeout
  starts at invite-send and can fail a still-ringing call before the
  30 s no-answer timer fires.

## Features

- **GIF picker needs an owner API key.** The picker, service and env
  slots (`VITE_GIF_PROVIDER` / `VITE_GIF_API_KEY`) ship, but a live GIF
  feed needs a free Klipy or GIPHY key created by the project owner.
  Until then the picker shows a designed empty state — no fake feed.
- **Poll quiz answers are a UX courtesy, not secrecy.** In quiz mode
  the correct option travels with the message payload to every
  recipient; it is revealed in the UI only after voting, but a modified
  client could read it earlier (noted in the code).
- **Email delivery needs SMTP.** Without `SMTP_HOST`/`SMTP_USER`/
  `SMTP_PASS`, verification mail uses a test/demo transport and is not
  really delivered; login-alert emails ride the same path. A live SMTP
  test is still an owner step.
- **Dark mode is frozen.** It remains functional (tokens flip), but
  Phase 2's Liquid Glass design work targeted the light theme only,
  per the owner's ruling.
- **Scheduled-message dual path.** New schedules are server-side and
  fire with the app closed — but if the server is unreachable at
  creation time, the item falls back to the local queue, and local
  items only fire while the sender's app is open (the UI says so).
