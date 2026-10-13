// Global crazy rules ("regole pazze"). Time/input mods are applied by the Host,
// render mods by the client renderer, flag mods are read by games that opt in.
export const MODS = [
  { id: 'turbo', name: 'Pozione della Fretta', desc: 'Il mago ha esagerato: tutto va più veloce!', icon: '⚗️', kind: 'time' },
  { id: 'moviola', name: 'Incantesimo Lumaca', desc: 'Una strega dispettosa rallenta il tempo…', icon: '🐌', kind: 'time' },
  { id: 'fisarmonica', name: 'Clessidra Matta', desc: 'Il tempo accelera e rallenta!', icon: '⏳', kind: 'time' },
  { id: 'invert', name: 'Maledizione del Giullare', desc: 'Destra è sinistra. Auguri, messere!', icon: '🃏', kind: 'input', needDir: true },
  { id: 'scirocco', name: 'Fiato del Drago', desc: 'Un vento di drago vi spinge!', icon: '🐉', kind: 'input', needDir: true },
  { id: 'sapone', name: 'Pavimento Unto di Lardo', desc: 'I comandi scivolano come nelle cucine del castello', icon: '🥓', kind: 'input', needDir: true },
  { id: 'nonna', name: 'Piccione Viaggiatore', desc: 'I comandi arrivano in ritardo!', icon: '🕊️', kind: 'input' },
  { id: 'scambio', name: 'Pozione dello Scambio', desc: 'Ogni tanto vi scambiate i comandi!', icon: '🔮', kind: 'input' },
  { id: 'specchio', name: 'Specchio della Strega', desc: 'Lo schermo è allo specchio!', icon: '🪞', kind: 'render' },
  { id: 'sottosopra', name: 'Giostra del Re', desc: 'Il reame gira su se stesso!', icon: '🎠', kind: 'render' },
  { id: 'ubriaco', name: 'Troppo Idromele', desc: 'La vista ondeggia: il menestrello ha bevuto troppo', icon: '🍺', kind: 'render' },
  { id: 'nebbia', name: 'Nebbia della Palude', desc: 'Si vede solo vicino a voi!', icon: '🌫️', kind: 'render', needFocus: true },
  { id: 'tubo', name: 'Sfera di Cristallo Crepata', desc: 'Si vede tutto da una sfera magica rotta!', icon: '🔮', kind: 'render' },
  { id: 'disco', name: 'Ballo a Corte', desc: 'Luci incantate: si balla!', icon: '🎻', kind: 'render' },
  { id: 'cugino', name: 'Occhio del Ciclope', desc: 'Zoom troppo vicino!', icon: '👁️', kind: 'render', needFocus: true },
  { id: 'festa', name: 'Festa del Villaggio', desc: 'Petali e coriandoli a ogni colpo!', icon: '🎉', kind: 'render' },
  { id: 'giganti', name: 'Gigante contro Folletto', desc: 'Chi è in vantaggio diventa minuscolo!', icon: '🧌', kind: 'flag', optIn: 'scale' },
  { id: 'luna', name: 'Incantesimo Piuma', desc: 'Niente gravità: si vola!', icon: '🪶', kind: 'flag', optIn: 'gravity' },
  { id: 'peperoncino', name: 'Arco Stregato', desc: 'Il tasto A spara da solo!', icon: '🏹', kind: 'input', optIn: 'autoA' },
];

// Null prototype: client-sent ids like 'constructor' must never look like a mod.
export const MOD_BY_ID = Object.assign(Object.create(null), Object.fromEntries(MODS.map((m) => [m.id, m])));

// Mods compatible with a game definition.
export function compatibleMods(def) {
  const no = new Set(def.noMods || []);
  const sup = new Set(def.supports || []);
  return MODS.filter((m) => {
    if (no.has(m.id)) return false;
    if (m.optIn && !sup.has(m.optIn)) return false;
    if (m.needDir && !def.controls?.dir) return false;
    if (m.needFocus && typeof def.focus !== 'function') return false;
    return true;
  });
}

// Time scale contributed by time mods at game time t.
export function modTimeScale(mods, t) {
  let s = 1;
  if (mods.includes('turbo')) s *= 1.45;
  if (mods.includes('moviola')) s *= 0.72;
  if (mods.includes('fisarmonica')) s *= 1.05 + 0.55 * Math.sin((t * Math.PI * 2) / 4);
  return s;
}

// Flags exposed to games as g.mods.
// score = match points per seat (game player index), length n.
export function modFlags(mods, score) {
  const f = {};
  if (mods.includes('giganti')) {
    // Leader becomes tiny, last place becomes a giant (catch-up). Ties: the later seat is the "leader".
    const hi = Math.max(...score), lo = Math.min(...score);
    let lead = score.lastIndexOf(hi), last = score.indexOf(lo);
    if (lead === last) { lead = score.length - 1; last = 0; }
    f.scale = score.map((_, k) => (k === lead ? 0.6 : k === last ? 1.6 : 1));
  }
  if (mods.includes('luna')) f.gravity = 0.4;
  if (mods.includes('peperoncino')) f.autoA = true;
  for (const m of mods) f[m] = true;
  return f;
}

// Stateful input transformer for one game session.
export function makeInputMods(mods, rng) {
  const has = (id) => mods.includes(id);
  const windDir = rng.sign();
  const windFlipAt = rng.range(8, 16);
  const smooth = [0, 1, 2, 3].map(() => ({ x: 0, y: 0 }));
  const delayBuf = [];
  const DELAY_TICKS = 11; // ~180 ms
  const autoTimer = [0, 0, 0, 0];
  const st = { swapped: false, lastSwap: false, windDir };

  // inp: one game input per seat (already with aP/aN). Returns transformed copy.
  function apply(inp, t, dt, emit) {
    let out = inp.map((i) => ({ ...i }));
    if (has('nonna')) {
      delayBuf.push(out);
      out = delayBuf.length > DELAY_TICKS ? delayBuf.shift() : out.map((i) => ({ ...i, a: false, b: false, aP: false, bP: false, aN: 0, bN: 0, x: 0, y: 0, sx: 0, sy: 0 }));
    }
    if (has('invert')) for (const i of out) { i.x = -i.x; i.y = -i.y; i.sx = -i.sx; i.sy = -i.sy; }
    if (has('sapone')) {
      const k = 1 - Math.pow(0.006, dt);
      out.forEach((i, n) => {
        smooth[n].x += (i.x - smooth[n].x) * k; smooth[n].y += (i.y - smooth[n].y) * k;
        i.x = smooth[n].x; i.y = smooth[n].y;
      });
    }
    if (has('scirocco')) {
      const dir = t > windFlipAt ? -windDir : windDir;
      if (st.windDir !== dir) { st.windDir = dir; emit.say(dir > 0 ? 'IL VENTO CAMBIA! →' : 'IL VENTO CAMBIA! ←'); emit.sfx('whoosh'); }
      for (const i of out) { i.x = Math.max(-1, Math.min(1, i.x + 0.4 * dir)); i.sx = Math.max(-1, Math.min(1, i.sx + 0.4 * dir)); }
    }
    if (has('peperoncino')) {
      out.forEach((i, n) => {
        autoTimer[n] -= dt;
        if (autoTimer[n] <= 0) { autoTimer[n] = 0.25; i.a = true; i.aP = true; i.aN = Math.max(1, i.aN); i.aT = t; }
      });
    }
    if (has('scambio')) {
      // Swap for 3 s every 8 s, starting at 6 s. Warn 1 s before.
      const cyc = (((t - 6) % 8) + 8) % 8;
      const swapped = t >= 6 && cyc < 3;
      if (st.prevCyc !== undefined && st.prevCyc < 7 && cyc >= 7) emit.say('SCAMBIO IN ARRIVO!');
      st.prevCyc = cyc;
      if (swapped !== st.lastSwap) {
        st.lastSwap = swapped;
        emit.say(swapped ? '🔀 SCAMBIO DI CORPI!' : 'TORNATE A CASA!');
        emit.sfx('swap');
      }
      st.swapped = swapped;
      // Every player gets the controls of the next one (2 players: a plain swap).
      if (swapped) out = out.map((_, k) => out[(k + 1) % out.length]);
    }
    return out;
  }
  return { apply, state: st };
}
