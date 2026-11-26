'use strict';
// Stage control behaviour on every opening guide, driven through the real pages in jsdom.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const CHESS_SRC = fs.readFileSync(require.resolve('chess.js-legacy'), 'utf8');
const PAGES = [
  { slug: 'ruy-lopez', api: 'EKSRuyLopez', white: true },
  { slug: 'italian-game', api: 'EKSItalian', white: true },
  { slug: 'sicilian-alapin', api: 'EKSAlapin', white: true },
  { slug: 'caro-kann', api: 'EKSCaroKann', white: false },
  { slug: 'queens-gambit-declined', api: 'EKSQGD', white: false },
  { slug: 'scotch-game', api: 'EKSScotch', white: true },
  { slug: 'kings-indian-defence', api: 'EKSKingsIndian', white: false },
  { slug: 'grunfeld-defence', api: 'EKSGrunfeld', white: false },
  { slug: 'english-opening', api: 'EKSEnglish', white: true },
  { slug: 'pirc-defence', api: 'EKSPirc', white: false },
  { slug: 'sicilian-najdorf', api: 'EKSNajdorf', white: false },
  { slug: 'sicilian-dragon', api: 'EKSDragon', white: false },
  { slug: 'sicilian-sveshnikov', api: 'EKSSveshnikov', white: false },
  { slug: 'sicilian-taimanov', api: 'EKSTaimanov', white: false },
  { slug: 'sicilian-classical', api: 'EKSClassicalSicilian', white: false },
  { slug: 'sicilian-accelerated-dragon', api: 'EKSAccelDragon', white: false },
  { slug: 'sicilian-scheveningen', api: 'EKSScheveningen', white: false },
  { slug: 'sicilian-smith-morra', api: 'EKSSmithMorra', white: true }
];
// A legal 36-ply line for each side to stand in for an extended line.
const LONG = {
  true: 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Na5 Bc2 c5 d4 Qc7 Nbd2 cxd4 cxd4 Nc6 Nb3 a5 Be3 a4 Nbd2 Bd7 Rc1 Qb7 Qe2',
  false: 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Na5 Bc2 c5 d4 Qc7 Nbd2 cxd4 cxd4 Nc6 Nb3 a5 Be3 a4 Nbd2 Bd7 Rc1 Qb7 Qe2 Rfc8'
};

function load(page) {
  const html = fs.readFileSync(path.join(__dirname, '../../openings', page.slug, 'index.html'), 'utf8')
    .replace(/<script async src="https:\/\/www\.googletagmanager[^>]*><\/script>/, '')
    .replace(/<script src="https:\/\/cdnjs[^>]*chess[^>]*><\/script>/,
      '<script>window.EKS_REPLY_DELAY = 0;\n' + CHESS_SRC.replace(/<\/script/g, '<\\/script') + '</script>');
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', function (e) { errors.push(e); });
  const dom = new JSDOM(html, { runScripts: 'dangerously', virtualConsole: vc, pretendToBeVisual: true });
  const w = dom.window, d = w.document, api = w[page.api];
  const p = {
    w: w, d: d, api: api, errors: errors,
    stageButtons: function () { return Array.from(d.querySelectorAll('#stagePicker button')); },
    stageLabels: function () { return p.stageButtons().map(function (b) { return b.textContent; }); },
    pickFirstLine: function () { d.querySelector('#linePicker button').click(); },
    pickStage: function (label) {
      const b = p.stageButtons().find(function (x) { return x.textContent === label; });
      assert.ok(b, 'no stage button "' + label + '"'); b.click();
    },
    // Play the trainee's moves from the line itself until the trainer stops accepting them.
    playThrough: function () {
      const moves = api.LINES[0].moves.split(' ');
      const g = new w.Chess();
      for (let i = 0; i < moves.length; i++) {
        const m = g.move(moves[i]);
        const traineeMove = (i % 2 === 0) === page.white;
        if (traineeMove && api.state.T.ply === i) {
          d.querySelector('#trainBoard [data-sq="' + m.from + '"]').click();
          d.querySelector('#trainBoard [data-sq="' + m.to + '"]').click();
        }
      }
    },
    feedback: function () { return d.getElementById('trainFeedback').textContent; }
  };
  return p;
}

PAGES.forEach(function (page) {
  const n8 = page.white ? 15 : 16, n12 = page.white ? 23 : 24;

  test(page.slug + ': stage row is hidden until a line is chosen, and the page has no script errors', function () {
    const p = load(page);
    assert.ok(p.d.getElementById('stageRow'), 'stage row exists');
    assert.equal(p.d.getElementById('stageRow').hidden, true);
    assert.deepEqual(p.errors, []);
  });

  test(page.slug + ': stagePlies ends on the trainee\'s move', function () {
    const p = load(page);
    assert.equal(p.api.stagePlies(36, 8, page.white), n8);
    assert.equal(p.api.stagePlies(36, 12, page.white), n12);
    assert.equal(p.api.stagePlies(36, 0, page.white), 36);
  });

  test(page.slug + ': an 18-move line offers all three stages, and stage 8 stops after the trainee\'s 8th move', function () {
    const p = load(page);
    p.api.LINES[0].moves = LONG[page.white];
    const note = p.api.LINES[0].note;
    p.pickFirstLine();
    assert.deepEqual(p.stageLabels(), ['To move 8', 'To move 12', 'Full line']);
    p.pickStage('To move 8');
    assert.equal(p.d.activeElement.textContent, 'To move 8', 'focus stays on the chosen stage');
    assert.match(p.feedback(), /Training to move 8/);
    p.playThrough();
    assert.equal(p.api.state.T.ply, n8);
    assert.match(p.feedback(), /Stage complete/);
    assert.ok(!p.feedback().includes(note));
    assert.equal(p.api.state.T.done[p.api.LINES[0].id + ':8'], true);
    assert.match(p.d.getElementById('trainStats').textContent, /Lines completed to move 8: 1 \//);
    assert.deepEqual(p.errors, []);
  });

  test(page.slug + ': the full line still finishes with the line\'s own note', function () {
    const p = load(page);
    p.pickFirstLine();
    p.playThrough();
    assert.match(p.feedback(), /Line complete/);
    assert.ok(p.feedback().includes(p.api.LINES[0].note));
    assert.equal(p.api.state.T.done[p.api.LINES[0].id + ':0'], true);
  });

  test(page.slug + ': every line is legal and stage buttons match its length', function () {
    const p = load(page);
    p.api.LINES.forEach(function (line, i) {
      const g = new p.w.Chess();
      const moves = line.moves.split(' ');
      moves.forEach(function (san) { assert.ok(g.move(san), line.id + ': illegal move ' + san); });
      p.d.querySelectorAll('#linePicker button')[i].click();
      const want = [];
      if (n8 < moves.length) want.push('To move 8');
      if (n12 < moves.length) want.push('To move 12');
      if (want.length) want.push('Full line');
      assert.deepEqual(p.stageLabels(), want, line.id);
    });
  });
});
