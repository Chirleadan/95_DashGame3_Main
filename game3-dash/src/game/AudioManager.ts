export class AudioManager {
  private readonly audio = new Audio();

  constructor() {
    this.audio.preload = 'auto';
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
