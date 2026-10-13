// RAFFICA! client app: menus, sessions, input routing, audio and the render loop.
// Slots (0..3) are the room places; once a match starts every slot sits in a SEAT (game player 0..n-1).
// Inputs/commands go out per SLOT; layouts, sticks and game rendering work per SEAT.
import { GAMES } from '../core/games.js';
import { DEFAULT_SETTINGS, MAX_PLAYERS, DEFAULT_CHARS, CHAR_BY_ID, CHARACTERS, maxPlayersOf } from '../core/proto.js';
import { MOD_BY_ID } from '../core/mods.js';
import { BOT_LEVELS, BOT_NAMES } from '../core/bots.js';
import { LocalSession, NetSession } from './session.js';
import { P2PRoom, peerSocket } from './p2p.js';
import { Input, keyName, PAD_NAMES } from './input.js';
import { computeLayout, stickToWorld } from './layout.js';
import { Renderer } from './render.js';
import { interp } from './interp.js';
import { audio } from './audio.js';
import { UI } from './ui.js';

// Public site (GitHub Pages) used in invitation links / QR codes of online rooms.
const PUBLIC_URL = 'https://naplesonfirerefdaf.github.io/raffica/';

const store = {
  load(k, def) { try { const v = localStorage.getItem('raffica.' + k); return v ? JSON.parse(v) : def; } catch { return def; } },
  save(k, v) { try { localStorage.setItem('raffica.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const GAME_PHASES = new Set(['intro', 'countdown', 'play', 'finish', 'result']);
const SLOTS = [...Array(MAX_PLAYERS).keys()];
const EMPTY_L = { overlays: [], views: [], controls: [], physRot: [0, 0], viewRot: [0, 0] };

class App {
  constructor() {
    this.games = GAMES;
    this.byId = new Map(GAMES.map((g) => [g.id, g]));
    this.canvas = document.getElementById('game');
    this.renderer = new Renderer(this.canvas);
    this.input = new Input(this.canvas);
    this.ui = new UI(this);
    this.isTouch = matchMedia('(pointer: coarse)').matches;
    this.settings = { ...DEFAULT_SETTINGS, shake: true, ...store.load('settings', {}) };
    this.settings.only = null;
    this.audioSettings = { ...audio.settings, ...store.load('audio', {}) };
    // Music is off unless the player turns it on (v2 settings: older saves had it on by default).
    if (this.audioSettings.v !== 2) { this.audioSettings.music = 0; this.audioSettings.v = 2; }
    const names = store.load('names', []), chars = store.load('chars', []);
    this.names = SLOTS.map((i) => (typeof names?.[i] === 'string' && names[i].trim() ? names[i].trim().slice(0, 12) : `Giocatore ${i + 1}`));
    this.chars = SLOTS.map((i) => (CHAR_BY_ID[chars?.[i]] ? chars[i] : DEFAULT_CHARS[i]));
    this.input.setKeys(store.load('keys', null));
    this.input.setPadMap(store.load('pad', null));
    // Devices of the players sitting at THIS screen, per slot: {kb:[keyboard set], pads:[gamepad.index]}.
    this.ctl = SLOTS.map(() => null);
    // "Unisciti!" screen (local play): who took a place and who is ready.
    // Computer players: {on, rdy: true, bot: level id, name, char} (always ready, no devices).
    this.joined = SLOTS.map(() => ({ on: false, rdy: false }));
    this.botLevel = BOT_LEVELS.some((l) => l.id === store.load('botLevel', 'medio')) ? store.load('botLevel', 'medio') : 'medio';
    this.joinOnly = null;   // practice: [gameId]
    this.autoPads = false;  // dev mode / several players in network play: a new controller goes to a player without one
    this.devIdle = false;   // dev mode: players without devices are auto-ready
    this.netLocal = 1;      // players on this device in network play
    this.layoutPref = null;
    this.padView = false;
    this.session = null;
    this.net = null;
    this.counters = SLOTS.map(() => ({ ac: 0, bc: 0, aT: -1, bT: -1, pa: null, pb: null }));
    this.lastPhase = null;
    this.rouletteIdx = -1;
    this.lastSay = 0;
    this.last = performance.now();
    this.applyAudio();

    this.input.on((ev) => this.onInputEvent(ev));
    const unlock = () => { audio.unlock(); };
    addEventListener('pointerdown', unlock, { capture: true });
    addEventListener('keydown', unlock, { capture: true });
    const pb = document.getElementById('pauseBtn');
    pb.tabIndex = -1;
    pb.addEventListener('mousedown', (e) => e.preventDefault());
    pb.addEventListener('click', () => { pb.blur(); this.togglePause(); });
    addEventListener('resize', () => this.renderer.resize());
    document.addEventListener('visibilitychange', () => {
      // Pause local games when the tab really goes to the background (ignore brief flickers).
      if (document.hidden && this.session?.kind === 'local') setTimeout(() => { if (document.hidden) this.pauseIfPlaying(); }, 600);
    });

    this.ui.show('home');
    audio.music('menu');
    this.handleUrl();
    requestAnimationFrame((t) => this.loop(t));
  }

  // ---------- helpers used by UI ----------
  click() { this.sound('click'); }
  sound(n, o) { audio.sfx(n, o); }
  speak(text) { audio.say(text); }
  toast(msg, ms = 2600) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(this.toastT);
    this.toastT = setTimeout(() => t.classList.add('hidden'), ms);
  }
  saveSettings() { store.save('settings', { target: this.settings.target, crazy: this.settings.crazy, variants: this.settings.variants, loserPicks: this.settings.loserPicks, shake: this.settings.shake, gfx3d: this.settings.gfx3d }); }
  saveNames() { store.save('names', this.names); }
  saveChars() { store.save('chars', this.chars); }
  applyAudio() {
    Object.assign(audio.settings, this.audioSettings);
    audio.applySettings();
    store.save('audio', this.audioSettings);
  }
  localMode() {
    if (this.layoutPref) return this.layoutPref;
    return this.isTouch ? 'shared' : 'pc';
  }
  gameById(id) { return this.byId.get(id); }
  // Games that can be played by n players (with the practice restriction, if any).
  gamesFor(n, only = null) {
    const list = only?.length ? only.map((id) => this.byId.get(id)).filter(Boolean) : this.games;
    return list.filter((d) => maxPlayersOf(d) >= n);
  }
  // Next/previous character id.
  cycleChar(id, dir) {
    const k = CHARACTERS.findIndex((c) => c.id === id);
    return CHARACTERS[(k + dir + CHARACTERS.length * 2) % CHARACTERS.length].id;
  }

  // ---------- sessions ----------
  // players: [{slot, name, char, bot?}] sitting at this device (bot = level id of a computer player).
  startLocal({ players, only = null, target = null } = {}) {
    if (!players || players.length < 2) { this.toast('Servono almeno 2 giocatori'); return false; }
    this.endSession();
    const settings = { ...this.settings, only, target: target || this.settings.target };
    this.session = new LocalSession({ games: this.games, settings, players });
    const mode = this.localMode();
    this.mode = mode === 'shared' && players.length > 2 ? 'pc' : mode;
    this.me = this.session.local[0] ?? players[0].slot; // only bots (dev mode): watch from the first place
    this.resetCounters();
    this.session.cmd(this.me, { type: 'start', only });
    this.ui.hide();
    this.goFullscreen();
    return true;
  }

  // Players of the "Unisciti!" screen, in slot order.
  joinedPlayers() {
    return SLOTS.filter((s) => this.joined[s].on).map((slot) => {
      const j = this.joined[slot];
      return j.bot ? { slot, name: j.name, char: j.char, bot: j.bot } : { slot, name: this.names[slot], char: this.chars[slot] };
    });
  }

  // ---------- computer players ----------
  levelOf(id) { return BOT_LEVELS.find((l) => l.id === id) || BOT_LEVELS[1]; }
  cycleLevel(id, dir) {
    const k = BOT_LEVELS.findIndex((l) => l.id === id);
    return BOT_LEVELS[(Math.max(0, k) + dir + BOT_LEVELS.length) % BOT_LEVELS.length].id;
  }
  rememberLevel(id) { this.botLevel = id; store.save('botLevel', id); }

  // A local ("Unisciti!") bot in place s: a funny name and a character nobody else has.
  makeLocalBot(s, level = this.botLevel) {
    const taken = SLOTS.filter((q) => q !== s && this.joined[q].on);
    const names = new Set(taken.map((q) => (this.joined[q].bot ? this.joined[q].name : this.names[q])));
    const chars = new Set(taken.map((q) => (this.joined[q].bot ? this.joined[q].char : this.chars[q])));
    const freeNames = BOT_NAMES.filter((n) => !names.has(n));
    const freeChars = CHARACTERS.filter((c) => !chars.has(c.id));
    const pick = (l) => l[Math.floor(Math.random() * l.length)];
    this.joined[s] = {
      on: true, rdy: true, bot: level,
      name: freeNames.length ? pick(freeNames) : `Bot ${s + 1}`,
      char: (freeChars.length ? pick(freeChars) : pick(CHARACTERS)).id,
    };
    this.ctl[s] = null;
  }

  // ---------- network lobby bots (any player in the room may add/remove them) ----------
  netCmdSlot() { const s = this.session; return s?.kind === 'net' && s.local.length ? s.local[0] : null; }
  netAddBot(level = this.botLevel) {
    const from = this.netCmdSlot();
    if (from === null) return;
    this.session.cmd(from, { type: 'bot', level });
    this.sound('powerup');
  }
  netBotLevel(slot, dir) {
    const from = this.netCmdSlot();
    const pl = this.session?.sample?.()?.latest?.pl?.[slot];
    if (from === null || !pl?.bot) return;
    const level = this.cycleLevel(pl.bot, dir);
    this.rememberLevel(level);
    this.session.cmd(from, { type: 'bot', target: slot, level });
    this.sound('tick');
  }
  netRemoveBot(slot) {
    const from = this.netCmdSlot();
    if (from === null) return;
    this.session.cmd(from, { type: 'bot', target: slot, level: null });
    this.sound('back');
  }
  netBotChar(slot, dir) {
    const from = this.netCmdSlot();
    const pl = this.session?.sample?.()?.latest?.pl?.[slot];
    if (from === null || !pl?.bot) return;
    this.session.cmd(from, { type: 'bot', target: slot, c: this.cycleChar(pl.c, dir) });
    this.sound('tick');
  }

  endSession() {
    if (this.session && this.session !== this.net) this.session.close();
    this.session = null;
    this.lastPhase = null;
    document.getElementById('pauseBtn').classList.add('hidden');
  }

  // Is our Node server behind this page? (no on the public site / installed apps: then online = P2P only)
  async hasServer() {
    if (this.serverOk === undefined) {
      if (location.protocol === 'file:' || location.protocol === 'capacitor:' || /github\.io$|pages\.dev$/.test(location.hostname)) this.serverOk = false;
      else {
        try { const r = await fetch('/api/info', { cache: 'no-store' }); this.serverOk = r.ok && !!(await r.json()).port; } catch { this.serverOk = false; }
      }
    }
    return this.serverOk;
  }

  // kind: 'server' (WebSocket to server.js), 'p2p-host' (this device runs the room), 'p2p' (join a P2P room by code).
  ensureNet(kind = 'server', code = null) {
    const want = kind === 'server' ? 'server' : kind === 'p2p-host' ? 'p2p-host' : `p2p:${code}`;
    if (this.net && !this.net.closed && this.netKind !== want) this.leaveNet();
    if (!this.net || this.net.closed) {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      this.netKind = want;
      if (kind === 'p2p-host') this.net = new NetSession('p2p-host', () => this.p2pRoom.loopback());
      else if (kind === 'p2p') this.net = new NetSession(`p2p:${code}`, () => peerSocket(code));
      else this.net = new NetSession(`${proto}://${location.host}/ws`);
      this.net.onError = (msg) => this.toast('⚠️ ' + msg);
      this.net.onJoined = (m) => {
        if (this.session !== this.net) return;
        if (m.slot !== this.me) { this.me = m.slot ?? 0; this.resetCounters(); }
        this.setupNetCtl();
        this.toast(m.slot === null ? 'Collegato come TV' : 'Collegato ✓', 1200);
      };
      this.net.onStatus = (st) => { if (st === 'closed' && this.session === this.net) this.toast('Connessione persa… riprovo'); };
    }
    return this.net;
  }

  async netRooms() {
    if (!(await this.hasServer())) return []; // online P2P rooms are joined by code only
    return this.ensureNet('server').rooms();
  }

  // Extra join info when several players share this device.
  netExtra(role) {
    if (role !== 'player') return {};
    const k = Math.max(1, Math.min(2, this.netLocal));
    return { local: k, names: this.names.slice(0, k), chars: this.chars.slice(0, k) };
  }

  // New room: online (P2P, reachable from anywhere with the code) when the internet handshake works; otherwise
  // a room on the PC server (same Wi-Fi / tunnel).
  async createNet(name, role) {
    try {
      if (role === 'player') { this.names[0] = name; this.saveNames(); }
      let n = null;
      if (role === 'player') {
        try {
          this.toast('Apro la stanza online…', 1500);
          this.leaveNet();
          this.p2pRoom = new P2PRoom(this.games);
          await this.p2pRoom.open();
          n = this.ensureNet('p2p-host');
        } catch (err) {
          this.p2pRoom?.close(); this.p2pRoom = null;
          if (!(await this.hasServer())) throw new Error('Online non disponibile: ' + (err.message || 'controlla la connessione'));
          this.toast('Online non disponibile: stanza sulla rete di casa', 2500);
        }
      }
      if (!n) n = this.ensureNet('server');
      await n.create(name, role, this.netExtra(role));
      this.enterNet(role);
    } catch (err) { this.toast('⚠️ ' + err.message); }
  }

  // Join by code: first the online (P2P) room with that code, then a room on the PC server.
  async joinNet(code, name, role = 'player') {
    try {
      if (role === 'player') { this.names[0] = name; this.saveNames(); }
      code = String(code || '').trim().toUpperCase();
      let n = null, m = null;
      try {
        n = this.ensureNet('p2p', code);
        // Fail fast when the code does not exist (the socket closes) instead of retrying forever.
        await new Promise((res, rej) => {
          if (n.status === 'open') return res();
          const prev = n.onStatus;
          n.onStatus = (st) => { prev(st); if (st === 'open') res(); else if (st === 'closed') rej(new Error('Stanza non trovata')); };
          setTimeout(() => rej(new Error('Nessuna risposta')), 15000);
        });
        m = await n.join(code, name, role, this.netExtra(role));
      } catch (err) {
        this.leaveNet();
        if (!(await this.hasServer())) throw new Error('Stanza non trovata (controlla il codice e la connessione)');
        n = this.ensureNet('server');
        m = await n.join(code, name, role, this.netExtra(role));
      }
      if (role === 'player' && this.netLocal > 1 && (m?.slots?.length || 0) < this.netLocal) this.toast('C\'era posto solo per un giocatore di questo dispositivo');
      this.enterNet(role);
    } catch (err) { this.toast('⚠️ ' + err.message); }
  }

  enterNet(role) {
    this.session = this.net;
    this.me = this.net.me ?? 0;
    this.setupNetCtl();
    this.mode = role === 'tv' ? 'tv' : this.net.local.length > 1 ? 'pc' : 'solo';
    this.resetCounters();
    this.lastPhase = null;
    this.ui.show('lobby');
    this.pushSettings();
  }

  // Network play: with one player here every device drives it; with two, keyboard set k drives local player k
  // and controllers are handed out on their first press.
  setupNetCtl() {
    const loc = this.net?.local || [];
    this.ctl = SLOTS.map(() => null);
    loc.forEach((sl, k) => { this.ctl[sl] = { kb: [k], pads: [] }; });
    this.autoPads = loc.length > 1;
    this.devIdle = false;
    if (this.session === this.net) this.mode = this.net.role === 'tv' ? 'tv' : loc.length > 1 ? 'pc' : 'solo';
  }

  leaveNet() {
    if (this.net) { this.net.close(); this.net = null; }
    if (this.p2pRoom) { this.p2pRoom.close(); this.p2pRoom = null; }
    this.netKind = null;
    if (this.session && this.session.kind === 'net') this.session = null;
    this.ctl = SLOTS.map(() => null);
    this.autoPads = false;
    this.lastPhase = null;
  }

  pushSettings() {
    if (this.session?.kind !== 'net' || this.session.me === null) return;
    const s = this.settings;
    this.session.cmd(this.session.me, { type: 'settings', settings: { target: s.target, crazy: s.crazy, variants: s.variants, loserPicks: s.loserPicks } });
  }

  // Change the character of a local player (lobby / "Unisciti!").
  setNetChar(slot, dir) {
    const s = this.session;
    if (s?.kind !== 'net' || !s.local.includes(slot)) return;
    const k = s.local.indexOf(slot);
    const cur = s.sample?.()?.latest?.pl?.[slot]?.c || this.chars[k];
    const next = this.cycleChar(cur, dir);
    this.chars[k] = next;
    this.saveChars();
    if (s.extra?.chars) s.extra.chars[k] = next; // a reconnect keeps the new character
    s.cmd(slot, { type: 'char', c: next });
    this.sound('tick');
  }

  async joinUrl(code) {
    // Online P2P room: the link is the public site (works from anywhere, also installs the app).
    if (this.p2pRoom) {
      const base = /^https:/.test(location.origin) && !/^(localhost|127\.)/.test(location.hostname) ? location.origin + location.pathname.replace(/[^/]*$/, '') : PUBLIC_URL;
      return { url: `${base}?room=${code}`, tvUrl: `${base}?tv=${code}`, online: true };
    }
    // Through the online tunnel (https) or a LAN address the page origin is already the right link.
    if (location.protocol === 'https:' || !/^(localhost|127\.)/.test(location.hostname)) {
      return { url: `${location.origin}/?room=${code}`, tvUrl: `${location.origin}/?tv=${code}`, online: location.protocol === 'https:' };
    }
    let host = location.host;
    try {
      const info = await (await fetch('/api/info')).json();
      if (info.ips?.length) host = `${info.ips[0]}:${info.port}`;
    } catch { /* keep localhost */ }
    return { url: `http://${host}/?room=${code}`, tvUrl: `http://${host}/?tv=${code}`, online: false };
  }

  handleUrl() {
    const q = new URLSearchParams(location.search);
    const room = q.get('room'), tv = q.get('tv'), dev = q.get('dev');
    if (room) {
      this.ui.show('netHome');
      setTimeout(() => {
        const inp = document.getElementById('code');
        if (inp) inp.value = room.toUpperCase();
        this.toast(`Stanza ${room.toUpperCase()}: scrivi il tuo nome e premi Entra`);
      }, 50);
    } else if (tv) {
      this.joinNet(tv, 'TV', 'tv');
    } else if (dev && this.byId.has(dev)) {
      // Developer shortcut: ?dev=<gameId>&v=<variant>&m=<mod>&n=<0..4>&bots=<level,level…>&layout=shared|pc
      // Players 1–2 use the two keyboard sets (F / K = ready), the others stand still and are auto-ready.
      // bots = computer players in the places after the humans (e.g. &n=1&bots=difficile, &n=0&bots=facile,difficile).
      if (q.get('layout')) this.layoutPref = q.get('layout');
      const bots = (q.get('bots') || '').split(',').map((b) => b.trim()).filter((b) => BOT_LEVELS.some((l) => l.id === b));
      const nq = q.has('n') ? Number(q.get('n')) : NaN;
      let n = Number.isFinite(nq) ? Math.max(0, Math.min(MAX_PLAYERS, Math.round(nq))) : bots.length ? 1 : 2;
      bots.splice(MAX_PLAYERS - n);
      if (n + bots.length < 2) n = 2 - bots.length;
      const players = SLOTS.slice(0, n).map((slot) => ({ slot, name: this.names[slot], char: this.chars[slot] }));
      bots.forEach((level, k) => {
        const slot = n + k;
        this.makeLocalBot(slot, level);
        const j = this.joined[slot];
        players.push({ slot, name: j.name, char: j.char, bot: level });
      });
      this.ctl = SLOTS.map((i) => (i < 2 ? { kb: [i], pads: [] } : null));
      this.autoPads = true;
      this.devIdle = true;
      this.startLocal({ players, only: [dev], target: 3 });
      const m = q.get('m');
      this.session.cmd(0, { type: 'debug', id: dev, v: q.get('v'), m: m && MOD_BY_ID[m] ? [m] : [] });
    }
  }

  goFullscreen() {
    if (!this.isTouch) return;
    const el = document.documentElement;
    try { if (!document.fullscreenElement && el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {}); } catch { /* unsupported */ }
    try { navigator.wakeLock?.request('screen').catch(() => {}); } catch { /* insecure context */ }
  }

  resetCounters() {
    for (const c of this.counters) Object.assign(c, { ac: 0, bc: 0, aT: -1, bT: -1, pa: null, pb: null });
  }

  // ---------- input ----------
  onInputEvent(ev) {
    if (ev.type === 'press' && ev.src === 'pad') this.autoAssignPad(ev.idx);
    // The "Unisciti!" and lobby screens read each device on its own (A = join, ◀ ▶ = character…).
    if (this.ui.visible() && this.ui.deviceInput(ev)) return;
    if (ev.type === 'nav') {
      if (this.ui.visible()) this.ui.nav(ev);
      return;
    }
    if (ev.type === 'pause') this.togglePause();
    if (ev.type === 'music') this.toggleMusic();
  }

  toggleMusic() {
    this.audioSettings.music = this.audioSettings.music > 0 ? 0 : 0.35;
    this.applyAudio();
    this.toast(this.audioSettings.music > 0 ? '🎵 Musica accesa' : '🔇 Musica spenta', 1200);
  }

  togglePause() {
    const s = this.session;
    if (!s || this.ui.visible() || !s.local.length) return;
    const snap = s.sample?.()?.latest;
    if (!snap || snap.ph === 'lobby' || snap.ph === 'final') return;
    s.cmd(s.local[0], { type: 'pause', on: snap.ph !== 'pause' });
  }

  pauseIfPlaying() {
    const s = this.session;
    const snap = s?.sample?.()?.latest;
    if (s?.local.length && snap && snap.ph !== 'pause' && snap.ph !== 'lobby' && snap.ph !== 'final') s.cmd(s.local[0], { type: 'pause', on: true });
  }

  // "Press ✕ to join" (dev mode / two players on one device in network play): an unassigned controller
  // goes to the first local player without one.
  autoAssignPad(index) {
    const s = this.session;
    if (!this.autoPads || !s) return;
    if (this.ctl.some((c) => c?.pads.includes(index))) return;
    const slot = s.local.find((sl) => this.ctl[sl] && !this.ctl[sl].pads.length);
    if (slot === undefined) return;
    this.ctl[slot].pads.push(index);
    this.toast(`🎮 ${this.input.padLabel(index)} → ${this.names[s.local.indexOf(slot)] || this.names[slot]}`);
    this.sound('powerup');
    this.ui.refreshControls?.();
  }

  saveKeys() { store.save('keys', this.input.keys); store.save('pad', this.input.padMap); }

  // Single network player: every keyboard set, controller and the touch screen drive it.
  netSingle() { return this.session?.kind === 'net' && this.session.local.length === 1; }

  // Real keys of a player for each input, shown in the rule card table.
  keyTexts(slot) {
    const single = this.netSingle();
    const c = this.ctl[slot];
    const touchOnly = (single && this.isTouch) || (this.session?.kind === 'local' && this.mode === 'shared' && !c?.kb?.length && !c?.pads?.length);
    const out = { dir: [], a: [], b: [] };
    if (touchOnly) { out.dir.push('joystick'); out.a.push('tasto A'); out.b.push('tasto B'); }
    const sets = single ? (touchOnly && !this.input.pads().length ? [] : [0, 1]) : c?.kb || [];
    for (const k of sets) {
      const m = this.input.keys[k];
      const dir = [m.up[0], m.left[0], m.down[0], m.right[0]];
      out.dir.push(dir.join() === 'KeyW,KeyA,KeyS,KeyD' ? 'WASD' : dir.join() === 'ArrowUp,ArrowLeft,ArrowDown,ArrowRight' ? 'Frecce' : dir.map(keyName).join(''));
      const names = (l) => l.filter((x, i) => i === 0 || !x.startsWith('Numpad')).slice(0, 2).map(keyName).join('/');
      out.a.push(names(m.a));
      out.b.push(names(m.b));
    }
    const hasPad = single ? this.input.pads().length > 0 : !!c?.pads?.length;
    if (hasPad) {
      out.dir.push('🎮 stick');
      out.a.push('🎮 ' + this.input.padMap.a.map((i) => PAD_NAMES[i]).join(''));
      out.b.push('🎮 ' + this.input.padMap.b.map((i) => PAD_NAMES[i]).join(''));
    }
    return { dir: out.dir.join(' · '), a: out.a.join(' · '), b: out.b.join(' · ') };
  }

  // Devices of a local player. seat = its seat in the running game (touch pads follow the seat on a shared phone).
  sourcesFor(slot, seat) {
    const touchOn = this.touchActive();
    if (this.netSingle()) return { kb: [0, 1], pads: 'all', touch: touchOn ? 0 : null };
    const c = this.ctl[slot] || { kb: [], pads: [] };
    const touch = touchOn && this.session.kind === 'local' && this.mode === 'shared' && seat >= 0 && seat < 2 ? seat : null;
    return { kb: c.kb, pads: c.pads, touch };
  }

  touchActive() {
    if (!this.session) return false;
    if (this.session.kind === 'local') return this.mode === 'shared';
    return this.mode !== 'tv' && this.mode !== 'pc' && (this.isTouch || this.input.hasTouchRecently());
  }

  touchCfg(slot, snap, def) {
    if (!snap) return null;
    const ph = snap.ph;
    if (ph === 'lobby') return null;
    if ((ph === 'intro' || ph === 'countdown' || ph === 'play' || ph === 'finish') && def) {
      const c = def.controls || {};
      return { dir: c.dir || null, a: c.a || (ph === 'intro' ? 'Pronto' : null), b: c.b || null, dirLabel: c.dirLabel || c.label };
    }
    if (ph === 'pick') return slot === snap.x?.who ? { dir: 'h', a: 'Scegli', dirLabel: 'Scegli' } : { a: '…' };
    if (ph === 'final') return { a: 'Rivincita', b: 'Menu' };
    if (ph === 'pause') return { a: 'Riprendi', b: 'Esci' };
    return { a: 'Avanti' };
  }

  sendInputs(L, rt, pads, snap) {
    const s = this.session;
    const seats = snap?.seats || [];
    const pressed = [];
    for (const slot of s.local) {
      const seat = seats.indexOf(slot);
      const raw = this.input.read(this.sourcesFor(slot, seat), pads);
      const c = this.counters[slot];
      if (c.pa === null) { c.pa = raw.pa; c.pb = raw.pb; }
      const da = raw.pa - c.pa, db = raw.pb - c.pb;
      c.pa = raw.pa; c.pb = raw.pb;
      if (da > 0) { c.ac += da; c.aT = rt; }
      if (db > 0) { c.bc += db; c.bT = rt; }
      const w = seat >= 0 ? stickToWorld(L, seat, raw.x, raw.y) : { x: raw.x, y: raw.y };
      s.input(slot, { x: w.x, y: w.y, sx: raw.x, sy: raw.y, a: raw.a, b: raw.b, ac: c.ac, bc: c.bc, aT: c.aT, bT: c.bT });
      pressed.push({ slot, a: da > 0, b: db > 0 });
    }
    // Client-side commands for menu-like phases.
    if (!snap) return;
    // Dev mode: seats without a device never press A on the rule card.
    if (this.devIdle && snap.ph === 'intro') {
      for (const slot of s.local) if (!this.ctl[slot] && seats.includes(slot) && !snap.pl?.[slot]?.rdy) s.cmd(slot, { type: 'ready' });
    }
    for (const p of pressed) {
      if (snap.ph === 'final' && snap.pt > 2) {
        if (p.a) s.cmd(p.slot, { type: 'rematch' });
        else if (p.b) s.cmd(p.slot, { type: 'menu' });
      } else if (snap.ph === 'pause' && snap.pt > 0.8) {
        if (p.a) s.cmd(p.slot, { type: 'pause', on: false });
        else if (p.b) s.cmd(p.slot, { type: 'menu' });
      } else if (snap.ph === 'result' && snap.pt > 1.2 && p.a) s.cmd(p.slot, { type: 'skip' });
    }
  }

  // ---------- events & phases ----------
  handleEvents(events, snap) {
    const festa = snap?.g?.m?.includes('festa');
    this.renderer.fx.seats = snap?.seats?.length ? snap.seats : null;
    for (const e of events) {
      if (e.k === 'sfx') audio.sfx(e.n, { vol: e.v ?? 1, pitch: e.p ?? 1 });
      else if (e.k === 'vib') {
        if (this.session.local.includes(e.p) && navigator.vibrate && (this.session.kind === 'net' || this.mode === 'shared')) {
          try { navigator.vibrate(Math.min(400, e.ms || 60)); } catch { /* ignore */ }
        }
      } else {
        this.renderer.fx.event(e, { shake: this.settings.shake !== false });
        if (e.k === 'say' && !e.big && performance.now() - this.lastSay > 1800 && e.s.length < 34) {
          this.lastSay = performance.now();
          audio.say(e.s.replace(/[^\p{L}\p{N}\s!?'.,]/gu, ''), { interrupt: false });
        }
        if (festa && e.k === 'fx' && e.f === 'burst') {
          this.renderer.fx.confetti(e.x, e.y, 24);
          if (Math.random() < 0.3) audio.crowd('cheer');
        }
      }
    }
  }

  onPhase(snap, prev) {
    const ph = snap.ph;
    const def = snap.g ? this.byId.get(snap.g.id) : null;
    const pauseBtn = document.getElementById('pauseBtn');
    // Only while playing: in the other phases the button would cover cards and banners.
    pauseBtn.classList.toggle('hidden', !['countdown', 'play', 'finish'].includes(ph) || this.mode === 'tv');
    pauseBtn.classList.toggle('shared', this.mode === 'shared');
    if (ph === 'lobby') {
      if (this.session.kind === 'local') {
        // Back to "Unisciti!" with the same players (they confirm again).
        const was = this.session.local;
        this.endSession();
        this.joined.forEach((j, s) => {
          if (j.bot) { j.on = true; j.rdy = true; return; } // bots stay seated (always ready)
          j.on = was.includes(s) && (this.ctl[s] !== null || j.on); j.rdy = false;
        });
        this.devIdle = false;
        this.ui.show('join', { only: this.joinOnly });
        audio.music('menu');
      } else { if (this.ui.screen !== 'lobby') this.ui.show('lobby'); audio.music('menu'); }
      return;
    }
    if (this.ui.visible() && this.session) this.ui.hide();
    const matchPoint = snap.seats?.some((s) => snap.sc?.[s] >= (snap.tg || 5) - 1);
    if (ph === 'roulette' || ph === 'pick') audio.music(matchPoint ? 'tense' : 'game');
    if (ph === 'intro' && def) {
      audio.say(`${def.name}! ${def.verb || ''}`);
      if (snap.x?.m?.length) setTimeout(() => audio.sfx('slotstop'), 600);
    }
    if (ph === 'play') audio.setTempo(1);
    if (ph === 'result') {
      const w = snap.x?.w;
      if (Number.isInteger(w) && w >= 0) {
        // One player here: their own win/loss. Several players on this screen: always a party.
        const mine = this.session.local.length === 1 ? w === this.me : true;
        audio.sfx(mine ? 'win' : 'lose');
        audio.crowd(mine ? 'cheer' : 'aww');
        const name = snap.pl?.[w]?.n || this.names[w];
        audio.say(snap.x.matchPoint === w ? `Punto a ${name}. Match point!` : `Punto a ${name}!`);
        this.renderer.fx.confetti(this.renderer.W / 2, this.renderer.H * 0.4, 50);
      } else {
        audio.crowd('ooh');
        audio.say(snap.x?.replay ? 'Pareggio! Si rigioca in turbo!' : 'Pareggio!');
      }
    }
    if (ph === 'final') {
      audio.music('final');
      audio.crowd('cheer');
      const w = snap.x?.w;
      const name = snap.pl?.[w]?.n || this.names[w] || '';
      audio.say(`${name} è il campione di Raffica!`);
    }
    void prev;
  }

  // ---------- main loop ----------
  loop(now) {
    requestAnimationFrame((t) => this.loop(t));
    const P = window.__perf;
    if (P) P.frame(now);
    const t0 = performance.now();
    try { this.loopBody(now); } finally { if (P) P.add('total', performance.now() - t0); }
  }

  loopBody(now) {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.renderer.resize();
    const pads = this.input.pollPads();
    const s = this.session;
    const W = this.renderer.W, H = this.renderer.H;
    const base = { dt, now, settings: this.settings, names: this.names, games: this.games, gameById: (id) => this.byId.get(id), input: this.input };

    if (!s || this.ui.visible()) {
      this.input.inGame = false;
      // Menus: animated background only (plus lobby updates in network mode).
      if (s?.kind === 'net') {
        const smp = s.sample();
        if (smp?.latest) {
          this.ui.updateLobby(smp.latest);
          if (smp.latest.ph !== this.lastPhase) { const prev = this.lastPhase; this.lastPhase = smp.latest.ph; this.onPhase(smp.latest, prev); }
          s.drain(smp.rt);
          if (s.local.length) this.sendInputs(computeLayout({ W, H, mode: 'solo', me: 0 }), smp.rt, pads, null);
        }
      }
      this.ui.tick(dt, now);
      this.renderer.frame({ ...base, snap: null, L: EMPTY_L });
      return;
    }

    const ts = performance.now();
    s.update(now);
    if (window.__perf) window.__perf.add('sim', performance.now() - ts);
    const smp = s.sample();
    if (!smp || !smp.b) { this.renderer.frame({ ...base, snap: null, L: EMPTY_L }); return; }
    const rt = smp.rt;
    this.input.clock = () => rt;
    const snap = smp.b;
    const latest = smp.latest;
    // Phase changes are driven by the newest snapshot so menus react instantly.
    if (latest.ph !== this.lastPhase && !(s.kind === 'local' && this.lastPhase === null && latest.ph === 'lobby')) {
      const prev = this.lastPhase;
      this.lastPhase = latest.ph;
      this.onPhase(latest, prev);
      if (!this.session || this.ui.visible()) return;
    }
    if (latest.ph === 'lobby') { this.ui.updateLobby(latest); }
    this.handleEvents(s.drain(rt), snap);

    const def = snap.g ? this.byId.get(snap.g.id) : null;
    let gview = snap.g?.view || null;
    const a = smp.a;
    if (gview && a?.g && a.g.id === snap.g.id && a.g.st === snap.g.st && a.g.view && smp.t < 1) {
      try { gview = interp(a.g.view, snap.g.view, smp.t); } catch { gview = snap.g.view; }
    }
    // Roulette ticks.
    if (snap.ph === 'roulette' && snap.x?.list) {
      const n = snap.x.list.length;
      const pos = Math.floor((1 - Math.pow(1 - Math.min(1, snap.pt / (snap.pd * 0.85)), 3)) * (n - 1) + 0.5);
      if (pos !== this.rouletteIdx) { this.rouletteIdx = pos; audio.sfx('slot', { pitch: 0.9 + pos * 0.03 }); }
    } else this.rouletteIdx = -1;
    // Urgency music.
    if (snap.ph === 'play' && snap.g) audio.setTempo(snap.g.left < 10 ? 1.15 : 1);

    const seats = snap.seats?.length ? snap.seats : s.local.slice(0, 2);
    const n = Math.max(2, seats.length);
    const mySeat = Math.max(0, seats.indexOf(this.me));
    const mode = this.mode === 'solo' && this.padView ? 'pad' : this.mode;
    const showGame = GAME_PHASES.has(snap.ph) || snap.ph === 'pause';
    const touchOn = this.touchActive();
    const L = computeLayout({ W, H, mode, me: mySeat, n, def: showGame ? def : null, touch: touchOn });
    const pb = document.getElementById('pauseBtn');
    pb.style.top = L.mode === 'shared' ? '' : `${(L.hudTop || 0) + 6}px`;
    // Touch pads (0/1) -> the local player using them.
    const cfgs = [0, 1].map((t) => {
      const c = touchOn ? L.controls.find((q) => q.t === t) : null;
      if (!c) return null;
      const slot = L.mode === 'solo' || L.mode === 'pad' ? this.me : seats[c.seat];
      return s.local.includes(slot) ? this.touchCfg(slot, snap, def) : null;
    });
    this.input.setTouch(touchOn ? L.controls.filter((c) => cfgs[c.t]) : [], cfgs);
    if (s.local.length) this.sendInputs(L, rt, pads, latest);

    this.input.inGame = true;
    this.renderer.frame({
      ...base,
      keys: SLOTS.map((sl) => (s.local.includes(sl) ? this.keyTexts(sl) : null)),
      snap, gview: showGame ? gview : null, def: showGame ? def : null, L, mode: L.mode, me: this.me, mySeat, seats, n,
      local: s.local, names: snap.pl?.map((p) => p.n) || this.names, cfgs,
    });
  }
}

// ?perf=1: frame-time meter (corner overlay + window.__perf.report()) to hunt stutters.
if (new URLSearchParams(location.search).has('perf')) {
  const P = window.__perf = {
    n: 0, last: 0, sums: {}, maxs: {}, gaps: [], long: 0, progs: 0, newProgs: [],
    frame(now) {
      if (P.last) { const g = now - P.last; P.gaps.push(g); if (P.gaps.length > 600) P.gaps.shift(); if (g > 25) P.long++; }
      P.last = now; P.n++;
      const pr = window.raffica?.renderer?.stage?.renderer?.info?.programs?.length || 0;
      if (P.progs && pr > P.progs) P.newProgs.push(`+${pr - P.progs} @${(P.gaps[P.gaps.length - 1] || 0).toFixed(0)}ms`);
      P.progs = pr;
    },
    add(k, ms) { P.sums[k] = (P.sums[k] || 0) + ms; P.maxs[k] = Math.max(P.maxs[k] || 0, ms); },
    report() {
      const g = P.gaps.slice().sort((a, b) => a - b), q = (p) => (g[Math.floor(p * (g.length - 1))] || 0).toFixed(1);
      const avg = (k) => ((P.sums[k] || 0) / Math.max(1, P.n)).toFixed(2), mx = (k) => (P.maxs[k] || 0).toFixed(1);
      const info = window.raffica?.renderer?.stage?.renderer?.info?.render;
      return `fps ${(1000 / (g.reduce((a, b) => a + b, 0) / Math.max(1, g.length))).toFixed(0)} · frame p50 ${q(0.5)} p95 ${q(0.95)} max ${q(1)} ms · lunghi ${P.long}\n` +
        `cpu/frame: tot ${avg('total')} (max ${mx('total')}) · sim ${avg('sim')} (max ${mx('sim')}) · 3D ${avg('r3d')} (max ${mx('r3d')}) [upd ${avg('upd')}/${mx('upd')} layer ${avg('layers')}/${mx('layers')} tick ${avg('ticks')}/${mx('ticks')}] ms · draw ${info?.calls ?? '-'} tri ${info?.triangles ?? '-'} · upload ${avg('upKpx')} kpx/frame` + (P.newProgs.length ? `
shader nuovi in partita: ${P.newProgs.slice(-6).join(' ')}` : '');
    },
    reset() { P.n = 0; P.sums = {}; P.maxs = {}; P.gaps = []; P.long = 0; P.newProgs = []; },
  };
  const el = document.createElement('pre');
  el.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:99;margin:0;padding:4px 8px;background:#000a;color:#9f9;font:11px monospace;pointer-events:none;white-space:pre';
  document.body.appendChild(el);
  setInterval(() => { el.textContent = P.report(); }, 500);
}
window.raffica = new App();

// Installed web app (public https site): offline cache + "Installa" / "Aggiungi a Home". Not on the LAN server.
if ('serviceWorker' in navigator && location.protocol === 'https:' && !/trycloudflare.com$/.test(location.hostname)) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
