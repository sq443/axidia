// Scroll speed. From each change's time on, notes move at `speed` × the normal speed: 2 is twice as
// fast, 0 stops them, negative runs them backwards. pos(t) is how far the notes have traveled by
// song time t, in ms at speed 1, so at time t a note due at T is pos(T) − pos(t) from its line:
// positive on the side notes normally come from, negative on the far side of the line.
export function scrollMap(changes = []) {
  // segments: from `start` on, pos(t) = p0 + speed × (t − t0); before the first change, speed 1
  const segs = [{ start: -Infinity, speed: 1, t0: 0, p0: 0 }];
  for (const c of [...changes].filter((c) => Number.isFinite(c.time) && Number.isFinite(c.speed)).sort((a, b) => a.time - b.time)) {
    const last = segs[segs.length - 1];
    const p0 = last.p0 + last.speed * (c.time - last.t0);
    if (c.time === last.start) segs.pop();
    segs.push({ start: c.time, speed: c.speed, t0: c.time, p0 });
  }
  // the segment in force at t (`before`: just before t, i.e. the one a note due at t arrives in)
  const segAt = (t, before = false) => {
    let i = segs.length - 1;
    while (i > 0 && (before ? segs[i].start >= t : segs[i].start > t)) i--;
    return i;
  };
  const pos = (t) => {
    const s = segs[segAt(t)];
    return s.p0 + s.speed * (t - s.t0);
  };
  return {
    segs,
    constant: segs.length === 1,
    pos,
    segAt,
    speedAt: (t) => segs[segAt(t)].speed,
    // [min, max] of pos over [a, b] (a hold's body covers every position its span passes through)
    range(a, b) {
      let lo = Math.min(pos(a), pos(b));
      let hi = Math.max(pos(a), pos(b));
      for (const s of segs) {
        if (s.start > a && s.start < b) {
          const p = pos(s.start);
          lo = Math.min(lo, p);
          hi = Math.max(hi, p);
        }
      }
      return [lo, hi];
    },
  };
}

const LOOKBACK = 600000; // ms; how far before its time a note's path is followed at most

// When a note due at T is shown: its arrival side `sgn` (+1: as usual, −1: from the far side,
// when it arrives in a backwards stretch) and the time windows it is drawn in, [{ from, to, fade }].
// reach(sgn) is how far (pos units) the screen edge on that side is from the line.
//
// Following the note backwards from T, it is drawn while it is on its arrival side and on screen.
// Any time before that it may have been on the other side, approaching as if due earlier; it would
// pass through the line without being played, so it isn't shown. And when it only got onto its
// arrival side by coming out of the line, that stretch isn't shown either: if it then leaves the
// screen, it reappears from the edge; if it doesn't, it fades in where it starts heading for the
// line. So a visible note never crosses the line before its time, and never comes out of it.
export function approachWindows(map, T, reach) {
  const { segs } = map;
  const first = map.segAt(T, true);
  let j = first;
  while (j > 0 && segs[j].speed === 0) j--;
  const sgn = segs[j].speed < 0 ? -1 : 1;
  const D = reach(sgn);

  // pieces of the path, latest first: d (distance on the arrival side) goes linearly from da at a
  // to db at b
  const pieces = [];
  let b = T;
  let db = 0;
  let crossed = false;
  for (let k = first; k >= 0; k--) {
    const s = segs[k];
    const r = sgn * s.speed; // d grows by r per ms, going back in time
    if (r < 0) {
      const tc = b - db / -r; // back in the line here
      if (tc >= s.start) {
        pieces.push({ a: tc, b, da: 0, db });
        crossed = true;
        break;
      }
    }
    let a = s.start;
    if (a === -Infinity || T - a > LOOKBACK) {
      // before the first change (speed 1, so r > 0 here): it comes from beyond the edge
      a = r > 0 ? b - (Math.max(0, D - db) + 1) / r : b - 1;
      pieces.push({ a, b, da: db + r * (b - a), db });
      break;
    }
    const da = db + r * (b - a);
    pieces.push({ a, b, da, db });
    b = a;
    db = da;
  }
  pieces.reverse();

  // stretches on screen (d ≤ D), in time order
  const wins = [];
  let open = crossed ? pieces[0].a : null;
  for (const p of pieces) {
    const inA = p.da <= D;
    const inB = p.db <= D;
    if (inA && open === null) open = p.a;
    if (inA !== inB) {
      const tx = p.a + ((D - p.da) / (p.db - p.da)) * (p.b - p.a);
      if (inB) open = tx;
      else {
        wins.push({ from: open, to: tx, fade: false });
        open = null;
      }
    }
  }
  wins.push({ from: open ?? T, to: Infinity, fade: false });

  if (crossed) {
    if (wins.length > 1) wins.shift();
    else {
      // fade in where it last turns toward the line
      let from = T;
      for (let i = pieces.length - 1; i >= 0 && pieces[i].da >= pieces[i].db; i--) from = pieces[i].a;
      wins[0] = { from, to: Infinity, fade: true };
    }
  }
  return { sgn, wins };
}
