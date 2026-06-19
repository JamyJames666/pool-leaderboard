require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.PASSWORD || 'pool123';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DB_PATH = path.join(__dirname, 'data', 'db.json');

// in-memory sessions: token -> { role, expires }
const sessions = new Map();

if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'));
}
if (!fs.existsSync(DB_PATH)) {
  fs.writeFileSync(DB_PATH, JSON.stringify({ players: [], matches: [] }, null, 2));
}

function readDB() {
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

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

app.get('/api/matches', (_req, res) => {
  const db = readDB();
  const playerMap = Object.fromEntries(db.players.map(p => [p.id, p.name]));
  const matches = [...db.matches].reverse().map(m => ({
    ...m,
    winnerName: playerMap[m.winnerId] ?? 'Unknown',
    loserName: playerMap[m.loserId] ?? 'Unknown',
  }));
  res.json(matches);
});

app.post('/api/matches', requireAuth, (req, res) => {
  const { winnerId, loserId } = req.body;
  if (!winnerId || !loserId) return res.status(400).json({ error: 'Both players required' });
  if (winnerId === loserId) return res.status(400).json({ error: 'Players must be different' });
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

app.get('/api/leaderboard', (_req, res) => {
  const db = readDB();
  // Build per-player recent form (last 5 results, newest last)
  const formMap = Object.fromEntries(db.players.map(p => [p.id, []]));
  for (const m of db.matches) {
    if (formMap[m.winnerId] !== undefined) formMap[m.winnerId].push('W');
    if (formMap[m.loserId] !== undefined) formMap[m.loserId].push('L');
  }

  const leaderboard = [...db.players]
    .sort((a, b) => b.elo - a.elo)
    .map((p, i) => ({
      ...p,
      rank: i + 1,
      games: p.wins + p.losses,
      winRate: p.wins + p.losses > 0 ? Math.round(p.wins / (p.wins + p.losses) * 100) : null,
      form: formMap[p.id].slice(-5),
    }));
  res.json(leaderboard);
});

app.listen(PORT, () => {
  console.log(`Pool leaderboard running at http://localhost:${PORT}`);
});