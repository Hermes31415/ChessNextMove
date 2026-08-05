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

## Files

```
index.html       the whole app (CSS + JS inline)
chess.min.js     chess.js v0.13.4 (UMD, vendored)
scripts/smoke.mjs  end-to-end test of the exact app logic against the live APIs
```

## Test

```bash
npm test                 # logic + live-API smoke suite (no deps needed)
npm run test:browser     # headless Chromium check (needs `npm i` once)
npm run serve            # python3 -m http.server 8123
```

`npm test` covers: UCI/SAN parsing, FEN correctness, castling / en passant /
promotion, game-over detection, all three live engines (legal best move, eval,
depth), error mapping, and the "Play it" round-trip.

The browser check loads the app headlessly, asserts the board + result +
FEN-after viewer, clicks through engine switching and the Play-it loop, and
fails on any console error. First time only:

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
