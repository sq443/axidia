// Music: a synthesized backing track that matches a chart's BPM and length, and the clock mapping
// that keeps the game in sync with what is actually heard.
import { audio } from './sfx.js';

// ---- clock mapping (AudioContext time ⇄ performance.now() as heard) ----

function outputLatency(ctx) {
  return ctx.outputLatency || ctx.baseLatency || 0;
}

// performance.now() time (ms) at which audio scheduled at context time `t` (s) is heard.
export function heardAt(ctx, t) {
  const ts = ctx.getOutputTimestamp?.();
  if (ts && ts.performanceTime > 0) return ts.performanceTime + (t - ts.contextTime) * 1000;
  return performance.now() + (t - ctx.currentTime + outputLatency(ctx)) * 1000;
}

// Context time (s) to schedule audio at so that it is heard at performance time `perf` (ms).
export function contextTimeFor(ctx, perf) {
  const ts = ctx.getOutputTimestamp?.();
  if (ts && ts.performanceTime > 0) return ts.contextTime + (perf - ts.performanceTime) / 1000;
  return ctx.currentTime + (perf - performance.now()) / 1000 - outputLatency(ctx);
}

// ---- playback ----

export class Music {
  constructor() {
    this.source = null;
    this.gain = null;
    this.zero = 0; // context time of the track's position 0
    this.vol = 1;
  }

  // 0..1; applies to what is playing too.
  get volume() {
    return this.vol;
  }

  set volume(v) {
    this.vol = v;
    if (this.gain) this.gain.gain.value = v;
  }

  // Play `buffer` so that track position `pos` (s) is heard at performance time `perf` (ms).
  playAt(buffer, pos, perf) {
    this.stop();
    const ctx = audio();
    if (!ctx || !buffer) return;
    this.zero = contextTimeFor(ctx, perf) - pos;
    let when = this.zero + Math.max(0, pos);
    let offset = Math.max(0, pos);
    if (when < ctx.currentTime) {
      offset += ctx.currentTime - when;
      when = ctx.currentTime;
    }
    if (offset >= buffer.duration) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    this.gain = ctx.createGain();
    this.gain.gain.value = this.vol;
    src.connect(this.gain).connect(ctx.destination);
    src.start(when, offset);
    this.source = src;
  }

  // Performance time (ms) at which track position 0 is (or would have been) heard.
  zeroPerf() {
    return heardAt(audio(), this.zero);
  }

  get playing() {
    return this.source !== null;
  }

  stop() {
    if (!this.source) return;
    try {
      this.source.stop();
    } catch {
      // already stopped
    }
    this.source.disconnect();
    this.gain?.disconnect();
    this.source = null;
    this.gain = null;
  }
}

// ---- the backing track ----

const tracks = new Map();

// The rendered track for a chart (cached; rendering takes a moment).
export function trackFor(chart) {
  const key = `${chart.bpm}:${chart.duration}`;
  if (!tracks.has(key)) tracks.set(key, renderTrack(chart.bpm, chart.duration / 1000));
  return tracks.get(key);
}

const CHORDS = [
  [220, 261.63, 329.63], // Am
  [174.61, 220, 261.63], // F
  [196, 261.63, 329.63], // C
  [196, 246.94, 293.66], // G
];
const BASS = [55, 43.65, 65.41, 49];

// Metronome-like loop: bar 0 is a count-in of clicks; then kick and a click on every beat, snare
// on 2 and 4, off-beat hats, an 8th-note bass and a chord stab per bar over Am–F–C–G; the beat
// the chart ends on (1.2s before the end) gets a final kick and crash.
// Rendering a whole song offline is slow on phones, so only the distinct parts are rendered (the
// count-in, the 4-bar loop with its decay tail, the ending) and then copied into place.
const RATE = 44100;
const TAIL = 1; // s of decay rendered after each part, mixed into what follows

async function renderTrack(bpm, seconds) {
  const beat = 60 / bpm;
  const bar = beat * 4;
  const finalBeat = Math.round((seconds - 1.2) / beat);

  const [countIn, loop, ending] = await Promise.all([
    renderPart(bar + TAIL, (ctx, out) => {
      for (let pos = 0; pos < 4; pos++) click(ctx, out, pos * beat, pos === 0 ? 1760 : 1320, 0.5);
    }),
    renderPart(bar * 4 + TAIL, (ctx, out, noise) => {
      for (let b = 0; b < 16; b++) {
        const t = b * beat;
        const harmony = Math.floor(b / 4);
        const pos = b % 4;
        kick(ctx, out, t);
        click(ctx, out, t, pos === 0 ? 1760 : 1320, 0.12);
        if (pos === 1 || pos === 3) hit(ctx, out, noise, t, 'bandpass', 1800, 0.3, 0.16);
        hit(ctx, out, noise, t + beat / 2, 'highpass', 7000, 0.12, 0.05);
        bass(ctx, out, t, BASS[harmony], beat / 2);
        bass(ctx, out, t + beat / 2, BASS[harmony] * 2, beat / 2);
        if (pos === 0) chord(ctx, out, t, CHORDS[harmony], beat * 1.5);
      }
    }),
    renderPart(2, (ctx, out, noise) => {
      kick(ctx, out, 0);
      hit(ctx, out, noise, 0, 'highpass', 4000, 0.35, 1.6);
      chord(ctx, out, 0, CHORDS[0], 1.6);
    }),
  ]);

  const length = Math.ceil(RATE * seconds);
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const track = new OAC(1, length, RATE).createBuffer(1, length, RATE);
  const data = track.getChannelData(0);
  const mix = (part, at, maxLen = part.length) => {
    const src = part.getChannelData(0);
    const from = Math.round(at * RATE);
    const n = Math.min(maxLen, src.length, length - from);
    for (let i = 0; i < n; i++) data[from + i] += src[i];
  };
  mix(countIn, 0);
  const loopEnd = finalBeat * beat; // the loop plays from bar 1 up to the final beat
  for (let at = bar; at < loopEnd; at += bar * 4) {
    // cut the last repetition at the final beat, keeping the decay of what was already playing
    const cut = Math.round((loopEnd - at) * RATE);
    mix(loop, at, cut < loop.length - TAIL * RATE ? cut : loop.length);
  }
  mix(ending, loopEnd);
  return track;
}

// Render `seconds` of audio drawn by `draw(ctx, out, noise)`.
function renderPart(seconds, draw) {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new OAC(1, Math.ceil(RATE * seconds), RATE);
  const out = ctx.createGain();
  out.gain.value = 0.55;
  out.connect(ctx.destination);
  draw(ctx, out, noiseBuffer(ctx));
  const done = ctx.startRendering();
  if (done?.then) return done;
  return new Promise((resolve) => (ctx.oncomplete = (e) => resolve(e.renderedBuffer)));
}

function noiseBuffer(ctx) {
  const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

function envelope(ctx, out, t, peak, decay) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  g.connect(out);
  return g;
}

function kick(ctx, out, t) {
  const o = ctx.createOscillator();
  o.frequency.setValueAtTime(150, t);
  o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
  o.connect(envelope(ctx, out, t, 0.9, 0.35));
  o.start(t);
  o.stop(t + 0.4);
}

// Short metronome click (also used by the offset calibration).
export function click(ctx, out, t, freq, volume) {
  const o = ctx.createOscillator();
  o.frequency.value = freq;
  o.connect(envelope(ctx, out, t, volume, 0.04));
  o.start(t);
  o.stop(t + 0.05);
}

function hit(ctx, out, noise, t, type, freq, volume, decay) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  src.connect(f).connect(envelope(ctx, out, t, volume, decay));
  src.start(t);
  src.stop(t + decay + 0.02);
}

function bass(ctx, out, t, freq, length) {
  const o = ctx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.value = freq;
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = 500;
  o.connect(f).connect(envelope(ctx, out, t, 0.16, length * 0.9));
  o.start(t);
  o.stop(t + length);
}

function chord(ctx, out, t, freqs, length) {
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = 1800;
  f.connect(envelope(ctx, out, t, 0.07, length));
  for (const freq of freqs) {
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = freq;
    o.connect(f);
    o.start(t);
    o.stop(t + length);
  }
}
