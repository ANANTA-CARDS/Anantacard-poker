// No-Limit Texas Hold'em engine. Pure functions over a plain JSON state, so the
// host's page can save it and the tests can run it in node.
// Cards are strings: rank + suit, e.g. "As", "Td", "2c".
(function (root) {
  const RANKS = '23456789TJQKA', SUITS = 'shdc';
  const HAND_NAMES = ['ไฮการ์ด', 'วันแพร์', 'ทูแพร์', 'ตอง', 'สเตรท', 'ฟลัช', 'ฟูลเฮาส์', 'โฟร์การ์ด', 'สเตรทฟลัช', 'รอยัลฟลัช'];

  function newDeck() { const d = []; for (const s of SUITS) for (const r of RANKS) d.push(r + s); return d; }
  function shuffle(deck, rnd) {
    for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    return deck;
  }

  // ---- hand evaluation: score is an array compared left to right ----
  function score5(cards) {
    const rs = cards.map(c => RANKS.indexOf(c[0])).sort((a, b) => b - a);
    const flush = cards.every(c => c[1] === cards[0][1]);
    const uniq = [...new Set(rs)];
    let straightHigh = -1;
    if (uniq.length === 5) {
      if (rs[0] - rs[4] === 4) straightHigh = rs[0];
      else if (rs[0] === 12 && rs[1] === 3) straightHigh = 3; // A-2-3-4-5
    }
    const cnt = {}; rs.forEach(r => cnt[r] = (cnt[r] || 0) + 1);
    const groups = Object.entries(cnt).map(([r, n]) => [n, +r]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    const byGroup = groups.map(g => g[1]);
    if (straightHigh >= 0 && flush) return [straightHigh === 12 ? 9 : 8, straightHigh];
    if (groups[0][0] === 4) return [7, ...byGroup];
    if (groups[0][0] === 3 && groups[1][0] === 2) return [6, ...byGroup];
    if (flush) return [5, ...rs];
    if (straightHigh >= 0) return [4, straightHigh];
    if (groups[0][0] === 3) return [3, ...byGroup];
    if (groups[0][0] === 2 && groups[1][0] === 2) return [2, ...byGroup];
    if (groups[0][0] === 2) return [1, ...byGroup];
    return [0, ...rs];
  }
  function cmp(a, b) { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; }
  function best(cards) { // best 5 of 5–7
    let top = null, topCards = null;
    const n = cards.length;
    const walk = (start, pick) => {
      if (pick.length === 5) { const s = score5(pick); if (!top || cmp(s, top) > 0) { top = s; topCards = pick.slice(); } return; }
      for (let i = start; i <= n - (5 - pick.length); i++) { pick.push(cards[i]); walk(i + 1, pick); pick.pop(); }
    };
    walk(0, []);
    return { score: top, cards: topCards, name: HAND_NAMES[top[0]] };
  }

  // ---- table state ----
  // state = { sb, bb, seats:[{id,name,stack,out}], button, handNo, hand }
  // hand  = { no, deck, board, street, players:[{seat,hole,bet,total,folded,allin,acted,mayRaise}],
  //           curBet, minRaise, toAct, done, result }
  function newTable({ sb, bb }) { return { sb, bb, seats: [], button: -1, handNo: 0, hand: null }; }

  function nextIdx(arr, from, ok) {
    for (let k = 1; k <= arr.length; k++) { const i = (from + k) % arr.length; if (ok(arr[i], i)) return i; }
    return -1;
  }

  function startHand(t, rnd) {
    const eligible = (s) => s && s.stack > 0 && !s.out;
    if (t.seats.filter(eligible).length < 2) throw new Error('ต้องมีผู้เล่นที่มีชิปอย่างน้อย 2 คน');
    t.button = nextIdx(t.seats, t.button < 0 ? t.seats.length - 1 : t.button, eligible);
    const deck = shuffle(newDeck(), rnd || Math.random);
    const players = [];
    // players ordered starting left of button, so index 0 is SB (or BB heads-up handled below)
    for (let k = 1; k <= t.seats.length; k++) {
      const i = (t.button + k) % t.seats.length;
      if (eligible(t.seats[i])) players.push({ seat: i, hole: [], bet: 0, total: 0, folded: false, allin: false, acted: false, mayRaise: true });
    }
    // button is the last in this order
    for (let r = 0; r < 2; r++) for (const p of players) p.hole.push(deck.pop());
    const h = { no: ++t.handNo, deck, board: [], street: 0, players, curBet: 0, minRaise: t.bb, toAct: -1, done: false, result: null, log: [] };
    t.hand = h;
    const heads = players.length === 2;
    const sbP = heads ? players.length - 1 : 0, bbP = heads ? 0 : 1;
    post(t, sbP, t.sb, 'บลายด์เล็ก'); post(t, bbP, t.bb, 'บลายด์ใหญ่');
    h.curBet = Math.max(t.bb, ...players.map(p => p.bet));
    h.minRaise = t.bb;
    h.toAct = firstToAct(h, bbP);
    checkRoundEnd(t);
    return t;
  }
  function post(t, pi, amt, label) {
    const h = t.hand, p = h.players[pi], s = t.seats[p.seat];
    const a = Math.min(amt, s.stack);
    s.stack -= a; p.bet += a; p.total += a;
    if (s.stack === 0) p.allin = true;
    h.log.push(`${s.name} ลง${label} ${a}`);
  }
  const canAct = p => !p.folded && !p.allin;
  function firstToAct(h, afterIdx) { return nextIdx(h.players, afterIdx, canAct); }

  // What the player at h.toAct may do.
  function options(t) {
    const h = t.hand; if (!h || h.done || h.toAct < 0) return null;
    const p = h.players[h.toAct], s = t.seats[p.seat];
    const toCall = Math.min(h.curBet - p.bet, s.stack);
    const maxTo = p.bet + s.stack;
    const minTo = Math.min(h.curBet + h.minRaise, maxTo);
    const canRaise = p.mayRaise && maxTo > h.curBet && h.players.some((q, i) => i !== h.toAct && canAct(q));
    return { seat: p.seat, toCall, canCheck: toCall === 0, canRaise, minTo: h.curBet === 0 ? Math.min(t.bb, maxTo) : minTo, maxTo, isBet: h.curBet === 0 };
  }

  // type: fold | check | call | raise (amount = total bet this street, "raise to")
  function act(t, seat, type, amount) {
    const h = t.hand;
    if (!h || h.done) throw new Error('ไม่มีมือที่กำลังเล่น');
    const o = options(t);
    if (!o || o.seat !== seat) throw new Error('ยังไม่ถึงตาคุณ');
    const p = h.players[h.toAct], s = t.seats[seat];
    if (type === 'check' && !o.canCheck) type = 'call';
    if (type === 'fold') { p.folded = true; h.log.push(`${s.name} หมอบ`); }
    else if (type === 'check') { h.log.push(`${s.name} เช็ค`); }
    else if (type === 'call') {
      const a = o.toCall; s.stack -= a; p.bet += a; p.total += a;
      if (s.stack === 0) p.allin = true;
      h.log.push(a ? `${s.name} คอล ${a}${p.allin ? ' (ออลอิน)' : ''}` : `${s.name} เช็ค`);
    } else if (type === 'raise') {
      if (!o.canRaise) throw new Error('เพิ่มเดิมพันไม่ได้');
      amount = Math.floor(+amount);
      if (!(amount >= o.minTo && amount <= o.maxTo)) throw new Error(`ต้องอยู่ระหว่าง ${o.minTo}–${o.maxTo}`);
      const add = amount - p.bet; s.stack -= add; p.bet = amount; p.total += add;
      if (s.stack === 0) p.allin = true;
      const inc = amount - h.curBet, full = inc >= h.minRaise;
      h.log.push(`${s.name} ${o.isBet ? 'เบท' : 'เรส'} ${amount}${p.allin ? ' (ออลอิน)' : ''}`);
      if (full) h.minRaise = inc;
      h.curBet = amount;
      h.players.forEach(q => { if (q !== p && canAct(q)) { q.acted = false; if (full) q.mayRaise = true; } });
    } else throw new Error('คำสั่งไม่ถูกต้อง');
    p.acted = true; p.mayRaise = false;
    h.toAct = nextIdx(h.players, h.toAct, q => canAct(q) && (!q.acted || q.bet < h.curBet));
    checkRoundEnd(t);
    return t;
  }

  function checkRoundEnd(t) {
    const h = t.hand;
    const live = h.players.filter(p => !p.folded);
    if (live.length === 1) return finish(t);
    const pending = h.players.filter(p => canAct(p) && (!p.acted || p.bet < h.curBet));
    if (pending.length) { if (h.toAct < 0 || !pending.includes(h.players[h.toAct])) h.toAct = h.players.indexOf(pending[0]); return; }
    // betting round over
    const actors = live.filter(canAct);
    if (h.street === 3 || actors.length <= 1) {
      while (h.board.length < 5) h.board.push(h.deck.pop());
      return finish(t);
    }
    h.street++;
    if (h.street === 1) h.board.push(h.deck.pop(), h.deck.pop(), h.deck.pop()); else h.board.push(h.deck.pop());
    h.players.forEach(p => { p.bet = 0; p.acted = false; p.mayRaise = true; });
    h.curBet = 0; h.minRaise = t.bb;
    h.toAct = firstToAct(h, h.players.length - 1); // first live player left of button
    h.log.push(['', 'ฟล็อป', 'เทิร์น', 'ริเวอร์'][h.street] + ': ' + h.board.join(' '));
    checkRoundEnd(t);
  }

  function finish(t) {
    const h = t.hand; h.done = true; h.toAct = -1;
    const live = h.players.filter(p => !p.folded);
    const res = { winners: {}, pots: [], shown: {} };
    const give = (p, a) => { t.seats[p.seat].stack += a; res.winners[p.seat] = (res.winners[p.seat] || 0) + a; };
    if (live.length === 1) {
      const pot = h.players.reduce((a, p) => a + p.total, 0);
      give(live[0], pot); res.pots.push({ amount: pot, winners: [live[0].seat], hand: null });
      h.log.push(`${t.seats[live[0].seat].name} ได้ ${pot}`);
    } else {
      const ev = new Map(live.map(p => [p, best(p.hole.concat(h.board))]));
      live.forEach(p => res.shown[p.seat] = { hole: p.hole, name: ev.get(p).name, best: ev.get(p).cards });
      const levels = [...new Set(h.players.map(p => p.total))].filter(x => x > 0).sort((a, b) => a - b);
      let prev = 0, carry = 0;
      for (const lv of levels) {
        let amt = carry; carry = 0;
        h.players.forEach(p => amt += Math.max(0, Math.min(p.total, lv) - prev));
        prev = lv;
        const elig = live.filter(p => p.total >= lv);
        if (!elig.length) { carry = amt; continue; }
        let top = null; let win = [];
        for (const p of elig) { const c = top ? cmp(ev.get(p).score, top) : 1; if (c > 0) { top = ev.get(p).score; win = [p]; } else if (c === 0) win.push(p); }
        // odd chips go to the first winner left of the button (players are already in that order)
        win.sort((a, b) => h.players.indexOf(a) - h.players.indexOf(b));
        const share = Math.floor(amt / win.length); let rem = amt - share * win.length;
        win.forEach(p => give(p, share + (rem-- > 0 ? 1 : 0)));
        const last = res.pots[res.pots.length - 1];
        if (last && last.winners.join() === win.map(p => p.seat).join()) last.amount += amt;
        else res.pots.push({ amount: amt, winners: win.map(p => p.seat), hand: ev.get(win[0]).name });
      }
      if (carry && res.pots.length) { const w = res.pots[res.pots.length - 1].winners; give(h.players.find(p => p.seat === w[0]), carry); }
      res.pots.forEach(pt => h.log.push(`${pt.winners.map(i => t.seats[i].name).join(', ')} ได้ ${pt.amount} (${pt.hand})`));
    }
    h.result = res;
  }

  // Remove a player at a seat (only between hands). Keeps seat indices stable by nulling.
  const api = { RANKS, SUITS, HAND_NAMES, newDeck, shuffle, score5, best, cmp, newTable, startHand, options, act, nextIdx };
  if (typeof module !== 'undefined') module.exports = api; else root.Poker = api;
})(this);
