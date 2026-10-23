// The song list. Each song has three charts (EASY / NORMAL / HARD) and its music.
//
// A song is either generated (the test song: `chart(difficulty)` and `music(chart)` functions) or
// loaded from files:
//   {
//     id: 'my-song', title: '曲名', artist: 'アーティスト', bpm: 128,
//     audio: 'songs/my-song/audio.mp3',
//     charts: { EASY: 'songs/my-song/easy.json', NORMAL: '…', HARD: '…' },
//   }
// Chart JSON: { "bpm": 128, "offset": 0, "notes": [ { "type": "tap", "side": "bottom", "beat": 4, "x": 0.5 }, … ] }
//   Each note takes either `time` (ms from the start of the audio) or `beat` (beats after `offset` ms);
//   hold / slide ends likewise take `end` (ms) or `endBeat`. Other fields are as in chart.js.
import { generateChart } from './chart.js';
import { trackFor } from './music.js';
import { decode as decodeWith } from './sfx.js';

export const DIFFS = ['EASY', 'NORMAL', 'HARD'];

export const SONGS = [
  {
    id: 'test',
    title: 'テスト楽曲',
    artist: 'AXIDIA',
    bpm: 140,
    chart: (difficulty) => generateChart(difficulty),
    music: (chart) => trackFor(chart),
  },
  {
    // every slide shape in turn — listed only with ?debug
    id: 'slide-test',
    title: 'スライド確認',
    artist: 'debug',
    bpm: 140,
    debug: true,
    chart: () => generateChart('SLIDE'),
    music: (chart) => trackFor(chart),
  },
];

const charts = new Map();
const tracks = new Map();

export function loadChart(song, difficulty) {
  const key = `${song.id}/${difficulty}`;
  if (!charts.has(key)) {
    charts.set(
      key,
      song.chart
        ? Promise.resolve(song.chart(difficulty))
        : fetch(song.charts[difficulty]).then((r) => r.json()).then(normalizeChart),
    );
  }
  return charts.get(key);
}

export function loadMusic(song, chart) {
  if (song.music) return song.music(chart);
  if (!tracks.has(song.id)) tracks.set(song.id, fetch(song.audio).then((r) => r.arrayBuffer()).then(decode));
  return tracks.get(song.id);
}

function decode(data) {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  return decodeWith(new OAC(1, 1, 44100), data);
}

// Chart JSON → the chart object the game plays (times in ms). Also used by the chart editor.
export function normalizeChart(json) {
  const beatMs = 60000 / json.bpm;
  const at = (ms, beat) => ms ?? (json.offset ?? 0) + beat * beatMs;
  const notes = json.notes
    .map(({ beat, endBeat, ...n }) => {
      const note = { side: 'bottom', x: 0.5, ...n, time: at(n.time, beat) };
      if (note.type === 'hold' || note.type === 'slide') note.end = at(n.end, endBeat);
      if (note.type === 'flick') note.side = 'center';
      if (note.type === 'slide') note.side = 'free';
      return note;
    })
    .sort((a, b) => a.time - b.time || a.x - b.x);
  const last = notes.reduce((m, n) => Math.max(m, n.end ?? n.time), 0);
  return { bpm: json.bpm, beatMs, notes, duration: json.duration ?? last + 1200 };
}
