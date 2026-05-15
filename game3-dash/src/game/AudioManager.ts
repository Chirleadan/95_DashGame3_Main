export class AudioManager {
  private readonly audio = new Audio();

  constructor() {
    this.audio.preload = 'auto';
  }

  setLoop(loop: boolean): void {
    this.audio.loop = loop;
  }

  setVolume(volume: number): void {
    this.audio.volume = Math.min(
      1,
      Math.max(0, Number.isFinite(volume) ? volume : 1),
    );
  }

  async setTrack(src: string): Promise<void> {
    if (this.audio.src !== src) {
      this.audio.src = src;
    }
    if (this.audio.readyState >= 1) return;
    await new Promise<void>((resolve, reject) => {
      const onLoaded = () => {
        cleanup();
        resolve();
      };
      const onErr = () => {
        cleanup();
        console.error('[Audio] failed to load:', {
          src: this.audio.src,
          error: this.audio.error,
          networkState: this.audio.networkState,
          readyState: this.audio.readyState,
        });
        reject(new Error('Audio failed to load'));
      };
      const cleanup = () => {
        this.audio.removeEventListener('loadedmetadata', onLoaded);
        this.audio.removeEventListener('error', onErr);
      };
      this.audio.addEventListener('loadedmetadata', onLoaded);
      this.audio.addEventListener('error', onErr);
      this.audio.load();
    });
  }

  async play(): Promise<void> {
    await this.audio.play();
  }

  pause(): void {
    this.audio.pause();
  }

  reset(): void {
    this.audio.currentTime = 0;
  }

  get currentTime(): number {
    return this.audio.currentTime;
  }

  get isPlaying(): boolean {
    return !this.audio.paused && !this.audio.ended;
  }
}
