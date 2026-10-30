# চিঠি · Chitthi — Demo Data

How to run Chitthi with a small, clearly-labelled **demo** dataset —
for screenshots, buyer demos and manual QA — without ever touching real
data.

## What you get

`scripts/demo-data.mjs` generates a server snapshot containing:

- **2 demo users** — "Demo Alice" (`demo_alice`) and "Demo Bob"
  (`demo_bob`), with directory entries and claimed usernames. Every
  display name is prefixed **"Demo"**.
- **1 DM conversation** between them (3 sample messages) and **1 demo
  group** ("Demo Group Chat", with `general` + read-only
  `announcements` sections and 2 sample messages).
- **1 text story** from Demo Alice (expires 24 h after generation).
- A marker record in the snapshot (`_demoDataset: {demo: true, …}`)
  and a `DEMO_DATASET.txt` file in the target directory, both stating
  plainly that the data is generated demo data.

## Generate it

```bash
node scripts/demo-data.mjs /tmp/chitthi-demo-data
```

Plain Node.js, builtins only — no `npm install` needed for the script
itself. The target directory is created if it does not exist.

**Safety:** the script **refuses** to write into the repository's own
`data/` directory (it exits with an error before writing anything), so
the shipped snapshot can never be overwritten by demo data.

## Run the server against it

Demo users have no Firebase accounts, so run the server in demo mode
(local only — demo auth is hard-disabled in production):

```bash
CHITTHI_DATA_DIR=/tmp/chitthi-demo-data CHITTHI_ALLOW_UNAUTH_DEMO=true npm run dev
```

Then open the app and sign in with a demo-mode session as `demo_alice`
or `demo_bob`. To also complete email-verification flows without a
mailbox, add `CHITTHI_DEMO_OTP=true` (same local-only rule — see
`docs/ENV_REFERENCE.md`).

Stop the server and delete the demo directory when finished; nothing
about the demo run touches the real `data/` directory.

## A fresh install never contains this data

The shipped `data/store.json` is the **empty snapshot** (no channels,
messages, stories, blocks or reports) — Phase 0 purged all seed/fake
data from the product, and it stays out. Demo data exists **only** in a
directory this script generated, only when you point
`CHITTHI_DATA_DIR` at it. If a store file does not carry the
`_demoDataset` marker, it did not come from this generator.
