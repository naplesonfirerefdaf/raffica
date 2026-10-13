// RAFFICA! — audio engine (browser only, but safe to import in Node).
// Everything is synthesized with the Web Audio API: no audio files.
//
//   audio.unlock()              on the first user gesture (iOS-safe, idempotent)
//   audio.sfx(name, {vol, pitch, pan})
//   audio.music('menu'|'game'|'tense'|'final'|null)
//   audio.setTempo(1..1.25)
//   audio.crowd('cheer'|'ooh'|'laugh'|'gasp'|'aww')
//   audio.say(text, {rate, pitch, interrupt})
//   audio.settings / audio.applySettings() / audio.names
//
// Graph: voices -> sfxBus ┐
//        music players -> musicBus -> sfxDuck -> voiceDuck ┤-> master -> compressor -> limiter -> destination

const HAS_WIN = typeof window !== 'undefined';
const ACtor = HAS_WIN ? (window.AudioContext || window.webkitAudioContext || null) : null;
const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

const MAX_VOICES = 24;      // simultaneous sfx/crowd voices (oldest stolen)
const THROTTLE_MS = 30;     // same-name sfx retrigger guard
const FADE = 0.5;           // music crossfade (s)
const MUSIC_TRIM = 0.7;     // keeps music under the SFX
const LOOKAHEAD = 0.12;     // scheduler horizon (s), visible tab
const LOOKAHEAD_HIDDEN = 1.5; // background tabs throttle timers to ~1 s
const TIMER_MS = 25;        // scheduler wake-up period
const EPS = 0.0005;         // exponential ramps can't reach 0

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const num = (x, d) => (typeof x === 'number' && isFinite(x) ? x : d);
const rnd = (a, b) => a + Math.random() * (b - a);
const mf = (m) => 440 * Math.pow(2, (m - 69) / 12);

// ---------------------------------------------------------------------------
// Context & buses
// ---------------------------------------------------------------------------
let ctx = null;
let master = null, sfxBus = null, musicBus = null, sfxDuck = null, voiceDuck = null;
let noiseBuf = null;
const waves = {};
const active = [];          // live sfx voices, oldest first
const lastPlay = new Map(); // name -> ms
const warned = new Set();
let gestureHooks = false;
let silentPlayed = false;

function warnOnce(key, msg) {
  if (warned.has(key)) return;
  warned.add(key);
  try { console.warn('[audio] ' + msg); } catch (e) { /* ignore */ }
}

function ready() { return !!ctx && ctx.state === 'running'; }

function init() {
  if (ctx || !ACtor) return ctx;
  try {
    try { ctx = new ACtor({ latencyHint: 'interactive' }); } catch (e) { ctx = new ACtor(); }
  } catch (e) { ctx = null; return null; }
  try {
    const c = ctx;
    // master chain: gentle glue compressor + brickwall-ish limiter
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 10; comp.ratio.value = 4;
    comp.attack.value = 0.004; comp.release.value = 0.18;
    const lim = c.createDynamicsCompressor();
    lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20;
    lim.attack.value = 0.001; lim.release.value = 0.08;
    master = c.createGain(); master.gain.value = 0.9;
    master.connect(comp); comp.connect(lim); lim.connect(c.destination);

    sfxBus = c.createGain(); sfxBus.connect(master);
    musicBus = c.createGain();
    sfxDuck = c.createGain(); voiceDuck = c.createGain();
    musicBus.connect(sfxDuck); sfxDuck.connect(voiceDuck); voiceDuck.connect(master);

    // one shared 2 s white-noise buffer
    const len = Math.floor(c.sampleRate * 2);
    noiseBuf = c.createBuffer(1, len, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    waves.p25 = pulseWave(0.25);
    waves.p12 = pulseWave(0.125);

    c.onstatechange = () => { if (c.state === 'running') onRunning(); };
    applyGains(true);
  } catch (e) {
    ctx = null;
  }
  return ctx;
}

function pulseWave(duty) {
  const n = 48, re = new Float32Array(n), im = new Float32Array(n);
  for (let k = 1; k < n; k++) re[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty);
  return ctx.createPeriodicWave(re, im);
}

function setWave(osc, w) {
  if (w === 'p25' || w === 'p12') {
    if (waves[w]) osc.setPeriodicWave(waves[w]); else osc.type = 'square';
  } else osc.type = w;
}

function installGestureHooks() {
  if (gestureHooks || !HAS_WIN) return;
  gestureHooks = true;
  const kick = () => { if (ctx && ctx.state !== 'running') audio.unlock(); };
  try {
    for (const ev of ['pointerdown', 'touchend', 'keydown', 'click']) {
      window.addEventListener(ev, kick, { capture: true, passive: true });
    }
    if (typeof document !== 'undefined') {
      // Silent while the game is not in front (another app/tab focused, e.g. playing something else on the PC).
      const away = () => document.hidden || (typeof document.hasFocus === 'function' && !document.hasFocus());
      const sync = () => {
        if (!ctx) return;
        try {
          if (away()) { if (ctx.state === 'running') ctx.suspend().catch(() => {}); }
          else if (ctx.state !== 'running') ctx.resume().catch(() => {});
        } catch (e) { /* ignore */ }
        if (players.length) { clearTimeout(timer); timer = null; tick(); }
      };
      document.addEventListener('visibilitychange', sync);
      window.addEventListener('blur', sync);
      window.addEventListener('focus', sync);
    }
  } catch (e) { /* ignore */ }
}

function applyGains(instant) {
  if (!ctx) return;
  const s = audio.settings || {};
  const muted = !!s.muted;
  const sv = muted ? 0 : clamp(num(s.sfx, 0.8), 0, 1);
  const mv = muted ? 0 : clamp(num(s.music, 0.45), 0, 1) * MUSIC_TRIM;
  const t = ctx.currentTime;
  if (instant) { sfxBus.gain.value = sv; musicBus.gain.value = mv; return; }
  sfxBus.gain.cancelScheduledValues(t); sfxBus.gain.setTargetAtTime(sv, t, 0.02);
  musicBus.gain.cancelScheduledValues(t); musicBus.gain.setTargetAtTime(mv, t, 0.05);
}

function sfxSilent() { const s = audio.settings || {}; return !!s.muted || !(num(s.sfx, 0.8) > 0); }
function musicSilent() { const s = audio.settings || {}; return !!s.muted || !(num(s.music, 0.45) > 0); }

// short dip of the music under important SFX
function duck() {
  if (!sfxDuck) return;
  const g = sfxDuck.gain, t = ctx.currentTime;
  g.cancelScheduledValues(t);
  g.setValueAtTime(g.value, t);
  g.linearRampToValueAtTime(0.55, t + 0.03);
  g.setTargetAtTime(1, t + 0.4, 0.25);
}

// ---------------------------------------------------------------------------
// SFX voice + synthesis toolkit
// ---------------------------------------------------------------------------
class Voice {
  constructor(name, vol, pan, pitch) {
    this.name = name;
    this.p = pitch;
    this.t = ctx.currentTime + 0.003;
    this.srcs = [];
    this.nodes = [];
    this.live = 0;
    this.dead = false;
    this.out = ctx.createGain();
    this.out.gain.value = vol;
    this.nodes.push(this.out);
    let last = this.out;
    if (pan && ctx.createStereoPanner) {
      const pn = ctx.createStereoPanner();
      pn.pan.value = clamp(pan, -1, 1);
      last.connect(pn); last = pn; this.nodes.push(pn);
    }
    last.connect(sfxBus);
  }
  node(n) { this.nodes.push(n); return n; }
  src(s, t0, t1, off) {
    this.srcs.push(s);
    this.live++;
    s.onended = () => {
      try { s.disconnect(); } catch (e) { /* ignore */ }
      if (--this.live <= 0) this.free();
    };
    if (off != null) s.start(t0, off); else s.start(t0);
    s.stop(t1);
    return s;
  }
  unlist() { const i = active.indexOf(this); if (i >= 0) active.splice(i, 1); }
  free() {
    if (this.dead) return;
    this.dead = true;
    for (const n of this.nodes) { try { n.disconnect(); } catch (e) { /* ignore */ } }
    this.nodes.length = 0;
    this.srcs.length = 0;
    this.unlist();
  }
  kill() { // voice stealing: fast fade, then stop everything
    this.unlist();
    if (this.dead) return;
    const t = ctx.currentTime;
    try {
      const g = this.out.gain;
      g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(0, t + 0.015);
    } catch (e) { /* ignore */ }
    for (const s of this.srcs) { try { s.stop(t + 0.02); } catch (e) { /* ignore */ } }
  }
}

const nyq = () => (ctx ? ctx.sampleRate / 2 - 100 : 20000);
const fq = (f) => clamp(f, 10, nyq());

function ramp(param, val, t, lin) {
  if (lin) param.linearRampToValueAtTime(val, t);
  else param.exponentialRampToValueAtTime(Math.max(val, EPS), t);
}

// gain envelope: 0 -> vol in `a`, then exponential decay (perc) or hold + linear release
function envGain(v, t, d, o) {
  const g = v.node(ctx.createGain());
  const vol = num(o.v, 0.4), a = num(o.a, 0.003);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + a);
  if (o.hold) {
    const r = num(o.r, 0.04);
    g.gain.setValueAtTime(vol, Math.max(t + a, t + d - r));
    g.gain.linearRampToValueAtTime(0, t + d);
  } else {
    g.gain.exponentialRampToValueAtTime(EPS, Math.max(t + a + 0.005, t + d));
  }
  g.connect(o.to || v.out);
  return g;
}

// flt = [type, f, f2?, Q?, sweepDur?]
function filt(v, into, t, d, flt) {
  const f = v.node(ctx.createBiquadFilter());
  f.type = flt[0];
  f.frequency.setValueAtTime(fq(flt[1] * v.p), t);
  if (flt[2]) ramp(f.frequency, fq(flt[2] * v.p), t + (flt[4] || d));
  if (flt[3] != null) f.Q.value = flt[3];
  f.connect(into);
  return f;
}

function lfo(v, param, t, d, rate, depth, depth2, type) {
  const o = ctx.createOscillator();
  o.type = type || 'sine';
  o.frequency.value = rate;
  const g = v.node(ctx.createGain());
  g.gain.setValueAtTime(depth, t);
  if (depth2 != null) g.gain.linearRampToValueAtTime(depth2, t + d);
  o.connect(g); g.connect(param);
  v.src(o, t, t + d + 0.01);
}

// amplitude modulation stage: gain swings between 1-2*depth and 1
function trem(v, into, t, d, tr) {
  const g = v.node(ctx.createGain());
  g.gain.value = 1 - tr[1];
  g.connect(into);
  lfo(v, g.gain, t, d, tr[0], tr[1], null, tr[2]);
  return g;
}

// Oscillator note.
// o: {w, f, f2, sd, lin, at, d, v, a, hold, r, det, flt, vib:[rate, depthHz, depth2Hz], trem:[rate, depth, type], to}
function tone(v, o) {
  const t = v.t + (o.at || 0), d = o.d || 0.1;
  const osc = ctx.createOscillator();
  setWave(osc, o.w || 'square');
  osc.frequency.setValueAtTime(fq(o.f * v.p), t);
  if (o.f2) ramp(osc.frequency, fq(o.f2 * v.p), t + (o.sd || d), o.lin);
  if (o.det) osc.detune.setValueAtTime(o.det, t);
  let into = envGain(v, t, d, o);
  if (o.trem) into = trem(v, into, t, d, o.trem);
  if (o.flt) into = filt(v, into, t, d, o.flt);
  osc.connect(into);
  if (o.vib) lfo(v, osc.frequency, t, d, o.vib[0], o.vib[1] * v.p, o.vib[2] != null ? o.vib[2] * v.p : null, o.vib[3]);
  v.src(osc, t, t + d + 0.02);
  return osc;
}

// Filtered noise burst. o: {at, d, v, a, hold, r, flt, flt2, trem, rate, to}
function noise(v, o) {
  const t = v.t + (o.at || 0), d = o.d || 0.2;
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf; s.loop = true;
  if (o.rate) s.playbackRate.value = o.rate;
  let into = envGain(v, t, d, o);
  if (o.trem) into = trem(v, into, t, d, o.trem);
  if (o.flt) into = filt(v, into, t, d, o.flt);
  if (o.flt2) into = filt(v, into, t, d, o.flt2);
  s.connect(into);
  v.src(s, t, t + d + 0.02, Math.random() * 1.5);
  return s;
}

// Many short noise hits on ONE source (claps, snare rolls, crackles).
// o: {d (each hit), v, flt, jit, to}
function hits(v, times, o) {
  if (!times.length) return;
  times = times.slice().sort((a, b) => a - b);
  const t0 = v.t, hd = o.d || 0.05;
  const end = times[times.length - 1] + hd + 0.02;
  const g = v.node(ctx.createGain());
  g.gain.setValueAtTime(0, t0);
  for (let i = 0; i < times.length; i++) {
    const t = t0 + times[i];
    const next = i + 1 < times.length ? t0 + times[i + 1] : Infinity;
    const vol = o.v * (o.jit ? rnd(0.5, 1) : 1);
    const stop = Math.max(t + 0.004, Math.min(t + hd, next - 0.001));
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.002);
    g.gain.exponentialRampToValueAtTime(EPS, stop);
  }
  g.connect(o.to || v.out);
  let into = g;
  if (o.flt) into = filt(v, into, t0, end, o.flt);
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf; s.loop = true;
  s.connect(into);
  v.src(s, t0, t0 + end, Math.random() * 1.5);
}

// Inharmonic bell (DING)
function bell(v, f, at, d, vol) {
  const P = [[1, 1, 1], [2.76, 0.45, 0.6], [5.4, 0.22, 0.35], [8.93, 0.1, 0.2]];
  for (const [m, a, dd] of P) tone(v, { w: 'sine', f: f * m, at, d: d * dd, v: vol * a, a: 0.002 });
}

// Brassy note: two detuned saws with an opening low-pass
function brass(v, f, at, d, vol) {
  for (const det of [-7, 7]) {
    tone(v, { w: 'sawtooth', f, at, d, v: vol, a: 0.03, hold: true, r: Math.min(0.2, d * 0.35), det,
      flt: ['lowpass', 600, 3800, 1.2, 0.09] });
  }
}

// ---------------------------------------------------------------------------
// Crowd (formant-filtered "people" + noise roar + claps)
// ---------------------------------------------------------------------------
const VOWELS = {
  a: [750, 1150, 2500], e: [420, 1900, 2550], o: [480, 820, 2500],
  u: [340, 700, 2400], aw: [600, 900, 2450],
};
const BQ = [5, 7, 9], BA = [1, 0.6, 0.2];

// Shared formant filter bank: every person in the crowd goes through the same 3 band-passes.
function bank(v, vowel, gain, t) {
  const input = v.node(ctx.createGain());
  const F = VOWELS[vowel], fl = [];
  for (let i = 0; i < 3; i++) {
    const f = v.node(ctx.createBiquadFilter());
    f.type = 'bandpass'; f.Q.value = BQ[i];
    f.frequency.setValueAtTime(F[i], t);
    const g = v.node(ctx.createGain());
    g.gain.value = BA[i] * gain;
    input.connect(f); f.connect(g); g.connect(v.out);
    fl.push(f);
  }
  return {
    input,
    to(vw, at, dur) {
      const F2 = VOWELS[vw];
      fl.forEach((f, i) => { f.frequency.setValueAtTime(F[i], at); f.frequency.linearRampToValueAtTime(F2[i], at + dur); });
    },
  };
}

// One voiced "person": sawtooth with pitch curve [[time, mult], ...] and either a sustained
// envelope or a train of pulses ("ha ha ha").
function person(v, dest, o) {
  const t = o.t, d = o.d, f = o.f * v.p;
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  const fr = osc.frequency, c = o.curve || [[0, 1]];
  fr.setValueAtTime(fq(f * c[0][1]), t);
  for (let i = 1; i < c.length; i++) fr.linearRampToValueAtTime(fq(f * c[i][1]), t + c[i][0]);
  const g = v.node(ctx.createGain());
  const gp = g.gain;
  gp.setValueAtTime(0, t);
  if (o.pulses) {
    const ps = o.pulses;
    for (let i = 0; i < ps.length; i++) {
      const pt = t + ps[i];
      const next = i + 1 < ps.length ? t + ps[i + 1] : t + d;
      gp.setValueAtTime(0, pt);
      gp.linearRampToValueAtTime(o.v, pt + 0.02);
      gp.exponentialRampToValueAtTime(EPS, Math.max(pt + 0.03, Math.min(pt + o.pd, next - 0.005)));
    }
  } else {
    gp.linearRampToValueAtTime(o.v, t + o.a);
    gp.setValueAtTime(o.v, t + Math.max(o.a, d - 0.3));
    gp.linearRampToValueAtTime(0, t + d);
  }
  osc.connect(g); g.connect(dest);
  if (o.vib) lfo(v, fr, t, d, o.vib[0], o.vib[1]);
  v.src(osc, t, t + d + 0.02);
}

const CROWDS = ['cheer', 'ooh', 'laugh', 'gasp', 'aww'];

function crowdLayer(v, kind, at, rate, vol) {
  const t0 = v.t + at;
  const rel = (x) => at + x; // relative to voice start (for noise()/hits())
  const voiceF = () => (Math.random() < 0.5 ? rnd(140, 230) : rnd(240, 400)) * rate;
  if (kind === 'cheer') {
    const b = bank(v, 'e', 1.8 * vol, t0);
    b.to('a', t0 + 0.2, 0.3);
    for (let i = 0; i < 8; i++) {
      const st = rnd(0, 0.15), f = voiceF();
      person(v, b.input, { t: t0 + st, f, d: 1.65 - st, a: 0.08, v: 0.13,
        curve: [[0, 0.9], [0.25, 1.15], [1.0, 1.08], [1.5, 0.95]], vib: [rnd(4.5, 7), f * 0.035] });
    }
    noise(v, { at: rel(0), d: 1.7, a: 0.1, hold: true, r: 0.6, v: 0.12 * vol, flt: ['bandpass', 1100, null, 0.6] });
    const claps = [];
    for (let i = 0; i < 22; i++) claps.push(rel(rnd(0.08, 1.55)));
    hits(v, claps, { d: 0.045, v: 0.28 * vol, jit: true, flt: ['bandpass', 1500, null, 1.1] });
  } else if (kind === 'ooh') {
    const b = bank(v, 'u', 2.2 * vol, t0);
    b.to('o', t0 + 0.3, 0.5);
    for (let i = 0; i < 7; i++) {
      const st = rnd(0, 0.1), f = voiceF() * 0.9;
      person(v, b.input, { t: t0 + st, f, d: 1.2 - st, a: 0.12, v: 0.14,
        curve: [[0, 0.85], [0.35, 1.12], [1.1, 0.8]], vib: [rnd(4, 6), f * 0.02] });
    }
    noise(v, { at: rel(0), d: 1.1, a: 0.15, v: 0.05 * vol, flt: ['bandpass', 500, null, 1] });
  } else if (kind === 'aww') {
    const b = bank(v, 'aw', 2.0 * vol, t0);
    b.to('u', t0 + 0.6, 0.6);
    for (let i = 0; i < 7; i++) {
      const st = rnd(0, 0.1), f = voiceF();
      person(v, b.input, { t: t0 + st, f, d: 1.25 - st, a: 0.1, v: 0.13,
        curve: [[0, 1.12], [0.2, 1.18], [1.2, 0.76]], vib: [rnd(4, 6), f * 0.025] });
    }
  } else if (kind === 'gasp') {
    const b = bank(v, 'e', 3.0 * vol, t0);
    b.to('a', t0 + 0.05, 0.15);
    noise(v, { at: rel(0), d: 0.55, a: 0.04, v: 0.5 * vol, to: b.input });
    for (let i = 0; i < 5; i++) {
      const st = rnd(0, 0.06), f = voiceF();
      person(v, b.input, { t: t0 + st, f, d: 0.4, a: 0.05, v: 0.06,
        curve: [[0, 1], [0.15, 1.35], [0.4, 1.25]] });
    }
  } else if (kind === 'laugh') {
    const b = bank(v, 'a', 2.2 * vol, t0);
    const breath = [];
    for (let i = 0; i < 5; i++) {
      const r = rnd(4.8, 6.8), st = rnd(0, 0.12), f = voiceF();
      const ps = [], curve = [[0, 1.08]];
      for (let k = 0; k < 8; k++) {
        const pt = st + k / r + rnd(-0.015, 0.015);
        if (pt > 1.3) break;
        ps.push(Math.max(0, pt - st));
        const m = 1 - k * 0.03;
        if (k > 0) curve.push([Math.max(0, pt - st), 1.08 * m]);
        curve.push([Math.max(0, pt - st) + 0.08, 0.95 * m]);
        if (i === 0) breath.push(rel(pt));
      }
      person(v, b.input, { t: t0 + st, f, d: 1.4 - st, v: 0.16, pulses: ps, pd: 0.6 / r, curve });
    }
    hits(v, breath, { d: 0.09, v: 0.25 * vol, to: b.input });
  }
}

// ---------------------------------------------------------------------------
// SFX definitions — each fn(v) builds one voice. Times in seconds from v.t.
// ---------------------------------------------------------------------------
const SFX = {
  // ---- UI ----
  click(v) {
    tone(v, { w: 'square', f: 1800, f2: 900, d: 0.035, v: 0.22 });
    noise(v, { d: 0.015, v: 0.15, flt: ['highpass', 4000] });
  },
  select(v) {
    tone(v, { w: 'p25', f: 660, d: 0.07, v: 0.3 });
    tone(v, { w: 'p25', f: 990, at: 0.06, d: 0.13, v: 0.3 });
  },
  back(v) {
    tone(v, { w: 'p25', f: 620, f2: 300, d: 0.15, v: 0.28 });
    tone(v, { w: 'triangle', f: 310, f2: 150, d: 0.15, v: 0.3 });
  },
  tick(v) {
    tone(v, { w: 'triangle', f: 1500, d: 0.04, v: 0.35 });
    noise(v, { d: 0.012, v: 0.12, flt: ['highpass', 6000] });
  },
  slot(v) {
    noise(v, { d: 0.025, v: 0.35, flt: ['bandpass', 2600 * rnd(0.92, 1.08), null, 3] });
    tone(v, { w: 'square', f: 900 * rnd(0.95, 1.05), f2: 600, d: 0.03, v: 0.1 });
  },
  slotstop(v) {
    tone(v, { w: 'triangle', f: 300, f2: 120, d: 0.08, v: 0.4 });
    bell(v, 1568, 0.015, 1.0, 0.3);
    bell(v, 2093, 0.015, 0.8, 0.14);
  },
  whoosh(v) {
    noise(v, { d: 0.38, a: 0.13, v: 0.5, flt: ['bandpass', 300, 2800, 1.3, 0.3] });
  },

  // ---- match flow ----
  count(v) {
    tone(v, { w: 'p25', f: 880, d: 0.18, v: 0.28, hold: true, r: 0.05 });
    tone(v, { w: 'sine', f: 440, d: 0.18, v: 0.25, hold: true, r: 0.05 });
  },
  go(v) {
    for (const f of [523.25, 659.25, 783.99, 1046.5]) {
      tone(v, { w: 'sawtooth', f, d: 0.85, a: 0.01, v: 0.1, hold: true, r: 0.4, det: rnd(-8, 8),
        flt: ['lowpass', 900, 6500, 1, 0.12] });
    }
    tone(v, { w: 'square', f: 1046.5, f2: 2093, sd: 0.15, d: 0.5, v: 0.08, hold: true, r: 0.3 });
    noise(v, { d: 0.9, v: 0.3, flt: ['highpass', 3000] });
    tone(v, { w: 'sine', f: 150, f2: 40, d: 0.4, v: 0.7 });
  },
  point(v) {
    [784, 988, 1319].forEach((f, i) => tone(v, { w: 'p25', f, at: i * 0.05, d: i === 2 ? 0.28 : 0.07, v: 0.26 }));
    tone(v, { w: 'sine', f: 2637, at: 0.1, d: 0.22, v: 0.08 });
  },
  win(v) {
    const L = [[72, 0, 0.1], [76, 0.1, 0.1], [79, 0.2, 0.1], [84, 0.3, 0.2], [79, 0.55, 0.12], [84, 0.7, 0.75]];
    for (const [m, at, d] of L) tone(v, { w: 'p25', f: mf(m), at, d, v: 0.24, hold: true, r: Math.min(0.3, d * 0.5) });
    for (const m of [76, 79]) tone(v, { w: 'triangle', f: mf(m), at: 0.7, d: 0.75, v: 0.18, hold: true, r: 0.35 });
    for (const [m, at, d] of [[48, 0, 0.28], [55, 0.3, 0.38], [48, 0.7, 0.75]]) {
      tone(v, { w: 'triangle', f: mf(m), at, d, v: 0.35, hold: true, r: 0.1 });
    }
    tone(v, { w: 'sine', f: 2093, at: 0.72, d: 0.6, v: 0.06, vib: [7, 20] });
    noise(v, { at: 0.7, d: 0.6, v: 0.08, flt: ['highpass', 6000] });
  },
  lose(v) {
    const N = [233.08, 220, 207.65, 196];
    N.forEach((f, i) => {
      const last = i === 3, d = last ? 0.75 : 0.3, at = i * 0.32;
      tone(v, { w: 'sawtooth', f, f2: last ? 186 : null, d, at, v: 0.24, a: 0.03, hold: true, r: last ? 0.3 : 0.06,
        flt: ['lowpass', 350, 1500, 4, 0.14], vib: last ? [5.5, 0, 7] : null });
      tone(v, { w: 'square', f: f / 2, d, at, v: 0.06, a: 0.03, hold: true, r: 0.06, flt: ['lowpass', 600] });
    });
  },
  fanfare(v) {
    const roll = [];
    for (let i = 0; i < 8; i++) roll.push(i * 0.045);
    hits(v, roll, { d: 0.04, v: 0.18, flt: ['bandpass', 2200, null, 0.8] });
    const M = [[67, 0, 0.11], [67, 0.13, 0.11], [67, 0.26, 0.11], [72, 0.4, 0.4], [67, 0.85, 0.13],
      [72, 1.0, 0.13], [76, 1.15, 0.3]];
    for (const [m, at, d] of M) { brass(v, mf(m), at, d, 0.1); brass(v, mf(m - 5), at, d, 0.05); }
    for (const m of [72, 76, 79, 84]) brass(v, mf(m), 1.5, 1.35, 0.075);
    tone(v, { w: 'sine', f: mf(91), at: 1.5, d: 1.2, v: 0.04, vib: [6, 25] });
    for (const [at, d] of [[0.4, 0.45], [1.5, 1.3]]) {
      tone(v, { w: 'sine', f: 98, f2: 78, at, d: 0.6, v: 0.6 });
      tone(v, { w: 'triangle', f: mf(36), at, d, v: 0.3, hold: true, r: 0.3 });
    }
    noise(v, { at: 1.5, d: 1.4, v: 0.22, flt: ['highpass', 4500] });
  },
  matchpoint(v) {
    [[0, 0.15], [0.2, 0.15], [0.4, 0.8]].forEach(([at, d], i) => {
      const last = i === 2;
      for (const f of [130.81, 185]) {
        tone(v, { w: 'sawtooth', f, f2: last ? f * 1.06 : null, at, d, v: 0.14, a: 0.005, hold: true, r: last ? 0.3 : 0.05,
          flt: ['lowpass', 2500, 900, 1], trem: last ? [9, 0.45] : null });
      }
      tone(v, { w: 'sine', f: 95, f2: 48, at, d: last ? 0.6 : 0.2, v: 0.7 });
    });
    noise(v, { at: 0.4, d: 0.8, a: 0.4, v: 0.1, flt: ['bandpass', 800, 4000, 2] });
  },
  buzzer(v) {
    tone(v, { w: 'sawtooth', f: 110, d: 0.5, v: 0.24, hold: true, r: 0.04, flt: ['lowpass', 2200] });
    tone(v, { w: 'square', f: 116, d: 0.5, v: 0.16, hold: true, r: 0.04, flt: ['lowpass', 2600] });
    tone(v, { w: 'square', f: 55, d: 0.5, v: 0.18, hold: true, r: 0.04, flt: ['lowpass', 900] });
  },
  whistle(v) {
    for (const [at, d] of [[0, 0.14], [0.2, 0.4]]) {
      tone(v, { w: 'sine', f: 2900, at, d, v: 0.28, a: 0.01, hold: true, r: 0.04, vib: [28, 180] });
      noise(v, { at, d, v: 0.12, a: 0.01, hold: true, r: 0.04, flt: ['bandpass', 2900, null, 6] });
    }
  },
  timeup(v) {
    for (const at of [0, 0.15, 0.3]) bell(v, 740, at, 0.9, 0.3);
    tone(v, { w: 'square', f: 370, d: 0.08, v: 0.06 });
  },

  // ---- action ----
  dash(v) {
    noise(v, { d: 0.18, a: 0.02, v: 0.45, flt: ['bandpass', 800, 4200, 1.5] });
    tone(v, { w: 'sine', f: 300, f2: 900, d: 0.1, v: 0.14 });
  },
  jump(v) { tone(v, { w: 'p25', f: 260, f2: 720, d: 0.16, v: 0.28 }); },
  land(v) {
    tone(v, { w: 'sine', f: 160, f2: 45, d: 0.14, v: 0.6 });
    noise(v, { d: 0.08, v: 0.3, flt: ['lowpass', 700] });
  },
  hit(v) {
    noise(v, { d: 0.14, v: 0.5, flt: ['lowpass', 3500, 500] });
    tone(v, { w: 'square', f: 220, f2: 70, d: 0.1, v: 0.22 });
    tone(v, { w: 'sine', f: 110, f2: 40, d: 0.18, v: 0.6 });
  },
  punch(v) {
    noise(v, { d: 0.06, a: 0.02, v: 0.3, flt: ['bandpass', 1200, 3000, 1] });
    tone(v, { w: 'sine', f: 190, f2: 45, at: 0.035, d: 0.2, v: 0.75 });
    noise(v, { at: 0.035, d: 0.12, v: 0.45, flt: ['lowpass', 1500, 300] });
  },
  bonk(v) {
    tone(v, { w: 'sine', f: 950, f2: 430, d: 0.13, v: 0.45 });
    tone(v, { w: 'triangle', f: 480, f2: 220, d: 0.09, v: 0.3 });
    tone(v, { w: 'square', f: 1900, f2: 1000, d: 0.03, v: 0.06 });
  },
  boing(v) {
    tone(v, { w: 'triangle', f: 160, f2: 420, sd: 0.5, d: 0.55, v: 0.42, vib: [17, 70, 4] });
    tone(v, { w: 'sine', f: 80, f2: 210, sd: 0.5, d: 0.4, v: 0.2, vib: [17, 35, 2] });
  },
  bounce(v) {
    tone(v, { w: 'sine', f: 240, f2: 620, d: 0.11, v: 0.45 });
    tone(v, { w: 'triangle', f: 480, f2: 1240, d: 0.06, v: 0.12 });
  },
  pop(v) {
    tone(v, { w: 'sine', f: 420, f2: 1500, sd: 0.03, d: 0.06, v: 0.5 });
    noise(v, { d: 0.02, v: 0.2, flt: ['highpass', 3000] });
  },
  explode(v) {
    noise(v, { d: 0.9, v: 0.7, flt: ['lowpass', 4000, 180, 0.7] });
    tone(v, { w: 'sine', f: 95, f2: 30, d: 0.55, v: 0.7 });
    noise(v, { d: 0.35, v: 0.22, flt: ['bandpass', 900, 300, 2] });
  },
  bigexplode(v) {
    noise(v, { d: 1.2, v: 0.8, flt: ['lowpass', 6000, 120, 0.8] });
    tone(v, { w: 'sine', f: 70, f2: 24, d: 1.0, v: 0.85 });
    tone(v, { w: 'square', f: 55, f2: 30, d: 0.5, v: 0.15, flt: ['lowpass', 300] });
    noise(v, { at: 0.12, d: 1.05, v: 0.5, flt: ['lowpass', 1200, 100] });
    noise(v, { d: 0.45, v: 0.15, trem: [22, 0.5, 'square'], flt: ['bandpass', 2500, null, 1.5] });
  },
  shoot(v) {
    tone(v, { w: 'square', f: 1300, f2: 220, d: 0.14, v: 0.22 });
    noise(v, { d: 0.04, v: 0.2, flt: ['highpass', 2000] });
  },
  laser(v) {
    tone(v, { w: 'sawtooth', f: 2600, f2: 500, d: 0.32, v: 0.16, flt: ['lowpass', 5000, 1500] });
    tone(v, { w: 'sine', f: 3200, f2: 900, d: 0.32, v: 0.15, vib: [45, 300] });
  },
  zap(v) {
    tone(v, { w: 'sawtooth', f: 70, d: 0.3, v: 0.4, hold: true, r: 0.06, trem: [32, 0.5, 'square'],
      flt: ['bandpass', 2200, null, 1.5] });
    noise(v, { d: 0.3, v: 0.25, hold: true, r: 0.05, trem: [27, 0.5, 'square'], flt: ['bandpass', 3500, 1500, 3] });
    tone(v, { w: 'square', f: 1500, f2: 3000, d: 0.08, v: 0.05 });
  },
  coin(v) {
    tone(v, { w: 'square', f: 988, d: 0.08, v: 0.2, hold: true, r: 0.01 });
    tone(v, { w: 'square', f: 1319, at: 0.075, d: 0.38, v: 0.2 });
  },
  powerup(v) {
    [0, 4, 7, 12, 16, 19, 24, 28].forEach((s, i) => {
      tone(v, { w: 'p12', f: mf(72 + s), at: i * 0.05, d: i === 7 ? 0.3 : 0.1, v: 0.22 });
    });
    tone(v, { w: 'sine', f: mf(96), at: 0.35, d: 0.35, v: 0.06, vib: [9, 40] });
  },
  pickup(v) {
    tone(v, { w: 'sine', f: 1200, f2: 2400, d: 0.09, v: 0.3 });
    tone(v, { w: 'sine', f: 1800, f2: 3600, at: 0.06, d: 0.12, v: 0.24 });
  },
  splash(v) {
    noise(v, { d: 0.55, a: 0.01, v: 0.55, flt: ['lowpass', 5000, 700] });
    noise(v, { d: 0.25, v: 0.22, flt: ['highpass', 2500] });
    for (let i = 0; i < 4; i++) {
      const f = rnd(700, 1600);
      tone(v, { w: 'sine', f, f2: f * 2.2, at: 0.05 + i * 0.06 + rnd(0, 0.03), d: 0.06, v: 0.14 });
    }
  },
  fall(v) {
    tone(v, { w: 'sine', f: 2100, f2: 280, d: 1.1, sd: 1.05, a: 0.03, hold: true, r: 0.15, v: 0.28, vib: [7, 15] });
  },
  crash(v) {
    noise(v, { d: 0.9, v: 0.5, flt: ['highpass', 1500, 800] });
    for (const f of [417, 593, 853, 1247]) tone(v, { w: 'square', f, d: rnd(0.3, 0.55), v: 0.05, flt: ['highpass', 300] });
    tone(v, { w: 'sine', f: 120, f2: 40, d: 0.25, v: 0.6 });
    noise(v, { d: 0.3, v: 0.4, flt: ['lowpass', 800] });
  },
  break(v) {
    for (let i = 0; i < 6; i++) {
      noise(v, { at: i * 0.04 + rnd(0, 0.03), d: 0.06, v: 0.35, flt: ['bandpass', rnd(1500, 5000), null, 2] });
    }
    for (let i = 0; i < 4; i++) tone(v, { w: 'sine', f: rnd(3000, 6500), at: 0.02 + i * 0.05, d: 0.12, v: 0.07 });
    tone(v, { w: 'sine', f: 150, f2: 60, d: 0.1, v: 0.5 });
  },
  squish(v) {
    noise(v, { d: 0.28, a: 0.02, v: 0.42, flt: ['bandpass', 1400, 250, 4] });
    tone(v, { w: 'sine', f: 260, f2: 80, d: 0.25, v: 0.35, vib: [30, 40] });
  },
  quack(v) {
    tone(v, { w: 'sawtooth', f: 560, f2: 420, d: 0.17, v: 0.45, hold: true, r: 0.05, flt: ['bandpass', 1300, 900, 2.5] });
    tone(v, { w: 'square', f: 280, f2: 210, d: 0.17, v: 0.12, hold: true, r: 0.05, flt: ['bandpass', 2600, null, 4] });
  },
  horn(v) {
    for (const [f, f2] of [[340, 370], [428, 466]]) {
      tone(v, { w: 'sawtooth', f, f2, sd: 0.05, d: 0.4, a: 0.01, hold: true, r: 0.06, v: 0.18, flt: ['lowpass', 2600, null, 2] });
    }
  },
  bang(v) {
    noise(v, { d: 0.03, a: 0.001, v: 0.9, flt: ['highpass', 800] });
    noise(v, { d: 0.45, a: 0.002, v: 0.5, flt: ['lowpass', 2500, 300] });
    tone(v, { w: 'sine', f: 160, f2: 40, d: 0.12, v: 0.8 });
  },
  cork(v) {
    tone(v, { w: 'sine', f: 220, f2: 1300, sd: 0.03, d: 0.07, v: 0.6 });
    noise(v, { at: 0.03, d: 0.7, a: 0.05, v: 0.14, trem: [38, 0.4, 'square'], flt: ['highpass', 5500] });
  },
  freeze(v) {
    noise(v, { d: 0.1, v: 0.3, flt: ['bandpass', 3000, null, 2] });
    noise(v, { d: 0.8, a: 0.05, v: 0.22, flt: ['highpass', 9000, 3000] });
    for (let i = 0; i < 6; i++) tone(v, { w: 'sine', f: rnd(2500, 5000), at: 0.05 + i * 0.08, d: 0.25, v: 0.09 });
    tone(v, { w: 'triangle', f: 1800, f2: 900, d: 0.6, v: 0.07, vib: [12, 40] });
  },
  fire(v) {
    noise(v, { d: 0.75, a: 0.06, v: 0.5, flt: ['lowpass', 500, 2500, 1, 0.25] });
    noise(v, { d: 0.7, v: 0.18, trem: [17, 0.5, 'square'], flt: ['highpass', 4000] });
    tone(v, { w: 'sine', f: 80, f2: 55, d: 0.6, v: 0.25 });
  },
  fuse(v) {
    noise(v, { d: 1.0, a: 0.02, v: 0.26, hold: true, r: 0.08, trem: [23, 0.45, 'sawtooth'], flt: ['highpass', 3500] });
    noise(v, { d: 1.0, v: 0.12, hold: true, r: 0.08, trem: [41, 0.5, 'square'], flt: ['bandpass', 6500, null, 2] });
    const pops = [];
    for (let i = 0; i < 7; i++) pops.push(rnd(0.02, 0.95));
    hits(v, pops, { d: 0.015, v: 0.35, jit: true, flt: ['highpass', 2000] });
  },
  shrink(v) {
    for (let i = 0; i < 10; i++) {
      tone(v, { w: 'p25', f: 1000 * Math.pow(0.87, i) * (i % 2 ? 0.84 : 1), at: i * 0.055, d: 0.06, v: 0.2, hold: true, r: 0.01 });
    }
  },
  grow(v) {
    for (let i = 0; i < 10; i++) {
      tone(v, { w: 'square', f: 220 * Math.pow(1.15, i) * (i % 2 ? 1.33 : 1), at: i * 0.055, d: 0.06, v: 0.17, hold: true, r: 0.01 });
    }
  },
  swap(v) {
    tone(v, { w: 'sine', f: 400, f2: 1300, d: 0.3, v: 0.3, hold: true, r: 0.1 });
    tone(v, { w: 'triangle', f: 1300, f2: 400, d: 0.3, v: 0.22, hold: true, r: 0.1 });
    noise(v, { d: 0.3, a: 0.1, v: 0.12, flt: ['bandpass', 600, 2400, 2] });
  },
  goal(v) {
    for (const [f, w, vol] of [[220, 'sawtooth', 0.14], [277.18, 'sawtooth', 0.12], [110, 'square', 0.12]]) {
      tone(v, { w, f: f * 0.95, f2: f, sd: 0.1, d: 1.0, a: 0.02, hold: true, r: 0.15, v: vol, flt: ['lowpass', 1800, null, 1.5] });
    }
    crowdLayer(v, 'cheer', 0.1, 1, 0.8);
  },
  kick(v) {
    tone(v, { w: 'sine', f: 260, f2: 70, d: 0.12, v: 0.6 });
    tone(v, { w: 'triangle', f: 700, f2: 300, d: 0.04, v: 0.3 });
    noise(v, { d: 0.05, v: 0.35, flt: ['bandpass', 1800, null, 1.5] });
  },
  slide(v) {
    tone(v, { w: 'sine', f: 420, f2: 1350, sd: 0.45, d: 0.5, a: 0.03, hold: true, r: 0.08, v: 0.3, vib: [6, 10] });
    tone(v, { w: 'triangle', f: 840, f2: 2700, sd: 0.45, d: 0.5, a: 0.03, hold: true, r: 0.08, v: 0.05 });
    noise(v, { d: 0.5, a: 0.05, v: 0.05, flt: ['bandpass', 1500, null, 2] });
  },
  stack(v) {
    tone(v, { w: 'triangle', f: 820, f2: 700, d: 0.06, v: 0.35 });
    tone(v, { w: 'sine', f: 420, f2: 300, d: 0.1, v: 0.45 });
    noise(v, { d: 0.03, v: 0.2, flt: ['lowpass', 2500] });
  },
  wobble(v) {
    tone(v, { w: 'sine', f: 300, d: 0.7, v: 0.4, vib: [9, 90, 5], trem: [9, 0.3] });
    tone(v, { w: 'triangle', f: 150, d: 0.7, v: 0.2, vib: [9, 45, 3] });
  },
  tada(v) {
    for (const m of [67, 71, 74]) brass(v, mf(m), 0, 0.12, 0.07);
    for (const m of [72, 76, 79, 84]) brass(v, mf(m), 0.16, 0.9, 0.07);
    tone(v, { w: 'sine', f: 2093, at: 0.16, d: 0.6, v: 0.06, vib: [8, 30] });
    tone(v, { w: 'sine', f: 3136, at: 0.2, d: 0.5, v: 0.04 });
    noise(v, { at: 0.16, d: 0.8, v: 0.14, flt: ['highpass', 5000] });
  },
};

const DUCKERS = new Set(['go', 'win', 'lose', 'fanfare', 'tada', 'goal', 'bigexplode', 'explode', 'timeup',
  'matchpoint', 'buzzer', 'whistle']);

function playVoice(key, vol, pan, pitch, build) {
  const tm = nowMs(), last = lastPlay.get(key);
  if (last != null && tm - last < THROTTLE_MS) return;
  lastPlay.set(key, tm);
  while (active.length >= MAX_VOICES) active[0].kill();
  const v = new Voice(key, vol, pan, pitch);
  active.push(v);
  try { build(v); } finally { if (v.live === 0) v.free(); }
}

// ---------------------------------------------------------------------------
// Music: songs + lookahead step sequencer (16 steps per bar)
// ---------------------------------------------------------------------------
const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const acc = (s) => (s === '#' ? 1 : s === 'b' ? -1 : 0);
function noteMidi(n) {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(n);
  return m ? 12 * (+m[3] + 1) + PC[m[1]] + acc(m[2]) : null;
}
const CHQ = { '': [0, 4, 7], m: [0, 3, 7], 7: [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11], dim: [0, 3, 6], sus4: [0, 5, 7] };
function parseChord(s) {
  const m = /^([A-G])([#b]?)(.*)$/.exec(s) || ['', 'C', '', ''];
  return { pc: (PC[m[1]] + acc(m[2]) + 12) % 12, iv: CHQ[m[3]] || CHQ[''] };
}

// Patterns: one char per 16th step ('.' rest, '-' sustain previous). Lead: one token per `leadRes` steps.
const SONGS = {
  // Medieval tavern tunes: modal melodies on a recorder, lute plucks, frame drum, tabor and tambourine.
  menu: {
    bpm: 100, swing: 0.16,
    chords: ['Dm', 'C', 'Dm', 'Am', 'F', 'C', 'Dm C', 'Dm'],
    kick:  'x.....x.........',
    snare: '........x.......',
    hat:   '..o...o...o...o.',
    clap:  '',
    fill: { snare: '........x...x.x.' },
    bass: 'R.......F.......', bassOct: 2, bassW: 'triangle',
    arp: '0.2.1.2.0.2.1.2.', arpOct: 4,
    pad: 'x---------------', padOct: 3,
    leadRes: 2,
    lead: `D5 - F5 A5 G5 F5 E5 D5 | E5 - G5 E5 C5 - D5 E5 | F5 - A5 F5 D5 - F5 A5 | A5 - G5 F5 E5 - - . |
           F5 - A5 C6 A5 F5 G5 A5 | G5 - E5 C5 E5 G5 C6 B5 | A5 - F5 D5 G5 - E5 C5 | D5 - - - . . A4 -`,
    mix: { bass: 1.1, arp: 1, lead: 0.9, pad: 0.7 },
  },
  game: {
    bpm: 132,
    chords: ['Am', 'G', 'Am', 'Em', 'F', 'G', 'Am G', 'Am'],
    kick:  'x.......x.x.....',
    snare: '....x.......x...',
    hat:   'x.o.x.o.x.o.x.o.',
    fill: { snare: '....x...x.x.xxxx', kick: 'x...x...x.x.x...' },
    bass: 'R...O...R...O.F.', bassOct: 2, bassW: 'triangle',
    arp: '0120120120120123', arpOct: 4,
    leadRes: 2,
    lead: `A5 . A5 B5 C6 - B5 A5 | G5 . G5 A5 B5 - A5 G5 | A5 - E5 A5 C6 - B5 A5 | B5 - G5 - E5 - - . |
           F5 . A5 C6 A5 - F5 A5 | G5 - B5 D6 B5 G5 D5 G5 | E5 - A5 C6 B5 A5 G5 B5 | A5 - - - E5 - A4 -`,
    mix: { arp: 0.85, lead: 0.85 },
  },
  tense: {
    bpm: 150,
    chords: ['Cm', 'Cm', 'Ab', 'G', 'Cm', 'Cm', 'Db', 'G7'],
    kick:  'x..x..x...x..x..',
    snare: '....x.......x...',
    hat:   'xxxxxxxxxxxxxxxx',
    fill: { snare: '....x.......xxxx' },
    bass: 'RRR.RRR.RRR.RROR', bassOct: 2, bassW: 'triangle',
    arp: '0.1.0.2.0.1.0.3.', arpOct: 4,
    leadW: 'p25', leadRes: 2,
    lead: `G5 . Ab5 G5 . F#5 G5 . | C6 . B5 C6 . G5 Eb5 . | Ab5 . G5 Ab5 . C6 Eb6 . | D6 - - - B5 - G5 . |
           G5 . Ab5 G5 . F#5 G5 . | Eb6 . D6 C6 . B5 C6 . | Db6 . C6 Db6 . F5 Ab5 . | B5 - D6 - G6 - F6 D6`,
    mix: { hat: 0.6, bass: 0.8, lead: 0.85 },
  },
  final: {
    bpm: 120,
    chords: ['D', 'A', 'Bm', 'G', 'D', 'A', 'G A', 'D'],
    kick:  'x...x...x...x...',
    snare: '....x.......x...',
    clap:  '....x.......x...',
    hat:   '..o...o...o...o.',
    fill: { snare: '....x...xxxxxxxx' },
    bass: 'R..RO.R.R..RO.F.', bassOct: 2, bassW: 'triangle',
    arp: '0.1.2.3.2.1.2.3.', arpOct: 5,
    pad: 'x-------x-------', padOct: 4,
    leadW: 'sawtooth', leadRes: 2,
    lead: `F#5 - A5 - D6 - - A5 | C#6 - E6 - A5 - - . | D6 - C#6 B5 F#5 - B5 C#6 | D6 - B5 - G5 - - . |
           A5 - D6 - F#6 - E6 D6 | E6 - C#6 A5 E5 - A5 C#6 | D6 - B5 D6 E6 - C#6 E6 | D6 - - - - . A5 -`,
    mix: { arp: 0.6, lead: 0.9 },
  },
};
const MUSIC_NAMES = Object.keys(SONGS);

function compile(song) {
  if (song.steps) return song;
  const bars = song.chords.length, total = bars * 16;
  const steps = Array.from({ length: total }, () => []);
  const chords = song.chords.map((b) => b.trim().split(/\s+/).map(parseChord));
  const chordAt = (s) => { const p = chords[Math.floor(s / 16)]; return p[p.length > 1 && s % 16 >= 8 ? 1 : 0]; };
  const pat = (str) => (str || '').replace(/[\s|]/g, '');
  const lenAt = (p, i) => { let n = 1; while (n < 64 && p[(i + n) % p.length] === '-') n++; return n; };
  const mix = song.mix || {};
  const vel = (k) => num(mix[k], 1);
  for (let s = 0; s < total; s++) {
    const last = Math.floor(s / 16) === bars - 1;
    const ch = chordAt(s), ev = steps[s];
    for (const dr of ['kick', 'snare', 'hat', 'clap']) {
      const p = pat(last && song.fill && song.fill[dr] != null ? song.fill[dr] : song[dr]);
      if (!p) continue;
      const c = p[s % p.length];
      if (c === 'x') ev.push([dr, 0, 1, vel(dr)]);
      else if (c === 'o') ev.push([dr === 'hat' ? 'ohat' : dr, 0, 1, vel(dr)]);
    }
    const bp = pat(song.bass);
    if (bp) {
      const i = s % bp.length, c = bp[i];
      const off = { R: 0, O: 12, F: ch.iv[2], T: ch.iv[1] }[c];
      if (off != null) ev.push(['bass', mf(12 * (song.bassOct + 1) + ch.pc + off), lenAt(bp, i), vel('bass')]);
    }
    const ap = pat(song.arp);
    if (ap) {
      const c = ap[s % ap.length];
      if (c >= '0' && c <= '9') {
        const k = +c, n = ch.iv.length;
        ev.push(['arp', mf(12 * (song.arpOct + 1) + ch.pc + ch.iv[k % n] + 12 * Math.floor(k / n)), 1, vel('arp')]);
      }
    }
    const pp = pat(song.pad);
    if (pp && pp[s % pp.length] === 'x') {
      const len = lenAt(pp, s % pp.length);
      for (const iv of ch.iv.slice(0, 3)) ev.push(['pad', mf(12 * (song.padOct + 1) + ch.pc + iv), len, vel('pad')]);
    }
  }
  const tk = song.lead.trim().split(/\s+/).filter((x) => x !== '|');
  const res = song.leadRes || 2;
  tk.forEach((t, i) => {
    if (t === '-' || t === '.') return;
    const m = noteMidi(t);
    if (m == null) return;
    let n = 1;
    while (tk[i + n] === '-') n++;
    steps[(i * res) % total].push(['lead', mf(m), n * res, vel('lead')]);
  });
  song.steps = steps;
  song.total = total;
  return song;
}

// lightweight cleanup for music nodes: when every source ended, disconnect everything
function fin(srcs, nodes) {
  let n = srcs.length;
  const done = () => {
    if (--n > 0) return;
    for (const s of srcs) { try { s.disconnect(); } catch (e) { /* ignore */ } }
    for (const x of nodes) { try { x.disconnect(); } catch (e) { /* ignore */ } }
  };
  for (const s of srcs) s.onended = done;
}
function nsrc(t, d) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf; s.loop = true;
  s.start(t, Math.random() * 1.5); s.stop(t + d);
  return s;
}
function mosc(w, f, t, d) {
  const o = ctx.createOscillator();
  setWave(o, w);
  o.frequency.setValueAtTime(f, t);
  o.start(t); o.stop(t + d);
  return o;
}
function dgain(dst, t, vol, dec) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(EPS, t + dec);
  g.connect(dst);
  return g;
}
function bq(type, f, q) {
  const b = ctx.createBiquadFilter();
  b.type = type; b.frequency.value = f; if (q != null) b.Q.value = q;
  return b;
}

// Medieval band: frame drum, tabor, tambourine, lute (plucked), recorder (lead), hurdy-gurdy drone (pad).
const INST = {
  kick(dst, t, f, d, vel) { // frame drum: soft low thump
    const o = mosc('sine', 120, t, 0.32), g = dgain(dst, t, 0.55 * vel, 0.3);
    o.frequency.exponentialRampToValueAtTime(58, t + 0.14);
    o.connect(g);
    const n = nsrc(t, 0.06), b = bq('lowpass', 500), g2 = dgain(dst, t, 0.18 * vel, 0.05);
    n.connect(b); b.connect(g2);
    fin([o, n], [g, b, g2]);
  },
  snare(dst, t, f, d, vel) { // tabor: skin + snare string buzz
    const n = nsrc(t, 0.14), b = bq('bandpass', 1100, 0.9), g = dgain(dst, t, 0.24 * vel, 0.12);
    n.connect(b); b.connect(g);
    const o = mosc('triangle', 190, t, 0.1), g2 = dgain(dst, t, 0.22 * vel, 0.09);
    o.frequency.exponentialRampToValueAtTime(130, t + 0.08);
    o.connect(g2);
    fin([n, o], [b, g, g2]);
  },
  hat(dst, t, f, d, vel) { // tambourine jingle
    const n = nsrc(t, 0.07), b = bq('bandpass', 8200, 3), g = ctx.createGain(), v = 0.11 * vel;
    g.gain.setValueAtTime(0, t);
    for (const o of [0, 0.014, 0.03]) { g.gain.setValueAtTime(v, t + o); g.gain.exponentialRampToValueAtTime(v * 0.2, t + o + 0.012); }
    g.gain.exponentialRampToValueAtTime(EPS, t + 0.065);
    n.connect(b); b.connect(g); g.connect(dst); fin([n], [b, g]);
  },
  ohat(dst, t, f, d, vel) { // tambourine shake
    const n = nsrc(t, 0.22), b = bq('bandpass', 7600, 2.5), g = ctx.createGain(), v = 0.08 * vel;
    g.gain.setValueAtTime(0, t);
    for (let k = 0; k < 5; k++) { g.gain.setValueAtTime(v * (1 - k * 0.15), t + k * 0.035); g.gain.exponentialRampToValueAtTime(v * 0.15, t + k * 0.035 + 0.025); }
    g.gain.exponentialRampToValueAtTime(EPS, t + 0.21);
    n.connect(b); b.connect(g); g.connect(dst); fin([n], [b, g]);
  },
  clap(dst, t, f, d, vel) {
    const n = nsrc(t, 0.16), b = bq('bandpass', 1300, 1.1), g = ctx.createGain();
    const p = g.gain, v = 0.2 * vel;
    p.setValueAtTime(0, t);
    for (const o of [0, 0.012, 0.024]) {
      p.setValueAtTime(v, t + o);
      p.exponentialRampToValueAtTime(v * 0.25, t + o + 0.011);
    }
    p.setValueAtTime(v, t + 0.036);
    p.exponentialRampToValueAtTime(EPS, t + 0.15);
    n.connect(b); b.connect(g); g.connect(dst); fin([n], [b, g]);
  },
  bass(dst, t, f, d, vel, song) { // plucked bass lute
    const len = Math.max(0.12, Math.min(d * 0.95, 0.9));
    const o = mosc(song.bassW || 'triangle', f, t, len + 0.01);
    const b = bq('lowpass', Math.min(f * 6, nyq()), 1.2);
    b.frequency.setValueAtTime(Math.min(f * 6, nyq()), t);
    b.frequency.exponentialRampToValueAtTime(Math.max(f * 1.5, 60), t + Math.min(len, 0.3));
    const g = ctx.createGain(), v = 0.22 * vel;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v, t + 0.004);
    g.gain.exponentialRampToValueAtTime(v * 0.3, t + len * 0.7);
    g.gain.linearRampToValueAtTime(0, t + len);
    o.connect(b); b.connect(g); g.connect(dst); fin([o], [b, g]);
  },
  arp(dst, t, f, d, vel) { // lute pluck: bright attack, the filter closes fast
    const len = 0.38;
    const o = mosc('sawtooth', f, t, len + 0.01), o2 = mosc('triangle', f * 2, t, len + 0.01);
    const b = bq('lowpass', Math.min(f * 8, nyq()), 3);
    b.frequency.setValueAtTime(Math.min(f * 8, nyq()), t);
    b.frequency.exponentialRampToValueAtTime(Math.max(f * 1.2, 80), t + 0.22);
    const g = ctx.createGain(), v = 0.06 * vel, g2 = ctx.createGain();
    g2.gain.value = 0.3;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v, t + 0.002);
    g.gain.exponentialRampToValueAtTime(EPS, t + len);
    o.connect(b); o2.connect(g2); g2.connect(b); b.connect(g); g.connect(dst); fin([o, o2], [b, g, g2]);
  },
  lead(dst, t, f, d, vel) { // recorder: soft sine + a little breath, gentle vibrato
    const len = Math.max(0.08, d * 0.92);
    const o1 = mosc('sine', f, t, len + 0.01), o2 = mosc('triangle', f * 2, t, len + 0.01);
    const vib = mosc('sine', 5.5, t, len + 0.01), vg = ctx.createGain();
    vg.gain.setValueAtTime(0, t);
    vg.gain.linearRampToValueAtTime(f * 0.006, t + Math.min(0.25, len));
    vib.connect(vg); vg.connect(o1.frequency); vg.connect(o2.frequency);
    const g = ctx.createGain(), v = 0.1 * vel, g2 = ctx.createGain();
    g2.gain.value = 0.12;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v, t + 0.03);
    g.gain.setValueAtTime(v * 0.9, t + Math.max(0.04, len - 0.05));
    g.gain.linearRampToValueAtTime(0, t + len);
    const n = nsrc(t, Math.min(len, 0.12) + 0.01), nb = bq('bandpass', Math.min(f * 2, nyq()), 2), ng = dgain(dst, t, 0.025 * vel, 0.1);
    n.connect(nb); nb.connect(ng);
    o1.connect(g); o2.connect(g2); g2.connect(g); g.connect(dst);
    fin([o1, o2, vib, n], [g, g2, vg, nb, ng]);
  },
  pad(dst, t, f, d, vel) { // hurdy-gurdy drone
    const len = Math.max(0.2, d);
    const o = mosc('sawtooth', f, t, len + 0.01);
    const b = bq('lowpass', 750, 1.5);
    const g = ctx.createGain(), v = 0.03 * vel;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v, t + 0.12);
    g.gain.setValueAtTime(v, t + len * 0.8);
    g.gain.linearRampToValueAtTime(0, t + len);
    o.connect(b); b.connect(g); g.connect(dst); fin([o], [b, g]);
  },
};

const players = [];   // current + fading-out players
let current = null;
let wanted = null;    // last requested track (applied once the context runs)
let tempoTarget = 1;
let timer = null;

function startMusic(name) {
  if ((current ? current.name : null) === name) return;
  const t = ctx.currentTime;
  if (current) {
    const g = current.g.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + FADE);
    current.stopAt = t + FADE;
    current = null;
  }
  if (name) {
    const song = compile(SONGS[name]);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1, t + FADE);
    g.connect(musicBus);
    current = { name, song, g, step: 0, next: t + 0.05, tempo: tempoTarget, stopAt: Infinity };
    players.push(current);
  }
  if (!timer) tick();
}

function scheduleStep(p, silent) {
  // smooth tempo glide: at most 1% per step
  p.tempo += clamp(tempoTarget - p.tempo, -0.01, 0.01);
  const song = p.song, sd = 60 / (song.bpm * p.tempo) / 4;
  const s = p.step % song.total;
  let t = p.next;
  if (song.swing && (s & 1)) t += song.swing * sd;
  if (!silent) {
    for (const e of song.steps[s]) INST[e[0]](p.g, t, e[1], e[2] * sd, e[3], song);
  }
  p.step = (s + 1) % song.total;
  p.next += sd;
}

function tick() {
  timer = null;
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    const hidden = typeof document !== 'undefined' && document.hidden;
    const horizon = now + (hidden ? LOOKAHEAD_HIDDEN : LOOKAHEAD);
    const silent = musicSilent() || ctx.state !== 'running';
    for (let i = players.length - 1; i >= 0; i--) {
      const p = players[i];
      if (p.next < now - 0.1) p.next = now + 0.02; // fell behind (throttled tab): skip, don't burst
      while (p.next < horizon && p.next < p.stopAt) scheduleStep(p, silent);
      if (p.stopAt !== Infinity && now > p.stopAt + 0.05) {
        try { p.g.disconnect(); } catch (e) { /* ignore */ }
        players.splice(i, 1);
      }
    }
  } catch (e) { /* never break the loop on a single bad note */ }
  if (players.length) timer = setTimeout(tick, TIMER_MS);
}

function onRunning() {
  try {
    if ((current ? current.name : null) !== wanted) startMusic(wanted);
    else if (players.length && !timer) tick();
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Announcer (speechSynthesis)
// ---------------------------------------------------------------------------
let itVoice = null, voicesHooked = false, speechPrimed = false, duckTimer = null;

function speechOK() {
  return HAS_WIN && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function';
}

function pickVoice() {
  if (itVoice) return itVoice;
  const ss = window.speechSynthesis;
  if (!voicesHooked) {
    voicesHooked = true;
    try { ss.addEventListener('voiceschanged', () => { itVoice = null; }); } catch (e) { /* ignore */ }
  }
  let best = null, bestScore = 0;
  for (const vc of ss.getVoices() || []) {
    const lang = (vc.lang || '').replace('_', '-').toLowerCase();
    let sc = lang === 'it-it' ? 10 : lang.startsWith('it') ? 6 : 0;
    if (!sc) continue;
    if (/google|natural|neural|premium|enhanced|alice|luca|federica/i.test(vc.name)) sc += 2;
    if (vc.localService) sc += 1;
    if (sc > bestScore) { bestScore = sc; best = vc; }
  }
  itVoice = best;
  return best;
}

function duckVoice(on, hold) {
  if (!voiceDuck || !ctx) return;
  const g = voiceDuck.gain, t = ctx.currentTime;
  g.cancelScheduledValues(t);
  g.setTargetAtTime(on ? 0.5 : 1, t, on ? 0.05 : 0.2);
  clearTimeout(duckTimer);
  if (on) duckTimer = setTimeout(() => duckVoice(false), hold * 1000); // safety if onend never fires
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export const audio = {
  settings: { sfx: 0.8, music: 0.45, voice: true, muted: false },
  names: Object.freeze(Object.keys(SFX)),

  unlock() {
    try {
      if (!ACtor) return Promise.resolve(false);
      if (!init()) return Promise.resolve(false);
      installGestureHooks();
      if (!silentPlayed || ctx.state !== 'running') {
        // iOS: playing a buffer inside the gesture unlocks output
        silentPlayed = true;
        const b = ctx.createBuffer(1, 1, ctx.sampleRate);
        const s = ctx.createBufferSource();
        s.buffer = b; s.connect(ctx.destination);
        s.onended = () => { try { s.disconnect(); } catch (e) { /* ignore */ } };
        s.start(0);
      }
      if (!speechPrimed && speechOK()) {
        // iOS: the first utterance must come from a gesture
        speechPrimed = true;
        try {
          const ss = window.speechSynthesis;
          if (!ss.speaking) { const u = new window.SpeechSynthesisUtterance(' '); u.volume = 0; ss.speak(u); }
        } catch (e) { /* ignore */ }
      }
      if (ctx.state !== 'running') {
        return ctx.resume().then(() => { onRunning(); return ctx.state === 'running'; }, () => false);
      }
      onRunning();
      return Promise.resolve(true);
    } catch (e) {
      return Promise.resolve(false);
    }
  },

  sfx(name, opts) {
    try {
      const build = SFX[name];
      if (!build || !Object.prototype.hasOwnProperty.call(SFX, name)) {
        warnOnce('sfx:' + name, 'unknown sfx "' + name + '"');
        return;
      }
      if (!ready() || sfxSilent()) return;
      const o = opts || {};
      playVoice(name, clamp(num(o.vol, 1), 0, 2), num(o.pan, 0), clamp(num(o.pitch, 1), 0.25, 4), build);
      if (DUCKERS.has(name)) duck();
    } catch (e) { /* never throw */ }
  },

  crowd(kind) {
    try {
      if (!CROWDS.includes(kind)) { warnOnce('crowd:' + kind, 'unknown crowd "' + kind + '"'); return; }
      if (!ready() || sfxSilent()) return;
      const rate = rnd(0.9, 1.1);
      playVoice('crowd:' + kind, 0.85, 0, 1, (v) => crowdLayer(v, kind, 0, rate, 1));
    } catch (e) { /* never throw */ }
  },

  music(name) {
    try {
      if (name != null && !Object.prototype.hasOwnProperty.call(SONGS, name)) {
        warnOnce('music:' + name, 'unknown music "' + name + '"');
        return;
      }
      const next = name || null;
      if (next !== wanted) tempoTarget = 1; // new track starts at normal speed
      wanted = next;
      if (ready()) startMusic(wanted);
    } catch (e) { /* never throw */ }
  },

  setTempo(mult) {
    tempoTarget = clamp(num(mult, 1), 0.5, 2);
  },

  say(text, opts) {
    try {
      const s = audio.settings || {};
      if (!text || !s.voice || s.muted || !speechOK()) return;
      const o = opts || {};
      const ss = window.speechSynthesis;
      if (o.interrupt !== false) ss.cancel();
      const str = String(text);
      const u = new window.SpeechSynthesisUtterance(str);
      u.lang = 'it-IT';
      const vc = pickVoice();
      if (vc) { u.voice = vc; u.lang = vc.lang; }
      u.rate = clamp(num(o.rate, 1.1), 0.5, 2);
      u.pitch = clamp(num(o.pitch, 1), 0, 2);
      u.volume = 1;
      u.onstart = () => duckVoice(true, 1.5 + str.length * 0.12);
      u.onend = u.onerror = () => { if (!ss.speaking) duckVoice(false); };
      if (ss.paused) ss.resume();
      ss.speak(u);
    } catch (e) { /* never throw */ }
  },

  applySettings() {
    try {
      applyGains(false);
      const s = audio.settings || {};
      if ((s.muted || !s.voice) && speechOK()) window.speechSynthesis.cancel();
      if (players.length && !timer) tick();
    } catch (e) { /* never throw */ }
  },

  // Not in the spec: handy for the test page / debugging.
  debug() {
    return {
      supported: !!ACtor,
      state: ctx ? ctx.state : 'none',
      voices: active.length,
      music: current ? current.name : null,
      tempo: current ? +current.tempo.toFixed(3) : tempoTarget,
      players: players.length,
    };
  },
  crowds: Object.freeze(CROWDS.slice()),
  musics: Object.freeze(MUSIC_NAMES.slice()),
};

export default audio;
