/* ChessNext API — a small Cloudflare Worker (free tier) that turns chess moves
   or a FEN into FEN / best-next-move JSON.

   Why a Worker at all: GitHub Pages is static-only, so the site can serve
   deep links (?moves=…) but can never answer a POST. This file is that missing
   server half — free, keyless, no storage, no accounts for callers.

     GET  /                       -> this API index (JSON)
     GET  /health                 -> liveness
     GET  /analyze?moves=…&engine=… -> analysis
     POST /analyze  {moves|fen, engine} -> analysis (JSON, form or plain text)

   Build the bundle before deploying:  npm run build:api  (esbuild -> api/dist)
   Deploy:                             npx wrangler deploy
*/
import { analyse, help, ApiError, ENGINE_NAMES } from './core.js';

const VERSION = '1.0.0';
const WINDOW_MS = 60_000;
const DEFAULT_LIMIT = 60;          // requests per IP per minute (env.RATE_LIMIT overrides)
const CACHE_TTL_S = 60;            // edge cache for identical GET analyses
const MAX_INPUT = 500;             // chars accepted for moves / fen

/* best-effort per-isolate token bucket — real protection is Cloudflare's own
   DDoS/rate limiting, this just stops a single caller hammering upstreams */
const buckets = new Map();

function rateLimit(ip, limit) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.start > WINDOW_MS) { b = { start: now, count: 0 }; buckets.set(ip, b); }
  b.count++;
  if (buckets.size > 5000) buckets.clear();      // bound memory
  const remaining = Math.max(0, limit - b.count);
  return { ok: b.count <= limit, remaining, resetIn: Math.ceil((b.start + WINDOW_MS - now) / 1000) };
}

function cors(extra) {
  return Object.assign({
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type',
    'access-control-max-age': '86400'
  }, extra || {});
}

function json(body, status, extra) {
  return new Response(JSON.stringify(body, null, extra && extra.pretty ? 2 : 0), {
    status: status || 200,
    headers: cors(Object.assign({ 'content-type': 'application/json; charset=utf-8' }, (extra && extra.headers) || {}))
  });
}

const isTruthy = (v) => v === '1' || v === 'true' || v === 'yes';

function clientIp(request) {
  return request.headers.get('cf-connecting-ip')
    || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim()
    || 'anonymous';
}

async function readBody(request) {
  const raw = (await request.text()).slice(0, MAX_INPUT * 2);
  if (!raw.trim()) return {};
  const ct = (request.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('json')) {
    try { return JSON.parse(raw); }
    catch { throw new ApiError('BAD_REQUEST', 'request body is not valid JSON'); }
  }
  if (ct.includes('form-urlencoded')) {
    const p = new URLSearchParams(raw);
    return { moves: p.get('moves') || p.get('p') || p.get('position') || '', fen: p.get('fen') || '', engine: p.get('engine') || '', pretty: p.get('pretty') || '' };
  }
  return { moves: raw.trim() };     // text/plain: curl --data 'e2e4 e7e5'
}

function paramsFromUrl(url) {
  const q = url.searchParams;
  return {
    moves: q.get('moves') || q.get('p') || q.get('position') || '',
    fen: q.get('fen') || '',
    engine: q.get('engine') || '',
    pretty: isTruthy(q.get('pretty'))
  };
}

function validateInput(p) {
  const moves = String(p.moves || '').trim();
  const fen = String(p.fen || '').trim();
  if (moves.length > MAX_INPUT) throw new ApiError('BAD_REQUEST', `moves is too long (max ${MAX_INPUT} characters)`);
  if (fen.length > 120) throw new ApiError('BAD_REQUEST', 'fen is too long (max 120 characters)');
  if (p.engine != null && String(p.engine).length > 40) throw new ApiError('UNKNOWN_ENGINE', `unknown engine — use one of: ${ENGINE_NAMES.join(', ')}`);
  if (!moves && !fen) throw new ApiError('BAD_REQUEST', 'pass a position: moves=e2e4 e7e5 (UCI or SAN) or fen=<FEN>');
  return { moves, fen, engine: p.engine };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const envObj = env || {};
    const limit = Number(envObj.RATE_LIMIT) > 0 ? Number(envObj.RATE_LIMIT) : DEFAULT_LIMIT;

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });

    const rl = rateLimit(clientIp(request), limit);
    const rlHeaders = {
      'x-ratelimit-limit': String(limit),
      'x-ratelimit-remaining': String(rl.remaining)
    };
    if (!rl.ok) {
      return json({
        ok: false,
        error: { code: 'RATE_LIMITED', message: `too many requests — max ${limit} per minute, retry in ${rl.resetIn}s` }
      }, 429, { headers: Object.assign({ 'retry-after': String(rl.resetIn), 'cache-control': 'no-store' }, rlHeaders) });
    }

    try {
      if (path === '/') {
        return json(help(url.origin), 200, { headers: Object.assign({ 'cache-control': 'public, max-age=300' }, rlHeaders) });
      }
      if (path === '/health') {
        return json({ ok: true, service: 'ChessNext API', version: VERSION, time: new Date().toISOString() },
          200, { headers: Object.assign({ 'cache-control': 'no-store' }, rlHeaders) });
      }
      if (path !== '/analyze') {
        throw new ApiError('NOT_FOUND', `unknown endpoint ${url.pathname} — GET / lists what this API offers`);
      }

      if (request.method === 'GET') {
        const p = paramsFromUrl(url);
        const input = validateInput(p);
        const pretty = p.pretty;
        const cacheKeyUrl = new Request(`${url.origin}/analyze?moves=${encodeURIComponent(input.moves)}&fen=${encodeURIComponent(input.fen)}&engine=${encodeURIComponent(input.engine || '')}`);
        const cache = (typeof caches !== 'undefined' && caches.default) ? caches.default : null;
        if (cache) {
          const hit = await cache.match(cacheKeyUrl);
          if (hit) {
            const body = await hit.text();
            return new Response(pretty ? JSON.stringify(JSON.parse(body), null, 2) : body, {
              status: 200,
              headers: cors(Object.assign({ 'content-type': 'application/json; charset=utf-8', 'x-cache': 'HIT' }, rlHeaders))
            });
          }
        }
        const out = await analyse(input);
        const body = JSON.stringify(out, null, pretty ? 2 : 0);
        if (cache && ctx && typeof ctx.waitUntil === 'function') {
          ctx.waitUntil(cache.put(cacheKeyUrl, new Response(body, {
            headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${CACHE_TTL_S}` }
          })));
        }
        return new Response(body, {
          status: 200,
          headers: cors(Object.assign({
            'content-type': 'application/json; charset=utf-8',
            'cache-control': `public, max-age=${CACHE_TTL_S}`,
            'x-cache': cache ? 'MISS' : 'BYPASS'
          }, rlHeaders))
        });
      }

      if (request.method === 'POST') {
        const body = await readBody(request);
        const input = validateInput({
          moves: body.moves != null ? body.moves : (body.pgn != null ? body.pgn : ''),
          fen: body.fen != null ? body.fen : '',
          engine: body.engine != null ? body.engine : ''
        });
        const out = await analyse(input);
        return json(out, 200, { pretty: isTruthy(body.pretty), headers: Object.assign({ 'cache-control': 'no-store' }, rlHeaders) });
      }

      throw new ApiError('METHOD', `${request.method} is not allowed here — use GET or POST`);
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError('UPSTREAM', (e && e.message) || 'unexpected error');
      const payload = { ok: false, error: { code: err.code, message: err.message } };
      if (e && e.position) payload.position = e.position;
      const headers = Object.assign({ 'cache-control': 'no-store' }, rlHeaders);
      if (err.code === 'RATE_LIMITED') headers['retry-after'] = '5';
      return json(payload, err.status, { headers });
    }
  }
};
