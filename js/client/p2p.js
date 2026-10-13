// Online play WITHOUT our server: the device that creates the room runs the Host and a tiny in-page "room server";
// the others connect to it peer-to-peer (WebRTC data channels). PeerJS's free cloud is used only for the handshake.
// Every device (host included) talks to the room with the same protocol as server.js, through a socket-like object,
// so NetSession, the lobby and the game screens work unchanged.
import { Host } from '../core/host.js';
import { TICK_RATE, MAX_PLAYERS, cleanInput } from '../core/proto.js';

const PREFIX = 'raffica-v1-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const PEER_OPTS = {
  debug: 0,
  config: { iceServers: [
    { urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' },
  ] },
};
const SNAP_EVERY = 2; // remote peers get 30 snapshots/s (events of skipped ticks are merged in)

let peerLib = null;
function loadPeerJS() {
  if (!peerLib) {
    peerLib = new Promise((resolve, reject) => {
      if (window.peerjs?.Peer) return resolve(window.peerjs.Peer);
      const s = document.createElement('script');
      s.src = new URL('../../vendor/peerjs.min.js', import.meta.url).href;
      s.onload = () => (window.peerjs?.Peer ? resolve(window.peerjs.Peer) : reject(new Error('PeerJS non caricato')));
      s.onerror = () => reject(new Error('PeerJS non caricato'));
      document.head.appendChild(s);
    });
  }
  return peerLib;
}

const newCode = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
const cleanName = (n, d) => (typeof n === 'string' && n.trim() ? n.trim().slice(0, 16) : d);

// ---------------------------------------------------------------- room (runs on the creator's device)
export class P2PRoom {
  constructor(games) {
    this.host = new Host({ games, seed: (Math.random() * 2 ** 32) >>> 0, settings: {} });
    this.code = null;
    this.slots = Array(MAX_PLAYERS).fill(null);
    this.names = Array(MAX_PLAYERS).fill('');
    this.tokens = Array(MAX_PLAYERS).fill(null);
    this.reserved = Array(MAX_PLAYERS).fill(0);
    this.conns = new Set();
    this.peer = null;
    this.tickN = 0;
    this.pendingEv = [];
    this.status = 'starting';
  }

  // Registers PREFIX+code on the PeerJS cloud (retries with another code if taken).
  async open() {
    const Peer = await loadPeerJS();
    for (let tries = 0; tries < 6; tries++) {
      const code = newCode();
      try {
        const peer = await new Promise((resolve, reject) => {
          const p = new Peer(PREFIX + code, PEER_OPTS);
          const to = setTimeout(() => { p.destroy(); reject(new Error('Il servizio online non risponde')); }, 9000);
          p.on('open', () => { clearTimeout(to); resolve(p); });
          p.on('error', (e) => { clearTimeout(to); p.destroy(); reject(e); });
        });
        this.code = code;
        this.peer = peer;
        peer.on('connection', (dc) => this.accept(dc));
        peer.on('disconnected', () => { try { peer.reconnect(); } catch { /* ignore */ } });
        this.startLoop();
        this.status = 'open';
        return code;
      } catch (e) {
        if (e?.type !== 'unavailable-id') throw e;
      }
    }
    throw new Error('Non trovo un codice stanza libero');
  }

  accept(dc) {
    const conn = { dc, slots: [], slot: null, role: null, name: '', send: (m) => { try { if (dc.open) dc.send(JSON.stringify(m)); } catch { /* closed */ } }, remote: true };
    dc.on('data', (d) => this.handle(conn, typeof d === 'string' ? d : String(d)));
    dc.on('close', () => this.leave(conn));
    dc.on('error', () => this.leave(conn));
  }

  // The creator's own NetSession talks to the room through this object (no network).
  loopback() {
    const room = this;
    const sock = {
      readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
      conn: null,
      send(str) { if (sock.readyState === 1) room.handle(sock.conn, str); },
      close() { if (sock.readyState === 3) return; sock.readyState = 3; room.leave(sock.conn); sock.onclose?.(); },
    };
    // Deliver asynchronously like a real network: NetSession registers its waiters right after sending.
    sock.conn = { slots: [], slot: null, role: null, name: '', remote: false, send: (m) => { const data = JSON.stringify(m); queueMicrotask(() => { if (sock.readyState === 1) sock.onmessage?.({ data }); }); } };
    setTimeout(() => { sock.readyState = 1; sock.onopen?.(); }, 0);
    return sock;
  }

  handle(conn, text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    const role = m.role === 'tv' ? 'tv' : 'player';
    switch (m.t) {
      case 'create':
      case 'join': {
        const err = this.enter(conn, m.name, role, { token: m.token, local: m.local, names: m.names, chars: m.chars });
        if (err) conn.send({ t: 'error', msg: err });
        return;
      }
      case 'rooms': conn.send({ t: 'rooms', list: [{ code: this.code, names: this.names.filter((n, i) => this.slots[i]), free: this.slots.filter((c) => !c).length }] }); return;
      case 'in': if (conn.slots.includes(m.slot) && m.i && typeof m.i === 'object') this.host.input(m.slot, cleanInput(m.i)); return;
      case 'cmd': if (conn.slots.includes(m.slot) && m.c && typeof m.c.type === 'string') this.host.command(m.slot, m.c); return;
      case 'ping': conn.send({ t: 'pong', c: m.c ?? null, T: this.host.T }); return;
      case 'leave': this.leave(conn); return;
    }
  }

  // Same seat assignment as server.js (tokens keep a dropped player's place for 60 s; bots give their place up last).
  enter(conn, name, role, want = {}) {
    // A device that joins again first gives back the places it had (like server.js): no slot hoarding.
    if (this.conns.has(conn)) this.leave(conn);
    const token = typeof want.token === 'string' && want.token.length <= 64 ? want.token : null;
    const local = role === 'player' ? Math.max(1, Math.min(MAX_PLAYERS, Math.floor(Number(want.local)) || 1)) : 0;
    const slots = [];
    for (let k = 0; k < local; k++) {
      const tk = token ? (k ? `${token}#${k}` : token) : null;
      let slot = tk ? this.tokens.indexOf(tk) : -1;
      if (slot >= 0) {
        const old = this.slots[slot];
        if (old && old !== conn) { this.conns.delete(old); old.slots = []; try { old.dc?.close(); } catch { /* gone */ } }
      } else {
        const free = (i) => (!this.slots[i] || this.slots[i] === conn) && !slots.includes(i);
        const kept = (i) => this.tokens[i] && this.tokens[i] !== tk && this.reserved[i] > Date.now();
        const isBot = (i) => !!this.host.players[i]?.bot;
        const all = [...Array(MAX_PLAYERS).keys()].sort((a, b) => isBot(a) - isBot(b));
        slot = all.find((i) => free(i) && !kept(i)) ?? all.find(free) ?? -1;
      }
      if (slot < 0) { if (!slots.length) return 'Stanza piena'; break; }
      slots.push(slot);
      this.tokens[slot] = tk;
    }
    conn.role = role; conn.slots = slots; conn.slot = slots.length ? slots[0] : null;
    conn.name = cleanName(name, role === 'tv' ? 'TV' : `Giocatore ${(conn.slot ?? 0) + 1}`);
    this.conns.add(conn);
    slots.forEach((slot, k) => {
      const nm = k === 0 ? conn.name : cleanName(Array.isArray(want.names) ? want.names[k] : '', `Giocatore ${slot + 1}`);
      const ch = Array.isArray(want.chars) && typeof want.chars[k] === 'string' ? want.chars[k] : undefined;
      this.slots[slot] = conn;
      this.names[slot] = nm;
      this.host.setPlayer(slot, { name: nm, char: ch, connected: true });
    });
    conn.send({ t: 'joined', code: this.code, slot: conn.slot, slots, role });
    return null;
  }

  leave(conn) {
    if (!conn || !this.conns.has(conn)) return;
    this.conns.delete(conn);
    for (const sl of conn.slots) {
      if (this.slots[sl] !== conn) continue;
      this.slots[sl] = null;
      this.reserved[sl] = Date.now() + 60000;
      this.host.setPlayer(sl, { name: this.names[sl], connected: false });
    }
    conn.slots = []; conn.slot = null;
  }

  startLoop() {
    const dtMs = 1000 / TICK_RATE;
    let last = performance.now(), acc = 0;
    const step = () => {
      const now = performance.now();
      acc += Math.min(250, now - last); last = now;
      let n = 0;
      while (acc >= dtMs && n < 5) { this.tick(); acc -= dtMs; n++; }
      if (acc >= dtMs) acc = 0;
    };
    // setInterval keeps ticking when the creator switches tab (browsers slow it down, but the room stays alive).
    this.timer = setInterval(step, 4);
  }

  tick() {
    this.host.tick();
    const s = this.host.snapshot();
    this.tickN++;
    // Local screen: every tick. Remote peers: every SNAP_EVERY ticks, carrying the events of the skipped ones.
    for (const c of this.conns) if (!c.remote) c.send({ t: 'snap', s });
    if (s.ev?.length) this.pendingEv.push(...s.ev);
    if (this.tickN % SNAP_EVERY === 0) {
      const out = { ...s, ev: this.pendingEv.splice(0) };
      const frame = JSON.stringify({ t: 'snap', s: out });
      for (const c of this.conns) if (c.remote && c.dc?.open) { try { c.dc.send(frame); } catch { /* congested */ } }
    }
  }

  close() {
    clearInterval(this.timer);
    for (const c of this.conns) { try { c.dc?.close(); } catch { /* gone */ } }
    try { this.peer?.destroy(); } catch { /* gone */ }
    this.conns.clear();
  }
}

// ---------------------------------------------------------------- client socket (joining someone else's room)
// A WebSocket-like wrapper around a PeerJS data connection to PREFIX+code.
export function peerSocket(code) {
  const sock = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null, send() {}, close() {} };
  let peer = null, dc = null, closed = false;
  const fail = () => { if (sock.readyState === 3) return; sock.readyState = 3; try { peer?.destroy(); } catch { /* gone */ } sock.onclose?.(); };
  sock.close = () => { closed = true; try { dc?.close(); } catch { /* gone */ } fail(); };
  sock.send = (str) => { if (sock.readyState === 1 && dc?.open) { try { dc.send(str); } catch { /* congested */ } } };
  loadPeerJS().then((Peer) => {
    if (closed) return;
    peer = new Peer(PEER_OPTS);
    const to = setTimeout(() => { sock.onerror?.(new Error('Nessuna risposta')); fail(); }, 15000);
    peer.on('open', () => {
      dc = peer.connect(PREFIX + String(code).trim().toUpperCase(), { reliable: true, serialization: 'raw' });
      dc.on('open', () => { clearTimeout(to); sock.readyState = 1; sock.onopen?.(); });
      dc.on('data', (d) => sock.onmessage?.({ data: typeof d === 'string' ? d : String(d) }));
      dc.on('close', fail);
      dc.on('error', fail);
    });
    peer.on('error', (e) => { clearTimeout(to); sock.lastError = e?.type === 'peer-unavailable' ? 'Stanza non trovata' : 'Connessione non riuscita'; sock.onerror?.(e); fail(); });
  }).catch((e) => { sock.lastError = e.message; fail(); });
  return sock;
}
