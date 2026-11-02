/* ChessNext API core — the app's position parsing and the three free chess
   engines, normalised to plain JSON (no DOM).

   Used by api/worker.js (the deployable Cloudflare Worker) and by
   scripts/api-test.mjs. The move/FEN rules mirror index.html. */
import { Chess } from '../chess.min.js';

/* HTTP status per error code */
const STATUS = {
  BAD_REQUEST: 400, BAD_MOVES: 400, BAD_FEN: 400, UNKNOWN_ENGINE: 400,
  NO_LEGAL_MOVES: 409, NOT_IN_CLOUD: 404, NOT_IN_BOOK: 404,
  RATE_LIMITED: 429, TIMEOUT: 504, UPSTREAM: 502, METHOD: 405, NOT_FOUND: 404
};

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status || STATUS[code] || 500;
  }
}

export const ENGINE_NAMES = ['cloud', 'stockfish', 'book'];
export const ENGINE_LABELS = {
  cloud: 'Lichess Cloud Eval',
  stockfish: 'Live Stockfish (chess-api.com)',
  book: 'ChessDB.cn opening book'
};
const ENGINE_ALIASES = {
  cloud: 'cloud', lichess: 'cloud', 'cloud-eval': 'cloud',
  stockfish: 'stockfish', sf: 'stockfish', api: 'stockfish', live: 'stockfish',
  book: 'book', chessdb: 'book', opening: 'book', openingbook: 'book'
};
export const UPSTREAM = {
  cloud: 'https://lichess.org/api/cloud-eval',
  stockfish: 'https://chess-api.com/v1',
  book: 'https://www.chessdb.cn/cdb.php'
};
export const UPSTREAM_NOTES = {
  cloud: 'Lichess cloud Stockfish database (precomputed, instant, depth ~40–70)',
  stockfish: 'Live Stockfish run per request (any position, ~1–2 s)',
  book: 'ChessDB.cn win-rate opening book (openings only)'
};

export function normaliseEngine(name) {
  if (name == null || String(name).trim() === '') return 'cloud';
  const key = String(name).trim().toLowerCase();
  const hit = ENGINE_ALIASES[key];
  if (!hit) {
    throw new ApiError('UNKNOWN_ENGINE',
      `unknown engine "${name}" — use one of: ${ENGINE_NAMES.join(', ')}`);
  }
  return hit;
}

/* ---------------- FEN validation (identical rules to the app) ---------------- */
export function isValidFen(t) {
  const parts = String(t).trim().split(/\s+/);
  if (parts.length !== 6) return false;
  const ranks = parts[0].split('/');
  if (ranks.length !== 8) return false;
  for (const rank of ranks) {
    if (!rank || rank.length > 8) return false;
    let sum = 0, prevDigit = false;
    for (const ch of rank) {
      if (ch >= '1' && ch <= '8') {
        if (prevDigit) return false;
        sum += +ch; prevDigit = true;
      } else if ('pnbrqkPNBRQK'.includes(ch)) {
        sum += 1; prevDigit = false;
      } else return false;
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

/* ---------------- move parsing (UCI or SAN) ---------------- */
export function uciObj(u) {
  return { from: u.slice(0, 2), to: u.slice(2, 4), promotion: u.length > 4 ? u[4].toLowerCase() : undefined };
}
function tryMove(chess, tok) {
  const isUci = /^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(tok);
  if (isUci) return chess.move(uciObj(tok));
  try { return chess.move(tok); } catch { return null; }
}
export function parseMoves(text) {
  const tokens = String(text || '').trim().split(/\s+/).filter(Boolean);
  const chess = new Chess();
  const applied = [];
  for (const tok of tokens) {
    if (/^\d+\.\.?$/.test(tok)) continue;          // "1." / "1..."
    if (tok.length > 10) return { error: `"${tok.slice(0, 20)}" is not a move.` };
    const mv = tryMove(chess, tok);
    if (!mv) return { error: `"${tok}" is not a legal move from this position.` };
    applied.push({ from: mv.from, to: mv.to, san: mv.san, uci: mv.from + mv.to + (mv.promotion || '') });
  }
  return { chess, applied };
}

/* ---------------- position input: moves or FEN ---------------- */
/* Accepts {moves} or {fen} (or a single string, auto-detected: '/' => FEN). */
export function parsePosition(input) {
  const q = typeof input === 'string' ? { moves: input } : (input || {});
  const fenRaw = typeof q.fen === 'string' ? q.fen.trim() : '';
  const movesRaw = typeof q.moves === 'string' ? q.moves.trim() : '';
  if (fenRaw) {
    if (!isValidFen(fenRaw)) {
      throw new ApiError('BAD_FEN',
        'not a valid FEN — expected 6 fields: pieces, side to move, castling, en passant, halfmove, fullmove');
    }
    return { chess: new Chess(fenRaw), mode: 'fen', applied: [], movesUci: [], movesSan: [], input };
  }
  if (movesRaw && movesRaw.includes('/')) {
    // '/'-bearing input is a FEN pasted into the moves slot
    return parsePosition({ fen: movesRaw });
  }
  const parsed = parseMoves(movesRaw);
  if (parsed.error) throw new ApiError('BAD_MOVES', parsed.error);
  return {
    chess: parsed.chess, mode: movesRaw ? 'moves' : 'start', applied: parsed.applied,
    movesUci: parsed.applied.map((m) => m.uci),
    movesSan: parsed.applied.map((m) => m.san),
    input
  };
}

/* ---------------- shared fetch helper ---------------- */
async function jfetch(url, opts, timeoutMs = 9000) {
  let r;
  try {
    r = await fetch(url, Object.assign({ signal: AbortSignal.timeout(timeoutMs) }, opts || {}));
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new ApiError(timedOut ? 'TIMEOUT' : 'UPSTREAM',
      timedOut ? 'the upstream chess service did not answer in time' : 'could not reach the upstream chess service');
  }
  return r;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- engines: FEN -> raw analysis ---------------- */
async function cloudAnalyse(fen) {
  const r = await jfetch(`${UPSTREAM.cloud}?fen=${encodeURIComponent(fen)}&multiPv=3`);
  if (r.status === 404) {
    throw new ApiError('NOT_IN_CLOUD',
      'this position is not in the Lichess cloud database — retry with engine=stockfish, which works for any position');
  }
  if (r.status === 429) throw new ApiError('RATE_LIMITED', 'Lichess rate limit hit — retry in a few seconds');
  if (!r.ok) throw new ApiError('UPSTREAM', 'Lichess returned HTTP ' + r.status);
  const j = await r.json();
  const all = j.pvs || [];
  const pv0 = all[0];
  if (!pv0 || !pv0.moves) throw new ApiError('NOT_IN_CLOUD', 'Lichess returned no evaluation for this position');
  const split = (s) => String(s || '').trim().split(/\s+/).filter(Boolean);
  const candidates = all.slice(0, 3).map((pv) => ({
    uci: split(pv.moves)[0] || null,
    cp: typeof pv.cp === 'number' ? pv.cp : null,
    mate: typeof pv.mate === 'number' ? pv.mate : null
  })).filter((c) => c.uci);
  return {
    uci: split(pv0.moves)[0],
    cp: typeof pv0.cp === 'number' ? pv0.cp : null,
    mate: typeof pv0.mate === 'number' ? pv0.mate : null,
    depth: j.depth || null, knodes: j.knodes || null,
    winPercent: typeof pv0.winPercent === 'number' ? pv0.winPercent : null,
    pv: split(pv0.moves), candidates
  };
}

async function stockfishAnalyse(fen) {
  let last = null, fenToSend = fen, epStripped = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await jfetch(UPSTREAM.stockfish, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fen: fenToSend })
      }, 12000);
      if (!r.ok) throw new ApiError('UPSTREAM', 'chess-api.com returned HTTP ' + r.status);
      const j = await r.json();
      if (j.move) {
        return {
          uci: j.move,
          cp: typeof j.centipawns === 'number' ? j.centipawns : null,
          mate: typeof j.mate === 'number' ? j.mate : null,
          depth: j.depth || null, knodes: null,
          winPercent: null,
          pv: Array.isArray(j.continuationArr) ? j.continuationArr : [],
          epStripped
        };
      }
      // their parser rejects FENs carrying an en-passant square — strip it, retry once
      if (!epStripped) {
        const parts = fenToSend.split(/\s+/);
        if (parts.length === 6 && parts[3] !== '-') {
          parts[3] = '-';
          fenToSend = parts.join(' ');
          epStripped = true;
          last = new ApiError('UPSTREAM', 'chess-api.com rejected the position (en-passant square stripped, retrying)');
          continue;
        }
      }
      last = new ApiError('UPSTREAM', 'chess-api.com returned no move for this position');
    } catch (e) {
      last = e;
    }
    if (attempt < 2) await sleep(1500);
  }
  throw last || new ApiError('UPSTREAM', 'chess-api.com failed');
}

async function bookAnalyse(fen) {
  const r = await jfetch(`${UPSTREAM.book}?action=queryall&board=${encodeURIComponent(fen)}`);
  if (!r.ok) throw new ApiError('UPSTREAM', 'chessdb.cn returned HTTP ' + r.status);
  const t = await r.text();
  if (!t || !t.includes('move:')) {
    throw new ApiError('NOT_IN_BOOK', 'this position is not in the ChessDB opening book — retry with engine=cloud or engine=stockfish');
  }
  const rows = t.split('|').map((seg) => {
    const kv = {};
    seg.split(',').forEach((pair) => {
      const i = pair.indexOf(':');
      if (i > 0) kv[pair.slice(0, i)] = pair.slice(i + 1);
    });
    return kv;
  }).filter((x) => x.move);
  if (!rows.length) throw new ApiError('NOT_IN_BOOK', 'the ChessDB book has no moves for this position');
  const rankOf = (m) => parseInt(m.rank, 10) || 0;
  const wrOf = (m) => parseFloat(m.winrate) || 0;
  const best = rows.slice().sort((a, b) => (rankOf(b) - rankOf(a)) || (wrOf(b) - wrOf(a)))[0];
  return {
    uci: best.move, cp: null, mate: null, depth: null, winPercent: null, pv: [],
    winrate: wrOf(best),
    book: rows.map((m) => ({ uci: m.move, winrate: wrOf(m), rank: rankOf(m) }))
      .sort((a, b) => (b.rank - a.rank) || (b.winrate - a.winrate))
  };
}

const ANALYSERS = { cloud: cloudAnalyse, stockfish: stockfishAnalyse, book: bookAnalyse };

/* ---------------- UCI -> SAN helpers ---------------- */
export function sanOf(fen, uci) {
  try {
    const c = new Chess(fen);
    const m = c.move(uciObj(uci));
    return m ? m.san : null;
  } catch { return null; }
}
export function sanList(fen, uciList) {
  const c = new Chess(fen);
  const out = [];
  for (const u of uciList || []) {
    let m = null;
    try { m = c.move(uciObj(u)); } catch { m = null; }
    if (!m) break;
    out.push(m.san);
  }
  return out;
}
export function fenAfter(fen, uci) {
  try {
    const c = new Chess(fen);
    const m = c.move(uciObj(uci));
    return m ? c.fen() : null;
  } catch { return null; }
}

/* ---------------- the one call the API exposes ---------------- */
export async function analyse({ moves, fen, engine } = {}) {
  const engineId = normaliseEngine(engine);
  const started = Date.now();
  const pos = parsePosition({ moves, fen });
  const startFen = pos.chess.fen();
  if (pos.chess.moves().length === 0) {
    const e = new ApiError('NO_LEGAL_MOVES', 'the game is over in this position — there is no move to suggest');
    e.position = { fen: startFen };
    throw e;
  }
  const raw = await ANALYSERS[engineId](startFen);
  const san = sanOf(startFen, raw.uci);
  if (!san) {
    throw new ApiError('UPSTREAM', `the ${engineId} engine answered with an illegal move (${raw.uci})`);
  }
  const pvUci = (raw.pv || []).filter(Boolean);
  const out = {
    fen: startFen,
    turn: pos.chess.turn(),
    input_mode: pos.mode,
    moves_uci: pos.movesUci,
    moves_san: pos.movesSan,
    engine: engineId,
    engine_label: ENGINE_LABELS[engineId],
    source: UPSTREAM_NOTES[engineId],
    bestmove: { uci: raw.uci, san },
    fen_after: fenAfter(startFen, raw.uci),
    eval: {
      cp: raw.cp != null ? raw.cp : null,
      mate: raw.mate != null ? raw.mate : null,
      depth: raw.depth != null ? raw.depth : null,
      nodes: raw.knodes != null ? raw.knodes : null,
      winPercent: raw.winPercent != null ? raw.winPercent : null,
      perspective: raw.cp != null || raw.mate != null ? 'white' : null,
      winrate_book: raw.winrate != null ? raw.winrate : null
    },
    pv: { uci: pvUci, san: sanList(startFen, pvUci) }
  };
  if (raw.candidates && raw.candidates.length) {
    out.candidates = raw.candidates.map((c) => ({
      uci: c.uci, san: sanOf(startFen, c.uci), cp: c.cp, mate: c.mate
    }));
  }
  if (raw.book && raw.book.length) {
    out.book = raw.book.map((b) => ({
      uci: b.uci, san: sanOf(startFen, b.uci), winrate: b.winrate, rank: b.rank
    }));
  }
  out.elapsed_ms = Date.now() - started;
  return out;
}

/* ---------------- self-documenting index ---------------- */
export function help(base) {
  const b = (base || '').replace(/\/$/, '');
  return {
    ok: true,
    service: 'ChessNext API',
    version: '1.0.0',
    about: 'Turn chess moves or a FEN into FEN / best next move, as JSON. Free, keyless, no storage.',
    engines: ENGINE_NAMES.map((e) => ({ id: e, label: ENGINE_LABELS[e], source: UPSTREAM[e], notes: UPSTREAM_NOTES[e], default: e === 'cloud' })),
    endpoints: [
      { method: 'GET', path: '/analyze', params: '?moves=e2e4 e7e5 | ?fen=<fen> [&engine=cloud|stockfish|book]', example: `${b}/analyze?moves=e2e4%20e7e5&engine=cloud` },
      { method: 'POST', path: '/analyze', body: '{"moves":"e2e4 e7e5"} or {"fen":"...","engine":"stockfish"} or plain text "e2e4 e7e5"', example: `curl -s -X POST ${b}/analyze -H 'content-type: application/json' -d '{"moves":"e2e4 e7e5"}'` },
      { method: 'GET', path: '/health', params: '', example: `${b}/health` }
    ],
    aliases: { lichess: 'cloud', api: 'stockfish', sf: 'stockfish', chessdb: 'book', p: 'moves (query alias)', position: 'moves (query alias)' },
    response: {
      bestmove: '{ "uci": "g1f3", "san": "Nf3" }',
      eval: '{ "cp": 25, "mate": null, "depth": 57, "winPercent": 51.4, "perspective": "white" }',
      pv: '{ "uci": [...], "san": [...] }',
      extra: 'candidates (cloud top-3), book (book win rates), fen_after, moves_uci, moves_san'
    },
    errors: 'JSON: { "ok": false, "error": { "code": "BAD_MOVES", "message": "..." } } — codes: BAD_REQUEST, BAD_MOVES, BAD_FEN, UNKNOWN_ENGINE, NO_LEGAL_MOVES, NOT_IN_CLOUD, NOT_IN_BOOK, RATE_LIMITED, TIMEOUT, UPSTREAM',
    web_app: 'https://hermes31415.github.io/ChessNextMove/'
  };
}
