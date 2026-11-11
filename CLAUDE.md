# pst

Playwright (Node, ESM, plain JS) attached over CDP to a real Chrome on a dedicated profile, to browse Facebook pages and groups on the user's own account.

Read `docs/plans/setup.md` and `docs/decisions.md` first.

## Rules
- Never automate the Facebook login or 2FA. On a login/checkpoint screen, wait for the user (`waitIfBlocked`).
- Never launch Chrome from Playwright (`launch`, `launchPersistentContext`). Attach only (D-001).
- All navigation goes through `Facebook.open()` so the visit budget and pauses apply.
- Keep every facebook.com selector in `src/fb.js`. Prefer roles, aria-labels and text over class names.
- Don't add proxies, stealth plugins or fingerprint spoofing (D-003).
- Never commit `.env` or the Chrome profile. Never read `.env`.
- `npm test` must pass before commits.
