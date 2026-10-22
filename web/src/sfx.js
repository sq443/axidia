// Tiny synthesized tap sound via Web Audio (no audio files).
let ctx = null;
let enabled = true;

// Must be called from a user gesture (iOS requires it to unlock audio).
export function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC({ latencyHint: 'interactive' });
  }
  if (ctx.state === 'suspended') ctx.resume();
}

export function setEnabled(value) {
  enabled = value;
}

export function tap(strength = 1) {
  if (!enabled || !ctx) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(1800, t);
  osc.frequency.exponentialRampToValueAtTime(500, t + 0.04);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.22 * strength, t + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.07);
}
