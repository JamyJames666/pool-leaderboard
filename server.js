require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cups = require('./cups');

const app = express();
const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.PASSWORD || 'pool123';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DB_PATH = path.join(__dirname, 'data', 'db.json');

const START_ELO = 1000;
const FLOOR_ELO = 100;
// Frames a player needs in a season before their rating holds a ranked place.
const QUALIFY_RULES = [
  { from: '0000-Q0', games: 10 },
  { from: '2026-Q4', games: 12 },
];
const qualifyGames = key => QUALIFY_RULES.filter(r => key >= r.from).pop().games;
// 0 = hard reset to START_ELO every quarter, 1 = no reset at all
const SEASON_CARRYOVER = 0;

// in-memory sessions: token -> { role, expires }
const sessions = new Map();

if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'));
}
if (!fs.existsSync(DB_PATH)) {
  fs.writeFileSync(DB_PATH, JSON.stringify({ players: [], matches: [] }, null, 2));
}

function readDB() {
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  db.cups ||= [];
  return db;
}

// A frame is worth the loser's remaining balls, plus to the winner and minus to the loser.
const ballsOf = m => (Number.isInteger(m.ballsLeft) ? m.ballsLeft : 0);

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function genId() {
  return crypto.randomBytes(8).toString('hex');
}

function calcEloChange(winnerElo, loserElo) {
  const K = 32;
  const expected = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
  return Math.max(1, Math.round(K * (1 - expected)));
}

// Replay all matches from scratch to keep ELOs consistent after edits/deletes
function recomputeAllElos(db) {
  for (const p of db.players) {
    p.elo = 1000;
    p.wins = 0;
    p.losses = 0;
  }
  for (const m of db.matches) {
    const winner = db.players.find(p => p.id === m.winnerId);
    const loser = db.players.find(p => p.id === m.loserId);
    if (!winner || !loser) continue;
    const change = calcEloChange(winner.elo, loser.elo);
    m.winnerEloBefore = winner.elo;
    m.loserEloBefore = loser.elo;
    m.eloChange = change;
    winner.elo += change;
    winner.wins++;
    loser.elo = Math.max(100, loser.elo - change);
    loser.losses++;
  }
}

// --- SEASONS ---
// A season is a calendar quarter derived from match.playedAt. Nothing is stored.

function seasonKeyOf(when) {
  const d = new Date(when);
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

function seasonLabel(key) {
  const [year, q] = key.split('-Q');
  return `Q${q} ${year}`;
}

function nextSeasonKey(key) {
  const [year, q] = key.split('-Q').map(Number);
  return q === 4 ? `${year + 1}-Q1` : `${year}-Q${q + 1}`;
}

function seasonBounds(key) {
  const [year, q] = key.split('-Q').map(Number);
  return {
    start: new Date(Date.UTC(year, (q - 1) * 3, 1)).toISOString(),
    end: new Date(Date.UTC(year, q * 3, 1) - 1).toISOString(),
  };
}

function seedFrom(previousElo) {
  if (previousElo === undefined) return START_ELO;
  return Math.round(START_ELO + (previousElo - START_ELO) * SEASON_CARRYOVER);
}

function rankRows(rows) {
  return rows
    .sort((a, b) => Number(b.qualified) - Number(a.qualified) || b.elo - a.elo || b.ballDiff - a.ballDiff || b.wins - a.wins || a.name.localeCompare(b.name))
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

// Walks every season oldest first so each one can be seeded from the last.
function computeSeasons(db) {
  const buckets = new Map();
  for (const m of [...db.matches].sort((a, b) => new Date(a.playedAt) - new Date(b.playedAt))) {
    const key = seasonKeyOf(m.playedAt);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(m);
  }
  const currentKey = seasonKeyOf(new Date());
  if (!buckets.has(currentKey)) buckets.set(currentKey, []);

  const keys = [...buckets.keys()].sort();
  const standings = new Map();
  let carried = new Map();

  for (const key of keys) {
    const stats = new Map(db.players.map(p => [p.id, {
      elo: seedFrom(carried.get(p.id)), wins: 0, losses: 0, ballDiff: 0, form: [], lastDelta: null,
    }]));

    for (const m of buckets.get(key)) {
      const w = stats.get(m.winnerId);
      const l = stats.get(m.loserId);
      if (!w || !l) continue;
      const change = calcEloChange(w.elo, l.elo);
      w.elo += change; w.wins++; w.ballDiff += ballsOf(m); w.form.push('W'); w.lastDelta = change;
      l.elo = Math.max(FLOOR_ELO, l.elo - change); l.losses++; l.ballDiff -= ballsOf(m); l.form.push('L'); l.lastDelta = -change;
    }

    const previous = standings.get(keys[keys.indexOf(key) - 1]);
    const prevRankOf = new Map((previous || []).map(r => [r.id, r.rank]));

    const needed = qualifyGames(key);
    const rows = rankRows(db.players
      .filter(p => stats.get(p.id).wins + stats.get(p.id).losses > 0)
      .map(p => {
        const st = stats.get(p.id);
        const games = st.wins + st.losses;
        return {
          id: p.id, name: p.name, elo: st.elo, wins: st.wins, losses: st.losses,
          ballDiff: st.ballDiff, games, winRate: Math.round(st.wins / games * 100),
          form: st.form.slice(-5), lastDelta: st.lastDelta,
          gamesNeeded: needed, qualified: games >= needed,
        };
      }))
      .map(r => {
        const prevRank = prevRankOf.has(r.id) ? prevRankOf.get(r.id) : null;
        return { ...r, prevRank, rankChange: prevRank === null ? null : prevRank - r.rank };
      });

    standings.set(key, rows);
    carried = new Map([...stats].map(([id, st]) => [id, st.elo]));
  }

  return { keys, buckets, standings, currentKey };
}

function allTimeStandings(db) {
  const form = new Map(db.players.map(p => [p.id, []]));
  const diff = new Map(db.players.map(p => [p.id, 0]));
  for (const m of db.matches) {
    form.get(m.winnerId)?.push('W');
    form.get(m.loserId)?.push('L');
    if (diff.has(m.winnerId)) diff.set(m.winnerId, diff.get(m.winnerId) + ballsOf(m));
    if (diff.has(m.loserId)) diff.set(m.loserId, diff.get(m.loserId) - ballsOf(m));
  }
  return rankRows(db.players.map(p => {
    const games = p.wins + p.losses;
    return {
      id: p.id, name: p.name, elo: p.elo, wins: p.wins, losses: p.losses,
      ballDiff: diff.get(p.id), games, winRate: games ? Math.round(p.wins / games * 100) : null,
      form: form.get(p.id).slice(-5), lastDelta: null,
      gamesNeeded: null, qualified: true, prevRank: null, rankChange: null,
    };
  }));
}

function resolveSeason(db, requested) {
  const season = computeSeasons(db);
  if (requested === 'all') return { season, key: 'all' };
  if (!requested || requested === 'current') return { season, key: season.currentKey };
  return { season, key: season.standings.has(requested) ? requested : season.currentKey };
}

function getSession(req) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return null;
  const s = sessions.get(token);
  if (!s || Date.now() > s.expires) { sessions.delete(token); return null; }
  return s;
}

const requireAuth = (req, res, next) => {
  if (!getSession(req)) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

const requireAdmin = (req, res, next) => {
  const s = getSession(req);
  if (!s || s.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
};

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- AUTH ---

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  let role = null;
  if (password === ADMIN_PASSWORD) role = 'admin';
  else if (password === PASSWORD) role = 'user';
  else return res.status(401).json({ error: 'Wrong password' });

  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { role, expires: Date.now() + 24 * 60 * 60 * 1000 });
  res.json({ token, role });
});

app.post('/api/logout', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

// --- PLAYERS ---

app.get('/api/players', (_req, res) => {
  res.json(readDB().players);
});

app.post('/api/players', requireAuth, (req, res) => {
  const name = req.body.name?.trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const db = readDB();
  if (db.players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
    return res.status(400).json({ error: 'Player already exists' });
  }
  const player = { id: genId(), name, elo: 1000, wins: 0, losses: 0, createdAt: new Date().toISOString() };
  db.players.push(player);
  writeDB(db);
  res.json(player);
});

app.put('/api/players/:id', requireAdmin, (req, res) => {
  const name = req.body.name?.trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const db = readDB();
  const p = db.players.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  p.name = name;
  writeDB(db);
  res.json(p);
});

app.delete('/api/players/:id', requireAdmin, (req, res) => {
  const db = readDB();
  const idx = db.players.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.players.splice(idx, 1);
  db.matches = db.matches.filter(m => m.winnerId !== req.params.id && m.loserId !== req.params.id);
  recomputeAllElos(db);
  writeDB(db);
  res.json({ ok: true });
});

// --- MATCHES ---

app.get('/api/matches', (req, res) => {
  const db = readDB();
  const playerMap = Object.fromEntries(db.players.map(p => [p.id, p.name]));
  const wanted = req.query.season && req.query.season !== 'all' ? req.query.season : null;
  const scoped = wanted ? db.matches.filter(m => seasonKeyOf(m.playedAt) === wanted) : db.matches;
  const matches = [...scoped].reverse().map(m => ({
    ...m,
    winnerName: playerMap[m.winnerId] ?? 'Unknown',
    loserName: playerMap[m.loserId] ?? 'Unknown',
  }));
  res.json(matches);
});

app.post('/api/matches', requireAuth, (req, res) => {
  const { winnerId, loserId, ballsLeft } = req.body;
  if (!winnerId || !loserId) return res.status(400).json({ error: 'Both players required' });
  if (winnerId === loserId) return res.status(400).json({ error: 'Players must be different' });
  const balls = Number(ballsLeft);
  if (!Number.isInteger(balls) || balls < 0 || balls > 7) {
    return res.status(400).json({ error: 'Balls left must be 0 to 7' });
  }
  const db = readDB();
  const winner = db.players.find(p => p.id === winnerId);
  const loser = db.players.find(p => p.id === loserId);
  if (!winner || !loser) return res.status(400).json({ error: 'Player not found' });

  const change = calcEloChange(winner.elo, loser.elo);
  const match = {
    id: genId(),
    winnerId, loserId,
    winnerEloBefore: winner.elo,
    loserEloBefore: loser.elo,
    eloChange: change,
    ballsLeft: balls,
    playedAt: new Date().toISOString(),
  };
  winner.elo += change;
  winner.wins++;
  loser.elo = Math.max(100, loser.elo - change);
  loser.losses++;
  db.matches.push(match);
  writeDB(db);
  res.json({ match, winner, loser });
});

app.delete('/api/matches/:id', requireAdmin, (req, res) => {
  const db = readDB();
  const idx = db.matches.findIndex(m => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.matches.splice(idx, 1);
  recomputeAllElos(db);
  writeDB(db);
  res.json({ ok: true });
});

// --- LEADERBOARD ---

app.get('/api/seasons', (_req, res) => {
  const db = readDB();
  const { keys, buckets, currentKey } = computeSeasons(db);
  res.json(keys.slice().reverse().map(key => ({
    key,
    label: seasonLabel(key),
    ...seasonBounds(key),
    matches: buckets.get(key).length,
    current: key === currentKey,
  })));
});

app.get('/api/leaderboard', (req, res) => {
  const db = readDB();
  const { season, key } = resolveSeason(db, req.query.season);
  const rows = key === 'all' ? allTimeStandings(db) : season.standings.get(key);
  const prevKey = key === 'all' ? null : season.keys[season.keys.indexOf(key) - 1];
  const prevRows = prevKey ? season.standings.get(prevKey) : null;
  res.json({
    previousSeason: prevRows && prevRows.length
      ? { key: prevKey, label: seasonLabel(prevKey), top3: prevRows.slice(0, 3).map(r => ({ id: r.id, name: r.name, rank: r.rank, elo: r.elo, ballDiff: r.ballDiff, wins: r.wins, losses: r.losses })) }
      : null,
    season: key,
    label: key === 'all' ? 'All time' : seasonLabel(key),
    current: key === season.currentKey,
    ...(key === 'all' ? {} : seasonBounds(key)),
    matches: key === 'all' ? db.matches.length : season.buckets.get(key).length,
    carryover: SEASON_CARRYOVER,
    qualify: key === 'all' ? null : {
      games: qualifyGames(key),
      next: qualifyGames(nextSeasonKey(key)) === qualifyGames(key)
        ? null
        : { label: seasonLabel(nextSeasonKey(key)), games: qualifyGames(nextSeasonKey(key)) },
    },
    standings: rows,
  });
});

// --- CUPS ---
// Cup frames never touch db.matches or ELO. They live only inside their cup.

function playersById(db) {
  return new Map(db.players.map(p => [p.id, p]));
}

function cupSummary(db, cup) {
  const r = cups.resolveCup(cup, playersById(db));
  const leader = r.table ? r.table[0] : null;
  return {
    id: r.id, name: r.name, format: r.format, seasonKey: r.seasonKey, seasonLabel: seasonLabel(r.seasonKey),
    createdAt: r.createdAt, players: r.seeds.length, progress: r.progress, status: r.status,
    championId: r.championId, championName: r.championName,
    leaderName: r.status === 'live' && leader && leader.played ? leader.name : null,
  };
}

app.get('/api/cups', (_req, res) => {
  const db = readDB();
  const list = db.cups.map(c => cupSummary(db, c))
    .sort((a, b) => (a.status === b.status ? 0 : a.status === 'live' ? -1 : 1) || b.createdAt.localeCompare(a.createdAt));
  res.json(list);
});

app.get('/api/cups/:id', (req, res) => {
  const db = readDB();
  const cup = db.cups.find(c => c.id === req.params.id);
  if (!cup) return res.status(404).json({ error: 'Cup not found' });
  res.json({ ...cups.resolveCup(cup, playersById(db)), seasonLabel: seasonLabel(cup.seasonKey) });
});

app.post('/api/cups', requireAuth, (req, res) => {
  const { format } = req.body;
  if (!cups.FORMATS.includes(format)) return res.status(400).json({ error: 'Pick single elimination, double elimination or round robin' });
  const db = readDB();
  const known = playersById(db);
  const ids = [...new Set(Array.isArray(req.body.playerIds) ? req.body.playerIds : [])].filter(id => known.has(id));
  if (ids.length < 2) return res.status(400).json({ error: 'A cup needs at least 2 players' });

  const { standings, currentKey } = computeSeasons(db);
  const seasonElo = new Map((standings.get(currentKey) || []).map(r => [r.id, r.elo]));
  const seeds = ids.sort((a, b) =>
    (seasonElo.get(b) ?? START_ELO) - (seasonElo.get(a) ?? START_ELO) ||
    known.get(b).elo - known.get(a).elo ||
    known.get(a).name.localeCompare(known.get(b).name));

  const name = req.body.name?.trim() || `${seasonLabel(currentKey)} Cup`;
  const cup = { id: genId(), name: name.slice(0, 60), seasonKey: currentKey, format, seeds, results: {}, createdAt: new Date().toISOString() };
  db.cups.push(cup);
  writeDB(db);
  res.json({ ...cups.resolveCup(cup, known), seasonLabel: seasonLabel(currentKey) });
});

app.post('/api/cups/:id/results', requireAuth, (req, res) => {
  const { fixtureId, winnerId } = req.body;
  const balls = Number(req.body.ballsLeft);
  if (!Number.isInteger(balls) || balls < 0 || balls > 7) return res.status(400).json({ error: 'Balls left must be 0 to 7' });
  const db = readDB();
  const cup = db.cups.find(c => c.id === req.params.id);
  if (!cup) return res.status(404).json({ error: 'Cup not found' });
  const fixture = cups.resolveCup(cup, playersById(db)).fixtures.find(f => f.id === fixtureId);
  if (!fixture) return res.status(404).json({ error: 'Fixture not found' });
  if (fixture.state !== 'ready') return res.status(400).json({ error: fixture.state === 'done' ? 'That frame already has a result' : 'That frame is not ready to play yet' });
  if (winnerId !== fixture.a.id && winnerId !== fixture.b.id) return res.status(400).json({ error: 'Winner must be one of the two players' });

  cup.results[fixtureId] = { winnerId, ballsLeft: balls, playedAt: new Date().toISOString() };
  writeDB(db);
  res.json({ ...cups.resolveCup(cup, playersById(db)), seasonLabel: seasonLabel(cup.seasonKey) });
});

app.delete('/api/cups/:id/results/:fixtureId', requireAdmin, (req, res) => {
  const db = readDB();
  const cup = db.cups.find(c => c.id === req.params.id);
  if (!cup) return res.status(404).json({ error: 'Cup not found' });
  if (!cup.results[req.params.fixtureId]) return res.status(404).json({ error: 'No result to undo' });
  if (!cups.canUndo(cup, req.params.fixtureId)) {
    return res.status(400).json({ error: 'A later frame depends on this result. Undo that one first' });
  }
  delete cup.results[req.params.fixtureId];
  writeDB(db);
  res.json({ ...cups.resolveCup(cup, playersById(db)), seasonLabel: seasonLabel(cup.seasonKey) });
});

app.delete('/api/cups/:id', requireAdmin, (req, res) => {
  const db = readDB();
  const idx = db.cups.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Cup not found' });
  db.cups.splice(idx, 1);
  writeDB(db);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Pool leaderboard running at http://localhost:${PORT}`);
});