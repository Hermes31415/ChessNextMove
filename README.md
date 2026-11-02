# ChessNext — next best move

**Live: <https://hermes31415.github.io/ChessNextMove/>** (GitHub Pages)

A tiny, keyless web app: type your first 2–3 chess moves (UCI or SAN) and get the
**next best move in UCI** — plus evaluation, follow-up line, and an interactive board —
from free public chess APIs. No server, no sign-up, no storage: requests go straight
from your browser to the chess services.

## Run it

```bash
cd ~/Documents/ChessNextMove
python3 -m http.server 8123
# open http://localhost:8123
```

Or just double-click `index.html` (the only caveat: a few browsers restrict
`fetch` from `file://` — the http server is the reliable way).

## How the "jumps" work

There is no API that takes "e2e4 e7e5 g1f3" and directly answers "g1f3" — but it takes
only one small hop plus an engine call:

1. **UCI → FEN** — the move list is applied on a `Chess` instance
   (`chess.min.js`, chess.js v0.13.4, MIT, vendored locally). SAN input works too.
2. **FEN → best move (UCI)** — the chosen engine answers. The first move of the
   returned principal variation *is* the next best move in UCI.

## The engines (selectable in the app menu)

| Option | What it is | Why | Notes |
|---|---|---|---|
| **Lichess Cloud Eval** (default, recommended) | Lichess' free cloud database of precomputed Stockfish evals (`lichess.org/api/cloud-eval?fen=…`) | Instant (~50–100 ms), **depth ~55–70**, no key, CORS-enabled, returns the full PV so you get the best move **and** the follow-up line | Eval is White-perspective; coverage is broad (even 1.h4 has an eval) but not every middlegame position |
| **Live Stockfish (chess-api.com)** | A real Stockfish instance runs per request (`POST chess-api.com/v1`) | Works for **any** position — no database coverage requirement; depth 12 in ~1–2 s | Free, no key, CORS `*`; slightly shallow, so its top move can differ from the cloud's on close calls. Two free-tier quirks handled by the app: rapid clicks may hit rate limits (auto-retried), and its parser rejects FENs carrying an en-passant square — the app strips it for this engine and says so in the result |
| **ChessDB.cn opening book** | Win-rate opening database (`cdb.php?action=queryall`) | Instant, gives a ranked list of book moves with win rates — the "what masters actually play" answer for the opening | Book only; near-equal moves can tie on win rate |

The Lichess opening explorer (`explorer.lichess.ovh`) would have been the zero-jump
answer (it accepts UCI directly, no FEN), but it is **auth-gated now — returns 401**,
so it was dropped.

## App features

- Input accepts **UCI** (`e2e4 e7e5 g1f3`), **SAN** (`e4 e5 Nf3`), and PGN-ish
  move numbers (`1. e4 e5 2. Nf3`) — validated move by move.
- **FEN input** — paste the FEN of your current game position instead of moves:
  the app auto-detects it (Moves | FEN toggle above the input, placeholder and
  examples adapt), validates all 6 FEN fields, and runs the same analysis.
- Instant result: best move as **SAN + UCI**, eval (White-perspective), depth/nodes,
  follow-up PV chips, and the recommended move highlighted on the board.
- **Top-3 moves** (Lichess Cloud Eval): the three best candidate moves with their
  evals, best one highlighted.
- **FEN after this move** viewer in the result card — the exact FEN of the position
  after the best move is applied (with its own Copy button), plus Copy FEN for the
  current position.
- **Open in Lichess ↗** — one click opens the current position (board header) or the
  after-move position (result card) in lichess.org/analysis; **Copy PV (UCI)** copies
  the full engine line for pasting into engines/tools.
- **Play it →** appends the best move and re-analyzes — in FEN mode the input
  advances to the new FEN (auto-play through the line).
- Flip board, copy FEN, engine switching (results cached per position), last
  selection + moves persisted in `localStorage`.
- Friendly error mapping: cloud-DB misses (404), rate limits (429), book misses,
  network errors — each with a hint on what to do.
- **PWA**: installable to iPhone/desktop home screens (manifest + icons + service
  worker); app shell works offline.
- Dark, chess-themed, responsive (verified at 390px mobile), keyboard-friendly
  (Enter to analyze).

## URL API — send a position in the URL (GET, works on GitHub Pages)

GitHub Pages is static hosting: the page itself cannot run server code, but it *can*
read a position straight out of the query string — so every position has a shareable
link, the same "URL way in" the big chess sites offer.

| Link | What it does |
|---|---|
| `?moves=e2e4 e7e5 g1f3` | applies UCI moves (SAN and PGN move numbers work too) and analyzes |
| `?moves=e4 e5 Nf3` | the same position written in SAN |
| `?fen=<FEN>` | analyzes a pasted FEN instead of moves |
| `?engine=cloud\|stockfish\|book` | picks the engine (`lichess`/`api`/`chessdb` aliases accepted) |
| `?best=<uci>` | the move the link **claims** is best — re-checked against a fresh analysis when it opens |
| `?p=` · `?position=` | aliases for `?moves=` |

Example: <https://hermes31415.github.io/ChessNextMove/?moves=e2e4%20e7e5%20g1f3%20b8c6%20f1c4&engine=cloud>

- Spaces may be `%20` or `+`; unrelated params (cache-busters) are preserved.
- A deep link wins over the remembered `localStorage` position.
- After any interaction (Analyze, an example chip, engine switch, Play it) the
  address bar is updated to the live position — **🔗 Link** copies that permalink,
  so any moment of a game is shareable.
- A plain visit never rewrites the URL.

**The recommended move travels in the link too.** After each analysis the app writes
the answer into the address bar as `?best=<uci>`, so a link says both *"this is the
position"* and *"ChessNext's answer here is `Nf6`"*. Because an engine answer can
change over time (the cloud database gets deeper, book lines get re-run), opening
such a link re-analyzes the position and **reports whether the claim still holds**:
a green **✓ link's move confirmed (Nf6)** badge, or an amber *"link said a3 — engine
now says Nf6"* when it no longer does. The claim is advisory only — nothing from the
URL is trusted, and the board always shows the freshly computed move.

## JSON API — POST + GET, for scripts and other apps

A static site cannot answer a `POST` (there is no server on GitHub Pages), so the
machine-readable half lives in this repo as a tiny Cloudflare Worker
(`api/worker.js` + `api/core.js`) — free tier, no key, no storage, no sign-up.
It wraps the same three public services and answers one consistent JSON object:

```
GET  /analyze?moves=e2e4 e7e5            (or ?fen=<fen>)   [&engine=cloud|stockfish|book]
POST /analyze   {"moves":"e2e4 e7e5"}    (or {"fen":"...","engine":"book"})
POST /analyze   body "e2e4 e7e5" (text/plain)  |  moves=…&engine=… (form-urlencoded)
GET  /            self-documenting API index (endpoints + examples)
GET  /health      liveness
```

```bash
curl -s "https://<your-worker>/analyze?moves=e2e4%20e7e5%20g1f3%20b8c6%20f1c4"
curl -s -X POST "https://<your-worker>/analyze" -H 'content-type: application/json' \
  -d '{"fen":"rnbqkbnr/ppp1pppp/8/8/2pP4/8/PP2PPPP/RNBQKBNR w KQkq - 0 3","engine":"stockfish"}'
```

```json
{
  "fen": "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3",
  "turn": "b",
  "moves_uci": ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4"],
  "moves_san": ["e4", "e5", "Nf3", "Nc6", "Bc4"],
  "engine": "cloud",
  "bestmove": { "uci": "g8f6", "san": "Nf6" },
  "eval": { "cp": 7, "mate": null, "depth": 55, "winPercent": 51.4, "perspective": "white" },
  "pv": { "uci": ["g8f6", "d2d3"], "san": ["Nf6", "d3"] },
  "candidates": [{ "uci": "g8f6", "san": "Nf6", "cp": 7 }],
  "fen_after": "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
  "elapsed_ms": 302
}
```

- `moves` → `fen` conversion is done by the same vendored chess.js the site uses,
  so SAN/PGN/castling/en-passant/promotion all behave identically; an illegal
  token is a clean `400`.
- The cloud engine also returns `candidates` (top 3); the book engine returns
  `book` (ranked moves + win rates). Fields that do not apply are omitted.
- CORS is `*`, so any web page can call it. Identical GETs are cached ~60 s at the
  edge (`x-cache: HIT|MISS`); each caller IP gets 60 requests/minute (429 +
  `Retry-After`) to protect the free upstreams.
- Inputs are capped (500 chars of moves, 120 of FEN) and **no request value is ever
  used to build an upstream URL** — the three endpoints are constants — so there is
  no SSRF/injection surface. No secrets are involved (all upstreams are keyless).
- Errors are JSON as well — `{"ok":false,"error":{"code":"BAD_MOVES","message":"…"}}`
  with codes `BAD_REQUEST`, `BAD_MOVES`, `BAD_FEN`, `UNKNOWN_ENGINE`,
  `NO_LEGAL_MOVES`, `NOT_IN_CLOUD`, `NOT_IN_BOOK`, `RATE_LIMITED`, `TIMEOUT`,
  `UPSTREAM`, `NOT_FOUND`, `METHOD`.

## Deploy (2 minutes, free)

The app is pure static files — no server needed. Any static host works; all three
APIs allow CORS from any origin (verified against a production origin).

**Easiest — Netlify Drop:** open <https://app.netlify.com/drop> and drag the
`ChessNextMove` folder onto the page. You get a live URL immediately (with a free
account it stays yours).

**Cloudflare Pages:** dash.cloudflare.com → Pages → "Upload assets" → drop the folder.

**GitHub Pages (already done):** repo at <https://github.com/Hermes31415/ChessNextMove>,
app served at <https://hermes31415.github.io/ChessNextMove/>. To redeploy after
changes: `git push` — Pages rebuilds automatically.

### Deploying the JSON API (Cloudflare Workers, free — optional, not live yet)

The static site works without this; the API is an independent deploy.

```bash
npm i                 # once (installs esbuild, which builds the worker bundle)
npm run build:api     # api/worker.js -> api/dist/worker.mjs (single file, ~62 kB)
npx wrangler login    # free Cloudflare account (one browser round trip)
npm run deploy:api    # -> https://chessnext-api.<your-subdomain>.workers.dev
```

`npm run dev:api` runs it locally on <http://localhost:8787>, verified there
against the real runtimes (workerd): GET/POST `/analyze`, CORS preflight, edge
cache HIT, per-IP rate limiting. Any other free host works too — the build output
is one ESM file exporting `{ fetch }` (Deno Deploy, Vercel, Netlify functions).

Once deployed, the worker root (`/`) is the thing to advertise: it returns a
self-documenting JSON index with the endpoints and copy-paste examples. Nothing in
the site needs to change — the page keeps calling the chess services directly, and
the API is a second, scriptable door onto the same analysis.

## Files

```
index.html       the whole app (CSS + JS inline)
chess.min.js     chess.js (MIT, vendored — an ES module despite the name)
api/core.js      position parsing + the three engines, normalised to JSON (no DOM)
api/worker.js    the deployable Worker: GET/POST /analyze, CORS, edge cache, rate limit
api/dist/        build output (git-ignored)
wrangler.toml    Worker config for `wrangler deploy`
scripts/smoke.mjs         end-to-end test of the app logic against the live APIs
scripts/api-test.mjs      end-to-end test of the BUILT worker (in-process + real HTTP)
scripts/build-api.mjs     bundles the worker with esbuild
scripts/browser-test.mjs  headless Chromium check (deep links included)
```

## Test

```bash
npm test                 # builds the worker bundle, then both suites (76 checks)
npm run test:web         # logic + live-API smoke only (34 checks)
npm run test:api         # the JSON API only (42 checks)
npm run test:browser     # headless Chromium check (needs `npm i` once)
npm run serve            # python3 -m http.server 8123
```

`npm test` covers: UCI/SAN parsing, FEN correctness, castling / en passant /
promotion, game-over detection, all three live engines (legal best move, eval,
depth), error mapping, and the "Play it" round-trip — then the API: the built
worker serving GET/POST/form/plain-text bodies over a real HTTP socket, FEN
round-trips, illegal-move/FEN/engine/oversized-input error codes, cloud-DB misses,
game-over conflicts, CORS preflight, pretty-printing, per-IP rate limiting and the
edge-cache header.

The browser check loads the app headlessly, asserts the board + result +
FEN-after viewer, clicks through engine switching and the Play-it loop, checks the
deep links (`?moves=` / `?fen=` / `?engine=` — including that the permalink button
produces a real link and that a plain visit leaves the URL alone), and fails on any
console error. First time only:

```bash
npm i                      # installs Playwright (devDependency)
npx playwright install chromium
```

## Credits

- [lichess.org/api — cloud eval](https://lichess.org/api) (free, keyless)
- [chess-api.com](https://chess-api.com) (free, keyless)
- [chessdb.cn](https://www.chessdb.cn) (free, keyless)
- [chess.js](https://github.com/jhlywa/chess.js) (MIT)

Please respect the services' rate limits — this is a casual-analysis tool, not a
batch engine.
