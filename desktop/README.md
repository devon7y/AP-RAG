# AP-RAG Desktop

Native desktop apps (macOS `.dmg`, Windows `.exe`) for AP-RAG. This is a thin
Electron shell around the deployed web app at **<https://aprag.devon7y.com>** —
like the `aprag` CLI, it runs no models and holds no data, so the app stays
current with every Vercel deploy and only the shell itself ever needs a
re-release.

What the shell adds over a browser tab:

- A real dock/taskbar app with its own icon, menus, and window state
  (size/position persist across launches).
- Navigation policy: only `aprag.devon7y.com` loads in-app; every other link
  (Google Drive papers, external sites) opens in the default browser.
- Chromium bundled — the Atlas WebGPU scene runs on the same engine it was
  debugged against, on both platforms.
- Offline handling (retry page), crash recovery, spellcheck with
  right-click suggestions, locked-down web permissions.
- Login autofill (see below) — browser-style credential fill on the login
  page, backed by the OS keystore.

## Login autofill

Chromium cannot reach iCloud Keychain (Apple exposes it only to Safari,
WKWebView, and an extension needing native-messaging APIs Electron lacks), so
the shell provides the equivalent itself:

- After a successful sign-in, the app offers to save the login. The password
  is encrypted with Electron `safeStorage` — macOS Keychain / Windows DPAPI
  hold the key — in `userData/credentials.json`; it never leaves the machine.
- On the next visit to `/login`, the form autofills — behind a Touch ID
  prompt on Macs that have it. Nothing is auto-submitted.
- The offer only appears after the navigation that proves the login
  succeeded; failed attempts are never saved. *Never Ask* is honored.
- **Help → Forget Saved Login** deletes the stored credential (and re-enables
  the save offer).

## Develop

```bash
cd desktop
npm install
npm start                                    # against production
APRAG_APP_URL=http://localhost:3000 npm start  # against a local `next dev`
```

> **VS Code terminals:** shells spawned by VS Code export
> `ELECTRON_RUN_AS_NODE=1`, which makes any Electron binary run as plain Node
> and exit instantly — this breaks `npm start`, and even `open
> /Applications/AP-RAG.app`, since macOS `open` propagates the caller's
> environment. In dev, prefix with `env -u ELECTRON_RUN_AS_NODE …`. Packaged
> builds are immune: the `electronFuses` block in `package.json` burns Node
> mode (plus `NODE_OPTIONS` and Node inspect flags) out of the shipped binary.

## Build installers

```bash
npm run dist:mac   # dist/AP-RAG-<version>-arm64.dmg + -x64.dmg
npm run dist:win   # dist/AP-RAG-Setup-<version>.exe (NSIS, per-user, one-click)
npm run dist       # both
```

The Windows installer cross-builds fine from macOS. Build outputs land in
`desktop/dist/` (gitignored).

## Releases (CI)

`.github/workflows/desktop.yml` builds both platforms on GitHub runners and
attaches the installers to a GitHub release:

```bash
git tag desktop-v0.1.0 && git push origin desktop-v0.1.0
```

(or run the workflow manually via *Actions → Desktop app → Run workflow*).
Bump `version` in `package.json` when tagging.

## Distribution notes (unsigned builds)

The installers are unsigned; they work fine. Two facts worth knowing:

- **macOS:** builds made on your own machine open normally. A copy downloaded
  from the internet carries the quarantine flag, so first launch needs
  right-click → Open, or System Settings → Privacy & Security → **Open
  Anyway** (newer macOS), or `xattr -dr com.apple.quarantine "/Applications/AP-RAG.app"`.
  Once opened, it never asks again. Developer ID signing + notarization (not
  App Store — it's for direct distribution) is what removes that one-time
  step, if it ever becomes annoying for lab members.
- **Windows:** SmartScreen shows "Windows protected your PC" → *More info* →
  *Run anyway* on first run.

## Icon

`build/icon.png` (1024×1024) is the single source; electron-builder derives
the `.icns`/`.ico` automatically. To regenerate from the SVG:

```bash
qlmanage -t -s 1024 -o build build/icon.svg && mv build/icon.svg.png build/icon.png
```
