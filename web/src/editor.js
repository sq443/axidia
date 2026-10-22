// AXIDIA chart editor. Charts are edited in beats (so BPM / OFFSET changes keep notes on the grid)
// and saved as the chart JSON that songs.js loads.
import { Game, makeSeg, SLIDE_LEAD_BEATS } from './game.js';
import { normalizeChart } from './songs.js';
import { generateChart } from './chart.js';
import { Music, trackFor, click } from './music.js';
import * as sfx from './sfx.js';

const $ = (id) => document.getElementById(id);
const DRAFT_KEY = 'axidia.editor.draft';
const PREFS_KEY = 'axidia.editor.prefs';
const GAME_KEY = 'axidia.v1';
const NOTE_W = 0.11; // as in the game
const ANCHORS = ['TL', 'TC', 'TR', 'ML', 'MC', 'MR', 'BL', 'BC', 'BR'];
const COLOR = { tap: '#f2f2f2', hold: '#f2f2f2', drag: '#ffd84d', flick: '#f2f2f2', slide: '#b9a4ff' };
const SELECT = '#7cf5ff';
const PEAK_MS = 5; // waveform resolution
const HISTORY = 200;

// ---- document ----

const newDoc = () => ({ title: '', artist: '', difficulty: 'NORMAL', bpm: 140, offset: 0, bars: 32, notes: [] });
let doc = loadDraft() ?? newDoc();
let nextId = 1;
doc.notes.forEach((n) => (n.id = nextId++));

const beatMs = () => 60000 / doc.bpm;
const msOf = (beat) => doc.offset + beat * beatMs();
const beatOf = (ms) => (ms - doc.offset) / beatMs();

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
const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

// The chart JSON that songs.js loads.
function exportJSON() {
  const notes = [...doc.notes]
    .sort((a, b) => a.beat - b.beat)
    .map((n) => {
      const out = { type: n.type, beat: round(n.beat) };
      if (n.type === 'tap' || n.type === 'hold' || n.type === 'drag') Object.assign(out, { side: n.side, x: round(n.x, 3) });
      if (n.type === 'hold' || n.type === 'slide') out.endBeat = round(n.endBeat);
      if (n.type === 'slide') Object.assign(out, { path: n.path, bends: n.bends });
      return out;
    });
  const { title, artist, difficulty, bpm, offset } = doc;
  return { title, artist, difficulty, bpm, offset, notes };
}

// Chart JSON (beats or ms) → document.
function importJSON(json) {
  const d = { ...newDoc(), title: json.title ?? '', artist: json.artist ?? '', bpm: json.bpm ?? 140, offset: json.offset ?? 0 };
  if (DIFFS.includes(json.difficulty)) d.difficulty = json.difficulty;
  const bms = 60000 / d.bpm;
  const toBeat = (ms, beat) => beat ?? (ms - d.offset) / bms;
  d.notes = (json.notes ?? []).map((n) => {
    const note = { type: n.type, beat: toBeat(n.time, n.beat) };
    if (n.type === 'tap' || n.type === 'hold' || n.type === 'drag') Object.assign(note, { side: n.side ?? 'bottom', x: n.x ?? 0.5 });
    if (n.type === 'hold' || n.type === 'slide') note.endBeat = toBeat(n.end, n.endBeat);
    if (n.type === 'slide') Object.assign(note, { path: n.path, bends: n.bends ?? n.path.slice(1).map(() => null) });
    return note;
  });
  const last = d.notes.reduce((m, n) => Math.max(m, n.endBeat ?? n.beat), 0);
  d.bars = Math.max(4, Math.ceil((last + 1) / 4));
  return d;
}

function setDoc(d) {
  doc = d;
  doc.notes.forEach((n) => (n.id = nextId++));
  selected = null;
  undoStack.length = redoStack.length = 0;
  view.beat = 0;
  syncInputs();
  changed();
}

// ---- undo / redo ----

const undoStack = [];
const redoStack = [];
const snapshot = () => JSON.stringify({ notes: doc.notes, bpm: doc.bpm, offset: doc.offset, bars: doc.bars });

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
  selected = doc.notes.find((n) => n.id === selected?.id) ?? null;
  syncInputs();
  changed();
}

const undo = () => restore(undoStack, redoStack);
const redo = () => restore(redoStack, undoStack);

// ---- editor preferences (music volume, test play speed) ----

const prefs = { volume: 1, speed: null, auto: false, ...readJSON(PREFS_KEY) };
prefs.speed ??= readJSON(GAME_KEY).speed ?? 3; // start from the game's speed

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
let selected = null;

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
  const field = Math.max(120, Math.min(380, (W - ruler - flick - slide - gap * 5) / 2));
  let x = 0;
  const col = (w) => {
    const c = { x, w };
    x += w + gap;
    return c;
  };
  cols = { ruler: col(ruler), top: col(field), bottom: col(field), flick: col(flick), slide: col(slide) };
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
  for (const name of ['top', 'bottom', 'flick', 'slide']) {
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

  // notes
  const visible = (n) => (n.endBeat ?? n.beat) >= b0 - 1 && n.beat <= b1 + 1;
  for (const n of doc.notes) if (visible(n) && n.type === 'slide') drawSlideNote(n);
  for (const n of doc.notes) if (visible(n) && n.type !== 'slide') drawNote(n);

  // hover ghost
  if (hover && !drag && view.tool !== 'select') drawGhost();

  // headers
  ctx.fillStyle = 'rgba(11,11,12,0.85)';
  ctx.fillRect(0, 0, W, 24);
  ctx.font = '500 10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#8a8a8e';
  const label = { ruler: 'BAR / WAVE', top: 'TOP LINE', bottom: 'BOTTOM LINE', flick: 'FLICK', slide: 'SLIDE' };
  for (const [name, c] of Object.entries(cols)) ctx.fillText(label[name], c.x + c.w / 2, 12);

  // playhead
  ctx.fillStyle = '#ff5d6c';
  ctx.fillRect(0, playY - 1, W, 2);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.font = '500 11px system-ui, sans-serif';
  ctx.fillText(formatBeat(view.beat), W - 6, playY - 4);
  drawOverview(b0, b1);
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
  const sel = n === selected;
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
  const sel = n === selected;
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
  }
}

// ---- hit testing ----

// The note under (px, py): { note, part: 'body' | 'end' }.
function noteAt(px, py) {
  const col = colAt(px);
  let best = null;
  for (const n of doc.notes) {
    const y = yOf(n.beat);
    if (n.type === 'slide') {
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

function removeNote(n) {
  remember();
  doc.notes = doc.notes.filter((m) => m !== n);
  if (selected === n) selected = null;
  changed();
}

function select(n) {
  selected = n;
  renderProps();
  draw();
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const at = locate(e);
  const hit = noteAt(at.px, at.py);
  if (e.button === 2) {
    if (hit) removeNote(hit.note);
    return;
  }
  if (at.col === 'ruler' || at.col === null) {
    drag = { kind: 'scroll', y: at.py, beat: view.beat, moved: false };
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
  }
  if (!created) {
    undoStack.pop(); // nothing changed
    select(null);
    drag = { kind: 'scroll', y: at.py, beat: view.beat, moved: false };
    return;
  }
  select(created);
  changed();
  if (t === 'hold' || t === 'slide') drag = { kind: 'resize', note: created, start: at, orig: { endBeat: created.endBeat }, moved: true };
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
  if (drag.kind === 'resize') {
    const min = 1 / view.snap;
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
  if ((drag?.kind === 'move' || drag?.kind === 'resize') && !drag.moved) undoStack.pop(); // a click only selected
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
  const n = selected;
  if (!n || !doc.notes.includes(n)) {
    body.innerHTML = '<p class="tip">ノーツを選ぶと、ここで細かく編集できます。</p>';
    return;
  }
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
  rows.push('<div class="buttons"><button id="p-delete">削除 (Del)</button></div>');
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
  body.querySelector('#p-delete')?.addEventListener('click', () => removeNote(n));
}

// New slides start with the shape of the last one edited.
function rememberPath(n) {
  lastPath = [...n.path];
  lastBends = [...n.bends];
}

function renderStats() {
  const count = { tap: 0, hold: 0, drag: 0, flick: 0, slide: 0 };
  for (const n of doc.notes) count[n.type]++;
  const judgments = doc.notes.length + count.hold + count.slide; // holds and slides judge twice
  $('stats').innerHTML = [
    ...Object.entries(count).map(([k, v]) => `<span>${k.toUpperCase()}</span><span>${v}</span>`),
    `<span>判定数（コンボ）</span><span>${judgments}</span>`,
  ].join('');
}

// ---- inputs ----

function syncInputs() {
  $('title').value = doc.title;
  $('artist').value = doc.artist;
  $('difficulty').value = doc.difficulty;
  $('bpm').value = doc.bpm;
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
  sfx.unlock();
  try {
    const data = await file.arrayBuffer();
    const buf = await new Promise((resolve, reject) => sfx.audio().decodeAudioData(data, resolve, reject));
    audio = buf;
    audioLabel = `${file.name}（${formatTime(buf.duration * 1000)}）`;
    peaks = computePeaks(buf);
    if (!doc.title) {
      doc.title = file.name.replace(/\.[^.]+$/, '');
      syncInputs();
    }
    toast('音源を読み込みました');
  } catch {
    toast('音源を読み込めませんでした');
  }
  $('audio-name').textContent = audioLabel;
  changed();
}

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

async function testPlay(fromStart) {
  stopPlay();
  sfx.unlock();
  const chart = normalizeChart(exportJSON());
  const from = fromStart ? 0 : Math.max(0, msOf(snapBeat(view.beat)));
  chart.notes = chart.notes.filter((n) => n.time >= from - 1);
  if (!chart.notes.length) return toast('この位置より後にノーツがありません');
  const track = await currentTrack();
  const { offset = 0 } = readJSON(GAME_KEY);
  const speed = prefs.speed;
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
$('redo').addEventListener('click', redo);

// drag & drop: audio files load as the song, JSON as the chart
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
    if (f.type.startsWith('audio/')) loadAudioFile(f);
    else if (f.name.endsWith('.json')) openFile(f);
  }
});

// ---- keyboard ----

const TOOL_KEYS = { v: 'select', 1: 'tap', 2: 'hold', 3: 'drag', 4: 'flick', 5: 'slide' };
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
  } else if (mod) {
    return;
  } else if (e.key === ' ') {
    e.preventDefault();
    play();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selected) removeNote(selected);
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
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 1800);
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
