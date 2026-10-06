// Arena Logbuch – automatische Eintragung
// Holt neue Arena-Runden des Kaders über die Riot-Schnittstelle und trägt sie
// in das gemeinsame Logbuch (Firestore) ein. Läuft ohne Zusatzpakete auf Node 20+.
//
// Aufruf:  RIOT_API_KEY=... node sync/arena-sync.mjs
//          node sync/arena-sync.mjs --probe     (liest nur, schreibt nichts)

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ARENA_QUEUES = [1700, 1710];          // Arena, Arena mit 16 Spielern
const RANDOM_ID = '__random';
const LOOKBACK_MS = 3 * 24 * 3600e3;
const SEEN_MAX = 600;

class StopError extends Error {
  constructor(msg) { super(msg); this.stop = true; }
}

/* ---------- Firestore-Werte ---------- */
export function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  return { mapValue: { fields: toFields(v) } };
}
export function toFields(o) {
  const f = {};
  for (const k of Object.keys(o)) if (o[k] !== undefined) f[k] = toValue(o[k]);
  return f;
}
export function fromValue(v) {
  if (!v) return null;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  if ('mapValue' in v) return fromFields(v.mapValue.fields || {});
  return null;
}
export function fromFields(f) {
  const o = {};
  for (const k of Object.keys(f || {})) o[k] = fromValue(f[k]);
  return o;
}

/* ---------- Auswertung einer Runde ---------- */
export function buildRecord(match, ctx) {
  const info = match && match.info;
  if (!info || !Array.isArray(info.participants)) return { skip: 'ohne Daten' };
  if (info.gameMode !== 'CHERRY' && !ARENA_QUEUES.includes(info.queueId)) return { skip: 'kein Arena-Spiel' };
  const subs = new Map();
  for (const p of info.participants) {
    const k = p.playerSubteamId;
    if (k === undefined || k === null || k === 0) continue;
    if (!subs.has(k)) subs.set(k, []);
    subs.get(k).push(p);
  }
  if (!subs.size) return { skip: 'ohne Team-Zuordnung' };

  const riotName = p => (p.riotIdGameName ? p.riotIdGameName + '#' + (p.riotIdTagline || '') : (p.summonerName || 'Unbekannt'));
  const person = p => ctx.byPuuid.get(p.puuid) || ctx.aliases.get(riotName(p).trim().toLowerCase()) || null;

  const own = [...subs.values()].filter(members => members.some(p => ctx.byPuuid.has(p.puuid)));
  if (!own.length) return { skip: 'kein Kaderspieler im Spiel' };

  // Team im Logbuch: dort, wo die meisten erkannten Spieler im Kader stehen
  const names = new Set();
  own.forEach(members => members.forEach(p => { const n = person(p); if (n) names.add(n.toLowerCase()); }));
  let team = null, best = -1;
  for (const t of ctx.teams) {
    const have = new Set((t.players || []).map(x => String(x.name || '').trim().toLowerCase()));
    let hits = 0; names.forEach(n => { if (have.has(n)) hits++; });
    const pref = String(t.name || '').trim().toLowerCase() === ctx.standardTeam ? 0.5 : 0;
    if (hits + pref > best) { best = hits + pref; team = t; }
  }
  if (!team) return { skip: 'kein Team im Logbuch' };
  const idByName = new Map((team.players || []).map(x => [String(x.name || '').trim().toLowerCase(), x.id]));

  const groups = own.map(members => {
    const place = Number(members[0].subteamPlacement || members[0].placement) || null;
    const used = new Set();
    const picks = members.map(p => {
      const n = person(p);
      let pid = n ? idByName.get(n.toLowerCase()) : null;
      if (pid && used.has(pid)) pid = null;
      if (pid) used.add(pid);
      const pick = { p: pid || RANDOM_ID, c: ctx.champId(p.championName), m: 'regular', g: false };
      if (!pid) pick.rn = riotName(p);
      return pick;
    });
    return { place: place >= 1 && place <= 8 ? place : null, u: false, picks };
  }).sort((a, b) => (a.place || 9) - (b.place || 9));

  const size = Math.max(...groups.map(g => g.picks.length));
  const ts = info.gameEndTimestamp || ((info.gameCreation || 0) + (info.gameDuration || 0) * 1000) || Date.now();
  return {
    record: { teamId: team.id, ts, mode: size >= 3 ? '3v3' : '2v2', groups, src: 'riot', rid: match.metadata && match.metadata.matchId || '' },
    team: team.name
  };
}

/* ---------- Ablauf ---------- */
export async function run({ fetchImpl = fetch, env = process.env, now = Date.now(), root, probe = false, log = console.log } = {}) {
  root = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const cfg = JSON.parse(await readFile(path.join(root, 'sync', 'spieler.json'), 'utf8'));
  const fbText = await readFile(path.join(root, 'firebase-config.js'), 'utf8');
  const pick = re => { const m = fbText.match(re); return m ? m[1] : ''; };
  const projectId = pick(/projectId:\s*"([^"]+)"/), apiKey = pick(/apiKey:\s*"([^"]+)"/), code = pick(/ARENA_TEAM_CODE\s*=\s*"([^"]+)"/);
  if (!projectId || !apiKey || !code) throw new Error('firebase-config.js ist unvollständig.');
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const champs = new Map([...html.matchAll(/\["([A-Za-z]+)","[^"]+","data:image/g)].map(m => [m[1].toLowerCase(), m[1]]));
  const champId = n => champs.get(String(n || '').toLowerCase()) || String(n || '').replace(/[^A-Za-z]/g, '') || 'Unbekannt';

  const docs = 'https://firestore.googleapis.com/v1/projects/' + projectId + '/databases/(default)/documents/logs/' + code;
  const fs = async (method, p, body) => {
    const res = await fetchImpl(docs + p + (p.includes('?') ? '&' : '?') + 'key=' + apiKey,
      { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) {}
    return { status: res.status, json };
  };
  const getDoc = async p => { const r = await fs('GET', p); if (r.status === 404) return null; if (r.status !== 200) throw new Error('Logbuch nicht lesbar (' + r.status + ') bei ' + p); return fromFields(r.json.fields || {}); };
  const setDoc = async (p, data) => { if (probe) return; const r = await fs('PATCH', p, { fields: toFields(data) }); if (r.status !== 200) throw new Error('Logbuch nicht beschreibbar (' + r.status + ') bei ' + p); };
  const status = async (ok, msg, added) => { try { await setDoc('/sync/status', { last: now, ok, msg, added: added || 0 }); } catch (e) { log('Status nicht gespeichert: ' + e.message); } };

  const key = (env.RIOT_API_KEY || '').trim();
  if (!key) { await status(false, 'Riot-Schlüssel fehlt'); throw new StopError('Das GitHub-Secret RIOT_API_KEY ist leer.'); }

  const host = 'https://' + (cfg.region || 'europe') + '.api.riotgames.com';
  const riot = async p => {
    for (let n = 0; n < 2; n++) {
      const res = await fetchImpl(host + p, { headers: { 'X-Riot-Token': key } });
      if (res.status === 429 && n === 0) {
        const wait = Math.min(Number(res.headers.get('retry-after')) || 5, 30);
        log('Riot bremst, warte ' + wait + ' s');
        await new Promise(r => setTimeout(r, env.ARENA_TEST ? 0 : wait * 1000));
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        // Form des Schlüssels prüfen, ohne ihn preiszugeben
        const form = /^RGAPI-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);
        // Riots eigene Begründung und eine Kennung des Schlüssels (Prüfsumme, lässt keinen Rückschluss zu),
        // damit sich erkennen lässt, ob ein neu eingetragener Schlüssel auch angekommen ist
        let grund = ''; try { grund = (await res.text()).replace(/\s+/g, ' ').slice(0, 140); } catch (e) {}
        let kenn = ''; try { const { createHash } = await import('node:crypto'); kenn = createHash('sha256').update(key).digest('hex').slice(0, 6); } catch (e) {}
        log('::notice::Riot-Antwort ' + res.status + ': ' + grund + ' | Schlüssel-Kennung ' + kenn);
        log('Riot lehnt ab (' + res.status + '). Schlüssel: ' + key.length + ' Zeichen, beginnt mit RGAPI-: ' + (key.startsWith('RGAPI-') ? 'ja' : 'nein') + ', Form stimmt: ' + (form ? 'ja' : 'nein'));
        throw new StopError(form
          ? 'Riot-Schlüssel abgelaufen oder ungültig (Riot meldet ' + res.status + ', Form des Schlüssels stimmt)'
          : 'Riot-Schlüssel hat nicht die erwartete Form RGAPI-… (' + key.length + ' Zeichen statt 42)');
      }
      if (res.status === 404) return null;
      if (res.status !== 200) throw new Error('Riot antwortet mit ' + res.status + ' bei ' + p.split('?')[0]);
      return await res.json();
    }
    throw new Error('Riot bremst weiter (429).');
  };

  try {
    // Kader auflösen
    const byPuuid = new Map();
    for (const s of cfg.spieler || []) {
      const [game, tag] = String(s.riotId || '').split('#');
      if (!game || !tag) throw new StopError('Riot-ID von ' + s.name + ' fehlt oder hat keinen #Tag');
      const acc = await riot('/riot/account/v1/accounts/by-riot-id/' + encodeURIComponent(game.trim()) + '/' + encodeURIComponent(tag.trim()));
      if (!acc || !acc.puuid) throw new StopError('Riot-ID ' + s.riotId + ' nicht gefunden');
      byPuuid.set(acc.puuid, s.name);
    }
    if (!byPuuid.size) throw new StopError('In sync/spieler.json steht kein Spieler');

    // Logbuch lesen
    const tl = await fs('GET', '/teams?pageSize=100');
    if (tl.status !== 200) throw new Error('Teams nicht lesbar (' + tl.status + ')');
    const teams = ((tl.json && tl.json.documents) || []).map(d => Object.assign({ id: d.name.split('/').pop() }, fromFields(d.fields || {})));
    if (!teams.length) throw new StopError('Im Logbuch gibt es noch kein Team');
    const conf = (await getDoc('/sync/config')) || {};
    const aliases = new Map(Object.entries(conf.aliases || {}).map(([k, v]) => [String(k).trim().toLowerCase(), String(v)]));
    let state = await getDoc('/sync/state');
    if (!state || !state.start) {
      const from = cfg.abDatum ? Date.parse(cfg.abDatum) : NaN;
      state = { start: Number.isFinite(from) ? from : now, seen: [] };
      await setDoc('/sync/state', state);
      if (!Number.isFinite(from)) {
        await status(true, 'eingerichtet', 0);
        log('Erster Lauf: eingerichtet. Ab jetzt werden neue Arena-Runden eingetragen.');
        return { added: 0, firstRun: true };
      }
    }
    const seen = new Set(state.seen || []);

    // Neue Spiele suchen
    const since = Math.floor(Math.max(state.start, now - LOOKBACK_MS) / 1000);
    const ids = new Set();
    for (const puuid of byPuuid.keys()) {
      for (const q of ARENA_QUEUES) {
        const list = await riot('/lol/match/v5/matches/by-puuid/' + puuid + '/ids?queue=' + q + '&startTime=' + since + '&count=20');
        (list || []).forEach(id => { if (!seen.has(id)) ids.add(id); });
      }
    }
    const ctx = { byPuuid, aliases, teams, champId, standardTeam: String(cfg.standardTeam || '').trim().toLowerCase() };
    const found = [];
    for (const id of ids) {
      const m = await riot('/lol/match/v5/matches/' + id);
      if (!m) continue;                         // noch nicht abrufbar, nächster Lauf
      const end = (m.info && (m.info.gameEndTimestamp || m.info.gameCreation)) || 0;
      if (end && end < state.start) { seen.add(id); continue; }
      const r = buildRecord(m, ctx);
      if (r.skip) { log(id + ': übersprungen, ' + r.skip); seen.add(id); continue; }
      found.push({ id, r });
    }
    found.sort((a, b) => a.r.record.ts - b.r.record.ts);

    let added = 0;
    for (const { id, r } of found) {
      const g = r.record.groups.map(x => 'Platz ' + x.place + ': ' + x.picks.map(pk => pk.c + (pk.rn ? ' (' + pk.rn + ')' : '')).join(', ')).join(' | ');
      if (probe) { log('[Probe] ' + id + ' → ' + r.team + ' · ' + r.record.mode + ' · ' + g); continue; }
      const res = await fs('POST', '/matches?documentId=' + encodeURIComponent('riot-' + id), { fields: toFields(r.record) });
      if (res.status === 200) { added++; log(id + ' eingetragen → ' + r.team + ' · ' + r.record.mode + ' · ' + g); }
      else if (res.status === 409) log(id + ': war schon eingetragen');
      else throw new Error('Runde nicht speicherbar (' + res.status + ')');
      seen.add(id);
    }
    await setDoc('/sync/state', { start: state.start, seen: [...seen].slice(-SEEN_MAX) });
    await status(true, added ? added + (added === 1 ? ' Runde' : ' Runden') + ' eingetragen' : 'nichts Neues', added);
    log(added ? added + ' neue Runde(n) eingetragen.' : 'Nichts Neues.');
    return { added };
  } catch (e) {
    await status(false, e.stop ? e.message : 'Fehler beim Abgleich');
    throw e;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Im Zeitplan endet der Lauf auch bei einem Fehler ohne Alarm: der Stand steht in der App-Fußzeile.
  // Von Hand gestartet (ARENA_STRICT=1) wird ein Fehler rot angezeigt.
  run({ probe: process.argv.includes('--probe') }).catch(e => {
    console.error('::error::Abgleich abgebrochen: ' + e.message);
    process.exit(process.env.ARENA_STRICT ? 1 : 0);
  });
}
