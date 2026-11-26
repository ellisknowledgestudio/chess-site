'use strict';
// Content checks shared by the opening guides built from the page templates.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '../..');
const CHESS_SRC = fs.readFileSync(require.resolve('chess.js-legacy'), 'utf8');
const GUIDES = [
  { slug: 'scotch-game', api: 'EKSScotch', white: true, title: /Scotch Game/, start: 'e4 e5 Nf3 Nc6 d4', minLines: 5,
    foreign: /Alapin|Sicilian|2\.c3|Caro/, explorer: ['e4', 'e5', 'Nf3', 'Nc6', 'd4'] },
  { slug: 'kings-indian-defence', api: 'EKSKingsIndian', white: false, title: /King's Indian Defence/, start: 'd4 Nf6 c4 g6', minLines: 6,
    foreign: /Caro|Kann|1\.e4 c6|Alapin|Ruy/, explorer: ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'Bg7', 'e4', 'd6'] },
  { slug: 'grunfeld-defence', api: 'EKSGrunfeld', white: false, title: /Grünfeld Defence/, start: 'd4 Nf6 c4 g6 Nc3 d5', minLines: 6,
    foreign: /Caro|Kann|1\.e4 c6|Alapin|Ruy/, explorer: ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'd5'] },
  { slug: 'english-opening', api: 'EKSEnglish', white: true, title: /English Opening/, start: 'c4', minLines: 6,
    foreign: /Alapin|2\.c3|Ruy|Caro/, explorer: ['c4'] },
  { slug: 'pirc-defence', api: 'EKSPirc', white: false, title: /Pirc Defence/, start: 'e4 d6 d4 Nf6 Nc3 g6', minLines: 6,
    foreign: /Caro|Kann|1\.e4 c6|Alapin|Ruy/, explorer: ['e4', 'd6', 'd4', 'Nf6', 'Nc3', 'g6'] }
];

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
function play(w, sans, label) {
  const g = new w.Chess();
  sans.forEach(function (s) { assert.ok(g.move(s), 'illegal move ' + s + ' in ' + (label || sans.join(' '))); });
  return g;
}

GUIDES.forEach(function (G) {
  const rel = 'openings/' + G.slug + '/index.html';
  const side = G.white ? 'w' : 'b';

  test(G.slug + ': page loads cleanly with its own title, address and wording', function () {
    const p = load(rel);
    assert.deepEqual(p.errors, []);
    assert.match(p.d.title, G.title);
    assert.equal(p.d.querySelector('link[rel=canonical]').href, 'https://chess.ellisknowledgestudio.com/openings/' + G.slug + '/');
    assert.doesNotMatch(p.d.getElementById('main').textContent + p.d.querySelector('footer').textContent, G.foreign, 'no wording left over from the template');
    assert.match(p.d.querySelector('.tags').textContent, G.white ? /For White/ : /For Black/);
    assert.ok(p.d.querySelectorAll('#overview .card').length >= 4);
  });

  test(G.slug + ': trainer lines are legal, start from the opening and end on the trainee\'s move', function () {
    const p = load(rel);
    const lines = Array.from(p.w[G.api].LINES);
    assert.ok(lines.length >= G.minLines, 'at least ' + G.minLines + ' lines');
    assert.equal(new Set(lines.map(function (l) { return l.id; })).size, lines.length, 'line ids are unique');
    lines.forEach(function (l) {
      const m = l.moves.split(' ');
      assert.ok(l.moves.indexOf(G.start) === 0 || l.allowOtherStart, l.id + ' starts with ' + G.start);
      assert.equal(m.length % 2, G.white ? 1 : 0, l.id + ' ends on the trainee\'s move');
      assert.ok(m.length >= 13, l.id + ' is at least 7 moves long');
      play(p.w, m, l.id);
      assert.ok(l.name && l.blurb && l.note, l.id + ' has name, blurb and note');
    });
  });

  test(G.slug + ': trap is legal and its notes point at real moves', function () {
    const p = load(rel);
    const traps = Array.from(p.w[G.api].TRAPS);
    assert.ok(traps.length >= 1);
    traps.forEach(function (t) {
      const m = t.moves.split(' ');
      play(p.w, m, t.id);
      assert.ok(t.bad >= 0 && t.bad < m.length);
      Object.keys(t.notes).forEach(function (k) { assert.ok(+k >= 0 && +k < m.length, 'note ' + k + ' is inside the trap line'); });
      assert.ok(t.notes[t.bad], 'the mistake has a note');
      assert.ok(t.title && t.text);
    });
  });

  test(G.slug + ': quiz positions are legal, ask for the trainee\'s move and accept only legal answers', function () {
    const p = load(rel);
    const quiz = Array.from(p.w[G.api].QUIZ);
    assert.ok(quiz.length >= 5);
    quiz.forEach(function (q) {
      Array.from(q.accept).forEach(function (a) {
        const g = play(p.w, q.pre.split(' '), 'quiz ' + q.pre);
        assert.equal(g.turn(), side, 'quiz asks for the trainee\'s move: ' + q.pre);
        assert.ok(g.move(a), 'accepted answer ' + a + ' is illegal after ' + q.pre);
      });
      assert.ok(q.prompt && q.explain);
    });
  });

  test(G.slug + ': listed on the index, linked from the explorer, in the sitemap and the workflow', function () {
    const p = load('openings/index.html');
    assert.deepEqual(p.errors, []);
    const api = p.w.EKSOpenings;
    const entry = Array.from(api.GUIDES).filter(function (g) { return g.url === G.slug + '/'; });
    assert.equal(entry.length, 1);
    assert.equal(entry[0].live, true);
    assert.equal(entry[0].side, side);
    G.explorer.forEach(api.playSan);
    const gl = p.d.getElementById('guideLink'), a = gl.querySelector('a');
    assert.ok(gl.style.display !== 'none' && a && a.getAttribute('href') === G.slug + '/', 'explorer links to the guide');
    assert.match(fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8'), new RegExp('openings/' + G.slug + '/</loc>'));
    assert.match(fs.readFileSync(path.join(ROOT, '.github/workflows/extend-lines.yml'), 'utf8'), new RegExp('^\\s+- ' + G.slug + '$', 'm'));
  });
});
