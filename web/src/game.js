import * as sfx from './sfx.js';

// Timing windows (ms, ± from the exact note time). Outside GREAT is MISS.
export const WINDOW = { PERFECT: 45, GREAT: 135 };
const WEIGHT = { PERFECT: 1, GREAT: 0.7, MISS: 0 };
// Judgments are shown only through hit effects, so each has its own color and strength.
const COLOR = {
  PERFECT: '#ffd84d',
  GREAT: '#7cf5ff',
  MISS: '#ff5d6c',
};
const NOTE_COLOR = { tap: '#f2f2f2', hold: '#f2f2f2', drag: '#ffd84d', flick: '#f2f2f2', slide: '#b9a4ff' };
const CHORD_GLOW = 'rgba(170,236,255,0.95)'; // pale cyan halo on simultaneous notes

const NOTE_W = 0.11; // note width, fraction of field width
const NOTE_H = 10; // px
const DRAG_H = 7; // px
const HIT_SLACK = 0.04; // extra horizontal tolerance on each side, fraction of field width
const HOLD_SLACK = 0.07; // looser tolerance for keeping a hold
const RELEASE_GRACE = 150; // ms before a hold's end where letting go still counts
const FLICK_MOVE = 4; // px a touching finger must move in one event to count as a flick
const FLICK_REACH = 2.5; // the finger must be within this many flick-diamond sizes of the center
const SLIDE_REACH = 100; // px from a slide's start / end point that a finger may be (at most)
const SLIDE_REACH_SHARE = 0.6; // ...and at most this share of the slide's length (keeps short slides' ends apart)
const SLIDE_LEAD_BEATS = 1; // the slide's guide appears this many beats before it starts
const SLIDE_END = { PERFECT: 250, GREAT: 400 }; // ms, ± around a slide's end time
const MID_SPACING = 70; // px between a slide's invisible midpoints (at least 2 per slide)
const MID_REACH = 50; // px a finger must pass within to clear a midpoint
// Judgment lines, fraction of screen height. Notes for the bottom line fall from the top edge;
// notes for the top line rise from the bottom edge. Touches in each half of the screen play that half's line.
const LINE_Y = { top: 0.2, bottom: 0.8 };
const BASE_APPROACH = 3000; // ms from the screen edge to the line at speed 1.0
const COUNTDOWN = 1500; // ms before play resumes after pause
const EFFECT_MS = 420;

export class Game {
  constructor(canvas, { onEnd }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onEnd = onEnd;
    this.running = false;
    this.paused = false;
    // pointerId -> { x (field fraction), side, px, py, mx, my (last movement) }
    this.pointers = new Map();
    this.frame = this.frame.bind(this);

    this.resize();
    window.addEventListener('resize', () => this.resize());
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.pointers.delete(e.pointerId));
    window.addEventListener('pointercancel', (e) => this.pointers.delete(e.pointerId));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w;
    this.h = h;
    // Keep clear of the notch / home indicator in landscape.
    const css = getComputedStyle(document.documentElement);
    const inset = Math.max(
      parseFloat(css.getPropertyValue('--sal')) || 0,
      parseFloat(css.getPropertyValue('--sar')) || 0,
    );
    const margin = Math.max(24, inset + 8);
    this.fieldW = Math.min(w - margin * 2, h * 1.8);
    this.fieldX = (w - this.fieldW) / 2;
    this.lineY = { top: Math.round(h * LINE_Y.top), bottom: Math.round(h * LINE_Y.bottom) };
    this.flickSize = Math.min(28, h * 0.07); // half-diagonal of the flick diamond
    // Slide anchors: a 3×3 grid. Rows are the top line, the middle and the bottom line; L/R are as
    // far apart as the two lines, so the corners form a square.
    const gap = this.lineY.bottom - this.lineY.top;
    const cx = this.fieldX + this.fieldW / 2;
    const midY = (this.lineY.top + this.lineY.bottom) / 2;
    this.gridStep = gap / 2; // TL–ML; also the radius of arc segments
    this.layoutVer = (this.layoutVer || 0) + 1; // invalidates cached slide geometry
    this.anchors = {};
    for (const [row, y] of [['T', this.lineY.top], ['M', midY], ['B', this.lineY.bottom]]) {
      for (const [col, x] of [['L', cx - gap / 2], ['C', cx], ['R', cx + gap / 2]]) this.anchors[row + col] = { x, y };
    }
    if (this.running) this.draw(this.songTime(performance.now()), performance.now());
  }

  // offset: ms the game clock runs behind the audio (device latency compensation).
  // sync: optional () => performance time at which song time 0 is heard; the game clock follows it.
  // from: song time (ms) to start playing at (the chart editor's test play); notes before it are
  // expected to be removed from the chart already.
  start(chart, { speed, offset = 0, sync = null, from = 0 }) {
    this.chart = chart;
    this.offset = offset;
    this.sync = sync;
    // A slide runs through anchors (`path`), each segment straight or an arc (`bends`). It is judged
    // at two points, its start and its end; the pace in between is free, but the finger has to pass
    // its invisible midpoints in order. The slide itself is kept for drawing.
    this.slides = [];
    const notes = [];
    for (const n of chart.notes) {
      if (n.type !== 'slide') {
        notes.push({ ...n, judged: null });
        continue;
      }
      // done: furthest point (0..1 along the path) traced so far; finger: the pointer that took the
      // start; reached: index of the furthest midpoint passed
      const slide = { ...n, done: 0, finger: null, reached: -1 };
      slide.mids = this.makeMids(slide);
      slide.points = [0, 1].map((u) => ({ type: 'slide', side: 'free', slide, u, time: u ? n.end : n.time, judged: null }));
      this.slides.push(slide);
      notes.push(...slide.points);
    }
    this.notes = notes.sort((a, b) => a.time - b.time);
    // Notes sharing a time are chords: they glow so they read as "hit together".
    const chordable = (n) => n.type !== 'slide';
    for (let i = 0; i < notes.length; i++) {
      for (let j = i + 1; j < notes.length && notes[j].time === notes[i].time; j++) {
        if (chordable(notes[i]) && chordable(notes[j])) notes[i].chord = notes[j].chord = true;
      }
    }
    // Each hold scores twice: its head and its tail.
    this.total = this.notes.reduce((s, n) => s + (n.type === 'hold' ? 2 : 1), 0);
    this.approach = BASE_APPROACH / speed;
    this.stats = { PERFECT: 0, GREAT: 0, MISS: 0, fast: 0, slow: 0 };
    this.points = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.comboAt = 0;
    this.head = 0; // first note that may still be unjudged
    this.holding = []; // holds whose head was hit and are being held
    this.fading = []; // holds that were missed or released, still drawn while they move away
    this.effects = [];
    this.pointers.clear();

    const first = this.notes.length ? this.notes[0].time : 0;
    const lead = Math.max(1200, this.approach - (first - from) + 600);
    this.startAt = performance.now() + lead + offset - from; // songTime = now - startAt, from `from - lead`
    this.paused = false;
    this.resumeAt = 0;
    if (!this.running) {
      this.running = true;
      requestAnimationFrame(this.frame);
    }
  }

  stop() {
    this.running = false;
  }

  pause() {
    if (!this.running || (this.paused && !this.resumeAt)) return;
    if (!this.paused) this.pausedAt = performance.now();
    this.paused = true;
    this.resumeAt = 0;
  }

  resume() {
    if (this.running && this.paused) this.resumeAt = performance.now() + COUNTDOWN;
  }

  songTime(now) {
    return (this.paused ? this.pausedAt : now) - this.startAt;
  }

  frame(now) {
    if (!this.running) return;
    if (this.resumeAt && now >= this.resumeAt) {
      this.startAt += this.resumeAt - this.pausedAt;
      this.paused = false;
      this.resumeAt = 0;
    }
    if (this.sync && !this.paused) {
      // Follow the audio clock: snap if far off, otherwise ease out jitter.
      const diff = this.sync() + this.offset - this.startAt;
      this.startAt += Math.abs(diff) > 100 ? diff : diff * 0.05;
    }
    const t = this.songTime(now);
    if (!this.paused) {
      for (const p of this.pointers.values()) this.catchDrags(t, p.x, p.x, p.side);
      this.catchSlides(t);
      this.resolveCaught(t);
      this.updateHolds(t);
      this.sweepMisses(t);
    }
    this.draw(t, now);

    if (!this.paused && t > this.chart.duration) {
      this.running = false;
      this.onEnd(this.result());
      return;
    }
    requestAnimationFrame(this.frame);
  }

  // ---- input ----

  fieldPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const side = py < this.h / 2 ? 'top' : 'bottom';
    return { px, py, fx: (px - this.fieldX) / this.fieldW, side };
  }

  onDown(e) {
    e.preventDefault();
    const { px, py, fx, side } = this.fieldPos(e);
    this.pointers.set(e.pointerId, { x: fx, side, px, py, mx: 0, my: 0 });
    if (!this.running || this.paused) return;
    // event.timeStamp shares performance.now()'s clock in modern browsers and is closer to the real touch.
    const pnow = performance.now();
    const now = Math.abs(pnow - e.timeStamp) < 500 ? e.timeStamp : pnow;
    const t = now - this.startAt;
    this.catchDrags(t, fx, fx, side);
    this.catchSlides(t);

    let best = null;
    let bestCost = Infinity;
    for (let i = this.head; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.time - t > WINDOW.GREAT) break;
      if (n.judged || n.side !== side || (n.type !== 'tap' && n.type !== 'hold')) continue;
      const dt = t - n.time;
      const dx = Math.abs(fx - n.x);
      if (Math.abs(dt) > WINDOW.GREAT || dx > NOTE_W / 2 + HIT_SLACK) continue;
      const cost = Math.abs(dt) + dx * 200; // prefer timing, break ties by distance
      if (cost < bestCost) {
        bestCost = cost;
        best = { n, dt };
      }
    }
    if (!best) return;
    const adt = Math.abs(best.dt);
    const j = adt <= WINDOW.PERFECT ? 'PERFECT' : 'GREAT';
    this.judge(best.n, j, best.dt);
    if (best.n.type === 'hold') this.holding.push(best.n);
  }

  onMove(e) {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const { px, py, fx, side } = this.fieldPos(e);
    const pnow = performance.now();
    const dist = Math.hypot(px - prev.px, py - prev.py);
    const moved = dist >= 1 ? { mx: px - prev.px, my: py - prev.py } : { mx: prev.mx, my: prev.my };
    this.pointers.set(e.pointerId, { x: fx, side, px, py, ...moved });
    if (!this.running || this.paused) return;
    const t = pnow - this.startAt;
    // Check the whole swept segment so fast slides don't skip over drag notes between frames.
    if (side === prev.side) this.catchDrags(t, Math.min(prev.x, fx), Math.max(prev.x, fx), side);
    for (const sl of this.slides) {
      if (this.slideActive(sl, t) && sl.finger === e.pointerId) this.passMids(sl, prev.px, prev.py, px, py, moved);
    }
    this.catchSlides(t);
    // A finger moving in any direction near the center diamond flicks.
    if (dist >= FLICK_MOVE && (this.nearFlick(px, py) || this.nearFlick(prev.px, prev.py))) this.catchFlicks(t);
  }

  nearFlick(px, py) {
    return Math.abs(px - this.w / 2) + Math.abs(py - this.h / 2) <= this.flickSize * FLICK_REACH;
  }

  // Mark drag notes near the line that a finger is touching (anywhere in [lo, hi] on that side).
  catchDrags(t, lo, hi, side) {
    const reach = NOTE_W / 2 + HIT_SLACK;
    for (let i = this.head; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.time - t > WINDOW.GREAT) break;
      if (n.type !== 'drag' || n.side !== side || n.judged || n.caught) continue;
      if (t - n.time > WINDOW.GREAT) continue;
      if (hi >= n.x - reach && lo <= n.x + reach) n.caught = true;
    }
  }

  // Slides are judged loosely:
  // - Start: PERFECT if a finger is near the start point at any time from when the guide appears
  //   until the end point stops accepting. The first such finger becomes the slide's finger.
  // - Midpoints (invisible, not judged): the slide's finger must pass them in order; skipping one
  //   is fine (except the first), skipping two in a row stalls the slide (so the end will MISS).
  //   A midpoint only counts while the finger moves along the path's direction there; that and
  //   the order are what make the direction count. A finger that slips off the path
  //   keeps the slide and continues once it's back on it; if the finger is lifted, any finger that
  //   touches down where the slide left off takes over.
  // - End: the slide's finger near the end point, having passed the midpoints. ±SLIDE_END.PERFECT →
  //   PERFECT, up to ±SLIDE_END.GREAT → GREAT, otherwise MISS — whichever window the finger was
  //   ready in at any moment (so arriving early and staying, or briefly leaving, is still PERFECT).
  catchSlides(t) {
    for (const sl of this.slides) {
      if (!this.slideActive(sl, t)) continue;
      if (sl.finger !== null && !this.pointers.has(sl.finger)) sl.finger = null; // lifted
      const [start, end] = sl.points;

      if (!start.judged && !start.caught) {
        const a = this.slidePos(sl, 0);
        for (const [id, p] of this.pointers) {
          if (Math.hypot(p.px - a.x, p.py - a.y) > this.slideReach(sl)) continue;
          start.caught = true;
          sl.finger = id;
          break;
        }
      }

      if (sl.finger === null && start.caught) this.resumeSlide(sl);
      const finger = sl.finger !== null ? this.pointers.get(sl.finger) : null;
      if (finger) this.passMids(sl, finger.px, finger.py, finger.px, finger.py, finger);

      if (!end.judged && !end.caught) {
        const dt = t - end.time;
        if (dt >= -SLIDE_END.GREAT) {
          const b = this.slidePos(sl, 1);
          const ready =
            finger &&
            sl.reached >= sl.mids.length - 2 && // the last midpoint may be skipped too
            Math.hypot(finger.px - b.x, finger.py - b.y) <= this.slideReach(sl);
          if (ready && dt < -SLIDE_END.PERFECT) end.early = true;
          else if (ready && dt <= SLIDE_END.PERFECT) end.caught = true; // PERFECT on time
          else if (dt > SLIDE_END.PERFECT && (ready || end.early)) {
            this.judge(end, 'GREAT', ready ? dt : -SLIDE_END.GREAT); // late, or only ever early
          }
        }
      }

      // Light up the slide up to the furthest midpoint passed (purely visual).
      if (sl.reached >= 0) sl.done = Math.max(sl.done, sl.mids[sl.reached].u);
    }
  }

  // After the slide's finger was lifted: a finger within MID_REACH of the stretch of path where
  // the slide left off — from the last midpoint passed (or the start) up to two midpoints ahead
  // (or the end) — becomes the slide's finger.
  resumeSlide(sl) {
    const from = sl.reached >= 0 ? sl.mids[sl.reached].u : 0;
    const to = sl.reached < 0 ? sl.mids[0].u : sl.mids[sl.reached + 2]?.u ?? 1;
    const steps = 12;
    for (const [id, p] of this.pointers) {
      for (let i = 0; i <= steps; i++) {
        const q = this.slidePos(sl, from + ((to - from) * i) / steps);
        if (Math.hypot(p.px - q.x, p.py - q.y) <= MID_REACH) {
          sl.finger = id;
          return;
        }
      }
    }
  }

  // Start / end reach: SLIDE_REACH, but less on short slides so the two don't overlap.
  slideReach(sl) {
    return Math.min(SLIDE_REACH, this.pathGeo(sl).total * SLIDE_REACH_SHARE);
  }

  slideActive(sl, t) {
    return t >= sl.time - this.chart.beatMs * SLIDE_LEAD_BEATS && t <= sl.end + SLIDE_END.GREAT;
  }

  // Midpoints every ~MID_SPACING px along each segment, including each relay corner (so corners
  // can't be cut). A single-segment slide gets at least two.
  makeMids(sl) {
    const { segs, total } = this.pathGeo(sl);
    const lens = segs.map((g) => g.len);
    const mids = [];
    let acc = 0;
    lens.forEach((len, i) => {
      const n = Math.max(lens.length === 1 ? 3 : 2, Math.round(len / MID_SPACING));
      for (let j = 1; j <= n; j++) {
        if (i === lens.length - 1 && j === n) break; // that's the end point
        mids.push({ u: (acc + (len * j) / n) / total, passed: false });
      }
      acc += len;
    });
    return mids;
  }

  // Advance through the midpoints the finger's segment (x1, y1)-(x2, y2) passes, in order, allowing
  // a single skip (but not of the first one). The finger's movement { mx, my } must not go against
  // the path's direction at the midpoint (a finger that hasn't moved yet is fine).
  passMids(sl, x1, y1, x2, y2, { mx, my }) {
    for (let progressed = true; progressed; ) {
      progressed = false;
      for (const i of sl.reached < 0 ? [0] : [sl.reached + 1, sl.reached + 2]) {
        const m = sl.mids[i];
        if (!m) continue;
        const q = this.slidePos(sl, m.u);
        if (segDist(q, x1, y1, x2, y2) <= MID_REACH && mx * q.tx + my * q.ty >= 0) {
          m.passed = true;
          sl.reached = i;
          progressed = true;
          break;
        }
      }
    }
  }

  // A slide's segments: straight lines, or — where `bends[i]` is 'L' / 'R' — arcs of radius
  // gridStep bulging to the left / right of the direction of travel. Cached per layout.
  pathGeo(sl) {
    if (sl.geo?.ver === this.layoutVer) return sl.geo;
    const pts = sl.path.map((id) => this.anchors[id]);
    const segs = pts.slice(1).map((b, i) => makeSeg(pts[i], b, sl.bends?.[i], this.gridStep));
    sl.geo = { ver: this.layoutVer, pts, segs, total: segs.reduce((sum, g) => sum + g.len, 0) };
    return sl.geo;
  }

  // Point { x, y } and direction of travel { tx, ty } at fraction u (0..1) of the path's length.
  slidePos(sl, u) {
    const { segs, total } = this.pathGeo(sl);
    let d = Math.max(0, Math.min(1, u)) * total;
    for (let i = 0; i < segs.length; i++) {
      if (d <= segs[i].len || i === segs.length - 1) return segs[i].at(segs[i].len ? Math.min(1, d / segs[i].len) : 0);
      d -= segs[i].len;
    }
  }

  // Points along the path from the start up to fraction u, fine enough to draw arcs smoothly.
  pathPoints(sl, u = 1) {
    const { segs, total } = this.pathGeo(sl);
    let left = Math.max(0, Math.min(1, u)) * total;
    const out = [segs[0].at(0)];
    for (const g of segs) {
      if (left <= 0) break;
      const upto = Math.min(1, left / g.len);
      const steps = g.arc ? Math.max(2, Math.ceil((g.len * upto) / 6)) : 1;
      for (let j = 1; j <= steps; j++) out.push(g.at((upto * j) / steps));
      left -= g.len;
    }
    return out;
  }

  catchFlicks(t) {
    for (let i = this.head; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.time - t > WINDOW.GREAT) break;
      if (n.type === 'flick' && !n.judged && Math.abs(t - n.time) <= WINDOW.GREAT) n.caught = true;
    }
  }

  // Caught drags, flicks and slide checkpoints score PERFECT exactly when they reach their timing.
  resolveCaught(t) {
    for (let i = this.head; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.time > t) break;
      if (n.caught && !n.judged) this.judge(n, 'PERFECT', 0);
    }
  }

  updateHolds(t) {
    this.holding = this.holding.filter((n) => {
      if (t >= n.end) {
        this.record('PERFECT', 0, n, 'hold');
        return false;
      }
      let held = false;
      for (const p of this.pointers.values()) {
        if (p.side === n.side && Math.abs(p.x - n.x) <= NOTE_W / 2 + HOLD_SLACK) held = true;
      }
      if (held) return true;
      if (n.end - t <= RELEASE_GRACE) {
        this.record('PERFECT', 0, n, 'hold');
      } else {
        this.record('MISS', 0, n, 'hold');
        this.fading.push(n);
      }
      return false;
    });
  }

  // How long after its time a note can still be taken.
  lateLimit(n) {
    if (n.type !== 'slide') return WINDOW.GREAT;
    return n.u === 0 ? n.slide.end - n.time + SLIDE_END.GREAT : SLIDE_END.GREAT;
  }

  sweepMisses(t) {
    const notes = this.notes;
    // Every limit is at least WINDOW.GREAT, so only notes older than that can be missed.
    for (let i = this.head; i < notes.length && notes[i].time < t - WINDOW.GREAT; i++) {
      const n = notes[i];
      if (n.judged || t - n.time <= this.lateLimit(n)) continue;
      this.judge(n, 'MISS', 0);
      if (n.type === 'hold') {
        this.record('MISS', 0, n, 'hold'); // tail is lost with the head
        this.fading.push(n);
      }
    }
    while (this.head < notes.length && notes[this.head].judged) this.head++;
  }

  // ---- scoring ----

  judge(n, j, dt) {
    n.judged = j;
    if (n.type === 'slide' && j !== 'MISS') n.slide.done = Math.max(n.slide.done, n.u);
    this.record(j, dt, n, n.type);
  }

  record(j, dt, n, type) {
    this.stats[j]++;
    this.points += WEIGHT[j];
    const at = performance.now();
    if (j === 'MISS') {
      this.combo = 0;
    } else {
      this.combo++;
      this.comboAt = at;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      if (j !== 'PERFECT') this.stats[dt < 0 ? 'fast' : 'slow']++;
      sfx.tap((type === 'tap' || type === 'flick') && j === 'PERFECT' ? 1 : type === 'slide' ? 0.35 : 0.6);
    }
    const pos = type === 'slide' ? this.slidePos(n.slide, n.u) : null;
    this.effects.push({ x: n.x, side: n.side, px: pos?.x, py: pos?.y, j, type, at, sparks: sparks(j, type) });
  }

  score() {
    return Math.round((1e6 * this.points) / (this.total || 1));
  }

  result() {
    return {
      score: this.score(),
      stats: { ...this.stats },
      maxCombo: this.maxCombo,
      total: this.total,
      fullCombo: this.stats.MISS === 0,
      allPerfect: this.stats.PERFECT === this.total,
    };
  }

  // ---- rendering ----

  yAt(time, t, side) {
    const k = (time - t) / this.approach;
    const line = this.lineY[side];
    return side === 'bottom'
      ? line - k * (line + NOTE_H * 2)
      : line + k * (this.h - line + NOTE_H * 2);
  }

  draw(t, now) {
    const { ctx, w, h, fieldX, fieldW, lineY } = this;
    ctx.fillStyle = '#0b0b0c';
    ctx.fillRect(0, 0, w, h);

    // field edges
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(fieldX, 0, 1, h);
    ctx.fillRect(fieldX + fieldW - 1, 0, 1, h);

    // judgment lines
    ctx.fillStyle = 'rgba(242,242,242,0.85)';
    ctx.fillRect(fieldX, lineY.top - 1, fieldW, 2);
    ctx.fillRect(fieldX, lineY.bottom - 1, fieldW, 2);

    const nw = fieldW * NOTE_W;

    // slides (from one beat before they start) and flicks sit underneath everything that moves
    for (const sl of this.slides) {
      if (t >= sl.time - this.chart.beatMs * SLIDE_LEAD_BEATS && t <= sl.end + 250) this.drawSlide(sl, t);
    }
    for (let i = this.head; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.time - t > this.approach) break;
      if (n.type === 'flick' && !n.judged) this.drawFlick(n, t);
    }

    // holds that broke: dim, keep moving away
    this.fading = this.fading.filter((n) => {
      const y = this.yAt(n.end, t, n.side);
      return y > -NOTE_H && y < h + NOTE_H;
    });
    for (const n of this.fading) this.drawHold(n, t, { alpha: 0.25 });

    // holds being held: head pinned to the line
    for (const n of this.holding) this.drawHold(n, t, { held: true, now });

    // incoming line notes
    for (let i = this.head; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.time - t > this.approach) break;
      if (n.judged || n.type === 'flick' || n.type === 'slide') continue;
      if (n.type === 'hold') {
        this.drawHold(n, t, {});
        continue;
      }
      const y = this.yAt(n.time, t, n.side);
      const cx = fieldX + n.x * fieldW;
      const nh = n.type === 'drag' ? DRAG_H : NOTE_H;
      this.glow(n);
      ctx.fillStyle = NOTE_COLOR[n.type];
      roundRect(ctx, cx - nw / 2, y - nh / 2, nw, nh, nh / 2);
      ctx.shadowBlur = 0;
    }

    this.effects = this.effects.filter((ef) => now - ef.at < EFFECT_MS);
    for (const ef of this.effects) this.drawEffect(ef, now);

    this.drawHud(t, now);
  }

  // Pale cyan halo for chord notes. Caller resets shadowBlur after drawing.
  glow(n) {
    if (!n.chord) return;
    this.ctx.shadowColor = CHORD_GLOW;
    this.ctx.shadowBlur = 20;
  }

  // The flick diamond fades in at the center; a diamond guide zooms in from beyond the screen
  // edges and meets it exactly on time.
  drawFlick(n, t) {
    const { ctx, w, h } = this;
    const cx = w / 2;
    const cy = h / 2;
    const s = this.flickSize;
    const k = Math.max(0, (n.time - t) / this.approach); // 1 → just appeared, 0 → now
    const alpha = Math.min(1, (1 - k) / 0.5);

    const far = w / 2 + h / 2 + 20; // a diamond this big has its edges outside the screen
    ctx.globalAlpha = alpha * 0.6;
    ctx.strokeStyle = '#f2f2f2';
    ctx.lineWidth = 1.5;
    diamond(ctx, cx, cy, s + (far - s) * k);
    ctx.stroke();

    ctx.globalAlpha = alpha;
    ctx.lineWidth = 3;
    diamond(ctx, cx, cy, s);
    ctx.stroke();
    ctx.fillStyle = NOTE_COLOR.flick;
    diamond(ctx, cx, cy, s * 0.36);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // The whole slide fades in SLIDE_LEAD_BEATS beats before it starts. At the same moment a demo
  // dot traces the first beat's worth of the slide at the slide's pace (for one beat); then, while
  // the slide is being played, the demo dot runs again over the whole slide.
  drawSlide(sl, t) {
    const { ctx } = this;
    const beat = this.chart.beatMs;
    const { pts, total } = this.pathGeo(sl);
    const a = pts[0];
    const b = pts[pts.length - 1];
    const appear = sl.time - beat * SLIDE_LEAD_BEATS;
    const alpha = t > sl.end ? 1 - (t - sl.end) / 250 : Math.min(1, (t - appear) / (beat * 0.5));

    ctx.save();
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // track
    ctx.strokeStyle = 'rgba(185,164,255,0.28)';
    ctx.lineWidth = 20;
    polyline(ctx, this.pathPoints(sl));

    // direction chevrons, following the path's direction of travel
    ctx.strokeStyle = 'rgba(185,164,255,0.8)';
    ctx.lineWidth = 3;
    for (let d = 36; d < total - 20; d += 44) {
      const { x: cx, y: cy, tx: ux, ty: uy } = this.slidePos(sl, d / total);
      ctx.beginPath();
      ctx.moveTo(cx - ux * 8 - uy * 10, cy - uy * 8 + ux * 10);
      ctx.lineTo(cx + ux * 4, cy + uy * 4);
      ctx.lineTo(cx - ux * 8 + uy * 10, cy - uy * 8 - ux * 10);
      ctx.stroke();
    }

    // relay points
    ctx.fillStyle = 'rgba(185,164,255,0.9)';
    for (const p of pts.slice(1, -1)) {
      circle(ctx, p.x, p.y, 8);
      ctx.fill();
    }

    // traced so far
    if (sl.done > 0) {
      ctx.strokeStyle = NOTE_COLOR.slide;
      ctx.lineWidth = 20;
      polyline(ctx, this.pathPoints(sl, sl.done));
    }

    // start point, with a ring closing in on the start time; end point
    const k = Math.min(1, Math.max(0, (sl.time - t) / (beat * SLIDE_LEAD_BEATS)));
    ctx.strokeStyle = NOTE_COLOR.slide;
    ctx.lineWidth = 3;
    circle(ctx, a.x, a.y, 20 + 44 * k);
    ctx.stroke();
    ctx.fillStyle = NOTE_COLOR.slide;
    circle(ctx, a.x, a.y, 16);
    ctx.fill();
    ctx.fillStyle = '#f2f2f2';
    circle(ctx, b.x, b.y, 10);
    ctx.fill();

    // demo dot: a one-beat preview with the guide, then the whole slide in time with play
    let demo = -1;
    if (t >= appear && t < appear + beat) demo = (t - appear) / (sl.end - sl.time);
    else if (t >= sl.time && t <= sl.end) demo = (t - sl.time) / (sl.end - sl.time);
    if (demo >= 0 && demo <= 1) {
      const p = this.slidePos(sl, demo);
      ctx.shadowColor = CHORD_GLOW;
      ctx.shadowBlur = 20;
      ctx.fillStyle = '#ffffff';
      circle(ctx, p.x, p.y, 12);
      ctx.fill();
    }
    ctx.restore();
  }

  drawHold(n, t, { held = false, alpha = 1, now = 0 }) {
    const { ctx, fieldX, fieldW } = this;
    const nw = fieldW * NOTE_W;
    const cx = fieldX + n.x * fieldW;
    const line = this.lineY[n.side];
    const headY = held ? line : this.yAt(n.time, t, n.side);
    const tailY = this.yAt(n.end, t, n.side);
    const bw = nw * 0.56;

    ctx.globalAlpha = alpha;
    ctx.fillStyle = held ? 'rgba(242,242,242,0.42)' : 'rgba(242,242,242,0.22)';
    ctx.fillRect(cx - bw / 2, Math.min(headY, tailY), bw, Math.abs(headY - tailY));
    ctx.fillStyle = 'rgba(242,242,242,0.8)';
    ctx.fillRect(cx - bw / 2, tailY - 1, bw, 2); // tail cap
    if (!held && alpha === 1) this.glow(n);
    ctx.fillStyle = NOTE_COLOR.hold;
    roundRect(ctx, cx - nw / 2, headY - NOTE_H / 2, nw, NOTE_H, NOTE_H / 2);
    ctx.shadowBlur = 0;
    if (held) {
      // gentle pulse while held
      const k = (now / 400) % 1;
      ctx.globalAlpha = 0.5 * (1 - k);
      ctx.strokeStyle = COLOR.PERFECT;
      ctx.lineWidth = 2;
      const ew = nw * (1 + 0.3 * k);
      const eh = NOTE_H + 14 * k;
      ctx.strokeRect(cx - ew / 2, line - eh / 2, ew, eh);
    }
    ctx.globalAlpha = 1;
  }

  // Hit effects carry the judgment: PERFECT is a big yellow burst with a beam and sparks,
  // GREAT a smaller cyan burst, MISS a red crack on the line.
  drawEffect(ef, now) {
    const { ctx, fieldX, fieldW } = this;
    const k = (now - ef.at) / EFFECT_MS;
    const ease = 1 - (1 - k) * (1 - k); // fast out, slow settle
    const fade = 1 - k;
    const color = COLOR[ef.j];
    const strong = ef.j === 'PERFECT' ? 1 : 0.65;

    let cx;
    let cy;
    let inward; // direction toward the middle of the screen (+1 down, -1 up, 0 for flicks)
    if (ef.side === 'center') {
      cx = this.w / 2;
      cy = this.h / 2;
      inward = 0;
    } else {
      cx = fieldX + ef.x * fieldW;
      cy = this.lineY[ef.side];
      inward = ef.side === 'top' ? 1 : -1;
    }

    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;

    if (ef.type === 'slide') {
      // small burst on the slide checkpoint
      ctx.globalAlpha = fade;
      if (ef.j === 'MISS') {
        ctx.lineWidth = 3;
        line(ctx, ef.px - 10, ef.py - 10, ef.px + 10, ef.py + 10);
        line(ctx, ef.px - 10, ef.py + 10, ef.px + 10, ef.py - 10);
      } else {
        ctx.lineWidth = 3;
        circle(ctx, ef.px, ef.py, 16 + 32 * ease * strong);
        ctx.stroke();
        for (const sp of ef.sparks) {
          const dist = sp.speed * ease;
          diamond(ctx, ef.px + Math.cos(sp.angle) * dist, ef.py + Math.sin(sp.angle) * dist, sp.size * (1 - 0.5 * k));
          ctx.fill();
        }
      }
      ctx.restore();
      return;
    }

    if (ef.j === 'MISS') {
      const nw = fieldW * NOTE_W;
      ctx.globalAlpha = fade;
      if (inward === 0) {
        ctx.lineWidth = 2;
        diamond(ctx, cx, cy, this.flickSize * (1 - 0.3 * ease));
        ctx.stroke();
      } else {
        ctx.fillRect(cx - nw * 0.6, cy - 1.5, nw * 1.2, 3);
        ctx.fillRect(cx - 1, cy + inward * 4 * ease, 2, inward * 10); // drop
      }
      ctx.restore();
      return;
    }

    if (inward === 0) {
      // flick: diamond shockwave
      const s = this.flickSize;
      ctx.globalAlpha = 0.3 * fade;
      diamond(ctx, cx, cy, s * (1 + 0.6 * ease));
      ctx.fill();
      ctx.globalAlpha = fade;
      ctx.lineWidth = 3 * fade + 1;
      diamond(ctx, cx, cy, s * (1 + 2.2 * ease));
      ctx.stroke();
    } else {
      const nw = fieldW * NOTE_W;
      // flash on the line
      ctx.globalAlpha = 0.45 * strong * fade;
      ctx.fillRect(cx - nw / 2, cy - NOTE_H, nw, NOTE_H * 2);
      // beam toward the middle
      const len = 90 * strong * (1 - 0.4 * k);
      const g = ctx.createLinearGradient(0, cy, 0, cy + inward * len);
      g.addColorStop(0, color);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.globalAlpha = 0.35 * strong * fade;
      const bw = nw * (0.9 - 0.4 * k);
      ctx.fillRect(cx - bw / 2, Math.min(cy, cy + inward * len), bw, len);
      ctx.fillStyle = color;
      // expanding ring
      ctx.globalAlpha = fade;
      ctx.lineWidth = 1 + 2 * strong;
      const ew = nw * (1 + 0.8 * strong * ease);
      const eh = NOTE_H + 44 * strong * ease;
      ctx.strokeRect(cx - ew / 2, cy - eh / 2, ew, eh);
    }

    // sparks: small diamonds flying away from the hit
    ctx.globalAlpha = fade;
    for (const sp of ef.sparks) {
      const dist = sp.speed * ease;
      const dy = inward === 0 ? Math.sin(sp.angle) * dist : inward * Math.abs(Math.sin(sp.angle)) * dist;
      diamond(ctx, cx + Math.cos(sp.angle) * dist, cy + dy, sp.size * (1 - 0.5 * k));
      ctx.fill();
    }
    ctx.restore();
  }

  drawHud(t, now) {
    const { ctx, w, h, fieldX, fieldW } = this;
    const cx = fieldX + fieldW / 2;

    // progress
    const p = Math.min(1, Math.max(0, t / this.chart.duration));
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(0, 0, w, 2);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillRect(0, 0, w * p, 2);

    // score
    ctx.textBaseline = 'top';
    ctx.textAlign = 'right';
    ctx.fillStyle = '#f2f2f2';
    ctx.font = '300 20px system-ui, -apple-system, sans-serif';
    ctx.fillText(String(this.score()).padStart(7, '0'), fieldX + fieldW - 4, 14);

    // combo, top center above the top line; pops briefly on each hit
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const comboY = this.lineY.top / 2 - 6;
    if (this.combo >= 2) {
      const pop = 1 + 0.12 * Math.max(0, 1 - (now - this.comboAt) / 120);
      ctx.fillStyle = 'rgba(242,242,242,0.85)';
      ctx.font = `300 ${Math.round(26 * pop)}px system-ui, -apple-system, sans-serif`;
      ctx.fillText(String(this.combo), cx, comboY);
      ctx.fillStyle = 'rgba(242,242,242,0.35)';
      ctx.font = '500 9px system-ui, -apple-system, sans-serif';
      ctx.fillText('C O M B O', cx, comboY + 21);
    }

    // ready / countdown
    if (this.resumeAt) {
      ctx.fillStyle = 'rgba(11,11,12,0.5)';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#f2f2f2';
      ctx.font = '200 64px system-ui, -apple-system, sans-serif';
      ctx.fillText(String(Math.ceil((this.resumeAt - now) / (COUNTDOWN / 3))), cx, h / 2);
    } else if (t < -300 && !this.paused) {
      ctx.fillStyle = 'rgba(242,242,242,0.6)';
      ctx.font = '400 13px system-ui, -apple-system, sans-serif';
      ctx.fillText('R E A D Y', cx, h / 2);
    }
  }
}

function sparks(j, type) {
  const count = j === 'PERFECT' ? { flick: 10, slide: 3 }[type] ?? 6 : j === 'GREAT' ? 3 : 0;
  const radial = type === 'flick' || type === 'slide';
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({
      angle: radial ? (i / count) * Math.PI * 2 + Math.random() * 0.4 : Math.PI * (0.1 + 0.8 * Math.random()),
      speed: ({ flick: 70, slide: 36 }[type] ?? 34) + Math.random() * 30,
      size: 2 + Math.random() * 2,
    });
  }
  return out;
}

// One segment of a slide path from a to b: straight, or an arc of radius r bulging to the left
// ('L') or right ('R') of the direction of travel. Of the two circles of radius r through a and b,
// the one whose center is on the other side gives that bulge. Arcs only join diagonal neighbors
// (a 90° arc) or anchors two steps apart (a semicircle); anything else is drawn straight.
// `at(k)` gives the point and direction of travel at fraction k of the segment.
export function makeSeg(a, b, bend, r) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const c = Math.hypot(dx, dy);
  const tx = dx / c;
  const ty = dy / c;
  if (!bend || c < 1.3 * r || c > 2 * r + 0.5) {
    // straight (also the fallback for neighbors, or anchors too far apart for an arc)
    return { len: c, arc: false, at: (k) => ({ x: a.x + dx * k, y: a.y + dy * k, tx, ty }) };
  }
  const side = bend === 'R' ? 1 : -1;
  const nx = -ty * side; // unit normal toward the bulge (right of travel is (-ty, tx), y down)
  const ny = tx * side;
  const h = Math.sqrt(Math.max(0, r * r - (c * c) / 4));
  const cx = (a.x + b.x) / 2 - nx * h;
  const cy = (a.y + b.y) / 2 - ny * h;
  const a0 = Math.atan2(a.y - cy, a.x - cx);
  let sweep = Math.atan2(b.y - cy, b.x - cx) - a0;
  sweep = ((((sweep + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
  // go the way whose middle lies on the bulge side (this is what decides semicircles)
  if (Math.cos(a0 + sweep / 2) * nx + Math.sin(a0 + sweep / 2) * ny < 0) sweep -= Math.sign(sweep || 1) * 2 * Math.PI;
  const dir = Math.sign(sweep);
  return {
    len: r * Math.abs(sweep),
    arc: true,
    at: (k) => {
      const ang = a0 + sweep * k;
      return { x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang), tx: -Math.sin(ang) * dir, ty: Math.cos(ang) * dir };
    },
  };
}

// Distance from point p to the segment (x1, y1)-(x2, y2).
function segDist(p, x1, y1, x2, y2) {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const l2 = vx * vx + vy * vy;
  const k = l2 ? Math.max(0, Math.min(1, ((p.x - x1) * vx + (p.y - y1) * vy) / l2)) : 0;
  return Math.hypot(p.x - (x1 + vx * k), p.y - (y1 + vy * k));
}

function polyline(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
  ctx.stroke();
}

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function circle(ctx, cx, cy, r) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
}

function diamond(ctx, cx, cy, r) {
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r, cy);
  ctx.closePath();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}
