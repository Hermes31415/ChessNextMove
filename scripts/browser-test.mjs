// Headless browser verification for ChessNext — loads the app, waits for the
// auto-analysis, asserts the board + result rendered, captures console errors.
import { chromium } from 'playwright';

const APP_URL = process.env.APP_URL || 'http://localhost:8123';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

const waitResult = (timeout = 15000) =>
  page.waitForFunction(() => !document.getElementById('result').hidden, { timeout }).catch(() => null);
// waits for the best-move UCI in the result card to change (new analysis landed)
const waitNewResult = async (timeout = 15000) => {
  const prev = await page.evaluate(() => (document.getElementById('rUci') || {}).textContent || '');
  await page.waitForFunction((p) => {
    const el = document.getElementById('rUci');
    return el && el.textContent && el.textContent !== p;
  }, prev, { timeout }).catch(() => null);
};
// generic waitForFunction with an optional arg
const waitFor = (fn, arg, timeout = 15000) =>
  page.waitForFunction(fn, arg, { timeout }).catch(() => null);
const read = () => page.evaluate(() => ({
  squares: document.querySelectorAll('.sq').length,
  resultVisible: !document.getElementById('result').hidden,
  bestSan: (document.getElementById('rSan') || {}).textContent,
  bestUci: (document.getElementById('rUci') || {}).textContent,
  evalText: (document.getElementById('reval') || {}).textContent,
  detail: (document.getElementById('rdetail') || {}).textContent,
  fenAfter: (document.getElementById('rFenAfter') || {}).textContent,
  fenAfterVisible: !document.getElementById('fenAfterRow').hidden,
  dbRows: document.querySelectorAll('.dbrow').length,
  topMoves: document.querySelectorAll('#topMoves .dbrow').length,
  copyPvEnabled: !document.getElementById('copyPvBtn').disabled,
  lichessAfterEnabled: !document.getElementById('lichessAfterBtn').disabled,
  lichessBtnExists: !!document.getElementById('lichessBtn'),
  chips: (document.getElementById('chips') || {}).textContent,
  modeFenSel: document.getElementById('modeFen').classList.contains('sel'),
  moves: document.getElementById('moves').value,
  status: (document.getElementById('status') || {}).textContent,
}));

await page.goto(APP_URL + '/?v=6', { waitUntil: 'networkidle', timeout: 30000 });
await waitResult(20000); // auto-analyze round-trip
await page.waitForTimeout(500);
const state = await read();
console.log('STATE (auto, cloud): ' + JSON.stringify(state, null, 2));
console.log('ERRORS: ' + (errors.length ? '\n' + errors.join('\n') : 'none'));

// FEN-after correctness for the start position: e2e4 must give black to move
let fenAfterOk = false;
try {
  const mod = await import('../chess.min.js');
  const c = new mod.Chess(state.fenAfter);
  fenAfterOk = c.turn() === 'b' && state.fenAfter === 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
} catch (e) { fenAfterOk = false; }
console.log('FEN-AFTER check (e2e4): ' + (fenAfterOk ? 'PASS' : 'FAIL') + ' :: ' + state.fenAfter);

// engine switch -> Live Stockfish (auto-analyzes current position). This free
// API rate-limits aggressively under burst; a graceful error is acceptable here.
await page.click('text=Live Stockfish');
await waitResult();
const s1b = await read();
console.log('STATE1b (engine switch, chess-api): ' + JSON.stringify(s1b));

// type moves + Analyze (still chess-api)
await page.fill('#moves', 'd2d4 d7d5 c2c4');
await page.click('#analyzeBtn');
await waitNewResult();
const s2 = await read();
console.log('STATE2 (QGD, chess-api): ' + JSON.stringify(s2));

// engine switch -> ChessDB opening book (auto-analyzes QGD position)
await page.click('text=ChessDB.cn opening book');
await waitNewResult();
const s3 = await read();
console.log('STATE3 (QGD, chessdb): ' + JSON.stringify(s3));

// "Play it" loop
await page.click('#playBtn');
await waitNewResult();
await page.waitForTimeout(600);
const s4 = await read();
console.log('STATE4 (play it): ' + JSON.stringify(s4));

// mode-switch behavior (user-reported): clicking FEN clears the input, resets
// the board, hides the old result, and waits for fresh input + Analyze.
await page.click('#modeFen');
const ms1 = await page.evaluate(() => ({
  value: document.getElementById('moves').value,
  fenSel: document.getElementById('modeFen').classList.contains('sel'),
  resultHidden: document.getElementById('result').hidden,
  placeholder: document.getElementById('moves').placeholder,
}));
console.log('MODE-SWITCH (to FEN): ' + JSON.stringify(ms1));

// FEN input path: type the FEN, analyze, then play-it (input becomes the new FEN)
await page.fill('#moves', 'rnbqkbnr/ppp1pppp/8/8/2pP4/8/PP2PPPP/RNBQKBNR w KQkq - 0 3');
await page.click('#analyzeBtn');
await waitFor(() => !document.getElementById('result').hidden, 15000);
await page.waitForTimeout(500);
const s5 = await read();
console.log('STATE5 (FEN input): ' + JSON.stringify(s5));
const prevFen = await page.evaluate(() => document.getElementById('fenLabel').textContent);
await page.click('#playBtn');
await waitFor((p) => document.getElementById('fenLabel').textContent !== p, prevFen, 15000);
await page.waitForTimeout(500);
const s6 = await read();
console.log('STATE6 (FEN play-it): ' + JSON.stringify(s6));

// board highlight check (before resetting modes)
const hl = await page.evaluate(() => ({
  bestSquares: document.querySelectorAll('.sq.best').length,
  lastSquares: document.querySelectorAll('.sq.last').length,
}));
console.log('HIGHLIGHTS: ' + JSON.stringify(hl));

await page.screenshot({ path: '/tmp/chessnext.png', fullPage: true });

// mode-switch back to Moves clears again
await page.click('#modeMoves');
const ms2 = await page.evaluate(() => ({
  value: document.getElementById('moves').value,
  movesSel: document.getElementById('modeMoves').classList.contains('sel'),
  resultHidden: document.getElementById('result').hidden,
}));
console.log('MODE-SWITCH (to Moves): ' + JSON.stringify(ms2));

// ---- deep links (the GET side of the "URL API") ----
const ITALIAN_FEN = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';
const QGA_FEN = 'rnbqkbnr/ppp1pppp/8/8/2pP4/8/PP2PPPP/RNBQKBNR w KQkq - 0 3';

const dErrors = [];
const dmove = await browser.newPage({ viewport: { width: 1280, height: 860 } });
dmove.on('pageerror', (e) => dErrors.push('MOVES: ' + e.message));
await dmove.goto(APP_URL + '/?' + new URLSearchParams({ moves: 'e2e4 e7e5 g1f3 b8c6 f1c4', engine: 'chessdb' }).toString(),
  { waitUntil: 'networkidle', timeout: 30000 });
await dmove.waitForFunction(() => !document.getElementById('result').hidden, { timeout: 20000 }).catch(() => {});
await dmove.waitForTimeout(400);
const dlMoves = await dmove.evaluate(() => ({
  input: document.getElementById('moves').value,
  engine: (document.querySelector('input[name=engine]:checked') || {}).value,
  fenLabel: document.getElementById('fenLabel').textContent,
  dbRows: document.querySelectorAll('.dbrow').length,
  resultVisible: !document.getElementById('result').hidden,
  search: location.search,
  chips: document.getElementById('chips').textContent,
}));
console.log('DEEPLINK moves+engine: ' + JSON.stringify(dlMoves));

// plain load (no position params) must NOT rewrite the address bar; an action must
const dclick = await browser.newPage({ viewport: { width: 1280, height: 860 } });
dclick.on('pageerror', (e) => dErrors.push('CLICK: ' + e.message));
await dclick.goto(APP_URL + '/?v=clean', { waitUntil: 'networkidle', timeout: 30000 });
await dclick.waitForFunction(() => !document.getElementById('result').hidden, { timeout: 20000 }).catch(() => {});
const plainSearch = await dclick.evaluate(() => location.search);
await dclick.click('.chip-btn');           // "Italian"
await dclick.waitForFunction(() => location.search.includes('moves='), { timeout: 10000 }).catch(() => {});
const clickSearch = await dclick.evaluate(() => location.search);
console.log('URL plain load: ' + JSON.stringify(plainSearch) + ' -> after chip click: ' + JSON.stringify(clickSearch));

// permalink button copies a link that re-opens this position
try { await browser.contexts()[0].grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP_URL }); }
catch (e) { console.log('clipboard permission grant failed: ' + e.message); }
await dclick.waitForTimeout(2500);        // let the chip analysis settle (it clears the status line when it lands)
await dclick.click('#copyLinkBtn');
await dclick.waitForTimeout(400);
const dlStatus = await dclick.evaluate(async () => ({
  clip: await navigator.clipboard.readText().catch(() => ''),
  status: document.getElementById('status').textContent,
  search: location.search
}));
console.log('permalink: ' + JSON.stringify(dlStatus));

// a link that carries the recommended move (&best=) — the claim is re-checked on load
const claimRead = (p) => p.evaluate(() => ({
  badge: (document.getElementById('linkBadge') || {}).textContent || '',
  cls: (document.getElementById('linkBadge') || {}).className || '',
  hidden: (document.getElementById('linkBadge') || {}).hidden,
  best: (document.getElementById('rUci') || {}).textContent || '',
  search: location.search
}));
const dClaim = await browser.newPage({ viewport: { width: 1280, height: 860 } });
dClaim.on('pageerror', (e) => dErrors.push('CLAIM: ' + e.message));
await dClaim.goto(APP_URL + '/?' + new URLSearchParams({ moves: 'e2e4 e7e5 g1f3 b8c6 f1c4', engine: 'cloud', best: 'g8f6' }).toString(),
  { waitUntil: 'networkidle', timeout: 30000 });
await dClaim.waitForFunction(() => !document.getElementById('result').hidden, { timeout: 20000 }).catch(() => {});
await dClaim.waitForTimeout(600);
const okClaim = await claimRead(dClaim);
console.log('LINK CLAIM (link says g8f6): ' + JSON.stringify(okClaim));

// a link whose claim the engine now disagrees with must say so, not silently agree
const dBadClaim = await browser.newPage({ viewport: { width: 1280, height: 860 } });
dBadClaim.on('pageerror', (e) => dErrors.push('BADCLAIM: ' + e.message));
await dBadClaim.goto(APP_URL + '/?' + new URLSearchParams({ moves: 'e2e4 e7e5 g1f3 b8c6 f1c4', engine: 'cloud', best: 'a2a3' }).toString(),
  { waitUntil: 'networkidle', timeout: 30000 });
await dBadClaim.waitForFunction(() => !document.getElementById('result').hidden, { timeout: 20000 }).catch(() => {});
await dBadClaim.waitForTimeout(600);
const badClaim = await claimRead(dBadClaim);
console.log('LINK CLAIM (link says a2a3): ' + JSON.stringify(badClaim));

const dFen = await browser.newPage({ viewport: { width: 1280, height: 860 } });
dFen.on('pageerror', (e) => dErrors.push('FEN: ' + e.message));
await dFen.goto(APP_URL + '/?' + new URLSearchParams({ fen: QGA_FEN }).toString(), { waitUntil: 'networkidle', timeout: 30000 });
await dFen.waitForFunction(() => !document.getElementById('result').hidden, { timeout: 20000 }).catch(() => {});
await dFen.waitForTimeout(400);
const dlFen = await dFen.evaluate(() => ({
  fenLabel: document.getElementById('fenLabel').textContent,
  fenSel: document.getElementById('modeFen').classList.contains('sel'),
  chips: document.getElementById('chips').textContent,
  resultVisible: !document.getElementById('result').hidden,
  search: location.search,
}));
console.log('DEEPLINK fen: ' + JSON.stringify(dlFen));
const deeplinksOk = dlMoves.input === 'e2e4 e7e5 g1f3 b8c6 f1c4' && dlMoves.engine === 'chessdb'
  && dlMoves.fenLabel === ITALIAN_FEN && dlMoves.resultVisible && dlMoves.dbRows === 5
  && dlMoves.search.includes('moves=') && dlMoves.search.includes('engine=chessdb')
  && !plainSearch.includes('moves=') && !plainSearch.includes('fen=')
  && clickSearch.includes('moves=e2e4') && clickSearch.includes('v=clean')
  && /moves=e2e4/.test(dlStatus.clip + dlStatus.status) && /localhost/.test(dlStatus.clip + dlStatus.status)
  && dlStatus.search.includes('best=')                                   // the link carries the answer
  && okClaim.hidden === false && /(confirmed|engine now says)/.test(okClaim.badge) && /(Nf6|g8f6)/.test(okClaim.badge)
  && okClaim.search.includes('best=' + okClaim.best)      // the link carries the answer that is shown
  && badClaim.hidden === false && /link said/.test(badClaim.badge) && /a2a3/.test(badClaim.badge) && badClaim.cls.includes('diff')
  && dlFen.fenSel && dlFen.chips === 'Position from FEN' && dlFen.fenLabel === QGA_FEN && dlFen.resultVisible
  && dlFen.search.includes('fen=')
  && dErrors.length === 0;
console.log('DEEPLINKS: ' + (deeplinksOk ? 'PASS' : 'FAIL'));

// mobile viewport check (iPhone-ish 390x844): layout must not overflow
const mpage = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const mErrors = [];
mpage.on('pageerror', (e) => mErrors.push(e.message));
await mpage.goto(APP_URL + '/?v=m1', { waitUntil: 'networkidle', timeout: 30000 });
await mpage.waitForFunction(() => !document.getElementById('result').hidden, { timeout: 20000 }).catch(() => {});
await mpage.waitForTimeout(500);
const mob = await mpage.evaluate(() => ({
  squares: document.querySelectorAll('.sq').length,
  resultVisible: !document.getElementById('result').hidden,
  scrollW: document.documentElement.scrollWidth,
  winW: window.innerWidth,
}));
console.log('MOBILE: ' + JSON.stringify(mob) + ' | pageerrors: ' + mErrors.length);
await mpage.screenshot({ path: '/tmp/chessnext-mobile.png' });
await mpage.close();

await browser.close();

const ok = state.squares === 64 && state.resultVisible && !errors.length
  && state.bestUci === 'e2e4' && fenAfterOk
  && state.topMoves >= 2 && state.copyPvEnabled && state.lichessAfterEnabled && state.lichessBtnExists
  && s3.dbRows === 5 && s4.moves.split(' ').length === 4
  && hl.bestSquares === 2 && s4.fenAfterVisible
  && ms1.value === '' && ms1.fenSel && ms1.resultHidden
  && s5.modeFenSel && s5.chips === 'Position from FEN' && s5.dbRows === 5
  && s6.moves.indexOf('/') !== -1 && s6.modeFenSel
  && ms2.value === '' && ms2.movesSel && ms2.resultHidden
  && deeplinksOk
  && mob.squares === 64 && mob.resultVisible && mob.scrollW <= mob.winW && mErrors.length === 0;
console.log('\nVERDICT: ' + (ok ? 'PASS' : 'CHECK'));
process.exit(ok ? 0 : 2);
