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
const GLOW_COLOR = { tap: 'rgba(242,242,242,0.75)', hold: 'rgba(242,242,242,0.75)', drag: 'rgba(255,216,77,0.8)' };

const NOTE_W = 0.11; // note width, fraction of field width
const NOTE_H = 10; // px
const DRAG_H = 7; // px
const HIT_SLACK = 0.04; // extra horizontal tolerance on each side, fraction of field width
const HOLD_SLACK = 0.07; // looser tolerance for keeping a hold
const RELEASE_GRACE = 150; // ms before a hold's end where letting go still counts
// Judgment lines, fraction of screen height. Notes for the bottom line fall from the top edge;
// notes for the top line rise from the bottom edge. Touches in each half of the screen play that half's line.
const LINE_Y = { top: 0.2, bottom: 0.8 };
const BASE_APPROACH = 3000; // ms from the screen edge to the line at speed 1.0
const COUNTDOWN = 1500; // ms before play resumes after pause

export class Game {
  constructor(canvas, { onEnd }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onEnd = onEnd;
    this.running = false;
    this.paused = false;
    this.pointers = new Map(); // pointerId -> { x (field fraction), side }
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
    if (this.running) this.draw(this.songTime(performance.now()), performance.now());
  }

  start(chart, { speed }) {
    this.chart = chart;
    this.notes = chart.notes.map((n) => ({ ...n, judged: null }));
    // Notes sharing a time are chords: they glow so they read as "hit together".
    for (let i = 1; i < this.notes.length; i++) {
      if (this.notes[i].time === this.notes[i - 1].time) this.notes[i].chord = this.notes[i - 1].chord = true;
    }
    // Each hold scores twice: its head and its tail.
    this.total = this.notes.reduce((s, n) => s + (n.type === 'hold' ? 2 : 1), 0);
    this.approach = BASE_APPROACH / speed;
    this.stats = { PERFECT: 0, GREAT: 0, GOOD: 0, MISS: 0, fast: 0, slow: 0 };
    this.points = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.head = 0; // first note that may still be unjudged
    this.holding = []; // holds whose head was hit and are being held
    this.fading = []; // holds that were missed or released, still drawn while they move away
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
      for (const p of this.pointers.values()) this.catchDrags(t, p.x, p.x, p.side);
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
    const side = e.clientY - rect.top < this.h / 2 ? 'top' : 'bottom';
    return { px, fx: (px - this.fieldX) / this.fieldW, side };
  }

  onDown(e) {
    e.preventDefault();
    const { px, fx, side } = this.fieldPos(e);
    this.pointers.set(e.pointerId, { x: fx, side });
    if (!this.running || this.paused) return;
    // event.timeStamp shares performance.now()'s clock in modern browsers and is closer to the real touch.
    const pnow = performance.now();
    const now = Math.abs(pnow - e.timeStamp) < 500 ? e.timeStamp : pnow;
    const t = now - this.startAt;
    this.taps.push({ px, side, at: pnow });
    this.catchDrags(t, fx, fx, side);

    let best = null;
    let bestCost = Infinity;
    for (let i = this.head; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.time - t > WINDOW.GOOD) break;
      if (n.judged || n.type === 'drag' || n.side !== side) continue;
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
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const { fx, side } = this.fieldPos(e);
    this.pointers.set(e.pointerId, { x: fx, side });
    // Check the whole swept segment so fast slides don't skip over drag notes between frames.
    if (this.running && !this.paused && side === prev.side) {
      this.catchDrags(performance.now() - this.startAt, Math.min(prev.x, fx), Math.max(prev.x, fx), side);
    }
  }

  // Mark drag notes near the line that a finger is touching (anywhere in [lo, hi] on that side).
  catchDrags(t, lo, hi, side) {
    const reach = NOTE_W / 2 + HIT_SLACK;
    for (let i = this.head; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.time - t > WINDOW.GREAT) break;
      if (n.type !== 'drag' || n.side !== side || n.judged || n.caught) continue;
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

  sweepMisses(t) {
    const notes = this.notes;
    while (this.head < notes.length) {
      const n = notes[this.head];
      if (!n.judged) {
        if (t - n.time <= WINDOW.GOOD) break;
        this.judge(n, 'MISS', 0);
        if (n.type === 'hold') {
          this.record('MISS', 0, n, 'hold'); // tail is lost with the head
          this.fading.push(n);
        }
      }
      this.head++;
    }
  }

  // ---- scoring ----

  judge(n, j, dt) {
    n.judged = j;
    this.record(j, dt, n, n.type);
  }

  record(j, dt, n, type) {
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
    this.effects.push({ x: n.x, side: n.side, j, type, at });
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

    // touch feedback: ripples for taps, a soft column under each finger that's down
    const nw = fieldW * NOTE_W;
    const column = (px, side, half) => {
      const y = lineY[side];
      ctx.fillRect(px - half, side === 'top' ? y : y - 36, half * 2, 36);
    };
    this.taps = this.taps.filter((tp) => now - tp.at < 220);
    for (const tp of this.taps) {
      const k = (now - tp.at) / 220;
      ctx.fillStyle = `rgba(255,255,255,${0.12 * (1 - k)})`;
      column(tp.px, tp.side, nw / 2 + 8 * k);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    for (const p of this.pointers.values()) column(fieldX + p.x * fieldW, p.side, nw / 2);

    // holds that broke: dim, keep moving away
    this.fading = this.fading.filter((n) => {
      const y = this.yAt(n.end, t, n.side);
      return y > -NOTE_H && y < h + NOTE_H;
    });
    for (const n of this.fading) this.drawHold(n, t, { alpha: 0.25 });

    // holds being held: head pinned to the line
    for (const n of this.holding) this.drawHold(n, t, { held: true, now });

    // incoming notes
    for (let i = this.head; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.time - t > this.approach) break;
      if (n.judged) continue;
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

    // hit effects
    this.effects = this.effects.filter((ef) => now - ef.at < 320);
    for (const ef of this.effects) {
      const k = (now - ef.at) / 320;
      const cx = fieldX + ef.x * fieldW;
      const y = lineY[ef.side];
      ctx.globalAlpha = 1 - k;
      if (ef.j === 'MISS') {
        ctx.fillStyle = COLOR.MISS;
        ctx.fillRect(cx - nw / 2, y - 1, nw, 2);
      } else {
        ctx.strokeStyle = ef.type === 'drag' ? NOTE_COLOR.drag : COLOR[ef.j];
        ctx.lineWidth = 2;
        const ew = nw * (1 + 0.5 * k);
        const eh = NOTE_H + 26 * k;
        ctx.strokeRect(cx - ew / 2, y - eh / 2, ew, eh);
      }
      ctx.globalAlpha = 1;
    }

    this.drawHud(t, now);
  }

  // Soft halo for chord notes. Caller resets shadowBlur after drawing.
  glow(n) {
    if (!n.chord) return;
    this.ctx.shadowColor = GLOW_COLOR[n.type];
    this.ctx.shadowBlur = 14;
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

    // combo + judgment, centered between the two lines
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const midY = h / 2;
    if (this.combo >= 2) {
      ctx.fillStyle = 'rgba(242,242,242,0.35)'; // faint so notes passing behind stay readable
      ctx.font = '200 48px system-ui, -apple-system, sans-serif';
      ctx.fillText(String(this.combo), cx, midY - 14);
      ctx.fillStyle = 'rgba(242,242,242,0.3)';
      ctx.font = '500 10px system-ui, -apple-system, sans-serif';
      ctx.fillText('C O M B O', cx, midY + 18);
    }
    const lj = this.lastJudge;
    if (lj && now - lj.at < 450) {
      const k = (now - lj.at) / 450;
      const pop = 1 + 0.15 * Math.max(0, 1 - k * 4);
      ctx.globalAlpha = 1 - k * k;
      ctx.fillStyle = COLOR[lj.j];
      ctx.font = `500 ${Math.round(14 * pop)}px system-ui, -apple-system, sans-serif`;
      ctx.fillText(spaced(lj.j), cx, midY + 40);
      if (lj.j === 'GREAT' || lj.j === 'GOOD') {
        ctx.font = '500 10px system-ui, -apple-system, sans-serif';
        ctx.fillStyle = lj.dt < 0 ? '#7cb8ff' : '#ffb27c';
        ctx.fillText(lj.dt < 0 ? 'FAST' : 'SLOW', cx, midY + 56);
      }
      ctx.globalAlpha = 1;
    }

    // ready / countdown
    if (this.resumeAt) {
      ctx.fillStyle = 'rgba(11,11,12,0.5)';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#f2f2f2';
      ctx.font = '200 64px system-ui, -apple-system, sans-serif';
      ctx.fillText(String(Math.ceil((this.resumeAt - now) / (COUNTDOWN / 3))), cx, midY);
    } else if (t < -300 && !this.paused) {
      ctx.fillStyle = 'rgba(242,242,242,0.6)';
      ctx.font = '400 13px system-ui, -apple-system, sans-serif';
      ctx.fillText('R E A D Y', cx, midY);
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
