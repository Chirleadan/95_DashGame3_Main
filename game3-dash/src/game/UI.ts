import { CONFIG } from './config.ts';
import type { BeatEvent } from './Beatmap.ts';

function lowerBeatIndex(beats: readonly BeatEvent[], minTime: number): number {
  let lo = 0;
  let hi = beats.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid]!.time < minTime) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

export class UI {
  private readonly mount: HTMLElement;
  private readonly hpEl: HTMLElement;
  private readonly enemiesEl: HTMLElement;
  private readonly dashEl: HTMLElement;
  private readonly fpsEl: HTMLElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly audioTimeEl: HTMLElement;
  private readonly nextBeatEl: HTMLElement;
  private readonly beatmapStateEl: HTMLElement;
  private readonly beatHitCountEl: HTMLElement;
  private readonly beatLaneHost: HTMLElement;
  private readonly beatLaneCanvas: HTMLCanvasElement;
  private beatLaneCtx: CanvasRenderingContext2D | null;
  private readonly lensSlider: HTMLInputElement;
  private readonly lensValEl: HTMLElement;
  private lensDistortionHandler: ((amount: number) => void) | null = null;

  constructor(container: HTMLElement) {
    this.mount = container;
    const hud = document.createElement('div');
    hud.className = 'hud';
    hud.innerHTML = `
      <div class="hud-row"><span class="label">HP</span> <span id="hud-hp">100</span></div>
      <div class="hud-row"><span class="label">Enemies</span> <span id="hud-enemies">0</span></div>
      <div class="hud-row"><span class="label">Dash CD</span> <span id="hud-dash">Ready</span></div>
    `;
    container.appendChild(hud);
    this.hpEl = hud.querySelector('#hud-hp')!;
    this.enemiesEl = hud.querySelector('#hud-enemies')!;
    this.dashEl = hud.querySelector('#hud-dash')!;

    const fps = document.createElement('div');
    fps.className = 'fps-meter';
    fps.innerHTML = `<span class="fps-label">FPS</span> <span id="hud-fps">0</span>`;
    container.appendChild(fps);
    this.fpsEl = fps.querySelector('#hud-fps')!;

    const beatUi = document.createElement('div');
    beatUi.className = 'beat-ui';
    beatUi.innerHTML = `
      <button id="beat-play-btn" type="button">Play</button>
      <div class="beat-debug-row"><span class="label">Audio</span> <span id="beat-audio-time">0.00s</span></div>
      <div class="beat-debug-row"><span class="label">Next</span> <span id="beat-next-time">-</span></div>
      <div class="beat-debug-row"><span class="label">On-beat</span> <span id="beat-hit-count">0</span></div>
      <div class="beat-lens-row">
        <div class="beat-lens-head">
          <span class="label">Lens Distortion</span>
          <span id="lens-distortion-val" class="beat-lens-val">0.15</span>
        </div>
        <input id="lens-distortion" type="range" min="0" max="0.5" step="0.01" value="0.15" />
      </div>
      <div class="beat-debug-row"><span class="label">State</span> <span id="beat-state">Loading...</span></div>
    `;
    container.appendChild(beatUi);
    this.playBtn = beatUi.querySelector('#beat-play-btn')!;
    this.audioTimeEl = beatUi.querySelector('#beat-audio-time')!;
    this.nextBeatEl = beatUi.querySelector('#beat-next-time')!;
    this.beatmapStateEl = beatUi.querySelector('#beat-state')!;
    this.beatHitCountEl = beatUi.querySelector('#beat-hit-count')!;
    this.lensSlider = beatUi.querySelector('#lens-distortion') as HTMLInputElement;
    this.lensValEl = beatUi.querySelector('#lens-distortion-val')!;

    this.beatLaneHost = document.createElement('div');
    this.beatLaneHost.className = 'beat-lane-host';
    this.beatLaneHost.style.width = `${CONFIG.beatLaneWidthFraction * 100}%`;
    this.beatLaneHost.style.height = `${CONFIG.beatLaneHeightPx}px`;
    this.beatLaneCanvas = document.createElement('canvas');
    this.beatLaneCtx = this.beatLaneCanvas.getContext('2d');
    this.beatLaneHost.appendChild(this.beatLaneCanvas);
    container.insertBefore(this.beatLaneHost, container.firstChild);
    this.resizeBeatLane();

    this.lensSlider.addEventListener('input', () => this.emitLensDistortion());
  }

  private emitLensDistortion(): void {
    const v = parseFloat(this.lensSlider.value);
    this.lensValEl.textContent = v.toFixed(2);
    this.lensDistortionHandler?.(v);
  }

  onLensDistortionChange(handler: (amount: number) => void): void {
    this.lensDistortionHandler = handler;
    this.emitLensDistortion();
  }

  /** Call on window/mount resize so the lane matches width. */
  resizeBeatLane(): void {
    const mountW = this.mount.clientWidth || window.innerWidth;
    const wCss = Math.max(
      1,
      this.beatLaneHost.clientWidth ||
        Math.floor(mountW * CONFIG.beatLaneWidthFraction),
    );
    const hCss = CONFIG.beatLaneHeightPx;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.beatLaneCanvas.width = Math.max(1, Math.floor(wCss * dpr));
    this.beatLaneCanvas.height = Math.max(1, Math.floor(hCss * dpr));
    this.beatLaneCanvas.style.width = `${wCss}px`;
    this.beatLaneCanvas.style.height = `${hCss}px`;
  }

  /**
   * Rhythm-style lane: notes move right → left; at `audioTime === beat.time` the dot
   * crosses the horizontal center (hit line). Uses the same timestamps as gameplay beats.
   */
  updateBeatLane(
    audioTime: number,
    beats: readonly BeatEvent[] | null,
    hitBeatIndices: ReadonlySet<number>,
  ): void {
    const ctx = this.beatLaneCtx;
    if (!ctx) return;

    const mountW = this.mount.clientWidth || window.innerWidth;
    const wCss = Math.max(
      1,
      this.beatLaneHost.clientWidth ||
        Math.floor(mountW * CONFIG.beatLaneWidthFraction),
    );
    const hCss = CONFIG.beatLaneHeightPx;
    const dpr = Math.max(1, this.beatLaneCanvas.width / Math.max(1, wCss));
    const v = CONFIG.beatLaneScrollPxPerSec;
    const centerX = wCss * 0.5;
    const cy = hCss * 0.5;
    const r = CONFIG.beatLaneNoteRadiusPx;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, wCss, hCss);

    ctx.fillStyle = 'rgba(6, 8, 14, 0.78)';
    ctx.fillRect(0, 0, wCss, hCss);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, cy);
    ctx.lineTo(wCss, cy);
    ctx.stroke();

    ctx.fillStyle = 'rgba(120, 200, 255, 0.35)';
    ctx.fillRect(centerX - 1, 0, 2, hCss);

    const targetR = r * 1.1;
    ctx.beginPath();
    ctx.arc(centerX, cy, targetR, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(230, 245, 255, 0.85)';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    if (!beats || beats.length === 0 || v < 1e-3) {
      return;
    }

    const halfWin = wCss * 0.5;
    const tPad = (r + 4) / v;
    const tMin = audioTime - halfWin / v - tPad;
    const tMax = audioTime + halfWin / v + tPad;
    let i = lowerBeatIndex(beats, tMin);
    const n = beats.length;

    ctx.lineWidth = 1.5;

    for (; i < n; i++) {
      const b = beats[i]!;
      if (b.time > tMax) break;
      const x = centerX + (b.time - audioTime) * v;
      if (x < -r - 2 || x > wCss + r + 2) continue;
      const onBeat = hitBeatIndices.has(i);
      const missed =
        !onBeat && audioTime > b.time + CONFIG.dashBeatWindowAfterSec;
      if (missed) {
        ctx.fillStyle = 'rgba(140, 148, 168, 0.28)';
        ctx.strokeStyle = 'rgba(100, 108, 128, 0.32)';
      } else if (onBeat) {
        ctx.fillStyle = '#3cff7a';
        ctx.strokeStyle = 'rgba(10, 90, 40, 0.75)';
      } else {
        ctx.fillStyle = '#6ae8ff';
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
      }
      ctx.beginPath();
      ctx.arc(x, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  update(hp: number, enemyCount: number, dashCooldownLeft: number): void {
    this.hpEl.textContent = String(Math.max(0, Math.ceil(hp)));
    this.enemiesEl.textContent = String(enemyCount);
    if (dashCooldownLeft > 0) {
      this.dashEl.textContent =
        dashCooldownLeft < 0.15
          ? `${Math.max(0, Math.ceil(dashCooldownLeft * 1000))}ms`
          : `${dashCooldownLeft.toFixed(1)}s`;
    } else {
      this.dashEl.textContent = 'Ready';
    }
  }

  setFps(fps: number): void {
    this.fpsEl.textContent = String(Math.round(fps));
  }

  onPlayRequested(handler: () => void): void {
    this.playBtn.addEventListener('click', handler);
  }

  setPlayEnabled(enabled: boolean): void {
    this.playBtn.disabled = !enabled;
  }

  setBeatmapState(text: string): void {
    this.beatmapStateEl.textContent = text;
  }

  setBeatDebug(audioTime: number, nextBeatTime: number | null): void {
    this.audioTimeEl.textContent = `${audioTime.toFixed(2)}s`;
    this.nextBeatEl.textContent = nextBeatTime === null ? '-' : `${nextBeatTime.toFixed(2)}s`;
  }

  setBeatHitCount(count: number): void {
    this.beatHitCountEl.textContent = String(Math.max(0, count));
  }
}
