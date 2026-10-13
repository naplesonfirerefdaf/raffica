// Sessions: LocalSession runs the Host in the page; NetSession talks to server.js over WebSocket.
// Both expose: kind, local (slots controlled here), input(slot, i), cmd(slot, c), update(now),
// sample() -> {a, b, t, latest, rt} for rendering, and drain(rt) -> events to play.
import { Host } from '../core/host.js';
import { DT } from '../core/proto.js';

class SnapBuffer {
  constructor() { this.list = []; }
  push(s) {
    const l = this.list;
    if (l.length && s.T <= l[l.length - 1].T) return; // out of order / duplicate
    l.push(s);
    if (l.length > 240) l.splice(0, l.length - 240);
  }
  latest() { return this.list[this.list.length - 1] || null; }
  sample(rt) {
    const l = this.list;
    if (!l.length) return null;
    if (rt >= l[l.length - 1].T) return { a: l[l.length - 1], b: l[l.length - 1], t: 1 };
    for (let k = l.length - 1; k > 0; k--) {
      if (l[k - 1].T <= rt) {
        const a = l[k - 1], b = l[k];
        return { a, b, t: (rt - a.T) / Math.max(1e-6, b.T - a.T) };
      }
    }
    return { a: l[0], b: l[0], t: 1 };
  }
  // Events of snapshots whose time has been reached, each delivered once.
  drain(rt) {
    const out = [];
    for (const s of this.list) {
      if (s.T > rt) break;
      if (!s.done) { s.done = true; if (s.ev?.length) out.push(...s.ev); }
    }
    // Drop old snapshots (keep the last couple before rt).
    let k = 0;
    while (k < this.list.length - 3 && this.list[k + 2].T < rt - 0.5) k++;
    if (k) this.list.splice(0, k);
    return out;
  }
}

export class LocalSession {
  // players: [{slot, name, char, bot?, team?}] — every player sitting at this device (2–4); bot = level id for computer players.
  // Bots run inside the Host: they are not in `local` (this device sends no input for them).
  constructor({ games, settings, players }) {
    this.kind = 'local';
    if (!players?.length) players = [0, 1].map((slot) => ({ slot, name: 'Giocatore ' + (slot + 1) }));
    this.local = players.filter((p) => !p.bot).map((p) => p.slot).sort((a, b) => a - b);
    this.me = this.local[0];
    this.host = new Host({ games, seed: (Math.random() * 2 ** 32) >>> 0, settings });
    for (const p of players) if (!p.bot) this.host.setPlayer(p.slot, { name: p.name, char: p.char, connected: true });
    for (const p of players.filter((q) => q.bot).sort((a, b) => a.slot - b.slot)) this.addBotAt(p.slot, p.bot, p.char, p.name);
    // 2 vs 2: team of every place (0 = Rossa, 1 = Blu); without it the Host default applies (places 1–2 vs 3–4).
    for (const p of players) if (p.team === 0 || p.team === 1) this.host.command(p.slot, { type: 'team', target: p.slot, team: p.team });
    this.buf = new SnapBuffer();
    this.acc = 0;
    this.last = performance.now();
    this.status = 'open';
  }

  // Host.addBot takes the first free place: hold the free places before `slot` so the bot sits exactly there.
  addBotAt(slot, level, char, name) {
    const h = this.host;
    const held = h.players.map((p, i) => (i < slot && !p.on ? i : -1)).filter((i) => i >= 0);
    held.forEach((i) => { h.players[i].on = true; });
    const got = h.addBot(level, char);
    held.forEach((i) => { h.players[i].on = false; });
    if (got >= 0 && name) h.setPlayer(got, { name });
    h.seats = h.onSlots();
    return got;
  }

  input(slot, i) { this.host.input(slot, i); }
  cmd(slot, c) { this.host.command(slot, c); }
  setName(slot, name) { this.host.setPlayer(slot, { name }); }
  update(now) {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.acc += dt;
    let n = 0;
    while (this.acc >= DT && n < 6) {
      this.host.tick();
      this.buf.push(this.host.snapshot());
      this.acc -= DT;
      n++;
    }
    if (n >= 6) this.acc = 0;
  }
  renderTime() {
    const l = this.buf.latest();
    return l ? l.T - DT + this.acc : 0;
  }
  sample() {
    const rt = this.renderTime();
    return { ...this.buf.sample(rt), latest: this.buf.latest(), rt };
  }
  drain(rt) { return this.buf.drain(rt); }
  close() {}
}

export class NetSession {
  // makeSocket: optional factory of a WebSocket-like object (online P2P rooms, see p2p.js); default = real WebSocket.
  constructor(url, makeSocket = null) {
    this.kind = 'net';
    this.url = url;
    this.makeSocket = makeSocket;
    this.local = [];
    this.me = null;
    this.role = 'player';
    this.code = null;
    this.name = '';
    this.buf = new SnapBuffer();
    this.offset = null;
    this.jitter = 0.01;
    this.status = 'connecting';
    this.waiters = [];
    this.lastSent = {};   // per slot
    this.lastSentAt = {};
    this.extra = {};      // {local, names, chars}: several players on this device
    this.onStatus = () => {};
    this.onError = () => {};
    this.onJoined = () => {};
    this.closed = false;
    this.token = NetSession.token();
    this.connect();
  }

  connect() {
    this.ws = this.makeSocket ? this.makeSocket() : new WebSocket(this.url);
    this.ws.onopen = () => {
      this.status = 'open';
      this.onStatus(this.status);
      // Rejoin after a reconnect.
      if (this.code && !this.closed) this.rejoin();
      this.flushWaiters('open');
    };
    this.ws.onmessage = (e) => this.onMessage(e.data);
    this.ws.onclose = () => {
      this.joinedOk = false;
      if (this.closed) return;
      this.status = 'closed';
      this.onStatus(this.status);
      setTimeout(() => !this.closed && this.connect(), 1500);
    };
    this.ws.onerror = () => {};
  }

  // Stable per-browser token: lets a dropped phone get its own slot back.
  static token() {
    try {
      let t = sessionStorage.getItem('raffica.token');
      if (!t) { t = Math.random().toString(36).slice(2) + Date.now().toString(36); sessionStorage.setItem('raffica.token', t); }
      return t;
    } catch { return Math.random().toString(36).slice(2); }
  }

  rejoin() {
    this.send({ t: 'join', code: this.code, name: this.name, role: this.role, token: this.token, ...this.extra });
    clearTimeout(this.rejoinT);
    // If the server refuses (e.g. old socket still registered), keep trying until we are back.
    this.rejoinT = setTimeout(() => { if (!this.closed && this.status === 'open' && !this.joinedOk) this.rejoin(); }, 2500);
  }

  opened() {
    if (this.status === 'open') return Promise.resolve();
    return this.wait('open');
  }

  wait(type, timeout = 6000) {
    return new Promise((resolve, reject) => {
      const w = { type, resolve, reject };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) { this.waiters.splice(i, 1); reject(new Error('Tempo scaduto: il server non risponde')); }
      }, timeout);
    });
  }

  flushWaiters(type, msg) {
    for (const w of this.waiters.slice()) {
      if (w.type === type || (type === 'error' && w.type !== 'open')) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        if (type === 'error') w.reject(new Error(msg?.msg || 'Errore')); else w.resolve(msg);
      }
    }
  }

  onMessage(data) {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    switch (m.t) {
      case 'snap': this.onSnap(m.s); break;
      case 'joined':
        this.code = m.code; this.me = m.slot; this.role = m.role;
        this.local = Array.isArray(m.slots) ? m.slots.filter((x) => Number.isInteger(x)) : Number.isInteger(m.slot) ? [m.slot] : [];
        this.joinedOk = true;
        this.flushWaiters('joined', m);
        this.onJoined(m);
        break;
      case 'rooms': this.flushWaiters('rooms', m); break;
      case 'pong': break;
      case 'error': this.flushWaiters('error', m); this.onError(m.msg); break;
    }
  }

  onSnap(s) {
    const now = performance.now() / 1000;
    const o = s.T - now;
    if (this.offset === null || o > this.offset) this.offset = o;
    else {
      this.jitter = this.jitter * 0.97 + (this.offset - o) * 0.03;
      this.offset -= 0.0004; // slow decay keeps us on the low-latency envelope despite clock drift
    }
    this.buf.push(s);
  }

  send(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  // extra = {local: k, names: [...], chars: [...]} for k players on this device.
  async create(name, role = 'player', extra = {}) {
    await this.opened();
    this.name = name; this.role = role; this.extra = extra || {};
    this.send({ t: 'create', name, role, token: this.token, ...this.extra });
    return this.wait('joined');
  }

  async join(code, name, role = 'player', extra = {}) {
    await this.opened();
    this.name = name; this.role = role; this.extra = extra || {};
    this.send({ t: 'join', code: String(code).toUpperCase(), name, role, token: this.token, ...this.extra });
    return this.wait('joined');
  }

  async rooms() {
    await this.opened();
    this.send({ t: 'rooms' });
    const m = await this.wait('rooms');
    return m.list || [];
  }

  input(slot, i) {
    const now = performance.now();
    const prev = this.lastSent[slot];
    const changed = !prev || prev.ac !== i.ac || prev.bc !== i.bc || prev.a !== i.a || prev.b !== i.b ||
      Math.abs(prev.x - i.x) > 0.02 || Math.abs(prev.y - i.y) > 0.02 || Math.abs(prev.sx - i.sx) > 0.02 || Math.abs(prev.sy - i.sy) > 0.02;
    if (changed || now - (this.lastSentAt[slot] || 0) > 100) {
      this.send({ t: 'in', slot, i });
      this.lastSent[slot] = { ...i };
      this.lastSentAt[slot] = now;
    }
  }

  cmd(slot, c) { this.send({ t: 'cmd', slot, c }); }

  update() {}

  renderTime() {
    if (this.offset === null) return 0;
    const delay = Math.max(0.035, Math.min(0.2, 0.03 + this.jitter * 2.5));
    return performance.now() / 1000 + this.offset - delay;
  }

  sample() {
    const rt = this.renderTime();
    const s = this.buf.sample(rt);
    return s ? { ...s, latest: this.buf.latest(), rt } : null;
  }

  drain(rt) { return this.buf.drain(rt); }

  close() {
    this.closed = true;
    try { this.send({ t: 'leave' }); this.ws.close(); } catch { /* ignore */ }
  }
}
