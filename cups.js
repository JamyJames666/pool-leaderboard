// Cup engine. Fixtures are regenerated from format + seeds on every read and
// stored results are replayed onto them, so nothing here is ever persisted.

const BYE = '__bye__';
const FORMATS = ['single', 'double', 'roundrobin'];

function nextPow2(n) {
  let s = 1;
  while (s < n) s *= 2;
  return s;
}

// Standard bracket order, so seed 1 and seed 2 can only meet in the final.
function seedOrder(size) {
  let order = [1, 2];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap(s => [s, n + 1 - s]);
  }
  return order.slice(0, size);
}

const winnerOf = id => ({ from: id, take: 'winner' });
const loserOf = id => ({ from: id, take: 'loser' });
const fid = (bracket, round, index) => `${bracket}-r${round}-m${index}`;

function buildElimination(n, double) {
  const size = nextPow2(Math.max(n, 2));
  const k = Math.log2(size);
  const order = seedOrder(size);
  const fixtures = [];

  for (let r = 1; r <= k; r++) {
    const count = size / 2 ** r;
    for (let m = 0; m < count; m++) {
      fixtures.push({
        id: fid('W', r, m), bracket: 'W', round: r, index: m,
        a: r === 1 ? { seed: order[2 * m] } : winnerOf(fid('W', r - 1, 2 * m)),
        b: r === 1 ? { seed: order[2 * m + 1] } : winnerOf(fid('W', r - 1, 2 * m + 1)),
      });
    }
  }
  if (!double) return fixtures;

  let lbFinal = null;
  if (k >= 2) {
    let round = 1;
    let prev = [];
    for (let m = 0; m < size / 4; m++) {
      const id = fid('L', round, m);
      fixtures.push({ id, bracket: 'L', round, index: m, a: loserOf(fid('W', 1, 2 * m)), b: loserOf(fid('W', 1, 2 * m + 1)) });
      prev.push(id);
    }
    for (let j = 2; j <= k; j++) {
      round++;
      const minor = [];
      const c = prev.length;
      for (let m = 0; m < c; m++) {
        const id = fid('L', round, m);
        // Drop-ins arrive reversed so a player can't meet the person who just beat them.
        fixtures.push({ id, bracket: 'L', round, index: m, a: winnerOf(prev[m]), b: loserOf(fid('W', j, c - 1 - m)) });
        minor.push(id);
      }
      prev = minor;
      if (j < k) {
        round++;
        const major = [];
        for (let m = 0; m < prev.length / 2; m++) {
          const id = fid('L', round, m);
          fixtures.push({ id, bracket: 'L', round, index: m, a: winnerOf(prev[2 * m]), b: winnerOf(prev[2 * m + 1]) });
          major.push(id);
        }
        prev = major;
      }
    }
    lbFinal = winnerOf(prev[0]);
  } else {
    lbFinal = loserOf(fid('W', 1, 0));
  }

  fixtures.push({ id: 'GF-r1-m0', bracket: 'GF', round: 1, index: 0, a: winnerOf(fid('W', k, 0)), b: lbFinal });
  return fixtures;
}

// Circle method. An odd field gets a phantom player whose pairings are skipped.
function buildRoundRobin(n) {
  const slots = Array.from({ length: n }, (_, i) => i + 1);
  if (slots.length % 2) slots.push(null);
  const m = slots.length;
  const fixtures = [];
  let ring = slots.slice();
  for (let r = 1; r < m; r++) {
    let index = 0;
    for (let i = 0; i < m / 2; i++) {
      const a = ring[i];
      const b = ring[m - 1 - i];
      if (a === null || b === null) continue;
      fixtures.push({ id: fid('RR', r, index), bracket: 'RR', round: r, index: index++, a: { seed: a }, b: { seed: b } });
    }
    ring = [ring[0], ring[m - 1], ...ring.slice(1, m - 1)];
  }
  return fixtures;
}

function buildFixtures(format, seedCount) {
  if (format === 'roundrobin') return buildRoundRobin(seedCount);
  return buildElimination(seedCount, format === 'double');
}

function expectedFrames(format, n) {
  if (format === 'roundrobin') return (n * (n - 1)) / 2;
  if (format === 'double') return 2 * n - 2;
  return n - 1;
}

function slotLabel(ref) {
  const [bracket, r, m] = ref.from.split('-');
  const round = r.slice(1);
  const match = Number(m.slice(1)) + 1;
  const where = bracket === 'W' ? `R${round} M${match}` : bracket === 'L' ? `LR${round} M${match}` : 'the final';
  return `${ref.take === 'winner' ? 'Winner' : 'Loser'} of ${where}`;
}

function resolveCup(cup, playersById) {
  const seeds = cup.seeds;
  const fixtures = buildFixtures(cup.format, seeds.length);
  const byId = new Map();
  const nameOf = id => (id === BYE ? 'Bye' : playersById.get(id)?.name ?? 'Removed player');

  const resolveSlot = ref => {
    if (ref.seed !== undefined) return ref.seed <= seeds.length ? seeds[ref.seed - 1] : BYE;
    const src = byId.get(ref.from);
    if (!src || src.winnerId === null) return null;
    return ref.take === 'winner' ? src.winnerId : src.loserId;
  };

  const out = fixtures.map(f => {
    const aId = resolveSlot(f.a);
    const bId = resolveSlot(f.b);
    const row = {
      id: f.id, bracket: f.bracket, round: f.round, index: f.index,
      feeds: [f.a.from ?? null, f.b.from ?? null],
      a: aId === null ? { pending: slotLabel(f.a) } : { id: aId, name: nameOf(aId), seed: seeds.indexOf(aId) + 1 || null, bye: aId === BYE },
      b: bId === null ? { pending: slotLabel(f.b) } : { id: bId, name: nameOf(bId), seed: seeds.indexOf(bId) + 1 || null, bye: bId === BYE },
      state: 'waiting', winnerId: null, loserId: null, ballsLeft: null, playedAt: null,
    };

    if (aId !== null && bId !== null) {
      if (aId === BYE || bId === BYE) {
        row.state = 'bye';
        row.winnerId = aId === BYE ? bId : aId;
        row.loserId = BYE;
      } else {
        const res = cup.results[f.id];
        if (res && (res.winnerId === aId || res.winnerId === bId)) {
          row.state = 'done';
          row.winnerId = res.winnerId;
          row.loserId = res.winnerId === aId ? bId : aId;
          row.ballsLeft = res.ballsLeft;
          row.playedAt = res.playedAt;
        } else {
          row.state = 'ready';
        }
      }
    }
    byId.set(f.id, row);
    return row;
  });

  const real = out.filter(f => f.state !== 'bye');
  const done = real.filter(f => f.state === 'done').length;
  const result = {
    id: cup.id, name: cup.name, format: cup.format, seasonKey: cup.seasonKey, createdAt: cup.createdAt,
    seeds: seeds.map((id, i) => ({ id, name: nameOf(id), seed: i + 1 })),
    fixtures: out,
    progress: { done, total: expectedFrames(cup.format, seeds.length) },
    status: 'live', championId: null, championName: null, table: null,
  };

  if (cup.format === 'roundrobin') {
    result.table = roundRobinTable(seeds, out, nameOf);
    if (done === result.progress.total) {
      result.status = 'complete';
      result.championId = result.table[0]?.id ?? null;
    }
  } else {
    const decider = out[out.length - 1];
    if (decider.winnerId && decider.winnerId !== BYE && (decider.state === 'done' || decider.state === 'bye')) {
      result.status = 'complete';
      result.championId = decider.winnerId;
    }
  }
  if (result.championId) result.championName = nameOf(result.championId);
  return result;
}

function roundRobinTable(seeds, fixtures, nameOf) {
  const rows = new Map(seeds.map(id => [id, { id, name: nameOf(id), played: 0, wins: 0, losses: 0, ballDiff: 0 }]));
  const h2h = new Map();
  for (const f of fixtures) {
    if (f.state !== 'done') continue;
    const w = rows.get(f.winnerId);
    const l = rows.get(f.loserId);
    w.played++; w.wins++; w.ballDiff += f.ballsLeft;
    l.played++; l.losses++; l.ballDiff -= f.ballsLeft;
    h2h.set(`${f.winnerId}|${f.loserId}`, true);
  }
  return [...rows.values()]
    .sort((x, y) =>
      y.wins - x.wins ||
      y.ballDiff - x.ballDiff ||
      (h2h.has(`${y.id}|${x.id}`) ? 1 : h2h.has(`${x.id}|${y.id}`) ? -1 : 0) ||
      x.name.localeCompare(y.name))
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

// A result can only be undone while nothing downstream has been played.
// Bye fixtures carry no stored result, so walk straight through them.
function canUndo(cup, fixtureId) {
  const fixtures = buildFixtures(cup.format, cup.seeds.length);
  const dependents = id => fixtures.filter(f => f.a.from === id || f.b.from === id);
  const stack = [fixtureId];
  const seen = new Set();
  while (stack.length) {
    const id = stack.pop();
    for (const dep of dependents(id)) {
      if (seen.has(dep.id)) continue;
      seen.add(dep.id);
      if (cup.results[dep.id]) return false;
      stack.push(dep.id);
    }
  }
  return true;
}

module.exports = { BYE, FORMATS, buildFixtures, resolveCup, canUndo, expectedFrames };
