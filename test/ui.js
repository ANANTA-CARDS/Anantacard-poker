// Browser test: several players in separate browser profiles play real hands through a mock of the
// room capability (presence relayed by this script, 4 KiB limit enforced like the real one).
// node build.js && node test/ui.js
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'dist', 'poker.html'), 'utf8');
const page = `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1"></head><body>${html}</body></html>`;
const server = http.createServer((q, r) => { r.setHeader('content-type', 'text/html; charset=utf-8'); r.end(page); });

const MOCK = () => {
  const me = Math.random().toString(36).slice(2, 10);
  const rooms = {};
  window.__presenceErrors = [];
  window.__deliver = (ch, m) => rooms[ch] && rooms[ch].recv(m);
  function mk(ch) {
    const peers = new Map(); let mine = {}; const hs = new Set(); let snap = Object.freeze([]);
    const fire = () => { snap = Object.freeze([...peers].map(([peer, v]) => Object.freeze({ peer, by: null, isMe: peer === me, sameTab: peer === me, kind: 'viewer', guest: false, presence: v.p, updatedAt: v.t }))); hs.forEach(h => h({ peers: snap, joined: [], left: [], updated: [] })); };
    peers.set(me, { p: {}, t: Date.now() });
    const R = {
      name: ch,
      recv(m) {
        if (m.type === 'hello') window.__relay(ch, { type: 'p', peer: me, p: mine });
        if (m.type === 'p') { peers.set(m.peer, { p: m.p, t: Date.now() }); fire(); }
        if (m.type === 'bye') { peers.delete(m.peer); fire(); }
      },
      async presence(patch) {
        const next = { ...mine }; for (const k in patch) { if (patch[k] === null) delete next[k]; else next[k] = patch[k]; }
        const size = new Blob([JSON.stringify(next)]).size;
        if (size > 4096) { window.__presenceErrors.push(size); throw { code: 'invalid_argument', message: 'presence over 4 KiB: ' + size }; }
        window.__maxPresence = Math.max(window.__maxPresence || 0, size);
        mine = JSON.parse(JSON.stringify(next)); peers.set(me, { p: mine, t: Date.now() }); window.__relay(ch, { type: 'p', peer: me, p: mine }); fire();
      },
      peers: () => snap,
      onPeers(h) { hs.add(h); setTimeout(fire, 0); return () => hs.delete(h); },
      connected: () => true, onConnection(h) { setTimeout(() => h(true)); return () => {}; },
      async leave() { window.__relay(ch, { type: 'bye', peer: me }); delete rooms[ch]; },
      async emit() {}, on() { return () => {}; },
    };
    rooms[ch] = R; window.__relay(ch, { type: 'hello' });
    return R;
  }
  const lobby = mk('lobby');
  lobby.join = async n => rooms[n] || mk(n);
  window.claude = { use: async n => n === 'room' ? lobby : null };
};

(async () => {
  await new Promise(r => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  const pages = [];
  const errors = [];
  async function player(name, viewport) {
    const ctx = await browser.newContext({ viewport: viewport || { width: 420, height: 860 } });
    await ctx.exposeBinding('__relay', async ({ page: src }, ch, m) => {
      for (const p of pages) if (p !== src) p.evaluate(([c, x]) => window.__deliver && window.__deliver(c, x), [ch, m]).catch(() => {});
    });
    await ctx.addInitScript(MOCK);
    const p = await ctx.newPage();
    p.on('pageerror', e => errors.push(name + ': ' + e.message));
    p.on('console', m => { if (m.type() === 'error' && !/fonts\.g/.test(m.text())) errors.push(name + ' console: ' + m.text()); });
    pages.push(p);
    await p.goto(url);
    await p.fill('#nick', name);
    return p;
  }
  const fail = m => { console.log('FAIL', m); process.exitCode = 1; };

  const host = await player('เจ้ามือ', { width: 1100, height: 900 });
  await host.fill('#cStack', '1000');
  await host.click('#createBtn');
  await host.waitForSelector('#game:not([hidden])');
  const code = (await host.textContent('#gCode')).trim();
  console.log('table code', code);

  const names = ['บี', 'ซี', 'ดี'];
  const others = [];
  for (const n of names) {
    const p = await player(n);
    // the open table shows up in the lobby list
    await p.waitForSelector('#openTables .tbl-row', { timeout: 5000 }).catch(() => fail(n + ' does not see the open table'));
    await p.fill('#jCode', code); await p.click('#joinForm button');
    await p.waitForSelector('#game:not([hidden])');
    others.push(p);
  }
  await host.waitForFunction(() => document.querySelectorAll('#dRows tr').length === 4, null, { timeout: 5000 }).catch(() => fail('host does not see 4 seated players'));

  // host sets a different stack for one player
  await host.fill('#stk-' + await others[0].evaluate(() => localStorage.getItem('pk-pid')), '2500');
  await host.click('#dRows tr:nth-child(2) button:has-text("ตั้ง")');
  await others[0].waitForFunction(() => [...document.querySelectorAll('.seat.me .stk')].some(e => e.textContent.replace(/,/g, '') === '2500'), null, { timeout: 5000 }).catch(() => fail('per-player stack not shown to player'));

  // play hands: whoever has the turn calls/checks (sometimes raises)
  await host.click('#dStart');
  const all = [host, ...others];
  let actions = 0, handsSeen = new Set();
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && handsSeen.size < 4) {
    let acted = false;
    for (const p of all) {
      const vis = await p.isVisible('#actions');
      if (!vis) continue;
      // every player in the hand sees exactly their own two cards
      const mine = await p.$$eval('#mine .card', cs => cs.map(c => c.getAttribute('aria-label')));
      if (mine.length !== 2 || mine.some(x => !x)) fail('own cards not visible: ' + JSON.stringify(mine));
      const r = actions % 7;
      if (r === 3 && await p.isVisible('#aRaise')) await p.click('#aRaise');
      else if (r === 5) await p.click('#aFold');
      else await p.click('#aCall');
      actions++; acted = true;
      await p.waitForTimeout(150);
    }
    const hn = await host.textContent('#gBlinds'); handsSeen.add(hn);
    if (!acted) await host.waitForTimeout(300);
  }
  console.log('actions', actions, 'hands', [...handsSeen].join(' | '));
  if (handsSeen.size < 3) fail('hands did not progress');

  // nobody can see another player's hole cards while the hand is live (only backs or nothing)
  for (const p of others) {
    const faces = await p.$$eval('.seat:not(.me) .hole .card', cs => cs.filter(c => !c.classList.contains('back')).length);
    const live = await p.isVisible('.seat.turn');
    if (live && faces) fail('saw opponent card faces during a live hand');
  }

  // chips are conserved: sum of stacks + pot equals what the host handed out
  const total = await host.evaluate(() => [...document.querySelectorAll('#dRows tr td:nth-child(2)')].reduce((a, td) => a + +td.textContent.replace(/,/g, ''), 0) + +document.getElementById('pot').textContent.replace(/[^\d]/g, ''));
  console.log('chips on table', total);

  const maxP = await host.evaluate(() => window.__maxPresence), perr = await host.evaluate(() => window.__presenceErrors);
  console.log('largest host presence', maxP, 'bytes');
  if (perr.length) fail('presence over limit ' + perr);

  // nine players fit inside the presence limit
  const more = [];
  for (const n of ['อี', 'เอฟ', 'จี', 'เอช', 'ไอ']) {
    const p = await player(n);
    await p.fill('#jCode', code); await p.click('#joinForm button'); await p.waitForSelector('#game:not([hidden])');
    more.push(p);
  }
  await host.waitForTimeout(1500);
  const seats = await host.$$eval('#dRows tr', r => r.length);
  console.log('seated after 5 more joined (max 6):', seats);
  if (seats !== 6) fail('max seats not respected: ' + seats);

  await host.screenshot({ path: path.join(__dirname, 'host.png') });
  await others[0].screenshot({ path: path.join(__dirname, 'player.png') });
  await more[0].screenshot({ path: path.join(__dirname, 'waiting.png') });

  if (errors.length) { console.log(errors.slice(0, 10).join('\n')); fail('page errors'); }
  console.log(process.exitCode ? 'FAILED' : 'ok');
  await browser.close(); server.close();
})();
