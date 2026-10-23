import { Game } from './game.js';
import { DIFFS, SONGS, loadChart, loadMusic } from './songs.js';
import { Music } from './music.js';
import { Calibrator } from './calibrate.js';
import * as sfx from './sfx.js';
import { blockZoom, isIOS } from './touch.js';

const STORAGE_KEY = 'axidia.v1';
const SPEED_MIN = 1;
const SPEED_MAX = 8;
const SPEED_STEP = 0.5;
const OFFSET_LIMIT = 500; // ms
const OFFSET_STEP = 5;
const IRIS_MS = 620;

const $ = (id) => document.getElementById(id);
const DEBUG = new URLSearchParams(location.search).has('debug');

const settings = {
  song: SONGS[0].id,
  difficulty: 'NORMAL',
  speed: 3,
  sfx: true,
  offset: 0, // ms; positive when the audio is heard late on this device
  best: {}, // "songId/DIFFICULTY" -> { score, rank }
  ...load(),
};
// Older saves kept best scores per difficulty only; those were all the test song.
for (const d of [...DIFFS, 'SLIDE']) {
  if (settings.best[d] && d !== 'SLIDE') settings.best[`test/${d}`] ??= settings.best[d];
  delete settings.best[d];
}
if (!DIFFS.includes(settings.difficulty)) settings.difficulty = 'NORMAL';

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // storage unavailable (private mode etc.) — settings just won't persist
  }
}

const songs = SONGS.filter((s) => DEBUG || !s.debug);
const currentSong = () => songs.find((s) => s.id === settings.song) ?? songs[0];

// ---- screens ----

const screens = ['title', 'select', 'settings', 'calib', 'pause', 'result'];
function show(id, { animate = true } = {}) {
  for (const s of screens) {
    const el = $(s);
    const visible = s === id;
    el.hidden = !visible;
    el.classList.toggle('enter', visible && animate && s === id);
  }
  $('pause-btn').hidden = id !== null;
}

const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);

// Diamond iris on a screen: it collapses into the center (open → false) or grows out of it
// (open → true), with an outline riding on its edge. What's underneath shows around it.
function iris(el, open) {
  const ring = $('iris');
  const w = window.innerWidth;
  const h = window.innerHeight;
  const cx = w / 2;
  const cy = h / 2;
  const max = w / 2 + h / 2; // a diamond this big covers the screen
  el.style.zIndex = 10;
  return new Promise((resolve) => {
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / IRIS_MS);
      const r = max * (open ? ease(k) : 1 - ease(k));
      el.style.clipPath = `polygon(${cx}px ${cy - r}px, ${cx + r}px ${cy}px, ${cx}px ${cy + r}px, ${cx - r}px ${cy}px)`;
      ring.style.width = ring.style.height = `${r * Math.SQRT2}px`;
      ring.style.opacity = String(Math.sin(Math.PI * k) * 0.9);
      if (k < 1) return requestAnimationFrame(step);
      el.style.clipPath = '';
      el.style.zIndex = '';
      ring.style.opacity = '0';
      resolve();
    };
    requestAnimationFrame(step);
  });
}

// ---- title ----

$('title').addEventListener('click', () => {
  sfx.unlock();
  lockLandscape();
  renderSelect();
  show('select');
});

// ---- song select ----

function renderSelect() {
  const song = currentSong();
  $('song-list').replaceChildren(
    ...songs.map((s) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.className = 'song';
      b.setAttribute('aria-current', String(s === song));
      b.innerHTML = '<i class="jacket"></i><span class="song-name"></span><span class="song-sub"></span>';
      b.querySelector('.song-name').textContent = s.title;
      b.querySelector('.song-sub').textContent = `${s.artist} · ${s.bpm} BPM`;
      b.addEventListener('click', () => {
        settings.song = s.id;
        save();
        renderSelect();
      });
      li.append(b);
      return li;
    }),
  );

  $('sd-title').textContent = song.title;
  $('sd-artist').textContent = song.artist;
  $('difficulty').replaceChildren(
    ...DIFFS.map((d) => {
      const b = document.createElement('button');
      b.textContent = d;
      b.setAttribute('aria-pressed', String(d === settings.difficulty));
      b.addEventListener('click', () => {
        settings.difficulty = d;
        save();
        renderSelect();
      });
      return b;
    }),
  );
  const best = settings.best[`${song.id}/${settings.difficulty}`];
  $('best').textContent = best ? `BEST ${String(best.score).padStart(7, '0')}  ${best.rank}` : '';
  $('sd-meta').textContent = `BPM ${song.bpm}`;
  $('sd-notes').textContent = '';
  const want = `${song.id}/${settings.difficulty}`;
  loadChart(song, settings.difficulty).then((chart) => {
    if (want !== `${currentSong().id}/${settings.difficulty}`) return; // selection moved on
    const secs = Math.round(chart.duration / 1000);
    $('sd-meta').textContent = `BPM ${song.bpm} · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    $('sd-notes').textContent = `${chart.notes.length} NOTES`;
    loadMusic(song, chart); // get the music ready ahead of time
  });
}

$('to-title').addEventListener('click', () => show('title'));

// ---- settings ----

function renderSettings() {
  $('speed').textContent = settings.speed.toFixed(1);
  $('sfx').textContent = settings.sfx ? 'ON' : 'OFF';
  $('sfx').setAttribute('aria-pressed', String(settings.sfx));
  sfx.setEnabled(settings.sfx);
  $('offset').textContent = formatOffset(settings.offset);
}

const formatOffset = (ms) => `${ms > 0 ? '+' : ''}${ms}ms`;
const clampOffset = (ms) => Math.max(-OFFSET_LIMIT, Math.min(OFFSET_LIMIT, Math.round(ms / OFFSET_STEP) * OFFSET_STEP));

for (const b of document.querySelectorAll('[data-speed]')) {
  b.addEventListener('click', () => {
    const v = settings.speed + Number(b.dataset.speed) * SPEED_STEP;
    settings.speed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, v));
    save();
    renderSettings();
  });
}

for (const b of document.querySelectorAll('[data-offset]')) {
  b.addEventListener('click', () => {
    settings.offset = clampOffset(settings.offset + Number(b.dataset.offset) * OFFSET_STEP);
    save();
    renderSettings();
  });
}

$('sfx').addEventListener('click', () => {
  settings.sfx = !settings.sfx;
  save();
  renderSettings();
});

$('open-settings').addEventListener('click', () => {
  renderSettings();
  show('settings');
});
$('close-settings').addEventListener('click', () => show('select', { animate: false }));

// ---- game ----

const game = new Game($('stage'), { onEnd: showResult });
const music = new Music();
let track = null; // the current song's music
let playing = null; // { song, difficulty } being played
if (DEBUG) Object.assign(window, { __game: game, __music: music });

async function play() {
  sfx.unlock(); // inside the tap, before any await (iOS)
  lockLandscape();
  music.stop();
  const song = currentSong();
  const difficulty = settings.difficulty;
  const from = screens.find((s) => !$(s).hidden);
  $('start').textContent = 'LOADING';
  const chart = await loadChart(song, difficulty);
  track = await loadMusic(song, chart).catch(() => null);
  $('start').textContent = 'START';
  playing = { song, difficulty };

  const offset = settings.offset;
  game.start(chart, { speed: settings.speed, offset, sync: track ? () => music.zeroPerf() : null });
  // song time 0 is heard `offset` ms before the game clock reaches it
  music.playAt(track, 0, game.startAt - offset);

  if (from === 'select') {
    // the select screen folds into a diamond, revealing the game already starting underneath
    $('pause-btn').hidden = true;
    await iris($('select'), false);
  }
  show(null);
}

// Back to song select: it unfolds from a diamond in the center.
async function toSelect() {
  game.stop();
  music.stop();
  renderSelect();
  const el = $('select');
  el.hidden = false;
  el.classList.remove('enter');
  $('pause-btn').hidden = true;
  await iris(el, true);
  show('select', { animate: false });
}

$('start').addEventListener('click', play);
$('retry').addEventListener('click', play);
$('retry-p').addEventListener('click', play);
$('back').addEventListener('click', toSelect);
$('quit').addEventListener('click', toSelect);

function pause() {
  game.pause();
  music.stop();
  show('pause');
}
$('pause-btn').addEventListener('click', pause);
$('resume').addEventListener('click', () => {
  sfx.unlock(); // a fresh context if the page was away (iOS)
  show(null);
  game.resume();
  // Restart the music where it stopped, timed to the end of the countdown.
  music.playAt(track, (game.pausedAt - (game.startAt - game.offset)) / 1000, game.resumeAt);
});
function pauseIfPlaying() {
  if (game.running) pause();
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseIfPlaying();
  else sfx.refreshAudio(); // iOS may silence the old AudioContext while away
});
document.addEventListener('fullscreenchange', sfx.refreshAudio);
blockZoom(true); // the game never wants pinch / double-tap zoom

// ---- orientation ----

// Landscape only. Where the browser allows it (Android Chrome), go fullscreen and lock the
// orientation; elsewhere (iOS Safari) the CSS overlay asks the player to rotate.
async function lockLandscape() {
  try {
    // not on iOS / iPadOS: there Safari ends full screen mid-play, taking rapid taps for typing
    if (!isIOS && !document.fullscreenElement && document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    }
    await screen.orientation?.lock?.('landscape');
  } catch {
    // not supported — the rotate overlay covers it
  }
}

matchMedia('(orientation: portrait)').addEventListener('change', (e) => e.matches && pauseIfPlaying());

// ---- result ----

function rankOf(score) {
  if (score >= 980000) return 'S+';
  if (score >= 950000) return 'S';
  if (score >= 900000) return 'A';
  if (score >= 800000) return 'B';
  if (score >= 700000) return 'C';
  return 'D';
}

function showResult(r) {
  music.stop();
  const { song, difficulty } = playing;
  const rank = rankOf(r.score);
  $('r-song').textContent = song.title;
  $('r-diff').textContent = difficulty;
  $('r-rank').textContent = rank;
  $('r-score').textContent = String(r.score).padStart(7, '0');
  $('r-badge').textContent = r.allPerfect ? 'ALL PERFECT' : r.fullCombo ? 'FULL COMBO' : '';
  $('r-perfect').textContent = r.stats.PERFECT;
  $('r-great').textContent = r.stats.GREAT;
  $('r-miss').textContent = r.stats.MISS;
  $('r-combo').textContent = `${r.maxCombo} / ${r.total}`;
  $('r-fastslow').textContent = `${r.stats.fast} / ${r.stats.slow}`;

  const key = `${song.id}/${difficulty}`;
  const prev = settings.best[key];
  if (!prev || r.score > prev.score) {
    settings.best[key] = { score: r.score, rank };
    save();
  }
  show('result');
}

// ---- offset calibration ----

const calibrator = new Calibrator();
if (DEBUG) window.__calib = calibrator;

function renderCalib() {
  const r = calibrator.result;
  $('calib-value').textContent = r === null ? '—' : formatOffset(clampOffset(r));
  $('calib-taps').textContent = `${calibrator.taps} taps`;
  $('calib-apply').disabled = r === null;
}

function closeCalib() {
  calibrator.stop();
  renderSettings();
  show('settings');
}

$('calibrate').addEventListener('click', () => {
  sfx.unlock();
  calibrator.start();
  renderCalib();
  show('calib');
});
$('calib').addEventListener('pointerdown', (e) => {
  if (e.target.closest('button')) return;
  const now = performance.now();
  calibrator.tap(Math.abs(now - e.timeStamp) < 500 ? e.timeStamp : now);
  renderCalib();
});
$('calib-back').addEventListener('click', closeCalib);
$('calib-apply').addEventListener('click', () => {
  if (calibrator.result !== null) settings.offset = clampOffset(calibrator.result);
  save();
  closeCalib();
});

renderSettings();
show('title');

const version = document.querySelector('.version');
if (version.textContent.includes('__VERSION__')) version.textContent = 'build local';
