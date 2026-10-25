// AXIDIA chart editor. Charts are edited in beats (so BPM / OFFSET changes keep notes on the grid)
// and saved as the chart JSON that songs.js loads.
import { Game, makeSeg, SLIDE_LEAD_BEATS, DECOR_DEFAULT, DECOR_PROPS, decorState, strokeDecor } from './game.js';
import { normalizeChart } from './songs.js';
import { tempoMap } from './tempo.js';
import { generateChart } from './chart.js';
import { Music, trackFor, click } from './music.js';
import * as sfx from './sfx.js';
import { blockZoom, isIOS, isStandalone } from './touch.js';

const $ = (id) => document.getElementById(id);
const DRAFT_KEY = 'axidia.editor.draft';
const PREFS_KEY = 'axidia.editor.prefs';
const CLIP_KEY = 'axidia.editor.clipboard';
const GAME_KEY = 'axidia.v1';
const NOTE_W = 0.11; // as in the game
const ANCHORS = ['TL', 'TC', 'TR', 'ML', 'MC', 'MR', 'BL', 'BC', 'BR'];
const COLOR = { tap: '#f2f2f2', hold: '#f2f2f2', drag: '#ffd84d', flick: '#f2f2f2', slide: '#b9a4ff', decor: '#9aa0a6' };
const SELECT = '#7cf5ff';
const PEAK_MS = 5; // waveform resolution
const HISTORY = 200;

// ---- document ----

// bpms: BPM changes after beat 0, [{ beat, bpm }] sorted (doc.bpm holds from beat 0).
// scrolls: scroll speed changes, [{ beat, speed }] sorted (speed 1 before the first).
const newDoc = () => ({ title: '', artist: '', difficulty: 'NORMAL', bpm: 140, bpms: [], scrolls: [], offset: 0, bars: 32, notes: [] });
let doc = loadDraft() ?? newDoc();
let nextId = 1;
doc.notes.forEach((n) => (n.id = nextId++));

// Beats ↔ ms through the tempo map, rebuilt whenever BPM / OFFSET / the BPM changes differ.
let tempo = null;
let tempoKey = '';
function tm() {
  const key = `${doc.bpm}|${doc.offset}|${doc.bpms.map((c) => `${c.beat}:${c.bpm}`).join()}`;
  if (key !== tempoKey) {
    tempo = tempoMap(doc.bpm, doc.bpms, doc.offset);
    tempoKey = key;
  }
  return tempo;
}
const msOf = (beat) => tm().msOf(beat);
const beatOf = (ms) => tm().beatOf(ms);

function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY));
    return d && Array.isArray(d.notes) ? { ...newDoc(), ...d } : null;
  } catch {
    return null;
  }
}

let draftTimer = 0;
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...doc, notes: doc.notes.map(strip) }));
    } catch {
      // storage full / unavailable — the draft just isn't kept
    }
  }, 300);
}

const strip = ({ id, ...n }) => n;

// Decoration diamonds live in doc.notes as { type: 'decor', beat, endBeat, keys }: each key has
// `t`, beats after the first key (so moving / copying the item moves its keys), plus DECOR_PROPS and
// `ease` (how it changes toward the next key; absent = linear).
// beat / endBeat are the first / last key. The chart JSON keeps them apart, in `decor`.
const isDecor = (n) => n.type === 'decor';
const keyBeat = (n, k) => n.beat + k.t;

// Set the keys' absolute beats (in key order), keeping beat / endBeat / t in step.
function setKeyBeats(n, beats) {
  n.beat = beats[0];
  n.keys.forEach((k, i) => (k.t = round(beats[i] - beats[0], 6)));
  n.endBeat = n.beat + n.keys[n.keys.length - 1].t;
}
const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

// The chart JSON that songs.js loads.
function exportJSON() {
  const notes = doc.notes
    .filter((n) => !isDecor(n))
    .sort((a, b) => a.beat - b.beat)
    .map((n) => {
      const out = { type: n.type, beat: round(n.beat) };
      if (n.type === 'tap' || n.type === 'hold' || n.type === 'drag') Object.assign(out, { side: n.side, x: round(n.x, 3) });
      if (n.type === 'hold' || n.type === 'slide') out.endBeat = round(n.endBeat);
      if (n.type === 'slide') Object.assign(out, { path: n.path, bends: n.bends });
      return out;
    });
  const decor = doc.notes.filter(isDecor).map((n) => ({
    keys: n.keys.map((k) => {
      const out = { beat: round(keyBeat(n, k)) };
      for (const p of DECOR_PROPS) out[p] = round(k[p], 3);
      if (k.ease && k.ease !== 'linear') out.ease = k.ease;
      return out;
    }),
  }));
  const { title, artist, difficulty, bpm, offset } = doc;
  const bpms = doc.bpms.map((c) => ({ beat: round(c.beat), bpm: c.bpm }));
  const scrolls = doc.scrolls.map((c) => ({ beat: round(c.beat), speed: c.speed }));
  return {
    title,
    artist,
    difficulty,
    bpm,
    offset,
    ...(bpms.length ? { bpms } : {}),
    ...(scrolls.length ? { scrolls } : {}),
    notes,
    ...(decor.length ? { decor } : {}),
  };
}

// Chart JSON (beats or ms) → document.
function importJSON(json) {
  const d = { ...newDoc(), title: json.title ?? '', artist: json.artist ?? '', bpm: json.bpm ?? 140, offset: json.offset ?? 0 };
  if (DIFFS.includes(json.difficulty)) d.difficulty = json.difficulty;
  d.bpms = (json.bpms ?? []).filter((c) => c.beat > 0 && c.bpm > 0).map((c) => ({ beat: c.beat, bpm: c.bpm })).sort((a, b) => a.beat - b.beat);
  const map = tempoMap(d.bpm, d.bpms, d.offset);
  const toBeat = (ms, beat) => beat ?? map.beatOf(ms);
  d.scrolls = (json.scrolls ?? [])
    .map((c) => ({ beat: Math.max(0, toBeat(c.time, c.beat)), speed: c.speed }))
    .filter((c) => Number.isFinite(c.beat) && Number.isFinite(c.speed))
    .sort((a, b) => a.beat - b.beat);
  d.notes = (json.notes ?? []).map((n) => {
    const note = { type: n.type, beat: toBeat(n.time, n.beat) };
    if (n.type === 'tap' || n.type === 'hold' || n.type === 'drag') Object.assign(note, { side: n.side ?? 'bottom', x: n.x ?? 0.5 });
    if (n.type === 'hold' || n.type === 'slide') note.endBeat = toBeat(n.end, n.endBeat);
    if (n.type === 'slide') Object.assign(note, { path: n.path, bends: n.bends ?? n.path.slice(1).map(() => null) });
    return note;
  });
  for (const dec of json.decor ?? []) {
    const keys = (dec.keys ?? []).map((k) => ({ ...DECOR_DEFAULT, ...k, beat: toBeat(k.time, k.beat) })).sort((a, b) => a.beat - b.beat);
    if (!keys.length) continue;
    const n = { type: 'decor', keys: keys.map(({ beat, time, ...k }) => ({ ...k, t: 0 })) };
    setKeyBeats(n, keys.map((k) => k.beat));
    d.notes.push(n);
  }
  const last = d.notes.reduce((m, n) => Math.max(m, n.endBeat ?? n.beat), 0);
  d.bars = Math.max(4, Math.ceil((last + 1) / 4));
  return d;
}

function setDoc(d) {
  doc = d;
  doc.notes.forEach((n) => (n.id = nextId++));
  selection = new Set();
  undoStack.length = redoStack.length = 0;
  view.beat = 0;
  syncInputs();
  changed();
}

// ---- undo / redo ----

const undoStack = [];
const redoStack = [];
const snapshot = () =>
  JSON.stringify({ notes: doc.notes, bpm: doc.bpm, bpms: doc.bpms, scrolls: doc.scrolls, offset: doc.offset, bars: doc.bars });

// Call before every change.
function remember() {
  undoStack.push(snapshot());
  if (undoStack.length > HISTORY) undoStack.shift();
  redoStack.length = 0;
}

function restore(from, to) {
  if (!from.length) return;
  to.push(snapshot());
  const s = JSON.parse(from.pop());
  Object.assign(doc, s);
  const ids = new Set([...selection].map((n) => n.id));
  selection = new Set(doc.notes.filter((n) => ids.has(n.id)));
  syncInputs();
  changed();
}

const undo = () => restore(undoStack, redoStack);
const redo = () => restore(redoStack, undoStack);

// ---- editor preferences (music volume, test play speed) ----

// Test play settings start from the game's own; testOffset is device latency compensation, not the
// chart's OFFSET (where beat 0 is in the audio).
const prefs = { volume: 1, speed: null, auto: false, testSfx: null, testOffset: null, ...readJSON(PREFS_KEY) };
prefs.speed ??= readJSON(GAME_KEY).speed ?? 3;
prefs.testSfx ??= readJSON(GAME_KEY).sfx ?? true;
prefs.testOffset ??= readJSON(GAME_KEY).offset ?? 0;

function readJSON(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) || {};
  } catch {
    return {};
  }
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // not kept
  }
}

// ---- view state ----

const DIFFS = ['EASY', 'NORMAL', 'HARD'];
const SNAPS = [1, 2, 3, 4, 6, 8, 12, 16];
const view = { beat: 0, pxPerBeat: 90, snap: 4, xsnap: true, tool: 'tap' };
let selection = new Set(); // selected notes
const only = () => (selection.size === 1 ? [...selection][0] : null);

const canvas = $('timeline');
const ctx = canvas.getContext('2d');
const octx = $('overview').getContext('2d');
let OW = 0;
let OH = 0;
let W = 0;
let H = 0;
let cols = {};
let playY = 0;

function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = canvas.clientWidth;
  H = canvas.clientHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const gap = 10;
  const ruler = 96;
  const flick = 56;
  const slide = 150;
  const decor = 96;
  const field = Math.max(110, Math.min(380, (W - ruler - flick - slide - decor - gap * 6) / 2));
  let x = 0;
  const col = (w) => {
    const c = { x, w };
    x += w + gap;
    return c;
  };
  cols = { ruler: col(ruler), top: col(field), bottom: col(field), flick: col(flick), slide: col(slide), decor: col(decor) };
  playY = H - 90;
  const ov = $('overview');
  OW = ov.clientWidth;
  OH = ov.clientHeight;
  ov.width = Math.round(OW * dpr);
  ov.height = Math.round(OH * dpr);
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

const yOf = (beat) => playY - (beat - view.beat) * view.pxPerBeat;
const beatAt = (y) => view.beat + (playY - y) / view.pxPerBeat;
const snapBeat = (beat) => Math.round(beat * view.snap) / view.snap;
const snapX = (x) => {
  const v = view.xsnap ? Math.round(x * 20) / 20 : x;
  return Math.min(0.95, Math.max(0.05, v));
};
const songMs = () => (audio ? audio.duration * 1000 : msOf(doc.bars * 4) + 1200);
const lengthBeats = () => beatOf(songMs());

function colAt(px) {
  for (const [name, c] of Object.entries(cols)) if (px >= c.x && px <= c.x + c.w) return name;
  return null;
}

// ---- drawing ----

let drawQueued = false;
function draw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    render();
  });
}

function render() {
  ctx.fillStyle = '#0b0b0c';
  ctx.fillRect(0, 0, W, H);
  const b0 = beatAt(H);
  const b1 = beatAt(0);

  // column backgrounds
  for (const name of ['top', 'bottom', 'flick', 'slide', 'decor']) {
    const c = cols[name];
    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    ctx.fillRect(c.x, 0, c.w, H);
  }
  // x guides on the fields
  if (view.xsnap) {
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    for (const name of ['top', 'bottom']) {
      const c = cols[name];
      for (let i = 1; i < 20; i++) ctx.fillRect(c.x + (c.w * i) / 20, 0, 1, H);
    }
  }

  // song range
  const endY = yOf(lengthBeats());
  if (endY > 0) {
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(cols.top.x, 0, W - cols.top.x, endY);
  }

  drawWaveform(b0, b1);

  // beat grid
  const left = cols.top.x;
  const sub = view.pxPerBeat / view.snap >= 6 ? view.snap : 1;
  for (let k = Math.floor(b0 * sub); k <= Math.ceil(b1 * sub); k++) {
    const beat = k / sub;
    const y = Math.round(yOf(beat)) + 0.5;
    const bar = Number.isInteger(beat) && beat % 4 === 0;
    ctx.fillStyle = bar ? 'rgba(255,255,255,0.35)' : Number.isInteger(beat) ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.05)';
    ctx.fillRect(left, y, W - left, 1);
    if (bar) {
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.font = '500 11px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(beat / 4 + 1), 6, y);
    }
  }

  // tempo: where each BPM holds from
  for (const sg of tm().segs) {
    if (sg.beat < b0 - 1 || sg.beat > b1 + 1) continue;
    const y = Math.round(yOf(sg.beat)) + 0.5;
    ctx.fillStyle = sg.beat > 0 ? 'rgba(255,159,67,0.8)' : 'rgba(255,159,67,0.35)';
    ctx.fillRect(left, y - 0.5, W - left, 2);
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = '#ff9f43';
    ctx.fillText(`BPM ${round(sg.bpm, 2)}`, cols.ruler.x + cols.ruler.w - 2, y - 2);
  }

  // scroll speed: a strip along the ruler wherever it isn't 1 (red: backwards), and each change
  const strip = (v) => (v < 0 ? '#ff5d6c' : v > 1 ? '#5be37d' : '#7cf5ff');
  doc.scrolls.forEach((c, i) => {
    const next = doc.scrolls[i + 1]?.beat ?? Infinity;
    if (next < b0 - 1 || c.beat > b1 + 1) return;
    const y = Math.round(yOf(c.beat)) + 0.5;
    if (c.speed !== 1) {
      const ye = Math.max(0, yOf(Math.min(next, b1 + 1)));
      ctx.fillStyle = strip(c.speed);
      ctx.globalAlpha = 0.55;
      ctx.fillRect(cols.ruler.x + cols.ruler.w - 4, ye, 3, y - ye);
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = strip(c.speed);
    ctx.globalAlpha = 0.7;
    ctx.fillRect(left, y - 0.5, W - left, 1);
    ctx.globalAlpha = 1;
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(`SCROLL ×${round(c.speed, 3)}`, cols.ruler.x + cols.ruler.w - 6, y + 2);
  });

  // notes
  const visible = (n) => (n.endBeat ?? n.beat) >= b0 - 1 && n.beat <= b1 + 1;
  for (const n of doc.notes) if (visible(n) && n.type === 'slide') drawSlideNote(n);
  for (const n of doc.notes) if (visible(n) && n.type !== 'slide' && !isDecor(n)) drawNote(n);
  const lanes = decorLanes();
  for (const n of doc.notes) if (visible(n) && isDecor(n)) drawDecorItem(n, lanes);

  // hover ghost
  if (hover && !drag && view.tool !== 'select') drawGhost();

  // selection box
  if (drag?.kind === 'box' && drag.moved) {
    const x = Math.min(drag.start.px, drag.end.px);
    const y = Math.min(drag.start.py, drag.end.py);
    ctx.fillStyle = 'rgba(124,245,255,0.08)';
    ctx.fillRect(x, y, Math.abs(drag.end.px - drag.start.px), Math.abs(drag.end.py - drag.start.py));
    ctx.strokeStyle = 'rgba(124,245,255,0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(drag.end.px - drag.start.px), Math.abs(drag.end.py - drag.start.py));
  }

  // headers
  ctx.fillStyle = 'rgba(11,11,12,0.85)';
  ctx.fillRect(0, 0, W, 24);
  ctx.font = '500 10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#8a8a8e';
  const label = { ruler: 'BAR / WAVE', top: 'TOP LINE', bottom: 'BOTTOM LINE', flick: 'FLICK', slide: 'SLIDE', decor: 'DECOR' };
  for (const [name, c] of Object.entries(cols)) ctx.fillText(label[name], c.x + c.w / 2, 12);

  // playhead
  ctx.fillStyle = '#ff5d6c';
  ctx.fillRect(0, playY - 1, W, 2);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.font = '500 11px system-ui, sans-serif';
  ctx.fillText(formatBeat(view.beat), W - 6, playY - 4);
  drawOverview(b0, b1);
  drawPreview();
  updateTransport();
}

// ---- overview bar: the whole song, bottom (start) to top (end) ----

const OV_PAD = 8;
const overviewBeats = () => Math.max(lengthBeats(), 4);
const ovY = (beat) => OH - OV_PAD - (beat / overviewBeats()) * (OH - OV_PAD * 2);
const ovBeat = (y) => ((OH - OV_PAD - y) / (OH - OV_PAD * 2)) * overviewBeats();

function drawOverview(b0, b1) {
  const c = octx;
  c.fillStyle = '#101012';
  c.fillRect(0, 0, OW, OH);
  // waveform, faint
  if (peaks) {
    c.fillStyle = 'rgba(124,245,255,0.16)';
    for (let y = 0; y < OH; y += 2) {
      const t1 = msOf(ovBeat(y));
      const t0 = msOf(ovBeat(y + 2));
      let m = 0;
      for (let i = Math.max(0, Math.floor(t0 / PEAK_MS)); i <= Math.min(peaks.length - 1, Math.floor(t1 / PEAK_MS)); i++) {
        m = Math.max(m, peaks[i]);
      }
      if (m > 0.02) c.fillRect(OW / 2 - (m * OW) / 2, y, m * OW, 2);
    }
  }
  // notes: TOP / BOTTOM line notes on the left / middle, flicks and slides on the right
  const laneX = { top: 5, bottom: 16, center: 28, free: 28 };
  for (const n of doc.notes) {
    if (isDecor(n)) {
      c.fillStyle = 'rgba(154,160,166,0.5)';
      c.fillRect(35, ovY(n.endBeat), 2, Math.max(1, ovY(n.beat) - ovY(n.endBeat)));
      continue;
    }
    const side = n.type === 'flick' ? 'center' : n.type === 'slide' ? 'free' : n.side;
    const y = ovY(n.beat);
    c.fillStyle = COLOR[n.type];
    if (n.endBeat !== undefined) {
      const ye = ovY(n.endBeat);
      c.globalAlpha = 0.6;
      c.fillRect(laneX[side] + 3, ye, 2, Math.max(1, y - ye));
      c.globalAlpha = 1;
    }
    c.fillRect(laneX[side], y - 1, 8, 2);
  }
  // what the timeline shows, and the playhead
  const y1 = ovY(b1);
  const y0 = ovY(b0);
  c.fillStyle = 'rgba(255,255,255,0.08)';
  c.fillRect(0, y1, OW, y0 - y1);
  c.strokeStyle = 'rgba(255,255,255,0.35)';
  c.lineWidth = 1;
  c.strokeRect(0.5, y1 + 0.5, OW - 1, y0 - y1 - 1);
  c.fillStyle = '#ff5d6c';
  c.fillRect(0, ovY(view.beat) - 1, OW, 2);
}

// Click / drag on the overview to jump; playback carries on from there.
let ovDrag = null;
$('overview').addEventListener('pointerdown', (e) => {
  $('overview').setPointerCapture(e.pointerId);
  ovDrag = { resume: !!playing };
  stopPlay();
  seekOverview(e);
});
$('overview').addEventListener('pointermove', (e) => ovDrag && seekOverview(e));
$('overview').addEventListener('pointerup', () => {
  if (ovDrag?.resume) play();
  ovDrag = null;
});

function seekOverview(e) {
  const r = $('overview').getBoundingClientRect();
  setViewBeat(ovBeat(e.clientY - r.top));
}

let peaks = null; // max |sample| per PEAK_MS
function drawWaveform(b0, b1) {
  const c = cols.ruler;
  if (!peaks) return;
  const mid = c.x + 26 + (c.w - 30) / 2;
  const half = (c.w - 32) / 2;
  ctx.fillStyle = 'rgba(124,245,255,0.45)';
  for (let y = 0; y < H; y += 2) {
    const t1 = msOf(beatAt(y));
    const t0 = msOf(beatAt(y + 2));
    let m = 0;
    for (let i = Math.max(0, Math.floor(t0 / PEAK_MS)); i <= Math.min(peaks.length - 1, Math.floor(t1 / PEAK_MS)); i++) {
      m = Math.max(m, peaks[i]);
    }
    if (m > 0.01) ctx.fillRect(mid - m * half, y, m * half * 2, 2);
  }
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function diamond(cx, cy, r) {
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r, cy);
  ctx.closePath();
}

function drawNote(n, ghost = false) {
  const y = yOf(n.beat);
  ctx.globalAlpha = ghost ? 0.35 : 1;
  const sel = selection.has(n);
  if (n.type === 'flick') {
    const c = cols.flick;
    diamond(c.x + c.w / 2, y, 10);
    ctx.strokeStyle = sel ? SELECT : COLOR.flick;
    ctx.lineWidth = 2.5;
    ctx.stroke();
  } else {
    const c = cols[n.side];
    const w = NOTE_W * c.w;
    const cx = c.x + n.x * c.w;
    if (n.type === 'hold') {
      const ye = yOf(n.endBeat);
      ctx.fillStyle = sel ? 'rgba(124,245,255,0.35)' : 'rgba(242,242,242,0.25)';
      ctx.fillRect(cx - w * 0.28, ye, w * 0.56, y - ye);
      ctx.fillStyle = sel ? SELECT : 'rgba(242,242,242,0.8)';
      ctx.fillRect(cx - w * 0.28, ye - 1, w * 0.56, 3);
    }
    const h = n.type === 'drag' ? 6 : 9;
    roundRect(cx - w / 2, y - h / 2, w, h, h / 2);
    ctx.fillStyle = COLOR[n.type];
    ctx.fill();
    if (sel) {
      ctx.strokeStyle = SELECT;
      ctx.lineWidth = 2;
      roundRect(cx - w / 2 - 3, y - h / 2 - 3, w + 6, h + 6, h / 2 + 3);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

function drawSlideNote(n, ghost = false) {
  const c = cols.slide;
  const y = yOf(n.beat);
  const ye = yOf(n.endBeat);
  const sel = selection.has(n);
  ctx.globalAlpha = ghost ? 0.35 : 1;
  // where the slide's guide is on screen in the game (SLIDE_LEAD_BEATS before it starts)
  const yg = yOf(n.beat - SLIDE_LEAD_BEATS);
  ctx.fillStyle = 'rgba(185,164,255,0.08)';
  ctx.fillRect(c.x + 2, y, c.w - 4, yg - y);
  ctx.strokeStyle = 'rgba(185,164,255,0.3)';
  ctx.setLineDash([3, 4]);
  ctx.strokeRect(c.x + 2.5, y + 0.5, c.w - 5, yg - y - 1);
  ctx.setLineDash([]);
  ctx.fillStyle = sel ? 'rgba(124,245,255,0.5)' : 'rgba(185,164,255,0.45)';
  ctx.fillRect(c.x + 10, ye, 8, y - ye);
  ctx.fillStyle = sel ? SELECT : COLOR.slide;
  ctx.fillRect(c.x + 6, y - 2, 16, 4);
  ctx.fillRect(c.x + 6, ye - 1, 16, 3);
  drawPathIcon(n.path, n.bends, c.x + 30 + 44, y - 46, 40, sel);
  ctx.globalAlpha = 1;
}

// A slide's path drawn on a small 3×3 grid (box `size` wide, centered at cx, cy).
function drawPathIcon(path, bends, cx, cy, size, sel) {
  const g = size / 2;
  const p = (a) => ({ x: cx + ('LCR'.indexOf(a[1]) - 1) * g, y: cy + ('TMB'.indexOf(a[0]) - 1) * g });
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  for (const a of ANCHORS) {
    const q = p(a);
    ctx.fillRect(q.x - 1, q.y - 1, 2, 2);
  }
  ctx.strokeStyle = sel ? SELECT : COLOR.slide;
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  path.slice(1).forEach((b, i) => {
    const seg = makeSeg(p(path[i]), p(b), bends?.[i], g);
    const steps = seg.arc ? 12 : 1;
    for (let k = 0; k <= steps; k++) {
      const q = seg.at(k / steps);
      if (i === 0 && k === 0) ctx.moveTo(q.x, q.y);
      else ctx.lineTo(q.x, q.y);
    }
  });
  ctx.stroke();
  const s = p(path[0]);
  ctx.fillStyle = sel ? SELECT : COLOR.slide;
  ctx.beginPath();
  ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
  ctx.fill();
  const e = p(path[path.length - 1]);
  ctx.fillStyle = '#f2f2f2';
  ctx.beginPath();
  ctx.arc(e.x, e.y, 3, 0, Math.PI * 2);
  ctx.fill();
}

// Decorations share the DECOR column in sub-lanes, so ones that overlap in time sit side by side.
function decorLanes() {
  const items = doc.notes.filter(isDecor).sort((a, b) => a.beat - b.beat || a.id - b.id);
  const ends = [];
  const lane = new Map();
  for (const n of items) {
    let i = ends.findIndex((e) => e < n.beat - 1e-9);
    if (i < 0) i = ends.length;
    ends[i] = n.endBeat;
    lane.set(n, i);
  }
  const c = cols.decor;
  const w = Math.min(24, (c.w - 8) / Math.max(1, ends.length));
  return { x: (n) => c.x + 4 + w * ((lane.get(n) ?? 0) + 0.5), w };
}

function drawDecorItem(n, lanes, ghost = false) {
  const cx = lanes.x(n);
  const sel = selection.has(n);
  ctx.globalAlpha = ghost ? 0.35 : 1;
  const y = yOf(n.beat);
  const ye = yOf(n.endBeat);
  ctx.fillStyle = sel ? 'rgba(124,245,255,0.4)' : 'rgba(154,160,166,0.35)';
  ctx.fillRect(cx - 1.5, ye, 3, y - ye);
  n.keys.forEach((k, i) => {
    const ky = yOf(keyBeat(n, k));
    diamond(cx, ky, 6);
    const current = sel && only() === n && i === decorKey;
    ctx.fillStyle = '#0b0b0c';
    ctx.fill();
    if (current) {
      ctx.fillStyle = SELECT;
      ctx.fill();
    }
    ctx.strokeStyle = sel ? SELECT : '#d0d3d6';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });
  ctx.globalAlpha = 1;
}

let hover = null; // { col, beat, x }
function drawGhost() {
  const { col, beat, x } = hover;
  const t = view.tool;
  const b = snapBeat(beat);
  if ((t === 'tap' || t === 'hold' || t === 'drag') && (col === 'top' || col === 'bottom')) {
    drawNote({ type: t, side: col, beat: b, x: snapX(x), endBeat: b + 1 / view.snap }, true);
  } else if (t === 'flick' && col === 'flick') {
    drawNote({ type: 'flick', beat: b }, true);
  } else if (t === 'slide' && col === 'slide') {
    drawSlideNote({ type: 'slide', beat: b, endBeat: b + 1, path: lastPath, bends: lastBends }, true);
  } else if (t === 'decor' && col === 'decor') {
    const g = newDecor(b);
    const lanes = decorLanes();
    drawDecorItem(g, { x: () => cols.decor.x + cols.decor.w - lanes.w / 2 - 4, w: lanes.w }, true);
  }
}

// A new decoration: two keys DECOR_BEATS apart, both at the last-used look.
const DECOR_BEATS = 4;
let lastDecor = { ...DECOR_DEFAULT };
function newDecor(beat, len = DECOR_BEATS) {
  return { type: 'decor', beat, endBeat: beat + len, keys: [{ t: 0, ...lastDecor }, { t: len, ...lastDecor }] };
}

// ---- hit testing ----

// The note under (px, py): { note, part: 'body' | 'end' }.
function noteAt(px, py) {
  const col = colAt(px);
  let best = null;
  const lanes = col === 'decor' ? decorLanes() : null;
  for (const n of doc.notes) {
    const y = yOf(n.beat);
    if (isDecor(n)) {
      if (col !== 'decor' || Math.abs(px - lanes.x(n)) > lanes.w / 2 + 3) continue;
      const i = n.keys.findIndex((k) => Math.abs(py - yOf(keyBeat(n, k))) <= 7);
      if (i >= 0) return { note: n, part: 'key', key: i };
      if (py <= y && py >= yOf(n.endBeat)) best = { note: n, part: 'body' };
    } else if (n.type === 'slide') {
      if (col !== 'slide') continue;
      const ye = yOf(n.endBeat);
      if (Math.abs(py - ye) <= 6) return { note: n, part: 'end' };
      if (py <= y + 6 && py >= Math.min(ye, y - 70)) best = { note: n, part: 'body' };
    } else if (n.type === 'flick') {
      if (col === 'flick' && Math.abs(py - y) <= 10) return { note: n, part: 'body' };
    } else {
      if (col !== n.side) continue;
      const c = cols[n.side];
      const cx = c.x + n.x * c.w;
      const half = (NOTE_W * c.w) / 2 + 4;
      if (Math.abs(px - cx) > half) continue;
      if (n.type === 'hold') {
        const ye = yOf(n.endBeat);
        if (Math.abs(py - ye) <= 6) return { note: n, part: 'end' };
        if (py <= y + 7 && py >= ye) best = { note: n, part: 'body' };
      } else if (Math.abs(py - y) <= 7) {
        return { note: n, part: 'body' };
      }
    }
  }
  return best;
}

function locate(e) {
  const r = canvas.getBoundingClientRect();
  const px = e.clientX - r.left;
  const py = e.clientY - r.top;
  const col = colAt(px);
  const c = cols[col];
  return { px, py, col, beat: beatAt(py), x: c ? (px - c.x) / c.w : 0.5 };
}

// ---- editing ----

let lastPath = ['ML', 'MR'];
let lastBends = [null];
let drag = null; // the current pointer gesture

function addNote(n) {
  n.id = nextId++;
  doc.notes.push(n);
  return n;
}

function removeNotes(list) {
  if (!list.length) return;
  remember();
  const gone = new Set(list);
  doc.notes = doc.notes.filter((m) => !gone.has(m));
  for (const n of list) selection.delete(n);
  changed();
}

// Select just `n` (or nothing); with toggle, add / remove it from the selection.
let decorKey = 0; // the key being edited of the selected decoration

function select(n, { toggle = false } = {}) {
  const before = only();
  if (!n) selection = new Set();
  else if (toggle) selection.has(n) ? selection.delete(n) : selection.add(n);
  else selection = new Set([n]);
  if (only() !== before) decorKey = 0;
  renderProps();
  draw();
}

function selectMany(list) {
  selection = new Set(list);
  renderProps();
  draw();
}

// Where a note sits on the timeline, for box selection.
function notePoint(n) {
  const y = yOf(n.beat);
  if (n.type === 'flick') return { x: cols.flick.x + cols.flick.w / 2, y };
  if (n.type === 'slide') return { x: cols.slide.x + cols.slide.w / 2, y };
  if (isDecor(n)) return { x: decorLanes().x(n), y };
  const c = cols[n.side];
  return { x: c.x + n.x * c.w, y };
}

function notesInBox(a, b) {
  const [x0, x1] = [Math.min(a.px, b.px), Math.max(a.px, b.px)];
  const [y0, y1] = [Math.min(a.py, b.py), Math.max(a.py, b.py)];
  return doc.notes.filter((n) => {
    const p = notePoint(n);
    return p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
  });
}

// ---- copy / paste / mirror ----

let clipboard = null;

function copySelection(cut = false) {
  if (!selection.size) return toast('ノーツを選択してください');
  const list = [...selection];
  const base = Math.min(...list.map((n) => n.beat));
  clipboard = list.map((n) => {
    const c = structuredClone(strip(n));
    c.beat -= base;
    if (c.endBeat !== undefined) c.endBeat -= base;
    return c;
  });
  try {
    localStorage.setItem(CLIP_KEY, JSON.stringify(clipboard)); // survives a reload / another tab
  } catch {
    // memory only
  }
  if (cut) removeNotes(list);
  toast(`${list.length} 個を${cut ? '切り取り' : 'コピー'}しました`);
}

// Paste at the playhead (snapped); the pasted notes become the selection.
function paste() {
  const stored = readJSON(CLIP_KEY);
  const clip = clipboard ?? (Array.isArray(stored) ? stored : null);
  if (!clip?.length) return toast('コピーしたノーツがありません');
  remember();
  const base = Math.max(0, snapBeat(view.beat));
  const added = clip.map((c) => {
    const n = structuredClone(c);
    n.beat += base;
    if (n.endBeat !== undefined) n.endBeat += base;
    return addNote(n);
  });
  selectMany(added);
  changed();
  toast(`${added.length} 個を貼り付けました（${formatBeat(base)}）`);
}

const MIRROR_COL = { L: 'R', C: 'C', R: 'L' };
const flipBend = (b) => (b === 'L' ? 'R' : b === 'R' ? 'L' : null);

// Left-right mirror of the selection: x for line notes; slides mirror their path and arcs
// (flicks sit in the center and stay).
function mirrorSelection() {
  if (!selection.size) return toast('ノーツを選択してください');
  remember();
  for (const n of selection) {
    if (n.side === 'top' || n.side === 'bottom') n.x = round(1 - n.x, 3);
    if (isDecor(n)) {
      for (const k of n.keys) {
        k.x = round(1 - k.x, 3);
        k.rotation = -k.rotation || 0;
      }
    }
    if (n.type === 'slide') {
      n.path = n.path.map((a) => a[0] + MIRROR_COL[a[1]]);
      n.bends = n.bends.map(flipBend);
      rememberPath(n);
    }
  }
  changed();
  toast(`${selection.size} 個を左右反転しました`);
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const at = locate(e);
  const hit = noteAt(at.px, at.py);
  if (e.button === 2) {
    if (hit) removeNotes([hit.note]);
    return;
  }
  const boxing = view.tool === 'select' || e.shiftKey;
  if (at.col === 'ruler' || (at.col === null && !boxing)) {
    drag = { kind: 'scroll', y: at.py, beat: view.beat, moved: false };
    return;
  }
  if (hit && e.shiftKey) {
    select(hit.note, { toggle: true });
    return;
  }
  if (hit && hit.part === 'body' && selection.has(hit.note) && selection.size > 1) {
    // drag any selected note to move the whole selection
    remember();
    drag = {
      kind: 'group',
      note: hit.note,
      start: at,
      orig: new Map([...selection].map((m) => [m, { beat: m.beat, endBeat: m.endBeat, x: m.x }])),
      moved: false,
    };
    return;
  }
  if (hit?.part === 'key') {
    select(hit.note);
    decorKey = hit.key;
    renderProps();
    remember();
    const n = hit.note;
    drag = { kind: 'key', note: n, index: hit.key, start: at, orig: n.keys.map((k) => keyBeat(n, k)), moved: false };
    return;
  }
  if (hit) {
    select(hit.note);
    remember();
    const n = hit.note;
    drag = {
      kind: hit.part === 'end' ? 'resize' : 'move',
      note: n,
      start: at,
      orig: { beat: n.beat, endBeat: n.endBeat, x: n.x, side: n.side },
      moved: false,
    };
    return;
  }

  if (boxing) {
    // box selection (Shift adds to what's selected); it may start between columns too
    drag = { kind: 'box', start: at, end: at, base: e.shiftKey ? new Set(selection) : new Set(), moved: false };
    if (!e.shiftKey) select(null);
    return;
  }

  const beat = snapBeat(at.beat);
  const field = at.col === 'top' || at.col === 'bottom';
  const t = view.tool;
  let created = null;
  remember();
  if (t === 'tap' && field) created = addNote({ type: 'tap', side: at.col, beat, x: snapX(at.x) });
  else if (t === 'hold' && field) created = addNote({ type: 'hold', side: at.col, beat, x: snapX(at.x), endBeat: beat + 1 / view.snap });
  else if (t === 'drag' && field) created = addNote({ type: 'drag', side: at.col, beat, x: snapX(at.x) });
  else if (t === 'flick' && at.col === 'flick') created = addNote({ type: 'flick', beat });
  else if (t === 'slide' && at.col === 'slide') {
    created = addNote({ type: 'slide', beat, endBeat: beat + 1, path: [...lastPath], bends: [...lastBends] });
  } else if (t === 'decor' && at.col === 'decor') created = addNote(newDecor(beat));
  if (!created) {
    undoStack.pop(); // nothing changed
    select(null);
    drag = { kind: 'scroll', y: at.py, beat: view.beat, moved: false };
    return;
  }
  select(created);
  changed();
  if (t === 'hold' || t === 'slide' || t === 'decor') drag = { kind: 'resize', note: created, start: at, orig: { endBeat: created.endBeat }, moved: true };
  else if (t === 'drag') drag = { kind: 'paint', side: at.col, last: beat };
  else drag = null;
});

canvas.addEventListener('pointermove', (e) => {
  const at = locate(e);
  hover = at;
  if (!drag) {
    const hit = noteAt(at.px, at.py);
    canvas.style.cursor = hit ? (hit.part === 'end' ? 'ns-resize' : 'move') : at.col === 'ruler' ? 'grab' : 'crosshair';
    draw();
    return;
  }
  if (drag.kind === 'scroll') {
    if (Math.abs(at.py - drag.y) > 3) drag.moved = true;
    if (drag.moved && !playing) setViewBeat(drag.beat + (at.py - drag.y) / view.pxPerBeat);
    return;
  }
  if (drag.kind === 'box') {
    drag.end = at;
    if (Math.abs(at.px - drag.start.px) > 3 || Math.abs(at.py - drag.start.py) > 3) drag.moved = true;
    if (drag.moved) selectMany([...drag.base, ...notesInBox(drag.start, at)]);
    return;
  }
  if (drag.kind === 'group') {
    if (!drag.moved && Math.abs(at.py - drag.start.py) < 3 && Math.abs(at.px - drag.start.px) < 3) return;
    drag.moved = true;
    const origs = [...drag.orig.values()];
    const dBeat = Math.max(
      snapBeat(at.beat) - snapBeat(drag.start.beat),
      -Math.min(...origs.map((o) => o.beat)), // keep everything at beat 0 or later
    );
    const raw = (at.px - drag.start.px) / cols.top.w;
    const dx = view.xsnap ? Math.round(raw * 20) / 20 : raw;
    for (const [m, o] of drag.orig) {
      m.beat = o.beat + dBeat;
      if (o.endBeat !== undefined) m.endBeat = o.endBeat + dBeat;
      if (m.side === 'top' || m.side === 'bottom') m.x = round(Math.min(0.95, Math.max(0.05, o.x + dx)), 3);
    }
    changed(false);
    return;
  }
  if (drag.kind === 'paint') {
    // DRAG tool: lay a drag note on every snap step the pointer passes, following it sideways
    const beat = snapBeat(at.beat);
    if (beat !== drag.last && (at.col === drag.side || at.col === null)) {
      const step = beat > drag.last ? 1 / view.snap : -1 / view.snap;
      const c = cols[drag.side];
      const x = snapX((at.px - c.x) / c.w);
      for (let b = drag.last + step; step > 0 ? b <= beat + 1e-9 : b >= beat - 1e-9; b += step) {
        const nb = round(b, 6);
        if (!doc.notes.some((n) => n.type === 'drag' && n.side === drag.side && Math.abs(n.beat - nb) < 1e-6)) {
          select(addNote({ type: 'drag', side: drag.side, beat: nb, x }));
        }
      }
      drag.last = beat;
      changed();
    }
    return;
  }
  const n = drag.note;
  const dBeat = snapBeat(at.beat) - snapBeat(drag.start.beat);
  if (drag.kind === 'key') {
    // a decoration key slides between its neighbors (it may meet them: a jump)
    if (!drag.moved && Math.abs(at.py - drag.start.py) < 3) return;
    drag.moved = true;
    const o = drag.orig;
    const i = drag.index;
    const beats = [...o];
    beats[i] = Math.min(o[i + 1] ?? Infinity, Math.max(o[i - 1] ?? 0, o[i] + dBeat));
    setKeyBeats(n, beats);
    changed(false);
    return;
  }
  if (drag.kind === 'resize') {
    const min = 1 / view.snap;
    if (isDecor(n)) {
      // a new decoration: drag sets where its last key goes
      const end = Math.max(n.beat + min, snapBeat(at.beat));
      if (end !== n.endBeat) {
        n.keys[n.keys.length - 1].t = end - n.beat;
        n.endBeat = end;
        changed(false);
      }
      return;
    }
    const end = Math.max(n.beat + min, snapBeat(at.beat));
    if (end !== n.endBeat) {
      n.endBeat = end;
      changed(false);
    }
    return;
  }
  // move
  if (!drag.moved && Math.abs(at.py - drag.start.py) < 3 && Math.abs(at.px - drag.start.px) < 3) return;
  drag.moved = true;
  n.beat = Math.max(0, drag.orig.beat + dBeat);
  if (n.endBeat !== undefined) n.endBeat = n.beat + (drag.orig.endBeat - drag.orig.beat);
  if (n.side === 'top' || n.side === 'bottom') {
    if (at.col === 'top' || at.col === 'bottom') {
      n.side = at.col;
      n.x = snapX(at.x);
    }
  }
  changed(false);
});

canvas.addEventListener('pointerup', (e) => {
  const at = locate(e);
  if (drag?.kind === 'scroll' && !drag.moved && !playing) setViewBeat(snapBeat(at.beat)); // click on the ruler: move the cursor
  if ((drag?.kind === 'move' || drag?.kind === 'resize' || drag?.kind === 'group' || drag?.kind === 'key') && !drag.moved) {
    undoStack.pop(); // a click only selected
    if (drag.kind === 'group') select(drag.note); // clicking one of several selected picks just it
  }
  drag = null;
  changed();
});

canvas.addEventListener('pointerleave', () => {
  hover = null;
  draw();
});

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15);
      return;
    }
    if (!playing) setViewBeat(view.beat - e.deltaY / view.pxPerBeat);
  },
  { passive: false },
);

function setViewBeat(b) {
  view.beat = Math.max(-2, Math.min(lengthBeats() + 4, b));
  draw();
}

function zoom(k) {
  view.pxPerBeat = Math.max(20, Math.min(600, view.pxPerBeat * k));
  draw();
}

// After any change: redraw, refresh the panels, keep the draft.
function changed(full = true) {
  draw();
  if (full) {
    renderProps();
    renderStats();
  }
  saveDraft();
}

// ---- properties panel ----

const anchorPos = (a) => ({ x: 'LCR'.indexOf(a[1]), y: 'TMB'.indexOf(a[0]) });
// Arcs join diagonal neighbors (90°) or anchors two steps apart in a line (semicircle).
function arcAllowed(a, b) {
  const p = anchorPos(a);
  const q = anchorPos(b);
  const d = Math.hypot(q.x - p.x, q.y - p.y);
  return d > 1.3 && d <= 2;
}

function renderProps() {
  const body = $('props-body');
  if (selection.size > 1) return renderMultiProps(body);
  const n = only();
  if (!n || !doc.notes.includes(n)) {
    body.innerHTML = '<p class="tip">ノーツを選ぶと、ここで細かく編集できます。</p>';
    return;
  }
  if (isDecor(n)) return renderDecorProps(body, n);
  const rows = [];
  rows.push(`<div class="props-row"><span>種類</span><b>${n.type.toUpperCase()}</b></div>`);
  rows.push(`<div class="props-row"><span>拍</span><input type="number" id="p-beat" step="${1 / view.snap}" value="${round(n.beat)}"><small>${formatBeat(n.beat)}</small></div>`);
  if (n.type === 'hold' || n.type === 'slide') {
    rows.push(`<div class="props-row"><span>長さ (拍)</span><input type="number" id="p-len" step="${1 / view.snap}" min="${1 / view.snap}" value="${round(n.endBeat - n.beat)}"></div>`);
  }
  if (n.side === 'top' || n.side === 'bottom') {
    rows.push(`<div class="props-row"><span>ライン</span><div class="seg">
      <button data-side="top" aria-pressed="${n.side === 'top'}">TOP</button>
      <button data-side="bottom" aria-pressed="${n.side === 'bottom'}">BOTTOM</button></div></div>`);
    rows.push(`<div class="props-row"><span>横位置</span><input type="range" id="p-x-range" min="0.05" max="0.95" step="0.01" value="${n.x}">
      <input type="number" id="p-x" min="0.05" max="0.95" step="0.01" value="${round(n.x, 3)}"></div>`);
  }
  if (n.type === 'slide') {
    rows.push('<div class="props-row"><span>経路</span><small>点を順にクリック</small></div>');
    rows.push(`<div class="anchor-grid">${ANCHORS.map((a) => {
      const on = n.path.includes(a);
      const last = n.path[n.path.length - 1] === a;
      return `<button data-anchor="${a}" class="${on ? 'on' : ''} ${last ? 'last' : ''}">${a}</button>`;
    }).join('')}</div>`);
    rows.push(`<div class="buttons"><button id="p-pop">最後の点を消す</button><button id="p-reverse">逆向きにする</button></div>`);
    rows.push(`<div class="segments">${n.path.slice(1).map((b, i) => {
      const a = n.path[i];
      const ok = arcAllowed(a, b);
      const v = n.bends[i];
      return `<div class="props-row"><span>${a} → ${b}</span><div class="seg">
        <button data-bend="${i}:" aria-pressed="${!v}">直線</button>
        <button data-bend="${i}:L" aria-pressed="${v === 'L'}" ${ok ? '' : 'disabled'} title="進行方向の左に膨らむ">(</button>
        <button data-bend="${i}:R" aria-pressed="${v === 'R'}" ${ok ? '' : 'disabled'} title="進行方向の右に膨らむ">)</button></div></div>`;
    }).join('')}</div>`);
    rows.push('<p class="tip">円弧にできるのは斜め隣（90°）か、2マス離れた点同士（半円）だけです。</p>');
  }
  rows.push(`<div class="buttons"><button id="p-copy">コピー</button><button id="p-mirror">左右反転</button>
    <button id="p-delete">削除 (Del)</button></div>`);
  body.innerHTML = rows.join('');

  const edit = (fn) => {
    remember();
    fn();
    changed();
  };
  body.querySelector('#p-beat')?.addEventListener('change', (e) =>
    edit(() => {
      const len = (n.endBeat ?? n.beat) - n.beat;
      n.beat = Math.max(0, Number(e.target.value));
      if (n.endBeat !== undefined) n.endBeat = n.beat + len;
    }),
  );
  body.querySelector('#p-len')?.addEventListener('change', (e) =>
    edit(() => (n.endBeat = n.beat + Math.max(1 / view.snap, Number(e.target.value)))),
  );
  for (const b of body.querySelectorAll('[data-side]')) b.addEventListener('click', () => edit(() => (n.side = b.dataset.side)));
  const setX = (v) => edit(() => (n.x = Math.min(0.95, Math.max(0.05, Number(v)))));
  body.querySelector('#p-x')?.addEventListener('change', (e) => setX(e.target.value));
  body.querySelector('#p-x-range')?.addEventListener('change', (e) => setX(e.target.value));
  body.querySelector('#p-x-range')?.addEventListener('input', (e) => {
    n.x = Number(e.target.value);
    body.querySelector('#p-x').value = n.x;
    draw();
  });
  for (const b of body.querySelectorAll('[data-anchor]')) {
    b.addEventListener('click', () => {
      const a = b.dataset.anchor;
      if (n.path[n.path.length - 1] === a) return;
      edit(() => {
        n.path.push(a);
        n.bends.push(null);
        rememberPath(n);
      });
    });
  }
  body.querySelector('#p-pop')?.addEventListener('click', () => {
    if (n.path.length <= 2) return toast('スライドには2点以上必要です');
    edit(() => {
      n.path.pop();
      n.bends.pop();
      rememberPath(n);
    });
  });
  body.querySelector('#p-reverse')?.addEventListener('click', () =>
    edit(() => {
      n.path.reverse();
      n.bends = n.bends.reverse().map((v) => (v === 'L' ? 'R' : v === 'R' ? 'L' : null)); // same curve, traveled backwards
      rememberPath(n);
    }),
  );
  for (const b of body.querySelectorAll('[data-bend]')) {
    b.addEventListener('click', () => {
      const [i, v] = b.dataset.bend.split(':');
      edit(() => {
        n.bends[Number(i)] = v || null;
        rememberPath(n);
      });
    });
  }
  body.querySelector('#p-copy').addEventListener('click', () => copySelection());
  body.querySelector('#p-mirror').addEventListener('click', mirrorSelection);
  body.querySelector('#p-delete').addEventListener('click', () => removeNotes([n]));
}

// ---- decoration properties: one key at a time, with the screen preview ----

const DECOR_FIELDS = [
  { p: 'x', label: '横位置', min: -0.5, max: 1.5, step: 0.01 },
  { p: 'y', label: '縦位置', min: -0.5, max: 1.5, step: 0.01 },
  { p: 'size', label: '大きさ', min: 0, max: 1.5, step: 0.01 },
  { p: 'rotation', label: '回転 (°)', min: -360, max: 360, step: 1 },
  { p: 'opacity', label: '不透明度', min: 0, max: 1, step: 0.01 },
];

const EASE_LABEL = { linear: '等速', in: '加速', out: '減速', inout: '加減速' };

function renderDecorProps(body, n) {
  decorKey = Math.min(decorKey, n.keys.length - 1);
  const k = n.keys[decorKey];
  const kb = keyBeat(n, k);
  const rows = [];
  rows.push('<div class="props-row"><span>種類</span><b>DECOR（ひし形）</b></div>');
  rows.push(`<div class="props-row"><span>キー</span><div class="seg keys">${n.keys
    .map((_, i) => `<button data-key="${i}" aria-pressed="${i === decorKey}">${i + 1}</button>`)
    .join('')}</div></div>`);
  rows.push(`<div class="props-row"><span>拍</span><input type="number" id="d-beat" step="${1 / view.snap}" value="${round(kb)}"><small>${formatBeat(kb)}</small></div>`);
  for (const f of DECOR_FIELDS) {
    rows.push(`<div class="props-row"><span>${f.label}</span>
      <input type="range" data-dr="${f.p}" min="${f.min}" max="${f.max}" step="${f.step}" value="${k[f.p]}">
      <input type="number" data-dn="${f.p}" step="${f.step}" value="${round(k[f.p], 3)}"></div>`);
  }
  const last = decorKey === n.keys.length - 1;
  rows.push(`<div class="props-row"><span title="次のキーまでの変化のしかた">変化</span><div class="seg ease">${Object.entries(EASE_LABEL)
    .map(([e, label]) => `<button data-ease="${e}" aria-pressed="${!last && (k.ease ?? 'linear') === e}" ${last ? 'disabled' : ''}>${label}</button>`)
    .join('')}</div></div>`);
  if (last) rows.push('<p class="tip">最後のキーです（変化のしかたは、その前のキーで選びます）。</p>');
  rows.push('<canvas id="decor-preview" class="decor-preview" title="ドラッグで位置を動かす"></canvas>');
  rows.push(`<p class="tip" id="decor-preview-label"></p>`);
  rows.push(`<div class="buttons"><button id="d-add" title="赤い線の位置にキーを足す（その時点の状態で）">キーを追加</button>
    <button id="d-remove">このキーを削除</button></div>`);
  rows.push(`<div class="buttons"><button id="p-copy">コピー</button><button id="p-mirror">左右反転</button>
    <button id="p-delete">削除 (Del)</button></div>`);
  rows.push('<p class="tip">キーとキーの間は、前のキーの「変化」で選んだしかた（等速・加速・減速・加減速）で変わります。DECOR 列の◇（キー）を上下にドラッグでタイミングを移動、同じ拍に2つ重ねると瞬間的に切り替わります。プレビューはこのキーの拍の画面で、ドラッグで位置を動かせます。</p>');
  body.innerHTML = rows.join('');

  const edit = (fn) => {
    remember();
    fn();
    changed();
  };
  for (const b of body.querySelectorAll('[data-ease]')) {
    b.addEventListener('click', () =>
      edit(() => {
        if (b.dataset.ease === 'linear') delete k.ease;
        else k.ease = b.dataset.ease;
      }),
    );
  }
  const keep = () => (lastDecor = Object.fromEntries(DECOR_PROPS.map((p) => [p, k[p]])));
  for (const b of body.querySelectorAll('[data-key]')) {
    b.addEventListener('click', () => {
      decorKey = Number(b.dataset.key);
      renderProps();
      draw();
    });
  }
  body.querySelector('#d-beat').addEventListener('change', (e) => {
    const beats = n.keys.map((q) => keyBeat(n, q));
    const v = Math.max(beats[decorKey - 1] ?? 0, Math.min(beats[decorKey + 1] ?? Infinity, Number(e.target.value)));
    if (!Number.isFinite(v)) return renderProps();
    edit(() => {
      beats[decorKey] = v;
      setKeyBeats(n, beats);
    });
  });
  let live = false; // a slider drag in progress: one undo step for the whole drag
  for (const f of DECOR_FIELDS) {
    const range = body.querySelector(`[data-dr="${f.p}"]`);
    const num = body.querySelector(`[data-dn="${f.p}"]`);
    range.addEventListener('input', () => {
      if (!live) remember();
      live = true;
      k[f.p] = Number(range.value);
      num.value = round(k[f.p], 3);
      keep();
      changed(false);
    });
    range.addEventListener('change', () => {
      live = false;
      changed();
    });
    num.addEventListener('change', () => {
      const v = Number(num.value);
      if (!Number.isFinite(v)) return renderProps();
      edit(() => {
        k[f.p] = f.p === 'opacity' ? Math.min(1, Math.max(0, v)) : f.p === 'size' ? Math.max(0, v) : v;
        keep();
      });
    });
  }
  body.querySelector('#d-add').addEventListener('click', () => addDecorKey(n));
  body.querySelector('#d-remove').addEventListener('click', () => {
    if (n.keys.length <= 2) return toast('キーは2つ以上必要です');
    edit(() => {
      const beats = n.keys.map((q) => keyBeat(n, q));
      n.keys.splice(decorKey, 1);
      beats.splice(decorKey, 1);
      setKeyBeats(n, beats);
      decorKey = Math.max(0, decorKey - 1);
    });
  });
  body.querySelector('#p-copy').addEventListener('click', () => copySelection());
  body.querySelector('#p-mirror').addEventListener('click', mirrorSelection);
  body.querySelector('#p-delete').addEventListener('click', () => removeNotes([n]));
  bindPreview(n);
}

// A key at the playhead, with the look the decoration has there (before / after it: extends it).
function addDecorKey(n) {
  const beat = snapBeat(view.beat);
  const beats = n.keys.map((k) => keyBeat(n, k));
  const same = beats.findIndex((b) => Math.abs(b - beat) < 1e-6);
  if (same >= 0) {
    decorKey = same;
    renderProps();
    draw();
    return toast('この拍にはもうキーがあります');
  }
  if (beat < 0) return;
  remember();
  const st = decorState(n.keys, beat, (k) => keyBeat(n, k)) ?? { ...(beat < n.beat ? n.keys[0] : n.keys[n.keys.length - 1]) };
  const key = { t: 0 };
  for (const p of DECOR_PROPS) key[p] = round(st[p], 3);
  const i = beats.filter((b) => b < beat).length;
  const prev = n.keys[i - 1];
  if (prev?.ease && i < n.keys.length) key.ease = prev.ease; // splitting a curve: both halves keep its kind
  n.keys.splice(i, 0, key);
  beats.splice(i, 0, beat);
  setKeyBeats(n, beats);
  decorKey = i;
  changed();
  toast(`キー ${i + 1} を追加しました（${formatBeat(beat)}）`);
}

// The preview: the play screen (a phone in landscape) at the edited key's beat — or, with no
// decoration selected, at the playhead — with every decoration there. Dragging moves the key.
const PREVIEW_ASPECT = 2.1;
function previewField(w, h) {
  const fieldW = Math.min(w - 16, h * 1.8);
  return { x: (w - fieldW) / 2, w: fieldW, h };
}

function drawPreview() {
  const cv = $('decor-preview');
  if (!cv) return;
  const n = only();
  if (!n || !isDecor(n)) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = cv.clientWidth;
  const h = Math.round(w / PREVIEW_ASPECT);
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    cv.style.height = `${h}px`;
  }
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = '#0b0b0c';
  c.fillRect(0, 0, w, h);
  const field = previewField(w, h);
  const beat = keyBeat(n, n.keys[Math.min(decorKey, n.keys.length - 1)]);
  const scale = h / 400; // line width as on a ~400px tall phone screen
  for (const d of doc.notes) {
    if (!isDecor(d)) continue;
    const st = d === n ? { ...n.keys[decorKey] } : decorState(d.keys, beat, (k) => keyBeat(d, k));
    if (st) strokeDecor(c, st, field, Math.max(1, 2 * scale));
  }
  // the edited one, marked even when faint or off screen
  const k = n.keys[decorKey];
  c.fillStyle = SELECT;
  c.beginPath();
  c.arc(field.x + k.x * field.w, k.y * h, 3, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = 'rgba(255,255,255,0.06)';
  c.fillRect(field.x, 0, 1, h);
  c.fillRect(field.x + field.w - 1, 0, 1, h);
  c.fillStyle = 'rgba(242,242,242,0.6)';
  c.fillRect(field.x, Math.round(h * 0.2), field.w, 1);
  c.fillRect(field.x, Math.round(h * 0.8), field.w, 1);
  const label = $('decor-preview-label');
  if (label) label.textContent = `キー ${decorKey + 1} の画面（${formatBeat(beat)}）`;
}

function bindPreview(n) {
  const cv = $('decor-preview');
  let dragging = null;
  const pos = (e) => {
    const r = cv.getBoundingClientRect();
    const f = previewField(r.width, r.height);
    return { x: (e.clientX - r.left - f.x) / f.w, y: (e.clientY - r.top) / r.height };
  };
  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId);
    const k = n.keys[decorKey];
    const p = pos(e);
    remember();
    dragging = { k, dx: k.x - p.x, dy: k.y - p.y, near: Math.hypot((p.x - k.x) * 1.8, p.y - k.y) < 0.08 };
    // a press away from the center moves it there; a press on it grabs it where it is
    if (!dragging.near) Object.assign(dragging, { dx: 0, dy: 0 });
    move(e);
  });
  const move = (e) => {
    if (!dragging) return;
    const p = pos(e);
    dragging.k.x = round(p.x + dragging.dx, 3);
    dragging.k.y = round(p.y + dragging.dy, 3);
    for (const f of ['x', 'y']) {
      const v = dragging.k[f];
      const range = document.querySelector(`[data-dr="${f}"]`);
      const num = document.querySelector(`[data-dn="${f}"]`);
      if (range) range.value = v;
      if (num) num.value = v;
    }
    changed(false);
  };
  cv.addEventListener('pointermove', move);
  cv.addEventListener('pointerup', () => {
    dragging = null;
    changed();
  });
  drawPreview();
}

function renderMultiProps(body) {
  const count = {};
  for (const n of selection) count[n.type] = (count[n.type] ?? 0) + 1;
  const beats = [...selection].map((n) => n.beat);
  body.innerHTML = `<div class="props-row"><span>選択</span><b>${selection.size} 個</b></div>
    <p class="tip">${Object.entries(count).map(([k, v]) => `${k.toUpperCase()} ${v}`).join(' · ')}<br>
    ${formatBeat(Math.min(...beats))} 〜 ${formatBeat(Math.max(...beats))}</p>
    <div class="buttons"><button id="p-copy">コピー</button><button id="p-cut">切り取り</button>
    <button id="p-mirror">左右反転</button><button id="p-delete">削除 (Del)</button></div>
    <p class="tip">選択中のどれかをドラッグすると、まとめて移動できます。</p>`;
  body.querySelector('#p-copy').addEventListener('click', () => copySelection());
  body.querySelector('#p-cut').addEventListener('click', () => copySelection(true));
  body.querySelector('#p-mirror').addEventListener('click', mirrorSelection);
  body.querySelector('#p-delete').addEventListener('click', () => removeNotes([...selection]));
}

// New slides start with the shape of the last one edited.
function rememberPath(n) {
  lastPath = [...n.path];
  lastBends = [...n.bends];
}

function renderStats() {
  const count = { tap: 0, hold: 0, drag: 0, flick: 0, slide: 0 };
  let decor = 0;
  for (const n of doc.notes) isDecor(n) ? decor++ : count[n.type]++;
  const notes = doc.notes.length - decor;
  const judgments = notes + count.hold + count.slide; // holds and slides judge twice
  $('stats').innerHTML = [
    ...Object.entries(count).map(([k, v]) => `<span>${k.toUpperCase()}</span><span>${v}</span>`),
    `<span>判定数（コンボ）</span><span>${judgments}</span>`,
    `<span>DECOR（演出）</span><span>${decor}</span>`,
  ].join('');
}

// ---- inputs ----

function syncInputs() {
  $('title').value = doc.title;
  $('artist').value = doc.artist;
  $('difficulty').value = doc.difficulty;
  $('bpm').value = doc.bpm;
  renderChanges('bpm');
  renderChanges('scroll');
  $('offset').value = doc.offset;
  $('bars').value = doc.bars;
  $('snap').value = String(view.snap);
  $('xsnap').checked = view.xsnap;
  for (const b of document.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === view.tool));
}

for (const id of ['title', 'artist', 'difficulty']) {
  $(id).addEventListener('change', (e) => {
    doc[id] = e.target.value;
    saveDraft();
  });
}

function setTiming(key, value) {
  if (!Number.isFinite(value)) return syncInputs();
  remember();
  doc[key] = value;
  syncInputs();
  changed();
  if (!audio && key !== 'offset') synthPeaks(); // the generated music follows BPM and length
}
$('bpm').addEventListener('change', (e) => setTiming('bpm', Math.min(400, Math.max(20, Number(e.target.value)))));

// ---- BPM / scroll speed changes ----
// BPM changes are for songs whose tempo changes partway. Notes stay on their beats when the tempo
// changes, like with BPM itself: put the change where the song's tempo changes, set its BPM so the
// grid follows the waveform again, then place notes.
// Scroll speed changes set how fast notes move from that beat on (1 normal, 2 twice as fast,
// 0 stopped, negative backwards); timing doesn't change.

const CHANGES = {
  bpm: {
    list: () => doc.bpms,
    value: 'bpm',
    el: 'bpm-changes',
    min: 20,
    max: 400,
    step: 0.01,
    first: 1e-9, // beat 0's BPM is the BPM field
    at: (beat) => round(tm().bpmAt(beat), 2),
    name: 'BPM 変更',
  },
  scroll: {
    list: () => doc.scrolls,
    value: 'speed',
    el: 'scroll-changes',
    min: -10,
    max: 10,
    step: 0.05,
    first: 0,
    at: (beat) => scrollAt(beat),
    name: 'スクロール速度の変更',
  },
};

// The scroll speed in force at a beat (1 before any change).
function scrollAt(beat) {
  let v = 1;
  for (const c of doc.scrolls) if (c.beat <= beat + 1e-9) v = c.speed;
  return v;
}

function renderChanges(kind) {
  const k = CHANGES[kind];
  const el = $(k.el);
  el.innerHTML = k
    .list()
    .map(
      (c, i) => `<div class="props-row change-row"><span>${formatBeat(c.beat)}</span>
      <input type="number" data-cbeat="${i}" step="${1 / view.snap}" min="0" value="${round(c.beat)}" title="拍">
      <input type="number" data-cval="${i}" step="${k.step}" min="${k.min}" max="${k.max}" value="${c[k.value]}" title="${k.name}">
      <button data-cdel="${i}" title="この${k.name}を削除">×</button></div>`,
    )
    .join('');
  for (const inp of el.querySelectorAll('[data-cbeat]')) {
    inp.addEventListener('change', () => {
      const i = Number(inp.dataset.cbeat);
      const v = snapBeat(Number(inp.value));
      if (!(v >= k.first) || k.list().some((c, j) => j !== i && Math.abs(c.beat - v) < 1e-6)) {
        toast(k.first > 0 ? '0拍目より後の、まだ変更のない拍にしてください' : 'まだ変更のない拍にしてください');
        return renderChanges(kind);
      }
      editChanges(kind, () => (k.list()[i].beat = v));
    });
  }
  for (const inp of el.querySelectorAll('[data-cval]')) {
    inp.addEventListener('change', () => {
      const v = Number(inp.value);
      if (!Number.isFinite(v)) return renderChanges(kind);
      editChanges(kind, () => (k.list()[Number(inp.dataset.cval)][k.value] = round(Math.min(k.max, Math.max(k.min, v)), 3)));
    });
  }
  for (const b of el.querySelectorAll('[data-cdel]')) {
    b.addEventListener('click', () => editChanges(kind, () => k.list().splice(Number(b.dataset.cdel), 1)));
  }
}

function editChanges(kind, fn) {
  remember();
  fn();
  CHANGES[kind].list().sort((a, b) => a.beat - b.beat);
  syncInputs();
  changed();
}

// A change at the playhead, starting at the value already there.
function addChange(kind) {
  const k = CHANGES[kind];
  const beat = snapBeat(view.beat);
  if (beat < k.first) return toast(kind === 'bpm' ? 'BPM変更は0拍目より後に置けます（0拍目の BPM は上の欄）' : '0拍目以降に置けます');
  if (k.list().some((c) => Math.abs(c.beat - beat) < 1e-6)) return toast(`この拍にはもう${k.name}があります`);
  editChanges(kind, () => k.list().push({ beat, [k.value]: k.at(beat) }));
  const i = k.list().findIndex((c) => c.beat === beat);
  const inp = $(k.el).querySelector(`[data-cval="${i}"]`);
  inp?.focus();
  inp?.select();
  toast(`${formatBeat(beat)} に${k.name}を追加しました`);
}
$('add-bpm').addEventListener('click', () => addChange('bpm'));
$('add-scroll').addEventListener('click', () => addChange('scroll'));
$('offset').addEventListener('change', (e) => setTiming('offset', Math.round(Number(e.target.value))));
$('bars').addEventListener('change', (e) => setTiming('bars', Math.max(1, Math.round(Number(e.target.value)))));
for (const b of document.querySelectorAll('[data-nudge]')) {
  b.addEventListener('click', () => setTiming('offset', doc.offset + Number(b.dataset.nudge)));
}
$('snap').addEventListener('change', (e) => {
  view.snap = Number(e.target.value);
  renderProps();
  draw();
});
$('xsnap').addEventListener('change', (e) => {
  view.xsnap = e.target.checked;
  draw();
});

function setTool(t) {
  view.tool = t;
  syncInputs();
  draw();
}
for (const b of document.querySelectorAll('[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));

// ---- audio ----

let audio = null; // AudioBuffer of the loaded song, or null for the test song's synth
let audioLabel = '';

async function loadAudioFile(file) {
  stopPlay(); // unlock() may swap the context the playback runs on
  sfx.unlock();
  const ac = sfx.audio();
  try {
    if (!ac) throw new Error('Web Audio を使えません');
    const buf = await sfx.decode(ac, await sfx.readBytes(file));
    audio = buf;
    audioLabel = `${file.name}（${formatTime(buf.duration * 1000)}）`;
    peaks = computePeaks(buf);
    if (!doc.title) {
      doc.title = file.name.replace(/\.[^.]+$/, '');
      syncInputs();
    }
    toast('音源を読み込みました');
  } catch (e) {
    // say what failed, so a report from a device we can't test on tells us why
    const kind = file.type || file.name.split('.').pop() || '不明';
    const why = e?.name && e.name !== 'Error' ? e.name : e?.message || '不明なエラー';
    toast('音源を読み込めませんでした');
    $('audio-name').textContent = `読み込めませんでした：${file.name}（${kind} / ${formatSize(file.size)} / ${why}）。mp3・m4a・wav を推奨します`;
    changed();
    return;
  }
  $('audio-name').textContent = audioLabel;
  changed();
}

const formatSize = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)}MB` : `${Math.round(bytes / 1024)}KB`);

function useSynth() {
  audio = null;
  peaks = null;
  audioLabel = 'テスト楽曲の音（BPM と長さに合わせて生成）';
  $('audio-name').textContent = audioLabel;
  synthPeaks();
}

// Peaks for the generated test track, so the waveform shows its beats too.
async function synthPeaks() {
  const buf = await currentTrack();
  if (!audio) {
    peaks = computePeaks(buf);
    draw();
  }
}

function computePeaks(buf) {
  const per = Math.round((buf.sampleRate * PEAK_MS) / 1000);
  const chans = [...Array(buf.numberOfChannels)].map((_, i) => buf.getChannelData(i));
  const out = new Float32Array(Math.ceil(buf.length / per));
  let max = 0;
  for (let i = 0; i < out.length; i++) {
    let m = 0;
    for (const d of chans) for (let j = i * per, e = Math.min(d.length, j + per); j < e; j++) m = Math.max(m, Math.abs(d[j]));
    out[i] = m;
    max = Math.max(max, m);
  }
  if (max > 0) for (let i = 0; i < out.length; i++) out[i] /= max;
  return out;
}

// The music to play: the loaded file, or the test song's synth (which puts beat 0 at 0ms).
function currentTrack() {
  if (audio) return Promise.resolve(audio);
  return trackFor({ bpm: doc.bpm, duration: msOf(doc.bars * 4) + 1200 });
}

$('load-audio').addEventListener('click', () => $('file-audio').click());
$('file-audio').addEventListener('change', (e) => e.target.files[0] && loadAudioFile(e.target.files[0]));
$('use-synth').addEventListener('click', useSynth);

// ---- playback ----

let playing = null;

async function play() {
  if (playing) return stopPlay();
  sfx.unlock();
  const ac = sfx.audio();
  const buf = await currentTrack();
  const rate = Number($('rate').value);
  const startMs = msOf(view.beat);
  const startCtx = ac.currentTime + 0.06;
  const src = ac.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate;
  const gain = ac.createGain();
  gain.gain.value = prefs.volume;
  src.connect(gain).connect(ac.destination);
  const lead = Math.max(0, -startMs) / 1000 / rate;
  src.start(startCtx + lead, Math.max(0, startMs) / 1000);
  playing = { src, gain, startCtx, startMs, rate, scheduled: startMs - 1 };
  playing.timer = setInterval(scheduleTicks, 25);
  scheduleTicks();
  $('play').textContent = '❚❚';
  requestAnimationFrame(follow);
}

function stopPlay() {
  if (!playing) return;
  try {
    playing.src.stop();
  } catch {
    // already stopped
  }
  clearInterval(playing.timer);
  playing = null;
  $('play').textContent = '▶';
  draw();
}

// Song time (ms) being heard now.
function playMs() {
  const ac = sfx.audio();
  const latency = ac.outputLatency || ac.baseLatency || 0;
  return playing.startMs + (ac.currentTime - playing.startCtx - latency) * 1000 * playing.rate;
}

function follow() {
  if (!playing) return;
  const ms = playMs();
  if (ms > songMs()) return stopPlay();
  view.beat = beatOf(ms);
  draw();
  requestAnimationFrame(follow);
}

// Hit sounds on note heads (and slide / hold ends), and the metronome, scheduled a little ahead.
function scheduleTicks() {
  const ac = sfx.audio();
  const p = playing;
  const horizon = p.startMs + (ac.currentTime + 0.2 - p.startCtx) * 1000 * p.rate;
  const at = (ms) => p.startCtx + (ms - p.startMs) / 1000 / p.rate;
  const from = p.scheduled;
  if ($('hitsound').checked) {
    const times = new Set();
    for (const n of doc.notes) {
      if (isDecor(n)) continue;
      times.add(msOf(n.beat));
      if (n.endBeat !== undefined) times.add(msOf(n.endBeat));
    }
    for (const t of times) if (t > from && t <= horizon && t >= p.startMs) click(ac, ac.destination, at(t), 2400, 0.35);
  }
  if ($('metronome').checked) {
    for (let b = Math.ceil(beatOf(from) + 1e-6); msOf(b) <= horizon; b++) {
      if (msOf(b) >= p.startMs) click(ac, ac.destination, at(msOf(b)), b % 4 === 0 ? 1760 : 1320, 0.3);
    }
  }
  p.scheduled = horizon;
}

// ---- volume / test play speed ----

function renderPrefs() {
  $('volume').value = String(Math.round(prefs.volume * 100));
  $('volume-value').textContent = `${Math.round(prefs.volume * 100)}%`;
  $('speed').textContent = prefs.speed.toFixed(1);
  $('auto').checked = prefs.auto;
  $('tp-sfx').checked = prefs.testSfx;
  $('tp-offset').textContent = `${prefs.testOffset > 0 ? '+' : ''}${prefs.testOffset}ms`;
}

$('tp-sfx').addEventListener('change', (e) => {
  prefs.testSfx = e.target.checked;
  savePrefs();
});
for (const b of document.querySelectorAll('[data-tpoffset]')) {
  b.addEventListener('click', () => {
    prefs.testOffset = Math.max(-500, Math.min(500, prefs.testOffset + Number(b.dataset.tpoffset)));
    renderPrefs();
    savePrefs();
  });
}

$('auto').addEventListener('change', (e) => {
  prefs.auto = e.target.checked;
  savePrefs();
});

$('volume').addEventListener('input', (e) => {
  prefs.volume = Number(e.target.value) / 100;
  music.volume = prefs.volume;
  if (playing) playing.gain.gain.value = prefs.volume;
  renderPrefs();
  savePrefs();
});

function setSpeed(v) {
  prefs.speed = Math.min(8, Math.max(1, v));
  renderPrefs();
  savePrefs();
}
$('speed-down').addEventListener('click', () => setSpeed(prefs.speed - 0.5));
$('speed-up').addEventListener('click', () => setSpeed(prefs.speed + 0.5));

$('play').addEventListener('click', play);
$('to-start').addEventListener('click', () => {
  stopPlay();
  setViewBeat(0);
});
$('rate').addEventListener('change', () => playing && (stopPlay(), play()));
$('zoom-in').addEventListener('click', () => zoom(1.25));
$('zoom-out').addEventListener('click', () => zoom(1 / 1.25));

// ---- test play (the real game) ----

const game = new Game($('tp-stage'), { onEnd: showTestResult });
const music = new Music();
music.volume = prefs.volume;

// During test play the page must not zoom: user-scalable=no (which also snaps an existing zoom
// back) plus cancelling pinch / double-tap gestures. Editing keeps normal zoom.
const viewport = document.querySelector('meta[name=viewport]');
const editViewport = viewport.content;
function lockZoom(on) {
  viewport.content = on ? `${editViewport}, maximum-scale=1, user-scalable=no` : editViewport;
  blockZoom(on);
}

async function testPlay(fromStart) {
  stopPlay();
  sfx.unlock();
  lockZoom(true);
  const chart = normalizeChart(exportJSON());
  const from = fromStart ? 0 : Math.max(0, msOf(snapBeat(view.beat)));
  chart.notes = chart.notes.filter((n) => n.time >= from - 1);
  if (!chart.notes.length) return toast('この位置より後にノーツがありません');
  const track = await currentTrack();
  const offset = prefs.testOffset;
  const speed = prefs.speed;
  sfx.setEnabled(prefs.testSfx);
  $('tp').hidden = false;
  $('tp-result').hidden = true;
  game.resize();
  game.start(chart, { speed, offset, sync: () => music.zeroPerf(), from, auto: prefs.auto });
  music.playAt(track, 0, game.startAt - offset);
}

function showTestResult(r) {
  music.stop();
  const el = $('tp-result');
  el.innerHTML = `<div class="big">${String(r.score).padStart(7, '0')}</div>
    <div>PERFECT ${r.stats.PERFECT} · GREAT ${r.stats.GREAT} · MISS ${r.stats.MISS}</div>
    <div>MAX COMBO ${r.maxCombo} / ${r.total}</div>
    <div class="buttons"><button id="tp-again">もう一度</button><button id="tp-back" class="accent">エディタに戻る</button></div>`;
  el.hidden = false;
  $('tp-again').addEventListener('click', () => testPlay(lastTestFromStart));
  $('tp-back').addEventListener('click', exitTestPlay);
}

let lastTestFromStart = false;
function exitTestPlay() {
  game.stop();
  music.stop();
  lockZoom(false);
  $('tp').hidden = true;
  layout();
}

$('testplay').addEventListener('click', (e) => {
  lastTestFromStart = e.shiftKey;
  testPlay(e.shiftKey);
});
$('tp-exit').addEventListener('click', exitTestPlay);

// ---- files ----

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function saveFile() {
  const base = (doc.title || 'chart').replace(/[\\/:*?"<>|\s]+/g, '_');
  download(`${base}_${doc.difficulty.toLowerCase()}.json`, JSON.stringify(exportJSON(), null, 1));
  toast('譜面を保存しました');
}

async function openFile(file) {
  try {
    setDoc(importJSON(JSON.parse(await file.text())));
    toast(`${file.name} を開きました`);
  } catch {
    toast('譜面を読み込めませんでした');
  }
}

$('save').addEventListener('click', saveFile);
$('open').addEventListener('click', () => $('file-json').click());
$('file-json').addEventListener('change', (e) => {
  if (e.target.files[0]) openFile(e.target.files[0]);
  e.target.value = '';
});
$('new').addEventListener('click', () => {
  if (doc.notes.length && !confirm('今の譜面を破棄して新規作成しますか？')) return;
  setDoc(newDoc());
});
$('sample').addEventListener('click', () => {
  if (doc.notes.length && !confirm('今の譜面を破棄して、テスト楽曲の譜面を開きますか？')) return;
  const d = doc.difficulty;
  const chart = generateChart(d);
  setDoc(importJSON({ title: 'テスト楽曲', artist: 'AXIDIA', difficulty: d, bpm: chart.bpm, offset: 0, notes: chart.notes }));
  useSynth();
});
$('undo').addEventListener('click', undo);
$('select-all').addEventListener('click', () => selectMany(doc.notes));
$('copy').addEventListener('click', () => copySelection());
$('cut').addEventListener('click', () => copySelection(true));
$('paste').addEventListener('click', paste);
$('mirror').addEventListener('click', mirrorSelection);

// ---- full screen (no address bar) ----

// Standard API, with the webkit-prefixed one older iPadOS has.
const fullscreenElement = () => document.fullscreenElement ?? document.webkitFullscreenElement ?? null;

// Safari's element full screen on iOS / iPadOS is not used: it takes rapid taps for typing on a
// fake keyboard (an anti-phishing check), warns "you seem to be typing in full screen" and drops
// out of full screen mid-play. A Home Screen web app has no address bar and no such check.
const IOS_FULLSCREEN_TIP = 'iPhone / iPad は「共有 → ホーム画面に追加」から開くと、アドレスバーなしの全画面で使えます';
$('fullscreen').hidden = isStandalone();

function toggleFullscreen() {
  const el = document.documentElement;
  if (fullscreenElement()) (document.exitFullscreen ?? document.webkitExitFullscreen)?.call(document);
  else if (isIOS) toast(IOS_FULLSCREEN_TIP, 5000);
  else if (el.requestFullscreen) el.requestFullscreen().catch(() => toast('全画面にできませんでした'));
  else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  else toast('この端末のブラウザは全画面に対応していません（ホーム画面に追加すると全画面で開けます）');
}
$('fullscreen').addEventListener('click', toggleFullscreen);
for (const type of ['fullscreenchange', 'webkitfullscreenchange']) {
  document.addEventListener(type, () => {
    $('fullscreen').textContent = fullscreenElement() ? '全画面を終了' : '全画面';
    sfx.refreshAudio(); // iOS may silence the old AudioContext across the switch
  });
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopPlay();
  else sfx.refreshAudio();
});
$('redo').addEventListener('click', redo);

// drag & drop: audio files load as the song, JSON as the chart (some browsers leave file.type empty)
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|aiff?|caf|flac|ogg|oga|opus|webm)$/i;
const wrap = $('timeline-wrap');
wrap.addEventListener('dragover', (e) => {
  e.preventDefault();
  wrap.classList.add('dropping');
});
wrap.addEventListener('dragleave', () => wrap.classList.remove('dropping'));
wrap.addEventListener('drop', (e) => {
  e.preventDefault();
  wrap.classList.remove('dropping');
  for (const f of e.dataTransfer.files) {
    if (f.type.startsWith('audio/') || AUDIO_EXT.test(f.name)) loadAudioFile(f);
    else if (f.name.endsWith('.json')) openFile(f);
  }
});

// ---- keyboard ----

const TOOL_KEYS = { v: 'select', 1: 'tap', 2: 'hold', 3: 'drag', 4: 'flick', 5: 'slide', 6: 'decor' };
window.addEventListener('keydown', (e) => {
  if (!$('tp').hidden) {
    if (e.key === 'Escape') exitTestPlay();
    return;
  }
  const typing = e.target.matches('input:not([type=checkbox]):not([type=range]), select');
  if (typing) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    (e.shiftKey ? redo : undo)();
  } else if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redo();
  } else if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveFile();
  } else if (mod && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    selectMany(doc.notes);
  } else if (mod && e.key.toLowerCase() === 'c') {
    e.preventDefault();
    copySelection();
  } else if (mod && e.key.toLowerCase() === 'x') {
    e.preventDefault();
    copySelection(true);
  } else if (mod && e.key.toLowerCase() === 'v') {
    e.preventDefault();
    paste();
  } else if (mod) {
    return;
  } else if (e.key === ' ') {
    e.preventDefault();
    play();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    removeNotes([...selection]);
  } else if (e.key.toLowerCase() === 'm') {
    mirrorSelection();
  } else if (e.key.toLowerCase() === 'f') {
    toggleFullscreen();
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    const step = (e.shiftKey ? 4 : 1 / view.snap) * (e.key === 'ArrowUp' ? 1 : -1);
    if (!playing) setViewBeat(snapBeat(view.beat) + step);
  } else if (e.key === 'Home') {
    stopPlay();
    setViewBeat(0);
  } else if (e.key === '+' || e.key === '=') {
    zoom(1.25);
  } else if (e.key === '-') {
    zoom(1 / 1.25);
  } else if (e.key.toLowerCase() === 't') {
    lastTestFromStart = e.shiftKey;
    testPlay(e.shiftKey);
  } else if (e.key === 'Escape') {
    select(null);
  } else if (TOOL_KEYS[e.key.toLowerCase()]) {
    setTool(TOOL_KEYS[e.key.toLowerCase()]);
  }
});

// ---- misc ----

function formatTime(ms) {
  const s = Math.max(0, ms) / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, '0')}`;
}

// "bar : beat" (1-based), with the fraction of a beat when off the beat
function formatBeat(beat) {
  const b = Math.max(0, beat);
  const bar = Math.floor(b / 4) + 1;
  const inBar = b - (bar - 1) * 4 + 1;
  return `${bar} : ${Number.isInteger(round(inBar, 3)) ? round(inBar, 3) : round(inBar, 2).toFixed(2)}`;
}

function updateTransport() {
  $('time').textContent = formatTime(msOf(view.beat));
  $('pos').textContent = formatBeat(view.beat);
}

let toastTimer = 0;
function toast(text, ms = 1800) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

window.addEventListener('resize', () => $('tp').hidden && layout());
if (new URLSearchParams(location.search).has('debug')) {
  Object.assign(window, { __editor: { get doc() { return doc; }, view, exportJSON, importJSON, setDoc }, __game: game, __music: music });
}

syncInputs();
renderPrefs();
useSynth();
renderStats();
renderProps();
layout();
