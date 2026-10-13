// Host: authoritative match runner. Runs in Node (network) or in the browser (local).
// Slots (0..3) are the connection places of the room; at match start every connected slot takes a SEAT.
// Games only know seats (player index 0..n-1, in slot order). Scores/stats/x.w/x.who are per SLOT.
import { DT, PHASE_TIME, DEFAULT_SETTINGS, EMPTY_INPUT, cleanInput, MAX_PLAYERS, CHAR_BY_ID, DEFAULT_CHARS, maxPlayersOf } from './proto.js';
import { makeRng } from './rng.js';
import { MOD_BY_ID, compatibleMods, modTimeScale, modFlags, makeInputMods } from './mods.js';
import { BOT_LEVELS, BOT_NAMES, botLevelIndex, makeBotDriver, genericBot } from './bots.js';
import { CHARACTERS } from './proto.js';

const r3 = (v) => Math.round(v * 1000) / 1000;
// Combine press edges of two consecutive frames (used to not lose presses during hit-stop).
const mergePresses = (prev, cur) => (prev ? {
  ...cur, aP: prev.aP || cur.aP, bP: prev.bP || cur.bP, aN: Math.min(10, prev.aN + cur.aN), bN: Math.min(10, prev.bN + cur.bN),
} : { ...cur });
const FINISH_SCALE = 0.3;

export class Host {
  constructor({ games, seed = 1, settings = {} } = {}) {
    this.games = games || [];
    this.byId = new Map(this.games.map((d) => [d.id, d]));
    this.rng = makeRng(seed);
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.T = 0;
    const S = [...Array(MAX_PLAYERS).keys()];
    // team: 0 or 1 (used when settings.teams is on). Default: places 1–2 vs places 3–4 (e.g. two friends vs two bots).
    this.players = S.map((i) => ({ n: `Giocatore ${i + 1}`, on: false, rdy: false, c: DEFAULT_CHARS[i], bot: null, team: i < 2 ? 0 : 1 }));
    this.botDrv = S.map(() => null); // per slot: input driver of a computer player
    this.inputs = S.map(() => ({ ...EMPTY_INPUT }));
    this.counts = S.map(() => ({ ac: 0, bc: 0 }));
    this.stamp = S.map(() => 0);
    this.seats = [];
    this.events = [];
    this.score = S.map(() => 0);
    this.round = 0;
    this.bag = [];
    this.cur = null;
    this.x = {};
    this.lastLoser = null;
    this.lastMod = null;
    this.stats = this.freshStats();
    this.setPhase('lobby', 0);
  }

  // ---------- public API ----------
  setPlayer(slot, info = {}) {
    const p = this.players[slot];
    if (!p) return;
    if (p.bot && info.connected) this.removeBot(slot); // a human takes the place of a bot
    if (typeof info.name === 'string' && info.name.trim()) p.n = info.name.trim().slice(0, 14);
    if (typeof info.char === 'string' && CHAR_BY_ID[info.char]) p.c = info.char;
    if (typeof info.connected === 'boolean') p.on = info.connected;
    if (!p.on) { this.inputs[slot] = { ...EMPTY_INPUT, ac: this.inputs[slot].ac, bc: this.inputs[slot].bc }; }
    if (this.phase === 'lobby') this.seats = this.onSlots();
    // Pause the match if a seated player drops; resume when all of them are back.
    const active = !['lobby', 'final', 'pause'].includes(this.phase);
    if (active && !this.seatedOn()) this.pause();
    else if (this.phase === 'pause' && this.seatedOn() && this.pausedBy === 'drop') this.resume();
  }

  addBot(level, char) {
    const slot = this.players.findIndex((p) => !p.on);
    if (slot < 0) return -1;
    const p = this.players[slot];
    const used = new Set(this.players.filter((q) => q.on).map((q) => q.n));
    const names = BOT_NAMES.filter((n) => !used.has(n));
    p.bot = level;
    p.on = true; p.rdy = false;
    p.n = names.length ? this.rng.pick(names) : `Bot ${slot + 1}`;
    const taken = new Set(this.players.filter((q) => q.on && q !== p).map((q) => q.c));
    const free = CHARACTERS.filter((ch) => !taken.has(ch.id));
    p.c = CHAR_BY_ID[char] ? char : this.rng.pick(free.length ? free : CHARACTERS).id;
    this.botDrv[slot] = null;
    this.inputs[slot] = { ...EMPTY_INPUT };
    this.counts[slot] = { ac: 0, bc: 0 };
    return slot;
  }

  removeBot(slot) {
    const p = this.players[slot];
    if (!p?.bot) return;
    p.bot = null; p.on = false; p.rdy = false; p.n = `Giocatore ${slot + 1}`;
    this.botDrv[slot] = null;
    this.inputs[slot] = { ...EMPTY_INPUT };
    this.counts[slot] = { ac: 0, bc: 0 };
  }

  // Computer players: decide, then feed a raw input exactly like a client would.
  runBots() {
    this.players.forEach((p, slot) => {
      if (!p.bot || !p.on) return;
      let d = this.botDrv[slot];
      if (!d) d = this.botDrv[slot] = makeBotDriver(botLevelIndex(p.bot), makeRng(this.rng.seed()));
      let want = null;
      const seat = this.seats.indexOf(slot);
      if (this.phase === 'intro' && !p.rdy && this.phaseT > 0.7 + slot * 0.25) this.markReady(slot);
      else if (this.phase === 'pick' && this.x.who === slot && this.phaseT > 1.6) {
        this.x = { ...this.x, sel: Math.floor(this.rng() * this.x.cards.length) };
        this.confirmPick();
      } else if ((this.phase === 'play' || this.phase === 'finish') && this.cur?.state && seat >= 0) {
        const c = this.cur;
        if (d.round !== c) { d.round = c; d.mem = {}; }
        const B = { level: d.level, rng: d.rng || (d.rng = makeRng(this.rng.seed())), t: c.t, mem: d.mem };
        try { want = c.def.bot ? c.def.bot(c.state, seat, c.api, B) : genericBot(c.def, c.state, seat, c.api, B); } catch (err) {
          if (!d.warned) { d.warned = true; console.error(`[host] bot failed for ${c.def.id}:`, err); }
          want = null;
        }
      }
      this.inputs[slot] = { ...d.step(this.T, want) };
      this.stamp[slot] = this.T;
    });
  }

  onSlots() { return this.players.map((p, i) => (p.on ? i : -1)).filter((i) => i >= 0); }
  seatedOn() { return this.seats.length > 0 && this.seats.every((s) => this.players[s].on); }
  seatOf(slot) { return this.seats.indexOf(slot); }

  input(slot, raw) {
    if (!this.players[slot]) return;
    const i = cleanInput(raw);
    // A client restart resets its counters: rebase so no phantom presses appear.
    const c = this.counts[slot];
    if (i.ac < c.ac) c.ac = i.ac;
    if (i.bc < c.bc) c.bc = i.bc;
    // Press times are client-reported (lag compensation): never trust more than 0.35 s in the past or any future.
    for (const k of ['aT', 'bT']) if (i[k] >= 0) i[k] = Math.min(this.T, Math.max(this.T - 0.35, i[k]));
    this.inputs[slot] = i;
    this.stamp[slot] = this.T;
  }

  command(slot, c) {
    if (!c || typeof c.type !== 'string') return;
    switch (c.type) {
      case 'start':
      case 'rematch':
        // Needs at least two players (network: the others may have left).
        if ((this.phase === 'lobby' || this.phase === 'final') && this.onSlots().length >= 2) this.startMatch(c.only);
        break;
      case 'menu':
        if (!['pause', 'final', 'lobby'].includes(this.phase)) break;
        this.cur = null;
        this.paused = null;
        this.setPhase('lobby', 0);
        this.seats = this.onSlots();
        break;
      case 'bot':
        // {type:'bot', level:'facile'|'medio'|'difficile'} adds a bot in the first free place;
        // {type:'bot', target: slot, level} changes its level, level null removes it, {target, c} changes its character.
        if (this.phase !== 'lobby' && this.phase !== 'final') break;
        if (Number.isInteger(c.target) && this.players[c.target]?.bot) {
          if (CHAR_BY_ID[c.c] && c.level === undefined) this.players[c.target].c = c.c; // {target, c}: new character
          else if (c.level === null || c.level === undefined) this.removeBot(c.target);
          else if (BOT_LEVELS.some((l) => l.id === c.level)) { this.players[c.target].bot = c.level; this.botDrv[c.target] = null; }
        } else if (BOT_LEVELS.some((l) => l.id === c.level)) this.addBot(c.level, c.c);
        if (this.phase === 'lobby') this.seats = this.onSlots();
        break;
      case 'team':
        // {type:'team', team: 0|1} for my place, or {target: slot, team} (e.g. a bot).
        if (this.phase !== 'lobby' && this.phase !== 'final') break;
        {
          const tg = Number.isInteger(c.target) && this.players[c.target] ? c.target : slot;
          if (this.players[tg] && (c.team === 0 || c.team === 1)) this.players[tg].team = c.team;
        }
        break;
      case 'char':
        if ((this.phase === 'lobby' || this.phase === 'final') && this.players[slot] && CHAR_BY_ID[c.c]) this.players[slot].c = c.c;
        break;
      case 'settings':
        if (this.phase === 'lobby' && c.settings && typeof c.settings === 'object') this.applySettings(c.settings);
        break;
      case 'ready':
        if (this.seats.includes(slot)) this.markReady(slot);
        break;
      case 'pick':
        if (this.phase === 'pick' && slot === this.x.who && Number.isInteger(c.index) && this.x.cards[c.index]) {
          this.x.sel = c.index;
          this.confirmPick();
        }
        break;
      case 'pause': {
        // Explicit on/off avoids double toggles when both players press at once.
        const want = typeof c.on === 'boolean' ? c.on : this.phase !== 'pause';
        if (!want && this.phase === 'pause') { if (this.seatedOn()) this.resume(); }
        else if (want && !['lobby', 'final', 'pause'].includes(this.phase)) this.pause('user');
        break;
      }
      case 'skip':
        if (this.phase === 'result' || this.phase === 'roulette') this.phaseT = this.phaseDur;
        break;
      case 'debug': // jump straight into a game: {id, v, m}
        if (this.byId.has(c.id)) {
          if (this.phase === 'lobby' || this.phase === 'final') {
            this.seats = this.onSlots();
            if (this.seats.length < 2) this.seats = [0, 1];
            this.score = this.score.map(() => 0); this.round = 1; this.stats = this.freshStats();
          }
          this.prepareGame(c.id, { variant: c.v ?? null, mods: Array.isArray(c.m) ? c.m.filter((m) => MOD_BY_ID[m]) : [] });
        }
        break;
    }
  }

  tick() {
    this.T += DT;
    this.phaseT += DT;
    this.runBots();
    const inp = this.readInputs();
    switch (this.phase) {
      case 'pick': this.tickPick(inp); break;
      case 'roulette': if (this.phaseT >= this.phaseDur) this.prepareGame(this.x.pick); break;
      case 'intro': this.tickIntro(inp); break;
      case 'countdown': this.tickCountdown(); break;
      case 'play':
      case 'finish': this.tickGame(inp); break;
      case 'result': if (this.phaseT >= this.phaseDur) this.afterResult(); break;
      default: break;
    }
  }

  snapshot() {
    const c = this.cur;
    const s = {
      T: r3(this.T), ph: this.phase, pt: r3(this.phaseT), pd: this.phaseDur,
      sc: this.score.slice(), tg: this.settings.target, rd: this.round,
      pl: this.players.map((p) => ({ n: p.n, on: p.on, rdy: p.rdy, c: p.c, bot: p.bot, tm: p.team })),
      tm: this.teamsOn(),
      ts: !!this.settings.teams, // the setting itself (tm = actually active: 4 players split 2 + 2)
      seats: this.seats.slice(),
      g: c ? {
        // k = serial number of this game instance (stable). st (start time) moves during hit-stops: never use it as an id.
        id: c.def.id, k: c.no, v: c.variant, m: c.mods, t: r3(c.t),
        left: r3(Math.max(0, c.def.duration - c.t)), st: r3(c.startT), sw: c.inMods?.state.swapped || false,
        view: c.state ? c.def.view(c.state) : null,
      } : null,
      x: this.x,
      ev: this.events,
    };
    this.events = [];
    return s;
  }

  // ---------- match flow ----------
  freshStats() {
    const S = this.players.map(() => 0);
    return { fastest: S.map(() => null), wins: S.slice(), crazyWins: S.slice(), maxBehind: S.slice(), rounds: [] };
  }

  applySettings(s) {
    const t = Number(s.target);
    if ([3, 5, 7, 10].includes(t)) this.settings.target = t;
    for (const k of ['crazy', 'variants', 'loserPicks', 'teams']) if (typeof s[k] === 'boolean') this.settings[k] = s[k];
    if (Array.isArray(s.only)) this.settings.only = s.only.filter((id) => this.byId.has(id));
    else if (s.only === null) this.settings.only = null;
  }

  startMatch(only) {
    if (Array.isArray(only)) this.settings.only = only.filter((id) => this.byId.has(id));
    else if (only === null) this.settings.only = null;
    this.seats = this.onSlots();
    this.score = this.score.map(() => 0);
    this.round = 0;
    this.bag = [];
    this.lastLoser = null;
    this.lastMod = null;
    this.stats = this.freshStats();
    this.emit({ k: 'sfx', n: 'go' });
    this.nextRound();
  }

  // Teams are active with 4 seated players split 2 + 2 and the "teams" setting on.
  teamsOn() {
    if (!this.settings.teams || this.seats.length !== 4) return false;
    const a = this.seats.filter((s) => this.players[s].team === 0).length;
    return a === 2;
  }

  pool() {
    const only = this.settings.only;
    const list = only && only.length ? only : this.games.map((d) => d.id);
    const n = Math.max(2, this.seats.length);
    // In team matches only games that know about teams (def.teams === true) are drawn.
    const fit = (def) => maxPlayersOf(def) >= n && (!this.teamsOn() || def.teams === true);
    const teamOk = this.games.filter(fit).map((d) => d.id);
    if (this.teamsOn() && !teamOk.length) return this.games.filter((d) => maxPlayersOf(d) >= n).map((d) => d.id);
    const ok = list.filter((id) => this.byId.has(id) && fit(this.byId.get(id)));
    // Practice lists may contain only 1v1 games: fall back to every game that supports this many players.
    return ok.length ? ok : this.games.filter((d) => maxPlayersOf(d) >= n).map((d) => d.id);
  }

  drawFromBag(exclude = []) {
    const pool = this.pool();
    if (!pool.length) return null;
    if (!this.bag.length) {
      this.bag = this.rng.shuffle(pool.slice());
      // Avoid repeating the game just played at the bag boundary.
      if (this.bag.length > 1 && this.cur && this.bag[this.bag.length - 1] === this.cur.def.id) this.bag.unshift(this.bag.pop());
    }
    for (let k = this.bag.length - 1; k >= 0; k--) {
      if (!exclude.includes(this.bag[k])) return this.bag.splice(k, 1)[0];
    }
    return this.bag.pop();
  }

  nextRound() {
    this.round++;
    this.players.forEach((p) => (p.rdy = false));
    const pool = this.pool();
    const picker = this.pickerSlot();
    if (this.settings.loserPicks && picker !== null && pool.length >= 3) {
      const cards = [];
      while (cards.length < 3) {
        const id = this.drawFromBag(cards);
        if (!id || cards.includes(id)) break;
        cards.push(id);
      }
      if (cards.length === 3) {
        this.x = { who: picker, cards, sel: 1 };
        this.pickHeld = this.players.map(() => 0);
        this.setPhase('pick', PHASE_TIME.pick);
        this.emit({ k: 'sfx', n: 'whoosh' });
        return;
      }
      cards.forEach((id) => this.bag.push(id));
    }
    const pick = this.drawFromBag();
    const list = [];
    for (let k = 0; k < 9; k++) list.push(this.rng.pick(pool));
    list.push(pick);
    this.x = { list, pick };
    this.setPhase('roulette', PHASE_TIME.roulette);
    this.emit({ k: 'sfx', n: 'slot' });
  }

  // Last-placed seated player picks the next game (ties: whoever lost last round, else random).
  pickerSlot() {
    if (this.lastLoser === null || !this.seats.length) return null;
    const lo = Math.min(...this.seats.map((s) => this.score[s]));
    const tied = this.seats.filter((s) => this.score[s] === lo);
    if (tied.includes(this.lastLoser)) return this.lastLoser;
    return this.rng.pick(tied);
  }

  tickPick(inp) {
    const who = this.x.who;
    const i = inp[who];
    const dirX = i.sx; // cards are drawn in the picker's own frame
    const held = dirX > 0.5 ? 1 : dirX < -0.5 ? -1 : 0;
    if (held !== 0 && held !== this.pickHeld[who]) {
      this.x = { ...this.x, sel: Math.max(0, Math.min(2, this.x.sel + held)) };
      this.emit({ k: 'sfx', n: 'tick' });
    }
    this.pickHeld[who] = held;
    if (i.aP || this.phaseT >= this.phaseDur) this.confirmPick();
  }

  confirmPick() {
    const { cards, sel } = this.x;
    // Unchosen cards go back to the bag.
    cards.forEach((id, k) => { if (k !== sel) this.bag.unshift(id); });
    this.emit({ k: 'sfx', n: 'slotstop' });
    this.prepareGame(cards[sel]);
  }

  chooseMods(def) {
    if (!this.settings.crazy || this.round <= 2) return [];
    const matchPoint = this.seats.some((s) => this.score[s] >= this.settings.target - 1);
    if (!this.rng.chance(matchPoint ? 0.55 : 0.4)) return [];
    const options = compatibleMods(def).filter((m) => m.id !== this.lastMod);
    if (!options.length) return [];
    return [this.rng.pick(options).id];
  }

  prepareGame(id, force = null) {
    const def = this.byId.get(id);
    if (!def) return;
    let variant = null;
    if (force) variant = def.variants?.some((v) => v.id === force.variant) ? force.variant : null;
    else if (this.settings.variants && def.variants?.length && this.rng.chance(0.65)) variant = this.rng.pick(def.variants).id;
    const mods = force ? force.mods : this.chooseMods(def);
    if (mods.length) this.lastMod = mods[0];
    this.players.forEach((p) => (p.rdy = false));
    this.startGame(def, variant, mods, force?.replay || false);
    this.x = { id: def.id, v: variant, m: mods, replay: force?.replay || false, double: this.isDouble() };
    this.setPhase('intro', PHASE_TIME.intro);
    this.emit({ k: 'sfx', n: 'whoosh' });
  }

  isDouble() {
    // Last round before a possible win is worth the same; keep scoring simple.
    return false;
  }

  startGame(def, variant, mods, replay) {
    const rng = makeRng(this.rng.seed());
    const flags = modFlags(mods, this.seats.map((s) => this.score[s]));
    const n = this.seats.length;
    // Teams for the game (by SEAT): null in free-for-all. Games that support teams (def.teams) read g.teams / g.ally.
    const teams = this.teamsOn() && def.teams === true ? this.seats.map((s) => this.players[s].team) : null;
    const c = {
      def, variant, mods, t: 0, startT: this.T, state: null, ended: false, winner: null, text: '', no: (this.gameNo = (this.gameNo || 0) + 1),
      slow: [], hitstop: 0, replay, inMods: makeInputMods(mods, rng),
    };
    const host = this;
    const fx = (f, x, y, o = {}) => host.emit({ k: 'fx', f, x, y, ...o });
    c.api = {
      dt: DT, t: 0, n, world: def.world, variant, mods: flags, rng, ended: false,
      teams, team: (i) => (teams ? teams[i] : i), ally: (i, j) => (teams ? teams[i] === teams[j] : i === j),
      end(winner, text = '') {
        if (c.ended) return;
        c.ended = true; c.api.ended = true;
        c.winner = Number.isInteger(winner) && winner >= 0 && winner < n ? winner : -1;
        c.text = String(text || '');
      },
      sfx: (n, o = {}) => host.emit({ k: 'sfx', n, v: o.vol ?? 1, p: o.pitch ?? 1 }),
      burst: (x, y, o) => fx('burst', x, y, o),
      ring: (x, y, o) => fx('ring', x, y, o),
      text: (x, y, str, o = {}) => fx('text', x, y, { s: String(str), ...o }),
      confetti: (x, y, o) => fx('confetti', x, y, o),
      shake: (a = 0.5) => host.emit({ k: 'shake', a }),
      flash: (color = '#fff', a = 0.6) => host.emit({ k: 'flash', color, a }),
      // Impact freeze: kept short (half of what games ask, max 0.1 s) — longer freezes read as lag.
      hitstop: (sec = 0.08) => { c.hitstop = Math.max(c.hitstop, Math.min(0.1, sec * 0.5)); },
      slowmo: (scale = 0.3, sec = 0.6) => { c.slow.push({ scale, until: c.t + sec }); },
      vibrate: (p, ms = 60) => host.emit({ k: 'vib', p: host.seats[p] ?? -1, ms }), // seat -> slot
      say: (str, o = {}) => host.emit({ k: 'say', s: String(str), ...o }),
    };
    try {
      c.state = def.init(c.api);
    } catch (err) {
      console.error(`[host] init failed for ${def.id}:`, err);
      c.state = null;
      c.ended = true; c.winner = -1; c.text = 'Errore nel minigioco';
    }
    this.cur = c;
  }

  markReady(slot) {
    if (this.phase !== 'intro' || this.players[slot].rdy) return;
    this.players[slot].rdy = true;
    this.emit({ k: 'sfx', n: 'select' });
  }

  tickIntro(inp) {
    this.seats.forEach((s) => { if (inp[s].aP || inp[s].bP) this.markReady(s); });
    const allReady = this.seats.every((s) => this.players[s].rdy);
    if (allReady && this.phaseT < this.phaseDur - 0.6) this.phaseT = this.phaseDur - 0.6;
    if (this.phaseT >= this.phaseDur) {
      this.setPhase('countdown', PHASE_TIME.countdown);
      this.cdStep = -1;
    }
  }

  tickCountdown() {
    const step = Math.floor(this.phaseT / 0.8);
    if (step !== this.cdStep && step < 3) {
      this.cdStep = step;
      this.emit({ k: 'sfx', n: 'count', p: 1 + step * 0.12 });
    }
    if (this.phaseT >= this.phaseDur) {
      this.setPhase('play', 0);
      this.cur.startT = this.T;
      this.emit({ k: 'sfx', n: 'go' });
      this.emit({ k: 'say', s: 'VIA!', big: true });
    }
  }

  timeScale(c) {
    let s = modTimeScale(c.mods, c.t);
    c.slow = c.slow.filter((q) => q.until > c.t);
    for (const q of c.slow) s *= q.scale;
    if (this.phase === 'finish') s *= FINISH_SCALE;
    return Math.max(0.02, Math.min(2, s));
  }

  tickGame(inp) {
    const c = this.cur;
    if (!c) return;
    if (this.phase === 'finish' && this.phaseT >= this.phaseDur) return this.resolveGame();
    inp = this.seats.map((s) => inp[s]); // per-slot -> per-seat
    if (c.hitstop > 0) {
      // Frozen frame: keep presses for the next real step and keep press times aligned with game time.
      c.hitstop -= DT;
      c.startT += DT;
      c.carry = inp.map((i, k) => mergePresses(c.carry?.[k], i));
      return;
    }
    if (c.carry) { inp = inp.map((i, k) => mergePresses(c.carry[k], i)); c.carry = null; }
    const dt = DT * this.timeScale(c);
    c.t += dt;
    c.api.dt = dt;
    c.api.t = c.t;
    const gameInp = inp.map((i) => ({
      ...i,
      aT: i.aT >= 0 ? Math.max(0, i.aT - c.startT) : -1,
      bT: i.bT >= 0 ? Math.max(0, i.bT - c.startT) : -1,
    }));
    const finalInp = c.inMods.apply(gameInp, c.t, dt, { say: c.api.say, sfx: c.api.sfx });
    if (c.state) {
      try {
        c.def.step(c.state, finalInp, c.api);
      } catch (err) {
        console.error(`[host] step failed for ${c.def.id}:`, err);
        c.api.end(-1, 'Errore nel minigioco');
      }
    }
    if (!c.ended && c.t >= c.def.duration) {
      let w = -1;
      try { w = c.def.timeout ? c.def.timeout(c.state, c.api) : -1; } catch (err) { console.error(err); }
      c.api.end(w, 'Tempo scaduto!');
      this.emit({ k: 'sfx', n: 'timeup' });
    }
    if (c.ended && this.phase === 'play') {
      this.setPhase('finish', PHASE_TIME.finish);
    }
  }

  resolveGame() {
    const c = this.cur;
    const w = c.winner >= 0 ? this.seats[c.winner] : -1; // seat -> slot
    const x = { w, text: c.text, id: c.def.id, replay: false };
    if (w >= 0) {
      // Team match: the whole team of the winner scores.
      const mates = c.api.teams ? this.seats.filter((s) => this.players[s].team === this.players[w].team) : [w];
      const others = this.seats.filter((s) => !mates.includes(s));
      const behind = Math.max(...others.map((s) => this.score[s])) - this.score[w];
      for (const s of mates) this.score[s] += 1;
      x.team = c.api.teams ? this.players[w].team : null;
      this.lastLoser = others.length === 1 ? others[0] : this.rng.pick(others);
      const st = this.stats;
      st.wins[w]++;
      if (c.mods.length || c.variant) st.crazyWins[w]++;
      if (st.fastest[w] === null || c.t < st.fastest[w].t) st.fastest[w] = { t: r3(c.t), id: c.def.id };
      st.maxBehind[w] = Math.max(st.maxBehind[w], behind);
      st.rounds.push({ id: c.def.id, w, t: r3(c.t) });
      this.emit({ k: 'sfx', n: 'point' });
      if (this.score[w] === this.settings.target - 1 && this.score[w] < this.settings.target) x.matchPoint = w;
    } else {
      // Draw: replay once at turbo speed.
      x.replay = !c.replay;
      this.stats.rounds.push({ id: c.def.id, w: -1, t: r3(c.t) });
    }
    x.sc = this.score.slice();
    this.x = x;
    this.setPhase('result', PHASE_TIME.result);
  }

  afterResult() {
    const x = this.x;
    const won = this.seats.find((s) => this.score[s] >= this.settings.target) ?? -1;
    if (won >= 0) {
      this.x = { w: won, sc: this.score.slice(), awards: this.awards(won) };
      this.cur = null;
      this.setPhase('final', 0);
      this.emit({ k: 'sfx', n: 'fanfare' });
      return;
    }
    if (x.replay) {
      const mods = this.cur.mods.includes('turbo') ? this.cur.mods : ['turbo'];
      return this.prepareGame(x.id, { variant: this.cur.variant, mods, replay: true });
    }
    this.nextRound();
  }

  awards(winner) {
    const st = this.stats;
    const out = [];
    const seats = this.seats;
    const fast = seats.filter((s) => st.fastest[s]).sort((a, b) => st.fastest[a].t - st.fastest[b].t)[0];
    if (fast !== undefined) out.push({ p: fast, icon: '🏹', name: 'Freccia del Re', desc: `Vittoria più rapida del reame: ${st.fastest[fast].t.toFixed(1)} s` });
    const cw = seats.map((s) => st.crazyWins[s]);
    const cmax = Math.max(...cw);
    if (cmax > 0 && cw.filter((v) => v === cmax).length === 1) out.push({ p: seats[cw.indexOf(cmax)], icon: '🃏', name: 'Giullare del Caos', desc: 'Più vittorie con le regole pazze' });
    if (st.maxBehind[winner] >= 2) out.push({ p: winner, icon: '🐉', name: 'Rimonta Leggendaria', desc: `Ha vinto partendo da -${st.maxBehind[winner]}` });
    const losers = seats.filter((s) => s !== winner);
    const lo = Math.min(...losers.map((s) => this.score[s]));
    const last = losers.find((s) => this.score[s] === lo);
    if (lo === 0) out.push({ p: last, icon: '🪵', name: "Gogna d'Onore", desc: 'Zero punti: stanotte dorme nella stalla!' });
    else out.push({ p: last, icon: '🛡️', name: 'Scudiero Tenace', desc: "Ci ha provato fino all'ultimo duello" });
    return out.slice(0, 3);
  }

  pause(by = 'drop') {
    if (this.phase === 'pause') return;
    this.paused = { phase: this.phase, pt: this.phaseT, pd: this.phaseDur, x: this.x, at: this.T };
    this.pausedBy = by;
    this.setPhase('pause', 0);
    this.x = { ...this.paused.x, by };
  }

  resume() {
    if (this.phase !== 'pause' || !this.paused) return;
    const p = this.paused;
    this.paused = null;
    this.phase = p.phase; this.phaseT = p.pt; this.phaseDur = p.pd; this.x = p.x;
    if (this.cur) this.cur.startT += this.T - p.at; // press times stay in game time
  }

  setPhase(ph, dur) {
    this.phase = ph;
    this.phaseT = 0;
    this.phaseDur = dur;
  }

  emit(e) {
    if (this.events.length < 200) this.events.push(e);
  }

  blankInput() {
    return { x: 0, y: 0, sx: 0, sy: 0, a: false, b: false, aP: false, bP: false, aN: 0, bN: 0, aT: -1, bT: -1 };
  }

  // Convert latest raw inputs into per-tick inputs (one per SLOT) with press edges.
  readInputs() {
    return this.inputs.map((i, s) => {
      const c = this.counts[s];
      const aN = Math.max(0, Math.min(10, i.ac - c.ac));
      const bN = Math.max(0, Math.min(10, i.bc - c.bc));
      c.ac = i.ac; c.bc = i.bc;
      if (!this.players[s].on) return this.blankInput();
      // A client that stopped sending (tab hidden, frozen phone) must not keep walking or holding buttons.
      if (this.T - this.stamp[s] > 0.6) return { ...this.blankInput(), aP: aN > 0, bP: bN > 0, aN, bN, aT: i.aT, bT: i.bT };
      return { x: i.x, y: i.y, sx: i.sx, sy: i.sy, a: i.a, b: i.b, aP: aN > 0, bP: bN > 0, aN, bN, aT: i.aT, bT: i.bT };
    });
  }
}
