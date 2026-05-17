import {
  BUTTON_SFX_PLAY_URL,
  BUTTON_SFX_PRESS_URLS,
  BUTTON_SFX_TARGET_URLS,
} from './ButtonSfxCatalog.ts';
import { SfxPool } from './SfxPool.ts';

const UI_BUTTON_SFX_VOLUME = 0.82;
const PLAY_BUTTON_ID = 'main-menu-play';

function pickRandom<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

function makePool(url: string, poolSize = 3): SfxPool {
  const source = new Audio(url);
  source.preload = 'auto';
  source.load();
  const pool = new SfxPool(source, poolSize);
  pool.warm();
  return pool;
}

export class UiButtonSfx {
  private readonly targetPools = BUTTON_SFX_TARGET_URLS.map((url) =>
    makePool(url, 2),
  );
  private readonly pressPools = BUTTON_SFX_PRESS_URLS.map((url) =>
    makePool(url, 3),
  );
  private readonly playPool = makePool(BUTTON_SFX_PLAY_URL, 2);
  private lastHoverButton: HTMLButtonElement | null = null;

  private readonly onPointerOver = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') return;
    const btn = this.resolveHoverButton(e.target, e.relatedTarget);
    if (!btn || btn === this.lastHoverButton) return;
    this.lastHoverButton = btn;
    pickRandom(this.targetPools).play(UI_BUTTON_SFX_VOLUME, 1);
  };

  private readonly onPointerOut = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') return;
    const btn = this.resolveButton(e.target);
    if (!btn || btn !== this.lastHoverButton) return;
    const related = e.relatedTarget;
    if (related instanceof Node && btn.contains(related)) return;
    this.lastHoverButton = null;
  };

  private readonly onClick = (e: MouseEvent): void => {
    const btn = this.resolveButton(e.target);
    if (!btn || btn.disabled) return;
    if (this.isPlayButton(btn)) {
      this.playPool.play(UI_BUTTON_SFX_VOLUME, 1);
      return;
    }
    pickRandom(this.pressPools).play(UI_BUTTON_SFX_VOLUME, 1);
  };

  mount(): void {
    document.addEventListener('pointerover', this.onPointerOver, true);
    document.addEventListener('pointerout', this.onPointerOut, true);
    document.addEventListener('click', this.onClick, true);
  }

  unmount(): void {
    document.removeEventListener('pointerover', this.onPointerOver, true);
    document.removeEventListener('pointerout', this.onPointerOut, true);
    document.removeEventListener('click', this.onClick, true);
    this.lastHoverButton = null;
  }

  private isPlayButton(btn: HTMLButtonElement): boolean {
    return btn.id === PLAY_BUTTON_ID;
  }

  private resolveButton(target: EventTarget | null): HTMLButtonElement | null {
    if (!(target instanceof Element)) return null;
    const btn = target.closest('button');
    return btn instanceof HTMLButtonElement ? btn : null;
  }

  private resolveHoverButton(
    target: EventTarget | null,
    relatedTarget: EventTarget | null,
  ): HTMLButtonElement | null {
    const btn = this.resolveButton(target);
    if (!btn || !this.isHoverSoundButton(btn)) return null;
    if (relatedTarget instanceof Node && btn.contains(relatedTarget)) return null;
    return btn;
  }

  private isHoverSoundButton(btn: HTMLButtonElement): boolean {
    if (btn.disabled) return false;
    return !!(
      btn.closest('.game-overlay--menu') ||
      btn.closest('.game-overlay--pause') ||
      btn.closest('.game-overlay--death')
    );
  }
}
