# চিঠি · Chitthi — Environment Variable Reference

Every variable the code actually reads, verified by grepping
`process.env` in `server.ts` and `vite.config.ts`, and `import.meta.env`
in `src/`, on 2026-10-30 (Phase 5). `.env.example` is the annotated
template; this file is the reference. **Discrepancies vs `.env.example`:
none** — all 12 variables below are documented there (see the note at the
bottom for the one code read that is not an operator setting).

## Server (`server.ts`, read via `process.env`)

| Variable | Purpose | Default | Required |
|---|---|---|---|
| `PORT` | Port the server listens on. Hosts such as Azure App Service assign this. (`server.ts:15`) | `3000` | Optional |
| `NODE_ENV` | `production` → serve the built `dist/` with SPA fallback, and hard-disable both demo flags below. Any other value (or unset) → Vite development mode. (`server.ts`, incl. `:2650`) | unset (development) | Optional locally; **set to `production` for any real deployment** |
| `CHITTHI_DATA_DIR` | Directory holding the disk snapshot (`store.json`) and the `uploads/` folder. Point it at persistent storage outside the deployment directory so redeploys don't wipe history. (`server.ts:431`) | `./data` next to `server.ts` | Optional |
| `SMTP_HOST` | SMTP server host for email-verification mail and first-seen-device login alerts. Real delivery requires `SMTP_HOST` + `SMTP_USER` + `SMTP_PASS` **all** set; otherwise the server falls back to a test/demo transport and mail is not really delivered. (`server.ts:833,854`) | unset | Optional (as a set) |
| `SMTP_USER` | SMTP username. See `SMTP_HOST`. | unset | Optional (as a set) |
| `SMTP_PASS` | SMTP password. Keep secret; never commit a real value. | unset | Optional (as a set) |
| `SMTP_PORT` | SMTP port. Port `465` is treated as secure (TLS). (`server.ts:857`) | `587` | Optional |
| `CHITTHI_DEMO_OTP` | **Demo / local development only — never in production.** When `true` **and** `NODE_ENV !== 'production'`, `POST /api/auth/send-2fa-code` may include the verification code in its API response for local testing. Ignored in production. (`server.ts:975`) | unset (`false`) | Optional — demo only |
| `CHITTHI_ALLOW_UNAUTH_DEMO` | **Demo / local development only — never in production.** When `true` **and** `NODE_ENV !== 'production'`, WebSocket/REST callers may authenticate with a self-asserted user ID / `X-Demo-User` header instead of a verified Firebase ID token. Hard-disabled in production (the server logs a warning if it is set there). (`server.ts:144`) | unset (`false`) | Optional — demo only |

## Build / dev tooling (`vite.config.ts`, read via `process.env`)

| Variable | Purpose | Default | Required |
|---|---|---|---|
| `DISABLE_HMR` | Set to `true` to disable Vite HMR and file watching (saves CPU in constrained dev environments). Development only. (`vite.config.ts:17,19`) | unset (HMR on) | Optional |

## Client (`src/`, read via `import.meta.env` — Vite build-time)

These are inlined at **build time**: changing them requires a rebuild.
They are public by design (they ship in the client bundle).

| Variable | Purpose | Default | Required |
|---|---|---|---|
| `VITE_GIF_PROVIDER` | GIF picker provider: `klipy` or `giphy`. Must be set together with `VITE_GIF_API_KEY`, or the picker shows its "not configured" empty state (no fake feed). Read in `src/services/gifService.ts:25`. | unset (picker unconfigured) | Optional — required only to light up the GIF feed |
| `VITE_GIF_API_KEY` | API key for the provider above; the owner creates it with Klipy or GIPHY. Restrict it by referrer/domain in the provider dashboard. Read in `src/services/gifService.ts:26`. | unset | Optional — see above |

## TURN / ICE — no environment variable exists

Grepping `src/` for TURN configuration finds **no env var**: the ICE
server list is hard-coded in `src/components/VoiceCallModal.tsx` —
Google STUN (`stun:stun.l.google.com:19302`,
`stun:stun1.l.google.com:19302`) plus the free Open Relay TURN pool
(`turn:openrelay.metered.ca:80` / `:443` / `:443?transport=tcp`,
username/credential `openrelayproject`). Using a dedicated TURN service
means editing that list in code; there is nothing to set in `.env`.

## Not operator settings

- `import.meta.env.BASE_URL` (`src/data/stickerPacks.ts:19`) is Vite's
  built-in base-path value, not a `.env` setting — listed here only so
  the grep record is complete.
- `firebase-applet-config.json` (repo root) is a **file**, not an env
  var: `server.ts` reads the Firebase `projectId` from it (fallback
  `modern-patrol-vt3g1`) and the client imports it in
  `src/services/firebase.ts`. Do not replace it with env vars.

## Cross-check against `.env.example` (2026-10-30)

`.env.example` documents all 12 operator variables above
(`PORT`, `NODE_ENV`, `CHITTHI_DATA_DIR`, `SMTP_HOST`, `SMTP_USER`,
`SMTP_PASS`, `SMTP_PORT`, `DISABLE_HMR`, `CHITTHI_DEMO_OTP`,
`CHITTHI_ALLOW_UNAUTH_DEMO`, `VITE_GIF_PROVIDER`, `VITE_GIF_API_KEY` —
the two GIF vars were added during Phase 1). **No discrepancies found:**
nothing the code reads is missing from `.env.example`, and `.env.example`
lists nothing the code does not read.
