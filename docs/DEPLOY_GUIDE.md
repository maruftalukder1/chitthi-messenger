# চিঠি · Chitthi — Deploy Guide

## 1. Local production run

The same single Node process serves the API, the WebSocket server and
the built client:

```bash
npm install
npm run build                 # builds the client into dist/
NODE_ENV=production npm start # tsx server.ts, production mode
```

- `npm start` runs `server.ts` via `tsx`. In production mode the server
  serves `dist/` as static files with an SPA fallback, alongside
  `/api/*` and the `/ws` WebSocket endpoint, on `PORT` (default `3000`).
- Set `CHITTHI_DATA_DIR` to a persistent folder if the working directory
  is not durable (see §3). All variables: `docs/ENV_REFERENCE.md`.
- For development instead: `npm run dev` (same server, Vite in
  middleware mode, HMR on).

## 2. Azure App Service path

Chitthi is a Node.js app with its own server — it cannot be hosted by
WordPress/PHP hosting. The prepared path is Azure App Service (Linux,
Node 20 LTS), per `~/workspace/your_files/chitthi/AZURE_SETUP.md`:

> **The deploy zip is rebuilt by the coordinator in Phase 5.** Any zip
> produced before Phase 5 predates Phases 1–2 (and the Phase 5 packaging
> pass) — do not deploy an older zip.

### Zip layout (what the rebuilt package contains)

- `dist/` — the production client build.
- `server.js` — `server.ts` bundled with esbuild into a single file.
- A **trimmed `package.json`** whose dependencies are only the runtime
  set the bundled server needs: **express, ws, nodemailer**.
- `node_modules/` — production dependencies only, matching that trimmed
  manifest.
- The app start command runs the bundled server with plain Node
  (`node server.js`) — no `tsx`, no Vite, no build step on the host.

### App Service configuration

1. Create the Web App: Linux · Node 20 LTS · (Singapore region in the
   prepared plan; Free F1 works for personal use — it sleeps when idle
   and has a daily CPU quota — Basic B1 adds Always On).
2. **Configuration → General settings: Web sockets = On** (required —
   all realtime traffic rides `/ws`).
3. **Configuration → Application settings:**
   - `NODE_ENV` = `production`
   - `CHITTHI_DATA_DIR` = `/home/chitthi-data` (persistent `/home`
     storage, outside the deployment directory, so redeploys never wipe
     chat history)
   - `PORT` — App Service assigns this automatically; `server.ts`
     honours it. Do not hard-code a port.
   - SMTP settings (`SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` /
     `SMTP_PORT`) — only when real email delivery is wanted; without
     them, email verification falls back to the test transport.
   - **Never** set `CHITTHI_DEMO_OTP` or `CHITTHI_ALLOW_UNAUTH_DEMO` on
     a deployed instance (both are hard-disabled under
     `NODE_ENV=production`, but they do not belong there at all).
4. Deploy the zip (Kudu Zip Push / `az webapp deploy`), then run the
   smoke checklist below.
5. `VITE_GIF_PROVIDER` / `VITE_GIF_API_KEY` are **build-time** values:
   they must be set before `npm run build` produces `dist/` — setting
   them as App Settings afterwards has no effect on the shipped bundle.

## 3. Environment setup (any host)

- Minimum for a real deployment: `NODE_ENV=production`, a durable
  `CHITTHI_DATA_DIR`, and the host-assigned `PORT`.
- `firebase-applet-config.json` ships with the app (client + server read
  the Firebase project config from it) — it is part of the deployment,
  not an env var.
- Full variable reference: `docs/ENV_REFERENCE.md`.

## 4. Post-deploy smoke checklist

Run against the deployed origin (locally: `http://localhost:3000`):

- [ ] **Health endpoint:** `GET /api/health` returns `{status:"ok"}`.
- [ ] **Login screen:** open the site — the app boots to the login
      screen with **zero console errors**, and a logged-out visitor is
      **not** presented as any user (no name/avatar in the UI).
- [ ] **Fresh-install data:** a brand-new deployment's `store.json`
      starts as the empty snapshot — no seed users, stories or channels.
- [ ] **WS suite:** `docs/qa-ws-test.mjs` passes 6/6 against the
      deployment (message / typing / reaction / call signalling).
- [ ] **Security + OTP suites** (for a full verification pass):
      `docs/qa-security-test.mjs` 31/31 and `docs/qa-otp-test.mjs` 6/6,
      run per the Phase reports' scratch-server setup (demo :3000,
      strict :3001, no-flag :3002) — never against the shipped
      `data/` directory.
- [ ] **Persistence:** send a message, restart the app service, confirm
      the message is still in history (proves `CHITTHI_DATA_DIR` points
      at durable storage).
- [ ] **Two-browser chat:** sign in on two browsers/devices and confirm
      messages, typing and receipts flow both ways.

Known limits that a smoke pass will **not** fix — see
`docs/KNOWN_LIMITATIONS.md` (no E2EE, no group calls, GIF key, TURN
pool, `firestore.rules` owner deploy).
