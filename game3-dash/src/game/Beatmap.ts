export type BeatType = 'beat' | string;

export type BeatEvent = {
  time: number;
  type: BeatType;
};

export type Beatmap = {
  track: string;
  beats: BeatEvent[];
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function loadBeatmap(url: string): Promise<Beatmap> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to load beatmap: ${res.status} ${res.statusText}`);
  }
  const raw: unknown = await res.json();
  if (!isObject(raw)) {
    throw new Error('Beatmap JSON must be an object');
  }
  const track = raw.track;
  const beats = raw.beats;
  if (typeof track !== 'string' || !Array.isArray(beats)) {
    throw new Error('Beatmap JSON has invalid track or beats');
  }

  const parsedBeats: BeatEvent[] = beats
    .map((entry: unknown) => {
      if (!isObject(entry)) return null;
      const time = entry.time;
      const type = entry.type;
      if (typeof time !== 'number' || typeof type !== 'string') return null;
      return { time, type };
    })
    .filter((x): x is BeatEvent => x !== null)
    .sort((a, b) => a.time - b.time);

  return {
    track,
    beats: parsedBeats,
  };
}
