import {
  getEssentialPreloadFailures,
  preloadCoreGameAssets,
  type PreloadGameAssetsResult,
} from './AssetPreloader.ts';
import { resolveStoredOrDefaultTrackStage } from './SelectedTape.ts';

const RING_RADIUS = 44;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export class LoadingScreen {
  private readonly root: HTMLElement;
  private readonly progressRing: SVGCircleElement;
  private readonly percentEl: HTMLElement;
  private readonly errorEl: HTMLElement;

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'loading-screen';
    this.root.className = 'loading-screen';
    this.root.setAttribute('role', 'progressbar');
    this.root.setAttribute('aria-valuemin', '0');
    this.root.setAttribute('aria-valuemax', '100');
    this.root.innerHTML = `
      <div class="loading-screen__inner">
        <svg class="loading-screen__svg" viewBox="0 0 100 100" aria-hidden="true">
          <circle class="loading-screen__track" cx="50" cy="50" r="${RING_RADIUS}" />
          <circle class="loading-screen__ring" cx="50" cy="50" r="${RING_RADIUS}" />
        </svg>
        <p class="loading-screen__label">LOADING</p>
        <p class="loading-screen__percent">0%</p>
        <p class="loading-screen__error" hidden></p>
      </div>
    `;
    this.progressRing = this.root.querySelector(
      '.loading-screen__ring',
    ) as SVGCircleElement;
    this.percentEl = this.root.querySelector(
      '.loading-screen__percent',
    ) as HTMLElement;
    this.errorEl = this.root.querySelector(
      '.loading-screen__error',
    ) as HTMLElement;
    this.progressRing.style.strokeDasharray = `${RING_CIRCUMFERENCE}`;
    this.progressRing.style.strokeDashoffset = `${RING_CIRCUMFERENCE}`;

    const flashingWarning = document.createElement('p');
    flashingWarning.className = 'flashing-lights-warning';
    flashingWarning.textContent = 'FLASHING LIGHTS WARNING';
    this.root.appendChild(flashingWarning);
  }

  mount(parent: HTMLElement = document.body): void {
    parent.appendChild(this.root);
  }

  setProgress(fraction: number): void {
    const clamped = Math.min(1, Math.max(0, fraction));
    const pct = Math.round(clamped * 100);
    this.root.setAttribute('aria-valuenow', String(pct));
    this.percentEl.textContent = `${pct}%`;
    this.progressRing.style.strokeDashoffset = `${RING_CIRCUMFERENCE * (1 - clamped)}`;
  }

  showError(message: string): void {
    this.errorEl.hidden = false;
    this.errorEl.textContent = message;
  }

  hide(): void {
    this.root.remove();
  }

  /** Preload assets; resolves false if essential assets failed. */
  async run(): Promise<boolean> {
    let result: PreloadGameAssetsResult = { failed: [] };
    try {
      result = await preloadCoreGameAssets(
        resolveStoredOrDefaultTrackStage(),
        (p) => this.setProgress(p.fraction),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.showError(message);
      return false;
    }

    const essentialFailures = getEssentialPreloadFailures(result);
    if (essentialFailures.length > 0) {
      const lines = essentialFailures
        .slice(0, 4)
        .map((f) => f.url)
        .join(', ');
      const more =
        essentialFailures.length > 4
          ? ` (+${essentialFailures.length - 4} more)`
          : '';
      this.showError(`Failed to load required assets: ${lines}${more}`);
      return false;
    }

    this.setProgress(1);
    return true;
  }
}
