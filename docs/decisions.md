# Decisions

## D-001 — Attach to Chrome over CDP, don't launch it (2026-11-11)
The user starts Chrome (`npm run chrome`); the script attaches with `connectOverCDP`.
**Why:** no automation flags or `navigator.webdriver`, the real fingerprint, and the user can browse the same profile by hand and step in on checkpoints.
**Cost:** Chrome must already be open, so runs aren't unattended. If that's needed later, add a `launchPersistentContext` mode (`channel: 'chrome'`, headed, `ignoreDefaultArgs: ['--enable-automation']`) on the same profile.

## D-002 — Dedicated profile outside the repo (2026-11-11)
Profile at `%LOCALAPPDATA%\pst\chrome-profile`.
**Why:** Chrome 136+ ignores `--remote-debugging-port` on the default profile; keeping it outside the repo means cookies can't be committed.

## D-003 — Playwright on real Chrome, no Camoufox or stealth plugins (2026-11-11)
**Why:** for one logged-in account, a stable device identity and human-paced behavior matter more than fingerprint spoofing. Camoufox rotates fingerprints, which looks like a new device each run. `playwright-core` is used since no bundled browser is needed.

## D-004 — Plain JS (ESM), no build step (2026-11-11)
**Why:** boilerplate stays small; types come from JSDoc. Revisit if the code grows.
