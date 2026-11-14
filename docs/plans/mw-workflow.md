# pst — Marketplace watch (MW) build run

## 1. Inputs

| Input | Status |
|---|---|
| `docs/plans/marketplace-watch.md` (plan) | Committed `f1610a8`, answers folded in |
| `docs/plans/mw-contracts.md` (build spec) | Written 2026-11-14, awaiting your "start" |
| `docs/decisions.md` D-005 to D-009 | Written 2026-11-14 |
| Base branch | `macos-support` (has the macOS fix and the plan; `main` doesn't) |
| Integration branch | `mw`, created from `macos-support` once these docs are committed |

## 2. Shape

```
           ┌─ A  parse + diff          (Haiku) ─┐
 wave 1 ───┼─ B  alerts rules + notify (Haiku) ─┼─► merge gate 1 (Sonnet): merge A, B, C one at a time
           └─ C  config, daily, fb, store (Haiku)┘
                                                      │
           ┌─ D  args, runner, CLIs   (Haiku) ─┐      ▼
 wave 2 ───┤                                   ├─► merge gate 2 (Sonnet): merge D, E one at a time
           └─ E  server + frontend    (Haiku) ─┘
                                                      │
                                       V  verify (Opus) ─► R  review (Opus) ─► report to you
```

- A, B and C don't import each other: A and B are pure, and C is I/O.
- D imports all three, so it waits for wave 1.
- E imports only the store (C), but it waits for wave 1 too, so both wave-2 tasks start from the same base.

## 3. How it runs

**Model split (per `~/brain/agent-workflow.md`):**

| Role | Model | In this run |
|---|---|---|
| Planner | Opus 5.5 (this session) | Wrote the contracts; decides every contract issue; does the mechanical setup (branch + worktrees) before launch |
| Orchestrator | Sonnet 5.5, effort medium | Merge gates 1 and 2: gate each branch, merge one at a time into `mw`, re-gate after each merge, route red gates to fixers, pass contract issues up |
| Workers | Haiku 5.5 | Builders A–E; fixers (max 2 tries per red branch) |
| Verify | Opus 5.5 | DoD checklist (`mw-contracts.md` §10), full suite, UI smoke test on seeded data, README and status docs |
| Review | Opus 5.5 | Injection (notification args, server paths, DOM), localhost hardening, visit budget and lock, privacy in logs and fixtures |

**Worktrees:** `../pst-mw-wt/<task>` on branches `mw-a` … `mw-e`. Wave-2 worktrees are cut from `mw` after gate 1. Nobody builds in `~/brain/pst` itself.

**Gate:** `mw-contracts.md` §9. This project has no lint, typecheck or DB, so the gate is: `npm test`, `node --check` on changed files, the ownership diff, the package.json check, and the innerHTML check for E.

**Failure rule:** a Haiku fixer gets the gate output, up to 2 tries. If the branch is still red, that branch stops and is reported. Independent tasks carry on. If a wave-1 branch stops, wave 2 still runs only if D's imports are all merged; otherwise D is skipped and reported.

**Contract issues:** worker → orchestrator → planner (this session, after the run, or V if it's blocking). Nothing is patched quietly. Decisions go into `mw-contracts.md` §12.

**Privacy and live:** made-up data only. **No agent touches Facebook, port 9222, real notifications or `.env` (D-009).** There is no deploy. The live step comes afterwards, with you.

**Shared notes in every worker prompt:**
- Run tests in the foreground, never with Monitor or background jobs.
- Kill only processes you started.
- Never `taskkill` or `pkill node`.
- Edit only owned files.
- Don't run any `npm run` script that would attach to Chrome.

## 4. Size

9 agents if all gates are green:
- 5 Haiku builders
- 2 Sonnet merge gates
- 1 Opus verify
- 1 Opus review

Each red gate adds up to 2 Haiku fixers. That's within the under-10 guideline on a clean run.

## 5. After the run (with you, not agents)

1. Review the report and contract issues, then merge `mw` → `macos-support` (or open a PR).
2. **Live step (milestone 1):**
   - You run `npm run chrome` and log in.
   - I run `npm run market -- "<something>" --raw` with you watching.
   - We set Pasig + 6 km by hand and read the location value off the URL.
   - Then we tune the `// TUNE LIVE` selectors and save cleaned fixtures.
3. First real watch: 3 passes at 10m.

## 6. Result
_(filled in by V, Opus 5.5, 2026-11-14)_

- **Run ID:** TODO (planner). **Duration:** TODO (planner).
- **Agents:** 5 Haiku builders (A–E), 2 Sonnet merge gates, V (Opus). R (Opus review) comes next. No fixers were needed.
- **Merge order into `mw`:**
  - gate 1: `mw-a` (`6dae974`) → `mw-b` (`680e958`) → `mw-c` (`054a01d`);
  - gate 2: `mw-d` (`9c75d96`) → `mw-e` (`7254c97`).
  - Every gate was green on the first try. Fixer tries: 0.
- **Tests:** 160 pass, 0 fail (13 suites, about 0.2 s) on `mw` after both merges and again after V's fix. The old `test/guard.test.js` and `test/platform.test.js` are unchanged from `e8f9b30`. `package-lock.json` and `dependencies` are unchanged. Only the three scripts were added to `package.json`.
- **What broke:** nothing at the gates. V found one DoD gap: tests imported `config.js` (through `human.js` and `fb.js`), which loaded `dotenv`, so a `.env` would have been read during `npm test`. V fixed it in `src/config.js` by skipping dotenv under `NODE_TEST_CONTEXT` (3 lines; §12 #9).
- **DoD (§10):** all items pass except two:
  - "no console errors" in the UI needs a browser check by you. V tested every API route, CSP, Host/Origin 403s and mark-read with curl against a seeded tmp store, and read `public/app.js`: it uses textContent/setAttribute only.
  - The Opus review is the R step, next.
- **Contract issues:** 27 were reported (A 5, B 5, C 5, D 7, E 5), 3 of them the same commit-trailer note.
  - V accepted every builder choice.
  - V changed one thing: `.env` in tests.
  - The 18 that changed or pinned behaviour are recorded in `mw-contracts.md` §12.
  - Worth a look in review: a corrupt store JSON file makes `/api/watches` answer 500 for the whole list (§12 #8).
- **Cleanup:**
  - V's tmp `OUTPUT_DIR` and its UI server (own PID) were removed or stopped.
  - The worktrees `../pst-mw-wt/*` and branches `mw-a` … `mw-e` are still there, for the planner to remove after review.

