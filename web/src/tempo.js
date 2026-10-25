// Beats ↔ ms for a chart whose BPM may change: `bpm` from beat 0 (which is at `offset` ms), then
// each of `changes` ({ beat, bpm }) from its beat on. Before beat 0 the starting BPM holds.
export function tempoMap(bpm, changes = [], offset = 0) {
  const segs = [{ beat: 0, bpm, ms: offset }];
  for (const c of [...changes].filter((c) => c.beat > 0 && c.bpm > 0).sort((a, b) => a.beat - b.beat)) {
    const last = segs[segs.length - 1];
    if (c.beat === last.beat) {
      last.bpm = c.bpm;
      continue;
    }
    segs.push({ beat: c.beat, bpm: c.bpm, ms: last.ms + ((c.beat - last.beat) * 60000) / last.bpm });
  }
  const segAtBeat = (beat) => {
    let i = 0;
    while (i < segs.length - 1 && segs[i + 1].beat <= beat) i++;
    return segs[i];
  };
  const segAtMs = (ms) => {
    let i = 0;
    while (i < segs.length - 1 && segs[i + 1].ms <= ms) i++;
    return segs[i];
  };
  return {
    segs,
    msOf(beat) {
      const s = segAtBeat(beat);
      return s.ms + ((beat - s.beat) * 60000) / s.bpm;
    },
    beatOf(ms) {
      const s = segAtMs(ms);
      return s.beat + ((ms - s.ms) * s.bpm) / 60000;
    },
    bpmAt: (beat) => segAtBeat(beat).bpm,
  };
}
