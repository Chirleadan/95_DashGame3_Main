import { CONFIG } from './config.ts';
import {
  getPlayerGold,
  loadPlayerGold,
  trySpendPlayerGold,
} from './PlayerGold.ts';
import type { BeatEvent } from './Beatmap.ts';
import {
  ARTIFACT_IDS,
  ARTIFACT_LABELS,
  isArtifactEnabled,
  loadArtifacts,
  setArtifactEnabled,
} from './Artifacts.ts';
import {
  type BalanceDiscreteStatKey,
  getBalanceSnapshot,
  getDiscreteLevelIndex,
  getDiscreteLevelValue,
  getDiscreteLevels,
  getMaxUnlockedLevelIndex,
  getPlayerMaxHp,
  getVaultMaxUnlockedLevel,
  setMaxUnlockedLevelIndex,
  unlockVaultMaxLevel,
  loadBalanceSettings,
  setBalancePatch,
} from './BalanceSettings.ts';
import {
  formatHighScoreScore,
  formatHighScoreTape,
  getHighScore,
  type HighScoreBoardId,
} from './HighScores.ts';
import {
  fetchLeaderboard,
  isLeaderboardApiConfigured,
  type LeaderboardEntry,
  type LeaderboardFetchFailure,
} from './leaderboard/LeaderboardApi.ts';
import { ensureOnlinePlayer } from './leaderboard/OnlinePlayerBootstrap.ts';
import {
  getRememberedNickname,
  getStoredPlayer,
} from './leaderboard/PlayerProfile.ts';
import {
  findTrackStage,
  findTrackForStage,
  getTapeStageMenuDescription,
  TRACK_CATALOG,
  type TrackStage,
} from './TrackCatalog.ts';
import { MusicMarquee } from './MusicMarquee.ts';
import { UiButtonSfx } from './UiButtonSfx.ts';
import {
  isDesktopMenuNoiseViewport,
  MENU_NOISE_WEBP_URLS,
  pickRandomMenuNoiseWebpUrl,
} from './MenuNoiseCatalog.ts';
import { getTapeCassetteImageUrl, TAPE_CASSETTES } from './TapeCatalog.ts';
import {
  getHighestUnlockedTrackStage,
  isTapeStagePlayable,
  isTapeStageUnlocked,
} from './TapeStageUnlocks.ts';
import { getRunUpgradeArtUrl } from './RunUpgradeArt.ts';

type UpgradeCellVisualState = 'selected' | 'open' | 'buyable' | 'locked';

type UpgradeCellRowConfig = {
  statKey: BalanceDiscreteStatKey;
  label: string;
};

const UPGRADE_CELL_ROWS: readonly UpgradeCellRowConfig[] = [
  { statKey: 'dashCooldownSec', label: 'Dash cooldown' },
  { statKey: 'dashNominalLengthWorld', label: 'Dash length' },
  { statKey: 'dashKillRadiusScale', label: 'Dash radius' },
  { statKey: 'playerSpeed', label: 'Move speed' },
  { statKey: 'playerMaxHp', label: 'Hero shields' },
];

type GuideTopicId = 'dash' | 'damage' | 'vaults' | 'enemies' | 'tape';

type GuideTopic = {
  id: GuideTopicId;
  label: string;
  gifUrl: string;
  webmUrl: string;
  body: string;
};

const GUIDE_TOPICS: readonly GuideTopic[] = [
  {
    id: 'dash',
    label: 'Dash Combat',
    gifUrl: '/assets/guides/Dash Combat.gif',
    webmUrl: '/assets/guides/dash-combat.webm',
    body:
      'Press Left Click to dash and kill enemies. Fast combo kills give more points.',
  },
  {
    id: 'damage',
    label: 'Damage',
    gifUrl: '/assets/guides/damage.gif',
    webmUrl: '/assets/guides/damage.webm',
    body:
      'Touch an enemy or projectile and you lose one shield. It also triggers a blast that kills nearby enemies.',
  },
  {
    id: 'vaults',
    label: 'Vaults',
    gifUrl: '/assets/guides/vault.gif',
    webmUrl: '/assets/guides/vault.webm',
    body:
      'Attack the vault and break its shields to level up and get a chance to drop a tape fragment.',
  },
  {
    id: 'enemies',
    label: 'Enemies',
    gifUrl: '/assets/guides/enemies.gif',
    webmUrl: '/assets/guides/enemies.webm',
    body:
      'There are different enemy types. Some have layers and need multiple hits; the longer you play, the more layers they get.',
  },
  {
    id: 'tape',
    label: 'Tape Mode',
    gifUrl: '/assets/guides/Tape Mode.gif',
    webmUrl: '/assets/guides/tape-mode.webm',
    body:
      'Press E to activate the tape and become invincible and get power-ups. Play the rhythm mini-game: missing the beat damages you.',
  },
];

function upgradeCellState(
  cellIndex: number,
  selectedIndex: number,
  maxUnlockedIndex: number,
): UpgradeCellVisualState {
  if (cellIndex === selectedIndex) return 'selected';
  if (cellIndex <= maxUnlockedIndex && cellIndex !== selectedIndex) return 'open';
  if (cellIndex === maxUnlockedIndex + 1) return 'buyable';
  return 'locked';
}

export type DitherUiSettings = {
  cssDotsEnabled: boolean;
  cssDotsOpacity: number;
  canvasDotsEnabled: boolean;
  canvasDotsOpacity: number;
  shaderDitherEnabled: boolean;
  shaderDitherStrength: number;
  shaderDotStrength: number;
};

export type RunUpgradeChoiceView = {
  id: string;
  label: string;
  description?: string;
  accentColor?: string;
  dropWeight?: number;
  secondary?: boolean;
};

/** Current / required mana shown above the beat-lane tape icon when too low to play. */
export type BeatLaneTapeManaDisplay = {
  current: number;
  required: number;
};

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
  private readonly musicMarquee: MusicMarquee;
  private readonly walletEl: HTMLElement;
  private readonly walletGoldEl: HTMLElement;
  private readonly walletManaGroupEl: HTMLElement;
  private readonly walletManaEl: HTMLElement;
  private readonly hudEl: HTMLElement;
  private readonly hudExtraEl: HTMLElement;
  private readonly beatUiEl: HTMLElement;
  private readonly beatLaneStackEl: HTMLElement;
  private artifactsPanelEl!: HTMLElement;
  private readonly hpBarsBottom: HTMLElement;
  private readonly hpBarSegments: HTMLElement[] = [];
  private readonly hpBarRegenFills: HTMLElement[] = [];
  private readonly enemiesEl: HTMLElement;
  private readonly runKillsEl: HTMLElement;
  private readonly runGoldEl: HTMLElement;
  private readonly runManaEl: HTMLElement;
  private readonly runXpTextEl: HTMLElement;
  private readonly runXpFillEl: HTMLElement;
  private readonly runLevelEl: HTMLElement;
  private readonly dashEl: HTMLElement;
  private readonly fpsMeterEl: HTMLElement;
  private readonly fpsEl: HTMLElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly playTrackPromptEl: HTMLElement;
  private readonly audioTimeEl: HTMLElement;
  private readonly nextBeatEl: HTMLElement;
  private readonly beatmapStateEl: HTMLElement;
  private readonly beatHitCountEl: HTMLElement;
  private readonly beatLaneHost: HTMLElement;
  private readonly beatLaneTapeStackEl: HTMLElement;
  private readonly beatLaneTapeManaEl: HTMLElement;
  private readonly beatLaneTapeIconEl: HTMLImageElement;
  private readonly beatRoundTimerEl: HTMLElement;
  private readonly beatLaneCanvas: HTMLCanvasElement;
  private beatLaneCtx: CanvasRenderingContext2D | null;
  private readonly lensSlider: HTMLInputElement;
  private readonly lensValEl: HTMLElement;
  private lensDistortionHandler: ((amount: number) => void) | null = null;
  private readonly overscanSlider: HTMLInputElement;
  private readonly overscanValEl: HTMLElement;
  private lensOverscanHandler: ((overscan: number) => void) | null = null;
  private readonly bloomThresholdSlider: HTMLInputElement;
  private readonly bloomThresholdValEl: HTMLElement;
  private bloomThresholdHandler: ((threshold: number) => void) | null = null;
  private readonly bloomStrengthSlider: HTMLInputElement;
  private readonly bloomStrengthValEl: HTMLElement;
  private bloomStrengthHandler: ((strength: number) => void) | null = null;
  private readonly cssDotsToggle: HTMLInputElement;
  private readonly cssDotsOpacitySlider: HTMLInputElement;
  private readonly cssDotsOpacityValEl: HTMLElement;
  private readonly canvasDotsToggle: HTMLInputElement;
  private readonly canvasDotsOpacitySlider: HTMLInputElement;
  private readonly canvasDotsOpacityValEl: HTMLElement;
  private readonly shaderDitherToggle: HTMLInputElement;
  private readonly shaderDitherStrengthSlider: HTMLInputElement;
  private readonly shaderDitherStrengthValEl: HTMLElement;
  private readonly shaderDotStrengthSlider: HTMLInputElement;
  private readonly shaderDotStrengthValEl: HTMLElement;
  private ditherSettingsHandler: ((settings: DitherUiSettings) => void) | null = null;
  private readonly mainMenuEl: HTMLElement;
  private readonly mainMenuNoiseEl: HTMLImageElement;
  private mainMenuNoiseTimer: number | null = null;
  private mainMenuNoiseCurrentSrc: string | null = null;
  private readonly mainMenuPanel: HTMLElement;
  private readonly upgradeMenuPanel: HTMLElement;
  private readonly tapeMenuPanel: HTMLElement;
  private readonly tapeMenuHintEl: HTMLElement;
  private readonly tapeMenuCaptionEl: HTMLParagraphElement;
  private readonly tapeBackBtn: HTMLButtonElement;
  private tapeFragmentToastHideTimer: number | null = null;
  private readonly tapeFragmentToastEl: HTMLElement;
  private readonly titlesMenuPanel: HTMLElement;
  private readonly titlesBackBtn: HTMLButtonElement;
  private readonly upgradeBackBtn: HTMLButtonElement;
  private readonly guidesMenuPanel: HTMLElement;
  private readonly guidesMediaHost: HTMLElement;
  private readonly guidesVideoEl: HTMLVideoElement;
  private readonly guidesGifFallbackEl: HTMLImageElement;
  private readonly guidesLoadingEl: HTMLElement;
  private guideMediaRequestId = 0;
  private guideMediaLoadTimer: number | null = null;
  private readonly guidesTitleEl: HTMLElement;
  private readonly guidesBodyEl: HTMLElement;
  private readonly guidesNavEl: HTMLElement;
  private readonly guidesBackBtn: HTMLButtonElement;
  private selectedGuideId: GuideTopicId = GUIDE_TOPICS[0]!.id;
  private readonly highScoreMenuPanel: HTMLElement;
  private readonly highScoreBackBtn: HTMLButtonElement;
  private readonly highScoreMenuList: HTMLElement;
  private readonly globalLeaderboardListEl: HTMLElement;
  private readonly globalLeaderboardTabEls: HTMLButtonElement[];
  private globalLeaderboardCheatMode = false;
  private readonly nicknameModalEl: HTMLElement;
  private readonly nicknameInputEl: HTMLInputElement;
  private readonly tapeCassetteRack: HTMLElement;
  private readonly currentTrackEl: HTMLElement;
  private selectedTrackStageForUi: TrackStage | null = null;
  private readonly upgradeMenuRows: HTMLElement;
  private readonly upgradeVaultRow: HTMLElement;
  private readonly deathScreenEl: HTMLElement;
  private readonly deathStatTimeEl: HTMLElement;
  private readonly deathStatKillsEl: HTMLElement;
  private readonly deathStatLevelEl: HTMLElement;
  private readonly pauseOverlayEl: HTMLElement;
  private readonly runUpgradeOverlayEl: HTMLElement;
  private readonly runUpgradeMilestoneEl: HTMLElement;
  private readonly runUpgradeChoicesEl: HTMLElement;
  private runUpgradeChoiceHandler: ((id: string) => void) | null = null;
  private runUpgradeClickEnableAtMs = 0;
  /** Full-viewport white flash on player damage (covers canvas + HUD). */
  private readonly damageFlashEl: HTMLElement;
  private readonly vaultBearingHost: HTMLElement;
  private readonly vaultBearingRot: SVGGElement;
  private artifactsChangeHandler: (() => void) | null = null;
  private trackStageSelectHandler: ((stage: TrackStage) => void) | null = null;
  private readonly buttonSfx = new UiButtonSfx();

  constructor(container: HTMLElement) {
    loadBalanceSettings();
    loadPlayerGold();
    loadArtifacts();
    this.mount = container;
    this.musicMarquee = new MusicMarquee(container);

    this.walletEl = document.createElement('div');
    this.walletEl.className = 'hud-wallet';
    this.walletEl.innerHTML = `
      <span class="label">Gold</span>
      <span id="hud-wallet-gold" class="hud-xp-num">0</span>
      <span class="hud-wallet__mana-group">
        <span class="hud-wallet__loot-sep" aria-hidden="true">·</span>
        <span class="label hud-wallet__mana-label">Mana</span>
        <span id="hud-wallet-mana" class="hud-xp-num hud-wallet__mana-num">0</span>
      </span>
    `;
    container.appendChild(this.walletEl);
    this.walletGoldEl = this.walletEl.querySelector('#hud-wallet-gold')!;
    this.walletManaGroupEl = this.walletEl.querySelector('.hud-wallet__mana-group')!;
    this.walletManaEl = this.walletEl.querySelector('#hud-wallet-mana')!;
    this.setWalletDisplay(getPlayerGold(), null);

    this.hudEl = document.createElement('div');
    this.hudEl.className = 'hud';
    this.hudEl.innerHTML = `
      <div class="hud-xp">
        <div class="hud-xp-row">
          <span class="hud-xp-meta__group"><span class="label">Lvl.</span> <span id="hud-run-level" class="hud-xp-num">1</span></span>
          <span class="hud-xp-meta__group"><span class="label">XP</span> <span id="hud-run-xp-text" class="hud-xp-num">0 / 10</span></span>
        </div>
        <div class="hud-xp-bar" aria-hidden="true"><div id="hud-run-xp-fill" class="hud-xp-bar__fill"></div></div>
      </div>
      <div class="hud__extra">
        <div class="hud-row"><span class="label">Kills</span> <span id="hud-run-kills">0</span></div>
      <div class="hud-row hud-row--loot"><span class="label">Gold</span> <span id="hud-run-gold" class="hud-xp-num">0</span><span class="hud-loot-sep" aria-hidden="true">·</span><span class="label">Mana</span> <span id="hud-run-mana" class="hud-xp-num">0</span></div>
      <div class="hud-row"><span class="label">Enemies</span> <span id="hud-enemies">0</span></div>
      <div class="hud-row"><span class="label">Dash CD</span> <span id="hud-dash">Ready</span></div>
      </div>
    `;
    this.hudExtraEl = this.hudEl.querySelector('.hud__extra')!;
    container.appendChild(this.hudEl);
    this.runKillsEl = this.hudEl.querySelector('#hud-run-kills')!;
    this.runGoldEl = this.hudEl.querySelector('#hud-run-gold')!;
    this.runManaEl = this.hudEl.querySelector('#hud-run-mana')!;
    this.runXpTextEl = this.hudEl.querySelector('#hud-run-xp-text')!;
    this.runXpFillEl = this.hudEl.querySelector('#hud-run-xp-fill')!;
    this.runLevelEl = this.hudEl.querySelector('#hud-run-level')!;
    this.enemiesEl = this.hudEl.querySelector('#hud-enemies')!;
    this.dashEl = this.hudEl.querySelector('#hud-dash')!;

    this.hpBarsBottom = document.createElement('div');
    this.hpBarsBottom.className = 'hp-bars-bottom';
    this.rebuildHpBarSegments();
    container.appendChild(this.hpBarsBottom);

    const fps = document.createElement('div');
    fps.className = 'fps-meter';
    fps.innerHTML = `<span class="fps-label">FPS</span> <span id="hud-fps">0</span>`;
    container.appendChild(fps);
    this.fpsMeterEl = fps;
    this.fpsEl = fps.querySelector('#hud-fps')!;

    const beatUi = document.createElement('div');
    beatUi.className = 'beat-ui';
    beatUi.innerHTML = `
      <button id="beat-play-btn" type="button">Play track (E)</button>
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
          <span id="lens-overscan-val" class="beat-lens-val">2.00</span>
        </div>
        <input id="lens-overscan" type="range" min="1" max="2" step="0.01" value="2" />
      </div>
      <div class="beat-lens-row">
        <div class="beat-lens-head">
          <span class="label">Glow Threshold</span>
          <span id="bloom-threshold-val" class="beat-lens-val">0.35</span>
        </div>
        <input id="bloom-threshold" type="range" min="0" max="1" step="0.01" value="0.35" />
      </div>
      <div class="beat-lens-row">
        <div class="beat-lens-head">
          <span class="label">Glow Strength</span>
          <span id="bloom-strength-val" class="beat-lens-val">0.30</span>
        </div>
        <input id="bloom-strength" type="range" min="0" max="3" step="0.01" value="0.30" />
      </div>
      <div class="beat-lens-row beat-lens-row--toggle">
        <label class="beat-toggle"><input id="css-dots-enabled" type="checkbox" /> CSS Dots</label>
        <div class="beat-lens-head">
          <span class="label">Dot Opacity</span>
          <span id="css-dots-opacity-val" class="beat-lens-val">0.18</span>
        </div>
        <input id="css-dots-opacity" type="range" min="0" max="0.6" step="0.01" value="0.18" />
      </div>
      <div class="beat-lens-row beat-lens-row--toggle">
        <label class="beat-toggle"><input id="canvas-dots-enabled" type="checkbox" /> Canvas Dither</label>
        <div class="beat-lens-head">
          <span class="label">Canvas Opacity</span>
          <span id="canvas-dots-opacity-val" class="beat-lens-val">0.20</span>
        </div>
        <input id="canvas-dots-opacity" type="range" min="0" max="0.7" step="0.01" value="0.20" />
      </div>
      <div class="beat-lens-row beat-lens-row--toggle">
        <label class="beat-toggle"><input id="shader-dither-enabled" type="checkbox" /> Shader Dither</label>
        <div class="beat-lens-head">
          <span class="label">Shader Strength</span>
          <span id="shader-dither-strength-val" class="beat-lens-val">0.35</span>
        </div>
        <input id="shader-dither-strength" type="range" min="0" max="1" step="0.01" value="0.35" />
        <div class="beat-lens-head">
          <span class="label">Shader Dots</span>
          <span id="shader-dot-strength-val" class="beat-lens-val">0.25</span>
        </div>
        <input id="shader-dot-strength" type="range" min="0" max="1" step="0.01" value="0.25" />
      </div>
      <div class="beat-debug-row"><span class="label">State</span> <span id="beat-state">Loading...</span></div>
    `;
    container.appendChild(beatUi);
    this.beatUiEl = beatUi;
    this.playTrackPromptEl = document.createElement('div');
    this.playTrackPromptEl.className = 'beat-play-prompt';
    this.playTrackPromptEl.hidden = true;
    this.playTrackPromptEl.innerHTML = `
      <span>PRESS <span class="beat-play-prompt__key">E</span> TO PLAY TAPE</span>
      <span>(ULTIMATE)</span>
    `;
    this.playBtn = beatUi.querySelector('#beat-play-btn')!;
    this.audioTimeEl = beatUi.querySelector('#beat-audio-time')!;
    this.nextBeatEl = beatUi.querySelector('#beat-next-time')!;
    this.beatmapStateEl = beatUi.querySelector('#beat-state')!;
    this.beatHitCountEl = beatUi.querySelector('#beat-hit-count')!;
    this.lensSlider = beatUi.querySelector('#lens-distortion') as HTMLInputElement;
    this.lensValEl = beatUi.querySelector('#lens-distortion-val')!;
    this.overscanSlider = beatUi.querySelector('#lens-overscan') as HTMLInputElement;
    this.overscanValEl = beatUi.querySelector('#lens-overscan-val')!;
    this.bloomThresholdSlider = beatUi.querySelector('#bloom-threshold') as HTMLInputElement;
    this.bloomThresholdValEl = beatUi.querySelector('#bloom-threshold-val')!;
    this.bloomStrengthSlider = beatUi.querySelector('#bloom-strength') as HTMLInputElement;
    this.bloomStrengthValEl = beatUi.querySelector('#bloom-strength-val')!;
    this.cssDotsToggle = beatUi.querySelector('#css-dots-enabled') as HTMLInputElement;
    this.cssDotsOpacitySlider = beatUi.querySelector('#css-dots-opacity') as HTMLInputElement;
    this.cssDotsOpacityValEl = beatUi.querySelector('#css-dots-opacity-val')!;
    this.canvasDotsToggle = beatUi.querySelector('#canvas-dots-enabled') as HTMLInputElement;
    this.canvasDotsOpacitySlider = beatUi.querySelector('#canvas-dots-opacity') as HTMLInputElement;
    this.canvasDotsOpacityValEl = beatUi.querySelector('#canvas-dots-opacity-val')!;
    this.shaderDitherToggle = beatUi.querySelector('#shader-dither-enabled') as HTMLInputElement;
    this.shaderDitherStrengthSlider = beatUi.querySelector('#shader-dither-strength') as HTMLInputElement;
    this.shaderDitherStrengthValEl = beatUi.querySelector('#shader-dither-strength-val')!;
    this.shaderDotStrengthSlider = beatUi.querySelector('#shader-dot-strength') as HTMLInputElement;
    this.shaderDotStrengthValEl = beatUi.querySelector('#shader-dot-strength-val')!;

    this.beatLaneHost = document.createElement('div');
    this.beatLaneHost.className = 'beat-lane-host';
    this.beatLaneHost.style.height = `${CONFIG.beatLaneHeightPx}px`;
    this.beatLaneCanvas = document.createElement('canvas');
    this.beatLaneCtx = this.beatLaneCanvas.getContext('2d');
    this.beatLaneTapeStackEl = document.createElement('div');
    this.beatLaneTapeStackEl.className = 'beat-lane-tape-stack';
    this.beatLaneTapeStackEl.hidden = true;
    this.beatLaneTapeManaEl = document.createElement('span');
    this.beatLaneTapeManaEl.className = 'beat-lane-tape-mana';
    this.beatLaneTapeManaEl.hidden = true;
    this.beatLaneTapeIconEl = document.createElement('img');
    this.beatLaneTapeIconEl.className = 'beat-lane-tape-icon';
    this.beatLaneTapeIconEl.alt = '';
    this.beatLaneTapeIconEl.draggable = false;
    this.beatLaneTapeStackEl.appendChild(this.beatLaneTapeIconEl);
    this.beatLaneTapeStackEl.appendChild(this.beatLaneTapeManaEl);
    this.beatLaneHost.appendChild(this.beatLaneCanvas);
    this.beatLaneHost.appendChild(this.beatLaneTapeStackEl);
    this.beatLaneHost.appendChild(this.playTrackPromptEl);

    this.beatRoundTimerEl = document.createElement('div');
    this.beatRoundTimerEl.className = 'beat-round-timer';
    this.beatRoundTimerEl.textContent = '0.00';
    this.beatRoundTimerEl.setAttribute('aria-label', 'Score');

    const beatStack = document.createElement('div');
    beatStack.className = 'beat-lane-stack';
    beatStack.style.width = `${CONFIG.beatLaneWidthFraction * 100}%`;
    beatStack.appendChild(this.beatLaneHost);
    beatStack.appendChild(this.beatRoundTimerEl);
    this.beatLaneStackEl = beatStack;
    container.insertBefore(beatStack, container.firstChild);
    this.resizeBeatLane();

    this.vaultBearingHost = document.createElement('div');
    this.vaultBearingHost.className = 'vault-bearing';
    this.vaultBearingHost.setAttribute('role', 'img');
    this.vaultBearingHost.setAttribute('aria-label', 'Direction to storage');
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

    this.artifactsPanelEl = this.buildArtifactsPanel(container);

    this.lensSlider.addEventListener('input', () => this.emitLensDistortion());
    this.overscanSlider.addEventListener('input', () => this.emitLensOverscan());
    this.bloomThresholdSlider.addEventListener('input', () => this.emitBloomThreshold());
    this.bloomStrengthSlider.addEventListener('input', () => this.emitBloomStrength());
    this.cssDotsToggle.addEventListener('change', () => this.emitDitherSettings());
    this.cssDotsOpacitySlider.addEventListener('input', () => this.emitDitherSettings());
    this.canvasDotsToggle.addEventListener('change', () => this.emitDitherSettings());
    this.canvasDotsOpacitySlider.addEventListener('input', () => this.emitDitherSettings());
    this.shaderDitherToggle.addEventListener('change', () => this.emitDitherSettings());
    this.shaderDitherStrengthSlider.addEventListener('input', () => this.emitDitherSettings());
    this.shaderDotStrengthSlider.addEventListener('input', () => this.emitDitherSettings());

    this.mainMenuEl = document.createElement('div');
    this.mainMenuEl.className = 'game-overlay game-overlay--menu';
    this.mainMenuEl.setAttribute('role', 'dialog');
    this.mainMenuEl.setAttribute('aria-modal', 'true');
    this.mainMenuEl.innerHTML = `
      <p class="flashing-lights-warning">FLASHING LIGHTS WARNING</p>
      <div class="main-menu-ui-scale">
      <div id="main-menu-panel" class="game-overlay__panel">
        <h1 class="game-overlay__title">Arena</h1>
        <div class="track-summary">
          <span class="track-summary__label">Track</span>
          <span id="main-menu-track-current" class="track-summary__value">Track 1 / Stage 3</span>
        </div>
        <div class="main-menu-actions">
          <button id="main-menu-play" type="button" class="game-overlay__btn">PLAY</button>
          <button id="main-menu-upgrade" type="button" class="game-overlay__btn game-overlay__btn--secondary">UPGRADES</button>
          <button id="main-menu-tracks" type="button" class="game-overlay__btn game-overlay__btn--secondary">TAPES</button>
        </div>
        <div class="main-menu-side-links">
          <button id="main-menu-guides" type="button" class="main-menu-side-btn">GUIDES</button>
          <button id="main-menu-highscore" type="button" class="main-menu-side-btn">BEST SCORE</button>
          <button id="main-menu-titles" type="button" class="main-menu-side-btn">TITLES</button>
          <label class="main-menu-cheatmode" data-tooltip="Cheat mode shows every level-up perk choice instead of rolling 3 random options.">
            <input id="main-menu-cheatmode" type="checkbox" />
            <span>Cheat mode</span>
          </label>
        </div>
      </div>
      <div id="tape-menu-panel" class="tape-cassette-rack" hidden></div>
      <button id="tape-back" type="button" class="game-overlay__btn game-overlay__btn--menu-sub-back" hidden>Back</button>
      <div id="guides-menu-panel" class="game-overlay__panel game-overlay__panel--guides" hidden>
        <div class="guides-menu">
          <h2 class="guides-menu__title"></h2>
          <p class="guides-menu__body"></p>
        </div>
      </div>
      <nav id="guides-nav" class="guides-nav" hidden aria-label="Guides"></nav>
      <button id="guides-back" type="button" class="game-overlay__btn game-overlay__btn--menu-sub-back" hidden>Back</button>
      <div id="highscore-menu-panel" class="game-overlay__panel game-overlay__panel--highscores" hidden>
        <div id="highscore-menu-list" class="highscore-menu"></div>
        <div id="global-leaderboard-panel" class="global-leaderboard" hidden>
          <p class="menu-sub-line menu-sub-line--heading global-leaderboard__title">Global Leaderboard</p>
          <div class="global-leaderboard__tabs" role="tablist">
            <button type="button" class="global-leaderboard__tab global-leaderboard__tab--active" data-cheat-mode="false">Normal</button>
            <button type="button" class="global-leaderboard__tab" data-cheat-mode="true">Cheat Mode</button>
          </div>
          <div id="global-leaderboard-list" class="global-leaderboard__list" aria-live="polite"></div>
        </div>
      </div>
      <div id="titles-menu-panel" class="game-overlay__panel game-overlay__panel--titles" hidden>
        <div class="titles-menu menu-sub-column"></div>
      </div>
      <button id="highscore-back" type="button" class="game-overlay__btn game-overlay__btn--menu-sub-back" hidden>Back</button>
      <button id="titles-back" type="button" class="game-overlay__btn game-overlay__btn--menu-sub-back" hidden>Back</button>
      <div id="upgrade-menu-panel" class="game-overlay__panel game-overlay__panel--upgrade" hidden>
        <h2 class="game-overlay__subtitle">Upgrade</h2>
        <p class="upgrade-menu__cost-hint">Next cell costs ${CONFIG.upgradeGoldCost} gold. White = active, gray = unlocked, gold = next buy.</p>
        <div id="upgrade-menu-rows" class="upgrade-menu__rows"></div>
        <div id="upgrade-vault-row" class="upgrade-menu__row"></div>
      </div>
      <button id="upgrade-back" type="button" class="game-overlay__btn game-overlay__btn--menu-sub-back" hidden>Back</button>
      </div>
    `;
    this.mainMenuEl.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
    });
    document.body.appendChild(this.mainMenuEl);

    this.mainMenuNoiseEl = document.createElement('img');
    this.mainMenuNoiseEl.className = 'main-menu-noise';
    this.mainMenuNoiseEl.alt = '';
    this.mainMenuNoiseEl.decoding = 'async';
    this.mainMenuNoiseEl.draggable = false;
    this.mainMenuEl.appendChild(this.mainMenuNoiseEl);
    window
      .matchMedia('(hover: hover) and (pointer: fine)')
      .addEventListener('change', () => this.refreshMainMenuNoise());

    const mainMenuUiScale = this.mainMenuEl.querySelector(
      '.main-menu-ui-scale',
    ) as HTMLElement;

    this.mainMenuPanel = this.mainMenuEl.querySelector('#main-menu-panel')!;
    this.tapeMenuPanel = this.mainMenuEl.querySelector('#tape-menu-panel')!;
    this.tapeMenuHintEl = document.createElement('div');
    this.tapeMenuHintEl.id = 'tape-menu-hint';
    this.tapeMenuHintEl.className = 'tape-menu-hint';
    this.tapeMenuHintEl.hidden = true;
    this.tapeMenuHintEl.innerHTML = `
      <p>Tapes are your ultimate abilities. Press <span class="tape-menu-hint__key">E</span> in-game to trigger your tape.${CONFIG.playTrackManaCostEnabled ? ' Using a tape costs Mana.' : ''}</p>
      <p>Choose one tape for each run.</p>
      <p>Each tape has 3 stages, unlocked by collecting tape fragments.</p>
      <p>Fragments can be found by breaking Vaults during the game.</p>
      <p>Each stage makes the tape hit harder.</p>
    `;
    mainMenuUiScale.appendChild(this.tapeMenuHintEl);

    this.tapeMenuCaptionEl = document.createElement('p');
    this.tapeMenuCaptionEl.id = 'tape-menu-caption';
    this.tapeMenuCaptionEl.className = 'tape-menu-caption';
    this.tapeMenuCaptionEl.hidden = true;
    mainMenuUiScale.appendChild(this.tapeMenuCaptionEl);

    this.tapeFragmentToastEl = document.createElement('div');
    this.tapeFragmentToastEl.className = 'tape-fragment-toast tape-fragment-toast--hidden';
    this.tapeFragmentToastEl.setAttribute('aria-live', 'polite');
    document.body.appendChild(this.tapeFragmentToastEl);

    this.tapeBackBtn = this.mainMenuEl.querySelector('#tape-back')!;
    this.titlesMenuPanel = this.mainMenuEl.querySelector('#titles-menu-panel')!;
    this.titlesBackBtn = this.mainMenuEl.querySelector('#titles-back')!;
    this.upgradeBackBtn = this.mainMenuEl.querySelector('#upgrade-back')!;
    this.guidesMenuPanel = this.mainMenuEl.querySelector('#guides-menu-panel')!;
    this.guidesTitleEl = this.guidesMenuPanel.querySelector('.guides-menu__title')!;
    this.guidesBodyEl = this.guidesMenuPanel.querySelector('.guides-menu__body')!;
    this.guidesNavEl = this.mainMenuEl.querySelector('#guides-nav')!;
    this.guidesBackBtn = this.mainMenuEl.querySelector('#guides-back')!;
    this.guidesMediaHost = document.createElement('div');
    this.guidesMediaHost.id = 'guides-menu-media';
    this.guidesMediaHost.className = 'guides-menu-media';
    this.guidesMediaHost.hidden = true;

    this.guidesVideoEl = document.createElement('video');
    this.guidesVideoEl.className = 'guides-menu-gif guides-menu-gif--video';
    this.guidesVideoEl.muted = true;
    this.guidesVideoEl.loop = true;
    this.guidesVideoEl.autoplay = true;
    this.guidesVideoEl.playsInline = true;
    this.guidesVideoEl.setAttribute('playsinline', '');
    this.guidesVideoEl.preload = 'auto';
    this.guidesVideoEl.disablePictureInPicture = true;
    this.guidesVideoEl.controls = false;
    this.guidesVideoEl.draggable = false;

    this.guidesGifFallbackEl = document.createElement('img');
    this.guidesGifFallbackEl.className = 'guides-menu-gif guides-menu-gif--fallback';
    this.guidesGifFallbackEl.alt = '';
    this.guidesGifFallbackEl.hidden = true;
    this.guidesGifFallbackEl.draggable = false;
    this.guidesGifFallbackEl.decoding = 'async';

    this.guidesLoadingEl = document.createElement('div');
    this.guidesLoadingEl.className = 'guides-menu-loading';
    this.guidesLoadingEl.textContent = 'Loading preview…';
    this.guidesLoadingEl.hidden = true;

    this.guidesMediaHost.append(
      this.guidesLoadingEl,
      this.guidesVideoEl,
      this.guidesGifFallbackEl,
    );
    mainMenuUiScale.appendChild(this.guidesMediaHost);
    this.buildGuidesMenu();
    this.highScoreMenuPanel = this.mainMenuEl.querySelector('#highscore-menu-panel')!;
    this.highScoreBackBtn = this.mainMenuEl.querySelector('#highscore-back')!;
    this.highScoreMenuList = this.mainMenuEl.querySelector('#highscore-menu-list')!;
    this.globalLeaderboardListEl = this.mainMenuEl.querySelector(
      '#global-leaderboard-list',
    )!;
    this.globalLeaderboardTabEls = Array.from(
      this.mainMenuEl.querySelectorAll<HTMLButtonElement>(
        '.global-leaderboard__tab',
      ),
    );
    const globalLeaderboardPanel = this.mainMenuEl.querySelector(
      '#global-leaderboard-panel',
    ) as HTMLElement | null;
    if (globalLeaderboardPanel) {
      globalLeaderboardPanel.hidden = !isLeaderboardApiConfigured();
    }
    for (const tab of this.globalLeaderboardTabEls) {
      tab.addEventListener('click', (e) => {
        e.stopPropagation();
        const cheatMode = tab.dataset.cheatMode === 'true';
        void this.setGlobalLeaderboardTab(cheatMode);
      });
    }

    this.nicknameModalEl = document.createElement('div');
    this.nicknameModalEl.id = 'nickname-modal';
    this.nicknameModalEl.className = 'nickname-modal';
    this.nicknameModalEl.hidden = true;
    this.nicknameModalEl.setAttribute('role', 'dialog');
    this.nicknameModalEl.setAttribute('aria-modal', 'true');
    this.nicknameModalEl.innerHTML = `
      <div class="nickname-modal__panel">
        <p class="menu-sub-line menu-sub-line--heading">Choose a nickname</p>
        <p class="menu-sub-line menu-sub-line--dim">Shown on the global leaderboard.</p>
        <input id="nickname-modal-input" class="nickname-modal__input" type="text" maxlength="24" autocomplete="nickname" placeholder="Nickname" />
        <div class="nickname-modal__actions">
          <button id="nickname-modal-ok" type="button" class="game-overlay__btn">OK</button>
          <button id="nickname-modal-skip" type="button" class="game-overlay__btn game-overlay__btn--secondary">Skip</button>
        </div>
      </div>
    `;
    document.body.appendChild(this.nicknameModalEl);
    this.nicknameInputEl = this.nicknameModalEl.querySelector(
      '#nickname-modal-input',
    ) as HTMLInputElement;

    this.buildTitlesMenu();
    this.buildHighScoreMenu();
    this.tapeCassetteRack = this.tapeMenuPanel;
    this.currentTrackEl = this.mainMenuEl.querySelector('#main-menu-track-current')!;
    this.upgradeMenuPanel = this.mainMenuEl.querySelector('#upgrade-menu-panel')!;
    this.upgradeMenuRows = this.mainMenuEl.querySelector('#upgrade-menu-rows')!;
    this.upgradeVaultRow = this.mainMenuEl.querySelector('#upgrade-vault-row')!;
    this.buildUpgradeCellRows();
    this.buildTapeCassetteRack();
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
          <p><span class="game-overlay__death-stat-label">Score</span> <span id="death-stat-time" class="game-overlay__death-stat-val">0</span></p>
          <p><span class="game-overlay__death-stat-label">Mobs killed</span> <span id="death-stat-kills" class="game-overlay__death-stat-val">0</span></p>
          <p><span class="game-overlay__death-stat-label">Level</span> <span id="death-stat-level" class="game-overlay__death-stat-val">1</span></p>
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

    this.pauseOverlayEl = document.createElement('div');
    this.pauseOverlayEl.className = 'game-overlay game-overlay--pause';
    this.pauseOverlayEl.hidden = true;
    this.pauseOverlayEl.setAttribute('role', 'dialog');
    this.pauseOverlayEl.setAttribute('aria-modal', 'true');
    this.pauseOverlayEl.setAttribute('aria-label', 'Pause');
    this.pauseOverlayEl.innerHTML = `
      <div class="pause-menu">
        <button id="pause-continue" type="button" class="pause-menu__btn">CONTINUE</button>
        <button id="pause-main-menu" type="button" class="pause-menu__btn">MAIN MENU</button>
      </div>
    `;
    this.pauseOverlayEl.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
    });
    document.body.appendChild(this.pauseOverlayEl);

    this.runUpgradeOverlayEl = document.createElement('div');
    this.runUpgradeOverlayEl.className = 'game-overlay game-overlay--run-upgrade';
    this.runUpgradeOverlayEl.hidden = true;
    this.runUpgradeOverlayEl.setAttribute('role', 'dialog');
    this.runUpgradeOverlayEl.setAttribute('aria-modal', 'true');
    this.runUpgradeOverlayEl.innerHTML = `
      <div class="game-overlay__panel game-overlay__panel--run-upgrade">
        <h2 class="game-overlay__title">Level Up</h2>
        <p class="game-overlay__run-upgrade-hint">
          Reached <span id="run-upgrade-milestone">10</span> XP. Choose one bonus for the rest of the run:
        </p>
        <div id="run-upgrade-choices" class="game-overlay__upgrade-choices"></div>
      </div>
    `;
    this.runUpgradeOverlayEl.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
    });
    document.body.appendChild(this.runUpgradeOverlayEl);
    this.runUpgradeMilestoneEl = this.runUpgradeOverlayEl.querySelector(
      '#run-upgrade-milestone',
    )!;
    this.runUpgradeChoicesEl = this.runUpgradeOverlayEl.querySelector(
      '#run-upgrade-choices',
    )!;
    this.runUpgradeChoicesEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const button = (e.target as HTMLElement).closest<HTMLButtonElement>(
        '[data-run-upgrade-id]',
      );
      if (!button) return;
      if (performance.now() < this.runUpgradeClickEnableAtMs) return;
      this.runUpgradeChoiceHandler?.(button.dataset.runUpgradeId ?? '');
    });

    this.damageFlashEl = document.createElement('div');
    this.damageFlashEl.className = 'damage-screen-flash';
    this.damageFlashEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(this.damageFlashEl);

    this.buttonSfx.mount();
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
  setMusicMarquee(text: string | null): void {
    this.musicMarquee.setText(text);
  }

  disposeMenuOverlays(): void {
    this.buttonSfx.unmount();
    this.musicMarquee.remove();
    this.mainMenuEl.remove();
    this.deathScreenEl.remove();
    this.runUpgradeOverlayEl.remove();
    this.damageFlashEl.remove();
  }

  showRunUpgradeModal(opts: {
    milestoneXp: number;
    choices: RunUpgradeChoiceView[];
    isCheatMode?: boolean;
    onChoice: (id: string) => void;
  }): void {
    this.runUpgradeMilestoneEl.textContent = String(opts.milestoneXp);
    this.runUpgradeChoiceHandler = opts.onChoice;
    this.runUpgradeClickEnableAtMs = performance.now() + 1000;
    this.runUpgradeChoicesEl.classList.toggle(
      'game-overlay__upgrade-choices--cards',
      !opts.isCheatMode,
    );
    this.runUpgradeChoicesEl.classList.toggle(
      'game-overlay__upgrade-choices--list',
      !!opts.isCheatMode,
    );
    this.runUpgradeChoicesEl.replaceChildren(
      ...opts.choices.map((choice) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.runUpgradeId = choice.id;
        if (choice.accentColor) {
          button.dataset.runUpgradeAccent = 'true';
          button.style.setProperty('--run-upgrade-accent', choice.accentColor);
        }
        if (opts.isCheatMode) {
          button.className = choice.secondary
            ? 'game-overlay__btn game-overlay__btn--secondary'
            : 'game-overlay__btn';
          button.textContent = choice.label;
        } else {
          button.className = 'run-upgrade-card';
          const title = document.createElement('span');
          title.className = 'run-upgrade-card__title';
          title.textContent = choice.label;
          const desc = document.createElement('span');
          desc.className = 'run-upgrade-card__desc';
          desc.textContent = choice.description ?? '';
          const artSlot = document.createElement('span');
          artSlot.className = 'run-upgrade-card__art';
          artSlot.setAttribute('aria-hidden', 'true');
          const artUrl = getRunUpgradeArtUrl(choice.id);
          if (artUrl) {
            artSlot.style.setProperty('--run-upgrade-art-url', `url("${artUrl}")`);
          }
          button.append(title, desc, artSlot);
        }
        return button;
      }),
    );
    this.runUpgradeOverlayEl.hidden = false;
  }

  /** Progress within current level: `xpInLevel / xpForNextLevel`. */
  setRunXp(level: number, xpInLevel: number, xpForNextLevel: number): void {
    const lv = Math.max(1, Math.floor(Number.isFinite(level) ? level : 1));
    const per = Math.max(1, Math.floor(Number.isFinite(xpForNextLevel) ? xpForNextLevel : 1));
    const inLevel = Math.max(0, Math.min(per, Math.floor(Number.isFinite(xpInLevel) ? xpInLevel : 0)));
    this.runLevelEl.textContent = String(lv);
    this.runXpTextEl.textContent = `${inLevel} / ${per}`;
    const pct = (inLevel / per) * 100;
    this.runXpFillEl.style.width = `${pct}%`;
  }

  setDeathScreenRunSummary(opts: {
    score: number;
    kills: number;
    level: number;
  }): void {
    const score = Math.max(0, Math.floor(Number.isFinite(opts.score) ? opts.score : 0));
    this.deathStatTimeEl.textContent = String(score);
    this.deathStatKillsEl.textContent = String(Math.max(0, Math.floor(opts.kills)));
    this.deathStatLevelEl.textContent = String(Math.max(1, Math.floor(opts.level)));
  }

  hideRunUpgradeModal(): void {
    this.runUpgradeOverlayEl.hidden = true;
    this.runUpgradeChoiceHandler = null;
    this.runUpgradeClickEnableAtMs = 0;
    this.runUpgradeChoicesEl.replaceChildren();
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

  private buildUpgradeCellRows(): void {
    this.upgradeMenuRows.replaceChildren();
    for (const row of UPGRADE_CELL_ROWS) {
      this.upgradeMenuRows.appendChild(this.createUpgradeStatRow(row));
    }
    this.refreshUpgradeVaultRow();
  }

  private createUpgradeStatRow(row: UpgradeCellRowConfig): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'upgrade-menu__row';
    wrap.dataset.upgradeRow = row.statKey;

    const head = document.createElement('div');
    head.className = 'upgrade-menu__head';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = row.label;
    head.appendChild(label);
    wrap.appendChild(head);

    const cells = document.createElement('div');
    cells.className = 'upgrade-cells';
    cells.dataset.upgradeCells = row.statKey;
    wrap.appendChild(cells);
    return wrap;
  }

  private refreshUpgradeCellRows(): void {
    const snap = getBalanceSnapshot();
    for (const row of UPGRADE_CELL_ROWS) {
      const host = this.upgradeMenuRows.querySelector<HTMLElement>(
        `[data-upgrade-cells="${row.statKey}"]`,
      );
      if (!host) continue;
      host.replaceChildren();
      const levels = getDiscreteLevels(row.statKey);
      const selectedIndex = getDiscreteLevelIndex(row.statKey, snap[row.statKey]);
      const maxUnlockedIndex = getMaxUnlockedLevelIndex(row.statKey);
      levels.forEach((_value, index) => {
        host.appendChild(
          this.createUpgradeCellButton(row.statKey, index, selectedIndex, maxUnlockedIndex, row.label),
        );
      });
    }
    this.refreshUpgradeVaultRow();
  }

  private refreshUpgradeVaultRow(): void {
    const enabled = isArtifactEnabled('vaultBearing');
    const selectedIndex = enabled ? 1 : 0;
    const maxUnlockedIndex = getVaultMaxUnlockedLevel();
    this.upgradeVaultRow.replaceChildren();
    this.upgradeVaultRow.dataset.upgradeRow = 'vaultBearing';

    const head = document.createElement('div');
    head.className = 'upgrade-menu__head';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = 'Storage pointer';
    head.appendChild(label);
    this.upgradeVaultRow.appendChild(head);

    const cells = document.createElement('div');
    cells.className = 'upgrade-cells';
    cells.dataset.upgradeCells = 'vaultBearing';
    for (const index of [0, 1]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'upgrade-cell';
      btn.dataset.upgradeKind = 'vault';
      btn.dataset.cellIndex = String(index);
      btn.setAttribute('aria-label', `${index === 0 ? 'Off' : 'On'} storage pointer`);
      const state = upgradeCellState(index, selectedIndex, maxUnlockedIndex);
      btn.classList.add(`upgrade-cell--${state}`);
      btn.disabled = state === 'locked' || state === 'selected';
      if (state === 'buyable') {
        btn.title = `${CONFIG.upgradeGoldCost} gold`;
      }
      cells.appendChild(btn);
    }
    this.upgradeVaultRow.appendChild(cells);
  }

  private createUpgradeCellButton(
    statKey: BalanceDiscreteStatKey,
    index: number,
    selectedIndex: number,
    maxUnlockedIndex: number,
    rowLabel: string,
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'upgrade-cell';
    btn.dataset.upgradeStat = statKey;
    btn.dataset.cellIndex = String(index);
    btn.setAttribute('aria-label', `${rowLabel} tier ${index + 1}`);
    const state = upgradeCellState(index, selectedIndex, maxUnlockedIndex);
    btn.classList.add(`upgrade-cell--${state}`);
    btn.disabled = state === 'locked' || state === 'selected';
    if (state === 'buyable') {
      btn.title = `${CONFIG.upgradeGoldCost} gold`;
    }
    return btn;
  }

  private onUpgradeCellClick(target: HTMLElement): void {
    const btn = target.closest<HTMLButtonElement>('.upgrade-cell');
    if (!btn || btn.disabled) return;

    const cellIndex = Number(btn.dataset.cellIndex);
    if (!Number.isFinite(cellIndex)) return;

    if (btn.dataset.upgradeKind === 'vault') {
      this.onUpgradeVaultCellClick(cellIndex);
      return;
    }

    const statKey = btn.dataset.upgradeStat as BalanceDiscreteStatKey | undefined;
    if (!statKey) return;

    const snap = getBalanceSnapshot();
    const selectedIndex = getDiscreteLevelIndex(statKey, snap[statKey]);
    const maxUnlockedIndex = getMaxUnlockedLevelIndex(statKey);
    if (cellIndex === selectedIndex) return;

    if (cellIndex <= maxUnlockedIndex) {
      setBalancePatch({ [statKey]: getDiscreteLevelValue(statKey, cellIndex) });
      if (statKey === 'playerMaxHp') {
        this.rebuildHpBarSegments();
      }
      this.refreshUpgradeCellRows();
      return;
    }

    if (cellIndex === maxUnlockedIndex + 1) {
      if (!trySpendPlayerGold()) return;
      setMaxUnlockedLevelIndex(statKey, cellIndex);
      setBalancePatch({ [statKey]: getDiscreteLevelValue(statKey, cellIndex) });
      if (statKey === 'playerMaxHp') {
        this.rebuildHpBarSegments();
      }
      this.setWalletGold(getPlayerGold());
      this.refreshUpgradeCellRows();
    }
  }

  private onUpgradeVaultCellClick(cellIndex: number): void {
    const enabled = isArtifactEnabled('vaultBearing');
    const selectedIndex = enabled ? 1 : 0;
    const maxUnlockedIndex = getVaultMaxUnlockedLevel();
    if (cellIndex === selectedIndex) return;

    if (cellIndex <= maxUnlockedIndex) {
      setArtifactEnabled('vaultBearing', cellIndex === 1);
      this.artifactsChangeHandler?.();
      this.refreshUpgradeVaultRow();
      return;
    }

    if (cellIndex === maxUnlockedIndex + 1) {
      if (!trySpendPlayerGold()) return;
      unlockVaultMaxLevel();
      setArtifactEnabled('vaultBearing', true);
      this.setWalletGold(getPlayerGold());
      this.artifactsChangeHandler?.();
      this.refreshUpgradeVaultRow();
    }
  }

  private syncUpgradeControlsFromBalance(): void {
    this.refreshUpgradeCellRows();
  }

  private setMainMenuHomePanelVisible(visible: boolean): void {
    this.mainMenuPanel.hidden = !visible;
    this.refreshMainMenuNoise();
  }

  private isMainMenuNoiseActive(): boolean {
    return (
      !this.mainMenuEl.hidden &&
      !this.mainMenuPanel.hidden &&
      isDesktopMenuNoiseViewport()
    );
  }

  private randomMenuNoiseDelayMs(): number {
    return 3000 + Math.floor(Math.random() * 2001);
  }

  private pickNextMenuNoiseWebpUrl(): string {
    if (MENU_NOISE_WEBP_URLS.length <= 1) {
      return pickRandomMenuNoiseWebpUrl();
    }
    let next = pickRandomMenuNoiseWebpUrl();
    for (let i = 0; i < 12 && next === this.mainMenuNoiseCurrentSrc; i++) {
      next = pickRandomMenuNoiseWebpUrl();
    }
    return next;
  }

  private clearMainMenuNoiseTimer(): void {
    if (this.mainMenuNoiseTimer == null) return;
    window.clearTimeout(this.mainMenuNoiseTimer);
    this.mainMenuNoiseTimer = null;
  }

  private hideMainMenuNoiseImage(): void {
    this.mainMenuNoiseEl.classList.remove('main-menu-noise--visible');
    this.mainMenuNoiseEl.removeAttribute('src');
    this.mainMenuNoiseCurrentSrc = null;
  }

  private showMainMenuNoiseImage(webpUrl: string): void {
    this.mainMenuNoiseCurrentSrc = webpUrl;
    this.mainMenuNoiseEl.classList.add('main-menu-noise--visible');
    this.mainMenuNoiseEl.onerror = () => {
      const pngUrl = webpUrl.replace(/\.webp$/i, '.png');
      if (this.mainMenuNoiseEl.getAttribute('src') !== pngUrl) {
        this.mainMenuNoiseEl.src = pngUrl;
      }
    };
    this.mainMenuNoiseEl.src = webpUrl;
  }

  private scheduleMainMenuNoiseStep(): void {
    this.clearMainMenuNoiseTimer();
    this.mainMenuNoiseTimer = window.setTimeout(() => {
      this.mainMenuNoiseTimer = null;
      this.stepMainMenuNoiseCycle();
    }, this.randomMenuNoiseDelayMs());
  }

  private stepMainMenuNoiseCycle(): void {
    if (!this.isMainMenuNoiseActive()) {
      this.clearMainMenuNoiseTimer();
      this.hideMainMenuNoiseImage();
      return;
    }

    const hasImage =
      this.mainMenuNoiseEl.classList.contains('main-menu-noise--visible') &&
      !!this.mainMenuNoiseEl.getAttribute('src');

    if (hasImage) {
      if (Math.random() < 0.5) {
        this.hideMainMenuNoiseImage();
      } else {
        this.showMainMenuNoiseImage(this.pickNextMenuNoiseWebpUrl());
      }
    } else {
      this.showMainMenuNoiseImage(this.pickNextMenuNoiseWebpUrl());
    }

    this.scheduleMainMenuNoiseStep();
  }

  private refreshMainMenuNoise(): void {
    this.clearMainMenuNoiseTimer();
    if (!this.isMainMenuNoiseActive()) {
      this.hideMainMenuNoiseImage();
      return;
    }

    if (Math.random() < 0.5) {
      this.hideMainMenuNoiseImage();
    } else {
      this.showMainMenuNoiseImage(this.pickNextMenuNoiseWebpUrl());
    }
    this.scheduleMainMenuNoiseStep();
  }

  private hideAllMenuSubpanels(): void {
    this.tapeMenuPanel.hidden = true;
    this.tapeMenuHintEl.hidden = true;
    this.tapeMenuCaptionEl.hidden = true;
    this.tapeBackBtn.hidden = true;
    this.upgradeMenuPanel.hidden = true;
    this.upgradeBackBtn.hidden = true;
    this.titlesMenuPanel.hidden = true;
    this.titlesBackBtn.hidden = true;
    this.guidesMenuPanel.hidden = true;
    this.pauseGuideMedia();
    this.guidesMediaHost.hidden = true;
    this.guidesNavEl.hidden = true;
    this.guidesBackBtn.hidden = true;
    this.highScoreMenuPanel.hidden = true;
    this.highScoreBackBtn.hidden = true;
  }

  private openUpgradeMenu(): void {
    this.syncUpgradeControlsFromBalance();
    this.setWalletGold(getPlayerGold());
    this.hideAllMenuSubpanels();
    this.setMainMenuHomePanelVisible(false);
    this.upgradeMenuPanel.hidden = false;
    this.upgradeBackBtn.hidden = false;
  }

  private closeUpgradeMenu(): void {
    this.hideAllMenuSubpanels();
    this.setMainMenuHomePanelVisible(true);
  }

  private buildGuidesMenu(): void {
    this.guidesNavEl.replaceChildren();
    for (const topic of GUIDE_TOPICS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'guides-nav__btn';
      btn.dataset.guideId = topic.id;
      btn.textContent = topic.label;
      btn.setAttribute('aria-pressed', 'false');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.selectGuideTopic(topic.id);
      });
      this.guidesNavEl.appendChild(btn);
    }
    this.selectGuideTopic(this.selectedGuideId);
  }

  private selectGuideTopic(id: GuideTopicId): void {
    const topic = GUIDE_TOPICS.find((entry) => entry.id === id) ?? GUIDE_TOPICS[0]!;
    this.selectedGuideId = topic.id;
    this.guidesTitleEl.textContent = topic.label;
    this.guidesBodyEl.textContent = topic.body;
    this.setGuideMedia(topic);
    const buttons = this.guidesNavEl.querySelectorAll<HTMLButtonElement>('.guides-nav__btn');
    for (const btn of buttons) {
      const active = btn.dataset.guideId === topic.id;
      btn.classList.toggle('guides-nav__btn--active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  private pauseGuideMedia(): void {
    this.clearGuideMediaLoadTimer();
    this.guidesVideoEl.pause();
  }

  private clearGuideMediaLoadTimer(): void {
    if (this.guideMediaLoadTimer == null) return;
    window.clearTimeout(this.guideMediaLoadTimer);
    this.guideMediaLoadTimer = null;
  }

  private showGuideLoading(): void {
    this.guidesLoadingEl.hidden = false;
    this.guidesVideoEl.hidden = true;
    this.guidesGifFallbackEl.hidden = true;
  }

  private hideGuideLoading(): void {
    this.guidesLoadingEl.hidden = true;
  }

  private isGuideMediaReady(): boolean {
    if (
      !this.guidesGifFallbackEl.hidden &&
      this.guidesGifFallbackEl.complete &&
      this.guidesGifFallbackEl.naturalWidth > 0
    ) {
      return true;
    }
    return (
      !this.guidesVideoEl.hidden &&
      this.guidesVideoEl.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
    );
  }

  private resumeGuideMedia(topic: GuideTopic): void {
    if (
      !this.guidesGifFallbackEl.hidden &&
      this.guidesGifFallbackEl.complete &&
      this.guidesGifFallbackEl.naturalWidth > 0
    ) {
      this.hideGuideLoading();
      return;
    }
    if (this.guidesVideoEl.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      this.hideGuideLoading();
      this.guidesGifFallbackEl.hidden = true;
      this.guidesVideoEl.hidden = false;
      void this.guidesVideoEl.play().catch(() =>
        this.showGuideGifFallback(topic, this.guideMediaRequestId),
      );
    }
  }

  private showGuideGifFallback(topic: GuideTopic, requestId: number): void {
    if (requestId !== this.guideMediaRequestId) return;
    if (this.guidesGifFallbackEl.dataset.guideId !== topic.id) return;

    this.guidesVideoEl.pause();
    this.guidesVideoEl.hidden = true;
    this.guidesGifFallbackEl.hidden = false;
    this.guidesGifFallbackEl.alt = topic.label;

    const revealGif = () => {
      if (requestId !== this.guideMediaRequestId) return;
      if (this.guidesGifFallbackEl.dataset.guideId !== topic.id) return;
      this.clearGuideMediaLoadTimer();
      this.hideGuideLoading();
    };

    this.guidesGifFallbackEl.onload = revealGif;
    this.guidesGifFallbackEl.onerror = () => {
      if (requestId !== this.guideMediaRequestId) return;
    };

    const gifSrc = `${encodeURI(topic.gifUrl)}?guide=${topic.id}`;
    if (this.guidesGifFallbackEl.getAttribute('src') !== gifSrc) {
      this.guidesGifFallbackEl.src = gifSrc;
    } else if (
      this.guidesGifFallbackEl.complete &&
      this.guidesGifFallbackEl.naturalWidth > 0
    ) {
      revealGif();
    }
  }

  private setGuideMedia(topic: GuideTopic): void {
    const requestId = ++this.guideMediaRequestId;
    this.clearGuideMediaLoadTimer();

    const sameTopic = this.guidesVideoEl.dataset.guideId === topic.id;
    if (sameTopic && this.isGuideMediaReady()) {
      this.resumeGuideMedia(topic);
      return;
    }

    this.guidesVideoEl.dataset.guideId = topic.id;
    this.guidesGifFallbackEl.dataset.guideId = topic.id;
    this.showGuideLoading();

    const webmSrc = `${encodeURI(topic.webmUrl)}?guide=${topic.id}`;

    const useGifFallback = () => {
      if (requestId !== this.guideMediaRequestId) return;
      this.showGuideGifFallback(topic, requestId);
    };

    this.guideMediaLoadTimer = window.setTimeout(() => {
      if (requestId !== this.guideMediaRequestId) return;
      useGifFallback();
    }, 12_000);

    this.guidesVideoEl.setAttribute('aria-label', topic.label);
    this.guidesVideoEl.onerror = useGifFallback;
    this.guidesVideoEl.onloadeddata = () => {
      if (requestId !== this.guideMediaRequestId) return;
      if (this.guidesVideoEl.dataset.guideId !== topic.id) return;
      this.clearGuideMediaLoadTimer();
      this.hideGuideLoading();
      this.guidesGifFallbackEl.hidden = true;
      this.guidesVideoEl.hidden = false;
      void this.guidesVideoEl.play().catch(useGifFallback);
    };

    this.guidesVideoEl.pause();
    this.guidesVideoEl.src = webmSrc;
    this.guidesVideoEl.load();
  }

  private openGuidesMenu(): void {
    this.hideAllMenuSubpanels();
    this.setMainMenuHomePanelVisible(false);
    this.selectGuideTopic(this.selectedGuideId);
    this.guidesMenuPanel.hidden = false;
    this.guidesMediaHost.hidden = false;
    this.guidesNavEl.hidden = false;
    this.guidesBackBtn.hidden = false;
  }

  private closeGuidesMenu(): void {
    this.pauseGuideMedia();
    this.hideAllMenuSubpanels();
    this.setMainMenuHomePanelVisible(true);
  }

  private openHighScoreMenu(): void {
    this.buildHighScoreMenu();
    this.hideAllMenuSubpanels();
    this.setMainMenuHomePanelVisible(false);
    this.highScoreMenuPanel.hidden = false;
    this.highScoreBackBtn.hidden = false;
    void this.loadGlobalLeaderboard(this.globalLeaderboardCheatMode);
  }

  ensureOnlinePlayerProfile(): void {
    void ensureOnlinePlayer((initial) => this.promptNickname(initial));
  }

  /** Dev-only: open BEST SCORE (used by Playwright / `window.__gameDev`). */
  openBestScoreMenuForDev(): void {
    this.openHighScoreMenu();
  }

  /** Dev-only: refresh global leaderboard list. */
  reloadGlobalLeaderboardForDev(cheatMode: boolean): void {
    void this.loadGlobalLeaderboard(cheatMode);
  }

  private promptNickname(initialNickname = ''): Promise<string | null> {
    return new Promise((resolve) => {
      this.nicknameModalEl.hidden = false;
      this.nicknameInputEl.value =
        initialNickname.trim() || getRememberedNickname() || '';
      requestAnimationFrame(() => {
        this.nicknameInputEl.focus({ preventScroll: true });
        this.nicknameInputEl.select();
      });

      const finish = (value: string | null) => {
        this.nicknameModalEl.hidden = true;
        okBtn.removeEventListener('click', onOk);
        skipBtn.removeEventListener('click', onSkip);
        this.nicknameInputEl.removeEventListener('keydown', onKey);
        resolve(value);
      };

      const onOk = () => {
        finish(this.nicknameInputEl.value);
      };
      const onSkip = () => {
        finish(null);
      };
      const onKey = (e: KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          onOk();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onSkip();
        }
      };

      const okBtn = this.nicknameModalEl.querySelector(
        '#nickname-modal-ok',
      ) as HTMLButtonElement;
      const skipBtn = this.nicknameModalEl.querySelector(
        '#nickname-modal-skip',
      ) as HTMLButtonElement;
      okBtn.addEventListener('click', onOk);
      skipBtn.addEventListener('click', onSkip);
      this.nicknameInputEl.addEventListener('keydown', onKey);
    });
  }

  private async setGlobalLeaderboardTab(cheatMode: boolean): Promise<void> {
    this.globalLeaderboardCheatMode = cheatMode;
    for (const tab of this.globalLeaderboardTabEls) {
      const active = tab.dataset.cheatMode === (cheatMode ? 'true' : 'false');
      tab.classList.toggle('global-leaderboard__tab--active', active);
    }
    await this.loadGlobalLeaderboard(cheatMode);
  }

  private async loadGlobalLeaderboard(cheatMode: boolean): Promise<void> {
    if (!isLeaderboardApiConfigured()) {
      this.globalLeaderboardListEl.replaceChildren();
      console.info(
        '[Leaderboard] global leaderboard hidden — API unavailable (VITE_API_BASE_URL not set)',
      );
      return;
    }

    this.globalLeaderboardListEl.replaceChildren();
    const loading = document.createElement('p');
    loading.className = 'menu-sub-line menu-sub-line--dim';
    loading.textContent = 'Loading…';
    this.globalLeaderboardListEl.appendChild(loading);

    const result = await fetchLeaderboard(cheatMode, 50);
    if (!result.ok) {
      this.globalLeaderboardListEl.replaceChildren();
      const err = document.createElement('p');
      err.className = 'menu-sub-line menu-sub-line--dim';
      err.textContent = this.globalLeaderboardErrorMessage(result.reason);
      this.globalLeaderboardListEl.appendChild(err);
      console.warn(
        '[Leaderboard] leaderboard load failed:',
        result.reason,
      );
      return;
    }

    console.info(
      `[Leaderboard] leaderboard loaded: ${result.entries.length} entries (${cheatMode ? 'cheat' : 'normal'})`,
    );
    this.renderGlobalLeaderboard(result.entries, cheatMode);
  }

  private globalLeaderboardErrorMessage(reason: LeaderboardFetchFailure): string {
    switch (reason) {
      case 'cors':
        return 'Could not load leaderboard (server blocked this site). Set FRONTEND_ORIGIN on Render to your Vercel URL, then redeploy the API.';
      case 'network':
        return 'Could not load leaderboard (API offline). Try again in a minute.';
      case 'http':
        return 'Could not load leaderboard (server error).';
      case 'not_configured':
        return 'Online leaderboard is not configured for this build.';
      default:
        return 'Could not load leaderboard.';
    }
  }

  private renderGlobalLeaderboard(
    entries: LeaderboardEntry[],
    cheatMode: boolean,
  ): void {
    this.globalLeaderboardListEl.replaceChildren();
    const player = getStoredPlayer();

    if (!entries.length) {
      const empty = document.createElement('p');
      empty.className = 'menu-sub-line menu-sub-line--dim';
      empty.textContent = 'No scores yet.';
      this.globalLeaderboardListEl.appendChild(empty);
      return;
    }

    entries.forEach((entry, index) => {
      const row = document.createElement('div');
      row.className = 'global-leaderboard__row';
      if (player && entry.playerId === player.playerId) {
        row.classList.add('global-leaderboard__row--self');
      }

      const rank = document.createElement('span');
      rank.className = 'global-leaderboard__rank';
      rank.textContent = String(index + 1);

      const nick = document.createElement('span');
      nick.className = 'global-leaderboard__nick';
      nick.textContent = entry.nickname;

      const scoreEl = document.createElement('span');
      scoreEl.className = 'global-leaderboard__score';
      scoreEl.textContent = String(entry.score);

      const track = document.createElement('span');
      track.className = 'global-leaderboard__track';
      track.textContent = entry.trackName ?? entry.trackId ?? '—';

      row.append(rank, nick, scoreEl, track);

      if (cheatMode) {
        const badge = document.createElement('span');
        badge.className = 'global-leaderboard__cheat-badge';
        badge.textContent = 'CHEAT';
        row.appendChild(badge);
      }

      this.globalLeaderboardListEl.appendChild(row);
    });
  }

  private closeHighScoreMenu(): void {
    this.hideAllMenuSubpanels();
    this.setMainMenuHomePanelVisible(true);
  }

  private openTitlesMenu(): void {
    this.hideAllMenuSubpanels();
    this.setMainMenuHomePanelVisible(false);
    this.titlesMenuPanel.hidden = false;
    this.titlesBackBtn.hidden = false;
  }

  private closeTitlesMenu(): void {
    this.hideAllMenuSubpanels();
    this.setMainMenuHomePanelVisible(true);
  }

  private buildHighScoreMenu(): void {
    this.highScoreMenuList.replaceChildren();
    const boards: { id: HighScoreBoardId; title: string }[] = [
      { id: 'normal', title: 'Normal' },
      { id: 'cheat', title: 'Cheat Mode' },
    ];
    for (const board of boards) {
      const col = document.createElement('div');
      col.className = 'highscore-menu__col';

      const heading = document.createElement('p');
      heading.className = 'menu-sub-line menu-sub-line--heading';
      heading.textContent = board.title;
      col.appendChild(heading);

      const rec = getHighScore(board.id);
      const scoreLine = document.createElement('p');
      scoreLine.className = 'menu-sub-line';
      scoreLine.textContent = rec ? formatHighScoreScore(rec.score) : '—';
      col.appendChild(scoreLine);

      const tape = document.createElement('p');
      tape.className = 'menu-sub-line menu-sub-line--dim';
      tape.textContent = rec ? formatHighScoreTape(rec) : 'No run yet';
      col.appendChild(tape);

      this.highScoreMenuList.appendChild(col);
    }
  }

  private buildTitlesMenu(): void {
    const root = this.titlesMenuPanel.querySelector('.titles-menu');
    if (!root) return;
    root.replaceChildren();
    type TitlesLine =
      | { text: string; heading?: boolean }
      | { name: string; linkHref: string };
    const lines: TitlesLine[] = [
      { text: 'Soundtrack by:', heading: true },
      { name: 'Varia.fx', linkHref: 'https://linktr.ee/variafx' },
      { name: 'Ohota', linkHref: 'https://www.instagram.com/ivan.ohota/' },
      { text: 'VibeCoded by', heading: true },
      { text: 'Larik (Codex, Cursor)' },
      { text: 'Art by', heading: true },
      { text: 'Larik / Nastya Trems' },
    ];
    for (const line of lines) {
      const p = document.createElement('p');
      if ('linkHref' in line) {
        p.className = 'menu-sub-line';
        p.append(`${line.name} `);
        const link = document.createElement('a');
        link.className = 'menu-sub-line__link';
        link.href = line.linkHref;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'link';
        link.addEventListener('click', (e) => e.stopPropagation());
        p.append(link);
      } else {
        p.className = line.heading
          ? 'menu-sub-line menu-sub-line--heading'
          : 'menu-sub-line';
        p.textContent = line.text;
      }
      root.appendChild(p);
    }
  }

  private buildTapeCassetteRack(): void {
    this.tapeCassetteRack.replaceChildren();
    for (const tape of TAPE_CASSETTES) {
      const track = TRACK_CATALOG.find((entry) => entry.id === tape.trackId);
      const col = document.createElement('div');
      col.className = 'tape-cassette-column';
      col.dataset.trackId = tape.trackId;

      const cassette = document.createElement('button');
      cassette.type = 'button';
      cassette.className = 'tape-cassette';
      cassette.dataset.trackId = tape.trackId;
      cassette.setAttribute(
        'aria-label',
        `${track?.label ?? tape.id}, highest stage`,
      );
      const img = document.createElement('img');
      img.className = 'tape-cassette__img';
      img.src = tape.imageUrl;
      img.alt = track?.label ?? '';
      img.draggable = false;
      cassette.appendChild(img);
      col.appendChild(cassette);

      const stages = document.createElement('div');
      stages.className = 'tape-cassette-stages';
      stages.setAttribute('role', 'group');
      stages.setAttribute('aria-label', `${track?.label ?? tape.id} stage`);
      for (const stage of track?.stages ?? []) {
        const unlocked = isTapeStageUnlocked(tape.trackId, stage.stage);
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'tape-stage-dot';
        if (!unlocked) {
          dot.classList.add('tape-stage-dot--locked');
        }
        dot.dataset.trackId = tape.trackId;
        dot.dataset.stageId = stage.id;
        dot.disabled = !stage.enabled || !unlocked;
        dot.title = !stage.enabled
          ? 'Not available'
          : unlocked
            ? stage.label
            : 'Unlock with a fragment from a Vault';
        dot.setAttribute('aria-label', stage.label);
        dot.setAttribute('aria-pressed', 'false');
        stages.appendChild(dot);
      }
      col.appendChild(stages);
      this.tapeCassetteRack.appendChild(col);
    }
  }

  private openTrackMenu(): void {
    this.hideAllMenuSubpanels();
    this.setMainMenuHomePanelVisible(false);
    this.buildTapeCassetteRack();
    if (this.selectedTrackStageForUi) {
      this.setSelectedTrackStage(this.selectedTrackStageForUi);
    }
    this.tapeMenuPanel.hidden = false;
    this.tapeMenuHintEl.hidden = false;
    this.tapeMenuCaptionEl.hidden = false;
    this.tapeBackBtn.hidden = false;
  }

  private closeTrackMenu(): void {
    this.hideAllMenuSubpanels();
    this.setMainMenuHomePanelVisible(true);
  }

  setSelectedTrackStage(stage: TrackStage): void {
    this.selectedTrackStageForUi = stage;
    const track = findTrackForStage(stage.id);
    this.currentTrackEl.textContent = `${track?.label ?? 'Track'} / ${stage.label}`;
    const columns = this.tapeCassetteRack.querySelectorAll<HTMLElement>('.tape-cassette-column');
    for (const col of columns) {
      col.classList.toggle('tape-cassette-column--active', col.dataset.trackId === track?.id);
    }
    const dots = this.tapeCassetteRack.querySelectorAll<HTMLButtonElement>('.tape-stage-dot');
    for (const dot of dots) {
      const selected = dot.dataset.stageId === stage.id;
      const trackId = dot.dataset.trackId ?? '';
      const stageNo = findTrackStage(trackId, dot.dataset.stageId ?? '')?.stage ?? 0;
      const unlocked = stageNo > 0 && isTapeStageUnlocked(trackId, stageNo);
      dot.classList.toggle('tape-stage-dot--selected', selected);
      dot.classList.toggle('tape-stage-dot--locked', !unlocked);
      dot.setAttribute('aria-pressed', selected ? 'true' : 'false');
    }
    this.syncBeatLaneTapeIcon(stage);
    this.tapeMenuCaptionEl.textContent = getTapeStageMenuDescription(stage);
  }

  private syncBeatLaneTapeIcon(stage: TrackStage): void {
    const track = findTrackForStage(stage.id);
    const url = track ? getTapeCassetteImageUrl(track.id) : null;
    if (!url) {
      this.beatLaneTapeStackEl.hidden = true;
      this.beatLaneTapeIconEl.removeAttribute('src');
      return;
    }
    if (this.beatLaneTapeIconEl.getAttribute('src') !== url) {
      this.beatLaneTapeIconEl.src = url;
    }
  }

  showTapeFragmentUnlocked(trackLabel: string, stageLabel: string): void {
    this.tapeFragmentToastEl.textContent = `Tape fragment — ${trackLabel} · ${stageLabel}`;
    this.tapeFragmentToastEl.classList.remove('tape-fragment-toast--hidden');
    if (this.tapeFragmentToastHideTimer !== null) {
      window.clearTimeout(this.tapeFragmentToastHideTimer);
    }
    this.tapeFragmentToastHideTimer = window.setTimeout(() => {
      this.tapeFragmentToastHideTimer = null;
      this.tapeFragmentToastEl.classList.add('tape-fragment-toast--hidden');
    }, 2800);
  }

  onTrackStageSelected(handler: (stage: TrackStage) => void): void {
    this.trackStageSelectHandler = handler;
  }

  private bindUpgradeMenuControls(): void {
    this.mainMenuEl.querySelector('#main-menu-tracks')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openTrackMenu();
    });
    this.tapeBackBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeTrackMenu();
    });
    this.mainMenuEl.querySelector('#main-menu-guides')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openGuidesMenu();
    });
    this.mainMenuEl.querySelector('#guides-back')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeGuidesMenu();
    });
    this.mainMenuEl.querySelector('#main-menu-highscore')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openHighScoreMenu();
    });
    this.mainMenuEl.querySelector('#highscore-back')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeHighScoreMenu();
    });
    this.mainMenuEl.querySelector('#main-menu-titles')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openTitlesMenu();
    });
    this.mainMenuEl.querySelector('#titles-back')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeTitlesMenu();
    });
    this.tapeCassetteRack.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;

      const dot = target.closest<HTMLButtonElement>('.tape-stage-dot');
      if (dot) {
        if (dot.disabled) return;
        const trackId = dot.dataset.trackId;
        const stageId = dot.dataset.stageId;
        if (!trackId || !stageId) return;
        const stage = findTrackStage(trackId, stageId);
        if (!stage || !isTapeStagePlayable(stage)) return;
        this.trackStageSelectHandler?.(stage);
        return;
      }

      const cassette = target.closest<HTMLButtonElement>('.tape-cassette');
      if (!cassette) return;
      const trackId = cassette.dataset.trackId;
      if (!trackId) return;
      const stage = getHighestUnlockedTrackStage(trackId);
      if (!stage) return;
      this.trackStageSelectHandler?.(stage);
    });

    this.mainMenuEl.querySelector('#main-menu-upgrade')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openUpgradeMenu();
    });
    this.mainMenuEl.querySelector('#upgrade-back')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeUpgradeMenu();
    });

    this.upgradeMenuPanel.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      this.onUpgradeCellClick(target);
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

  private emitBloomThreshold(): void {
    const v = parseFloat(this.bloomThresholdSlider.value);
    this.bloomThresholdValEl.textContent = v.toFixed(2);
    this.bloomThresholdHandler?.(v);
  }

  private emitBloomStrength(): void {
    const v = parseFloat(this.bloomStrengthSlider.value);
    this.bloomStrengthValEl.textContent = v.toFixed(2);
    this.bloomStrengthHandler?.(v);
  }

  private emitDitherSettings(): void {
    const cssDotsOpacity = parseFloat(this.cssDotsOpacitySlider.value);
    const canvasDotsOpacity = parseFloat(this.canvasDotsOpacitySlider.value);
    const shaderDitherStrength = parseFloat(this.shaderDitherStrengthSlider.value);
    const shaderDotStrength = parseFloat(this.shaderDotStrengthSlider.value);
    this.cssDotsOpacityValEl.textContent = cssDotsOpacity.toFixed(2);
    this.canvasDotsOpacityValEl.textContent = canvasDotsOpacity.toFixed(2);
    this.shaderDitherStrengthValEl.textContent = shaderDitherStrength.toFixed(2);
    this.shaderDotStrengthValEl.textContent = shaderDotStrength.toFixed(2);
    this.ditherSettingsHandler?.({
      cssDotsEnabled: this.cssDotsToggle.checked,
      cssDotsOpacity,
      canvasDotsEnabled: this.canvasDotsToggle.checked,
      canvasDotsOpacity,
      shaderDitherEnabled: this.shaderDitherToggle.checked,
      shaderDitherStrength,
      shaderDotStrength,
    });
  }

  onLensDistortionChange(handler: (amount: number) => void): void {
    this.lensDistortionHandler = handler;
    this.emitLensDistortion();
  }

  onLensOverscanChange(handler: (overscan: number) => void): void {
    this.lensOverscanHandler = handler;
    this.emitLensOverscan();
  }

  onBloomThresholdChange(handler: (threshold: number) => void): void {
    this.bloomThresholdHandler = handler;
    this.emitBloomThreshold();
  }

  onBloomStrengthChange(handler: (strength: number) => void): void {
    this.bloomStrengthHandler = handler;
    this.emitBloomStrength();
  }

  onDitherSettingsChange(handler: (settings: DitherUiSettings) => void): void {
    this.ditherSettingsHandler = handler;
    this.emitDitherSettings();
  }

  onArtifactsChange(handler: () => void): void {
    this.artifactsChangeHandler = handler;
  }

  private buildArtifactsPanel(container: HTMLElement): HTMLElement {
    const panel = document.createElement('aside');
    panel.className = 'artifacts-panel';
    panel.setAttribute('aria-label', 'Artifacts');
    const title = document.createElement('div');
    title.className = 'artifacts-panel__title';
    title.textContent = 'Artifacts';
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
    return panel;
  }

  /**
   * During a run: minimal HUD (XP only) unless cheat mode (full dev panels).
   * Main menu: hide gameplay HUD.
   */
  /** Top-left wallet: persistent gold (+ run gold from caller); run mana when `mana` is set. */
  setWalletDisplay(gold: number, mana: number | null): void {
    const g = Math.max(0, Math.floor(Number.isFinite(gold) ? gold : 0));
    this.walletGoldEl.textContent = String(g);
    if (mana === null) {
      this.walletManaGroupEl.hidden = true;
      return;
    }
    this.walletManaGroupEl.hidden = false;
    const m = Math.max(0, Math.floor(Number.isFinite(mana) ? mana : 0));
    this.walletManaEl.textContent = String(m);
  }

  setWalletGold(total: number): void {
    this.setWalletDisplay(total, null);
  }

  syncRunHudLayout(layout: 'menu' | 'run', cheatMode: boolean): void {
    const inMenu = layout === 'menu';
    const showDev = !inMenu && cheatMode;
    this.walletEl.hidden = false;
    this.walletEl.classList.toggle('hud-wallet--over-menu', inMenu);
    this.hudEl.hidden = inMenu;
    this.hpBarsBottom.hidden = inMenu;
    if (inMenu) {
      this.beatUiEl.hidden = true;
      this.beatLaneStackEl.hidden = true;
      this.artifactsPanelEl.hidden = true;
      this.fpsMeterEl.hidden = true;
      return;
    }
    this.beatLaneStackEl.hidden = false;
    this.hudExtraEl.hidden = !showDev;
    this.beatUiEl.hidden = !showDev;
    this.artifactsPanelEl.hidden = !showDev;
    this.fpsMeterEl.hidden = !showDev;
    this.hudEl.classList.toggle('hud--compact', !showDev);
  }

  /** Run totals: gold / mana from resource sacks (no spend yet). */
  setRunGoldMana(gold: number, mana: number): void {
    const g = Math.max(0, Math.floor(Number.isFinite(gold) ? gold : 0));
    const m = Math.max(0, Math.floor(Number.isFinite(mana) ? mana : 0));
    this.runGoldEl.textContent = String(g);
    this.runManaEl.textContent = String(m);
  }

  /** Enemies removed during the current run (dash, pulse, etc.). */
  setRunKills(count: number): void {
    const n = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
    this.runKillsEl.textContent = String(n);
  }

  /** Current run score (gameplay); menu uses `0`. */
  setRunScore(score: number): void {
    const n = Math.max(0, Math.floor(Number.isFinite(score) ? score : 0));
    this.beatRoundTimerEl.textContent = String(n);
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
    tapePlaying = false,
    tapeMana: BeatLaneTapeManaDisplay | null = null,
  ): void {
    const showTapeStack =
      !tapePlaying && !!this.beatLaneTapeIconEl.getAttribute('src');
    this.beatLaneTapeStackEl.hidden = !showTapeStack;
    if (
      showTapeStack &&
      tapeMana &&
      tapeMana.current < tapeMana.required
    ) {
      const current = Math.max(0, Math.floor(tapeMana.current));
      this.beatLaneTapeManaEl.textContent = `${current}/${tapeMana.required}`;
      this.beatLaneTapeManaEl.hidden = false;
    } else {
      this.beatLaneTapeManaEl.hidden = true;
    }
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
        regen.style.width = active ? `${p * 100}%` : '0%';
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

  onPauseContinue(handler: () => void): void {
    const btn = this.pauseOverlayEl.querySelector('#pause-continue')!;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handler();
    });
  }

  onPauseMainMenu(handler: () => void): void {
    const btn = this.pauseOverlayEl.querySelector('#pause-main-menu')!;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handler();
    });
  }

  showPauseMenu(): void {
    this.pauseOverlayEl.hidden = false;
  }

  hidePauseMenu(): void {
    this.pauseOverlayEl.hidden = true;
  }

  isCheatModeEnabled(): boolean {
    const input = this.mainMenuEl.querySelector('#main-menu-cheatmode') as HTMLInputElement | null;
    return input?.checked ?? false;
  }

  showMainMenu(): void {
    this.mainMenuEl.hidden = false;
    this.closeUpgradeMenu();
    this.setWalletGold(getPlayerGold());
    this.syncRunHudLayout('menu', false);
  }

  hideMainMenu(): void {
    this.mainMenuEl.hidden = true;
    this.refreshMainMenuNoise();
    this.syncRunHudLayout('run', this.isCheatModeEnabled());
  }

  showDeathScreen(): void {
    this.deathScreenEl.hidden = false;
  }

  hideDeathScreen(): void {
    this.deathScreenEl.hidden = true;
  }

  setPlayEnabled(enabled: boolean, disabledTitle = ''): void {
    this.playBtn.disabled = !enabled;
    this.playBtn.title = disabledTitle;
    this.playTrackPromptEl.hidden = !enabled;
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
