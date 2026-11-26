# Deeper opening lines from the Lichess masters database: design

**Approved by James, 26 Nov 2026.**

## Intent
The opening guide trainers (e.g. `/openings/ruy-lopez/`) stop at about move 11-12. Ruy Lopez theory
runs much deeper, so for an adult club player the lines are not extensive enough. Make each trainer
line follow master practice further, without turning it into an 18-move wall for someone starting out.

## Goals
- Extend each line in a page's `LINES` array along the most-played master move, to move 18 at most,
  stopping earlier where fewer than 50 master games reach the position.
- James reviews every extended line before it goes live (pull request diff + per-move game counts).
- Trainer lets the player train a line in stages: to move 8, to move 12, or the full line.
- Ruy Lopez is the pilot. The same script must work unchanged on the other three opening pages.

## Non-goals
- Branching Black replies (later upgrade; approach 2 below).
- Model games to click through.
- Calling Lichess from the visitor's browser.

## Anti-goals
- The Lichess token appearing in the repo, the page, or logs.
- Anything changing on the live site without James merging a pull request.
- `tools/` or `docs/` being uploaded to Hostinger.

## Constraints
- Lichess opening explorer requires an OAuth token on every request; one request at a time; on HTTP
  429 wait a full minute.
- Site is static HTML with inline JS and chess.js 0.10.3 from a CDN; lines are space-separated SAN
  strings in `var LINES = [...]`. Keep that format.
- Deploys happen by FTP on push to `main`.

## Approaches considered
1. **Longer lines, same trainer, with stages (chosen).** Smallest change; fixes the depth complaint
   directly. Black still plays one reply per line.
2. **Branching tree.** Trainer picks among Black replies masters play >10% of the time. Much more
   extensive but needs a trainer rewrite and a coherence review of every White answer. Deferred.
3. **Model games bolted on.** Cheap, but it is watching, not drilling. Not chosen.

James picked 1.

## Design
- `tools/extend-lines.js`: Node script. Reads one opening page, extends each `LINES[].moves`, writes
  the page back, writes a Markdown report (per line: each added move, master games reaching it, share
  of games choosing it, and why the line stopped).
- `.github/workflows/extend-lines.yml`: manual workflow with an `opening` input. Uses the
  `LICHESS_TOKEN` repo secret, runs the script, opens a pull request with the report as its body.
- Trainer stage control on the opening page; completion tracked per line per stage.
- `deploy.yml` excludes `tools/**` and `docs/**`.

## Claude's calls (not decisions James made)
- Extended lines end on the trainee's own move, as the current ones do.
- A stage button is hidden for a line that is not longer than that stage.
- End-of-line `note` text is rewritten by hand after the first real run, in the same pull request.

## Left to the builder
Internal structure of the script and the styling of the stage control (match existing `.btn` styles).
