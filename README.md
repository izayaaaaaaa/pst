# pst

Drive a logged-in Facebook account from Node with Playwright, by attaching over CDP to a real Chrome window on a dedicated profile.

> Meta's terms ban automated access. The account is what's at risk: keep volume low and don't use an account you can't afford to lose.

## How it works

```
npm run chrome  ──► real Chrome, dedicated profile, --remote-debugging-port=9222
                         ▲   (you log in by hand, browse by hand now and then)
                         │
npm start       ──► Playwright connectOverCDP ──► opens its own tab, does the work, closes the tab
```

- **You launch Chrome, the script attaches.** No `--enable-automation` flag, no `navigator.webdriver`, your real fingerprint.
- **Dedicated profile** (`%LOCALAPPDATA%\pst\chrome-profile`). Since Chrome 136 the debugging port is ignored on your default profile, so this one is separate.
- **Login is never automated.** You log in once by hand (with 2FA). The cookies live in the profile.
- **The script hands control back** when Facebook shows a checkpoint or login screen, and waits for you to clear it.

## Setup

```powershell
npm install
copy .env.example .env      # optional; defaults work
npm run chrome              # opens Chrome on facebook.com
```

Log in to Facebook in that window. Then:

```powershell
npm start                   # attach, check login, scroll the feed
npm start -- <groupId>      # also open a group and print a few posts
npm test                    # unit tests for the guard helpers
```

Leave Chrome open between runs. Close it when you're done for the day, because while it's open any program on this PC can control it through port 9222.

## Layout

| File | What it does |
|---|---|
| `scripts/chrome.js` | Finds chrome.exe and starts it with the port and profile |
| `src/config.js` | Reads `.env` (port, profile dir, limits, quiet hours) |
| `src/browser.js` | `attach()`: connects over CDP, opens a tab, `detach()` closes only that tab |
| `src/human.js` | Random pauses, uneven scrolling, mouse-moved clicks, per-key typing, quiet hours |
| `src/guard.js` | Checkpoint/login detection and wait, per-run visit budget |
| `src/fb.js` | Facebook navigation; all selectors live here |
| `src/index.js` | Example run |

## Safe-use rules built in

- Visit budget per run (`MAX_PAGE_VISITS`, default 15).
- 2.5 to 7 s random pause after every page load.
- Won't run during quiet hours (default 01:00 to 07:00).
- Same machine, same home IP, same profile every time. Don't add proxies.
