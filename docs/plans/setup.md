# pst — setup plan

## Goal
Log in to Facebook on the user's own account and navigate pages and groups from code, with the lowest practical ban risk.

## Approach
CDP attach on a dedicated Chrome profile (see decisions D-001 to D-003).

1. `npm run chrome` starts real Chrome with `--remote-debugging-port=9222 --user-data-dir=<profile>`.
2. The user logs in by hand once, with 2FA, and uses this profile by hand now and then so it has a normal history.
3. `npm start` attaches with Playwright, opens its own tab, works through `Facebook` helpers, closes the tab and disconnects. Chrome stays open.

## Status
### P0 — boilerplate (done 2026-11-11)
- [x] Chrome launcher script (finds Chrome, skips if already running)
- [x] Launcher and profile path work on Windows and macOS (2026-11-14)
- [x] `attach()` / `detach()` over CDP
- [x] Human-paced helpers: pauses, scrolling, mouse-moved clicks, typing
- [x] Checkpoint/login detection that waits for the user
- [x] Per-run visit budget and quiet hours
- [x] `Facebook` class: home, group, page, browse feed, read posts
- [x] Unit tests for guard helpers

### P1 — first real use (next)
- [ ] User runs `npm run chrome`, logs in, runs `npm start` and `npm start -- <groupId>`
- [ ] Decide the actual job in groups: read/monitor, post, or collect data
- [ ] Tune `readPosts` selectors against the live page (author, time, link, text)
- [ ] Save output somewhere (`output/` JSON, or into Sibyl)

### Later, only if needed
- [ ] Unattended mode via `launchPersistentContext` on the same profile
- [ ] Scheduled runs (Task Scheduler), only during normal waking hours
- [ ] Daily visit cap across runs (persisted counter)

## Risks
- Account lock or ban: Meta forbids automation. Keep volume low, same machine/IP, human pacing.
- Port 9222 lets any local program control the browser. Close Chrome when done.
- Facebook markup changes often; selectors in `src/fb.js` will need upkeep.
