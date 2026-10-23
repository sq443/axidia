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

// The shared AudioContext (null until unlock()).
export function audio() {
  return ctx;
}

// Decode an encoded audio file (ArrayBuffer) on `context`. Uses the callback form, which older
// Safari needs, and hands it a copy (decoding detaches the buffer). Some Safari versions call
// the error callback with null, so a plain error stands in for it.
export function decode(context, data) {
  return new Promise((resolve, reject) => {
    const fail = (e) => reject(e ?? new Error('decode failed'));
    const p = context.decodeAudioData(data.slice(0), resolve, fail);
    p?.catch?.(() => {}); // the failure also comes through the callback
  });
}

// A File / Blob's bytes (Blob.arrayBuffer is missing before iOS 14).
export function readBytes(file) {
  if (file.arrayBuffer) return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(file);
  });
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
