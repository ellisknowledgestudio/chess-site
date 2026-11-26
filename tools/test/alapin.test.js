'use strict';
// Content checks for the Sicilian Alapin guide and its entry points.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '../..');
const CHESS_SRC = fs.readFileSync(require.resolve('chess.js-legacy'), 'utf8');

function load(rel) {
  const html = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/<script async src="https:\/\/www\.googletagmanager[^>]*><\/script>/, '')
    .replace(/<script src="https:\/\/cdnjs[^>]*chess[^>]*><\/script>/,
      '<script>window.EKS_REPLY_DELAY = 0;\n' + CHESS_SRC.replace(/<\/script/g, '<\\/script') + '</script>');
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', function (e) { errors.push(e); });
  const dom = new JSDOM(html, { runScripts: 'dangerously', virtualConsole: vc, pretendToBeVisual: true });
  return { w: dom.window, d: dom.window.document, errors: errors };
}
function play(w, sans) { const g = new w.Chess(); sans.forEach(function (s) { assert.ok(g.move(s), 'illegal move ' + s + ' in ' + sans.join(' ')); }); return g; }

test('Alapin page loads cleanly and is about the Alapin, not the Ruy Lopez', function () {
  const p = load('openings/sicilian-alapin/index.html');
  assert.deepEqual(p.errors, []);
  assert.match(p.d.title, /Sicilian.*Alapin/);
  assert.equal(p.d.querySelector('link[rel=canonical]').href, 'https://chess.ellisknowledgestudio.com/openings/sicilian-alapin/');
  assert.doesNotMatch(p.d.documentElement.outerHTML, /Ruy|Lopez|Spanish|Noah|Chigorin|Berlin/);
});

test('Alapin trainer has one line for each sound reply to 2.c3', function () {
  const p = load('openings/sicilian-alapin/index.html');
  const lines = p.w.EKSAlapin.LINES;
  const replies = Array.from(lines).map(function (l) {
    const m = l.moves.split(' ');
    assert.deepEqual(m.slice(0, 3), ['e4', 'c5', 'c3'], l.id);
    assert.equal(m.length % 2, 1, l.id + ' ends on White\'s move');
    assert.ok(m.length >= 13, l.id + ' is at least 7 moves long');
    play(p.w, m);
    assert.ok(l.name && l.blurb && l.note, l.id + ' has name, blurb and note');
    return m[3];
  });
  assert.deepEqual(replies.slice().sort(), ['Nc6', 'Nf6', 'b6', 'd5', 'd6', 'e5', 'e6', 'g6']);
});

test('Alapin trap shows the Qa4+ fork winning the knight on e4', function () {
  const p = load('openings/sicilian-alapin/index.html');
  const trap = p.w.EKSAlapin.TRAPS[0];
  const m = trap.moves.split(' ');
  const g = play(p.w, m);
  assert.equal(m[trap.bad], 'Nxe4', 'the marked mistake is ...Nxe4');
  assert.ok(m.indexOf('Qa4+') > trap.bad);
  assert.equal(m[m.length - 1], 'Qxe4');
  assert.equal(g.get('e4').type, 'q');
});

test('Alapin quiz positions are legal and every accepted answer is a legal move', function () {
  const p = load('openings/sicilian-alapin/index.html');
  const quiz = p.w.EKSAlapin.QUIZ;
  assert.ok(quiz.length >= 5);
  quiz.forEach(function (q) {
    const pre = q.pre.split(' ');
    assert.deepEqual(pre.slice(0, 3), ['e4', 'c5', 'c3']);
    q.accept.forEach(function (a) {
      const g = play(p.w, pre);
      assert.equal(g.turn(), 'w', 'quiz asks for a White move: ' + q.pre);
      assert.ok(g.move(a), 'accepted answer ' + a + ' is illegal after ' + q.pre);
    });
    assert.ok(q.prompt && q.explain);
  });
});

test('openings index lists the Alapin guide and the explorer links to it only for the Alapin', function () {
  const p = load('openings/index.html');
  assert.deepEqual(p.errors, []);
  const api = p.w.EKSOpenings;
  assert.ok(api.GUIDES.some(function (g) { return g.url === 'sicilian-alapin/' && g.live; }));
  const shown = function (page) {
    const gl = page.d.getElementById('guideLink'), a = gl.querySelector('a');
    return gl.style.display !== 'none' && a ? a.getAttribute('href') : null;
  };
  ['e4', 'c5', 'c3'].forEach(api.playSan);
  assert.equal(shown(p), 'sicilian-alapin/', 'Alapin position links to the guide');
  ['Nf6', 'e5'].forEach(api.playSan);
  assert.equal(shown(p), 'sicilian-alapin/', 'a deeper Alapin position still links to the guide');
  const q = load('openings/index.html');
  ['e4', 'c5', 'Nf3'].forEach(q.w.EKSOpenings.playSan);
  assert.equal(shown(q), null, 'an Open Sicilian does not link to the Alapin guide');
});

test('sitemap and workflow know about the Alapin page', function () {
  assert.match(fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8'), /openings\/sicilian-alapin\/<\/loc>/);
  assert.match(fs.readFileSync(path.join(ROOT, '.github/workflows/extend-lines.yml'), 'utf8'), /^\s+- sicilian-alapin$/m);
});
