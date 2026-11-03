// node test/engine.js [randomGames]
const P = require('../engine.js');
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } };
const ev = cs => P.best(cs.split(' '));

// hand ranking
ok(ev('As Ks Qs Js Ts 2c 3d').name === 'รอยัลฟลัช', 'royal');
ok(ev('9h 8h 7h 6h 5h Ac Ad').name === 'สเตรทฟลัช', 'sf');
ok(ev('Ah 2d 3c 4s 5h Kd Qc').name === 'สเตรท', 'wheel');
ok(P.cmp(ev('Ah 2d 3c 4s 5h Kd 9c').score, ev('2h 3d 4c 5s 6h Kd 9c').score) < 0, 'wheel < 6-high');
ok(ev('Ah Ad Ac Kd Kc 2s 3s').name === 'ฟูลเฮาส์', 'boat');
ok(ev('Ah Ad Ac Kd Kc Ks 3s').score.join() === '6,12,11', 'best boat of two trips');
ok(ev('Ah Ad Kc Kd Qc Qs 3s').score.join() === '2,12,11,10', 'two pair kicker from third pair');
ok(P.cmp(ev('Ah Kd 7c 7d 2s 3h 9c').score, ev('Qh Jd 7c 7d 2s 3h 9c').score) > 0, 'kicker');
ok(P.cmp(ev('Ah Kd Qc Jd 9s 3h 2c').score, ev('Ah Kd Qc Jd 9s 4h 2c').score) === 0, 'same 5');

// scripted hand helper: deck order controlled by rnd that leaves the deck as-is, then we overwrite
function table(stacks, sb = 5, bb = 10) {
  const t = P.newTable({ sb, bb });
  stacks.forEach((s, i) => t.seats.push({ id: 'p' + i, name: 'P' + i, stack: s }));
  return t;
}
const total = t => t.seats.reduce((a, s) => a + (s ? s.stack : 0), 0) + (t.hand && !t.hand.done ? t.hand.players.reduce((a, p) => a + p.total, 0) : 0);

// 3-handed: button P0, SB P1, BB P2, UTG = P0
{
  const t = table([1000, 1000, 1000]);
  P.startHand(t, () => 0.5);
  ok(t.button === 0, 'button');
  ok(P.options(t).seat === 0, 'utg acts first 3-handed');
  P.act(t, 0, 'call'); P.act(t, 1, 'call');
  ok(P.options(t).seat === 2 && P.options(t).canCheck, 'bb option');
  P.act(t, 2, 'raise', 40);
  ok(P.options(t).seat === 0 && P.options(t).minTo === 70, 'min reraise to 70');
  P.act(t, 0, 'fold'); P.act(t, 1, 'call');
  ok(t.hand.street === 1 && t.hand.board.length === 3, 'flop');
  ok(P.options(t).seat === 1, 'sb first postflop');
  P.act(t, 1, 'check'); P.act(t, 2, 'raise', 100); P.act(t, 1, 'fold');
  ok(t.hand.done && t.seats[2].stack === 1000 - 40 - 100 + 40 + 40 + 10 + 100, 'win by fold ' + t.seats[2].stack);
  ok(total(t) === 3000, 'chips conserved');
}
// heads-up: button is SB and acts first preflop, BB first postflop
{
  const t = table([500, 500]);
  P.startHand(t);
  const btn = t.button, other = 1 - btn;
  ok(t.hand.players[t.hand.players.length - 1].seat === btn && t.hand.players[t.hand.players.length - 1].bet === 5, 'hu button posts sb');
  ok(P.options(t).seat === btn, 'hu button acts first preflop');
  P.act(t, btn, 'call'); P.act(t, other, 'check');
  ok(P.options(t).seat === other, 'hu bb first postflop');
}
// side pots: short stack all-in, two bigger stacks continue
{
  const t = table([100, 300, 300]);
  P.startHand(t, () => 0.99);
  const h = t.hand;
  // fix the cards: P0 best, P1 second, P2 worst
  const seatP = s => h.players.find(p => p.seat === s);
  seatP(0).hole = ['As', 'Ah']; seatP(1).hole = ['Ks', 'Kh']; seatP(2).hole = ['2c', '7d'];
  h.deck = ['Qh', 'Jd', '9c', '4d', '3s']; // dealt from the end
  P.act(t, 0, 'raise', 100); // all-in
  P.act(t, 1, 'raise', 300); // all-in
  P.act(t, 2, 'call');      // all-in
  ok(h.done, 'runout done');
  ok(t.seats[0].stack === 300, 'main pot to AA ' + t.seats[0].stack);
  ok(t.seats[1].stack === 400, 'side pot to KK ' + t.seats[1].stack);
  ok(t.seats[2].stack === 0, 'loser busted');
  ok(h.result.pots.length === 2, 'two pots');
}
// split pot
{
  const t = table([105, 100, 100], 5, 10);
  P.startHand(t);
  const h = t.hand;
  h.players.forEach(p => p.hole = p.seat === 0 ? ['2c', '3d'] : p.seat === 1 ? ['Ac', 'Kd'] : ['Ad', 'Kc']);
  h.deck = ['4h', '8s', 'Qs', 'Jh', 'Th'];
  P.act(t, 0, 'call'); P.act(t, 1, 'call'); P.act(t, 2, 'check');
  for (let i = 0; i < 3; i++) { P.act(t, P.options(t).seat, 'check'); P.act(t, P.options(t).seat, 'check'); P.act(t, P.options(t).seat, 'check'); }
  ok(h.done && t.seats[0].stack === 95 && t.seats[1].stack === 105 && t.seats[2].stack === 105, 'split ' + t.seats.map(s => s.stack));
}
// short all-in raise does not reopen betting for someone who already acted
{
  const t = table([1000, 1000, 1000, 55]);
  P.startHand(t); // button 0, sb 1, bb 2, utg 3
  P.act(t, 3, 'call'); P.act(t, 0, 'raise', 40); P.act(t, 1, 'fold'); P.act(t, 2, 'call');
  // seat 3 had acted (called 10); now faces raise to 40: full raise so may raise
  ok(P.options(t).seat === 3 && P.options(t).canRaise, 'full raise reopens');
  P.act(t, 3, 'raise', 55); // all-in for 55, increment 15 < 30 → not full
  ok(P.options(t).seat === 0 && !P.options(t).canRaise && P.options(t).toCall === 15, 'short all-in does not reopen');
}

// odd chip goes to the first winner left of the button
{
  const t = table([100, 100, 100], 5, 10);
  P.startHand(t); // button 0, sb 1, bb 2
  const h = t.hand;
  h.players.forEach(p => p.hole = p.seat === 0 ? ['2c', '3d'] : p.seat === 1 ? ['Ac', 'Kd'] : ['Ad', 'Kc']);
  h.deck = ['4h', '8s', 'Qs', 'Jh', 'Th'];
  P.act(t, 0, 'fold'); P.act(t, 1, 'call'); P.act(t, 2, 'raise', 20); P.act(t, 1, 'call');
  ok(h.street === 1, 'flop after raise-call');
  while (!h.done) P.act(t, P.options(t).seat, 'check');
  ok(t.seats[1].stack === 100 && t.seats[2].stack === 100 && t.seats[0].stack === 100, 'even split ' + t.seats.map(s => s.stack));
}
{
  const t = table([100, 100, 100], 5, 10);
  P.startHand(t);
  const h = t.hand;
  h.players.forEach(p => p.hole = p.seat === 0 ? ['2c', '3d'] : p.seat === 1 ? ['Ac', 'Kd'] : ['Ad', 'Kc']);
  h.deck = ['4h', '8s', 'Qs', 'Jh', 'Th'];
  P.act(t, 0, 'raise', 25); P.act(t, 1, 'call'); P.act(t, 2, 'call');
  P.act(t, 1, 'raise', 10); P.act(t, 2, 'call'); P.act(t, 0, 'raise', 30); P.act(t, 1, 'fold'); P.act(t, 2, 'call');
  // pot = 25*3 + 10 + 30 + 30 = 145; seat 2 has AK straight vs seat 0 junk → seat 2 wins all
  while (!h.done) P.act(t, P.options(t).seat, 'check');
  ok(t.seats[2].stack === 100 - 55 + 145, 'raise war ' + t.seats.map(s => s.stack));
}
{
  const t = table([100, 100, 100], 5, 10);
  P.startHand(t);
  const h = t.hand;
  h.players.forEach(p => p.hole = ['2c', '3d', '2d', '3c', '2h', '3h'].slice(p.seat * 2, p.seat * 2 + 2));
  h.deck = ['As', 'Ks', 'Qs', 'Js', 'Ts'].reverse(); // board royal flush, everyone chops
  P.act(t, 0, 'call'); P.act(t, 1, 'fold'); P.act(t, 2, 'check');
  while (!h.done) P.act(t, P.options(t).seat, 'check');
  // pot = 25: seat 0 and 2 chop, odd chip to first left of button among winners = seat 2 (button is 0, so order 1,2,0)
  ok(t.seats[2].stack === 103 && t.seats[0].stack === 102, 'odd chip ' + t.seats.map(s => s.stack));
}

// random games: chips must always be conserved and hands must always end
const N = +process.argv[2] || 2000;
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
for (let g = 0; g < N; g++) {
  const n = 2 + Math.floor(rnd() * 8);
  const t = table(Array.from({ length: n }, () => 20 + Math.floor(rnd() * 500)), 1 + Math.floor(rnd() * 5), 10);
  const start = total(t);
  for (let hand = 0; hand < 30; hand++) {
    if (t.seats.filter(s => s.stack > 0).length < 2) break;
    P.startHand(t, rnd);
    let steps = 0;
    while (!t.hand.done && steps++ < 500) {
      const o = P.options(t); const r = rnd();
      try {
        if (r < 0.15) P.act(t, o.seat, 'fold');
        else if (r < 0.65 || !o.canRaise) P.act(t, o.seat, o.canCheck ? 'check' : 'call');
        else P.act(t, o.seat, 'raise', o.minTo + Math.floor(rnd() * (o.maxTo - o.minTo + 1)));
      } catch (e) { fails++; console.log('FAIL act', e.message); break; }
    }
    if (!t.hand.done) { fails++; console.log('FAIL hand stuck'); break; }
    if (total(t) !== start) { fails++; console.log('FAIL chips', total(t), start, g, hand); break; }
    if (t.seats.some(s => s.stack < 0)) { fails++; console.log('FAIL negative'); break; }
    const cards = t.hand.board.concat(...t.hand.players.map(p => p.hole));
    if (new Set(cards).size !== cards.length) { fails++; console.log('FAIL duplicate card'); }
  }
}
console.log(fails ? `${fails} failures` : `ok (${N} random games)`);
process.exit(fails ? 1 : 0);
