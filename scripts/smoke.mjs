// Smoke test for ChessNext — mirrors the engine + parsing logic in index.html
// and verifies it end-to-end against the real, live APIs.
// Run: node scripts/smoke.mjs  (from the project root)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Chess } = require(process.cwd() + '/chess.min.js');

/* ---- replicated app logic (keep in sync with index.html) ---- */
function err(code) { const e = new Error(code); e.code = code; return e; }
async function jfetch(url, opts) {
  try { return await fetch(url, opts); } catch { throw err('NET'); }
}
function uciObj(u) {
  return { from: u.slice(0, 2), to: u.slice(2, 4), promotion: u.length > 4 ? u[4].toLowerCase() : undefined };
}
function tryMove(chess, tok) {
  const isUci = /^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(tok);
  let mv = null;
  if (isUci) mv = chess.move(uciObj(tok));
  else { try { mv = chess.move(tok); } catch { mv = null; } }
  return mv;
}
function parseMoves(text) {
  const tokens = (text || '').trim().split(/\s+/).filter(Boolean);
  const chess = new Chess();
  const applied = [];
  for (const tok of tokens) {
    if (/^\d+\.\.?$/.test(tok)) continue;
    const mv = tryMove(chess, tok);
    if (!mv) return { error: `"${tok}" is not a legal move from this position.` };
    applied.push({ from: mv.from, to: mv.to, san: mv.san, color: mv.color, promotion: mv.promotion || '' });
  }
  return { chess, applied };
}
// Mirrors index.html parseInput: '/' => FEN (validated), else moves.
function isValidFen(t) {
  const parts = t.trim().split(/\s+/);
  if (parts.length !== 6) return false;
  const ranks = parts[0].split('/');
  if (ranks.length !== 8) return false;
  for (const rank of ranks) {
    if (!rank || rank.length > 8) return false;
    let sum = 0, prevDigit = false;
    for (const ch of rank) {
      if (ch >= '1' && ch <= '8') { if (prevDigit) return false; sum += +ch; prevDigit = true; }
      else if ('pnbrqkPNBRQK'.includes(ch)) { sum += 1; prevDigit = false; }
      else return false;
    }
    if (sum !== 8) return false;
  }
  if (parts[1] !== 'w' && parts[1] !== 'b') return false;
  const castling = parts[2];
  if (castling !== '-') {
    if (!/^[KQkq]+$/.test(castling)) return false;
    if (new Set(castling).size !== castling.length) return false;
  }
  if (parts[3] !== '-' && !/^[a-h][36]$/.test(parts[3])) return false;
  if (!/^\d+$/.test(parts[4])) return false;
  if (!/^\d+$/.test(parts[5]) || +parts[5] < 1) return false;
  return true;
}
function parseInput(text, mode) {
  const t = (text || '').trim();
  if (!t) return { chess: new Chess(), applied: [], mode: 'moves' };
  if (t.indexOf('/') !== -1) {
    if (!isValidFen(t)) return { error: 'bad fen' };
    return { chess: new Chess(t), applied: [], mode: 'fen' };
  }
  if (mode === 'fen') return { error: 'fen expected' };
  const p = parseMoves(t);
  if (p.error) return p;
  p.mode = 'moves';
  return p;
}

const ENGINES = {
  cloud: {
    async analyze(fen) {
      const r = await jfetch('https://lichess.org/api/cloud-eval?fen=' + encodeURIComponent(fen) + '&multiPv=3');
      if (r.status === 404) throw err('NO_CLOUD');
      if (r.status === 429) throw err('RATE');
      if (!r.ok) throw err('HTTP');
      const j = await r.json();
      const all = j.pvs || [];
      const candidates = all.slice(0, 3).map((pv) => {
        const first = String(pv.moves || '').trim().split(/\s+/).filter(Boolean)[0];
        return { uci: first, cp: (typeof pv.cp === 'number' ? pv.cp : null),
          mate: (typeof pv.mate === 'number' ? pv.mate : null) };
      }).filter((c) => c.uci);
      const pv0 = all[0];
      if (!pv0 || !pv0.moves) throw err('NO_EVAL');
      const pv = String(pv0.moves).trim().split(/\s+/).filter(Boolean);
      return { uci: pv[0], cp: (typeof pv0.cp === 'number' ? pv0.cp : null),
        mate: (typeof pv0.mate === 'number' ? pv0.mate : null), depth: j.depth || null,
        knodes: j.knodes || null, pv, candidates, note: 'Lichess cloud Stockfish database' };
    }
  },
  api: {
    async analyze(fen) {
      let lastErr = null;
      let fenToSend = fen;
      let epStripped = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await jfetch('https://chess-api.com/v1', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fen: fenToSend })
          });
          if (!r.ok) throw err('HTTP');
          const j = await r.json();
          if (j.move) {
            return { uci: j.move, cp: (typeof j.centipawns === 'number' ? j.centipawns : null),
              mate: (typeof j.mate === 'number' ? j.mate : null), depth: j.depth || null,
              pv: Array.isArray(j.continuationArr) ? j.continuationArr : [],
              note: 'Live Stockfish' + (epStripped ? ' · en-passant square ignored (API limit)' : '') };
          }
          if (!epStripped) {
            const parts = fenToSend.split(/\s+/);
            if (parts.length === 6 && parts[3] !== '-') {
              parts[3] = '-';
              fenToSend = parts.join(' ');
              epStripped = true;
              lastErr = err('NO_EVAL');
              continue;
            }
          }
          lastErr = err('NO_EVAL');
        } catch (e) { lastErr = e; }
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1500));
      }
      throw lastErr;
    }
  },
  chessdb: {
    async analyze(fen) {
      const r = await jfetch('https://www.chessdb.cn/cdb.php?action=queryall&board=' + encodeURIComponent(fen));
      if (!r.ok) throw err('HTTP');
      const t = await r.text();
      if (!t || t.indexOf('move:') === -1) throw err('NO_BOOK');
      const rows = t.split('|').map((seg) => {
        const kv = {};
        seg.split(',').forEach((pair) => { const i = pair.indexOf(':'); if (i > 0) kv[pair.slice(0, i)] = pair.slice(i + 1); });
        return kv;
      }).filter((x) => x.move);
      if (!rows.length) throw err('NO_BOOK');
      const rankOf = (m) => parseInt(m.rank, 10) || 0;
      const wrOf = (m) => parseFloat(m.winrate) || 0;
      const best = rows.slice().sort((a, b) => (rankOf(b) - rankOf(a)) || (wrOf(b) - wrOf(a)))[0];
      return { uci: best.move, cp: null, mate: null, depth: null, pv: [], winrate: wrOf(best),
        allMoves: rows.map((m) => ({ uci: m.move, winrate: wrOf(m), rank: rankOf(m) })),
        note: 'ChessDB.cn win-rate opening book' };
    }
  }
};

/* ---- tests ---- */
const fmtCp = (cp) => {
  const s = cp / 100;
  return (s > 0 ? '+' : s < 0 ? '−' : '') + Math.abs(s).toFixed(2);
};
const results = [];
function check(name, cond, extra) {
  results.push(!!cond);
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (extra !== undefined ? ' :: ' + extra : ''));
}

// FEN pipeline
const p1 = parseMoves('e2e4 e7e5 g1f3 b8c6 f1c4');
check('UCI parse ok (5 moves)', !p1.error && p1.applied.length === 5, p1.error || '');
check('UCI -> FEN (Italian Game)', p1.chess && p1.chess.fen() === 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3', p1.chess ? p1.chess.fen() : '');
const p2 = parseMoves('e4 e5 Nf3 Nc6 Bc4');
check('SAN input -> same FEN', p2.chess && p2.chess.fen() === p1.chess.fen(), p2.chess ? p2.chess.fen() : '');
check('illegal token rejected', parseMoves('e2e4 e7e5 g1g3x').error !== undefined);
check('move numbers tolerated ("1. e4 e5 2. Nf3 Nc6")', !parseMoves('1. e4 e5 2. Nf3 Nc6').error);
const pc = parseMoves('e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 e1g1');
check('castling UCI -> O-O', !pc.error && pc.applied[6] && pc.applied[6].san === 'O-O', pc.error || (pc.applied[6] && pc.applied[6].san));
const mate = new Chess('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3');
check('game-over detection (fool\'s mate, no legal moves)', mate.moves().length === 0, String(mate.moves().length));
const pep = parseMoves('e2e4 d7d5 e4e5 f7f5 e5f6');
check('en passant UCI -> exf6', !pep.error && pep.applied[4] && pep.applied[4].san === 'exf6', pep.error || (pep.applied[4] && pep.applied[4].san));

// FEN input path (mirrors the app's parseInput)
const QGA = 'rnbqkbnr/ppp1pppp/8/8/2pP4/8/PP2PPPP/RNBQKBNR w KQkq - 0 3';
const pf = parseInput(QGA);
check('FEN input parses (QGA position, white to move)', !pf.error && pf.mode === 'fen' && pf.chess.turn() === 'w', pf.error || pf.chess.turn());
check('invalid FEN rejected', parseInput('not/a/real/fen/8/8/8/8 w - - 0 1').error !== undefined);
check('moves text rejected in FEN mode', parseInput('e2e4 e7e5', 'fen').error !== undefined);
check('moves still detected without FEN markers', parseInput('e2e4 e7e5 g1f3').mode === 'moves');
const resF = await ENGINES.chessdb.analyze(pf.chess.fen());
const mf = new Chess(pf.chess.fen()).move(uciObj(resF.uci));
check('FEN-mode: engine works on FEN position', !!mf, resF.uci + ' -> ' + (mf ? mf.san : 'ILLEGAL'));
const playFen = { chess: new Chess(QGA), mode: 'fen' };
const mvF = playFen.chess.move(uciObj(resF.uci));
check('FEN play-it: best move applies', !!mvF, mvF ? mvF.san : '');
check('FEN play-it: new FEN round-trips', !parseInput(playFen.chess.fen()).error, playFen.chess.fen());
check('valid FEN with ep square accepted', !parseInput('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1').error);
check('valid FEN with castling rights accepted', !parseInput('r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3').error);
check('rank sum mismatch rejected', parseInput('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPP/RNBQKBNR w KQkq - 0 1').error !== undefined);
check('empty-board FEN accepted', !parseInput('8/8/8/8/8/8/8/8 w - - 0 1').error);

// Live engines on the Italian position
const fen = p1.chess.fen();
const resC = await ENGINES.cloud.analyze(fen);
const mc = new Chess(fen).move(uciObj(resC.uci));
check('cloud: best move UCI + legal', !!resC.uci && !!mc, resC.uci + ' -> ' + (mc ? mc.san : 'ILLEGAL'));
check('cloud: numeric cp', typeof resC.cp === 'number', String(resC.cp));
check('cloud: deep depth', resC.depth > 20, 'depth ' + resC.depth);
check('cloud: pv[0] === best move', resC.pv[0] === resC.uci);
check('cloud: top-3 candidates (multiPv)', resC.candidates && resC.candidates.length >= 2 && resC.candidates[0].uci === resC.uci,
  JSON.stringify((resC.candidates || []).map((c) => c.uci + ':' + (c.cp != null ? fmtCp(c.cp) : '?'))));

const resA = await ENGINES.api.analyze(fen);
const ma = new Chess(fen).move(uciObj(resA.uci));
check('api: best move UCI + legal', !!resA.uci && !!ma, resA.uci + ' -> ' + (ma ? ma.san : 'ILLEGAL'));
check('api: depth present', !!resA.depth, 'depth ' + resA.depth);
// chess-api rejects FENs with an en-passant square; the engine must strip it and still answer
const EP_FEN = 'rnbqkbnr/ppp1pppp/8/3p4/2PP4/8/PP2PPPP/RNBQKBNR b KQkq c3 0 2';
const resAEp = await ENGINES.api.analyze(EP_FEN);
const maEp = new Chess(EP_FEN).move(uciObj(resAEp.uci));
check('api: ep-square FEN auto-fixed + legal', !!maEp && resAEp.note.indexOf('en-passant') !== -1, resAEp.uci + ' | ' + resAEp.note);

const resD = await ENGINES.chessdb.analyze(fen);
const md = new Chess(fen).move(uciObj(resD.uci));
check('chessdb: book rows returned', resD.allMoves.length >= 3, resD.allMoves.length + ' moves');
check('chessdb: best move legal', !!md, resD.uci);
check('chessdb: winrate numeric', typeof resD.winrate === 'number', String(resD.winrate));

// Error-mapping path: a malformed FEN must map to a friendly error (lichess
// answers 404 -> NO_CLOUD), never crash. (Note: Lichess cloud coverage is
// broad — even 1.h4 has an eval.)
try {
  await ENGINES.cloud.analyze('not-a-fen');
  check('cloud: bad request -> mapped error', false, 'no error thrown');
} catch (e) {
  check('cloud: bad request -> mapped error', e.code === 'HTTP' || e.code === 'NO_CLOUD', String(e.code));
}

// "Play it" round-trip — mirrors the app: parse the input, apply the best move
// on the SAME instance, then rebuild the UCI list from its history.
const p5 = parseMoves('e2e4 e7e5 g1f3 b8c6 f1c4');
const mv = p5.chess.move(uciObj(resC.uci));
check('play it: best move applies', !!mv, mv ? mv.san : '');
const hist = p5.chess.history({ verbose: true });
const uciList = hist.map((m) => m.from + m.to + (m.promotion || ''));
check('play it: history has all 6 moves', uciList.length === 6, uciList.join(' '));
const rep = parseMoves(uciList.join(' '));
check('play it: UCI round-trip parses (6 moves)', !rep.error && rep.applied.length === 6, rep.error || String(rep.applied.length));

const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
