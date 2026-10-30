# Third-Party Notices — চিঠি · Chitthi

Chitthi itself is MIT-licensed (see `LICENSE`, © 2026 Maruf Talukder).
It builds on the open-source packages below. Versions and licence types
were read programmatically from each package's installed
`node_modules/<pkg>/package.json` `license` field on 2026-10-30
(Phase 5); the version column shows the **installed** version, which
may be newer than the `package.json` range that selected it.

## Runtime dependencies (`dependencies` in package.json)

| Package | Installed version | Licence |
|---|---|---|
| `@tailwindcss/vite` | 4.3.3 | MIT |
| `@vitejs/plugin-react` | 6.1.2 | MIT |
| `express` | 4.22.3 | MIT |
| `firebase` | 12.19.0 | Apache-2.0 |
| `jsqr` | 1.4.0 | Apache-2.0 |
| `jszip` | 3.10.2 | (MIT OR GPL-3.0-or-later) — dual-licensed; Chitthi relies on it under the MIT option |
| `lucide-react` | 0.546.0 | ISC |
| `nodemailer` | 10.1.6 | MIT-0 |
| `qrcode` | 1.5.4 | MIT |
| `react` | 19.3.1 | MIT |
| `react-dom` | 19.3.1 | MIT |
| `vite` | 8.3.4 | MIT |
| `ws` | 8.22.0 | MIT |

## Development dependencies (`devDependencies` in package.json)

Build/test tooling only — not shipped in the production bundle or the
Azure deploy package (which trims runtime deps to express / ws /
nodemailer).

| Package | Installed version | Licence |
|---|---|---|
| `@types/express` | 4.17.25 | MIT |
| `@types/node` | 22.20.5 | MIT |
| `@types/nodemailer` | 8.0.2 | MIT |
| `@types/qrcode` | 1.5.6 | MIT |
| `@types/react` | 19.3.0 | MIT |
| `@types/react-dom` | 19.3.0 | MIT |
| `@types/ws` | 8.18.2 | MIT |
| `autoprefixer` | 10.6.1 | MIT |
| `esbuild` | 0.28.2 | MIT |
| `tailwindcss` | 4.3.3 | MIT |
| `tsx` | 4.23.15 | MIT |
| `typescript` | 7.0.2 | Apache-2.0 |

## Notes

- Transitive dependencies (everything else under `node_modules/`) are
  covered by their own licences, available in each package's
  `LICENSE` / `package.json` in the installed tree.
- The bundled sticker artwork in `public/stickers/` is original work
  created for this app (basic SVG shapes) — no third-party sticker art.
- Call media uses third-party **services**, not code: Google STUN and
  the free Open Relay (metered.ca) TURN pool, with its public
  credentials, as documented in `docs/KNOWN_LIMITATIONS.md`.
