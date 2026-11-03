// Realtime "rooms" over a public MQTT broker (no account, no server of our own).
// Each open page is a peer with one presence object per room, kept as a retained message
// at <prefix>/<room>/<peerId>. Others subscribe to <prefix>/<room>/+ and see everyone's
// latest presence. A peer re-sends its presence every HEARTBEAT ms; presences older than
// STALE ms are treated as gone, and leaving clears the retained message.
// Same shape the page used with the claude.ai room capability: peers(), presence(), onPeers(), join(), leave().
(function (root) {
  const PREFIX = 'anantapoker/v1';
  const HEARTBEAT = 15000, STALE = 50000;

  function createNet(url, opts) {
    opts = opts || {};
    const mqtt = opts.mqtt || root.mqtt;
    const me = opts.peerId || Math.random().toString(36).slice(2, 12);
    const client = mqtt.connect(url, { clientId: 'anpk-' + me, keepalive: 30, reconnectPeriod: 2000, connectTimeout: 10000, clean: true });
    const rooms = new Map();
    const connHandlers = new Set();
    let connected = false;
    client.on('connect', () => {
      connected = true; connHandlers.forEach(h => h(true));
      for (const r of rooms.values()) { client.subscribe(r.topic + '/+', { qos: 1 }); r.resend(); }
    });
    client.on('close', () => { if (connected) { connected = false; connHandlers.forEach(h => h(false)); } });
    client.on('message', (topic, buf) => {
      const i = topic.lastIndexOf('/'), base = topic.slice(0, i), peer = topic.slice(i + 1);
      const r = rooms.get(base); if (!r || peer === me) return;
      let p = null;
      if (buf && buf.length) { try { p = JSON.parse(new TextDecoder().decode(buf)); } catch (e) { p = null; } }
      if (p && typeof p === 'object' && typeof p.ts === 'number') r.others.set(peer, { presence: p.p || {}, ts: p.ts });
      else r.others.delete(peer);
      r.fire();
    });

    function makeRoom(name) {
      const topic = PREFIX + '/' + name;
      const R = {
        name, topic, others: new Map(), mine: {}, handlers: new Set(), snap: Object.freeze([]), timer: 0, scheduled: false, left: false,
        build() {
          const now = Date.now(), list = [Object.freeze({ peer: me, isMe: true, sameTab: true, presence: R.mine })];
          for (const [peer, v] of R.others) if (now - v.ts < STALE) list.push(Object.freeze({ peer, isMe: false, sameTab: false, presence: v.presence }));
          R.snap = Object.freeze(list);
        },
        fire() {
          if (R.scheduled) return; R.scheduled = true;
          setTimeout(() => { R.scheduled = false; R.build(); R.handlers.forEach(h => { try { h({ peers: R.snap }); } catch (e) { console.error(e); } }); }, 0);
        },
        resend() {
          if (R.left || !connected) return;
          client.publish(topic + '/' + me, JSON.stringify({ ts: Date.now(), p: R.mine }), { qos: 1, retain: true });
        },
      };
      const api = {
        name,
        peers: () => R.snap,
        onPeers(h) { R.handlers.add(h); R.fire(); return () => R.handlers.delete(h); },
        async presence(patch) {
          const next = Object.assign({}, R.mine);
          for (const k in patch) { if (patch[k] === null) delete next[k]; else next[k] = patch[k]; }
          R.mine = JSON.parse(JSON.stringify(next));
          R.resend(); R.fire();
        },
        connected: () => connected,
        async leave() {
          if (R.left) return; R.left = true; clearInterval(R.timer);
          if (connected) client.publish(topic + '/' + me, '', { qos: 1, retain: true });
          client.unsubscribe(topic + '/+'); rooms.delete(topic);
        },
      };
      R.api = api; rooms.set(topic, R);
      if (connected) client.subscribe(topic + '/+', { qos: 1 });
      // heartbeat keeps us fresh for others; the same tick also drops peers that went quiet
      R.timer = setInterval(() => { if (Object.keys(R.mine).length) R.resend(); R.fire(); }, HEARTBEAT);
      R.build();
      return api;
    }

    const lobby = makeRoom('lobby');
    lobby.join = async n => {
      if (!/^[a-z0-9][a-z0-9_.-]{0,47}$/.test(n)) throw { code: 'invalid_argument' };
      const r = rooms.get(PREFIX + '/t/' + n);
      return r ? r.api : makeRoom('t/' + n);
    };
    lobby.onConnection = h => { connHandlers.add(h); setTimeout(() => h(connected)); return () => connHandlers.delete(h); };
    lobby.close = () => client.end(true);
    // tidy up our retained presences when the tab closes (best effort)
    if (root.addEventListener) root.addEventListener('pagehide', () => { for (const r of rooms.values()) if (connected) client.publish(r.topic + '/' + me, '', { qos: 0, retain: true }); });
    return lobby;
  }
  root.createNet = createNet;
  if (typeof module !== 'undefined') module.exports = { createNet };
})(typeof window !== 'undefined' ? window : globalThis);
