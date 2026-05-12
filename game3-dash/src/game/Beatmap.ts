/**
 * Manual beatmap JSON (from tapper export), e.g. `public/beatmaps/test.json`:
 * `{ "track": "/audio/foo.mp3", "beats": [{ "time": 1.2, "type": "beat" }, ...] }`
 */

export type BeatKind = 'beat' | 'accent' | 'drop' | 'danger';

export type BeatEvent = {
  time: number;
  type: BeatKind;
};

export type Beatmap = {
  track: string;
  beats: BeatEvent[];
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseTime(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const t = parseFloat(value);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

const KNOWN_BEAT_KINDS: ReadonlySet<BeatKind> = new Set([
  'beat',
  'accent',
  'drop',
  'danger',
]);

function normalizeBeatType(raw: unknown): BeatKind {
  if (typeof raw === 'string' && KNOWN_BEAT_KINDS.has(raw as BeatKind)) {
    return raw as BeatKind;
  }
  if (typeof raw === 'string' && raw.length > 0) {
    console.warn('[Beatmap] unknown beat type, using "beat":', raw);
  }
  return 'beat';
}

/**
 * Parse `beats` from manual JSON or a few legacy shapes:
 * - `[{ time, type }, ...]`
 * - `[t1, t2, ...]` (numbers only → type `"beat"`)
 */
function parseBeatsArray(beats: unknown): BeatEvent[] {
  if (!Array.isArray(beats)) {
    throw new Error('beatmap.beats must be an array');
  }
  if (beats.length === 0) {
    return [];
  }

  const first = beats[0];
  if (typeof first === 'number' || typeof first === 'string') {
    console.warn(
      '[Beatmap] beats appear to be a legacy flat time list; wrapping as type "beat".',
    );
    const out: BeatEvent[] = [];
    for (const entry of beats) {
      const time = parseTime(entry);
      if (time === null) continue;
      out.push({ time, type: 'beat' });
    }
    return out.sort((a, b) => a.time - b.time);
  }

  const out: BeatEvent[] = [];
  for (const entry of beats) {
    if (!isObject(entry)) continue;
    const time = parseTime(entry.time);
    if (time === null) continue;
    const type =
      entry.type === undefined ? 'beat' : normalizeBeatType(entry.type);
    const ev: BeatEvent = { time, type };
    out.push(ev);
  }
  return out.sort((a, b) => a.time - b.time);
}

export async function loadBeatmap(url: string): Promise<Beatmap> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const raw: unknown = await res.json();
    if (!isObject(raw)) {
      throw new Error('Beatmap JSON must be an object');
    }
    const track = raw.track;
    const beatsRaw = raw.beats;
    if (typeof track !== 'string' || track.trim().length === 0) {
      throw new Error('beatmap.track must be a non-empty string (audio URL path)');
    }

    const beats = parseBeatsArray(beatsRaw);

    const beatmap: Beatmap = {
      track: track.trim(),
      beats,
    };

    console.log('[Beatmap] loaded:', url);
    console.log('[Beatmap] track:', beatmap.track);
    console.log('[Beatmap] beats count:', beatmap.beats.length);
    console.log('[Beatmap] first beats:', beatmap.beats.slice(0, 5));

    return beatmap;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error('[Beatmap] load failed:', reason, e);
    throw e;
  }
}
