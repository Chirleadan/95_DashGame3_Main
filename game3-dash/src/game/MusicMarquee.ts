/** Scrolling “now playing” label for ambient vs tape (stage) audio. */

export const MUSIC_MARQUEE_AMBIENT = 'variafx - Mistlands';

const TAPE_CREDITS: Readonly<Record<string, string>> = {
  'track-1': 'variafx - uuuoooh1',
  'track-2': 'variafx - zeroheadbeat',
  'track-3': 'Ohota - Would You Lay on My Trap',
};

export type TapeTrackCreditParts = {
  artist: string;
  title: string;
};

export function getTapeTrackCredit(trackId: string): string | null {
  return TAPE_CREDITS[trackId] ?? null;
}

export function getTapeTrackCreditParts(trackId: string): TapeTrackCreditParts | null {
  const raw = getTapeTrackCredit(trackId);
  if (!raw) return null;
  const sep = raw.indexOf(' - ');
  if (sep < 0) return { artist: raw, title: '' };
  return {
    artist: raw.slice(0, sep).trim(),
    title: raw.slice(sep + 3).trim(),
  };
}

export class MusicMarquee {
  private readonly root: HTMLElement;
  private readonly textEls: readonly HTMLElement[];
  private currentText: string | null = null;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'music-marquee';
    this.root.hidden = true;
    this.root.setAttribute('aria-live', 'polite');
    this.root.innerHTML = `
      <div class="music-marquee__viewport">
        <div class="music-marquee__track">
          <span class="music-marquee__text"></span>
          <span class="music-marquee__text" aria-hidden="true"></span>
        </div>
      </div>
    `;
    this.textEls = Array.from(
      this.root.querySelectorAll<HTMLElement>('.music-marquee__text'),
    );
    parent.appendChild(this.root);
  }

  setLayout(mode: 'menu' | 'run'): void {
    this.root.classList.toggle('music-marquee--menu', mode === 'menu');
  }

  setText(text: string | null): void {
    if (!text) {
      this.currentText = null;
      this.root.hidden = true;
      return;
    }
    if (text === this.currentText) return;
    this.currentText = text;
    this.root.hidden = false;
    for (const el of this.textEls) {
      el.textContent = text;
    }
    const track = this.root.querySelector('.music-marquee__track') as HTMLElement;
    track.style.animation = 'none';
    void track.offsetWidth;
    track.style.animation = '';
  }

  remove(): void {
    this.root.remove();
  }
}
