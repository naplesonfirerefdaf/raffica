// DOM menus (home, "Unisciti!", network, lobby, practice, settings, how-to). Navigable with touch, mouse,
// keyboard and gamepad (spatial focus); the "Unisciti!" and lobby screens read every device on its own.
import * as THREE from '../../vendor/three.module.min.js';
import { ACTIONS, DEFAULT_KEYS, DEFAULT_PAD, PAD_NAMES, keyName } from './input.js';
import { PLAYER_COLORS, CHAR_BY_ID, CHARACTERS, MAX_PLAYERS, maxPlayersOf } from '../core/proto.js';
import { preload, charAssets, makeCharacter } from './models.js';
import { BOT_LEVELS } from '../core/bots.js';
import { TEAMS, colorMap, teamSplit } from './teams.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SLOTS = [...Array(MAX_PLAYERS).keys()];
const PREVIEW_SCREENS = new Set(['join', 'lobby']);
const JOIN_DELAY = 1.6; // seconds between "everyone ready" and the start (time for a late player to join)
// Jeweled crown over the logo: one gem per team color.
const CROWN_SVG = `<svg class="crown" viewBox="0 0 120 78" aria-hidden="true">
  <defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff6c8"/><stop offset=".45" stop-color="#f6c94e"/><stop offset=".55" stop-color="#c88a18"/><stop offset="1" stop-color="#ffd86a"/></linearGradient></defs>
  <path d="M10 66 L4 18 L32 40 L60 6 L88 40 L116 18 L110 66 Z" fill="url(#cg)" stroke="#3a1d06" stroke-width="4" stroke-linejoin="round"/>
  <rect x="8" y="60" width="104" height="14" rx="4" fill="url(#cg)" stroke="#3a1d06" stroke-width="4"/>
  <circle cx="4" cy="16" r="5" fill="#ffe68c" stroke="#3a1d06" stroke-width="3"/><circle cx="60" cy="5" r="5" fill="#ffe68c" stroke="#3a1d06" stroke-width="3"/><circle cx="116" cy="16" r="5" fill="#ffe68c" stroke="#3a1d06" stroke-width="3"/>
  <circle cx="27" cy="67" r="4.5" fill="#ff4b5c" stroke="#3a1d06" stroke-width="2"/><circle cx="49" cy="67" r="4.5" fill="#3fa9ff" stroke="#3a1d06" stroke-width="2"/>
  <circle cx="71" cy="67" r="4.5" fill="#5fd35a" stroke="#3a1d06" stroke-width="2"/><circle cx="93" cy="67" r="4.5" fill="#ffc53d" stroke="#3a1d06" stroke-width="2"/>
  <path d="M60 30 L67 42 L60 54 L53 42 Z" fill="#ff4b5c" stroke="#3a1d06" stroke-width="2.5"/>
  <path d="M20 26 L28 50 M100 26 L92 50" stroke="rgba(255,255,255,.5)" stroke-width="3" stroke-linecap="round"/>
</svg>`;

export class UI {
  constructor(app) {
    this.app = app;
    this.root = $('#ui');
    this.screen = null;
    this.back = null;
    this.preview = null; // the only extra WebGL renderer: character previews, alive on join/lobby only
    this.goAt = 0;
    this.preloaded = new Set();
  }

  show(name, ...args) {
    this.root.classList.remove('hidden');
    this.screen = name;
    this.root.innerHTML = '';
    this.refreshControls = null;
    if (!PREVIEW_SCREENS.has(name)) this.dropPreview();
    const el = this[`s_${name}`](...args);
    this.root.appendChild(el);
    this.root.scrollTop = 0;
    // Device-driven screens never hold focus: Space/Enter are game keys there.
    if (PREVIEW_SCREENS.has(name)) { document.activeElement?.blur?.(); return; }
    const first = el.querySelector('[data-autofocus]') || el.querySelector('.btn:not([disabled])');
    if (first && !this.app.isTouch) first.focus({ preventScroll: true });
  }

  hide() {
    this.root.classList.add('hidden');
    this.screen = null;
    this.dropPreview();
  }

  visible() { return !this.root.classList.contains('hidden'); }

  dropPreview() {
    if (this.preview) { this.preview.dispose(); this.preview = null; }
  }

  el(html, cls = 'screen') {
    const d = document.createElement('div');
    d.className = cls;
    d.innerHTML = html;
    return d;
  }

  bind(el, map) {
    for (const [sel, fn] of Object.entries(map)) {
      el.querySelectorAll(sel).forEach((b) => b.addEventListener('click', (e) => { this.app.click(); fn(e, b); }));
    }
  }

  // ---------- focus navigation ----------
  nav(ev) {
    if (!this.visible()) return false;
    const items = [...this.root.querySelectorAll('.btn:not([disabled]), input[type=text], [data-nav]:not([disabled])')].filter((b) => b.offsetParent !== null);
    if (!items.length) return false;
    let cur = document.activeElement;
    if (!items.includes(cur)) cur = null;
    if (ev.act === 'ok') {
      if (ev.src === 'kb' && (ev.code === 'Enter' || ev.code === 'Space' || ev.code === 'NumpadEnter') && cur) return true; // native click
      (cur || items[0]).click();
      return true;
    }
    if (ev.act === 'back') { if (this.back) { this.app.click(); this.back(); } return true; }
    if (!cur) { items[0].focus(); return true; }
    const r0 = cur.getBoundingClientRect();
    const c0 = { x: r0.left + r0.width / 2, y: r0.top + r0.height / 2 };
    const dir = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[ev.act];
    let best = null, bestScore = Infinity;
    for (const it of items) {
      if (it === cur) continue;
      const r = it.getBoundingClientRect();
      const dx = r.left + r.width / 2 - c0.x, dy = r.top + r.height / 2 - c0.y;
      const along = dx * dir[0] + dy * dir[1];
      if (along <= 4) continue;
      const across = Math.abs(dx * dir[1]) + Math.abs(dy * dir[0]);
      const score = along + across * 2.2;
      if (score < bestScore) { bestScore = score; best = it; }
    }
    if (best) { best.focus(); best.scrollIntoView({ block: 'nearest' }); this.app.sound('tick'); }
    return true;
  }

  // Per-device events (press/dir/nav) for the "Unisciti!" and lobby screens. Returns true when consumed.
  deviceInput(ev) {
    if (this.screen === 'join') return this.joinInput(ev);
    if (this.screen === 'lobby') return this.lobbyInput(ev);
    return false;
  }

  // Called every frame while a menu is visible.
  tick(dt, now) {
    if (this.screen === 'join') this.joinTick(now);
    if (!PREVIEW_SCREENS.has(this.screen)) return;
    if (!this.preview) this.preview = new CharPreview();
    const cards = [...this.root.querySelectorAll('.pcard')];
    const t = now / 1000;
    // Download the chosen characters right away (the game needs them too), even without the 3D preview.
    for (const c of cards) {
      const id = c.dataset.char;
      if (id && !this.preloaded.has(id)) { this.preloaded.add(id); preload(charAssets(id)); }
    }
    const items = cards.filter((c) => !c.classList.contains('empty') && c.dataset.char).map((c) => ({
      key: c.dataset.slot, canvas: c.querySelector('.pc-cv'), char: c.dataset.char,
      cheer: c.classList.contains('ready') || t < Number(c.dataset.cheer || 0),
    }));
    this.preview.draw(items, dt);
    for (const c of cards) c.classList.toggle('has3d', !c.classList.contains('empty') && this.preview.shows(c.dataset.slot, c.dataset.char));
  }

  // ---------- screens ----------
  s_home() {
    const app = this.app;
    this.back = null;
    const el = this.el(`
      <div class="crest">${CROWN_SVG}<div class="logo">RAFFICA!</div></div>
      <p class="tagline">${app.games.length} sfide a corte · da 2 a 4 giocatori · regole folli</p>
      <button class="btn big hot" id="local" data-autofocus>⚔️ Gioca qui <small>stesso schermo · 2–4 giocatori</small></button>
      <button class="btn big gold" id="solo">🤖 Gioca da solo <small>tu contro i bot · 3 livelli</small></button>
      <button class="btn big teams2" id="duo">👥 2 contro 2 <small>tu e un amico (Rossi) contro 2 bot Cavaliere (Blu)</small></button>
      <button class="btn big cyan" id="net">🏰 Gioca in rete <small>più dispositivi · anche online</small></button>
      <div class="row">
        <button class="btn" id="practice">🎯 Allenamento</button>
        <button class="btn" id="howto">📜 Come si gioca</button>
      </div>
      <button class="btn ghost" id="settings">⚙️ Impostazioni</button>
    `);
    this.bind(el, {
      '#local': () => { app.settings.teams = false; this.show('join'); },
      '#solo': () => this.playSolo(),
      '#duo': () => this.playDuo(),
      '#net': () => this.show('netHome'),
      '#practice': () => this.show('practice'),
      '#howto': () => this.show('howto'),
      '#settings': () => this.show('settings'),
    });
    return el;
  }

  // "Gioca da solo": straight to "Unisciti!" with one Cavaliere bot (the human takes the first place with A).
  playSolo() {
    const app = this.app;
    app.settings.teams = false; // tutti contro tutti, as always
    SLOTS.forEach((s) => { if (app.joined[s].bot) app.joined[s] = { on: false, rdy: false }; });
    const s = SLOTS.find((q) => q > 0 && !app.joined[q].on) ?? SLOTS.find((q) => !app.joined[q].on);
    if (s !== undefined) app.makeLocalBot(s, 'medio');
    this.show('join');
  }

  // "2 contro 2": teams on, two Cavaliere bots in the Blu team (places 3–4); the two friends press A and are the Rossa team.
  playDuo() {
    const app = this.app;
    SLOTS.forEach((s) => { app.joined[s] = { on: false, rdy: false }; app.ctl[s] = null; });
    if (app.localMode() === 'shared') app.layoutPref = 'pc'; // 4 players: the phone-on-the-table layout is for 2
    app.settings.teams = true;
    for (const s of [2, 3]) { app.makeLocalBot(s, 'medio'); app.joined[s].tm = 1; }
    this.show('join');
  }

  // ---------- "Unisciti!" (local play) ----------
  // Every device presses A to take a free place, picks a character with ◀ ▶, A = ready, B = back/out.
  joinMax() {
    const app = this.app;
    if (app.localMode() === 'shared') return 2;
    const def = app.joinOnly ? app.gameById(app.joinOnly[0]) : null;
    return def ? maxPlayersOf(def) : MAX_PLAYERS;
  }

  s_join(opts = {}) {
    const app = this.app;
    const st = app.settings;
    app.joinOnly = opts?.only || null;
    const def = app.joinOnly ? app.gameById(app.joinOnly[0]) : null;
    this.back = () => { app.joinOnly = null; this.show(def ? 'practice' : 'home'); };
    this.goAt = 0;
    const shared = app.localMode() === 'shared';
    const k = app.input.keys;
    const el = this.el(`
      <h2>${def ? `Allenamento: ${esc(def.name)}` : 'Unisciti!'}</h2>
      <p class="hint join-hint">Premi <b class="kA">A</b> per entrare: <kbd>${esc(keyName(k[0].a[0]))}</kbd> tastiera sinistra · <kbd>${esc(keyName(k[1].a[0]))}</kbd> tastiera destra · <kbd>✕</kbd> controller${app.isTouch ? ' · oppure tocca “Unisciti”' : ''}<br>
        <b>◀ ▶</b> personaggio · <b class="kA">A</b> pronto · <b class="kB">B</b> esci · <b>▲</b> aggiungi un bot 🤖 · <span id="downHint"><b>▼</b> togli l'ultimo bot</span></p>
      <div class="pcards" id="cards">${SLOTS.map((s) => cardHtml(s, true)).join('')}</div>
      <div class="join-status" id="status"></div>
      <div class="team-warn hidden" id="teamWarn"></div>
      <div class="card join-opts">
        <div class="opt"><h3>Schermo</h3>
          <div class="seg" id="layout">
            <button class="btn ${shared ? 'on' : ''}" data-v="shared">📱 Telefono sul tavolo <small>(2)</small></button>
            <button class="btn ${!shared ? 'on' : ''}" data-v="pc">🖥️ PC / TV</button>
          </div></div>
        ${def ? '' : `<div class="opt"><h3>Punti per vincere</h3>
          <div class="seg" id="target">${[3, 5, 7, 10].map((t) => `<button class="btn ${st.target === t ? 'on' : ''}" data-v="${t}">${t}</button>`).join('')}</div></div>`}
        <div class="opt"><h3>Regole</h3>
          <div class="seg">
            <button class="btn ${st.crazy ? 'on' : ''}" id="crazy">🤪 Pazze</button>
            <button class="btn ${st.variants ? 'on' : ''}" id="variants">🎲 Varianti</button>
            ${def ? '' : `<button class="btn ${st.loserPicks ? 'on' : ''}" id="loser">👆 Chi perde sceglie</button>`}
          </div></div>
        <div class="opt ${this.teamsPossible() ? '' : 'hidden'}"><h3>Squadre</h3>
          <div class="seg">
            <button class="btn ${st.teams ? 'on' : ''}" id="teams">⚔️ Squadre 2 contro 2 <small>Rossi contro Blu</small></button>
          </div></div>
        <div class="opt"><h3>Comandi</h3>
          <div class="seg">
            <button class="btn ghost keys" data-p="0">⌨️ Tasti sinistra</button>
            <button class="btn ghost keys" data-p="1">⌨️ Tasti destra</button>
          </div>
          <p class="hint" id="pads"></p></div>
      </div>
      <button class="btn ghost" id="back">← Indietro</button>
    `, 'screen wider');
    // Card buttons (mouse / touch).
    el.querySelectorAll('.pcard').forEach((card) => {
      const s = Number(card.dataset.slot);
      const on = (sel, fn) => card.querySelector(sel).addEventListener('click', (e) => { e.stopPropagation(); fn(); e.currentTarget.blur(); });
      on('.pc-join', () => this.joinByPointer(s));
      on('.pc-bot', () => this.addLocalBot(s));
      on('.pc-unbot', () => this.removeLocalBot(s));
      on('.pc-team', () => { const j = app.joined[s]; if (app.settings.teams && j.on && !(j.rdy && !j.bot)) this.setTeam(s, j.tm === 1 ? 0 : 1, false); });
      on('.pc-ready', () => this.setReady(s, !app.joined[s].rdy));
      on('.pc-leave', () => this.leaveSlot(s));
      card.querySelectorAll('.pc-arrow').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); b.blur(); this.changeChar(s, Number(b.dataset.d)); }));
      card.querySelectorAll('.pc-lv').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); b.blur(); this.changeLevel(s, Number(b.dataset.d)); }));
      const name = card.querySelector('.pc-name');
      name.value = app.names[s];
      name.addEventListener('change', () => {
        const j = app.joined[s];
        if (j.bot) { j.name = name.value.trim().slice(0, 12) || j.name; name.value = j.name; return; }
        app.names[s] = name.value.trim().slice(0, 12) || `Giocatore ${s + 1}`; app.saveNames();
      });
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') name.blur(); });
    });
    this.bind(el, {
      '.keys': (e, b) => this.show('keys', Number(b.dataset.p)),
      '#layout .btn': (e, b) => {
        const v = b.dataset.v;
        if (v === 'shared' && app.joined.filter((j) => j.on).length > 2) { app.toast('📱 Il telefono sul tavolo è per 2 giocatori'); return; }
        app.layoutPref = v;
        el.querySelectorAll('#layout .btn').forEach((x) => x.classList.toggle('on', x === b));
        this.refreshJoin();
      },
      '#target .btn': (e, b) => { st.target = Number(b.dataset.v); el.querySelectorAll('#target .btn').forEach((x) => x.classList.toggle('on', x === b)); app.saveSettings(); },
      '#crazy': (e, b) => { st.crazy = !st.crazy; b.classList.toggle('on', st.crazy); app.saveSettings(); },
      '#variants': (e, b) => { st.variants = !st.variants; b.classList.toggle('on', st.variants); app.saveSettings(); },
      '#loser': (e, b) => { st.loserPicks = !st.loserPicks; b.classList.toggle('on', st.loserPicks); app.saveSettings(); },
      '#teams': (e, b) => {
        st.teams = !st.teams;
        b.classList.toggle('on', st.teams);
        if (st.teams && app.localMode() === 'shared') { app.layoutPref = 'pc'; el.querySelectorAll('#layout .btn').forEach((x) => x.classList.toggle('on', x.dataset.v === 'pc')); }
        this.refreshJoin();
      },
      '#back': () => this.back(),
    });
    // Space / Enter are game keys here: never leave a clicked button focused.
    el.addEventListener('click', () => { const a = document.activeElement; if (a && a.tagName === 'BUTTON') a.blur(); });
    this.refreshControls = () => { if (this.screen === 'join') this.refreshJoin(); };
    queueMicrotask(() => this.refreshJoin());
    return el;
  }

  // The 2 vs 2 toggle: off in practice of a game without teams.
  teamsPossible() {
    const app = this.app;
    const def = app.joinOnly ? app.gameById(app.joinOnly[0]) : null;
    return !def || (maxPlayersOf(def) >= 4 && def.teams === true);
  }

  // Change the team of place s. swap = keep the 2 + 2 split by moving a bot of the new team to the old one
  // (so a keyboard / controller player can arrange the teams alone).
  setTeam(s, team, swap = true) {
    const app = this.app;
    const j = app.joined[s];
    if (!j.on || (j.tm === 1 ? 1 : 0) === team) return;
    const old = j.tm === 1 ? 1 : 0;
    j.tm = team;
    if (swap) {
      const mates = SLOTS.filter((q) => q !== s && app.joined[q].on && (app.joined[q].tm === 1 ? 1 : 0) === team);
      const bot = [...mates].reverse().find((q) => app.joined[q].bot);
      if (mates.length >= 2 && bot !== undefined) { app.joined[bot].tm = old; this.cheer(bot, 1.1); }
    }
    app.sound('tick');
    this.cheer(s, 1.1);
    this.refreshJoin();
  }

  // Which joined slot a device belongs to (-1 if none).
  slotOfDevice(ev) {
    const app = this.app;
    return SLOTS.find((s) => app.joined[s].on && app.ctl[s] && (ev.src === 'kb' ? app.ctl[s].kb.includes(ev.idx) : app.ctl[s].pads.includes(ev.idx))) ?? -1;
  }

  joinInput(ev) {
    const app = this.app;
    if (ev.type === 'nav') {
      if (ev.act === 'back' && ev.src === 'kb' && ev.code === 'Escape' && !this.typing()) { app.click(); this.back(); }
      return true;
    }
    if (ev.type === 'press') {
      if (ev.src === 'touch') return true;
      const slot = this.slotOfDevice(ev);
      if (ev.btn === 'a') {
        if (slot < 0) this.joinSlot(ev.src === 'kb' ? { kb: [ev.idx], pads: [] } : { kb: [], pads: [ev.idx] });
        else if (!app.joined[slot].rdy) this.setReady(slot, true);
      } else if (slot >= 0) {
        if (app.joined[slot].rdy) this.setReady(slot, false);
        else this.leaveSlot(slot);
      }
      return true;
    }
    if (ev.type === 'dir') {
      const slot = this.slotOfDevice(ev);
      if (slot >= 0 && !app.joined[slot].rdy && (ev.dir === 'left' || ev.dir === 'right')) this.changeChar(slot, ev.dir === 'left' ? -1 : 1);
      // ▲ / ▼ (any keyboard set or controller): add a bot in the first free place / take the last bot out.
      if (ev.dir === 'up' && !this.typing()) this.addLocalBot();
      if (ev.dir === 'down' && !this.typing()) {
        // With "Squadre 2 contro 2" on, ▼ of a player in the game (not ready yet) changes their team.
        if (app.settings.teams && this.teamsPossible() && slot >= 0 && !app.joined[slot].rdy) this.setTeam(slot, app.joined[slot].tm === 1 ? 0 : 1);
        else {
          const last = [...SLOTS].reverse().find((q) => app.joined[q].bot);
          if (last !== undefined) this.removeLocalBot(last);
        }
      }
      return true;
    }
    return false;
  }

  typing() {
    const el = document.activeElement;
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
  }

  joinSlot(ctl) {
    const app = this.app;
    const max = this.joinMax();
    let used = app.joined.filter((j) => j.on).length;
    let free = SLOTS.filter((s) => !app.joined[s].on && (app.localMode() !== 'shared' || s < 2));
    // Table full of bots: the newcomer takes the place of the last bot.
    const lastBot = [...SLOTS].reverse().find((s) => app.joined[s].bot && (app.localMode() !== 'shared' || s < 2));
    if ((used >= max || !free.length) && lastBot !== undefined) {
      app.joined[lastBot] = { on: false, rdy: false };
      used--; free = [lastBot];
    }
    if (used >= max || !free.length) { app.toast(max === 2 && app.localMode() === 'shared' ? '📱 Sul telefono sul tavolo si gioca in 2' : `Al massimo ${max} giocatori`); app.sound('tick'); return -1; }
    const s = free[0];
    app.joined[s] = { on: true, rdy: false, tm: app.humanTeam(s) };
    app.ctl[s] = ctl;
    app.sound('powerup');
    this.cheer(s);
    this.refreshJoin();
    return s;
  }

  // Mouse / touch "Unisciti": the touch screen on the shared phone, otherwise the first free keyboard set.
  joinByPointer(s) {
    const app = this.app;
    if (app.joined[s].on) return;
    let ctl;
    if (app.localMode() === 'shared') ctl = { kb: [], pads: [], touch: true };
    else {
      const usedKb = new Set(SLOTS.filter((q) => app.joined[q].on).flatMap((q) => app.ctl[q]?.kb || []));
      const k = [0, 1].find((x) => !usedKb.has(x));
      if (k === undefined) { app.toast('🎮 Le tastiere sono già prese: premi ✕ su un controller'); return; }
      ctl = { kb: [k], pads: [] };
    }
    const max = this.joinMax();
    if (app.joined.filter((j) => j.on).length >= max) { app.toast(`Al massimo ${max} giocatori`); return; }
    if (app.localMode() === 'shared' && s > 1) s = app.joined[0].on ? 1 : 0;
    app.joined[s] = { on: true, rdy: false, tm: app.humanTeam(s) };
    app.ctl[s] = ctl;
    app.sound('powerup');
    this.cheer(s);
    this.refreshJoin();
  }

  // Mouse / touch "+ Bot" on an empty card (s), or ▲ (first free place).
  addLocalBot(s = null) {
    const app = this.app;
    const shared = app.localMode() === 'shared';
    const max = this.joinMax();
    if (app.joined.filter((j) => j.on).length >= max) { app.toast(shared ? '📱 Sul telefono sul tavolo si gioca in 2' : `Al massimo ${max} giocatori`); app.sound('tick'); return -1; }
    if (s === null || app.joined[s].on || (shared && s > 1)) s = SLOTS.find((q) => !app.joined[q].on && (!shared || q < 2));
    if (s === undefined) return -1;
    app.makeLocalBot(s);
    app.sound('powerup');
    this.cheer(s);
    this.refreshJoin();
    return s;
  }

  removeLocalBot(s) {
    const app = this.app;
    if (!app.joined[s].bot) return;
    app.joined[s] = { on: false, rdy: false };
    app.sound('back');
    this.refreshJoin();
  }

  changeLevel(s, dir) {
    const app = this.app;
    const j = app.joined[s];
    if (!j.bot) return;
    j.bot = app.cycleLevel(j.bot, dir);
    app.rememberLevel(j.bot);
    app.sound('tick');
    this.cheer(s, 1.1);
    this.refreshJoin();
  }

  leaveSlot(s) {
    const app = this.app;
    app.joined[s] = { on: false, rdy: false };
    app.ctl[s] = null;
    app.sound('back');
    this.refreshJoin();
  }

  setReady(s, rdy) {
    const app = this.app;
    if (!app.joined[s].on) return;
    app.joined[s].rdy = rdy;
    app.sound(rdy ? 'select' : 'tick');
    if (rdy) this.cheer(s);
    this.refreshJoin();
  }

  changeChar(s, dir) {
    const app = this.app;
    const j = app.joined[s];
    if (j.bot) j.char = app.cycleChar(j.char, dir);
    else {
      if (!j.on || j.rdy) return;
      app.chars[s] = app.cycleChar(app.chars[s], dir);
      app.saveChars();
    }
    app.sound('tick');
    this.cheer(s, 1.1);
    this.refreshJoin();
  }

  cheer(s, sec = 1.4) {
    const card = this.root.querySelector(`.pcard[data-slot="${s}"]`);
    if (card) card.dataset.cheer = String(performance.now() / 1000 + sec);
  }

  // Short description of a player's devices.
  ctlText(ctl) {
    if (!ctl) return '';
    const app = this.app;
    const out = [];
    for (const k of ctl.kb || []) {
      const m = app.input.keys[k];
      const dir = [m.up[0], m.left[0], m.down[0], m.right[0]].join();
      out.push(`⌨️ ${dir === 'KeyW,KeyA,KeyS,KeyD' ? 'WASD' : dir === 'ArrowUp,ArrowLeft,ArrowDown,ArrowRight' ? 'Frecce' : 'Tastiera ' + (k + 1)} · A=${keyName(m.a[0])} B=${keyName(m.b[0])}`);
    }
    for (const p of ctl.pads || []) out.push(`🎮 ${app.input.padLabel(p)}`);
    if (ctl.touch) out.push('👆 Touch dal tuo lato');
    return out.join(' + ');
  }

  refreshJoin() {
    if (this.screen !== 'join') return;
    const app = this.app;
    const max = this.joinMax();
    const used = app.joined.filter((j) => j.on).length;
    const shared = app.localMode() === 'shared';
    const teams = !!app.settings.teams && this.teamsPossible();
    const cmap = colorMap(app.joined.map((j) => ({ on: j.on, tm: j.tm })), SLOTS.filter((q) => app.joined[q].on), teams);
    for (const card of this.root.querySelectorAll('.pcard')) {
      const s = Number(card.dataset.slot);
      const j = app.joined[s];
      const locked = !j.on && (used >= max || (shared && s > 1));
      setTeamLook(card, s, teams && j.on ? (j.tm === 1 ? 1 : 0) : null, cmap[s], teams && j.on && !(j.rdy && !j.bot));
      const bot = j.on && j.bot;
      card.classList.toggle('empty', !j.on);
      card.classList.toggle('ready', !!(j.on && j.rdy && !bot));
      card.classList.toggle('botc', !!bot);
      card.classList.toggle('locked', locked);
      const ch = CHAR_BY_ID[bot ? j.char : app.chars[s]] || CHARACTERS[0];
      card.dataset.char = j.on ? ch.id : '';
      card.querySelector('.pc-emoji').textContent = j.on ? ch.icon : '?';
      card.querySelector('.pc-char').textContent = j.on ? ch.name : '';
      card.querySelector('.pc-dev').textContent = j.on && !bot ? this.ctlText(app.ctl[s]) : '';
      const name = card.querySelector('input.pc-name');
      const want = bot ? j.name : app.names[s];
      if (document.activeElement !== name && name.value !== want) name.value = want;
      setLevel(card, bot ? j.bot : null);
      card.querySelector('.pc-msg').innerHTML = !j.on ? (locked ? '—' : 'Premi <b class="kA">A</b> per unirti')
        : bot ? '🤖 Sempre pronto' : j.rdy ? '✓ PRONTO!' : teams ? '◀ ▶ personaggio · <b>▼</b> squadra · <b class="kA">A</b> pronto' : '◀ ▶ personaggio · <b class="kA">A</b> pronto';
      card.querySelector('.pc-ready').textContent = j.rdy ? 'Annulla' : 'Pronto!';
    }
    const dh = this.root.querySelector('#downHint');
    const dhHtml = teams ? "<b>▼</b> cambia squadra 🚩 (se non sei entrato: togli l'ultimo bot)" : "<b>▼</b> togli l'ultimo bot";
    if (dh && dh.dataset.h !== dhHtml) { dh.innerHTML = dhHtml; dh.dataset.h = dhHtml; }
    const pads = app.input.pads();
    const padsBox = this.root.querySelector('#pads');
    if (padsBox) padsBox.textContent = pads.length ? `Controller collegati: ${pads.map((g) => app.input.padLabel(g.index)).join(', ')} — premi ✕ per unirti` : 'Nessun controller: collegane uno e premi ✕ (PS5 / Xbox)';
    this.joinStatus();
  }

  // Start condition: at least 2 players, all ready, and some game for that many players.
  joinState() {
    const app = this.app;
    const on = SLOTS.filter((s) => app.joined[s].on);
    const humans = on.filter((s) => !app.joined[s].bot);
    const rdy = humans.filter((s) => app.joined[s].rdy);
    const games = app.gamesFor(Math.max(2, on.length), app.joinOnly).length;
    const teams = !!app.settings.teams && this.teamsPossible();
    const split = teamSplit(app.joined.map((j) => ({ on: j.on, tm: j.tm })));
    const teamsBad = teams && !split.ok;
    return {
      on: on.length, humans: humans.length, rdy: rdy.length, games, teams, split, teamsBad,
      go: on.length >= 2 && humans.length >= 1 && rdy.length === humans.length && games > 0 && !teamsBad,
    };
  }

  joinStatus(now = performance.now()) {
    const box = this.root.querySelector('#status');
    if (!box) return;
    const st = this.joinState();
    let html;
    if (st.go) {
      if (!this.goAt) this.goAt = now + JOIN_DELAY * 1000;
      html = `<span class="go">🎺 Si parte tra ${Math.max(1, Math.ceil((this.goAt - now) / 1000))}…</span>`;
    } else {
      this.goAt = 0;
      if (st.on < 2) html = st.on ? (st.humans ? 'Serve un altro giocatore: premi <b class="kA">A</b>… oppure <b>▲</b> per un bot 🤖' : 'Premi <b class="kA">A</b> per sfidare il bot!') : 'Servono almeno 2 giocatori (o un bot 🤖)';
      else if (!st.humans) html = 'Solo bot al tavolo: premi <b class="kA">A</b> per unirti!';
      else if (!st.games) html = `⚠️ Nessun minigioco per ${st.on} giocatori (ancora!): per ora si gioca in 2`;
      else if (st.teamsBad) html = `⚔️ Squadre: servono 2 Rossi e 2 Blu (ora ${st.split.n[0]} + ${st.split.n[1]})`;
      else html = `Pronti ${st.rdy} su ${st.humans}: tutti premono <b class="kA">A</b>`;
    }
    if (box.dataset.h !== html) { box.innerHTML = html; box.dataset.h = html; box.classList.toggle('going', st.go); }
    const warn = this.root.querySelector('#teamWarn');
    if (warn) {
      const w = !st.teamsBad ? '' : st.on < 4
        ? '⚠️ Le squadre 2 contro 2 vogliono 4 giocatori: premi <b>▲</b> o “+ Bot” per completare il tavolo (oppure spegni ⚔️ Squadre).'
        : `⚠️ Squadre sbilanciate (${st.split.n[0]} Rossi, ${st.split.n[1]} Blu): <b>▼</b> o un clic sullo stendardo cambia squadra.`;
      if (warn.dataset.h !== w) { warn.innerHTML = w; warn.dataset.h = w; warn.classList.toggle('hidden', !w); }
    }
  }

  joinTick(now) {
    this.joinStatus(now);
    if (this.goAt && now >= this.goAt && this.joinState().go) {
      this.goAt = 0;
      const app = this.app;
      app.startLocal({ players: app.joinedPlayers(), only: app.joinOnly, target: app.joinOnly ? 3 : null, teams: !!app.settings.teams && this.teamsPossible() });
    }
  }

  s_keys(p) {
    const app = this.app;
    this.back = () => { app.saveKeys(); this.show('join', { only: app.joinOnly }); };
    const label = { up: 'Su', down: 'Giù', left: 'Sinistra', right: 'Destra', a: 'Tasto A', b: 'Tasto B' };
    const el = this.el(`
      <h2>Tasti: tastiera ${p ? 'destra' : 'sinistra'}</h2>
      <p class="hint">Clicca un'azione e premi il nuovo tasto sulla tastiera. Il controller usa sempre stick/croce, ✕ = A, ○ = B.</p>
      <div class="card list" id="list"></div>
      <h3>🎮 Pulsanti del controller (per tutti i controller)</h3>
      <div class="card list" id="padlist"></div>
      <div class="row">
        <button class="btn ghost" id="reset">↺ Predefiniti</button>
        <button class="btn gold" id="done">Fatto</button>
      </div>
    `);
    const render = (waiting = null) => {
      const k = app.input.keys[p];
      el.querySelector('#list').innerHTML = ACTIONS.map((a) => `
        <button class="btn ${waiting === a ? 'gold' : ''} act" data-a="${a}">
          <span>${label[a]}</span><span>${waiting === a ? 'Premi un tasto…' : esc(k[a].map(keyName).join(' / '))}</span>
        </button>`).join('');
      el.querySelectorAll('.act').forEach((b) => b.addEventListener('click', () => {
        app.click();
        render(b.dataset.a);
        app.input.capture = (code) => {
          if (code !== 'Escape') {
            // A key can only belong to one action of one player.
            for (const set of app.input.keys) for (const a of ACTIONS) set[a] = set[a].filter((c) => c !== code);
            app.input.keys[p][b.dataset.a] = [code];
            for (const set of app.input.keys) for (const a of ACTIONS) if (!set[a].length) set[a] = ['Unidentified'];
          }
          app.saveKeys();
          app.sound('select');
          render();
        };
      }));
    };
    const renderPad = (waiting = null) => {
      const m = app.input.padMap;
      el.querySelector('#padlist').innerHTML = ['a', 'b'].map((a) => `
        <button class="btn ${waiting === a ? 'gold' : ''} pact" data-a="${a}">
          <span>${label[a]}</span><span>${waiting === a ? 'Premi un pulsante sul controller…' : esc(m[a].map((i) => PAD_NAMES[i]).join(' / '))}</span>
        </button>`).join('');
      el.querySelectorAll('.pact').forEach((b) => b.addEventListener('click', () => {
        app.click();
        renderPad(b.dataset.a);
        app.input.padCapture = (btn) => {
          const other = b.dataset.a === 'a' ? 'b' : 'a';
          app.input.padMap[b.dataset.a] = [btn];
          app.input.padMap[other] = app.input.padMap[other].filter((i) => i !== btn);
          if (!app.input.padMap[other].length) app.input.padMap[other] = [btn === 0 ? 1 : 0];
          app.saveKeys();
          app.sound('select');
          renderPad();
        };
      }));
    };
    render();
    renderPad();
    this.bind(el, {
      '#reset': () => { app.input.keys[p] = JSON.parse(JSON.stringify(DEFAULT_KEYS[p])); app.input.padMap = JSON.parse(JSON.stringify(DEFAULT_PAD)); app.saveKeys(); render(); renderPad(); },
      '#done': () => this.back(),
    });
    return el;
  }

  s_practice() {
    const app = this.app;
    this.back = () => this.show('home');
    const el = this.el(`
      <h2>Allenamento</h2>
      <p class="hint">Scegli un minigioco e giocalo quante volte vuoi (stesso schermo).</p>
      <div class="grid">
        ${app.games.map((g) => `
          <button class="btn game-tile" data-id="${esc(g.id)}">
            <span>${esc(g.name)} <small class="np">👥 2${maxPlayersOf(g) > 2 ? '–' + maxPlayersOf(g) : ''}</small></span>
            <span class="rule">${esc(g.rule)}</span>
            <span class="insp">${esc(g.inspired || '')}</span>
          </button>`).join('')}
      </div>
      <button class="btn ghost" id="back">← Indietro</button>
    `, 'screen wide');
    this.bind(el, {
      '.game-tile': (e, b) => {
        // Drop the players that do not fit this game.
        const max = maxPlayersOf(app.gameById(b.dataset.id));
        let seen = 0;
        SLOTS.forEach((s) => { if (app.joined[s].on && ++seen > max) { app.joined[s] = { on: false, rdy: false }; app.ctl[s] = null; } });
        app.joined.forEach((j) => { j.rdy = false; });
        this.show('join', { only: [b.dataset.id] });
      },
      '#back': () => this.back(),
    });
    return el;
  }

  s_netHome() {
    const app = this.app;
    this.back = () => { app.leaveNet(); this.show('home'); };
    const online = location.protocol === 'https:';
    const el = this.el(`
      <h2>Gioca in rete</h2>
      <p class="hint">${online ? '🌍 Sei collegato online: ognuno apre questo stesso link.' : 'Stessa rete Wi-Fi del PC che ha avviato RAFFICA!, oppure online (sotto).'}</p>
      <div class="card list">
        <h3>Giocatori su questo dispositivo</h3>
        <div class="seg" id="nloc">${[1, 2].map((k) => `<button class="btn ${app.netLocal === k ? 'on' : ''}" data-v="${k}">${k === 1 ? '👤 1' : '👥 2 (PC con 2 tastiere/controller)'}</button>`).join('')}</div>
        <h3>${app.netLocal > 1 ? 'I vostri nomi' : 'Il tuo nome'}</h3>
        <input type="text" maxlength="12" id="name" value="${esc(app.names[0])}">
        <input type="text" maxlength="12" id="name2" value="${esc(app.names[1])}" class="${app.netLocal > 1 ? '' : 'hidden'}">
      </div>
      <button class="btn big hot" id="create" data-autofocus>➕ Crea partita</button>
      <div class="card list">
        <h3>Partite aperte</h3>
        <div class="list" id="rooms"><p class="hint">Cerco partite…</p></div>
        <div class="row">
          <input type="text" class="code" id="code" maxlength="4" placeholder="CODICE">
          <button class="btn cyan" id="join">Entra</button>
        </div>
      </div>
      ${online ? '' : `<div class="card online"><b>🌍 Gioca online</b>: avvia <b>GIOCA-ONLINE.bat</b> sul PC e manda il link agli amici (https://….trycloudflare.com). Tutti aprono quel link e uno crea la partita.</div>`}
      <button class="btn ghost" id="tv">📺 Usa questo schermo come TV (spettatore)</button>
      <button class="btn ghost" id="back">← Indietro</button>
    `);
    const nameOf = () => {
      const n2 = el.querySelector('#name2').value.trim();
      if (n2) { app.names[1] = n2.slice(0, 12); app.saveNames(); }
      return el.querySelector('#name').value.trim() || 'Giocatore';
    };
    const refresh = async () => {
      try {
        const list = await app.netRooms();
        const box = el.querySelector('#rooms');
        if (!box) return;
        const open = list.filter((r) => r.free > 0);
        box.innerHTML = open.length ? open.map((r) => `<button class="btn cyan room" data-code="${esc(r.code)}">Entra da ${esc(r.names.filter(Boolean).join(', ') || 'una stanza vuota')} · <b>${esc(r.code)}</b> <small>(${r.free} ${r.free === 1 ? 'posto' : 'posti'})</small></button>`).join('')
          : '<p class="hint">Nessuna partita aperta: creane una!</p>';
        box.querySelectorAll('.room').forEach((b) => b.addEventListener('click', () => { app.click(); app.joinNet(b.dataset.code, nameOf()); }));
      } catch (err) {
        const box = el.querySelector('#rooms');
        if (box) box.innerHTML = `<p class="hint">⚠️ ${esc(err.message)}</p>`;
      }
    };
    refresh();
    this.timer = setInterval(() => { if (this.screen === 'netHome') refresh(); else clearInterval(this.timer); }, 2500);
    this.bind(el, {
      '#nloc .btn': (e, b) => {
        app.netLocal = Number(b.dataset.v);
        el.querySelectorAll('#nloc .btn').forEach((x) => x.classList.toggle('on', x === b));
        el.querySelector('#name2').classList.toggle('hidden', app.netLocal < 2);
      },
      '#create': () => app.createNet(nameOf(), 'player'),
      '#join': () => { const c = el.querySelector('#code').value.trim(); if (c.length === 4) app.joinNet(c, nameOf()); else app.toast('Scrivi il codice di 4 lettere'); },
      '#tv': () => app.createNet('TV', 'tv'),
      '#back': () => this.back(),
    });
    return el;
  }

  s_lobby() {
    const app = this.app;
    const sess = app.session;
    this.back = () => { app.leaveNet(); this.show('netHome'); };
    const el = this.el(`
      <h2>Stanza</h2>
      <div class="code-big" id="code">${esc(sess.code)}</div>
      <div class="card qr">
        <div id="qr"></div>
        <div>
          <p>Inquadra il QR o apri sugli altri dispositivi:</p>
          <p class="url" id="url">…</p>
          <p class="hint left" id="onl"></p>
        </div>
      </div>
      <div class="pcards" id="cards">${SLOTS.map((s) => cardHtml(s, false)).join('')}</div>
      <p class="hint">${sess.local.length ? '◀ ▶ (o le frecce sulla scheda) per cambiare personaggio · 🤖 aggiungi bot qui sotto o con “+ Bot” su un posto libero<br><span id="teamHint" class="hidden">⚔️ Squadre: clicca lo stendardo Rossi/Blu sulla tua scheda o su un bot (da tastiera/controller: <b>▲ ▼</b> fino allo stendardo, poi <b class="kA">A</b>)</span>' : 'Schermo TV: si vedono tutti i giocatori'}</p>
      <p class="team-warn hidden" id="teamWarn"></p>
      <div class="card" id="opts">
        ${sess.local.length ? `<h3>Bot 🤖 <small class="sub">(giocatori computer: chiunque nella stanza può aggiungerli)</small></h3>
        <div class="seg" id="addbots">
          ${BOT_LEVELS.map((l) => `<button class="btn" data-lv="${l.id}">${l.icon} + ${esc(l.name)}</button>`).join('')}
          <button class="btn ghost" id="unbot" disabled>✖ Togli bot</button>
        </div>` : ''}
        <h3>Punti per vincere</h3>
        <div class="seg" id="target">
          ${[3, 5, 7, 10].map((t) => `<button class="btn ${app.settings.target === t ? 'on' : ''}" data-v="${t}">${t}</button>`).join('')}
        </div>
        ${sess.local.length ? `<div class="toggle"><span>⚔️ Squadre 2 contro 2 <small class="sub">(4 giocatori: 2 Rossi contro 2 Blu, la squadra vince insieme)</small></span><button class="btn ${app.settings.teams ? 'on' : ''}" id="teams">${app.settings.teams ? 'SÌ' : 'NO'}</button></div>` : ''}
        ${sess.role === 'player' && app.isTouch && sess.local.length === 1 ? `<div class="toggle"><span>📺 C'è una TV? Usa questo telefono solo come joypad</span><button class="btn ${app.padView ? 'on' : ''}" id="pad">${app.padView ? 'SÌ' : 'NO'}</button></div>` : ''}
      </div>
      <button class="btn big gold" id="start" disabled>In attesa di altri giocatori…</button>
      <button class="btn ghost" id="back">← Esci dalla stanza</button>
    `, 'screen wider');
    app.joinUrl(sess.code).then(({ url, online }) => {
      const u = el.querySelector('#url');
      if (u) u.textContent = url;
      const q = el.querySelector('#qr');
      if (q) q.innerHTML = qrImg(url);
      const o = el.querySelector('#onl');
      if (o) o.textContent = online ? '🌍 Link online: mandalo agli amici, funziona da qualunque rete.' : '🌍 Gioca online: avvia GIOCA-ONLINE.bat e manda il link agli amici.';
    });
    el.classList.toggle('nobots', !sess.local.length);
    el.querySelectorAll('.pcard').forEach((card) => {
      const s = Number(card.dataset.slot);
      const isBot = () => card.classList.contains('botc');
      card.querySelectorAll('.pc-arrow').forEach((b) => b.addEventListener('click', (e) => {
        e.stopPropagation(); b.blur();
        if (isBot()) app.netBotChar(s, Number(b.dataset.d)); else app.setNetChar(s, Number(b.dataset.d));
        this.cheer(s, 1.1);
      }));
      card.querySelectorAll('.pc-lv').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); b.blur(); app.netBotLevel(s, Number(b.dataset.d)); this.cheer(s, 1.1); }));
      card.querySelector('.pc-bot').addEventListener('click', (e) => { e.stopPropagation(); e.currentTarget.blur(); app.netAddBot(); });
      card.querySelector('.pc-unbot').addEventListener('click', (e) => { e.stopPropagation(); e.currentTarget.blur(); app.netRemoveBot(s); });
      card.querySelector('.pc-team').addEventListener('click', (e) => {
        e.stopPropagation();
        const pl = app.session?.sample?.()?.latest?.pl?.[s];
        if (!app.settings.teams || !pl?.on) return;
        app.setNetTeam(s, pl.tm === 1 ? 0 : 1);
        this.cheer(s, 1.1);
      });
    });
    this.bind(el, {
      '#target .btn': (e, b) => {
        app.settings.target = Number(b.dataset.v);
        el.querySelectorAll('#target .btn').forEach((x) => x.classList.toggle('on', x === b));
        app.saveSettings();
        app.pushSettings();
      },
      '#addbots .btn[data-lv]': (e, b) => { app.rememberLevel(b.dataset.lv); app.netAddBot(b.dataset.lv); },
      '#unbot': () => {
        const pl = app.session?.sample?.()?.latest?.pl || [];
        const last = [...SLOTS].reverse().find((q) => pl[q]?.bot);
        if (last !== undefined) app.netRemoveBot(last);
      },
      '#teams': (e, b) => {
        app.settings.teams = !app.settings.teams;
        b.textContent = app.settings.teams ? 'SÌ' : 'NO';
        b.classList.toggle('on', app.settings.teams);
        app.pushTeams();
      },
      '#pad': (e, b) => { app.padView = !app.padView; b.textContent = app.padView ? 'SÌ' : 'NO'; b.classList.toggle('on', app.padView); },
      '#start': () => { app.pushSettings(); app.session.cmd(app.session.me ?? 0, { type: 'start' }); },
      '#back': () => this.back(),
    });
    return el;
  }

  // Lobby: left/right of a local device changes that player's character.
  lobbyInput(ev) {
    const app = this.app;
    const s = app.session;
    const lr = ev.act === 'left' || ev.act === 'right' || ev.dir === 'left' || ev.dir === 'right';
    if (ev.type === 'nav') return lr; // left/right never move the menu focus here
    if (ev.type !== 'dir' || !lr || !s?.local.length || this.typing()) return false;
    let slot;
    if (s.local.length === 1) slot = s.local[0];
    else if (ev.src === 'kb') slot = s.local[ev.idx];
    else slot = s.local.find((sl) => app.ctl[sl]?.pads.includes(ev.idx));
    if (slot === undefined) return true;
    app.setNetChar(slot, ev.dir === 'left' ? -1 : 1);
    this.cheer(slot, 1.1);
    return true;
  }

  updateLobby(snap) {
    if (this.screen !== 'lobby' || !snap) return;
    const app = this.app;
    const local = app.session?.local || [];
    // The room has the teams on when the Host says so (s.tm: 4 players 2 + 2): keep the toggle in sync.
    if (snap.tm && !app.settings.teams) {
      app.settings.teams = true;
      const tb = this.root.querySelector('#teams');
      if (tb) { tb.textContent = 'SÌ'; tb.classList.add('on'); }
    }
    const teams = !!app.settings.teams || !!snap.tm;
    const onSlots = SLOTS.filter((q) => snap.pl?.[q]?.on);
    const cmap = colorMap(snap.pl, onSlots, teams);
    this.root.querySelector('#teamHint')?.classList.toggle('hidden', !teams);
    for (const card of this.root.querySelectorAll('.pcard')) {
      const s = Number(card.dataset.slot);
      const pl = snap.pl?.[s];
      const on = !!pl?.on;
      const ch = CHAR_BY_ID[pl?.c] || CHARACTERS[0];
      const bot = on && pl.bot ? pl.bot : null;
      setTeamLook(card, s, teams && on ? (pl.tm === 1 ? 1 : 0) : null, cmap[s], on && local.length > 0 && (local.includes(s) || !!bot), true);
      const key = `${on}|${pl?.n}|${pl?.c}|${local.includes(s)}|${bot}|${pl?.tm}|${teams}`;
      if (card.dataset.k === key) continue;
      card.dataset.k = key;
      card.classList.toggle('empty', !on);
      card.classList.toggle('mine', on && local.includes(s));
      card.classList.toggle('botc', !!bot);
      card.dataset.char = on ? ch.id : '';
      setLevel(card, bot);
      card.querySelector('.pc-emoji').textContent = on ? ch.icon : '?';
      card.querySelector('.pc-char').textContent = on ? ch.name : '';
      card.querySelector('.pc-name').textContent = on ? pl.n : 'In attesa…';
      card.querySelector('.pc-msg').textContent = on ? (bot ? '🤖 Sempre pronto' : local.includes(s) ? (local.length > 1 ? `Tu (${local.indexOf(s) ? 'tastiera destra' : 'tastiera sinistra'})` : 'Tu') : '') : 'Posto libero';
    }
    const unbot = this.root.querySelector('#unbot');
    if (unbot) unbot.disabled = !SLOTS.some((s) => snap.pl?.[s]?.on && snap.pl[s].bot);
    const n = SLOTS.filter((s) => snap.pl?.[s]?.on).length;
    const games = app.gamesFor(Math.max(2, n)).length;
    const split = teamSplit(snap.pl || []);
    const teamsBad = teams && !split.ok;
    const ok = n >= 2 && games > 0 && !teamsBad;
    const start = $('#start', this.root);
    const label = ok ? (snap.tm ? '⚔️ INIZIA: ROSSI CONTRO BLU!' : `INIZIA LA RAFFICA! (${n} giocatori)`) : n < 2 ? 'In attesa di altri giocatori…'
      : teamsBad ? `⚔️ Squadre: servono 2 Rossi e 2 Blu (ora ${split.n[0]} + ${split.n[1]})` : `Nessun minigioco per ${n} giocatori (ancora!)`;
    const warn = this.root.querySelector('#teamWarn');
    if (warn) {
      const w = !teamsBad ? '' : n < 4 ? '⚠️ Le squadre 2 contro 2 vogliono 4 giocatori: aggiungi bot o aspetta gli amici (oppure metti Squadre su NO).'
        : `⚠️ Squadre sbilanciate (${split.n[0]} Rossi, ${split.n[1]} Blu): clicca uno stendardo per cambiare squadra.`;
      if (warn.dataset.h !== w) { warn.textContent = w; warn.dataset.h = w; warn.classList.toggle('hidden', !w); }
    }
    if (start && (start.textContent !== label || !!start.disabled === ok)) {
      start.disabled = !ok || !local.length;
      start.textContent = label;
    }
  }

  s_settings() {
    const app = this.app;
    const a = app.audioSettings;
    this.back = () => this.show('home');
    const el = this.el(`
      <h2>Impostazioni</h2>
      <div class="card list">
        <h3>Effetti sonori</h3>
        <div class="seg" id="sfx">${[0, 0.4, 0.8, 1].map((v) => `<button class="btn ${a.sfx === v ? 'on' : ''}" data-v="${v}">${v === 0 ? 'Off' : Math.round(v * 100) + '%'}</button>`).join('')}</div>
        <h3>Musica</h3>
        <div class="seg" id="music">${[0, 0.25, 0.45, 0.7].map((v) => `<button class="btn ${a.music === v ? 'on' : ''}" data-v="${v}">${v === 0 ? 'Off' : Math.round(v * 100) + '%'}</button>`).join('')}</div>
        <div class="seg">
          <button class="btn ${a.voice ? 'on' : ''}" id="voice">🗣️ Annunciatore</button>
          <button class="btn ${app.settings.shake !== false ? 'on' : ''}" id="shake">📳 Scossoni</button>
          <button class="btn ${app.settings.gfx3d !== false ? 'on' : ''}" id="gfx3d">🧊 Grafica 3D</button>
        </div>
      </div>
      <button class="btn ghost" id="back">← Indietro</button>
    `);
    this.bind(el, {
      '#sfx .btn': (e, b) => { a.sfx = Number(b.dataset.v); el.querySelectorAll('#sfx .btn').forEach((x) => x.classList.toggle('on', x === b)); app.applyAudio(); app.sound('coin'); },
      '#music .btn': (e, b) => { a.music = Number(b.dataset.v); el.querySelectorAll('#music .btn').forEach((x) => x.classList.toggle('on', x === b)); app.applyAudio(); },
      '#voice': (e, b) => { a.voice = !a.voice; b.classList.toggle('on', a.voice); app.applyAudio(); if (a.voice) app.speak('Ciao! Sono l\'annunciatore di Raffica!'); },
      '#gfx3d': (e, b) => { app.settings.gfx3d = app.settings.gfx3d === false; b.classList.toggle('on', app.settings.gfx3d !== false); app.saveSettings(); },
      '#shake': (e, b) => { app.settings.shake = app.settings.shake === false; b.classList.toggle('on', app.settings.shake !== false); app.saveSettings(); },
      '#back': () => this.back(),
    });
    return el;
  }

  s_howto() {
    this.back = () => this.show('home');
    const el = this.el(`
      <h2>Come si gioca</h2>
      <div class="card list">
        <p>⚔️ <b>RAFFICA!</b> è un torneo di corte da 2 a 4 giocatori a colpi di minigiochi: ogni round un gioco a sorpresa, spesso con una <b>regola pazza</b>. Chi è ultimo in classifica sceglie il prossimo gioco. Vince chi arriva per primo ai punti stabiliti.</p>
        <p>Su <i>Unisciti!</i> ognuno preme <b>A</b> per entrare, sceglie il personaggio con ◀ ▶ e preme <b>A</b> quando è pronto. Prima di ogni round c'è una scheda con la regola: premete <b>A</b> quando avete letto.</p>
        <p>⚔️ <b>Squadre 2 contro 2</b>: accendi <i>Squadre</i> su <i>Unisciti!</i> (o nella stanza in rete), oppure usa <i>👥 2 contro 2</i> nel menu (tu e un amico contro 2 bot). Servono 4 giocatori, 2 Rossi e 2 Blu: lo stendardo sulla scheda dice la squadra, <b>▼</b> (o un clic sullo stendardo) la cambia. Se vince uno, il punto va a tutta la squadra!</p>
        <p>🤖 <b>Da soli o in pochi?</b> Aggiungete dei bot: <i>Gioca da solo</i> nel menu, oppure <b>▲</b> / “+ Bot” su <i>Unisciti!</i> (<b>▼</b> toglie l'ultimo). Tre livelli: 🪵 Scudiero, ⚔️ Cavaliere, 👑 Re. I bot sono sempre pronti.</p>
      </div>
      <div class="card">
        <h3>Comandi</h3>
        <div class="keys">
          <span>📱 Telefono</span><span>joystick a sinistra, tasti <b>A</b> e <b>B</b> a destra (dal tuo lato)</span>
          <span>⌨️ Tastiera sinistra</span><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> muovi · <kbd>F</kbd> = A · <kbd>G</kbd> = B</span>
          <span>⌨️ Tastiera destra</span><span><kbd>↑</kbd><kbd>←</kbd><kbd>↓</kbd><kbd>→</kbd> muovi · <kbd>K</kbd> = A · <kbd>L</kbd> = B</span>
          <span>🎮 Controller</span><span>stick sinistro · <kbd>✕</kbd> = A · <kbd>○</kbd> = B · <kbd>Options</kbd> pausa</span>
          <span>⏸️ Pausa</span><span><kbd>Esc</kbd> o il tasto in alto</span>
        </div>
      </div>
      <div class="card list">
        <h3>In rete e online</h3>
        <p>Avvia RAFFICA! sul PC con <b>AVVIA.bat</b>. Sul primo dispositivo: <i>Gioca in rete → Crea partita</i>. Sugli altri: inquadra il QR oppure <i>Gioca in rete → Entra</i>. Un PC può portare 2 giocatori (2 tastiere o controller). Il PC può fare da TV: <i>Usa questo schermo come TV</i>.</p>
        <p>🌍 Per giocare con amici lontani avvia <b>GIOCA-ONLINE.bat</b> e manda loro il link che compare.</p>
      </div>
      <button class="btn ghost" id="back">← Indietro</button>
    `);
    this.bind(el, { '#back': () => this.back() });
    return el;
  }
}

// A player card (slot = team color). join = local "Unisciti!" card with buttons, else a lobby card.
function cardHtml(s, join) {
  const c = PLAYER_COLORS[s];
  return `
    <div class="pcard empty ${join ? 'jc' : 'lc'}" data-slot="${s}" style="--pc:${c.main};--pcl:${c.light};--pcd:${c.dark}">
      <button class="pc-team" tabindex="-1" data-slot="${s}">${esc(c.name)}</button>
      <div class="pc-stage">
        <div class="pc-emoji">?</div>
        <canvas class="pc-cv"></canvas>
        <button class="pc-arrow" data-d="-1" tabindex="-1" aria-label="Personaggio precedente">◀</button>
        <button class="pc-arrow r" data-d="1" tabindex="-1" aria-label="Personaggio successivo">▶</button>
        <div class="pc-botmark" title="Giocatore computer">🤖</div>
      </div>
      <div class="pc-char"></div>
      ${join ? '<input type="text" class="pc-name" maxlength="12">' : '<div class="pc-name"></div>'}
      <div class="pc-level">
        <button class="pc-lv" data-d="-1" tabindex="-1" aria-label="Livello precedente">◀</button>
        <span class="pc-lvname"></span>
        <button class="pc-lv" data-d="1" tabindex="-1" aria-label="Livello successivo">▶</button>
      </div>
      <div class="pc-dev"></div>
      <div class="pc-msg"></div>
      ${join ? `<div class="pc-act">
        <button class="pc-btn pc-join" tabindex="-1">＋ Unisciti</button>
        <button class="pc-btn pc-bot" tabindex="-1">＋ 🤖 Bot</button>
        <button class="pc-btn pc-ready" tabindex="-1">Pronto!</button>
        <button class="pc-btn pc-leave" tabindex="-1">Esci</button>
        <button class="pc-btn pc-unbot" tabindex="-1">✖ Togli</button>
      </div>` : `<div class="pc-act">
        <button class="pc-btn pc-bot" tabindex="-1">＋ 🤖 Bot</button>
        <button class="pc-btn pc-unbot" tabindex="-1">✖ Togli</button>
      </div>`}
    </div>`;
}

// Team look of a card. team = 0|1 (2 vs 2 on) or null; ci = PLAYER_COLORS index of the place (team colors);
// can = the banner is a button that switches team (lobby: reachable with the arrows, data-nav).
function setTeamLook(card, s, team, ci, can, nav = false) {
  const c = PLAYER_COLORS[ci] || PLAYER_COLORS[s];
  const key = `${team}|${ci}|${can}|${nav}`;
  if (card.dataset.tk === key) return;
  card.dataset.tk = key;
  card.style.setProperty('--pc', c.main);
  card.style.setProperty('--pcl', c.light);
  card.style.setProperty('--pcd', c.dark);
  const T = team === null ? null : TEAMS[team];
  card.style.setProperty('--tc', T ? T.main : c.main);
  card.style.setProperty('--tcl', T ? T.light : c.light);
  card.style.setProperty('--tcd', T ? T.dark : c.dark);
  card.classList.toggle('teamc', !!T);
  const b = card.querySelector('.pc-team');
  b.classList.toggle('tchg', !!(T && can));
  b.innerHTML = T ? `${can ? '<i>◀</i>' : ''}${team ? '🔷' : '🔶'} ${esc(T.plural.toUpperCase())}${can ? '<i>▶</i>' : ''}` : esc(PLAYER_COLORS[s].name);
  b.title = T && can ? 'Cambia squadra' : '';
  if (T && can && nav) b.setAttribute('data-nav', ''); else b.removeAttribute('data-nav');
  b.disabled = !(T && can);
}

// Bot level shown on a card (level id, or null for a human / empty place).
function setLevel(card, level) {
  const L = BOT_LEVELS.find((l) => l.id === level);
  card.dataset.lv = L ? L.id : '';
  const el = card.querySelector('.pc-lvname');
  const txt = L ? `${L.icon} ${L.name}` : '';
  if (el && el.textContent !== txt) el.textContent = txt;
}

// Character previews: ONE small WebGL renderer draws every card in turn (Idle, Cheer when ready), slowly
// spinning; each frame is copied into the card's own 2D canvas. Without WebGL the cards show the icon.
class CharPreview {
  constructor() {
    this.items = new Map(); // card key -> { char, root, ch, action, anim, failed, rot }
    this.ok = false;
    this.dead = false;
    try {
      this.cv = document.createElement('canvas');
      const R = new THREE.WebGLRenderer({ canvas: this.cv, antialias: true, alpha: true });
      R.outputColorSpace = THREE.SRGBColorSpace;
      R.toneMapping = THREE.ACESFilmicToneMapping;
      R.setClearColor(0x000000, 0);
      this.R = R;
      const scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight('#fff3e6', '#3b2a55', 1.7));
      const sun = new THREE.DirectionalLight('#ffffff', 2.3);
      sun.position.set(2, 4, 3.5);
      scene.add(sun);
      const rim = new THREE.DirectionalLight('#b48cff', 1.4);
      rim.position.set(-3, 2.5, -2.5);
      scene.add(rim);
      this.scene = scene;
      this.cam = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
      this.ok = true;
    } catch (err) {
      console.warn('[preview] WebGL non disponibile: mostro le icone', err);
    }
  }

  item(key, char) {
    let it = this.items.get(key);
    if (it && it.char === char) return it;
    if (it?.root) this.scene.remove(it.root);
    it = { char, root: null, ch: null, action: null, anim: null, failed: false, rot: it?.rot ?? 0.5 };
    this.items.set(key, it);
    preload(charAssets(char)).then(() => {
      if (this.dead || this.items.get(key) !== it) return;
      const ch = makeCharacter(char);
      if (!ch) { it.failed = true; return; }
      const h = ch.info?.size?.y || 2;
      const s = 1.7 / h;
      ch.model.scale.setScalar(s);
      ch.model.position.y = -(ch.info?.min?.y || 0) * s;
      it.root = new THREE.Group();
      it.root.add(ch.model);
      it.root.visible = false;
      this.scene.add(it.root);
      it.ch = ch;
    });
    return it;
  }

  // True when the 3D model of that card is on screen (otherwise the card shows the icon).
  shows(key, char) {
    const it = this.items.get(key);
    return this.ok && !!it?.ch && it.char === char;
  }

  play(it, name) {
    if (it.anim === name) return;
    const clip = it.ch.clips.get(name) || it.ch.clips.get('Idle');
    if (!clip) return;
    const a = it.ch.mixer.clipAction(clip);
    a.reset().fadeIn(0.25).play();
    if (it.action && it.action !== a) it.action.fadeOut(0.25);
    it.action = a;
    it.anim = name;
  }

  draw(list, dt) {
    if (!this.ok || this.dead) return;
    const keys = new Set(list.map((l) => l.key));
    for (const [k, it] of this.items) if (!keys.has(k)) { if (it.root) this.scene.remove(it.root); this.items.delete(k); }
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    // Round-robin: at most 2 cards re-rendered per frame (cheap on phones and software WebGL);
    // every card accumulates its own animation time.
    for (const L of list) { const it = this.item(L.key, L.char); it.acc = (it.acc || 0) + dt; }
    const per = Math.min(list.length, 2);
    this.rr = (this.rr || 0) % Math.max(1, list.length);
    const todo = list.slice(this.rr, this.rr + per).concat(list.slice(0, Math.max(0, this.rr + per - list.length)));
    this.rr += per;
    for (const L of todo) {
      const it = this.item(L.key, L.char);
      if (!it.ch || !L.canvas) continue;
      const dtk = Math.min(0.25, it.acc);
      it.acc = 0;
      const cw = L.canvas.clientWidth, chh = L.canvas.clientHeight;
      if (!cw || !chh) continue;
      const pw = Math.round(cw * dpr), ph = Math.round(chh * dpr);
      if (L.canvas.width !== pw || L.canvas.height !== ph) { L.canvas.width = pw; L.canvas.height = ph; }
      this.play(it, L.cheer ? 'Cheer' : 'Idle');
      it.ch.mixer.update(dtk);
      it.rot += dtk * 0.7;
      it.root.rotation.y = it.rot;
      for (const o of this.items.values()) if (o.root) o.root.visible = o === it;
      if (this.cv.width !== pw || this.cv.height !== ph) this.R.setSize(pw, ph, false);
      this.cam.aspect = pw / ph;
      this.cam.position.set(0, 1.15, 4.3);
      this.cam.lookAt(0, 0.84, 0);
      this.cam.updateProjectionMatrix();
      this.R.render(this.scene, this.cam);
      const ctx = L.canvas.getContext('2d');
      ctx.clearRect(0, 0, pw, ph);
      ctx.drawImage(this.cv, 0, 0, pw, ph);
    }
  }

  dispose() {
    this.dead = true;
    this.items.clear();
    try { this.R?.dispose(); this.R?.forceContextLoss?.(); } catch { /* already gone */ }
    this.R = null;
  }
}

function qrImg(text) {
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createImgTag(5, 4);
  } catch {
    return '';
  }
}

