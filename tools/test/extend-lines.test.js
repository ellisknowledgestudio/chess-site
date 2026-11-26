'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Chess } = require('chess.js');
const { parseLines, replaceLineMoves, extendLine, makeFetchPosition, buildReport } = require('../extend-lines.js');

const RUY = fs.readFileSync(path.join(__dirname, '../../openings/ruy-lopez/index.html'), 'utf8');
const CHIGORIN = 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Na5 Bc2 c5 d4 Qc7 Nbd2'.split(' ');

// Stub explorer: replays the UCI moves, offers the first legal move with `games` games.
function stubExplorer(gamesAt) {
  return async function (uci) {
    const g = new Chess();
    uci.forEach(function (u) { g.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); });
    const total = gamesAt(uci.length);
    const m = g.moves({ verbose: true })[0];
    return { white: total, draws: 0, black: 0,
      moves: m ? [{ uci: m.from + m.to + (m.promotion || ''), san: m.san, white: Math.floor(total / 2), draws: 0, black: 0 }] : [] };
  };
}

test('parseLines reads only the LINES block of the real Ruy Lopez page', function () {
  const lines = parseLines(RUY);
  assert.deepEqual(lines.map(function (l) { return l.id; }), ['chigorin', 'berlin', 'open']);
  assert.match(lines[0].moves, /^e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Na5 Bc2 c5 d4 Qc7 Nbd2/);
});

test('replaceLineMoves changes only the named line', function () {
  const out = replaceLineMoves(RUY, 'berlin', 'e4 e5 Nf3');
  const lines = parseLines(out);
  assert.equal(lines[1].moves, 'e4 e5 Nf3');
  assert.equal(lines[0].moves, parseLines(RUY)[0].moves);
  assert.equal(lines[2].moves, parseLines(RUY)[2].moves);
  assert.ok(out.includes("moves: 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 d6 d4 b5 Bb3 Nxd4 Nxd4 exd4 Qxd4 c5 Qd5 Be6 Qc6+ Bd7 Qd5 c4'"));
});

test('replaceLineMoves throws for an unknown line id', function () {
  assert.throws(function () { replaceLineMoves(RUY, 'nope', 'e4'); }, /nope/);
});

test('extendLine stops at max depth and keeps the trainee on the last move', async function () {
  const r = await extendLine(CHIGORIN, { fetchPosition: stubExplorer(function () { return 1000; }) });
  assert.equal(r.stopped, 'max-depth');
  assert.equal(r.sans.length, 35);
  assert.deepEqual(r.sans.slice(0, 23), CHIGORIN);
  assert.equal(r.added.length, 12);
  assert.equal(r.added[0].reached, 1000);
  assert.equal(r.added[0].share, 0.5);
  const g = new Chess();
  r.sans.forEach(function (s) { g.move(s); });
});

test('extendLine leaves a line alone when too few master games reach it', async function () {
  const r = await extendLine(CHIGORIN, { fetchPosition: stubExplorer(function () { return 49; }) });
  assert.deepEqual(r.sans, CHIGORIN);
  assert.deepEqual(r.added, []);
  assert.equal(r.stopped, 'few-games');
});

test('extendLine trims a trailing opponent move', async function () {
  // games run out after one added ply (Black's move), so it must be dropped
  const r = await extendLine(CHIGORIN, { fetchPosition: stubExplorer(function (ply) { return ply === 23 ? 1000 : 10; }) });
  assert.deepEqual(r.sans, CHIGORIN);
  assert.deepEqual(r.added, []);
  assert.equal(r.stopped, 'few-games');
});

test('extendLine keeps a Black-side line ending on Black\'s move', async function () {
  const caro = 'e4 c6 d4 d5 e5 Bf5 Nf3 e6 Be2 Nd7 O-O Ne7 c3 c5 Be3 Nc6 Nbd2 cxd4 cxd4 Be7'.split(' ');
  const r = await extendLine(caro, { fetchPosition: stubExplorer(function () { return 1000; }) });
  assert.equal(r.sans.length, 36);
  assert.equal(r.stopped, 'max-depth');
});

test('extendLine reports no-moves when the explorer offers none', async function () {
  const r = await extendLine(CHIGORIN, { fetchPosition: async function () { return { white: 500, draws: 0, black: 0, moves: [] }; } });
  assert.equal(r.stopped, 'no-moves');
  assert.deepEqual(r.sans, CHIGORIN);
});

function fakeFetch(statuses, body) {
  const calls = [];
  const f = async function (url, init) {
    calls.push({ url: url, init: init });
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    return { status: status, ok: status === 200, json: async function () { return body; } };
  };
  f.calls = calls;
  return f;
}

test('makeFetchPosition sends the token and the moves, and returns the body', async function () {
  const f = fakeFetch([200], { white: 1 });
  const sleeps = [];
  const fp = makeFetchPosition({ token: 'tok123', fetchImpl: f, sleep: async function (ms) { sleeps.push(ms); } });
  assert.deepEqual(await fp(['e2e4', 'e7e5']), { white: 1 });
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer tok123');
  assert.equal(f.calls[0].url, 'https://explorer.lichess.ovh/masters?play=e2e4,e7e5&moves=5&topGames=0');
  assert.deepEqual(sleeps, [1000]);
});

test('makeFetchPosition waits a minute after a 429 and retries', async function () {
  const f = fakeFetch([429, 200], { ok: true });
  const sleeps = [];
  const fp = makeFetchPosition({ token: 't', fetchImpl: f, sleep: async function (ms) { sleeps.push(ms); } });
  assert.deepEqual(await fp([]), { ok: true });
  assert.equal(f.calls.length, 2);
  assert.ok(sleeps.includes(60000));
});

test('makeFetchPosition gives up after five retries of 429', async function () {
  const f = fakeFetch([429], {});
  const fp = makeFetchPosition({ token: 't', fetchImpl: f, sleep: async function () {} });
  await assert.rejects(fp([]), /rate limit/i);
  assert.equal(f.calls.length, 6);
});

test('makeFetchPosition explains a rejected token without printing it', async function () {
  const f = fakeFetch([401], {});
  const fp = makeFetchPosition({ token: 'secret-token', fetchImpl: f, sleep: async function () {} });
  await assert.rejects(fp([]), function (e) {
    assert.match(e.message, /Lichess rejected the token/);
    assert.ok(!e.message.includes('secret-token'));
    return true;
  });
});

test('makeFetchPosition refuses to run without a token', function () {
  assert.throws(function () { makeFetchPosition({ token: '', fetchImpl: fakeFetch([200], {}), sleep: async function () {} }); }, /LICHESS_TOKEN/);
});

test('buildReport lists added moves with move numbers and why each line stopped', function () {
  const md = buildReport('ruy-lopez', [
    { id: 'chigorin', before: CHIGORIN, sans: CHIGORIN.concat(['cxd4', 'cxd4']), stopped: 'few-games',
      added: [{ san: 'cxd4', reached: 1200, share: 0.61 }, { san: 'cxd4', reached: 730, share: 0.9 }] },
    { id: 'berlin', before: ['e4'], sans: ['e4'], stopped: 'few-games', added: [] }
  ]);
  assert.match(md, /ruy-lopez/);
  assert.match(md, /12\.\.\.cxd4 \| 1200 \| 61%/);
  assert.match(md, /13\.cxd4 \| 730 \| 90%/);
  assert.match(md, /berlin[\s\S]*No moves added/);
  assert.match(md, /fewer than 50 master games/);
});
