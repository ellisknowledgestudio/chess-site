/**
 * Ellis Knowledge Studio – AI Chess Coach (front end)
 *
 * Drop-in module for any board that uses chess.js.
 *
 *   import { ChessCoach } from '/coach/coach.js';
 *   const coach = new ChessCoach({ container: document.getElementById('coach') });
 *   // after the student plays a move:
 *   coach.explainMove(fenBeforeTheMove, 'Nxe5');
 *
 * Flow: Stockfish analyses the position before and after the move →
 * the move is graded → the facts go to /coach/api/explain.php →
 * Claude explains them in plain English → shown in the panel.
 */
import { Chess } from './vendor/chess.js';

const HERE = new URL('.', import.meta.url);

/* ------------------------------------------------------------------ */
/* Stockfish wrapper                                                   */
/* ------------------------------------------------------------------ */
export class EngineAnalyser {
  constructor(workerUrl = new URL('vendor/stockfish-19-lite-single.js', HERE)) {
    this.worker = new Worker(workerUrl);
    this.queue = Promise.resolve();
    this.listeners = new Set();
    this.worker.onmessage = (e) => {
      const line = typeof e.data === 'string' ? e.data : '';
      for (const fn of this.listeners) fn(line);
    };
    this.ready = this._waitFor('uci', 'uciok').then(() => this._waitFor('isready', 'readyok'));
  }

  _waitFor(cmd, token) {
    return new Promise((resolve) => {
      const fn = (line) => {
        if (line.startsWith(token)) { this.listeners.delete(fn); resolve(); }
      };
      this.listeners.add(fn);
      this.worker.postMessage(cmd);
    });
  }

  /** Analyse a FEN. Score is from the side to move's point of view. */
  analyse(fen, { depth = 16, movetime = 2500 } = {}) {
    const job = async () => {
      await this.ready;
      return new Promise((resolve) => {
        let result = { score: null, pv: [], best: null };
        const fn = (line) => {
          if (line.startsWith('info') && line.includes(' pv ') && !line.includes('multipv 2')) {
            const cp = line.match(/score cp (-?\d+)/);
            const mate = line.match(/score mate (-?\d+)/);
            if (cp) result.score = { cp: +cp[1] };
            if (mate) result.score = { mate: +mate[1] };
            result.pv = line.split(' pv ')[1].trim().split(/\s+/);
          } else if (line.startsWith('info') && /score mate 0\b/.test(line)) {
            result.score = { mate: 0 };
          } else if (line.startsWith('bestmove')) {
            this.listeners.delete(fn);
            const bm = line.split(/\s+/)[1];
            result.best = bm && bm !== '(none)' ? bm : null;
            resolve(result);
          }
        };
        this.listeners.add(fn);
        this.worker.postMessage('ucinewgame');
        this.worker.postMessage('position fen ' + fen);
        this.worker.postMessage(`go depth ${depth} movetime ${movetime}`);
      });
    };
    const p = this.queue.then(job);
    this.queue = p.catch(() => {});
    return p;
  }

  /**
   * Choose a move to PLAY at a given strength (see STRENGTHS).
   * Use a separate EngineAnalyser for playing, so strength limits never affect analysis.
   */
  playMove(fen, strength = STRENGTHS[2]) {
    const job = async () => {
      await this.ready;
      return new Promise((resolve) => {
        const fn = (line) => {
          if (line.startsWith('bestmove')) {
            this.listeners.delete(fn);
            const bm = line.split(/\s+/)[1];
            resolve(bm && bm !== '(none)' ? bm : null);
          }
        };
        this.listeners.add(fn);
        const w = this.worker;
        w.postMessage('setoption name UCI_LimitStrength value ' + (strength.elo ? 'true' : 'false'));
        if (strength.elo) w.postMessage('setoption name UCI_Elo value ' + strength.elo);
        w.postMessage('setoption name Skill Level value ' + (strength.skill ?? 20));
        w.postMessage('position fen ' + fen);
        w.postMessage(strength.depth ? `go depth ${strength.depth} movetime ${strength.movetime}` : `go movetime ${strength.movetime}`);
      });
    };
    const p = this.queue.then(job);
    this.queue = p.catch(() => {});
    return p;
  }

  destroy() { this.worker.terminate(); }
}

/** Playing strengths for "play the coach". Ratings are rough guides, not calibrated. */
export const STRENGTHS = [
  { id: 1, label: 'Beginner (≈800)', skill: 0, depth: 1, movetime: 150 },
  { id: 2, label: 'Casual (≈1100)', skill: 3, depth: 4, movetime: 300 },
  { id: 3, label: 'Club (≈1400)', elo: 1400, movetime: 600 },
  { id: 4, label: 'Strong club (≈1800)', elo: 1800, movetime: 800 },
  { id: 5, label: 'Expert (≈2200)', elo: 2200, movetime: 1000 },
  { id: 6, label: 'Full strength', movetime: 1500 },
];

/* ------------------------------------------------------------------ */
/* Grading                                                             */
/* ------------------------------------------------------------------ */
const toCp = (e) => (e.mate !== undefined ? (e.mate > 0 ? 10000 - e.mate * 10 : -10000 - e.mate * 10) : e.cp);
const winPct = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * Math.max(-1500, Math.min(1500, cp)))) - 1);
const negate = (e) => (e.mate !== undefined ? { mate: -e.mate } : { cp: -e.cp });

/** Both evals from the mover's point of view. */
export function classifyMove(before, after, playedIsBest) {
  if (playedIsBest) return 'best';
  const loss = winPct(toCp(before)) - winPct(toCp(after));
  // Win-chance drop in percentage points (same scale Lichess uses).
  if (loss < 2) return 'excellent';
  if (loss < 5) return 'good';
  if (loss < 10) return 'inaccuracy';
  if (loss < 15) return 'mistake';
  return 'blunder';
}

function uciToSan(fen, uciMoves, max = 8) {
  const g = new Chess(fen);
  const out = [];
  for (const u of uciMoves.slice(0, max)) {
    try {
      const m = g.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      out.push(m.san);
    } catch { break; }
  }
  return out;
}

/** Run the engine on the move and build the payload for the coach. */
export async function analyseMove(engine, fenBefore, san, opts) {
  const g = new Chess(fenBefore);
  const played = g.move(san); // throws if illegal
  const fenAfter = g.fen();

  const pre = await engine.analyse(fenBefore, opts);
  let evalAfter, replyLine = [];
  if (g.isCheckmate()) {
    evalAfter = { mate: 1 };
  } else if (g.isDraw() || g.isStalemate()) {
    evalAfter = { cp: 0 };
  } else {
    const post = await engine.analyse(fenAfter, opts);
    evalAfter = post.score ? negate(post.score) : { cp: 0 };
    replyLine = uciToSan(fenAfter, post.pv);
  }
  const evalBefore = pre.score || { cp: 0 };
  const bestLine = uciToSan(fenBefore, pre.pv.length ? pre.pv : pre.best ? [pre.best] : []);
  const bestMove = bestLine[0] || '';
  const playedIsBest = bestMove === played.san || g.isCheckmate();

  return {
    fen: fenBefore,
    move: played.san,
    fenAfter,
    evalBefore,
    evalAfter,
    bestMove,
    bestLine,
    replyLine,
    classification: classifyMove(evalBefore, evalAfter, playedIsBest),
  };
}

/* ------------------------------------------------------------------ */
/* Coach panel                                                         */
/* ------------------------------------------------------------------ */
const LABELS = {
  best: 'Best move', excellent: 'Excellent', good: 'Good',
  inaccuracy: 'Inaccuracy', mistake: 'Mistake', blunder: 'Blunder',
};
const SYMBOL = { inaccuracy: '?!', mistake: '?', blunder: '??', best: '!', excellent: '', good: '' };

function fmtEval(e, moverIsWhite) {
  // Display from White's point of view, as players expect.
  const w = moverIsWhite ? e : negate(e);
  if (w.mate !== undefined) return (w.mate >= 0 ? '#' : '#-') + Math.abs(w.mate);
  const v = w.cp / 100;
  return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class ChessCoach {
  /**
   * @param {object} o
   * @param {HTMLElement} o.container  where the panel is drawn
   * @param {string} [o.endpoint]      URL of explain.php
   * @param {'beginner'|'club'|'advanced'} [o.level]
   * @param {EngineAnalyser} [o.engine] reuse an existing engine if your board has one
   */
  constructor({ container, endpoint = new URL('api/explain.php', HERE).href, level = 'club', engine } = {}) {
    this.el = container;
    this.endpoint = endpoint;
    this.level = level;
    this.engine = engine || null;
    this.busy = false;
    this.el.classList.add('ekc');
    this._idle();
  }

  setLevel(level) { this.level = level; }

  _engine() { return (this.engine ||= new EngineAnalyser()); }

  _idle() {
    this.el.innerHTML = `<div class="ekc-empty"><span class="ekc-icon" aria-hidden="true">♞</span>
      <p>Play a move, then press <strong>Explain this move</strong> and the coach will tell you what it did.</p></div>`;
  }

  _status(msg) {
    this.el.innerHTML = `<div class="ekc-status" role="status"><span class="ekc-spin" aria-hidden="true"></span>${esc(msg)}</div>`;
  }

  /** Quick, free engine grade of a move (no AI call) – for live ?!/?/?? marks. */
  grade(fenBefore, san) {
    return analyseMove(this._engine(), fenBefore, san, { depth: 12, movetime: 800 });
  }

  /**
   * @param {string} fenBefore  position before the move
   * @param {string} san        the move
   * @param {{mover?: 'student'|'coach'}} [opts]  'coach' = explain the coach's own move
   */
  async explainMove(fenBefore, san, { mover = 'student' } = {}) {
    if (this.busy) return;
    this.busy = true;
    try {
      this._status('Stockfish is checking the position…');
      const a = await analyseMove(this._engine(), fenBefore, san);
      a.mover = mover;
      this._status('The coach is writing an explanation…');

      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...a, level: this.level }),
      });
      let data;
      try { data = await res.json(); } catch { data = { ok: false, error: 'The coach is unavailable right now.' }; }
      this._render(a, data);
      return { analysis: a, response: data };
    } catch (err) {
      console.error(err);
      this._render(null, { ok: false, error: 'Something went wrong analysing that move.' });
    } finally {
      this.busy = false;
    }
  }

  _render(a, data) {
    if (!data.ok) {
      this.el.innerHTML = `<div class="ekc-error" role="alert">${esc(data.error || 'The coach is unavailable right now.')}</div>` +
        (a ? this._linesHtml(a) : '');
      return;
    }
    const moverIsWhite = a.fen.split(' ')[1] === 'w';
    const num = a.fen.split(' ')[5];
    const label = `${num}${moverIsWhite ? '.' : '…'} ${a.move}${SYMBOL[a.classification] || ''}`;
    const lines = data.text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const body = lines.map((l) => /^takeaway:/i.test(l)
      ? `<p class="ekc-takeaway"><strong>Takeaway:</strong>${esc(l.replace(/^takeaway:/i, ''))}</p>`
      : `<p>${esc(l)}</p>`).join('');
    const warn = data.unverified && data.unverified.length
      ? `<p class="ekc-warn">Double-check with the engine: ${esc(data.unverified.join(', '))} ${data.unverified.length > 1 ? "aren't" : "isn't"} in Stockfish's lines.</p>` : '';
    const left = typeof data.remaining === 'number'
      ? `${data.remaining} free explanation${data.remaining === 1 ? '' : 's'} left today` : '';

    this.el.innerHTML = `
      <div class="ekc-head">
        <span class="ekc-badge ekc-${a.classification}">${LABELS[a.classification]}</span>
        <span class="ekc-move">${esc(label)}</span>
        <span class="ekc-eval" title="Evaluation from White's side, before → after">${fmtEval(a.evalBefore, moverIsWhite)} → ${fmtEval(a.evalAfter, moverIsWhite)}</span>
      </div>
      <div class="ekc-body">${body}${warn}</div>
      ${this._linesHtml(a)}
      <div class="ekc-foot">${esc(left)}${data.cached ? ' · saved answer' : ''}</div>`;
  }

  _linesHtml(a) {
    const row = (name, moves) => moves.length
      ? `<div><dt>${name}</dt><dd>${esc(moves.join(' '))}</dd></div>` : '';
    const best = a.classification === 'best' ? '' : row('Engine’s choice', a.bestLine);
    return `<dl class="ekc-lines">${best}${row('After ' + esc(a.move), a.replyLine)}</dl>`;
  }
}
