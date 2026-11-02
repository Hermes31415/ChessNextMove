// End-to-end test for the ChessNext JSON API (api/worker.js).
//
// Runs the BUILT worker bundle (api/dist/worker.mjs) — the exact artifact that
// gets deployed to Cloudflare — in plain Node:
//   * directly, via worker.fetch(new Request(...))  (unit-ish, gives us env control)
//   * through a real http.createServer bridge (proves it answers over HTTP)
// and hits the REAL free chess services, so a pass means the API genuinely works.
//
// Run: node scripts/api-test.mjs   (needs `npm run build:api` first — npm test does it)
import http from 'node:http';
import { Chess } from '../chess.min.js';

const worker = (await import(new URL('../api/dist/worker.mjs', import.meta.url))).default;

const ORIGIN = 'http://api.test';
const results = [];
function check(name, cond, extra) {
  results.push(!!cond);
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (extra !== undefined ? ' :: ' + extra : ''));
}
const uciObj = (u) => ({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u.length > 4 ? u[4].toLowerCase() : undefined });
const legal = (fen, uci) => { try { return !!new Chess(fen).move(uciObj(uci)); } catch { return false; } };
const sanOf = (fen, uci) => { try { const m = new Chess(fen).move(uciObj(uci)); return m ? m.san : null; } catch { return null; } };
const qs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null)
  .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

/* --- call the worker in-process, with per-call env + caller IP --- */
async function call(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: Object.assign({}, opts.headers) };
  if (opts.ip) init.headers['cf-connecting-ip'] = opts.ip;
  if (opts.body !== undefined) init.body = opts.body;
  const res = await worker.fetch(new Request(ORIGIN + path, init), opts.env || {},
    { waitUntil: (p) => Promise.resolve(p).catch(() => {}) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, h: res.headers, text, json };
}

const ITALIAN = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';
const QGA = 'rnbqkbnr/ppp1pppp/8/8/2pP4/8/PP2PPPP/RNBQKBNR w KQkq - 0 3';
const KINGS = '8/8/8/8/8/8/8/K6k w - - 0 1';                 // not in Lichess cloud (404)
const FOOLS_MATE = 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3';

/* ---------------- 1. index / health / CORS ---------------- */
{
  const r = await call('/');
  check('GET / -> API index (JSON, self-documenting)',
    r.status === 200 && r.json && r.json.ok === true && Array.isArray(r.json.endpoints) && r.json.engines.length === 3,
    r.json && r.json.service);
  check('GET / -> CORS * (browser callable from any origin)', r.h.get('access-control-allow-origin') === '*', String(r.h.get('access-control-allow-origin')));

  const h = await call('/health');
  check('GET /health -> ok', h.status === 200 && h.json.ok === true, h.json && h.json.version);

  const o = await call('/analyze', { method: 'OPTIONS' });
  check('OPTIONS preflight -> 204 + methods', o.status === 204 && /POST/.test(o.h.get('access-control-allow-methods') || ''),
    o.status + ' ' + o.h.get('access-control-allow-methods'));
}

/* ---------------- 2. GET /analyze (cloud) ---------------- */
{
  const r = await call('/analyze?' + qs({ moves: 'e2e4 e7e5 g1f3 b8c6 f1c4', engine: 'cloud' }));
  const j = r.json || {};
  const bm = j.bestmove || {};
  check('GET /analyze (moves, cloud) -> 200', r.status === 200 && j.ok !== false, r.status + ' ' + (j.error && j.error.code));
  check('GET: moves -> FEN (Italian)', j.fen === ITALIAN, j.fen);
  check('GET: moves echoed as SAN', JSON.stringify(j.moves_san) === JSON.stringify(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']), JSON.stringify(j.moves_san));
  check('GET: side to move = b', j.turn === 'b', j.turn);
  check('GET: bestmove UCI is legal + SAN matches', !!bm.uci && legal(j.fen, bm.uci) && bm.san === sanOf(j.fen, bm.uci), bm.uci + ' -> ' + bm.san);
  check('GET: deep cloud eval (depth > 20)', j.eval && j.eval.depth > 20, 'depth ' + (j.eval && j.eval.depth));
  check('GET: numeric cp (white perspective)', j.eval && typeof j.eval.cp === 'number' && j.eval.perspective === 'white', j.eval && j.eval.cp);
  check('GET: pv[0] === bestmove', j.pv && j.pv.uci[0] === bm.uci && j.pv.san[0] === bm.san, j.pv && j.pv.uci.slice(0, 4).join(' '));
  check('GET: candidates (cloud top-3)', Array.isArray(j.candidates) && j.candidates.length >= 2 && j.candidates[0].uci === bm.uci,
    JSON.stringify((j.candidates || []).map((c) => c.uci + ':' + (c.cp != null ? c.cp : '?'))));
  check('GET: fen_after is the position after the best move', !!j.fen_after && (() => {
    const c = new Chess(j.fen); c.move(uciObj(bm.uci));
    return c.fen() === j.fen_after;
  })(), j.fen_after);
  check('GET: cache status header present (CF edge cache)', ['HIT', 'MISS', 'BYPASS'].includes(r.h.get('x-cache')), String(r.h.get('x-cache')));
  check('GET: rate-limit headers present', r.h.get('x-ratelimit-limit') === '60', String(r.h.get('x-ratelimit-limit')));
  check('GET: elapsed_ms reported', typeof j.elapsed_ms === 'number', j.elapsed_ms + ' ms');
}

/* aliases + FEN input */
{
  const a = await call('/analyze?' + qs({ p: 'e2e4 e7e5 g1f3 b8c6 f1c4', engine: 'lichess' }));
  check('alias p= + engine=lichess -> resolved to cloud', a.status === 200 && a.json.engine === 'cloud' && legal(a.json.fen, a.json.bestmove.uci),
    (a.json && a.json.engine) + ' ' + (a.json.bestmove && a.json.bestmove.uci));

  const f = await call('/analyze?' + qs({ fen: QGA, engine: 'stockfish' }));
  check('GET /analyze?fen= + engine=stockfish (live Stockfish) -> legal best move',
    f.status === 200 && f.json.input_mode === 'fen' && legal(f.json.fen, f.json.bestmove.uci),
    (f.json.bestmove && f.json.bestmove.uci + ' -> ' + f.json.bestmove.san) + ' | ' + (f.json.error && f.json.error.code));
  check('stockfish: depth present', f.json.eval && !!f.json.eval.depth, 'depth ' + (f.json.eval && f.json.eval.depth));

  const fenIn = await call('/analyze?' + qs({ moves: QGA, engine: 'cloud' }));   // FEN pasted into moves
  check('FEN pasted into ?moves= auto-detected', fenIn.status === 200 && fenIn.json.input_mode === 'fen', fenIn.json.input_mode);
}

/* ---------------- 3. POST /analyze (the point of the exercise) ---------------- */
{
  const j1 = await call('/analyze', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ moves: 'd2d4 d7d5 c2c4', engine: 'book' })
  });
  check('POST /analyze JSON (book engine) -> 200', j1.status === 200 && j1.json.ok !== false, j1.status + ' ' + (j1.json.error && j1.json.error.code));
  check('POST: opening book rows with win rates', Array.isArray(j1.json.book) && j1.json.book.length >= 3 && typeof j1.json.book[0].winrate === 'number',
    (j1.json.book || []).slice(0, 3).map((b) => b.uci + ' ' + b.winrate + '%').join(', '));
  check('POST: book best move legal + SAN', legal(j1.json.fen, j1.json.bestmove.uci) && !!j1.json.bestmove.san,
    j1.json.bestmove.uci + ' -> ' + j1.json.bestmove.san);

  const j2 = await call('/analyze', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'e2e4 e7e5' });
  check('POST text/plain body ("e2e4 e7e5") -> parsed', j2.status === 200 && JSON.stringify(j2.json.moves_san) === JSON.stringify(['e4', 'e5']),
    JSON.stringify(j2.json.moves_san) + ' | ' + (j2.json.error && j2.json.error.code));

  const j3 = await call('/analyze', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: qs({ fen: QGA, engine: 'chessdb' })
  });
  check('POST form-urlencoded body -> parsed (chessdb -> book)', j3.status === 200 && j3.json.engine === 'book', String(j3.json.engine));

  const j4 = await call('/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
  check('POST invalid JSON -> 400 BAD_REQUEST', j4.status === 400 && j4.json.error.code === 'BAD_REQUEST', j4.json.error && j4.json.error.message);
}

/* ---------------- 4. real HTTP server round trip ---------------- */
{
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const init = {
      method: req.method,
      headers: { 'content-type': req.headers['content-type'] || 'text/plain', origin: req.headers.origin || '' }
    };
    if (req.method !== 'GET' && req.method !== 'HEAD' && body.length) init.body = body;
    try {
      const out = await worker.fetch(new Request(ORIGIN + req.url, init), {}, { waitUntil() {} });
      res.writeHead(out.status, Object.fromEntries(out.headers.entries()));
      res.end(Buffer.from(await out.arrayBuffer()));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ bridge: 'error', message: String(e) }));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const g = await fetch(base + '/analyze?' + qs({ moves: 'd2d4 d7d5 c2c4', engine: 'book' }));
  const gj = await g.json();
  check('over real HTTP: GET /analyze returns JSON best move',
    g.status === 200 && gj.ok !== false && legal(gj.fen, gj.bestmove.uci),
    gj.bestmove && (gj.bestmove.uci + ' -> ' + gj.bestmove.san));

  const p = await fetch(base + '/analyze', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ moves: 'e2e4 e7e5 g1f3 b8c6 f1c4', engine: 'cloud' })
  });
  const pj = await p.json();
  check('over real HTTP: POST /analyze (JSON) returns analysis',
    p.status === 200 && pj.fen === ITALIAN && legal(pj.fen, pj.bestmove.uci),
    pj.fen + ' | ' + (pj.bestmove && pj.bestmove.uci));

  await new Promise((r) => server.close(r));
  check('http bridge closed', true, base);
}

/* ---------------- 5. error paths ---------------- */
{
  const bad = await call('/analyze?' + qs({ moves: 'e2e4 e7e5 g1g3' }));
  check('illegal move -> 400 BAD_MOVES (with the offending token)', bad.status === 400 && bad.json.error.code === 'BAD_MOVES' && /g1g3/.test(bad.json.error.message),
    bad.json.error && bad.json.error.message);

  const badFen = await call('/analyze?' + qs({ fen: 'rubbish/x w - - 0 1' }));
  check('malformed FEN -> 400 BAD_FEN', badFen.status === 400 && badFen.json.error.code === 'BAD_FEN', badFen.json.error && badFen.error);

  const empty = await call('/analyze');
  check('no position -> 400 BAD_REQUEST with a hint', empty.status === 400 && empty.json.error.code === 'BAD_REQUEST' && /moves=|fen=/.test(empty.json.error.message),
    empty.json.error && empty.json.error.message);

  const eng = await call('/analyze?' + qs({ moves: 'e2e4', engine: 'hal9000' }));
  check('unknown engine -> 400 UNKNOWN_ENGINE (lists valid ones)', eng.status === 400 && eng.json.error.code === 'UNKNOWN_ENGINE' && /cloud/.test(eng.json.error.message),
    eng.json.error && eng.json.error.message);

  const miss = await call('/analyze?' + qs({ fen: KINGS, engine: 'cloud' }));
  check('position outside the cloud DB -> 404 NOT_IN_CLOUD (suggests stockfish)', miss.status === 404 && miss.json.error.code === 'NOT_IN_CLOUD',
    miss.json.error && miss.json.error.code);

  const over = await call('/analyze?' + qs({ fen: FOOLS_MATE, engine: 'cloud' }));
  check('game already over -> 409 NO_LEGAL_MOVES (+ position echoed)', over.status === 409 && over.json.error.code === 'NO_LEGAL_MOVES' && !!over.json.position.fen,
    over.json.error && over.json.error.code);

  const nf = await call('/nope');
  check('unknown path -> 404 NOT_FOUND (points at /)', nf.status === 404 && nf.json.error.code === 'NOT_FOUND' && /GET \//.test(nf.json.error.message),
    nf.json.error && nf.json.error.message);

  const m = await call('/analyze', { method: 'PUT' });
  check('PUT /analyze -> 405 METHOD', m.status === 405 && m.json.error.code === 'METHOD', m.json.error && m.json.error.message);

  const long = await call('/analyze?' + qs({ moves: 'e2e4 '.repeat(200) }));
  check('oversized input -> 400 BAD_REQUEST', long.status === 400 && long.json.error.code === 'BAD_REQUEST', long.json.error && long.json.error.message);
}

/* ---------------- 6. pretty + rate limiting ---------------- */
{
  const pr = await call('/analyze?' + qs({ moves: 'e2e4 e7e5', engine: 'cloud', pretty: '1' }));
  check('pretty=1 -> indented JSON', pr.status === 200 && /\n {2}"/.test(pr.text), pr.text.split('\n').length + ' lines');

  const env = { RATE_LIMIT: 3 };
  let last = null;
  for (let i = 0; i < 4; i++) last = await call('/health', { env, ip: '9.9.9.9' });
  check('rate limit: 4th request in the window -> 429 RATE_LIMITED (+ retry-after)',
    last.status === 429 && last.json.error.code === 'RATE_LIMITED' && !!last.h.get('retry-after'),
    last.status + ' retry-after=' + last.h.get('retry-after'));
  const other = await call('/health', { env, ip: '8.8.8.8' });
  check('rate limit is per caller IP (other IP still 200)', other.status === 200, String(other.status));
}

const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
