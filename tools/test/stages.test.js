'use strict';
// Runs the real Ruy Lopez page in jsdom and drives the trainer by clicking squares.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const PAGE = path.join(__dirname, '../../openings/ruy-lopez/index.html');
const CHESS_SRC = fs.readFileSync(require.resolve('chess.js-legacy'), 'utf8');
const SHORT_CHIGORIN = 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Na5 Bc2 c5 d4 Qc7 Nbd2';   // 23 plies, ends 12.Nbd2
const LONG_CHIGORIN = 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Na5 Bc2 c5 d4 Qc7 Nbd2 ' +
  'cxd4 cxd4 Nc6 Nb3 a5 Be3 a4 Nbd2 Bd7 Rc1 Qb7 Qe2';   // 35 plies, ends 18.Qe2

function loadPage() {
  const html = fs.readFileSync(PAGE, 'utf8')
    .replace(/<script async src="https:\/\/www\.googletagmanager[^>]*><\/script>/, '')
    .replace(/<script src="https:\/\/cdnjs[^>]*chess[^>]*><\/script>/,
      '<script>window.EKS_REPLY_DELAY = 0;\n' + CHESS_SRC.replace(/<\/script/g, '<\\/script') + '</script>');
  const errors = [];
  const { VirtualConsole } = require('jsdom');
  const vc = new VirtualConsole();
  vc.on('jsdomError', function (e) { errors.push(e); });
  const dom = new JSDOM(html, { runScripts: 'dangerously', virtualConsole: vc, pretendToBeVisual: true });
  const w = dom.window, d = w.document;
  return {
    w: w, d: d, errors: errors, api: w.EKSRuyLopez,
    pickLine: function (name) { click(d, '#linePicker button', name); },
    pickStage: function (label) { click(d, '#stagePicker button', label); },
    stageLabels: function () { return Array.from(d.querySelectorAll('#stagePicker button')).map(function (b) { return b.textContent; }); },
    play: function (from, to) {
      d.querySelector('#trainBoard [data-sq="' + from + '"]').click();
      d.querySelector('#trainBoard [data-sq="' + to + '"]').click();
    },
    feedback: function () { return d.getElementById('trainFeedback').textContent; }
  };
}
function click(d, sel, text) {
  const b = Array.from(d.querySelectorAll(sel)).find(function (x) { return x.textContent.indexOf(text) === 0; });
  assert.ok(b, 'button "' + text + '" not found in ' + sel);
  b.click();
}
const WHITE_FIRST_8 = [['e2', 'e4'], ['g1', 'f3'], ['f1', 'b5'], ['b5', 'a4'], ['e1', 'g1'], ['f1', 'e1'], ['a4', 'b3'], ['c2', 'c3']];

test('stagePlies ends on the trainee\'s move and never exceeds the line', function () {
  const api = loadPage().api;
  assert.equal(api.stagePlies(35, 8, true), 15);
  assert.equal(api.stagePlies(35, 12, true), 23);
  assert.equal(api.stagePlies(35, 0, true), 35);
  assert.equal(api.stagePlies(36, 8, false), 16);
  assert.equal(api.stagePlies(21, 12, true), 21);
});

test('availableStages hides stages that are not shorter than the line', function () {
  const api = loadPage().api;
  assert.deepEqual(Array.from(api.availableStages(23, true)), [8, 0]);
  assert.deepEqual(Array.from(api.availableStages(35, true)), [8, 12, 0]);
  assert.deepEqual(Array.from(api.availableStages(15, true)), [0]);
});

test('page loads without script errors and shows no stage buttons before a line is chosen', function () {
  const p = loadPage();
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.stageLabels(), []);
});

test('a 12-move line offers "To move 8" and "Full line" only', function () {
  const p = loadPage();
  p.api.LINES[0].moves = SHORT_CHIGORIN;
  p.pickLine('Closed: Chigorin');
  assert.deepEqual(p.stageLabels(), ['To move 8', 'Full line']);
});

test('training to move 8 finishes after White\'s 8th move and is tracked for that stage only', function () {
  const p = loadPage();
  const note = p.api.LINES[0].note;
  p.pickLine('Closed: Chigorin');
  p.pickStage('To move 8');
  WHITE_FIRST_8.forEach(function (m) { p.play(m[0], m[1]); });
  const T = p.api.state.T;
  assert.equal(T.ply, 15);
  assert.match(p.feedback(), /Stage complete/);
  assert.ok(!p.feedback().includes(note));
  assert.equal(T.done['chigorin:8'], true);
  assert.equal(T.done['chigorin:0'], undefined);
  assert.match(p.d.getElementById('trainStats').textContent, /Lines completed to move 8: 1 \/ 3/);
  p.pickStage('Full line');
  assert.equal(p.api.state.T.ply, 0, 'changing stage restarts the line');
  assert.match(p.d.getElementById('trainStats').textContent, /Lines completed in full: 0 \/ 3/);
  assert.deepEqual(p.errors, []);
});

test('a full line still ends with the line\'s own note', function () {
  const p = loadPage();
  p.api.LINES[0].moves = SHORT_CHIGORIN;
  p.pickLine('Closed: Chigorin');
  WHITE_FIRST_8.concat([['h2', 'h3'], ['b3', 'c2'], ['d2', 'd4'], ['b1', 'd2']]).forEach(function (m) { p.play(m[0], m[1]); });
  assert.match(p.feedback(), /Line complete/);
  assert.ok(p.feedback().includes(p.api.LINES[0].note));
  assert.equal(p.api.state.T.done['chigorin:0'], true);
});

test('an 18-move line offers all three stages', function () {
  const p = loadPage();
  p.api.LINES[0].moves = LONG_CHIGORIN;
  p.pickLine('Closed: Chigorin');
  assert.deepEqual(p.stageLabels(), ['To move 8', 'To move 12', 'Full line']);
  p.pickStage('To move 12');
  WHITE_FIRST_8.concat([['h2', 'h3'], ['b3', 'c2'], ['d2', 'd4'], ['b1', 'd2']]).forEach(function (m) { p.play(m[0], m[1]); });
  assert.equal(p.api.state.T.ply, 23);
  assert.match(p.feedback(), /Stage complete/);
});

test('switching to a shorter line falls back to the full line when the stage does not apply', function () {
  const p = loadPage();
  p.api.LINES[0].moves = LONG_CHIGORIN;
  p.pickLine('Closed: Chigorin');
  p.api.LINES[1].moves = 'e4 e5 Nf3 Nc6 Bb5 Nf6 d3 Bc5 c3 O-O O-O d6 h3 a6 Ba4 Ba7 Re1 Ne7 Nbd2 Ng6 Nf1';
  p.pickStage('To move 12');
  p.pickLine('Berlin');
  assert.equal(p.api.state.T.stage, 0);
  assert.deepEqual(p.stageLabels(), ['To move 8', 'Full line']);
});

test('choosing a stage keeps keyboard focus on that button and announces the stage', function () {
  const p = loadPage();
  p.pickLine('Closed: Chigorin');
  p.pickStage('To move 8');
  const active = p.d.activeElement;
  assert.equal(active && active.textContent, 'To move 8');
  assert.equal(active.getAttribute('aria-pressed'), 'true');
  assert.match(p.feedback(), /Training to move 8/);
});

test('every line on the live page is legal and ends on White\'s move', function () {
  const p = loadPage();
  p.api.LINES.forEach(function (line) {
    const g = new p.w.Chess();
    const moves = line.moves.split(' ');
    moves.forEach(function (san) { assert.ok(g.move(san), line.id + ': illegal move ' + san); });
    assert.equal(moves.length % 2, 1, line.id + ' should end on White\'s move');
  });
});

test('the extended Chigorin can be trained to move 12 on the live page', function () {
  const p = loadPage();
  p.pickLine('Closed: Chigorin');
  assert.deepEqual(p.stageLabels(), ['To move 8', 'To move 12', 'Full line']);
});
