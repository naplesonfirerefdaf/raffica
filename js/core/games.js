// Registry of all mini-games. Each id maps to public/js/games/<id>.js.
// Missing or broken files are skipped (with a warning) so one bad game never breaks the party.
export const GAME_IDS = [
  'sumo', 'fuoco', 'vigile', 'moka', 'spaghetto', 'mattarello', 'pavimento',
  'mollala', 'fotobomba', 'tron', 'bombe', 'hockey', 'calcetto',
  'palloncini', 'carri', 'budini', 'lasagna', 'torre', 'smash',
];

const REQUIRED = ['id', 'name', 'rule', 'cam', 'world', 'controls', 'duration', 'init', 'step', 'view', 'render'];

export function validateGame(def) {
  const missing = REQUIRED.filter((k) => def[k] === undefined);
  if (missing.length) return `campi mancanti: ${missing.join(', ')}`;
  if (typeof def.init !== 'function' || typeof def.step !== 'function' || typeof def.render !== 'function') return 'init/step/render devono essere funzioni';
  if (typeof def.view !== 'function') return 'view deve essere una funzione';
  return null;
}

export async function loadGames(ids = GAME_IDS) {
  const results = await Promise.allSettled(ids.map((id) => import(`../games/${id}.js`)));
  const games = [];
  results.forEach((res, k) => {
    if (res.status !== 'fulfilled') {
      if (!String(res.reason?.message || res.reason).match(/Cannot find module|Failed to fetch|404|ERR_MODULE_NOT_FOUND/)) {
        console.warn(`[giochi] ${ids[k]} non caricato:`, res.reason);
      }
      return;
    }
    const def = res.value.default;
    const err = def ? validateGame(def) : 'nessun export default';
    if (err) { console.warn(`[giochi] ${ids[k]} scartato: ${err}`); return; }
    games.push(def);
  });
  return games;
}

export const GAMES = await loadGames();
