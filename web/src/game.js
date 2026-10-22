import * as sfx from './sfx.js';

// Timing windows (ms, ± from the exact note time).
export const WINDOW = { PERFECT: 45, GREAT: 90, GOOD: 135 };
const WEIGHT = { PERFECT: 1, GREAT: 0.7, GOOD: 0.3, MISS: 0 };
const COLOR = {
  PERFECT: '#7cf5ff',
  GREAT: '#f2f2f2',
  GOOD: '#9a9a9a',
  MISS: '#ff5d6c',
};
const NOTE_COLOR = { tap: '#f2f2f2', hold: '#f2f2f2', drag: '#ffd84d' };

const NOTE_W = 0.11; // note width, fraction of field width
const NOTE_H = 10; // px
const DRAG_H = 7; // px
const HIT_SLACK = 0.04; // extra horizontal tolerance on each side, fraction of field width
const HOLD_SLACK = 0.07; // looser tolerance for keeping a hold
const RELEASE_GRACE = 150; // ms before a hold's end where letting go still counts
const LINE_Y = 0.82; // judgment line, fraction of screen height
const BASE_APPROACH = 3000; // ms from top to the line at speed 1.0
const COUNTDOWN = 1500; // ms before play resumes after pause

export class Game {
  constructor(canvas, { onEnd }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onEnd = onEnd;
    this.running = false;
    this.paused = false;
    this.pointers = new Map(); // pointerId -> x (field fraction)
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
    this.lineY = Math.round(h * LINE_Y);
    if (this.running) this.draw(this.songTime(performance.now()), performance.now());
  }

  start(chart, { speed }) {
    this.chart = chart;
    this.notes = chart.notes.map((n) => ({ ...n, judged: null }));
    // Each hold scores twice: its head and its tail.
    this.total = this.notes.reduce((s, n) => s + (n.type === 'hold' ? 2 : 1), 0);
    this.approach = BASE_APPROACH / speed;
    this.stats = { PERFECT: 0, GREAT: 0, GOOD: 0, MISS: 0, fast: 0, slow: 0 };
    this.points = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.head = 0; // first note that may still be unjudged
    this.holding = []; // holds whose head was hit and are being held
    this.fading = []; // holds that were missed or released, still drawn while they fall away
    this.effects = [];
    this.taps = [];
    this.lastJudge = null;
    this.pointers.clear();

    const first = this.notes.length ? this.notes[0].time : 0;
    const lead = Math.max(1200, this.approach - first + 600);
    this.startAt = performance.now() + lead; // songTime = now - startAt
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
    const t = this.songTime(now);
    if (!this.paused) {
      for (const x of this.pointers.values()) this.catchDrags(t, x, x);
      this.resolveDrags(t);
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
    return { px, fx: (px - this.fieldX) / this.fieldW };
  }

  onDown(e) {
    e.preventDefault();
    const { px, fx } = this.fieldPos(e);
    this.pointers.set(e.pointerId, fx);
    if (!this.running || this.paused) return;
    // event.timeStamp shares performance.now()'s clock in modern browsers and is closer to the real touch.
    const pnow = performance.now();
    const now = Math.abs(pnow - e.timeStamp) < 500 ? e.timeStamp : pnow;
    const t = now - this.startAt;
    this.taps.push({ px, at: pnow });
    this.catchDrags(t, fx, fx);

    let best = null;
    let bestCost = Infinity;
    for (let i = this.head; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.time - t > WINDOW.GOOD) break;
      if (n.judged || n.type === 'drag') continue;
      const dt = t - n.time;
      const dx = Math.abs(fx - n.x);
      if (Math.abs(dt) > WINDOW.GOOD || dx > NOTE_W / 2 + HIT_SLACK) continue;
      const cost = Math.abs(dt) + dx * 200; // prefer timing, break ties by distance
      if (cost < bestCost) {
        bestCost = cost;
        best = { n, dt };
      }
    }
    if (!best) return;
    const adt = Math.abs(best.dt);
    const j = adt <= WINDOW.PERFECT ? 'PERFECT' : adt <= WINDOW.GREAT ? 'GREAT' : 'GOOD';
    this.judge(best.n, j, best.dt);
    if (best.n.type === 'hold') this.holding.push(best.n);
  }

  onMove(e) {
    if (!this.pointers.has(e.pointerId)) return;
    const prev = this.pointers.get(e.pointerId);
    const { fx } = this.fieldPos(e);
    this.pointers.set(e.pointerId, fx);
    // Check the whole swept segment so fast slides don't skip over drag notes between frames.
    if (this.running && !this.paused) {
      this.catchDrags(performance.now() - this.startAt, Math.min(prev, fx), Math.max(prev, fx));
    }
  }

  // Mark drag notes near the line that a finger is touching (anywhere in [lo, hi]).
  catchDrags(t, lo, hi) {
    const reach = NOTE_W / 2 + HIT_SLACK;
    for (let i = this.head; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.time - t > WINDOW.GREAT) break;
      if (n.type !== 'drag' || n.judged || n.caught) continue;
      if (t - n.time > WINDOW.GOOD) continue;
      if (hi >= n.x - reach && lo <= n.x + reach) n.caught = true;
    }
  }

  // Caught drags score PERFECT exactly when they reach the line.
  resolveDrags(t) {
    for (let i = this.head; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.time > t) break;
      if (n.type === 'drag' && n.caught && !n.judged) this.judge(n, 'PERFECT', 0);
    }
  }

  updateHolds(t) {
    this.holding = this.holding.filter((n) => {
      if (t >= n.end) {
        this.record('PERFECT', 0, n.x, 'hold');
        return false;
      }
      let held = false;
      for (const x of this.pointers.values()) {
        if (Math.abs(x - n.x) <= NOTE_W / 2 + HOLD_SLACK) held = true;
      }
      if (held) return true;
      if (n.end - t <= RELEASE_GRACE) {
        this.record('PERFECT', 0, n.x, 'hold');
      } else {
        this.record('MISS', 0, n.x, 'hold');
        this.fading.push(n);
      }
      return false;
    });
  }

  sweepMisses(t) {
    const notes = this.notes;
    while (this.head < notes.length) {
      const n = notes[this.head];
      if (!n.judged) {
        if (t - n.time <= WINDOW.GOOD) break;
        this.judge(n, 'MISS', 0);
        if (n.type === 'hold') {
          this.record('MISS', 0, n.x, 'hold'); // tail is lost with the head
          this.fading.push(n);
        }
      }
      this.head++;
    }
  }

  // ---- scoring ----

  judge(n, j, dt) {
    n.judged = j;
    this.record(j, dt, n.x, n.type);
  }

  record(j, dt, x, type) {
    this.stats[j]++;
    this.points += WEIGHT[j];
    if (j === 'MISS') {
      this.combo = 0;
    } else {
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      if (j !== 'PERFECT') this.stats[dt < 0 ? 'fast' : 'slow']++;
      sfx.tap(type === 'tap' && j === 'PERFECT' ? 1 : 0.6);
    }
    const at = performance.now();
    this.lastJudge = { j, dt, at };
    this.effects.push({ x, j, type, at });
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

  yAt(time, t) {
    return this.lineY - ((time - t) / this.approach) * (this.lineY + NOTE_H * 2);
  }

  draw(t, now) {
    const { ctx, w, h, fieldX, fieldW, lineY } = this;
    ctx.fillStyle = '#0b0b0c';
    ctx.fillRect(0, 0, w, h);

    // field edges
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(fieldX, 0, 1, h);
    ctx.fillRect(fieldX + fieldW - 1, 0, 1, h);

    // beat guides
    const beatMs = this.chart.beatMs;
    const lastBeat = Math.floor((this.chart.duration - 1200) / beatMs);
    const fromBeat = Math.max(0, Math.ceil(t / beatMs));
    const toBeat = Math.min(lastBeat, Math.floor((t + this.approach) / beatMs));
    for (let b = fromBeat; b <= toBeat; b++) {
      const y = this.yAt(b * beatMs, t);
      ctx.fillStyle = b % 4 === 0 ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.035)';
      ctx.fillRect(fieldX, Math.round(y), fieldW, 1);
    }

    // judgment line
    ctx.fillStyle = 'rgba(242,242,242,0.85)';
    ctx.fillRect(fieldX, lineY - 1, fieldW, 2);

    // touch feedback: ripples for taps, a soft column under each finger that's down
    const nw = fieldW * NOTE_W;
    this.taps = this.taps.filter((tp) => now - tp.at < 220);
    for (const tp of this.taps) {
      const k = (now - tp.at) / 220;
      ctx.fillStyle = `rgba(255,255,255,${0.12 * (1 - k)})`;
      const half = nw / 2 + 8 * k;
      ctx.fillRect(tp.px - half, lineY - 36, half * 2, 36);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    for (const x of this.pointers.values()) ctx.fillRect(fieldX + x * fieldW - nw / 2, lineY - 36, nw, 36);

    // holds that broke: dim, keep falling
    this.fading = this.fading.filter((n) => this.yAt(n.end, t) < h + NOTE_H);
    for (const n of this.fading) this.drawHold(n, t, { alpha: 0.25 });

    // holds being held: head pinned to the line
    for (const n of this.holding) this.drawHold(n, t, { held: true, now });

    // falling notes (with connectors between simultaneous notes)
    let prev = null;
    for (let i = this.head; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.time - t > this.approach) break;
      if (n.judged) continue;
      const y = this.yAt(n.time, t);
      const cx = fieldX + n.x * fieldW;
      if (prev && prev.time === n.time) {
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.fillRect(prev.cx, y - 0.5, cx - prev.cx, 1);
      }
      prev = { time: n.time, cx };
      if (n.type === 'hold') {
        this.drawHold(n, t, {});
      } else {
        const nh = n.type === 'drag' ? DRAG_H : NOTE_H;
        ctx.fillStyle = NOTE_COLOR[n.type];
        roundRect(ctx, cx - nw / 2, y - nh / 2, nw, nh, nh / 2);
      }
    }

    // hit effects
    this.effects = this.effects.filter((ef) => now - ef.at < 320);
    for (const ef of this.effects) {
      const k = (now - ef.at) / 320;
      const cx = fieldX + ef.x * fieldW;
      ctx.globalAlpha = 1 - k;
      if (ef.j === 'MISS') {
        ctx.fillStyle = COLOR.MISS;
        ctx.fillRect(cx - nw / 2, lineY - 1, nw, 2);
      } else {
        ctx.strokeStyle = ef.type === 'drag' ? NOTE_COLOR.drag : COLOR[ef.j];
        ctx.lineWidth = 2;
        const ew = nw * (1 + 0.5 * k);
        const eh = NOTE_H + 26 * k;
        ctx.strokeRect(cx - ew / 2, lineY - eh / 2, ew, eh);
      }
      ctx.globalAlpha = 1;
    }

    this.drawHud(t, now);
  }

  drawHold(n, t, { held = false, alpha = 1, now = 0 }) {
    const { ctx, fieldX, fieldW, lineY } = this;
    const nw = fieldW * NOTE_W;
    const cx = fieldX + n.x * fieldW;
    const headY = held ? lineY : this.yAt(n.time, t);
    const tailY = this.yAt(n.end, t);
    const bw = nw * 0.56;

    ctx.globalAlpha = alpha;
    ctx.fillStyle = held ? 'rgba(242,242,242,0.42)' : 'rgba(242,242,242,0.22)';
    ctx.fillRect(cx - bw / 2, tailY, bw, headY - tailY);
    ctx.fillStyle = 'rgba(242,242,242,0.8)';
    ctx.fillRect(cx - bw / 2, tailY - 1, bw, 2); // tail cap
    ctx.fillStyle = NOTE_COLOR.hold;
    roundRect(ctx, cx - nw / 2, headY - NOTE_H / 2, nw, NOTE_H, NOTE_H / 2);
    if (held) {
      // gentle pulse while held
      const k = ((now / 400) % 1);
      ctx.globalAlpha = 0.5 * (1 - k);
      ctx.strokeStyle = COLOR.PERFECT;
      ctx.lineWidth = 2;
      const ew = nw * (1 + 0.3 * k);
      const eh = NOTE_H + 14 * k;
      ctx.strokeRect(cx - ew / 2, lineY - eh / 2, ew, eh);
    }
    ctx.globalAlpha = 1;
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
    ctx.fillText(String(this.score()).padStart(7, '0'), fieldX + fieldW - 4, 18);

    // combo + judgment
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const comboY = h * 0.36;
    if (this.combo >= 2) {
      ctx.fillStyle = 'rgba(242,242,242,0.35)'; // faint so notes passing behind stay readable
      ctx.font = '200 48px system-ui, -apple-system, sans-serif';
      ctx.fillText(String(this.combo), cx, comboY);
      ctx.fillStyle = 'rgba(242,242,242,0.3)';
      ctx.font = '500 10px system-ui, -apple-system, sans-serif';
      ctx.fillText('C O M B O', cx, comboY + 32);
    }
    const lj = this.lastJudge;
    if (lj && now - lj.at < 450) {
      const k = (now - lj.at) / 450;
      const pop = 1 + 0.15 * Math.max(0, 1 - k * 4);
      ctx.globalAlpha = 1 - k * k;
      ctx.fillStyle = COLOR[lj.j];
      ctx.font = `500 ${Math.round(14 * pop)}px system-ui, -apple-system, sans-serif`;
      ctx.fillText(spaced(lj.j), cx, comboY + 56);
      if (lj.j === 'GREAT' || lj.j === 'GOOD') {
        ctx.font = '500 10px system-ui, -apple-system, sans-serif';
        ctx.fillStyle = lj.dt < 0 ? '#7cb8ff' : '#ffb27c';
        ctx.fillText(lj.dt < 0 ? 'FAST' : 'SLOW', cx, comboY + 74);
      }
      ctx.globalAlpha = 1;
    }

    // ready / countdown
    if (this.resumeAt) {
      ctx.fillStyle = 'rgba(11,11,12,0.5)';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#f2f2f2';
      ctx.font = '200 64px system-ui, -apple-system, sans-serif';
      ctx.fillText(String(Math.ceil((this.resumeAt - now) / (COUNTDOWN / 3))), cx, comboY);
    } else if (t < -300 && !this.paused) {
      ctx.fillStyle = 'rgba(242,242,242,0.6)';
      ctx.font = '400 13px system-ui, -apple-system, sans-serif';
      ctx.fillText('R E A D Y', cx, comboY);
    }
  }
}

function spaced(s) {
  return s.split('').join(' ');
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
