// Offset calibration: clicks at a steady tempo; the player taps along by ear. The median of how
// late the taps land after each click (as heard) is the suggested offset.
import { audio } from './sfx.js';
import { click, heardAt } from './music.js';

const INTERVAL = 0.5; // s between clicks (120 BPM)
const KEEP = 12; // taps used for the estimate
export const MIN_TAPS = 6;

export class Calibrator {
  start() {
    const ctx = audio();
    if (!ctx) return;
    this.ctx = ctx;
    this.beats = []; // performance times (ms) at which clicks are heard
    this.diffs = [];
    this.count = 0;
    this.next = ctx.currentTime + 0.6;
    this.timer = setInterval(() => this.schedule(), 25);
    this.schedule();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  // Schedule clicks a little ahead so timer jitter never makes one late.
  schedule() {
    const { ctx } = this;
    while (this.next < ctx.currentTime + 0.15) {
      click(ctx, ctx.destination, this.next, this.count % 4 === 0 ? 1760 : 1320, 0.5);
      this.beats.push(heardAt(ctx, this.next));
      this.next += INTERVAL;
      this.count++;
    }
    if (this.beats.length > 8) this.beats.splice(0, this.beats.length - 8);
  }

  // A tap at performance time `perf` (ms). Taps far from any click are ignored.
  tap(perf) {
    if (!this.timer) return;
    let best = null;
    for (const b of this.beats) if (best === null || Math.abs(perf - b) < Math.abs(perf - best)) best = b;
    if (best === null || Math.abs(perf - best) > (INTERVAL * 1000) / 2) return;
    this.diffs.push(perf - best);
    if (this.diffs.length > KEEP) this.diffs.shift();
  }

  get taps() {
    return this.diffs.length;
  }

  // Median lateness (ms), or null until there are enough taps.
  get result() {
    if (this.diffs.length < MIN_TAPS) return null;
    const sorted = [...this.diffs].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
}
