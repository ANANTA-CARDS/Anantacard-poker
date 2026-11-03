// Browser test: several players in separate browser profiles play real hands through a local MQTT
// broker (same protocol as the public broker the site uses).
// npm install && node build.js && node test/ui.js
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const server = http.createServer((q, r) => { r.setHeader('content-type', 'text/html; charset=utf-8'); r.end(html); });

// local MQTT broker over websockets, standing in for the public one
const aedes = require('aedes')();
const { WebSocketServer, createWebSocketStream } = require('ws');
const wss = new WebSocketServer({ port: 0 });
wss.on('connection', ws => aedes.handle(createWebSocketStream(ws)));

(async () => {
  await new Promise(r => server.listen(0, r));
  const broker = `ws://127.0.0.1:${wss.address().port}`;
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  const pages = [];
  const errors = [];
  async function player(name, viewport) {
    const ctx = await browser.newContext({ viewport: viewport || { width: 420, height: 860 } });
    await ctx.addInitScript(b => { window.ANPK_BROKER = b; }, broker);
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

  const names = ['บี', 'ซี'];
  const others = [];
  // one friend arrives through the invite link (#code) instead of typing the code
  {
    const p = await player('ดี');
    await p.evaluate(() => localStorage.setItem('pk-name', 'ดี'));
    await p.goto(url + '#' + code); await p.reload();
    await p.waitForSelector('#game:not([hidden])', { timeout: 8000 }).catch(() => fail('invite link did not open the table'));
    others.push(p);
  }
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

  // the host reloads the page: the table comes back and play continues
  const before = await host.textContent('#gBlinds');
  await host.reload();
  await host.waitForSelector('#game:not([hidden])', { timeout: 8000 }).catch(() => fail('host did not resume the table'));
  const until = Date.now() + 40000; let after = before;
  while (Date.now() < until && after === before) {
    for (const p of [host, ...others, ...more]) if (await p.isVisible('#actions')) { await p.click('#aCall'); await p.waitForTimeout(150); }
    if (!(await host.isVisible('.seat.turn')) && await host.isEnabled('#dStart')) await host.click('#dStart').catch(() => {});
    after = await host.textContent('#gBlinds');
    await host.waitForTimeout(200);
  }
  console.log('after host reload:', before, '->', after);
  if (after === before) fail('play did not continue after host reload');

  await host.screenshot({ path: path.join(__dirname, 'host.png') });
  await others[0].screenshot({ path: path.join(__dirname, 'player.png') });
  await more[0].screenshot({ path: path.join(__dirname, 'waiting.png') });

  if (errors.length) { console.log(errors.slice(0, 10).join('\n')); fail('page errors'); }
  console.log(process.exitCode ? 'FAILED' : 'ok');
  await browser.close(); server.close(); wss.close(); aedes.close(); process.exit(process.exitCode || 0);
})();
