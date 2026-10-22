// Chart format:
//   { bpm, beatMs, duration (ms), notes: [{ type, side, time (ms), x (0..1), end? (ms, hold only) }] }
//   side: 'bottom' — falls from the top edge to the bottom judgment line
//         'top'    — rises from the bottom edge to the top judgment line (vertical mirror)
//         'center' — flick only: a diamond in the middle of the screen
//         'free'   — slide only: runs between two anchor points (see below)
//   type: 'tap'   — tap when it reaches the line
//         'drag'  — just have a finger on it when it reaches the line (no tap needed)
//         'hold'  — tap the head, keep a finger on it until `end`
//         'flick' — move a touching finger in any direction when the diamond guide closes in
//         'slide' — trace a straight line from anchor `from` to anchor `to` between `time` and `end`
//   Slide anchors: T/B (top / bottom judgment line) + L/C/R. L and R are as far apart as the two
//   lines are, so TL-TR-BR-BL forms a square around the center.
// Free lane: x is the note's center as a fraction of the field width; there are no fixed lanes.
// For now charts are generated from a fixed seed so every play of a difficulty is identical.

const MIN_X = 0.08;
const MAX_X = 0.92;
const BPM = 140;
const BARS = 32;

export const DIFFICULTIES = {
  EASY: {
    seed: 418,
    flick: 0.3,
    slideLen: 1.5,
    patterns: ['half', 'quarter', 'holdSimple', 'dragSweep', 'halfDouble', 'mirrorHalf', 'slide'],
  },
  NORMAL: {
    seed: 35,
    flick: 0.4,
    slideLen: 1.5,
    patterns: [
      'quarter', 'eighthStair', 'zigzag', 'quarterDouble', 'holdSimple', 'dragWave', 'holdTaps', 'mirror', 'slide',
    ],
  },
  HARD: {
    seed: 484,
    flick: 0.5,
    slideLen: 1,
    patterns: [
      'eighthStair', 'zigzag', 'quarterDouble', 'burst', 'eighthDouble', 'dragZig', 'holdTaps', 'mirror', 'seesaw',
      'slide',
    ],
  },
  // Test chart: slides only, every shape at several speeds.
  SLIDE: { test: 'slides' },
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

const flip = (side) => (side === 'top' ? 'bottom' : 'top');
const pair = (rng) => [between(rng, MIN_X, 0.38), between(rng, 0.62, MAX_X)];

// Each pattern fills one bar (4 beats) and returns [[beat, x, type?, lengthInBeats?, otherSide?, from?, to?], ...].
// `otherSide` puts the note on the opposite judgment line from the rest of the bar.
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
      x += dir * 0.1;
      if (x > MAX_X || x < MIN_X) {
        dir = -dir;
        x += 2 * dir * 0.1;
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
    const out = [0, 0.25, 0.5, 0.75].map((b, i) => [b, clamp(start + dir * i * 0.1)]);
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

  // ---- both lines ----
  // Same position on both lines at once.
  mirrorHalf(rng, s) {
    return [0, 2].flatMap((b) => {
      const x = (s.x = nextX(rng, s.x, 0.25));
      return [[b, x], [b, x, 'tap', 0, true]];
    });
  },
  mirror(rng, s) {
    return [0, 1, 2, 3].flatMap((b) => {
      const x = (s.x = nextX(rng, s.x));
      return [[b, x], [b, x, 'tap', 0, true]];
    });
  },
  // 8ths alternating between the lines while drifting sideways.
  seesaw(rng, s) {
    let dir = s.x < 0.5 ? 1 : -1;
    let x = s.x;
    const out = [];
    for (let i = 0; i < 8; i++) {
      x += dir * 0.08;
      if (x > MAX_X || x < MIN_X) {
        dir = -dir;
        x += 2 * dir * 0.08;
      }
      out.push([i / 2, clamp(x), 'tap', 0, i % 2 === 1]);
    }
    s.x = x;
    return out;
  },

  // ---- hold ----
  holdSimple(rng, s) {
    const x = (s.x = nextX(rng, s.x, 0.25));
    return [[0, x, 'hold', 2], [3, (s.x = nextX(rng, x, 0.3))]];
  },
  // Hold on one side while tapping on the other.
  holdTaps(rng, s) {
    const left = rng() < 0.5;
    const hx = left ? between(rng, MIN_X, 0.3) : between(rng, 0.7, MAX_X);
    const out = [[0, hx, 'hold', 3]];
    const beats = s.hard ? [1, 1.5, 2, 2.5, 3] : [1, 2, 3];
    for (const b of beats) out.push([b, left ? between(rng, 0.55, MAX_X) : between(rng, MIN_X, 0.45)]);
    s.x = out[out.length - 1][1];
    return out;
  },

  // ---- drag ----
  // Straight slide across the field on 8ths.
  dragSweep(rng, s) {
    const from = s.x < 0.5 ? between(rng, MIN_X, 0.25) : between(rng, 0.75, MAX_X);
    const to = 1 - from;
    const out = [];
    for (let i = 0; i < 7; i++) out.push([i / 2, from + ((to - from) * i) / 6, 'drag']);
    s.x = to;
    return out;
  },
  // Gentle sine wave on 8ths, ending with a tap.
  dragWave(rng, s) {
    const c = between(rng, 0.35, 0.65);
    const amp = Math.min(c - MIN_X, MAX_X - c, 0.3);
    const phase = rng() * Math.PI * 2;
    const out = [];
    for (let i = 0; i < 7; i++) out.push([i / 2, c + amp * Math.sin(phase + (i * Math.PI) / 3), 'drag']);
    out.push([3.5, (s.x = nextX(rng, out[6][1], 0.3))]);
    return out;
  },
  // Two quick 16th slides in opposite directions.
  dragZig(rng, s) {
    const out = [];
    let x = s.x < 0.5 ? between(rng, MIN_X, 0.3) : between(rng, 0.7, MAX_X);
    for (const start of [0, 2]) {
      const dir = x < 0.5 ? 1 : -1;
      for (let i = 0; i < 6; i++) out.push([start + i / 4, clamp(x + dir * i * 0.09), 'drag']);
      x = nextX(rng, clamp(x + dir * 5 * 0.09), 0.3);
      out.push([start + 1.5, x]); // the next slide starts from this tap
    }
    s.x = x;
    return out;
  },

  // ---- slide ----
  // One straight slide starting on beat 1; its guide appears one beat earlier, on beat 0.
  slide(rng, s) {
    const from = ANCHORS[Math.floor(rng() * ANCHORS.length)];
    const rest = ANCHORS.filter((a) => a !== from);
    const to = rest[Math.floor(rng() * rest.length)];
    return [[1, 0.5, 'slide', s.slideLen, false, from, to]];
  },
};

const ANCHORS = ['TL', 'TC', 'TR', 'BL', 'BC', 'BR'];
const MIRROR_H = { L: 'R', C: 'C', R: 'L' };
const mirrorH = (a) => a[0] + MIRROR_H[a[1]];
const flipV = (a) => (a[0] === 'T' ? 'B' : 'T') + a[1];

// Every directed anchor pair once — horizontal, then vertical, then diagonal — cycling through
// lengths so each shape shows up at different speeds. Slides are two beats apart, so each guide
// appears one beat after the previous slide ends.
function slideTestChart(difficulty) {
  const beatMs = 60000 / BPM;
  const LENGTHS = [1, 2, 0.5, 1.5, 3]; // beats
  const kind = (a, b) => (a[0] === b[0] ? 0 : a[1] === b[1] ? 1 : 2);
  const pairs = ANCHORS.flatMap((a) => ANCHORS.filter((b) => b !== a).map((b) => [a, b]));
  pairs.sort((p, q) => kind(...p) - kind(...q));
  const notes = [];
  let beat = 4;
  pairs.forEach(([from, to], i) => {
    const len = LENGTHS[i % LENGTHS.length];
    notes.push({ type: 'slide', side: 'free', time: beat * beatMs, end: (beat + len) * beatMs, x: 0.5, from, to });
    beat += len + 2;
  });
  const last = notes[notes.length - 1].end;
  return { difficulty, bpm: BPM, beatMs, notes, duration: last + 1200 };
}

export function generateChart(difficulty) {
  const def = DIFFICULTIES[difficulty];
  if (def.test === 'slides') return slideTestChart(difficulty);
  const rng = mulberry32(def.seed);
  const beatMs = 60000 / BPM;
  const state = { x: 0.5, hard: difficulty === 'HARD', slideLen: def.slideLen };
  let raw = [];

  // Bar 0 is lead-in. Phrases are 2 bars; the second bar mirrors the first horizontally,
  // and sometimes answers on the other judgment line.
  for (let bar = 1; bar < BARS; bar += 2) {
    const intro = bar < 5;
    const pool = intro ? def.patterns.slice(0, 1) : def.patterns;
    const name = pool[Math.floor(rng() * pool.length)];
    const phrase = PATTERNS[name](rng, state);
    const sideA = intro || rng() < 0.5 ? 'bottom' : 'top';
    const sideB = !intro && rng() < 0.5 ? flip(sideA) : sideA;
    for (const [beat, x, type = 'tap', len = 0, other = false, from, to] of phrase) {
      if (type === 'slide') {
        // Slides mirror like everything else: horizontally in the answer bar, vertically on the top side.
        const v = (a, side) => (side === 'top' ? flipV(a) : a);
        raw.push([bar * 4 + beat, x, type, len, 'free', v(from, sideA), v(to, sideA)]);
        if (bar + 1 < BARS) {
          raw.push([(bar + 1) * 4 + beat, x, type, len, 'free', v(mirrorH(from), sideB), v(mirrorH(to), sideB)]);
        }
        continue;
      }
      raw.push([bar * 4 + beat, x, type, len, other ? flip(sideA) : sideA]);
      if (bar + 1 < BARS) raw.push([(bar + 1) * 4 + beat, 1 - x, type, len, other ? flip(sideB) : sideB]);
    }
    state.x = 1 - state.x;

    // Some phrases open with a center flick, which takes over that beat (unless a hold starts there).
    const fb = bar * 4;
    const flick = !intro && name !== 'slide' && (bar === 5 || rng() < def.flick);
    if (flick && !raw.some((r) => r[0] === fb && r[2] === 'hold')) {
      raw = raw.filter((r) => r[0] !== fb);
      raw.push([fb, 0.5, 'flick', 0, 'center']);
    }
  }
  raw.push([BARS * 4, 0.5, 'flick', 0, 'center']); // finale

  const notes = raw
    .map(([beat, x, type, len, side, from, to]) => {
      const n = { type, side, time: beat * beatMs, x: Math.round(x * 1000) / 1000 };
      if (type === 'hold' || type === 'slide') n.end = (beat + len) * beatMs;
      if (type === 'slide') Object.assign(n, { from, to });
      return n;
    })
    .sort((a, b) => a.time - b.time || a.x - b.x);

  const last = notes.reduce((m, n) => Math.max(m, n.end ?? n.time), 0);
  return { difficulty, bpm: BPM, beatMs, notes, duration: last + 1200 };
}
