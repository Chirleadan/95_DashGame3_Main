/** Pre-cloned HTMLAudio elements so gameplay SFX do not decode on every play(). */
export class SfxPool {
  private readonly pool: HTMLAudioElement[];
  private index = 0;

  constructor(source: HTMLAudioElement, poolSize = 4) {
    this.pool = [];
    for (let i = 0; i < poolSize; i++) {
      const clone = source.cloneNode(true) as HTMLAudioElement;
      clone.preload = 'auto';
      this.pool.push(clone);
    }
  }

  warm(): void {
    for (const el of this.pool) {
      el.load();
    }
  }

  play(volume: number, playbackRate: number): void {
    const sfx = this.pool[this.index]!;
    this.index = (this.index + 1) % this.pool.length;
    sfx.volume = volume;
    sfx.playbackRate = playbackRate;
    try {
      sfx.currentTime = 0;
    } catch {
      /* some browsers throw if not ready */
    }
    void sfx.play().catch(() => {
      /* autoplay policy */
    });
  }
}
