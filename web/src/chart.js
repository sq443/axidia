// Chart format:
//   { bpm, duration (ms), notes: [{ time (ms), x (0..1, center of note in the field) }] }
// Free lane: x is continuous, there are no fixed lanes.
// For now charts are generated from a fixed seed so every play of a difficulty is identical.

const MIN_X = 0.1;
const MAX_X = 0.9;
const BPM = 140;
const BARS = 32;

export const DIFFICULTIES = {
  EASY: { seed: 11, patterns: ['half', 'quarter', 'halfDouble', 'quarter'] },
  NORMAL: { seed: 23, patterns: ['quarter', 'eighthStair', 'zigzag', 'quarterDouble'] },
  HARD: { seed: 37, patterns: ['eighthStair', 'zigzag', 'quarterDouble', 'burst', 'eighthDouble'] },
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v) => Math.min(MAX_X, Math.max(MIN_X, v));
const between = (rng, lo, hi) => lo + rng() * (hi - lo);

// Random position at least `minDist` away from `from`, so consecutive notes move.
function nextX(rng, from, minDist = 0.2) {
  for (let i = 0; i < 8; i++) {
    const x = between(rng, MIN_X, MAX_X);
    if (Math.abs(x - from) >= minDist) return x;
  }
  return from < 0.5 ? clamp(from + minDist) : clamp(from - minDist);
}

const pair = (rng) => [between(rng, MIN_X, 0.38), between(rng, 0.62, MAX_X)];

// Each pattern fills one bar (4 beats) and returns [[beat, x], ...].
const PATTERNS = {
  half(rng, s) {
    return [0, 2].map((b) => [b, (s.x = nextX(rng, s.x, 0.25))]);
  },
  quarter(rng, s) {
    return [0, 1, 2, 3].map((b) => [b, (s.x = nextX(rng, s.x))]);
  },
  halfDouble(rng, s) {
    const [a, b] = pair(rng);
    s.x = nextX(rng, 0.5, 0.25);
    return [[0, a], [0, b], [2, s.x]];
  },
  quarterDouble(rng, s) {
    const [a, b] = pair(rng);
    const [c, d] = pair(rng);
    const out = [[0, a], [0, b], [1, (s.x = nextX(rng, 0.5, 0.15))], [2, c], [2, d]];
    out.push([3, (s.x = nextX(rng, s.x))]);
    return out;
  },
  eighthStair(rng, s) {
    let dir = s.x < 0.5 ? 1 : -1;
    let x = s.x;
    const out = [];
    for (let i = 0; i < 8; i++) {
      x += dir * 0.11;
      if (x > MAX_X || x < MIN_X) {
        dir = -dir;
        x += 2 * dir * 0.11;
      }
      out.push([i / 2, clamp(x)]);
    }
    s.x = x;
    return out;
  },
  zigzag(rng, s) {
    const out = [];
    for (let i = 0; i < 8; i++) {
      const left = i % 2 === 0;
      out.push([i / 2, left ? between(rng, MIN_X, 0.38) : between(rng, 0.62, MAX_X)]);
    }
    s.x = out[7][1];
    return out;
  },
  burst(rng, s) {
    const dir = s.x < 0.5 ? 1 : -1;
    const start = dir > 0 ? between(rng, MIN_X, 0.3) : between(rng, 0.7, MAX_X);
    const out = [0, 0.25, 0.5, 0.75].map((b, i) => [b, clamp(start + dir * i * 0.11)]);
    let x = out[3][1];
    for (const b of [1.5, 2, 3, 3.5]) out.push([b, (x = nextX(rng, x))]);
    s.x = x;
    return out;
  },
  eighthDouble(rng, s) {
    const out = [];
    for (const b of [0, 2]) {
      const [l, r] = pair(rng);
      out.push([b, l], [b, r]);
      let x = 0.5;
      for (const o of [0.5, 1, 1.5]) out.push([b + o, (x = nextX(rng, x, 0.18))]);
    }
    s.x = out[out.length - 1][1];
    return out;
  },
};

export function generateChart(difficulty) {
  const def = DIFFICULTIES[difficulty];
  const rng = mulberry32(def.seed);
  const beatMs = 60000 / BPM;
  const state = { x: 0.5 };
  const raw = [];

  // Bar 0 is lead-in. Phrases are 2 bars; the second bar mirrors the first.
  for (let bar = 1; bar < BARS; bar += 2) {
    const pool = bar < 5 ? def.patterns.slice(0, 1) : def.patterns;
    const name = pool[Math.floor(rng() * pool.length)];
    const phrase = PATTERNS[name](rng, state);
    for (const [beat, x] of phrase) {
      raw.push([bar * 4 + beat, x]);
      if (bar + 1 < BARS) raw.push([(bar + 1) * 4 + beat, 1 - x]);
    }
    state.x = 1 - state.x;
  }
  raw.push([BARS * 4, 0.5]); // final note

  const notes = raw
    .map(([beat, x]) => ({ time: beat * beatMs, x: Math.round(x * 1000) / 1000 }))
    .sort((a, b) => a.time - b.time || a.x - b.x);

  return {
    difficulty,
    bpm: BPM,
    beatMs,
    notes,
    duration: notes[notes.length - 1].time + 1200,
  };
}
