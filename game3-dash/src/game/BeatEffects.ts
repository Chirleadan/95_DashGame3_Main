import { type BeatEvent } from './Beatmap.ts';

type BeatListener = (beat: BeatEvent) => void;

/** Visual beat effects. Extend by registering more listeners later. */
export class BeatEffects {
  private readonly flashEl: HTMLDivElement;
  private readonly listeners: BeatListener[] = [];
  private flashTimer = 0;

  constructor(container: HTMLElement) {
    this.flashEl = document.createElement('div');
    this.flashEl.className = 'beat-flash';
    container.appendChild(this.flashEl);
  }

  /** White screen pulse when the player scores an on-beat dash hit. */
  triggerOnBeatHitFlash(): void {
    this.flashTimer = 0.085;
    this.flashEl.style.opacity = '0.35';
  }

  onBeat(listener: BeatListener): void {
    this.listeners.push(listener);
  }

  triggerBeat(beat: BeatEvent): void {
    for (const l of this.listeners) l(beat);
  }

  update(dt: number): void {
    if (this.flashTimer <= 0) return;
    this.flashTimer = Math.max(0, this.flashTimer - dt);
    const t = this.flashTimer / 0.085;
    this.flashEl.style.opacity = (0.35 * t).toFixed(3);
  }
}
