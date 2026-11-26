#!/usr/bin/env node
'use strict';
/*
 * Extends the trainer lines on an opening guide page along the most-played
 * master move, using the Lichess masters opening explorer.
 *
 *   LICHESS_TOKEN=... node tools/extend-lines.js ruy-lopez [--report report.md]
 *
 * Build-time only: this folder is never uploaded to the live site.
 */
const fs = require('node:fs');
const path = require('node:path');
const { Chess } = require('chess.js');

const EXPLORER = 'https://explorer.lichess.ovh/masters';
const MAX_PLY = 36;        // move 18
const MIN_GAMES = 50;      // below this, theory has run out
const PAUSE_MS = 1000;     // Lichess: one request at a time
const RATE_LIMIT_WAIT_MS = 60000;
const MAX_RETRIES = 5;

function linesBlock(html) {
  const start = html.indexOf('var LINES = [');
  if (start === -1) throw new Error('No "var LINES = [" block found in the page');
  const end = html.indexOf('\n  ];', start);
  if (end === -1) throw new Error('Could not find the end of the LINES block');
  return { start: start, end: end };
}

function findEntries(html) {
  const b = linesBlock(html);
  const block = html.slice(b.start, b.end);
  const re = /id:\s*'([^']+)'[\s\S]*?moves:\s*'([^']*)'/g;
  const out = [];
  let m;
  while ((m = re.exec(block))) {
    const movesEnd = b.start + m.index + m[0].length - 1;       // closing quote
    out.push({ id: m[1], moves: m[2], from: movesEnd - m[2].length, to: movesEnd });
  }
  return out;
}

function parseLines(html) {
  return findEntries(html).map(function (e) { return { id: e.id, moves: e.moves }; });
}

function replaceLineMoves(html, id, moves) {
  const entry = findEntries(html).find(function (e) { return e.id === id; });
  if (!entry) throw new Error('No line with id "' + id + '" in the LINES block');
  return html.slice(0, entry.from) + moves + html.slice(entry.to);
}

function toUci(m) { return m.from + m.to + (m.promotion || ''); }

async function extendLine(sans, opts) {
  const maxPly = opts.maxPly || MAX_PLY;
  const minGames = opts.minGames || MIN_GAMES;
  const game = new Chess();
  const uci = sans.map(function (s) { return toUci(game.move(s)); });
  const out = sans.slice();
  const added = [];
  let stopped = 'max-depth';

  while (out.length < maxPly) {
    const pos = await opts.fetchPosition(uci.slice());
    const reached = pos.white + pos.draws + pos.black;
    if (reached < minGames) { stopped = 'few-games'; break; }
    const top = pos.moves && pos.moves[0];
    if (!top) { stopped = 'no-moves'; break; }
    const made = game.move(top.san);          // throws if the explorer's move is illegal here
    uci.push(toUci(made));
    out.push(made.san);
    added.push({ san: made.san, reached: reached, share: (top.white + top.draws + top.black) / reached });
  }

  // End on the same side's move as the original line (the trainee's move).
  if (added.length % 2 === 1) { out.pop(); added.pop(); }
  return { sans: out, added: added, stopped: stopped };
}

function makeFetchPosition(cfg) {
  if (!cfg.token) throw new Error('LICHESS_TOKEN is not set. Add it as a repository secret (or environment variable).');
  const pauseMs = cfg.pauseMs === undefined ? PAUSE_MS : cfg.pauseMs;
  return async function fetchPosition(uci) {
    const url = EXPLORER + '?play=' + uci.join(',') + '&moves=5&topGames=0';
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await cfg.sleep(pauseMs);
      const res = await cfg.fetchImpl(url, { headers: { Authorization: 'Bearer ' + cfg.token, Accept: 'application/json' } });
      if (res.status === 200) return res.json();
      if (res.status === 401 || res.status === 403) {
        throw new Error('Lichess rejected the token (HTTP ' + res.status + '). Create a new personal API token and update LICHESS_TOKEN.');
      }
      if (res.status === 429) { await cfg.sleep(RATE_LIMIT_WAIT_MS); continue; }
      throw new Error('Lichess explorer returned HTTP ' + res.status);
    }
    throw new Error('Lichess rate limit: still refused after ' + MAX_RETRIES + ' retries. Try again later.');
  };
}

function moveLabel(plyIndex, san) {
  const n = Math.floor(plyIndex / 2) + 1;
  return n + (plyIndex % 2 === 0 ? '.' : '...') + san;
}

const STOP_TEXT = {
  'max-depth': 'reached move ' + (MAX_PLY / 2) + ', the depth limit',
  'few-games': 'fewer than ' + MIN_GAMES + ' master games reach the next position',
  'no-moves': 'the masters database has no moves from the next position'
};

function buildReport(slug, results) {
  const out = ['# Deeper lines: ' + slug, '',
    'Each line follows the most-played move in the Lichess masters database from where it used to stop.',
    'Please check every added move before merging: the most popular move is not always the best one to teach.', ''];
  results.forEach(function (r) {
    out.push('## ' + r.id, '');
    if (!r.added.length) {
      out.push('No moves added (' + STOP_TEXT[r.stopped] + ').', '');
      return;
    }
    out.push('Was ' + Math.ceil(r.before.length / 2) + ' moves, now ' + Math.ceil(r.sans.length / 2) + '. Stopped because: ' + STOP_TEXT[r.stopped] + '.', '');
    out.push('| Move | Master games reaching it | Share choosing it |', '| --- | --- | --- |');
    r.added.forEach(function (a, i) {
      out.push('| ' + moveLabel(r.before.length + i, a.san) + ' | ' + a.reached + ' | ' + Math.round(a.share * 100) + '% |');
    });
    out.push('', 'Full line: `' + r.sans.join(' ') + '`', '');
  });
  out.push('The end-of-line notes on the page still describe the old final positions and need updating before this goes live.', '');
  return out.join('\n');
}

async function main(argv) {
  const slug = argv[0];
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) throw new Error('Usage: node tools/extend-lines.js <opening-folder> [--report <file>]');
  const ri = argv.indexOf('--report');
  const reportPath = ri !== -1 ? argv[ri + 1] : null;
  const page = path.join(__dirname, '..', 'openings', slug, 'index.html');
  let html = fs.readFileSync(page, 'utf8');
  const fetchPosition = makeFetchPosition({
    token: process.env.LICHESS_TOKEN, fetchImpl: fetch,
    sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  });
  const results = [];
  for (const line of parseLines(html)) {
    const before = line.moves.split(' ');
    console.log('Extending ' + line.id + ' (' + before.length + ' plies)...');
    const r = await extendLine(before, { fetchPosition: fetchPosition });
    console.log('  -> ' + r.sans.length + ' plies (' + r.stopped + ')');
    results.push({ id: line.id, before: before, sans: r.sans, added: r.added, stopped: r.stopped });
  }
  results.forEach(function (r) { html = replaceLineMoves(html, r.id, r.sans.join(' ')); });
  fs.writeFileSync(page, html);                  // only after every line succeeded
  const report = buildReport(slug, results);
  if (reportPath) fs.writeFileSync(reportPath, report); else console.log('\n' + report);
}

module.exports = { parseLines, replaceLineMoves, extendLine, makeFetchPosition, buildReport };

if (require.main === module) {
  main(process.argv.slice(2)).catch(function (e) { console.error('Error: ' + e.message); process.exit(1); });
}
