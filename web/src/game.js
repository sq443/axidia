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

const NOTE_W = 0.16; // note width, fraction of field width
const NOTE_H = 10; // px
const HIT_SLACK = 0.06; // extra horizontal tolerance on each side, fraction of field width
const LINE_Y = 0.8; // judgment line, fraction of screen height
const BASE_APPROACH = 3000; // ms from top to the line at speed 1.0
const COUNTDOWN = 1500; // ms before play resumes after pause

export class Game {
  constructor(canvas, { onEnd }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onEnd = onEnd;
    this.running = false;
    this.paused = false;
    this.frame = this.frame.bind(this);

    this.resize();
    window.addEventListener('resize', () => this.resize());
    canvas.addEventListener('pointerdown', (e) => this.onPointer(e));
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
    this.fieldW = Math.min(w - 24, h * 0.65);
    this.fieldX = (w - this.fieldW) / 2;
    this.lineY = Math.round(h * LINE_Y);
    if (this.running) this.draw(this.songTime(performance.now()), performance.now());
  }

  start(chart, { speed }) {
    this.chart = chart;
    this.notes = chart.notes.map((n) => ({ ...n, judged: null }));
    this.approach = BASE_APPROACH / speed;
    this.stats = { PERFECT: 0, GREAT: 0, GOOD: 0, MISS: 0, fast: 0, slow: 0 };
    this.points = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.head = 0; // first note that may still be unjudged
    this.effects = [];
    this.taps = [];
    this.lastJudge = null;

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
    if (!this.paused) this.sweepMisses(t);
    this.draw(t, now);

    if (!this.paused && t > this.chart.duration) {
      this.running = false;
      this.onEnd(this.result());
      return;
    }
    requestAnimationFrame(this.frame);
  }

  sweepMisses(t) {
    const notes = this.notes;
    while (this.head < notes.length) {
      const n = notes[this.head];
      if (!n.judged) {
        if (t - n.time <= WINDOW.GOOD) break;
        this.judge(n, 'MISS', 0);
      }
      this.head++;
    }
  }

  onPointer(e) {
    if (!this.running || this.paused) return;
    e.preventDefault();
    // event.timeStamp shares performance.now()'s clock in modern browsers and is closer to the real touch.
    const pnow = performance.now();
    const now = Math.abs(pnow - e.timeStamp) < 500 ? e.timeStamp : pnow;
    const t = now - this.startAt;
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const fx = (px - this.fieldX) / this.fieldW;
    this.taps.push({ px, at: pnow });

    let best = null;
    let bestCost = Infinity;
    for (let i = this.head; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.time - t > WINDOW.GOOD) break;
      if (n.judged) continue;
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
  }

  judge(n, j, dt) {
    n.judged = j;
    this.stats[j]++;
    this.points += WEIGHT[j];
    if (j === 'MISS') {
      this.combo = 0;
    } else {
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      if (j !== 'PERFECT') this.stats[dt < 0 ? 'fast' : 'slow']++;
      sfx.tap(j === 'PERFECT' ? 1 : 0.7);
    }
    const at = performance.now();
    this.lastJudge = { j, dt, at };
    this.effects.push({ x: n.x, j, at });
  }

  score() {
    const total = this.notes.length || 1;
    return Math.round((1e6 * this.points) / total);
  }

  result() {
    const total = this.notes.length;
    return {
      score: this.score(),
      stats: { ...this.stats },
      maxCombo: this.maxCombo,
      total,
      fullCombo: this.stats.MISS === 0,
      allPerfect: this.stats.PERFECT === total,
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
    const lastBeat = Math.floor(this.notes.length ? this.notes[this.notes.length - 1].time / beatMs : 0);
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

    // tap ripples
    this.taps = this.taps.filter((tp) => now - tp.at < 220);
    for (const tp of this.taps) {
      const k = (now - tp.at) / 220;
      ctx.fillStyle = `rgba(255,255,255,${0.12 * (1 - k)})`;
      const half = (fieldW * NOTE_W) / 2 + 8 * k;
      ctx.fillRect(tp.px - half, lineY - 40, half * 2, 40);
    }

    // notes (with connectors between simultaneous notes)
    const nw = fieldW * NOTE_W;
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
      ctx.fillStyle = '#f2f2f2';
      roundRect(ctx, cx - nw / 2, y - NOTE_H / 2, nw, NOTE_H, NOTE_H / 2);
    }

    // hit effects
    this.effects = this.effects.filter((ef) => now - ef.at < 320);
    for (const ef of this.effects) {
      const k = (now - ef.at) / 320;
      const cx = fieldX + ef.x * fieldW;
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = COLOR[ef.j];
      ctx.lineWidth = 2;
      if (ef.j === 'MISS') {
        ctx.fillStyle = COLOR.MISS;
        ctx.fillRect(cx - nw / 2, lineY - 1, nw, 2);
      } else {
        const ew = nw * (1 + 0.5 * k);
        const eh = NOTE_H + 26 * k;
        ctx.strokeRect(cx - ew / 2, lineY - eh / 2, ew, eh);
      }
      ctx.globalAlpha = 1;
    }

    this.drawHud(t, now);
  }

  drawHud(t, now) {
    const { ctx, w, h, fieldX, fieldW } = this;
    const cx = fieldX + fieldW / 2;
    const top = 18;

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
    ctx.fillText(String(this.score()).padStart(7, '0'), w - 16, top + 4);

    // combo + judgment
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const comboY = h * 0.42;
    if (this.combo >= 2) {
      ctx.fillStyle = 'rgba(242,242,242,0.9)';
      ctx.font = '200 56px system-ui, -apple-system, sans-serif';
      ctx.fillText(String(this.combo), cx, comboY);
      ctx.fillStyle = 'rgba(242,242,242,0.4)';
      ctx.font = '500 10px system-ui, -apple-system, sans-serif';
      ctx.fillText('C O M B O', cx, comboY + 38);
    }
    const lj = this.lastJudge;
    if (lj && now - lj.at < 450) {
      const k = (now - lj.at) / 450;
      const pop = 1 + 0.15 * Math.max(0, 1 - k * 4);
      ctx.globalAlpha = 1 - k * k;
      ctx.fillStyle = COLOR[lj.j];
      ctx.font = `500 ${Math.round(15 * pop)}px system-ui, -apple-system, sans-serif`;
      ctx.fillText(spaced(lj.j), cx, comboY + 68);
      if (lj.j === 'GREAT' || lj.j === 'GOOD') {
        ctx.font = '500 10px system-ui, -apple-system, sans-serif';
        ctx.fillStyle = lj.dt < 0 ? '#7cb8ff' : '#ffb27c';
        ctx.fillText(lj.dt < 0 ? 'FAST' : 'SLOW', cx, comboY + 88);
      }
      ctx.globalAlpha = 1;
    }

    // ready / countdown
    if (this.resumeAt) {
      ctx.fillStyle = 'rgba(11,11,12,0.5)';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#f2f2f2';
      ctx.font = '200 64px system-ui, -apple-system, sans-serif';
      ctx.fillText(String(Math.ceil((this.resumeAt - now) / (COUNTDOWN / 3))), cx, h * 0.42);
    } else if (t < -300 && !this.paused) {
      ctx.fillStyle = 'rgba(242,242,242,0.6)';
      ctx.font = '400 13px system-ui, -apple-system, sans-serif';
      ctx.fillText('R E A D Y', cx, h * 0.42);
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
