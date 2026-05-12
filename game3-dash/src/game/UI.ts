import { CONFIG } from './config.ts';
import type { BeatEvent } from './Beatmap.ts';
import {
  ARTIFACT_IDS,
  ARTIFACT_LABELS,
  isArtifactEnabled,
  loadArtifacts,
  setArtifactEnabled,
} from './Artifacts.ts';
import {
  balanceLimits,
  getBalanceSnapshot,
  getPlayerMaxHp,
  loadBalanceSettings,
  setBalancePatch,
} from './BalanceSettings.ts';

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
  private readonly hpBarsBottom: HTMLElement;
  private readonly hpBarSegments: HTMLElement[] = [];
  private readonly hpBarRegenFills: HTMLElement[] = [];
  private readonly enemiesEl: HTMLElement;
  private readonly runKillsEl: HTMLElement;
  private readonly runXpTextEl: HTMLElement;
  private readonly runXpFillEl: HTMLElement;
  private readonly runLevelEl: HTMLElement;
  private readonly dashEl: HTMLElement;
  private readonly fpsEl: HTMLElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly audioTimeEl: HTMLElement;
  private readonly nextBeatEl: HTMLElement;
  private readonly beatmapStateEl: HTMLElement;
  private readonly beatHitCountEl: HTMLElement;
  private readonly beatLaneHost: HTMLElement;
  private readonly beatRoundTimerEl: HTMLElement;
  private readonly beatLaneCanvas: HTMLCanvasElement;
  private beatLaneCtx: CanvasRenderingContext2D | null;
  private readonly lensSlider: HTMLInputElement;
  private readonly lensValEl: HTMLElement;
  private lensDistortionHandler: ((amount: number) => void) | null = null;
  private readonly overscanSlider: HTMLInputElement;
  private readonly overscanValEl: HTMLElement;
  private lensOverscanHandler: ((overscan: number) => void) | null = null;
  private readonly mainMenuEl: HTMLElement;
  private readonly mainMenuPanel: HTMLElement;
  private readonly upgradeMenuPanel: HTMLElement;
  private readonly upgradeDashLen: HTMLInputElement;
  private readonly upgradeDashLenVal: HTMLElement;
  private readonly upgradeDashNomLen: HTMLInputElement;
  private readonly upgradeDashNomLenVal: HTMLElement;
  private readonly upgradeDashRadius: HTMLInputElement;
  private readonly upgradeDashRadiusVal: HTMLElement;
  private readonly upgradeMoveSpeed: HTMLInputElement;
  private readonly upgradeMoveSpeedVal: HTMLElement;
  private readonly upgradeShields: HTMLInputElement;
  private readonly upgradeShieldsVal: HTMLElement;
  private readonly deathScreenEl: HTMLElement;
  private readonly deathStatTimeEl: HTMLElement;
  private readonly deathStatKillsEl: HTMLElement;
  private readonly deathStatLevelEl: HTMLElement;
  private readonly runUpgradeOverlayEl: HTMLElement;
  private readonly runUpgradeMilestoneEl: HTMLElement;
  private runUpgradeOnDash: (() => void) | null = null;
  private runUpgradeOnShields: (() => void) | null = null;
  private runUpgradeOnShieldRegen: (() => void) | null = null;
  private runUpgradeOnSpeed: (() => void) | null = null;
  /** Full-viewport white flash on player damage (covers canvas + HUD). */
  private readonly damageFlashEl: HTMLElement;
  private readonly vaultBearingHost: HTMLElement;
  private readonly vaultBearingRot: SVGGElement;
  private artifactsChangeHandler: (() => void) | null = null;

  constructor(container: HTMLElement) {
    loadBalanceSettings();
    loadArtifacts();
    this.mount = container;
    const hud = document.createElement('div');
    hud.className = 'hud';
    hud.innerHTML = `
      <div class="hud-xp">
        <div class="hud-xp-row">
          <span class="hud-xp-meta__group"><span class="label">Уров.</span> <span id="hud-run-level" class="hud-xp-num">1</span></span>
          <span class="hud-xp-meta__group"><span class="label">XP</span> <span id="hud-run-xp-text" class="hud-xp-num">0 / 10</span></span>
        </div>
        <div class="hud-xp-bar" aria-hidden="true"><div id="hud-run-xp-fill" class="hud-xp-bar__fill"></div></div>
      </div>
      <div class="hud-row"><span class="label">Убито</span> <span id="hud-run-kills">0</span></div>
      <div class="hud-row"><span class="label">Enemies</span> <span id="hud-enemies">0</span></div>
      <div class="hud-row"><span class="label">Dash CD</span> <span id="hud-dash">Ready</span></div>
    `;
    container.appendChild(hud);
    this.runKillsEl = hud.querySelector('#hud-run-kills')!;
    this.runXpTextEl = hud.querySelector('#hud-run-xp-text')!;
    this.runXpFillEl = hud.querySelector('#hud-run-xp-fill')!;
    this.runLevelEl = hud.querySelector('#hud-run-level')!;
    this.enemiesEl = hud.querySelector('#hud-enemies')!;
    this.dashEl = hud.querySelector('#hud-dash')!;

    this.hpBarsBottom = document.createElement('div');
    this.hpBarsBottom.className = 'hp-bars-bottom';
    this.rebuildHpBarSegments();
    container.appendChild(this.hpBarsBottom);

    const fps = document.createElement('div');
    fps.className = 'fps-meter';
    fps.innerHTML = `<span class="fps-label">FPS</span> <span id="hud-fps">0</span>`;
    container.appendChild(fps);
    this.fpsEl = fps.querySelector('#hud-fps')!;

    const beatUi = document.createElement('div');
    beatUi.className = 'beat-ui';
    beatUi.innerHTML = `
      <button id="beat-play-btn" type="button">Play track</button>
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
      <div class="beat-lens-row">
        <div class="beat-lens-head">
          <span class="label">Lens Overscan</span>
          <span id="lens-overscan-val" class="beat-lens-val">1.35</span>
        </div>
        <input id="lens-overscan" type="range" min="1" max="2" step="0.01" value="1.35" />
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
    this.overscanSlider = beatUi.querySelector('#lens-overscan') as HTMLInputElement;
    this.overscanValEl = beatUi.querySelector('#lens-overscan-val')!;

    this.beatLaneHost = document.createElement('div');
    this.beatLaneHost.className = 'beat-lane-host';
    this.beatLaneHost.style.height = `${CONFIG.beatLaneHeightPx}px`;
    this.beatLaneCanvas = document.createElement('canvas');
    this.beatLaneCtx = this.beatLaneCanvas.getContext('2d');
    this.beatLaneHost.appendChild(this.beatLaneCanvas);

    this.beatRoundTimerEl = document.createElement('div');
    this.beatRoundTimerEl.className = 'beat-round-timer';
    this.beatRoundTimerEl.textContent = '0.00';
    this.beatRoundTimerEl.setAttribute('aria-label', 'Время раунда');

    const beatStack = document.createElement('div');
    beatStack.className = 'beat-lane-stack';
    beatStack.style.width = `${CONFIG.beatLaneWidthFraction * 100}%`;
    beatStack.appendChild(this.beatLaneHost);
    beatStack.appendChild(this.beatRoundTimerEl);
    container.insertBefore(beatStack, container.firstChild);
    this.resizeBeatLane();

    this.vaultBearingHost = document.createElement('div');
    this.vaultBearingHost.className = 'vault-bearing';
    this.vaultBearingHost.setAttribute('role', 'img');
    this.vaultBearingHost.setAttribute('aria-label', 'Направление на хранилище');
    this.vaultBearingHost.hidden = true;
    const pad = 56;
    const vb = CONFIG.vaultBearingArcRadiusPx + pad;
    this.vaultBearingHost.innerHTML = `
      <svg class="vault-bearing__svg" viewBox="${-vb} ${-vb} ${vb * 2} ${vb * 2}" preserveAspectRatio="xMidYMid meet">
        <g class="vault-bearing__rot" transform="rotate(0)">
          <path class="vault-bearing__arc" fill="none" stroke-linecap="round"/>
        </g>
      </svg>
    `;
    container.appendChild(this.vaultBearingHost);
    this.vaultBearingRot = this.vaultBearingHost.querySelector(
      '.vault-bearing__rot',
    ) as SVGGElement;
    const arcPath = this.vaultBearingHost.querySelector('.vault-bearing__arc') as SVGPathElement;
    const R = CONFIG.vaultBearingArcRadiusPx;
    const s = R * Math.SQRT1_2;
    arcPath.setAttribute(
      'd',
      `M ${s} ${-s} A ${R} ${R} 0 0 1 ${s} ${s}`,
    );

    this.buildArtifactsPanel(container);

    this.lensSlider.addEventListener('input', () => this.emitLensDistortion());
    this.overscanSlider.addEventListener('input', () => this.emitLensOverscan());

    this.mainMenuEl = document.createElement('div');
    this.mainMenuEl.className = 'game-overlay game-overlay--menu';
    this.mainMenuEl.setAttribute('role', 'dialog');
    this.mainMenuEl.setAttribute('aria-modal', 'true');
    const L = balanceLimits();
    const b = getBalanceSnapshot();
    this.mainMenuEl.innerHTML = `
      <div id="main-menu-panel" class="game-overlay__panel">
        <h1 class="game-overlay__title">Arena</h1>
        <button id="main-menu-play" type="button" class="game-overlay__btn">Play</button>
        <button id="main-menu-upgrade" type="button" class="game-overlay__btn game-overlay__btn--secondary">Апгрейд</button>
      </div>
      <div id="upgrade-menu-panel" class="game-overlay__panel game-overlay__panel--upgrade" hidden>
        <h2 class="game-overlay__subtitle">Апгрейд</h2>
        <div class="upgrade-menu__row">
          <div class="upgrade-menu__head">
            <span class="label">Длительность деша (с)</span>
            <span id="upgrade-dash-len-val" class="upgrade-menu__val">${b.dashDurationSec.toFixed(3)}</span>
          </div>
          <input id="upgrade-dash-len" type="range" min="${L.dashDurationSec.min}" max="${L.dashDurationSec.max}" step="0.005" value="${b.dashDurationSec}" />
        </div>
        <div class="upgrade-menu__row">
          <div class="upgrade-menu__head">
            <span class="label">Длина деша (мир)</span>
            <span id="upgrade-dash-nomlen-val" class="upgrade-menu__val">${b.dashNominalLengthWorld.toFixed(2)}</span>
          </div>
          <input id="upgrade-dash-nomlen" type="range" min="${L.dashNominalLengthWorld.min}" max="${L.dashNominalLengthWorld.max}" step="0.05" value="${b.dashNominalLengthWorld}" />
        </div>
        <div class="upgrade-menu__row">
          <div class="upgrade-menu__head">
            <span class="label">Радиус деша по умолчанию</span>
            <span id="upgrade-dash-radius-val" class="upgrade-menu__val">${b.dashKillRadiusScale.toFixed(2)}</span>
          </div>
          <input id="upgrade-dash-radius" type="range" min="${L.dashKillRadiusScale.min}" max="${L.dashKillRadiusScale.max}" step="0.05" value="${b.dashKillRadiusScale}" />
        </div>
        <div class="upgrade-menu__row">
          <div class="upgrade-menu__head">
            <span class="label">Скорость передвижения по умолчанию</span>
            <span id="upgrade-move-speed-val" class="upgrade-menu__val">${b.playerSpeed.toFixed(1)}</span>
          </div>
          <input id="upgrade-move-speed" type="range" min="${L.playerSpeed.min}" max="${L.playerSpeed.max}" step="0.5" value="${b.playerSpeed}" />
        </div>
        <div class="upgrade-menu__row">
          <div class="upgrade-menu__head">
            <span class="label">Щиты героя</span>
            <span id="upgrade-shields-val" class="upgrade-menu__val">${b.playerMaxHp}</span>
          </div>
          <input id="upgrade-shields" type="range" min="${L.playerMaxHp.min}" max="${L.playerMaxHp.max}" step="1" value="${b.playerMaxHp}" />
        </div>
        <button id="upgrade-back" type="button" class="game-overlay__btn game-overlay__btn--upgrade-back">Назад</button>
      </div>
    `;
    this.mainMenuEl.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
    });
    document.body.appendChild(this.mainMenuEl);

    this.mainMenuPanel = this.mainMenuEl.querySelector('#main-menu-panel')!;
    this.upgradeMenuPanel = this.mainMenuEl.querySelector('#upgrade-menu-panel')!;
    this.upgradeDashLen = this.mainMenuEl.querySelector('#upgrade-dash-len') as HTMLInputElement;
    this.upgradeDashLenVal = this.mainMenuEl.querySelector('#upgrade-dash-len-val')!;
    this.upgradeDashNomLen = this.mainMenuEl.querySelector('#upgrade-dash-nomlen') as HTMLInputElement;
    this.upgradeDashNomLenVal = this.mainMenuEl.querySelector('#upgrade-dash-nomlen-val')!;
    this.upgradeDashRadius = this.mainMenuEl.querySelector('#upgrade-dash-radius') as HTMLInputElement;
    this.upgradeDashRadiusVal = this.mainMenuEl.querySelector('#upgrade-dash-radius-val')!;
    this.upgradeMoveSpeed = this.mainMenuEl.querySelector('#upgrade-move-speed') as HTMLInputElement;
    this.upgradeMoveSpeedVal = this.mainMenuEl.querySelector('#upgrade-move-speed-val')!;
    this.upgradeShields = this.mainMenuEl.querySelector('#upgrade-shields') as HTMLInputElement;
    this.upgradeShieldsVal = this.mainMenuEl.querySelector('#upgrade-shields-val')!;
    this.bindUpgradeMenuControls();

    this.deathScreenEl = document.createElement('div');
    this.deathScreenEl.className = 'game-overlay game-overlay--death';
    this.deathScreenEl.hidden = true;
    this.deathScreenEl.setAttribute('role', 'dialog');
    this.deathScreenEl.setAttribute('aria-modal', 'true');
    this.deathScreenEl.innerHTML = `
      <div class="game-overlay__panel game-overlay__panel--death">
        <p class="game-overlay__death-title">You died</p>
        <div class="game-overlay__death-stats">
          <p><span class="game-overlay__death-stat-label">Время в ране</span> <span id="death-stat-time" class="game-overlay__death-stat-val">0.00</span> с</p>
          <p><span class="game-overlay__death-stat-label">Мобов убито</span> <span id="death-stat-kills" class="game-overlay__death-stat-val">0</span></p>
          <p><span class="game-overlay__death-stat-label">Уровень</span> <span id="death-stat-level" class="game-overlay__death-stat-val">1</span></p>
        </div>
        <p class="game-overlay__death-hint">Returning to the menu shortly, or press:</p>
        <button id="death-to-menu" type="button" class="game-overlay__btn game-overlay__btn--death">Main menu</button>
      </div>
    `;
    this.deathScreenEl.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
    });
    document.body.appendChild(this.deathScreenEl);
    this.deathStatTimeEl = this.deathScreenEl.querySelector('#death-stat-time')!;
    this.deathStatKillsEl = this.deathScreenEl.querySelector('#death-stat-kills')!;
    this.deathStatLevelEl = this.deathScreenEl.querySelector('#death-stat-level')!;

    this.runUpgradeOverlayEl = document.createElement('div');
    this.runUpgradeOverlayEl.className = 'game-overlay game-overlay--run-upgrade';
    this.runUpgradeOverlayEl.hidden = true;
    this.runUpgradeOverlayEl.setAttribute('role', 'dialog');
    this.runUpgradeOverlayEl.setAttribute('aria-modal', 'true');
    this.runUpgradeOverlayEl.innerHTML = `
      <div class="game-overlay__panel game-overlay__panel--run-upgrade">
        <h2 class="game-overlay__title">Прокачка</h2>
        <p class="game-overlay__run-upgrade-hint">
          Набрано <span id="run-upgrade-milestone">10</span> XP (уровень). Выберите один бонус до конца рана:
        </p>
        <button id="run-upgrade-dash" type="button" class="game-overlay__btn">Дальность дэша +1</button>
        <button id="run-upgrade-speed" type="button" class="game-overlay__btn game-overlay__btn--secondary">Скорость персонажа +1</button>
        <button id="run-upgrade-shields" type="button" class="game-overlay__btn game-overlay__btn--secondary">Щиты +1</button>
        <button id="run-upgrade-shield-regen" type="button" class="game-overlay__btn game-overlay__btn--secondary">Реген щитов −0.5 с (до ${CONFIG.shieldRegenMinIntervalSec} с)</button>
      </div>
    `;
    this.runUpgradeOverlayEl.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
    });
    document.body.appendChild(this.runUpgradeOverlayEl);
    this.runUpgradeMilestoneEl = this.runUpgradeOverlayEl.querySelector(
      '#run-upgrade-milestone',
    )!;
    this.runUpgradeOverlayEl.querySelector('#run-upgrade-dash')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.runUpgradeOnDash?.();
    });
    this.runUpgradeOverlayEl.querySelector('#run-upgrade-speed')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.runUpgradeOnSpeed?.();
    });
    this.runUpgradeOverlayEl.querySelector('#run-upgrade-shields')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.runUpgradeOnShields?.();
    });
    this.runUpgradeOverlayEl.querySelector('#run-upgrade-shield-regen')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.runUpgradeOnShieldRegen?.();
    });

    this.damageFlashEl = document.createElement('div');
    this.damageFlashEl.className = 'damage-screen-flash';
    this.damageFlashEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(this.damageFlashEl);
  }

  /** Brief white fullscreen flash when the hero loses HP. */
  triggerDamageScreenFlash(): void {
    const el = this.damageFlashEl;
    el.style.transition = 'none';
    el.style.opacity = '0.36';
    requestAnimationFrame(() => {
      void el.offsetHeight;
      el.style.transition = 'opacity 0.2s ease-out';
      el.style.opacity = '0';
    });
  }

  /** Remove fullscreen menu overlays from the document (call from Game.dispose). */
  disposeMenuOverlays(): void {
    this.mainMenuEl.remove();
    this.deathScreenEl.remove();
    this.runUpgradeOverlayEl.remove();
    this.damageFlashEl.remove();
  }

  showRunUpgradeModal(opts: {
    milestoneXp: number;
    onDash: () => void;
    onSpeed: () => void;
    onShields: () => void;
    onShieldRegen: () => void;
  }): void {
    this.runUpgradeMilestoneEl.textContent = String(opts.milestoneXp);
    this.runUpgradeOnDash = opts.onDash;
    this.runUpgradeOnSpeed = opts.onSpeed;
    this.runUpgradeOnShields = opts.onShields;
    this.runUpgradeOnShieldRegen = opts.onShieldRegen;
    this.runUpgradeOverlayEl.hidden = false;
  }

  /** Progress within current level: `totalXp % xpPerLevel` / `xpPerLevel`. */
  setRunXp(totalXp: number, xpPerLevel: number): void {
    const per = Math.max(1, Math.floor(xpPerLevel));
    const t = Math.max(0, Math.floor(Number.isFinite(totalXp) ? totalXp : 0));
    const inLevel = t % per;
    const level = 1 + Math.floor(t / per);
    this.runLevelEl.textContent = String(level);
    this.runXpTextEl.textContent = `${inLevel} / ${per}`;
    const pct = (inLevel / per) * 100;
    this.runXpFillEl.style.width = `${pct}%`;
  }

  setDeathScreenRunSummary(opts: {
    survivedSec: number;
    kills: number;
    level: number;
  }): void {
    const sec = Math.max(0, Number.isFinite(opts.survivedSec) ? opts.survivedSec : 0);
    this.deathStatTimeEl.textContent = sec.toFixed(2);
    this.deathStatKillsEl.textContent = String(Math.max(0, Math.floor(opts.kills)));
    this.deathStatLevelEl.textContent = String(Math.max(1, Math.floor(opts.level)));
  }

  hideRunUpgradeModal(): void {
    this.runUpgradeOverlayEl.hidden = true;
    this.runUpgradeOnDash = null;
    this.runUpgradeOnSpeed = null;
    this.runUpgradeOnShields = null;
    this.runUpgradeOnShieldRegen = null;
  }

  /** Rebuild bottom HP bar segments when max shields change (upgrade menu). */
  rebuildHpBarSegments(): void {
    this.hpBarsBottom.replaceChildren();
    this.hpBarSegments.length = 0;
    this.hpBarRegenFills.length = 0;
    const n = getPlayerMaxHp();
    for (let i = 0; i < n; i++) {
      const seg = document.createElement('div');
      seg.className = 'hp-bar-segment';
      const regen = document.createElement('div');
      regen.className = 'hp-bar-segment__regen';
      regen.setAttribute('aria-hidden', 'true');
      seg.appendChild(regen);
      this.hpBarsBottom.appendChild(seg);
      this.hpBarSegments.push(seg);
      this.hpBarRegenFills.push(regen);
    }
  }

  private syncUpgradeControlsFromBalance(): void {
    const b = getBalanceSnapshot();
    this.upgradeDashLen.value = String(b.dashDurationSec);
    this.upgradeDashLenVal.textContent = b.dashDurationSec.toFixed(3);
    this.upgradeDashNomLen.value = String(b.dashNominalLengthWorld);
    this.upgradeDashNomLenVal.textContent = b.dashNominalLengthWorld.toFixed(2);
    this.upgradeDashRadius.value = String(b.dashKillRadiusScale);
    this.upgradeDashRadiusVal.textContent = b.dashKillRadiusScale.toFixed(2);
    this.upgradeMoveSpeed.value = String(b.playerSpeed);
    this.upgradeMoveSpeedVal.textContent = b.playerSpeed.toFixed(1);
    this.upgradeShields.value = String(b.playerMaxHp);
    this.upgradeShieldsVal.textContent = String(b.playerMaxHp);
  }

  private openUpgradeMenu(): void {
    this.syncUpgradeControlsFromBalance();
    this.mainMenuPanel.hidden = true;
    this.upgradeMenuPanel.hidden = false;
  }

  private closeUpgradeMenu(): void {
    this.upgradeMenuPanel.hidden = true;
    this.mainMenuPanel.hidden = false;
  }

  private bindUpgradeMenuControls(): void {
    this.mainMenuEl.querySelector('#main-menu-upgrade')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openUpgradeMenu();
    });
    this.mainMenuEl.querySelector('#upgrade-back')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeUpgradeMenu();
    });

    this.upgradeDashLen.addEventListener('input', () => {
      const v = parseFloat(this.upgradeDashLen.value);
      setBalancePatch({ dashDurationSec: v });
      this.upgradeDashLenVal.textContent =
        getBalanceSnapshot().dashDurationSec.toFixed(3);
    });
    this.upgradeDashNomLen.addEventListener('input', () => {
      const v = parseFloat(this.upgradeDashNomLen.value);
      setBalancePatch({ dashNominalLengthWorld: v });
      this.upgradeDashNomLenVal.textContent =
        getBalanceSnapshot().dashNominalLengthWorld.toFixed(2);
    });
    this.upgradeDashRadius.addEventListener('input', () => {
      const v = parseFloat(this.upgradeDashRadius.value);
      setBalancePatch({ dashKillRadiusScale: v });
      this.upgradeDashRadiusVal.textContent =
        getBalanceSnapshot().dashKillRadiusScale.toFixed(2);
    });
    this.upgradeMoveSpeed.addEventListener('input', () => {
      const v = parseFloat(this.upgradeMoveSpeed.value);
      setBalancePatch({ playerSpeed: v });
      this.upgradeMoveSpeedVal.textContent =
        getBalanceSnapshot().playerSpeed.toFixed(1);
    });
    this.upgradeShields.addEventListener('input', () => {
      const v = Math.round(parseFloat(this.upgradeShields.value));
      setBalancePatch({ playerMaxHp: v });
      const b = getBalanceSnapshot();
      this.upgradeShieldsVal.textContent = String(b.playerMaxHp);
      this.rebuildHpBarSegments();
    });
  }

  private emitLensDistortion(): void {
    const v = parseFloat(this.lensSlider.value);
    this.lensValEl.textContent = v.toFixed(2);
    this.lensDistortionHandler?.(v);
  }

  private emitLensOverscan(): void {
    const v = parseFloat(this.overscanSlider.value);
    this.overscanValEl.textContent = v.toFixed(2);
    this.lensOverscanHandler?.(v);
  }

  onLensDistortionChange(handler: (amount: number) => void): void {
    this.lensDistortionHandler = handler;
    this.emitLensDistortion();
  }

  onLensOverscanChange(handler: (overscan: number) => void): void {
    this.lensOverscanHandler = handler;
    this.emitLensOverscan();
  }

  onArtifactsChange(handler: () => void): void {
    this.artifactsChangeHandler = handler;
  }

  private buildArtifactsPanel(container: HTMLElement): void {
    const panel = document.createElement('aside');
    panel.className = 'artifacts-panel';
    panel.setAttribute('aria-label', 'Артефакты');
    const title = document.createElement('div');
    title.className = 'artifacts-panel__title';
    title.textContent = 'Артефакты';
    panel.appendChild(title);
    for (const id of ARTIFACT_IDS) {
      const row = document.createElement('label');
      row.className = 'artifacts-row';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'artifacts-row__toggle';
      input.checked = isArtifactEnabled(id);
      input.addEventListener('change', () => {
        setArtifactEnabled(id, input.checked);
        this.artifactsChangeHandler?.();
      });
      const span = document.createElement('span');
      span.className = 'artifacts-row__text';
      span.textContent = ARTIFACT_LABELS[id];
      row.appendChild(input);
      row.appendChild(span);
      panel.appendChild(row);
    }
    container.appendChild(panel);
  }

  /** Enemies removed during the current run (dash, pulse, etc.). */
  setRunKills(count: number): void {
    const n = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
    this.runKillsEl.textContent = String(n);
  }

  /** Seconds elapsed in the current run (gameplay); menu uses `0`. */
  setRunRoundElapsedSec(sec: number): void {
    const s = Number.isFinite(sec) ? Math.max(0, sec) : 0;
    this.beatRoundTimerEl.textContent = s.toFixed(2);
  }

  /**
   * Bearing from **viewport center** toward vault on screen (rad); `0` = to the right, `π/2` = down.
   * `null` hides the arc.
   */
  setVaultBearingAngle(angleRad: number | null): void {
    if (angleRad === null || !Number.isFinite(angleRad)) {
      this.vaultBearingHost.hidden = true;
      return;
    }
    this.vaultBearingHost.hidden = false;
    const deg = (angleRad * 180) / Math.PI;
    this.vaultBearingRot.setAttribute('transform', `rotate(${deg})`);
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
    heroDashing: boolean,
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
    const hitRingR =
      r *
      1.1 *
      CONFIG.beatLaneHitRingScale *
      (heroDashing ? CONFIG.beatLaneHitRingDashScaleMult : 1);

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

    const targetR = hitRingR;
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
        !onBeat &&
        audioTime > b.time + CONFIG.dashBeatWindowAfterSec;
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

  update(
    hp: number,
    maxHp: number,
    enemyCount: number,
    dashCooldownLeft: number,
    shieldRegenProgress = 0,
  ): void {
    const cur = Math.max(0, Math.min(maxHp, Math.ceil(hp)));
    const n = Math.min(this.hpBarSegments.length, maxHp);
    const p = Math.max(0, Math.min(1, Number.isFinite(shieldRegenProgress) ? shieldRegenProgress : 0));
    for (let i = 0; i < n; i++) {
      const filled = cur > i;
      const seg = this.hpBarSegments[i]!;
      seg.classList.toggle('hp-bar-segment--filled', filled);
      const regen = this.hpBarRegenFills[i];
      if (regen) {
        const active = !filled && i === cur && cur < maxHp && p > 0;
        regen.classList.toggle('hp-bar-segment__regen--active', active);
        regen.style.height = active ? `${p * 100}%` : '0%';
      }
    }
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

  onMainMenuPlay(handler: () => void): void {
    const btn = this.mainMenuEl.querySelector('#main-menu-play')!;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handler();
    });
  }

  onDeathMenuClick(handler: () => void): void {
    const btn = this.deathScreenEl.querySelector('#death-to-menu')!;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handler();
    });
  }

  showMainMenu(): void {
    this.mainMenuEl.hidden = false;
    this.closeUpgradeMenu();
  }

  hideMainMenu(): void {
    this.mainMenuEl.hidden = true;
  }

  showDeathScreen(): void {
    this.deathScreenEl.hidden = false;
  }

  hideDeathScreen(): void {
    this.deathScreenEl.hidden = true;
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
