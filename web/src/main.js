import { Game } from './game.js';
import { DIFFICULTIES, generateChart } from './chart.js';
import * as sfx from './sfx.js';

const STORAGE_KEY = 'axidia.v1';
const SPEED_MIN = 1;
const SPEED_MAX = 8;
const SPEED_STEP = 0.5;

const $ = (id) => document.getElementById(id);

const settings = {
  difficulty: 'NORMAL',
  speed: 3,
  sfx: true,
  best: {},
  ...load(),
};

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

const screens = ['title', 'pause', 'result'];
function show(id) {
  for (const s of screens) $(s).hidden = s !== id;
  $('pause-btn').hidden = id !== null;
}

// ---- title ----

function renderTitle() {
  const seg = $('difficulty');
  seg.replaceChildren(
    ...Object.keys(DIFFICULTIES).map((d) => {
      const b = document.createElement('button');
      b.textContent = d;
      b.setAttribute('aria-pressed', String(d === settings.difficulty));
      b.addEventListener('click', () => {
        settings.difficulty = d;
        save();
        renderTitle();
      });
      return b;
    }),
  );
  const best = settings.best[settings.difficulty];
  $('best').textContent = best ? `BEST ${String(best.score).padStart(7, '0')}  ${best.rank}` : '';
  $('speed').textContent = settings.speed.toFixed(1);
  $('sfx').textContent = settings.sfx ? 'ON' : 'OFF';
  $('sfx').setAttribute('aria-pressed', String(settings.sfx));
  sfx.setEnabled(settings.sfx);
}

for (const b of document.querySelectorAll('[data-speed]')) {
  b.addEventListener('click', () => {
    const v = settings.speed + Number(b.dataset.speed) * SPEED_STEP;
    settings.speed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, v));
    save();
    renderTitle();
  });
}

$('sfx').addEventListener('click', () => {
  settings.sfx = !settings.sfx;
  save();
  renderTitle();
});

// ---- game ----

const game = new Game($('stage'), { onEnd: showResult });
if (new URLSearchParams(location.search).has('debug')) window.__game = game;

function play() {
  sfx.unlock();
  lockLandscape();
  show(null);
  game.start(generateChart(settings.difficulty), { speed: settings.speed });
}

function toTitle() {
  game.stop();
  renderTitle();
  show('title');
}

$('start').addEventListener('click', play);
$('retry').addEventListener('click', play);
$('retry-p').addEventListener('click', play);
$('back').addEventListener('click', toTitle);
$('quit').addEventListener('click', toTitle);

$('pause-btn').addEventListener('click', () => {
  game.pause();
  show('pause');
});
$('resume').addEventListener('click', () => {
  show(null);
  game.resume();
});
function pauseIfPlaying() {
  if (game.running) {
    game.pause();
    show('pause');
  }
}
document.addEventListener('visibilitychange', () => document.hidden && pauseIfPlaying());

// ---- orientation ----

// Landscape only. Where the browser allows it (Android Chrome), go fullscreen and lock the
// orientation; elsewhere (iOS Safari) the CSS overlay asks the player to rotate.
async function lockLandscape() {
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
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
  const rank = rankOf(r.score);
  $('r-diff').textContent = settings.difficulty;
  $('r-rank').textContent = rank;
  $('r-score').textContent = String(r.score).padStart(7, '0');
  $('r-badge').textContent = r.allPerfect ? 'ALL PERFECT' : r.fullCombo ? 'FULL COMBO' : '';
  $('r-perfect').textContent = r.stats.PERFECT;
  $('r-great').textContent = r.stats.GREAT;
  $('r-miss').textContent = r.stats.MISS;
  $('r-combo').textContent = `${r.maxCombo} / ${r.total}`;
  $('r-fastslow').textContent = `${r.stats.fast} / ${r.stats.slow}`;

  const prev = settings.best[settings.difficulty];
  if (!prev || r.score > prev.score) {
    settings.best[settings.difficulty] = { score: r.score, rank };
    save();
  }
  show('result');
}

renderTitle();
show('title');

const version = document.querySelector('.version');
if (version.textContent.includes('__VERSION__')) version.textContent = 'build local';
