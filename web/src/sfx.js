// Tiny synthesized tap sound via Web Audio (no audio files), and the shared AudioContext.
let ctx = null;
let enabled = true;
let stale = false;

// Must be called from a user gesture (iOS requires it to unlock audio).
export function unlock() {
  if (ctx && stale) {
    // iOS can leave a context silent (while it still reports "running") after full screen or
    // app switches; a fresh one plays. Buffers are context-independent, so nothing is lost.
    ctx.close?.().catch(() => {});
    ctx = null;
  }
  stale = false;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC({ latencyHint: 'interactive' });
  }
  // Safari 16.4+: play as media, so the silent switch doesn't mute the game.
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch {
    // not supported
  }
  if (ctx.state !== 'running') ctx.resume?.().catch(() => {}); // "suspended" or iOS's "interrupted"
}

// The page went full screen / came back to the foreground: start the next unlock() on a new context.
export function refreshAudio() {
  if (ctx) stale = true;
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
