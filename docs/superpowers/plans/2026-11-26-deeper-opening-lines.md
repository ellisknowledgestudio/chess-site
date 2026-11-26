# Deeper Opening Lines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the opening guide trainer lines along Lichess master practice to move 18, reviewed by pull request, and let players train them in stages.

**Architecture:** A Node script rewrites the `moves` strings inside an opening page's `LINES` array using the Lichess masters explorer, and a manually run GitHub Action turns its output into a pull request. The page itself gains a stage control that truncates the line being trained.

**Tech Stack:** Node 22 (built-in `fetch`, `node:test`), chess.js (npm, in `tools/` only), GitHub Actions, existing inline page JS with chess.js 0.10.3.

**Spec:** `docs/superpowers/specs/2026-11-26-deeper-opening-lines-design.md`

## Global Constraints

- Explorer endpoint: `https://explorer.lichess.ovh/masters?play=<uci,uci,...>&moves=5&topGames=0`, header `Authorization: Bearer $LICHESS_TOKEN`.
- One request at a time, 1000 ms pause between requests; on HTTP 429 wait 60000 ms and retry, at most 5 times.
- Maximum depth 36 plies (move 18). Stop when games reaching the position (`white + draws + black`) < 50.
- The token is read only from `process.env.LICHESS_TOKEN` and never printed.
- `LINES` format unchanged: space-separated SAN in single quotes.
- No change reaches `main` except by pull request.

## Review Focus

1. Explorer returns 401 (bad or missing token): script exits non-zero with "Lichess rejected the token", page untouched.
2. A line stops immediately (first position already < 50 games): moves string left exactly as it was, report says so.
3. Extension ends on the opponent's move: last ply trimmed so the line ends on the trainee's move.
4. Page where the trainee is Black (Caro-Kann): parity rule keeps lines ending on Black's move.
5. Stage longer than the line: stage button hidden; "full" always available.

---

### Task 1: Extension script

**Files:**
- Create: `tools/extend-lines.js`, `tools/package.json` (dependency `chess.js`, script `"test": "node --test"`), `tools/test/extend-lines.test.js`
- Modify: `.gitignore` (add `tools/node_modules/`)

**Interfaces (exports of `tools/extend-lines.js`):**
- `parseLines(html: string) -> Array<{id: string, moves: string}>`: entries of the `var LINES = [ ... ];` block only (not `TRAPS`).
- `replaceLineMoves(html: string, id: string, moves: string) -> string`
- `extendLine(sans: string[], opts: {fetchPosition: (uci: string[]) => Promise<{white, draws, black, moves: [{uci, san, white, draws, black}]}>, maxPly?: 36, minGames?: 50}) -> Promise<{sans: string[], added: Array<{san, reached: number, share: number}>, stopped: 'max-depth'|'few-games'|'no-moves'}>`
- `makeFetchPosition({token, fetchImpl, sleep, pauseMs?: 1000}) -> fetchPosition`
- `buildReport(slug: string, results) -> string` (Markdown)
- CLI: `node tools/extend-lines.js <slug> [--report <path>]`

- [ ] **Step 1: Write failing tests** in `tools/test/extend-lines.test.js`:
  - `parseLines` on the real `openings/ruy-lopez/index.html` returns ids `['chigorin','berlin','open']` and the Chigorin moves end in `Qc7 Nbd2`.
  - `replaceLineMoves` changes only the named line; `parseLines` of the result shows the new string and the `noahsArk` trap string is still present unchanged.
  - `extendLine` with a stub that always offers one legal move with 1000 games stops with `'max-depth'`, result length <= 36 and same parity as the input length.
  - `extendLine` with a stub returning total 49 returns the input unchanged, `stopped: 'few-games'`, `added: []`.
  - `extendLine` trims a trailing opponent ply (stub runs out of games after one added ply).
  - Same parity test starting from an even-length (Black-trainee) line.
  - `makeFetchPosition`: 429 then 200 calls `sleep(60000)` once and returns the body; six 429s rejects; 401 rejects with a message containing `Lichess rejected the token`; the `Authorization` header is `Bearer <token>`.
- [ ] **Step 2:** `cd tools && npm install && npm test`; expect failures (module missing).
- [ ] **Step 3:** Implement. SAN-to-UCI and legality via chess.js; take the explorer's first move (most played); `share` = that move's games / games reaching the position. CLI writes the page only after every line succeeded.
- [ ] **Step 4:** `npm test`; expect all pass.
- [ ] **Step 5:** Commit `feat: script to extend opening lines from Lichess masters`.

### Task 2: Workflow and deploy exclusions

**Files:**
- Create: `.github/workflows/extend-lines.yml`
- Modify: `.github/workflows/deploy.yml` (exclude list: add `tools/**`, `docs/**`)

- [ ] **Step 1:** Workflow: `on: workflow_dispatch` with required choice input `opening` (`ruy-lopez`, `italian-game`, `caro-kann`, `queens-gambit-declined`); `permissions: contents: write, pull-requests: write`; steps: checkout, setup-node 22, `npm ci` in `tools`, run script with `LICHESS_TOKEN: ${{ secrets.LICHESS_TOKEN }}` and `--report "$RUNNER_TEMP/report.md"`, then `peter-evans/create-pull-request@v7` with branch `extend-lines/<opening>`, title `Deeper lines: <opening>`, `body-path` the report.
- [ ] **Step 2:** Verify both files parse: `node -e` YAML load via `npx --yes js-yaml <file>`; expect no error and the two new exclude entries present.
- [ ] **Step 3:** Commit `ci: manual workflow to extend opening lines; keep tools and docs off the server`.

### Task 3: Stage control in the Ruy Lopez trainer

**Files:**
- Modify: `openings/ruy-lopez/index.html` (trainer markup near `#linePicker`, trainer script from `var T =` to `finishLine`)
- Test: `tools/test/stages.test.js`

**Interfaces (page script, also exposed on `window.EKSRuyLopez`):**
- `var STAGES = [8, 12, 0]` (0 = full line)
- `stagePlies(totalPlies: number, stage: number, traineeIsWhite: boolean) -> number`: plies to train; ends on the trainee's move; never more than `totalPlies`.
- `availableStages(totalPlies, traineeIsWhite) -> number[]`: always includes 0; includes 8 or 12 only if `stagePlies` for it is less than `totalPlies`.
- `T.stage` (default 0); `lineMoves()` returns the line sliced to `stagePlies`; completion key `id + ':' + T.stage`.

- [ ] **Step 1: Write failing tests** (`stages.test.js` loads the page's inline script functions by extracting `stagePlies` and `availableStages` source from the HTML and evaluating them):
  - `stagePlies(35, 8, true) === 15`, `stagePlies(35, 12, true) === 23`, `stagePlies(35, 0, true) === 35`
  - `stagePlies(36, 8, false) === 16`
  - `stagePlies(21, 12, true) === 21`
  - `availableStages(23, true)` deep-equals `[8, 0]`; `availableStages(35, true)` deep-equals `[8, 12, 0]`; `availableStages(15, true)` deep-equals `[0]`
- [ ] **Step 2:** `npm test`; expect failures.
- [ ] **Step 3:** Implement the two functions, a `#stagePicker` button group labelled "Train to" (To move 8 / To move 12 / Full line) rebuilt on line change, restart of the line on stage change, per-stage completion, and the stats line counting completed lines at the current stage.
- [ ] **Step 4:** `npm test`; expect pass. Then load the page in a headless browser with `EKS_REPLY_DELAY = 0`, select the Chigorin at "To move 8", play the line through the board API and confirm it finishes after 8.c3 (White's 8th move), with no console errors.
- [ ] **Step 5:** Commit `feat: train opening lines in stages (Ruy Lopez)`.

### Task 4: Pull request

- [ ] Push the branch, open a pull request describing: add `LICHESS_TOKEN` secret, enable "Allow GitHub Actions to create and approve pull requests", run the workflow for `ruy-lopez`, review the generated pull request. Note that end-of-line notes are updated after the first real run.
