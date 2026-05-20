import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { CONFIG, isDebugDashPastTankEnabled } from './config.ts';
import { Input } from './Input.ts';
import { Player, type DashSweepSegment, type SpiralDashInput } from './Player.ts';
import { Enemy } from './Enemy.ts';
import { EnemySpawner } from './EnemySpawner.ts';
import { circlesOverlap, segmentHitsCircle } from './Collision.ts';
import { UI, type RunUpgradeChoiceView } from './UI.ts';
import { CameraController } from './CameraController.ts';
import { MobileMovementControls } from './MobileMovementControls.ts';
import {
  getCameraZoomHalfExtentLimits,
  getDefaultCameraViewHalfExtent,
  getGameViewportSize,
} from './MobileViewport.ts';
import { screenToGroundXZ } from './screenToGround.ts';
import {
  ensureLvlupAssetsLoaded,
  ensureStageTrackAssetsLoaded,
  preloadDeferredTrackAssets,
} from './AssetPreloader.ts';
import { loadBeatmap, type Beatmap, type BeatEvent } from './Beatmap.ts';
import {
  getTapeTrackCredit,
  MUSIC_MARQUEE_AMBIENT,
} from './MusicMarquee.ts';
import { SfxPool } from './SfxPool.ts';
import { AudioManager } from './AudioManager.ts';
import { BeatEffects } from './BeatEffects.ts';
import {
  BeatFloorVisualizer,
  createArenaCheckerCanvasTexture,
} from './BeatFloorVisualizer.ts';
import { addPlayerGold, getPlayerGold } from './PlayerGold.ts';
import { submitHighScore } from './HighScores.ts';
import { installLeaderboardDevTools } from './leaderboard/LeaderboardDevTools.ts';
import { syncRunToLeaderboard } from './leaderboard/LeaderboardSync.ts';
import { LensDistortionPass } from './render/LensDistortionPass.ts';
import { DitherPass } from './render/DitherPass.ts';
import { getConfiguredStorageObstacleDisk } from './ObstacleAvoidance.ts';
import {
  addRunDashNominalLengthBonus,
  addRunPlayerMaxHpBonus,
  addRunPlayerSpeedBonus,
  clearRunBalanceBonuses,
  getDashKillRadiusScale,
  getPlayerMaxHp,
  loadBalanceSettings,
} from './BalanceSettings.ts';
import { isArtifactEnabled } from './Artifacts.ts';
import { rollResourceSackDropAmount } from './Loot.ts';
import { ARTIFACT_SPIRAL_DESCRIPTION } from './RunUpgradeLibrary.ts';
import {
  findTrackForStage,
  type TrackStage,
  resolveDashCooldownSecWhilePlaying,
} from './TrackCatalog.ts';
import {
  resolveStoredOrDefaultTrackStage,
  saveSelectedTrackStageId,
} from './SelectedTape.ts';
import {
  isTapeStagePlayable,
  tryUnlockRandomTapeFragment,
} from './TapeStageUnlocks.ts';
import type { DitherUiSettings } from './UI.ts';

type BloodPalette = readonly [number, number, number];
const BLOOD_PALETTE_DEFAULT: BloodPalette = [0x45d684, 0xe8f799, 0xba1470];
const BLOOD_PALETTE_GOLD_SACK: BloodPalette = [0xffd154, 0xe0e897, 0xbf934b];
const BLOOD_PALETTE_MANA_SACK: BloodPalette = [0x322f8f, 0xe4c3e8, 0x34389e];
const BLOOD_PALETTE_VAULT: BloodPalette = [0xd8d8e3, 0xd8d8e3, 0xc3e8d1];
/** Matches resource sack mesh colors in `Enemy.ts`. */
const LOOT_FLOAT_COLOR_GOLD = '#c9a227';
const LOOT_FLOAT_COLOR_MANA = '#4a6bdc';
const BLOOD_SPLASH_DELAY_SEC = 0.15;
const TRACK_3_PHANTOM_BEAT_DASH_STEP_SEC = 0.05;
const PHANTOM_SPLASH_TRAIL_LIFE_SEC = 0.18;
const RUN_UPGRADE_MAX_LEVEL = 5;
const SIDE_DASH_MAX_LEVEL = 2;
const ORBIT_SHIELD_RADIUS = 1.45;
const ORBIT_SHIELD_THETA = Math.PI * 0.2;
const VAULT_WALK_PSEUDO_COLLISION_RADIUS =
  CONFIG.vaultHexCircumradius + CONFIG.playerRadius * 0.65;
const SIDE_DASH_TRAIL_LIFE_SEC = 0.16;
const SIDE_DASH_DELAY_SEC = 0.15;
const LIGHTNING_AUTO_DASH_DELAY_SEC = 0.1;
const LIGHTNING_COLOR = 0xa36eff;
const RUN_UPGRADE_COLOR_UTILITY = '#a36eff';
const RUN_UPGRADE_COLOR_ARTIFACT = '#ffd35c';
const RUN_UPGRADE_COLOR_RARE_ARTIFACT = '#e00b3d';
const RUN_UPGRADE_STARTED_WEIGHT_BONUS = 0.15;
const SPIRAL_PREVIEW_MAX_POINTS = 256;
const SPIRAL_PREVIEW_WIDTH = 0.38;
const SPIRAL_DRAG_CLICK_MAX_PX = 14;
const SPIRAL_PATH_SMOOTH_SAMPLES_PER_SPAN = 6;

export class Game {
  /** Outer radius of `RingGeometry` used for damage pulse (local units). */
  private static readonly DAMAGE_PULSE_RING_OUTER_LOCAL = 0.36;
  /** Every next level requires `+5` XP more than the previous one. */
  private static readonly RUN_XP_STEP_PER_LEVEL = 5;
  private static readonly DASH_SFX_URL = '/audio/dash_1.mp3';
  private static readonly DEATH_SFX_URL = '/audio/death_1.mp3';
  private static readonly HIT_SFX_URLS = [
    '/audio/hit_1.mp3',
    '/audio/hit_2.mp3',
    '/audio/hit_3.mp3',
  ] as const;
  private static readonly DASH_SFX_RATE_VARIANCE = 0.15;
  private static readonly HIT_SFX_RATE_VARIANCE = 0.2;
  private static readonly SFX_VOLUME_MULT = 0.5;
  private static readonly DEATH_SFX_COOLDOWN_MS = 100;

  private readonly mount: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly composer: EffectComposer;
  private readonly bloomPass: UnrealBloomPass;
  private readonly lensPass: LensDistortionPass;
  private readonly ditherPass: DitherPass;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.OrthographicCamera;
  /** Wider frustum for off-screen RT; gameplay + raycast still use `camera`. */
  private readonly renderCamera: THREE.OrthographicCamera;
  private readonly cameraController = new CameraController();
  private readonly clock = new THREE.Clock();
  private readonly input: Input;
  private readonly player: Player;
  private readonly enemies: Enemy[] = [];
  private readonly dyingEnemies: { enemy: Enemy; age: number }[] = [];
  private readonly enemyProjectiles: {
    mesh: THREE.Mesh;
    vx: number;
    vz: number;
    age: number;
  }[] = [];
  private readonly comboEl: HTMLDivElement;
  private readonly cssDitherOverlay: HTMLDivElement;
  private readonly canvasDitherOverlay: HTMLCanvasElement;
  private readonly canvasDitherCtx: CanvasRenderingContext2D | null;
  private comboCount = 0;
  private comboTimeLeftSec = 0;
  private comboWorldX = 0;
  private comboWorldZ = 0;
  private readonly comboScreenPos = new THREE.Vector3();
  private readonly spawner: EnemySpawner;
  private readonly ui: UI;
  private readonly audio = new AudioManager();
  private readonly backgroundAudio = new AudioManager();
  private readonly dashSfx = new Audio(Game.DASH_SFX_URL);
  private readonly deathSfx = new Audio(Game.DEATH_SFX_URL);
  private readonly hitSfxSources = Game.HIT_SFX_URLS.map((url) => new Audio(url));
  private readonly dashSfxPool: SfxPool;
  private readonly deathSfxPool: SfxPool;
  private readonly hitSfxPools: SfxPool[];
  private backgroundPauseTimer: number | null = null;
  /** Which ambient loop is loaded on `backgroundAudio` (menu vs in-run). */
  private ambientMusicMode: 'menu' | 'game' = 'menu';
  private tapeMenuPreviewUrl: string | null = null;
  private readonly beatEffects: BeatEffects;
  private beatFloor!: BeatFloorVisualizer;
  private arenaFloorMat!: THREE.MeshStandardMaterial;
  private arenaFloorMap!: THREE.CanvasTexture;
  private beatmap: Beatmap | null = null;
  private nextBeatIndex = 0;
  /** Beat indices the player dashed on-time (lane draws them green). */
  private readonly beatHitIndices = new Set<number>();
  /** Beat indices that already dealt miss/skip damage. */
  private readonly beatPenaltyIndices = new Set<number>();
  private beatHitCount = 0;
  private readonly dashSerialsWithBeatHit = new Set<number>();
  private raf = 0;
  private readyForDisplayResolve: (() => void) | null = null;
  private readonly readyForDisplayPromise: Promise<void>;
  /** Orthographic camera shake after dash kills (decays each frame). */
  private cameraShake = 0;
  private readonly groundHit = new THREE.Vector3();
  private readonly vaultBearingProj = new THREE.Vector3();
  private fpsSmoothed = 0;
  private runPhase: 'menu' | 'playing' | 'paused' | 'death' | 'runUpgrade' = 'menu';
  /** Beat-track was playing when pause opened; resume on continue. */
  private beatAudioPausedForPause = false;
  /** Cheat mode checkbox at run start — used only for high-score board selection. */
  private runCheatModeActive = false;
  private deathScreenTimer = 0;
  /** Total combat XP this run (mob / tank / pulse / vault kills). */
  private runXpTotal = 0;
  /** Count of reached level-up thresholds this run (earned upgrade choices). */
  private runLevelUpsAwarded = 0;
  /** Next cumulative XP threshold that triggers the in-run upgrade modal. */
  private runNextUpgradeAtXp = CONFIG.runXpPerLevel;
  /** Reached milestones waiting for player choices (shown one-by-one). */
  private readonly runPendingUpgradeMilestones: number[] = [];
  /** Previous frame beat-track playback state (used to detect track end). */
  private wasTrackPlayingLastFrame = false;
  /** Active run survival time (seconds); wall clock, never synced to track audio. */
  private runElapsedSec = 0;
  private runClockStartedAtMs = 0;
  private runClockPausedTotalMs = 0;
  private runClockPauseStartedAtMs: number | null = null;
  private runEnemySlowLevel = 0;
  private runRocketLevel = 0;
  private runRocketTimerSec = 0;
  private runLightningLevel = 0;
  private runLightningDashCounter = 0;
  private pendingLightningAutoDashes = 0;
  private lightningAutoDashDelaySec = 0;
  private lightningChainActive = false;
  private lightningAutoDashInProgress = false;
  private runSideDashLevel = 0;
  private runOrbitShieldLevel = 0;
  private runPhaseDashUnlocked = false;
  private runSpiralDashUnlocked = false;
  private readonly runUpgradePickCounts = new Map<string, number>();
  /** Enemies killed this run (removed from arena by dash/tank resolve/damage pulse). */
  private runEnemiesKilled = 0;
  /** Gold picked up this run; deposited into the wallet when the run ends. */
  private runGold = 0;
  /** Mana picked up this run (мешки маны); пока ни на что не тратится. */
  private runMana = 0;
  /** Bonus score from kills, track bonuses, etc. (see `getRunScore`). */
  private runScoreBonus = 0;
  private runScoreLastSecondFloor = -1;
  /** Any beat miss on the current track playthrough. */
  private currentTrackMissed = false;
  /** Post-process: render frustum scale vs gameplay ortho (lens overscan). */
  private lensOverscan = 1.35;
  /** Lens distortion from UI slider; effective value adds boost while beatmap audio plays. */
  private lensDistortionBase = 0.15;
  private bloomThreshold = 0.35;
  private bloomStrength = 0.3;
  private pendingDashSfx = false;
  private lastDeathSfxAtMs = -Infinity;
  /** Current ortho camera half-height (world units), changed by wheel zoom. */
  private cameraViewHalfExtentCurrent: number = getDefaultCameraViewHalfExtent();
  private readonly mobileMoveControls: MobileMovementControls;
  private selectedTrackStage: TrackStage = resolveStoredOrDefaultTrackStage();
  private beatmapLoadSerial = 0;

  private readonly damagePulseRings: {
    mesh: THREE.Mesh;
    mat: THREE.MeshBasicMaterial;
    age: number;
    baseOpacity: number;
    radiusMult: number;
  }[] = [];
  private readonly bloodPuddles: {
    mesh: THREE.Mesh;
    mat: THREE.MeshBasicMaterial;
    age: number;
    life: number;
    baseScale: number;
    shimmerSeed: number;
  }[] = [];
  private readonly bloodParticles: {
    mesh: THREE.Mesh;
    mat: THREE.MeshBasicMaterial;
    vx: number;
    vz: number;
    age: number;
    life: number;
  }[] = [];
  private readonly pendingBloodSplashes: {
    delay: number;
    x: number;
    z: number;
    bodyRadius: number;
    palette: BloodPalette;
    dashDir?: { x: number; z: number; passPower?: number };
  }[] = [];
  private readonly pendingPhantomSplashes: { delay: number }[] = [];
  private readonly phantomSplashTrails: {
    mesh: THREE.Mesh;
    mat: THREE.MeshBasicMaterial;
    age: number;
    life: number;
  }[] = [];
  private readonly sideDashTrails: {
    mesh: THREE.Mesh;
    mat: THREE.MeshBasicMaterial;
    age: number;
    life: number;
  }[] = [];
  private readonly pendingSideDashes: {
    delay: number;
    segs: DashSweepSegment[];
    dir: { x: number; z: number };
  }[] = [];
  private readonly spiralPreviewMaxSegs = SPIRAL_PREVIEW_MAX_POINTS - 1;
  private readonly spiralPreviewRibbonPositions = new Float32Array(
    this.spiralPreviewMaxSegs * 6 * 3,
  );
  private readonly spiralPreviewGeo = new THREE.BufferGeometry();
  private readonly spiralPreviewRibbon: THREE.Mesh;

  /** Dash sweep consumed in `resolveDashKills` this frame (debug overlay / logs). */
  private dashDebugSweepThisFrame: DashSweepSegment | null = null;
  private debugDashTankGroup: THREE.Group | null = null;
  private readonly orbitShieldGroup = new THREE.Group();
  private readonly orbitShieldSegments: THREE.Mesh[] = [];
  private readonly lightningMeterEl: HTMLDivElement;

  constructor(mount: HTMLElement) {
    this.readyForDisplayPromise = new Promise((resolve) => {
      this.readyForDisplayResolve = resolve;
    });
    this.mount = mount;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9eaaad);

    const { width: w, height: h } = getGameViewportSize();
    const aspect = w / Math.max(1, h);
    const view = this.cameraViewHalfExtentCurrent;
    this.camera = new THREE.OrthographicCamera(
      (-view * aspect) / 2,
      (view * aspect) / 2,
      view / 2,
      -view / 2,
      0.1,
      200,
    );
    this.camera.position.copy(this.cameraController.cameraOffset);
    this.camera.up.set(0, 0, -1);
    this.camera.lookAt(0, 0, 0);

    const os = this.lensOverscan;
    this.renderCamera = new THREE.OrthographicCamera(
      this.camera.left * os,
      this.camera.right * os,
      this.camera.top * os,
      this.camera.bottom * os,
      this.camera.near,
      this.camera.far,
    );
    this.renderCamera.position.copy(this.camera.position);
    this.renderCamera.quaternion.copy(this.camera.quaternion);
    this.renderCamera.up.copy(this.camera.up);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(this.renderer.domElement);
    const vignette = document.createElement('div');
    vignette.className = 'game-vignette';
    mount.appendChild(vignette);
    this.cssDitherOverlay = document.createElement('div');
    this.cssDitherOverlay.className = 'dither-overlay dither-overlay--css';
    mount.appendChild(this.cssDitherOverlay);
    this.canvasDitherOverlay = document.createElement('canvas');
    this.canvasDitherOverlay.className = 'dither-overlay dither-overlay--canvas';
    this.canvasDitherCtx = this.canvasDitherOverlay.getContext('2d');
    mount.appendChild(this.canvasDitherOverlay);
    this.comboEl = document.createElement('div');
    this.comboEl.className = 'combo-pop combo-pop--hidden game-run-ui';
    mount.appendChild(this.comboEl);
    this.lightningMeterEl = document.createElement('div');
    this.lightningMeterEl.className = 'lightning-meter lightning-meter--hidden game-run-ui';
    mount.appendChild(this.lightningMeterEl);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.renderCamera));
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(w, h),
      this.bloomStrength,
      0.35,
      this.bloomThreshold,
    );
    this.composer.addPass(this.bloomPass);
    this.lensPass = new LensDistortionPass();
    this.composer.addPass(this.lensPass);
    this.ditherPass = new DitherPass();
    this.composer.addPass(this.ditherPass);
    this.composer.addPass(new OutputPass());
    this.composer.setSize(w, h);

    this.addLights();
    this.addArena();
    this.createOrbitShieldVisuals();
    this.spiralPreviewGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(this.spiralPreviewRibbonPositions, 3),
    );
    this.spiralPreviewGeo.setDrawRange(0, 0);
    this.spiralPreviewRibbon = new THREE.Mesh(
      this.spiralPreviewGeo,
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.96,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.spiralPreviewRibbon.visible = false;
    this.spiralPreviewRibbon.frustumCulled = false;
    this.spiralPreviewRibbon.renderOrder = 12;
    this.scene.add(this.spiralPreviewRibbon);

    loadBalanceSettings();

    this.input = new Input(window.document.documentElement, mount);
    this.input.centerPointerOn(this.renderer.domElement);
    this.mobileMoveControls = new MobileMovementControls(mount);
    this.mobileMoveControls.attach(this.input);
    this.player = new Player(this.scene);
    this.spawner = new EnemySpawner(this.scene, this.enemies);
    this.ui = new UI(mount);
    this.beatEffects = new BeatEffects(mount);
    this.backgroundAudio.setLoop(true);
    this.backgroundAudio.setVolume(CONFIG.backgroundMusicVolume);
    this.dashSfx.preload = 'auto';
    this.dashSfx.volume = 0.72 * Game.SFX_VOLUME_MULT;
    this.dashSfx.load();
    this.deathSfx.preload = 'auto';
    this.deathSfx.volume = 0.78 * Game.SFX_VOLUME_MULT;
    this.deathSfx.load();
    for (const hitSfx of this.hitSfxSources) {
      hitSfx.preload = 'auto';
      hitSfx.volume = 0.78 * Game.SFX_VOLUME_MULT;
      hitSfx.load();
    }
    this.dashSfxPool = new SfxPool(this.dashSfx, 6);
    this.deathSfxPool = new SfxPool(this.deathSfx, 2);
    this.hitSfxPools = this.hitSfxSources.map((src) => new SfxPool(src, 3));
    this.dashSfxPool.warm();
    this.deathSfxPool.warm();
    for (const pool of this.hitSfxPools) {
      pool.warm();
    }
    void this.backgroundAudio.setTrack(CONFIG.menuMusicUrl).catch((e) => {
      console.error('[MenuAudio] init failed:', e instanceof Error ? e.message : e, e);
    });
    this.ui.onPlayRequested(() => {
      void this.requestStartAudioPlayback();
    });
    this.ui.onBeatLaneTapePlayTap(() => {
      void this.requestStartAudioPlayback();
    });
    this.ui.onTrackStageSelected((stage) => {
      void this.selectTrackStage(stage);
    });
    this.ui.onTapeMenuOpenChange((open) => {
      if (open) {
        void this.syncTapeMenuPreviewMusic();
        return;
      }
      void this.stopTapeMenuPreviewMusic();
    });
    saveSelectedTrackStageId(this.selectedTrackStage.id);
    this.ui.setSelectedTrackStage(this.selectedTrackStage);
    this.ui.setPlayEnabled(false, '');
    this.ui.setBeatmapState('Loading...');
    this.ui.setBeatDebug(0, null);
    this.ui.onLensDistortionChange((v) => {
      this.lensDistortionBase = v;
      this.applyLensDistortionEffective();
    });
    this.ui.onLensOverscanChange((v) => {
      this.lensOverscan = v;
      this.lensPass.setOverscan(v);
    });
    this.ui.onBloomThresholdChange((v) => {
      this.bloomThreshold = v;
      this.bloomPass.threshold = v;
    });
    this.ui.onBloomStrengthChange((v) => {
      this.bloomStrength = v;
      this.bloomPass.strength = v;
    });
    this.ui.onDitherSettingsChange((settings) => {
      this.applyDitherSettings(settings);
    });
    this.ui.onArtifactsChange(() => {
      if (!isArtifactEnabled('vaultBearing')) {
        this.ui.setVaultBearingAngle(null);
      } else if (this.runPhase === 'playing') {
        this.syncVaultBearingUi();
      }
    });
    this.ui.onMainMenuPlay(() => {
      this.startGameFromMenu();
    });
    this.ui.onDeathMenuClick(() => {
      if (this.runPhase === 'death') {
        this.goToMainMenuAfterDeath();
      }
    });
    this.ui.onPauseContinue(() => {
      if (this.runPhase === 'paused') {
        this.resumeFromPause();
      }
    });
    this.ui.onPauseMainMenu(() => {
      if (this.runPhase === 'paused') {
        this.goToMainMenuFromPause();
      }
    });
    this.ui.ensureOnlinePlayerProfile();
    if (import.meta.env.DEV) {
      installLeaderboardDevTools({
        openBestScoreMenu: () => this.ui.openBestScoreMenuForDev(),
        reloadGlobalLeaderboard: (cheatMode) =>
          this.ui.reloadGlobalLeaderboardForDev(cheatMode),
      });
    }
    this.syncWalletGoldUi();
    void this.ensureBackgroundMusicPlaying();
    preloadDeferredTrackAssets(this.selectedTrackStage.id);
    void this.initBeatmap();

    window.addEventListener('resize', this.onResize);
    this.onResize();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  private addLights(): void {
    const amb = new THREE.AmbientLight(0x3a4050, 0.55);
    this.scene.add(amb);
    const dir = new THREE.DirectionalLight(0xe8ecf5, 0.95);
    dir.position.set(10, 28, 6);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.near = 1;
    const sh = CONFIG.arenaFloorVisualHalfExtent + 80;
    dir.shadow.camera.left = -sh;
    dir.shadow.camera.right = sh;
    dir.shadow.camera.top = sh;
    dir.shadow.camera.bottom = -sh;
    dir.shadow.camera.far = sh * 2.5;
    this.scene.add(dir);
  }

  private createOrbitShieldVisuals(): void {
    this.orbitShieldGroup.visible = false;
    this.orbitShieldGroup.position.y = CONFIG.floorY + 0.42;
    for (let i = 0; i < RUN_UPGRADE_MAX_LEVEL; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xe8f799,
        transparent: true,
        opacity: 0.86,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(
        new THREE.RingGeometry(
          ORBIT_SHIELD_RADIUS - 0.08,
          ORBIT_SHIELD_RADIUS + 0.08,
          24,
          1,
          i * ORBIT_SHIELD_THETA * 1.22,
          ORBIT_SHIELD_THETA,
        ),
        mat,
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = 11;
      mesh.visible = false;
      this.orbitShieldGroup.add(mesh);
      this.orbitShieldSegments.push(mesh);
    }
    this.scene.add(this.orbitShieldGroup);
  }

  private applyDitherSettings(settings: DitherUiSettings): void {
    this.cssDitherOverlay.classList.toggle(
      'dither-overlay--enabled',
      settings.cssDotsEnabled && settings.cssDotsOpacity > 0,
    );
    this.cssDitherOverlay.style.setProperty(
      '--dither-css-opacity',
      String(settings.cssDotsOpacity),
    );

    this.canvasDitherOverlay.classList.toggle(
      'dither-overlay--enabled',
      settings.canvasDotsEnabled && settings.canvasDotsOpacity > 0,
    );
    this.canvasDitherOverlay.style.opacity = String(settings.canvasDotsOpacity);
    if (settings.canvasDotsEnabled) {
      this.paintCanvasDitherOverlay();
    }

    this.ditherPass.setEnabled(settings.shaderDitherEnabled);
    this.ditherPass.setStrength(settings.shaderDitherStrength);
    this.ditherPass.setDotStrength(settings.shaderDotStrength);
  }

  private resizeCanvasDitherOverlay(width: number, height: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvasDitherOverlay.width = Math.max(1, Math.floor(width * dpr));
    this.canvasDitherOverlay.height = Math.max(1, Math.floor(height * dpr));
    this.canvasDitherOverlay.style.width = `${width}px`;
    this.canvasDitherOverlay.style.height = `${height}px`;
    this.paintCanvasDitherOverlay();
  }

  private paintCanvasDitherOverlay(): void {
    const ctx = this.canvasDitherCtx;
    if (!ctx) return;
    const w = this.canvasDitherOverlay.width;
    const h = this.canvasDitherOverlay.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
    const step = 4;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
        const f = n - Math.floor(n);
        if (f < 0.68) continue;
        const r = f > 0.9 ? 1.2 : 0.7;
        ctx.beginPath();
        ctx.arc(x + step * 0.5, y + step * 0.5, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private applyLensDistortionEffective(): void {
    const boost = this.audio.isPlaying ? CONFIG.lensDistortionWhileTrackPlaysBoost : 0;
    this.lensPass.setAmount(this.lensDistortionBase + boost);
  }

  private addArena(): void {
    const size = CONFIG.arenaFloorVisualHalfExtent * 2 + 2;
    this.arenaFloorMap = createArenaCheckerCanvasTexture();
    this.arenaFloorMat = new THREE.MeshStandardMaterial({
      map: this.arenaFloorMap,
      color: 0xffffff,
      metalness: 0.05,
      roughness: 0.92,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(size, size), this.arenaFloorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.beatFloor = new BeatFloorVisualizer(this.scene);

    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(size, size)),
      new THREE.LineBasicMaterial({ color: 0x2a3142 }),
    );
    edge.rotation.x = -Math.PI / 2;
    edge.position.y = 0.02;
    this.scene.add(edge);

    const grid = new THREE.GridHelper(
      CONFIG.arenaFloorVisualHalfExtent * 2,
      64,
      0x151923,
      0x0d1017,
    );
    grid.position.y = 0.01;
    this.scene.add(grid);
  }

  private async initBeatmap(): Promise<void> {
    const loadSerial = ++this.beatmapLoadSerial;
    const stage = this.selectedTrackStage;
    try {
      const loaded = await loadBeatmap(stage.beatmapUrl);
      if (loadSerial !== this.beatmapLoadSerial) return;
      const beatmap = {
        ...loaded,
        track: stage.audioUrl || loaded.track,
      };
      this.beatmap = beatmap;
      this.nextBeatIndex = 0;
      this.resetBeatHitTracking();
      await this.audio.setTrack(beatmap.track);
      if (loadSerial !== this.beatmapLoadSerial) return;
      this.ui.setBeatmapState(`Ready: ${stage.label}`);
      this.syncBeatPlayButton();
      this.ui.setBeatDebug(this.audio.currentTime, beatmap.beats[0]?.time ?? null);
    } catch (e) {
      if (loadSerial !== this.beatmapLoadSerial) return;
      console.error('[Beatmap] init failed:', e instanceof Error ? e.message : e, e);
      this.beatmap = null;
      this.ui.setBeatmapState('Beatmap load failed');
      this.syncBeatPlayButton();
    }
  }

  private async selectTrackStage(stage: TrackStage): Promise<void> {
    if (!isTapeStagePlayable(stage)) return;
    this.selectedTrackStage = stage;
    saveSelectedTrackStageId(stage.id);
    this.ui.setSelectedTrackStage(stage);
    this.beatFloor.onTrackEnded();
    this.audio.pause();
    this.audio.reset();
    this.beatmap = null;
    this.nextBeatIndex = 0;
    this.resetBeatHitTracking();
    this.ui.setBeatDebug(0, null);
    this.ui.setBeatmapState('Loading...');
    this.syncBeatPlayButton();
    await ensureStageTrackAssetsLoaded(stage);
    await this.initBeatmap();
    if (this.ui.isTapeMenuOpen() && this.runPhase === 'menu') {
      void this.syncTapeMenuPreviewMusic();
    }
  }

  private syncBeatPlayButton(): void {
    if (!this.beatmap) {
      this.ui.setPlayEnabled(false, '');
      return;
    }
    if (this.runPhase === 'death') {
      this.ui.setPlayEnabled(false, '');
      return;
    }
    if (this.audio.isPlaying) {
      this.ui.setPlayEnabled(false, '');
      return;
    }
    const spendMana =
      CONFIG.playTrackManaCostEnabled &&
      (this.runPhase === 'playing' || this.runPhase === 'runUpgrade');
    if (spendMana && this.runMana < CONFIG.playTrackMinManaToActivate) {
      this.ui.setPlayEnabled(
        false,
        `During a run you need at least ${CONFIG.playTrackMinManaToActivate} mana (start: -${CONFIG.playTrackManaCost}).`,
      );
      return;
    }
    if (!isTapeStagePlayable(this.selectedTrackStage)) {
      this.ui.setPlayEnabled(
        false,
        'Unlock a stage under TAPES (fragments drop from Vaults).',
      );
      return;
    }
    this.ui.setPlayEnabled(true, '');
  }

  private async requestStartAudioPlayback(): Promise<void> {
    void this.ensureBackgroundMusicPlaying();
    if (!this.beatmap) return;
    const spendMana =
      CONFIG.playTrackManaCostEnabled &&
      (this.runPhase === 'playing' || this.runPhase === 'runUpgrade');
    if (spendMana) {
      if (this.runMana < CONFIG.playTrackMinManaToActivate) return;
      this.runMana -= CONFIG.playTrackManaCost;
      this.syncRunLootUi();
      const ok = await this.startAudioPlayback();
      if (!ok) {
        this.runMana += CONFIG.playTrackManaCost;
        this.syncRunLootUi();
      }
      this.syncBeatPlayButton();
      return;
    }
    await this.startAudioPlayback();
    this.syncBeatPlayButton();
  }

  private async startAudioPlayback(): Promise<boolean> {
    if (!this.beatmap) return false;
    try {
      if (this.audio.currentTime >= (this.beatmap.beats.at(-1)?.time ?? 0) + 0.25) {
        this.audio.reset();
        this.nextBeatIndex = 0;
        this.resetBeatHitTracking();
      }
      await this.audio.play();
      this.ui.showGetReadyOverlay();
      if (this.beatmap) {
        this.beatFloor.onTrackStarted(this.beatmap, this.audio.currentTime);
      }
      this.scheduleBackgroundPauseForTrack();
      this.ui.setBeatmapState('Playing');
      return true;
    } catch (e) {
      console.error('[Beatmap] audio play failed:', e instanceof Error ? e.message : e, e);
      this.ui.setBeatmapState('Playback blocked');
      void this.ensureBackgroundMusicPlaying();
      return false;
    }
  }

  private ambientMusicUrlForPhase(): string {
    return this.runPhase === 'menu' ? CONFIG.menuMusicUrl : CONFIG.backgroundMusicUrl;
  }

  private ambientMusicModeForPhase(): 'menu' | 'game' {
    return this.runPhase === 'menu' ? 'menu' : 'game';
  }

  private syncMusicMarquee(): void {
    if (this.audio.isPlaying) {
      const trackEntry = findTrackForStage(this.selectedTrackStage.id);
      const credit = trackEntry
        ? getTapeTrackCredit(trackEntry.id)
        : null;
      this.ui.setMusicMarquee(credit);
      return;
    }
    if (
      this.ui.isTapeMenuOpen() &&
      this.runPhase === 'menu' &&
      this.tapeMenuPreviewUrl &&
      this.backgroundAudio.isPlaying
    ) {
      const trackEntry = findTrackForStage(this.selectedTrackStage.id);
      const credit = trackEntry
        ? getTapeTrackCredit(trackEntry.id)
        : null;
      this.ui.setMusicMarquee(credit);
      return;
    }
    if (this.backgroundAudio.isPlaying) {
      this.ui.setMusicMarquee(MUSIC_MARQUEE_AMBIENT);
      return;
    }
    this.ui.setMusicMarquee(null);
  }

  private async syncTapeMenuPreviewMusic(): Promise<void> {
    if (!this.ui.isTapeMenuOpen() || this.runPhase !== 'menu') return;
    if (this.audio.isPlaying) return;

    const url = this.selectedTrackStage.audioUrl;
    const needsLoad = this.tapeMenuPreviewUrl !== url;
    try {
      this.backgroundAudio.setLoop(true);
      if (needsLoad) {
        await this.backgroundAudio.setTrack(url);
        this.tapeMenuPreviewUrl = url;
      }
      this.backgroundAudio.seek(CONFIG.tapeMenuPreviewStartSec);
      if (!this.backgroundAudio.isPlaying) {
        await this.backgroundAudio.play();
      }
      this.syncMusicMarquee();
    } catch (e) {
      console.error(
        '[TapeMenuPreview] playback failed:',
        e instanceof Error ? e.message : e,
        e,
      );
    }
  }

  /** Leave TAPES submenu: restore main-menu ambient loop (not cassette preview). */
  private async stopTapeMenuPreviewMusic(): Promise<void> {
    if (this.runPhase !== 'menu') return;
    this.tapeMenuPreviewUrl = null;
    this.clearBackgroundPauseTimer();
    if (this.audio.isPlaying) return;
    try {
      this.backgroundAudio.setLoop(true);
      await this.backgroundAudio.setTrack(CONFIG.menuMusicUrl);
      this.backgroundAudio.reset();
      this.ambientMusicMode = 'menu';
      if (!this.backgroundAudio.isPlaying) {
        await this.backgroundAudio.play();
      }
      this.syncMusicMarquee();
    } catch {
      // Browser autoplay can block this until the next explicit user gesture.
    }
  }

  private async ensureBackgroundMusicPlaying(): Promise<void> {
    this.clearBackgroundPauseTimer();
    if (this.audio.isPlaying) return;

    // Cassette preview is started only from TAPES open / stage pick — never from the menu loop.
    if (this.ui.isTapeMenuOpen() && this.runPhase === 'menu') {
      return;
    }

    const mode = this.ambientMusicModeForPhase();
    const url = this.ambientMusicUrlForPhase();
    const leavingTapePreview = this.tapeMenuPreviewUrl !== null;
    this.tapeMenuPreviewUrl = null;
    const needsSwitch = this.ambientMusicMode !== mode || leavingTapePreview;
    if (!needsSwitch && this.backgroundAudio.isPlaying) return;

    try {
      if (needsSwitch) {
        this.backgroundAudio.setLoop(true);
        await this.backgroundAudio.setTrack(url);
        this.backgroundAudio.reset();
        this.ambientMusicMode = mode;
      }
      if (!this.backgroundAudio.isPlaying) {
        await this.backgroundAudio.play();
      }
      this.syncMusicMarquee();
    } catch {
      // Browser autoplay can block this until the next explicit user gesture.
    }
  }

  private scheduleBackgroundPauseForTrack(): void {
    this.clearBackgroundPauseTimer();
    const delay = Math.max(0, CONFIG.backgroundMusicPauseAfterTrackStartMs);
    this.backgroundPauseTimer = window.setTimeout(() => {
      this.backgroundPauseTimer = null;
      if (this.audio.isPlaying) {
        this.backgroundAudio.pause();
      }
    }, delay);
  }

  private clearBackgroundPauseTimer(): void {
    if (this.backgroundPauseTimer === null) return;
    window.clearTimeout(this.backgroundPauseTimer);
    this.backgroundPauseTimer = null;
  }

  private resetRunUpgradeBonuses(): void {
    this.runUpgradePickCounts.clear();
    this.runEnemySlowLevel = 0;
    this.runRocketLevel = 0;
    this.runRocketTimerSec = 0;
    this.runLightningLevel = 0;
    this.runLightningDashCounter = 0;
    this.pendingLightningAutoDashes = 0;
    this.lightningAutoDashDelaySec = 0;
    this.lightningChainActive = false;
    this.lightningAutoDashInProgress = false;
    this.runSideDashLevel = 0;
    this.runOrbitShieldLevel = 0;
    this.runPhaseDashUnlocked = false;
    this.runSpiralDashUnlocked = false;
    this.syncOrbitShieldVisuals();
    this.syncLightningMeter();
  }

  private syncRenderCamera(): void {
    const os = this.lensOverscan;
    this.renderCamera.position.copy(this.camera.position);
    this.renderCamera.quaternion.copy(this.camera.quaternion);
    this.renderCamera.up.copy(this.camera.up);
    this.renderCamera.left = this.camera.left * os;
    this.renderCamera.right = this.camera.right * os;
    this.renderCamera.top = this.camera.top * os;
    this.renderCamera.bottom = this.camera.bottom * os;
    this.renderCamera.near = this.camera.near;
    this.renderCamera.far = this.camera.far;
    this.renderCamera.updateProjectionMatrix();
  }

  private consumeSpiralDashInput(): SpiralDashInput | null {
    const release = this.input.consumePointerDragRelease();
    if (!this.runSpiralDashUnlocked || !release || release.points.length === 0) {
      return null;
    }
    const { points: screenPoints, durationSec } = release;
    if (this.pointerDragScreenLengthPx(screenPoints) < SPIRAL_DRAG_CLICK_MAX_PX) {
      const click = this.screenPointToGroundXZ(screenPoints[screenPoints.length - 1]!);
      return click ? { mode: 'click', x: click.x, z: click.z } : null;
    }
    const path = this.buildSpiralGroundPathFromScreen(screenPoints);
    if (path && path.length >= 2) {
      return { mode: 'path', points: path, drawDurationSec: durationSec };
    }
    const click = this.screenPointToGroundXZ(screenPoints[screenPoints.length - 1]!);
    return click ? { mode: 'click', x: click.x, z: click.z } : null;
  }

  private pointerDragScreenLengthPx(
    screenPoints: readonly { x: number; y: number }[],
  ): number {
    let len = 0;
    for (let i = 1; i < screenPoints.length; i++) {
      const a = screenPoints[i - 1]!;
      const b = screenPoints[i]!;
      len += Math.hypot(b.x - a.x, b.y - a.y);
    }
    return len;
  }

  private readonly spiralGroundHit = new THREE.Vector3();

  private screenPointToGroundXZ(
    p: { x: number; y: number },
  ): { x: number; z: number } | null {
    if (
      !screenToGroundXZ(
        p.x,
        p.y,
        this.renderer.domElement,
        this.camera,
        CONFIG.floorY,
        this.spiralGroundHit,
      )
    ) {
      return null;
    }
    return { x: this.spiralGroundHit.x, z: this.spiralGroundHit.z };
  }

  private buildSpiralGroundPathFromScreen(
    screenPoints: readonly { x: number; y: number }[],
  ): { x: number; z: number }[] | null {
    const out: { x: number; z: number }[] = [];
    for (const p of screenPoints) {
      const g = this.screenPointToGroundXZ(p);
      if (!g) continue;
      const prev = out.at(-1);
      if (!prev || Math.hypot(g.x - prev.x, g.z - prev.z) >= CONFIG.spiralGroundSampleMinDist) {
        out.push(g);
      }
    }
    if (out.length < 2) return null;
    return this.smoothSpiralGroundPath(out, SPIRAL_PREVIEW_MAX_POINTS);
  }

  private smoothSpiralGroundPath(
    points: readonly { x: number; z: number }[],
    maxPoints: number,
  ): { x: number; z: number }[] {
    if (points.length < 2) return [...points];
    const out: { x: number; z: number }[] = [];
    const spans = points.length - 1;
    for (let i = 0; i < spans; i++) {
      const p0 = points[Math.max(0, i - 1)]!;
      const p1 = points[i]!;
      const p2 = points[i + 1]!;
      const p3 = points[Math.min(points.length - 1, i + 2)]!;
      const steps = i === spans - 1 ? SPIRAL_PATH_SMOOTH_SAMPLES_PER_SPAN + 1 : SPIRAL_PATH_SMOOTH_SAMPLES_PER_SPAN;
      for (let s = 0; s < steps; s++) {
        const u = s / SPIRAL_PATH_SMOOTH_SAMPLES_PER_SPAN;
        const t = u * u * (3 - 2 * u);
        const q = this.catmullRomXZ(p0, p1, p2, p3, t);
        const prev = out.at(-1);
        if (!prev || Math.hypot(q.x - prev.x, q.z - prev.z) >= 0.12) {
          out.push(q);
          if (out.length >= maxPoints) return out;
        }
      }
    }
    const end = points[points.length - 1]!;
    const prev = out.at(-1);
    if (!prev || Math.hypot(end.x - prev.x, end.z - prev.z) >= 0.08) {
      out.push({ x: end.x, z: end.z });
    }
    return out.length >= 2 ? out : [...points];
  }

  private catmullRomXZ(
    p0: { x: number; z: number },
    p1: { x: number; z: number },
    p2: { x: number; z: number },
    p3: { x: number; z: number },
    t: number,
  ): { x: number; z: number } {
    const t2 = t * t;
    const t3 = t2 * t;
    const x =
      0.5 *
      (2 * p1.x +
        (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
    const z =
      0.5 *
      (2 * p1.z +
        (-p0.z + p2.z) * t +
        (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 +
        (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3);
    return { x, z };
  }

  private syncSpiralPreviewRibbon(points: readonly { x: number; z: number }[]): void {
    const n = points.length;
    if (n < 2) {
      this.spiralPreviewGeo.setDrawRange(0, 0);
      this.spiralPreviewRibbon.visible = false;
      return;
    }
    const y = CONFIG.floorY + 0.08;
    const halfW = SPIRAL_PREVIEW_WIDTH * 0.5;
    const arr = this.spiralPreviewRibbonPositions;
    let o = 0;
    for (let i = 0; i < n - 1; i++) {
      const ax = points[i]!.x;
      const az = points[i]!.z;
      const bx = points[i + 1]!.x;
      const bz = points[i + 1]!.z;
      let dx = bx - ax;
      let dz = bz - az;
      const len = Math.hypot(dx, dz);
      let px: number;
      let pz: number;
      if (len < 1e-6) {
        px = 0;
        pz = 1;
      } else {
        const inv = 1 / len;
        px = -dz * inv;
        pz = dx * inv;
      }
      const apx = px * halfW;
      const apz = pz * halfW;
      const alx = ax - apx;
      const alz = az - apz;
      const arx = ax + apx;
      const arz = az + apz;
      const blx = bx - apx;
      const blz = bz - apz;
      const brx = bx + apx;
      const brz = bz + apz;

      arr[o++] = alx;
      arr[o++] = y;
      arr[o++] = alz;
      arr[o++] = brx;
      arr[o++] = y;
      arr[o++] = brz;
      arr[o++] = arx;
      arr[o++] = y;
      arr[o++] = arz;

      arr[o++] = alx;
      arr[o++] = y;
      arr[o++] = alz;
      arr[o++] = blx;
      arr[o++] = y;
      arr[o++] = blz;
      arr[o++] = brx;
      arr[o++] = y;
      arr[o++] = brz;
    }
    const vertCount = (n - 1) * 6;
    this.spiralPreviewGeo.setDrawRange(0, vertCount);
    const attr = this.spiralPreviewGeo.attributes.position as THREE.BufferAttribute;
    attr.needsUpdate = true;
    this.spiralPreviewGeo.computeBoundingSphere();
    this.spiralPreviewRibbon.visible = true;
  }

  private syncSpiralDashPreview(): void {
    if (this.runPhase !== 'playing' || !this.runSpiralDashUnlocked) {
      this.spiralPreviewRibbon.visible = false;
      return;
    }
    const raw = this.buildSpiralGroundPathFromScreen(this.input.getPointerDragPoints());
    if (!raw || raw.length < 2) {
      this.spiralPreviewRibbon.visible = false;
      return;
    }
    this.syncSpiralPreviewRibbon(raw);
  }

  private onResize = (): void => {
    const { width: w, height: h } = getGameViewportSize();
    const aspect = w / Math.max(1, h);
    const view = this.cameraViewHalfExtentCurrent;
    this.camera.left = (-view * aspect) / 2;
    this.camera.right = (view * aspect) / 2;
    this.camera.top = view / 2;
    this.camera.bottom = -view / 2;
    this.camera.updateProjectionMatrix();
    this.syncRenderCamera();
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloomPass.setSize(w, h);
    this.ditherPass.setSize(w, h);
    this.resizeCanvasDitherOverlay(w, h);
    this.ui.resizeBeatLane();
  };

  whenReadyForDisplay(): Promise<void> {
    return this.readyForDisplayPromise;
  }

  /** Called after the loading screen is dismissed (initial boot). */
  showMainMenu(): void {
    this.ui.showMainMenu();
  }

  private loop(): void {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.update(dt);
    this.syncRenderCamera();
    this.composer.render();
    if (this.readyForDisplayResolve) {
      this.readyForDisplayResolve();
      this.readyForDisplayResolve = null;
    }
  }

  private update(dt: number): void {
    this.input.beginFrame();
    this.syncRunSurvivalClock();
    this.updateCameraZoomFromInput();
    this.syncBeatPlayButton();
    this.updateDamagePulseRings(dt);
    this.updateBloodEffects(dt);
    this.updatePhantomSplashEffects(dt);
    this.updatePendingSideDashes(dt);
    this.updateSideDashTrails(dt);
    this.updateDyingEnemies(dt);
    this.applyLensDistortionEffective();

    if (this.runPhase === 'death') {
      this.ui.setMusicMarquee(null);
      this.clearDashPastTankDebugOverlay();
      this.deathScreenTimer += dt;
      this.beatEffects.update(dt);
      this.updateCamera(dt);
      this.updateComboOverlay(dt);
      const instFpsD = dt > 1e-6 ? 1 / dt : 0;
      this.fpsSmoothed =
        this.fpsSmoothed <= 0
          ? instFpsD
          : this.fpsSmoothed * 0.92 + instFpsD * 0.08;
      this.ui.update(
        this.player.hp,
        getPlayerMaxHp(),
        this.enemies.length,
        this.player.dashCooldownRemaining,
        this.player.getShieldRegenVisualProgress(),
      );
      this.ui.setFps(this.fpsSmoothed);
      this.syncRunScoreUi();
      this.ui.setRunKills(this.runEnemiesKilled);
      this.syncRunXpUi();
      this.syncRunLootUi();
      this.ui.setVaultBearingAngle(null);
      if (this.deathScreenTimer >= CONFIG.deathScreenToMenuDelaySec) {
        this.goToMainMenuAfterDeath();
      }
      return;
    }

    this.syncMusicMarquee();

    if (this.runPhase === 'menu') {
      this.clearDashPastTankDebugOverlay();
      this.hideComboOverlay();
      this.beatEffects.update(dt);
      this.updateCamera(dt);
      const instFpsM = dt > 1e-6 ? 1 / dt : 0;
      this.fpsSmoothed =
        this.fpsSmoothed <= 0
          ? instFpsM
          : this.fpsSmoothed * 0.92 + instFpsM * 0.08;
      this.ui.update(
        this.player.hp,
        getPlayerMaxHp(),
        this.enemies.length,
        this.player.dashCooldownRemaining,
        0,
      );
      this.ui.setFps(this.fpsSmoothed);
      this.syncRunScoreUi();
      this.ui.setRunKills(0);
      this.syncRunXpUi();
      this.runGold = 0;
      this.runMana = 0;
      this.syncRunLootUi();
      this.ui.setVaultBearingAngle(null);
      void this.ensureBackgroundMusicPlaying();
      return;
    }

    if (this.runPhase === 'paused') {
      this.clearDashPastTankDebugOverlay();
      if (this.input.consumeEscapeTrigger()) {
        this.resumeFromPause();
      }
      this.beatEffects.update(dt);
      this.updateCamera(dt);
      const instFpsP = dt > 1e-6 ? 1 / dt : 0;
      this.fpsSmoothed =
        this.fpsSmoothed <= 0
          ? instFpsP
          : this.fpsSmoothed * 0.92 + instFpsP * 0.08;
      this.ui.update(
        this.player.hp,
        getPlayerMaxHp(),
        this.enemies.length,
        this.player.dashCooldownRemaining,
        this.player.getShieldRegenVisualProgress(),
      );
      this.ui.setFps(this.fpsSmoothed);
      this.syncRunScoreUi();
      this.ui.setRunKills(this.runEnemiesKilled);
      this.syncRunXpUi();
      this.syncRunLootUi();
      this.ui.setVaultBearingAngle(null);
      return;
    }

    if (this.runPhase === 'runUpgrade') {
      this.clearDashPastTankDebugOverlay();
      this.beatEffects.update(dt);
      this.updateCamera(dt);
      this.updateComboOverlay(dt);
      const instFpsU = dt > 1e-6 ? 1 / dt : 0;
      this.fpsSmoothed =
        this.fpsSmoothed <= 0
          ? instFpsU
          : this.fpsSmoothed * 0.92 + instFpsU * 0.08;
      this.ui.update(
        this.player.hp,
        getPlayerMaxHp(),
        this.enemies.length,
        this.player.dashCooldownRemaining,
        0,
      );
      this.ui.setFps(this.fpsSmoothed);
      this.syncRunScoreUi();
      this.ui.setRunKills(this.runEnemiesKilled);
      this.syncRunXpUi();
      this.syncRunLootUi();
      this.ui.setVaultBearingAngle(null);
      if (this.input.consumePlayTrackTrigger()) {
        void this.requestStartAudioPlayback();
      }
      return;
    }

    const aimOk = screenToGroundXZ(
      this.input.lastPointerClientX,
      this.input.lastPointerClientY,
      this.renderer.domElement,
      this.camera,
      CONFIG.floorY,
      this.groundHit,
    );

    if (this.input.consumeEscapeTrigger()) {
      this.enterPause();
      return;
    }

    if (this.input.consumePlayTrackTrigger()) {
      void this.requestStartAudioPlayback();
    }

    this.syncSpiralDashPreview();
    const spiralDashInput = this.consumeSpiralDashInput();
    if (spiralDashInput) {
      this.spiralPreviewRibbon.visible = false;
    }

    const diffMult = this.getDifficultyMultiplier();
    const maxSlots = this.getMaxEnemySlots();

    this.updateBeatPlayback(dt);
    this.beatFloor.update(
      dt,
      this.audio.currentTime,
      this.player.x,
      this.player.z,
      this.audio.isPlaying,
    );

    this.player.update(
      dt,
      this.input,
      aimOk ? this.groundHit : null,
      aimOk,
      this.getDashLengthWidthMultForThisFrame(),
      this.getActivePlayerSpeedMult(),
      this.enemies,
      this.runSpiralDashUnlocked,
      spiralDashInput,
      this.getActiveDashCooldownSec(),
    );
    if (this.player.consumeSpiralTeleportStarted()) {
      this.cameraController.beginTeleportCatchUp(CONFIG.spiralCameraCatchUpSec);
    }
    this.applyVaultWalkPseudoCollision();
    this.updateLightningAutoDashChain(dt);
    const mainDashStarted = this.player.consumeMainDashStarted();
    if (mainDashStarted) {
      this.pendingDashSfx = true;
      this.handleRunLightningDashStart();
    }
    this.tryRegisterDashBeatHit(mainDashStarted);

    const dashKills = this.resolveDashKills() + this.applyDeferredTankDashDamage();
    this.runEnemiesKilled += dashKills;
    const overlapPasses = Math.max(
      1,
      Math.floor(CONFIG.dashTankOverlapResolvePasses),
    );
    for (let p = 0; p < overlapPasses; p++) {
      this.player.resolveTankOverlapWhileDashing(this.enemies);
    }
    this.player.tickDashAfterHits(dt, isArtifactEnabled('reverseDash'));
    this.flushPendingDashSfxIfDashEnded();
    const land = this.player.consumeDashLandingPulseXZ();
    if (land) {
      const pulseMult = Math.max(
        isArtifactEnabled('bomb') ? 1 : 0,
        this.shouldPulseForSuccessfulBeatDash()
          ? this.getActiveDashLandingPulseRadiusMult()
          : 0,
      );
      if (pulseMult > 0) {
        this.spawnDamagePulseRingAt(land.x, land.z, pulseMult);
        this.runEnemiesKilled += this.applyPlayerDamagePulseToEnemiesAt(
          land.x,
          land.z,
          pulseMult,
        );
      }
    }
    if (this.player.tickShieldRegen(dt)) {
      this.ui.rebuildHpBarSegments();
    }
    this.updateRunRockets(dt);
    this.updateOrbitShield(dt);
    this.syncBeatLaneUi();
    this.syncDashPastTankDebug();
    if (dashKills > 0) {
      const add = Math.min(
        CONFIG.dashKillShakeCap,
        dashKills * CONFIG.dashKillShakePerEnemy,
      );
      this.cameraShake = Math.min(
        CONFIG.dashKillShakeCap,
        this.cameraShake + add,
      );
    }

    if (!this.player.areEnemiesFrozenByDash()) {
      const storageNav = this.enemies
        .filter((e) => e.isVault())
        .map((e) =>
          getConfiguredStorageObstacleDisk(e.mesh.position.x, e.mesh.position.z),
        );
      for (const e of this.enemies) {
        e.update(
          dt,
          this.player.x,
          this.player.z,
          (diffMult / this.getRunEnemySlowFactor()) * this.getSpiralEnemySpeedMult(),
          storageNav,
        );
        if (e.tickShooterShotCooldown(dt)) {
          this.spawnEnemyProjectile(e);
        }
      }
    } else {
      for (const e of this.enemies) {
        e.faceTarget(this.player.x, this.player.z);
        e.tickAngelShieldRegenOnly(dt);
      }
    }

    this.updateEnemyProjectiles(dt);

    this.spawner.update(
      dt,
      this.player.x,
      this.player.z,
      diffMult,
      maxSlots,
      this.runElapsedSec,
    );

    let touching = 0;
    for (const e of this.enemies) {
      if (e.isVault() && e.getActiveShieldCount() > 0) {
        continue;
      }
      if (e.isResourceSack()) {
        continue;
      }
      if (
        circlesOverlap(
          this.player.x,
          this.player.z,
          CONFIG.playerRadius,
          e.mesh.position.x,
          e.mesh.position.z,
          e.bodyRadius,
        )
      ) {
        touching += 1;
      }
    }
    if (
      touching > 0 &&
      this.player.hp > 0 &&
      !this.isTapeTrackPlaying() &&
      !this.player.isInvulnerable()
    ) {
      this.damagePlayerAndPulse(CONFIG.contactDamagePerTick * touching);
    }

    this.updateCamera(dt);
    this.updateComboOverlay(dt);

    const instFps = dt > 1e-6 ? 1 / dt : 0;
    this.fpsSmoothed =
      this.fpsSmoothed <= 0
        ? instFps
        : this.fpsSmoothed * 0.92 + instFps * 0.08;

    this.ui.update(
      this.player.hp,
      getPlayerMaxHp(),
      this.enemies.length,
      this.player.dashCooldownRemaining,
      this.player.getShieldRegenVisualProgress(),
    );
    this.ui.setFps(this.fpsSmoothed);
    this.ui.setBeatHitCount(this.beatHitCount);
    this.syncRunScoreUi();
    this.ui.setRunKills(this.runEnemiesKilled);
    this.syncRunXpUi();
    this.syncRunLootUi();
    this.syncVaultBearingUi();

    if (this.player.hp > 0) {
      this.maybeEnterRunUpgrade();
    }

    if (this.player.hp <= 0) {
      this.ui.hideRunUpgradeModal();
      this.pendingDashSfx = false;
      this.runPhase = 'death';
      this.syncRunHudLayout();
      this.deathScreenTimer = 0;
      this.clearEnemyProjectiles();
      const deathLevel = this.getRunXpProgress(this.runXpTotal).level;
      const finalScore = this.getRunScore();
      this.ui.setDeathScreenRunSummary({
        score: finalScore,
        kills: this.runEnemiesKilled,
        level: deathLevel,
      });
      const track = findTrackForStage(this.selectedTrackStage.id);
      const trackLabel = track?.label ?? 'Track';
      const trackName = `${trackLabel} / ${this.selectedTrackStage.label}`;
      const improved = submitHighScore({
        cheatMode: this.runCheatModeActive,
        score: finalScore,
        trackLabel,
        stageLabel: this.selectedTrackStage.label,
      });
      if (improved) {
        void syncRunToLeaderboard({
          score: finalScore,
          trackId: track?.id ?? this.selectedTrackStage.id,
          trackName,
          cheatMode: this.runCheatModeActive,
        });
      }
      this.depositRunGold();
      this.ui.showDeathScreen();
      this.beatFloor.onTrackEnded();
      this.audio.pause();
      void this.ensureBackgroundMusicPlaying();
    }
  }

  /** `1` at run start, `2` after `difficultyRampTimeSec`, capped by `difficultyMaxMultiplier`. */
  private getDifficultyMultiplier(): number {
    return Math.min(
      CONFIG.difficultyMaxMultiplier,
      1 + this.runElapsedSec / CONFIG.difficultyRampTimeSec,
    );
  }

  private getMaxEnemySlots(): number {
    const m = this.getDifficultyMultiplier();
    return Math.min(
      CONFIG.difficultyMaxEnemyCountCap,
      Math.max(1, Math.floor(CONFIG.maxEnemies * m)),
    );
  }

  private clearDamagePulseRings(): void {
    for (const p of this.damagePulseRings) {
      this.scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mat.dispose();
    }
    this.damagePulseRings.length = 0;
  }

  private clearPhantomSplashEffects(): void {
    this.pendingPhantomSplashes.length = 0;
    for (const p of this.phantomSplashTrails) {
      this.scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mat.dispose();
    }
    this.phantomSplashTrails.length = 0;
    this.pendingSideDashes.length = 0;
    for (const p of this.sideDashTrails) {
      this.scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mat.dispose();
    }
    this.sideDashTrails.length = 0;
  }

  private clearBloodEffects(): void {
    for (const p of this.bloodPuddles) {
      this.scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mat.map?.dispose();
      p.mat.dispose();
    }
    this.bloodPuddles.length = 0;
    for (const p of this.bloodParticles) {
      this.scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mat.dispose();
    }
    this.bloodParticles.length = 0;
    this.pendingBloodSplashes.length = 0;
  }

  private clearAllEnemies(): void {
    for (const e of this.enemies) {
      e.dispose(this.scene);
    }
    this.enemies.length = 0;
    for (const d of this.dyingEnemies) {
      d.enemy.dispose(this.scene);
    }
    this.dyingEnemies.length = 0;
  }

  private removeEnemyFromGameplayAt(
    index: number,
    dashDir?: { x: number; z: number; passPower?: number },
  ): Enemy | null {
    const enemy = this.enemies[index];
    if (!enemy) return null;
    this.enemies.splice(index, 1);
    this.registerComboKill(enemy.mesh.position.x, enemy.mesh.position.z);
    this.playDeathSfx();
    this.queueBloodSplash(
      enemy.mesh.position.x,
      enemy.mesh.position.z,
      enemy.bodyRadius,
      this.getBloodPaletteForEnemy(enemy),
      dashDir,
    );
    enemy.showDeathSprite();
    this.dyingEnemies.push({ enemy, age: 0 });
    return enemy;
  }

  private updateDyingEnemies(dt: number): void {
    const linger = Math.max(0, CONFIG.enemyDeathLingerSec);
    for (let i = this.dyingEnemies.length - 1; i >= 0; i--) {
      const d = this.dyingEnemies[i]!;
      d.age += dt;
      if (d.age < linger) continue;
      d.enemy.dispose(this.scene);
      this.dyingEnemies.splice(i, 1);
    }
  }

  private registerComboKill(x: number, z: number): void {
    this.comboCount += 1;
    this.comboTimeLeftSec = 1.5;
    this.comboWorldX = x;
    this.comboWorldZ = z;
    if (this.comboCount < 2) {
      this.comboEl.classList.add('combo-pop--hidden');
      return;
    }
    const growT = Math.max(0, Math.min(1, (this.comboCount - 2) / 8));
    const comboSize = 21 + growT * 4;
    const countSize = 21 + growT * 14;
    const countColor = this.mixHexColor(0xf7fbff, 0xfa2367, growT);
    this.comboEl.innerHTML = `<span class="combo-pop__label">COMBO</span> <span class="combo-pop__count">x${this.comboCount}</span>`;
    this.comboEl.style.setProperty('--combo-label-size', `${comboSize}px`);
    this.comboEl.style.setProperty('--combo-count-size', `${countSize}px`);
    this.comboEl.style.setProperty('--combo-count-color', countColor);
    this.comboEl.classList.remove('combo-pop--hidden');
    this.comboEl.classList.remove('combo-pop--hit');
    void this.comboEl.offsetWidth;
    this.comboEl.classList.add('combo-pop--hit');
  }

  private updateComboOverlay(dt: number): void {
    if (this.comboTimeLeftSec <= 0) {
      this.hideComboOverlay();
      return;
    }
    this.comboTimeLeftSec = Math.max(0, this.comboTimeLeftSec - Math.max(0, dt));
    if (this.comboTimeLeftSec <= 0) {
      this.hideComboOverlay();
      return;
    }

    this.comboScreenPos.set(this.comboWorldX, CONFIG.floorY + 1.2, this.comboWorldZ);
    this.comboScreenPos.project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = (this.comboScreenPos.x * 0.5 + 0.5) * rect.width;
    const y = (-this.comboScreenPos.y * 0.5 + 0.5) * rect.height;
    this.comboEl.style.transform = `translate3d(${x}px, ${y}px, 0) translate(0, -100%)`;
  }

  private hideComboOverlay(): void {
    if (this.comboCount <= 0 && this.comboTimeLeftSec <= 0) return;
    this.comboCount = 0;
    this.comboTimeLeftSec = 0;
    this.comboEl.classList.add('combo-pop--hidden');
    this.comboEl.classList.remove('combo-pop--hit');
  }

  private mixHexColor(from: number, to: number, t: number): string {
    const u = Math.max(0, Math.min(1, t));
    const fr = (from >> 16) & 0xff;
    const fg = (from >> 8) & 0xff;
    const fb = from & 0xff;
    const tr = (to >> 16) & 0xff;
    const tg = (to >> 8) & 0xff;
    const tb = to & 0xff;
    const r = Math.round(fr + (tr - fr) * u);
    const g = Math.round(fg + (tg - fg) * u);
    const b = Math.round(fb + (tb - fb) * u);
    return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
  }

  private getBloodPaletteForEnemy(enemy: Enemy): BloodPalette {
    if (enemy.isGoldSack()) return BLOOD_PALETTE_GOLD_SACK;
    if (enemy.isManaSack()) return BLOOD_PALETTE_MANA_SACK;
    if (enemy.isVault() || enemy.isAngel()) return BLOOD_PALETTE_VAULT;
    return BLOOD_PALETTE_DEFAULT;
  }

  private queueShieldBloodSplash(
    enemy: Enemy,
    dashDir?: { x: number; z: number; passPower?: number },
  ): void {
    this.queueBloodSplash(
      enemy.mesh.position.x,
      enemy.mesh.position.z,
      enemy.bodyRadius * 0.62,
      BLOOD_PALETTE_VAULT,
      dashDir,
    );
  }

  private queueBloodSplash(
    x: number,
    z: number,
    bodyRadius: number,
    palette: BloodPalette,
    dashDir?: { x: number; z: number; passPower?: number },
  ): void {
    this.pendingBloodSplashes.push({
      delay: BLOOD_SPLASH_DELAY_SEC,
      x,
      z,
      bodyRadius,
      palette,
      dashDir,
    });
  }

  private spawnBloodSplash(
    x: number,
    z: number,
    bodyRadius: number,
    palette: BloodPalette,
    dashDir?: { x: number; z: number; passPower?: number },
  ): void {
    const radius = Math.max(0.25, bodyRadius * CONFIG.enemyBloodPuddleRadiusMult);
    let dirX = 0;
    let dirZ = 0;
    const dirLen = dashDir ? Math.hypot(dashDir.x, dashDir.z) : 0;
    const directional = dirLen > 1e-4;
    if (directional && dashDir) {
      dirX = dashDir.x / dirLen;
      dirZ = dashDir.z / dirLen;
    }
    const passPower = directional
      ? Math.max(0, Math.min(1, dashDir?.passPower ?? 1))
      : 0;
    const stretchActive = directional && passPower > 0.02;
    const sideX = -dirZ;
    const sideZ = dirX;
    const shape = new THREE.Shape();
    const points = 18;
    for (let i = 0; i <= points; i++) {
      const a = (i / points) * Math.PI * 2;
      const wobble =
        0.78 +
        Math.random() * 0.34 +
        Math.sin(a * 3 + Math.random() * 0.4) * 0.08;
      const forward = Math.cos(a);
      const lateral = Math.sin(a);
      const forwardScale = stretchActive
        ? (forward >= 0 ? 1 + 3.5 * passPower : 1 - 0.35 * passPower)
        : 1;
      const forwardOffset = stretchActive ? radius * 0.68 * passPower : 0;
      const along = forward * radius * wobble * forwardScale + forwardOffset;
      const across = lateral * radius * wobble * (stretchActive ? 0.95 : 1);
      const worldX = stretchActive ? dirX * along + sideX * across : along;
      const worldZ = stretchActive ? dirZ * along + sideZ * across : across;
      // Shape local Y becomes negative world Z after rotation.x = -PI / 2.
      const shapeY = -worldZ;
      if (i === 0) shape.moveTo(worldX, shapeY);
      else shape.lineTo(worldX, shapeY);
    }
    shape.closePath();

    const mat = new THREE.MeshBasicMaterial({
      map: this.createBloodPuddleTexture(bodyRadius, palette),
      color: 0xffffff,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, CONFIG.floorY + 0.012, z);
    mesh.scale.setScalar(0.42);
    mesh.renderOrder = 2;
    this.scene.add(mesh);
    this.bloodPuddles.push({
      mesh,
      mat,
      age: 0,
      life: Math.max(0.1, CONFIG.enemyBloodPuddleLifeSec),
      baseScale: 1 + Math.random() * 0.18,
      shimmerSeed: Math.random() * Math.PI * 2,
    });

    const count = Math.max(0, Math.floor(CONFIG.enemyBloodParticleCount));
    for (let i = 0; i < count; i++) {
      const spread = Math.PI * (1 - passPower) + 0.55 * passPower;
      const a = stretchActive
        ? Math.atan2(dirZ, dirX) + (Math.random() * 2 - 1) * spread
        : Math.random() * Math.PI * 2;
      const speed =
        CONFIG.enemyBloodParticleSpeed * (0.25 + Math.random() * 0.75) *
        Math.max(0.55, Math.min(1.7, bodyRadius)) *
        (1 + 0.75 * passPower);
      const size = 0.24 + Math.random() * 0.28;
      const pMat = new THREE.MeshBasicMaterial({
        color: palette[Math.floor(Math.random() * palette.length)]!,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const pMesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), pMat);
      pMesh.rotation.x = -Math.PI / 2;
      pMesh.rotation.z = Math.random() * Math.PI;
      const spawnScatter = radius * (0.1 + Math.random() * 0.75);
      const scatterA = Math.random() * Math.PI * 2;
      const forwardScatter = stretchActive
        ? radius * passPower * (0.68 + Math.random() * 1.88)
        : 0;
      pMesh.position.set(
        x + dirX * forwardScatter + Math.cos(scatterA) * spawnScatter,
        CONFIG.floorY + 0.018,
        z + dirZ * forwardScatter + Math.sin(scatterA) * spawnScatter,
      );
      pMesh.renderOrder = 3;
      this.scene.add(pMesh);
      this.bloodParticles.push({
        mesh: pMesh,
        mat: pMat,
        vx: Math.cos(a) * speed,
        vz: Math.sin(a) * speed,
        age: 0,
        life: Math.max(0.1, CONFIG.enemyBloodPuddleLifeSec),
      });
    }
  }

  private createBloodPuddleTexture(
    bodyRadius: number,
    palette: BloodPalette,
  ): THREE.CanvasTexture {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Could not create blood texture canvas');
    }

    const base = ctx.createLinearGradient(0, 0, size, size);
    base.addColorStop(0, `#${palette[0].toString(16).padStart(6, '0')}`);
    base.addColorStop(0.52, `#${palette[1].toString(16).padStart(6, '0')}`);
    base.addColorStop(1, `#${palette[2].toString(16).padStart(6, '0')}`);
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, size, size);

    for (let i = 0; i < 38; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const r = size * (0.06 + Math.random() * 0.22);
      const c0 = `#${palette[Math.floor(Math.random() * palette.length)]!.toString(16).padStart(6, '0')}`;
      const c1 = `#${palette[Math.floor(Math.random() * palette.length)]!.toString(16).padStart(6, '0')}`;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, c0);
      g.addColorStop(1, c1);
      ctx.globalAlpha = 0.32 + Math.random() * 0.42;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(
        x,
        y,
        r * (0.7 + Math.random() * 0.8),
        r * (0.35 + Math.random() * 0.65),
        Math.random() * Math.PI,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    const bodyScale = Math.max(0.001, bodyRadius / CONFIG.enemyRadius);
    const repeat = 0.17 / bodyScale;
    texture.repeat.set(repeat, repeat);
    texture.rotation = Math.random() * Math.PI * 2;
    texture.needsUpdate = true;
    return texture;
  }

  private getDashBloodImpact(
    enemyX: number,
    enemyZ: number,
    bodyRadius: number,
    dashDir: { x: number; z: number },
  ): { x: number; z: number; passPower: number } {
    const dirLen = Math.hypot(dashDir.x, dashDir.z);
    if (dirLen <= 1e-4) return { x: 0, z: 0, passPower: 0 };
    const dirX = dashDir.x / dirLen;
    const dirZ = dashDir.z / dirLen;
    const projectedEnd = this.player.getProjectedDashEndXZ();
    const playerPastEnemy =
      (projectedEnd.x - enemyX) * dirX + (projectedEnd.z - enemyZ) * dirZ;
    const fullStretchDist = Math.max(0.35, bodyRadius * 2.2);
    const passPower = Math.max(0, Math.min(1, playerPastEnemy / fullStretchDist));
    return { x: dirX, z: dirZ, passPower };
  }

  private updateBloodEffects(dt: number): void {
    for (let i = this.pendingBloodSplashes.length - 1; i >= 0; i--) {
      const p = this.pendingBloodSplashes[i]!;
      p.delay -= dt;
      if (p.delay > 0) continue;
      this.spawnBloodSplash(p.x, p.z, p.bodyRadius, p.palette, p.dashDir);
      this.pendingBloodSplashes.splice(i, 1);
    }

    for (let i = this.bloodPuddles.length - 1; i >= 0; i--) {
      const p = this.bloodPuddles[i]!;
      p.age += dt;
      const t = Math.min(1, p.age / p.life);
      const spreadT = Math.min(1, t / 0.16);
      const spread = p.baseScale * (0.86 + 0.14 * (1 - Math.pow(1 - spreadT, 3)));
      p.mesh.scale.setScalar(spread);
      const map = p.mat.map;
      if (map) {
        map.offset.x = Math.sin(p.age * 3.1 + p.shimmerSeed) * 0.04;
        map.offset.y = Math.cos(p.age * 2.4 + p.shimmerSeed) * 0.04;
      }
      p.mat.opacity = 0.82 * (1 - Math.max(0, t - 0.28) / 0.72);
      if (p.age < p.life) continue;
      this.scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mat.map?.dispose();
      p.mat.dispose();
      this.bloodPuddles.splice(i, 1);
    }

    for (let i = this.bloodParticles.length - 1; i >= 0; i--) {
      const p = this.bloodParticles[i]!;
      p.age += dt;
      const t = Math.min(1, p.age / Math.max(0.001, p.life));
      const drag = Math.pow(0.035, dt);
      p.vx *= drag;
      p.vz *= drag;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.z += p.vz * dt;
      p.mesh.rotation.z += (p.vx - p.vz) * dt * 0.2;
      p.mat.opacity = 0.9 * (1 - t);
      if (p.age < p.life) continue;
      this.scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mat.dispose();
      this.bloodParticles.splice(i, 1);
    }
  }

  private clearEnemyProjectiles(): void {
    for (const p of this.enemyProjectiles) {
      this.scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      (p.mesh.material as THREE.Material).dispose();
    }
    this.enemyProjectiles.length = 0;
  }

  /** Shooter volley size: 1 → 2 → 3 as run difficulty ramps. */
  private getShooterVolleyCount(): number {
    const diff = this.getDifficultyMultiplier();
    return Math.min(
      CONFIG.shooterVolleyMaxCount,
      Math.max(1, Math.round(diff)),
    );
  }

  private spawnEnemyProjectile(enemy: Enemy): void {
    const dx = this.player.x - enemy.mesh.position.x;
    const dz = this.player.z - enemy.mesh.position.z;
    const len = Math.hypot(dx, dz);
    if (len <= 1e-4) return;
    const baseNx = dx / len;
    const baseNz = dz / len;
    const perpX = -baseNz;
    const perpZ = baseNx;
    const r = CONFIG.shooterProjectileRadius;
    const startOffset = enemy.bodyRadius + r + 0.08;
    const count = this.getShooterVolleyCount();
    const spread = CONFIG.shooterVolleySpreadRad;
    const lateralStep = CONFIG.shooterVolleyLateralSpacing;
    const center = (count - 1) * 0.5;

    for (let i = 0; i < count; i++) {
      const slot = i - center;
      const angle = slot * spread;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const nx = baseNx * cos - baseNz * sin;
      const nz = baseNx * sin + baseNz * cos;
      const lateral = slot * lateralStep;
      const geo = new THREE.SphereGeometry(r, 12, 8);
      const mat = new THREE.MeshBasicMaterial({
        color: CONFIG.shooterProjectileColor,
        transparent: true,
        opacity: 0.96,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(
        enemy.mesh.position.x + nx * startOffset + perpX * lateral,
        CONFIG.floorY + 0.28,
        enemy.mesh.position.z + nz * startOffset + perpZ * lateral,
      );
      this.scene.add(mesh);
      const speed = CONFIG.shooterProjectileSpeed;
      this.enemyProjectiles.push({
        mesh,
        vx: nx * speed,
        vz: nz * speed,
        age: 0,
      });
    }
  }

  private updateEnemyProjectiles(dt: number): void {
    const maxAge = Math.max(0.1, CONFIG.shooterProjectileMaxAgeSec);
    for (let i = this.enemyProjectiles.length - 1; i >= 0; i--) {
      const p = this.enemyProjectiles[i]!;
      p.age += dt;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.z += p.vz * dt;
      if (this.projectileHitsOrbitShield(p.mesh.position.x, p.mesh.position.z)) {
        this.removeEnemyProjectileAt(i);
        continue;
      }
      if (
        this.player.hp > 0 &&
        !this.isTapeTrackPlaying() &&
        !this.player.isInvulnerable() &&
        circlesOverlap(
          this.player.x,
          this.player.z,
          CONFIG.playerRadius,
          p.mesh.position.x,
          p.mesh.position.z,
          CONFIG.shooterProjectileRadius,
        )
      ) {
        this.damagePlayerAndPulse(CONFIG.shooterProjectileDamage);
        this.removeEnemyProjectileAt(i);
        continue;
      }
      if (p.age >= maxAge) {
        this.removeEnemyProjectileAt(i);
      }
    }
  }

  private removeEnemyProjectileAt(index: number): void {
    const p = this.enemyProjectiles[index];
    if (!p) return;
    this.scene.remove(p.mesh);
    p.mesh.geometry.dispose();
    (p.mesh.material as THREE.Material).dispose();
    this.enemyProjectiles.splice(index, 1);
  }

  private updatePhantomSplashEffects(dt: number): void {
    for (let i = this.pendingPhantomSplashes.length - 1; i >= 0; i--) {
      const p = this.pendingPhantomSplashes[i]!;
      p.delay -= dt;
      if (p.delay > 0) continue;
      this.pendingPhantomSplashes.splice(i, 1);
      this.triggerTrack3PhantomSplash();
    }

    for (let i = this.phantomSplashTrails.length - 1; i >= 0; i--) {
      const p = this.phantomSplashTrails[i]!;
      p.age += dt;
      const t = Math.min(1, p.age / Math.max(0.001, p.life));
      p.mat.opacity = 0.9 * (1 - t);
      if (p.age < p.life) continue;
      this.scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mat.dispose();
      this.phantomSplashTrails.splice(i, 1);
    }
  }

  private triggerTrack3PhantomSplash(): void {
    this.triggerNearestEnemyStrike(0xe8f799, 'phantom');
  }

  private triggerNearestEnemyStrike(
    color: number,
    source: 'phantom' | 'lightning',
  ): void {
    if (this.runPhase !== 'playing' || this.enemies.length <= 0 || this.player.hp <= 0) {
      return;
    }

    let bestIndex = -1;
    let bestD2 = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i]!;
      const dx = e.mesh.position.x - this.player.x;
      const dz = e.mesh.position.z - this.player.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= bestD2) continue;
      bestD2 = d2;
      bestIndex = i;
    }
    if (bestIndex < 0) return;

    const e = this.enemies[bestIndex]!;
    const sx = this.player.x;
    const sz = this.player.z;
    const tx = e.mesh.position.x;
    const tz = e.mesh.position.z;
    this.spawnPhantomSplashTrail(sx, sz, tx, tz, color, source);

    const dx = tx - sx;
    const dz = tz - sz;
    const len = Math.hypot(dx, dz);
    const dir = len > 1e-4 ? { x: dx / len, z: dz / len, passPower: 1 } : undefined;
    const seg = { ax: sx, az: sz, bx: tx, bz: tz };
    let died = false;

    if ((e.isVault() || e.isAngel()) && e.getActiveShieldCount() > 0) {
      const scaledPlayer = CONFIG.playerRadius * getDashKillRadiusScale();
      if (e.tryBreakVaultShieldWithDash(seg, this.getVaultShieldJoinRadius(scaledPlayer))) {
        this.queueShieldBloodSplash(e, dir);
      }
      this.markDashImpactSfx();
    } else {
      died = e.takeDashHit(e.isAngel());
      this.markDashImpactSfx();
    }

    if (!died) return;
    this.handleResourceSackLoot(e);
    this.awardEnemyKillXp(e);
    this.removeEnemyFromGameplayAt(bestIndex, dir);
    this.runEnemiesKilled += 1;
  }

  private spawnPhantomSplashTrail(
    sx: number,
    sz: number,
    tx: number,
    tz: number,
    color = 0xe8f799,
    source: 'phantom' | 'lightning' = 'phantom',
  ): void {
    const y = CONFIG.floorY + 0.34;
    const dx = tx - sx;
    const dz = tz - sz;
    const len = Math.hypot(dx, dz);
    if (len <= 1e-4) return;
    const nx = -dz / len;
    const nz = dx / len;
    const midX = sx + dx * 0.62;
    const midZ = sz + dz * 0.62;
    const startHalfW = 0.035;
    const midHalfW = source === 'lightning' ? 0.18 : 0.28;
    const endHalfW = 0.05;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([
          sx + nx * startHalfW, y, sz + nz * startHalfW,
          sx - nx * startHalfW, y, sz - nz * startHalfW,
          midX + nx * midHalfW, y, midZ + nz * midHalfW,
          midX - nx * midHalfW, y, midZ - nz * midHalfW,
          tx + nx * endHalfW, y, tz + nz * endHalfW,
          tx - nx * endHalfW, y, tz - nz * endHalfW,
        ]),
        3,
      ),
    );
    geo.setIndex([0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5]);
    geo.computeBoundingSphere();
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 12;
    this.scene.add(mesh);
    this.phantomSplashTrails.push({
      mesh,
      mat,
      age: 0,
      life: PHANTOM_SPLASH_TRAIL_LIFE_SEC,
    });
  }

  /** Cassette / beatmap track is playing — immune to enemies; beat misses still hurt. */
  private isTapeTrackPlaying(): boolean {
    return this.runPhase === 'playing' && this.audio.isPlaying;
  }

  /** Run mana cannot increase from loot while the tape plays. */
  private canGainRunMana(): boolean {
    return !this.isTapeTrackPlaying();
  }

  private damagePlayerAndPulse(amount: number): void {
    if (this.player.hp <= 0) return;
    if (this.isTapeTrackPlaying()) return;
    const hpBefore = this.player.hp;
    this.player.takeDamage(amount);
    if (this.player.hp >= hpBefore) return;
    this.ui.triggerDamageScreenFlash();
    this.spawnDamagePulseRingAt(this.player.x, this.player.z);
    this.runEnemiesKilled += this.applyPlayerDamagePulseToEnemiesAt(
      this.player.x,
      this.player.z,
    );
  }

  private damagePlayerForBeatMistake(): void {
    if (this.runPhase !== 'playing' || this.player.hp <= 0) return;
    this.markTrackBeatMissed();
    if (this.isTapeTrackPlaying()) {
      this.damagePlayerForBeatMistakeDuringTape(1);
      return;
    }
    this.damagePlayerAndPulse(1);
  }

  /** Beat miss damage while tape plays — bypasses dash/contact invuln. */
  private damagePlayerForBeatMistakeDuringTape(amount: number): void {
    if (this.player.hp <= 0) return;
    const hpBefore = this.player.hp;
    this.player.takeDamage(amount, true);
    if (this.player.hp >= hpBefore) return;
    this.ui.triggerDamageScreenFlash();
    this.spawnDamagePulseRingAt(this.player.x, this.player.z);
    this.runEnemiesKilled += this.applyPlayerDamagePulseToEnemiesAt(
      this.player.x,
      this.player.z,
    );
  }

  private resetRunSurvivalClock(): void {
    this.runClockStartedAtMs = performance.now();
    this.runClockPausedTotalMs = 0;
    this.runClockPauseStartedAtMs = null;
    this.runElapsedSec = 0;
  }

  /** Pause survival clock during upgrade modal / death / menu (not during track playback). */
  private syncRunSurvivalClockPause(): void {
    const shouldPause =
      this.runPhase === 'runUpgrade' ||
      this.runPhase === 'paused' ||
      this.runPhase === 'death' ||
      this.runPhase === 'menu';
    if (shouldPause) {
      if (this.runClockPauseStartedAtMs === null) {
        this.runClockPauseStartedAtMs = performance.now();
      }
      return;
    }
    if (this.runClockPauseStartedAtMs !== null) {
      this.runClockPausedTotalMs += performance.now() - this.runClockPauseStartedAtMs;
      this.runClockPauseStartedAtMs = null;
    }
  }

  private syncRunSurvivalClock(): void {
    this.syncRunSurvivalClockPause();
    if (this.runClockStartedAtMs <= 0) {
      this.runElapsedSec = 0;
      return;
    }
    let elapsedMs =
      performance.now() - this.runClockStartedAtMs - this.runClockPausedTotalMs;
    if (this.runClockPauseStartedAtMs !== null) {
      elapsedMs -= performance.now() - this.runClockPauseStartedAtMs;
    }
    this.runElapsedSec = Math.max(0, elapsedMs / 1000);
  }

  private enterPause(): void {
    if (this.runPhase !== 'playing') return;
    this.runPhase = 'paused';
    this.beatAudioPausedForPause = this.audio.isPlaying;
    if (this.beatAudioPausedForPause) {
      this.audio.pause();
    }
    this.ui.showPauseMenu();
  }

  private resumeFromPause(): void {
    if (this.runPhase !== 'paused') return;
    this.runPhase = 'playing';
    this.ui.hidePauseMenu();
    if (this.beatAudioPausedForPause) {
      void this.audio.play().catch(() => {
        /* playback may be blocked */
      });
    }
    this.beatAudioPausedForPause = false;
  }

  private goToMainMenuFromPause(): void {
    if (this.runPhase !== 'paused') return;
    this.ui.hidePauseMenu();
    this.beatAudioPausedForPause = false;
    this.abandonRunToMainMenu();
  }

  private abandonRunToMainMenu(): void {
    this.depositRunGold();
    this.resetRunSurvivalClock();
    this.runEnemiesKilled = 0;
    this.runGold = 0;
    this.runMana = 0;
    this.runScoreBonus = 0;
    this.runScoreLastSecondFloor = -1;
    this.currentTrackMissed = false;
    this.runXpTotal = 0;
    this.runLevelUpsAwarded = 0;
    this.runNextUpgradeAtXp = CONFIG.runXpPerLevel;
    this.runPendingUpgradeMilestones.length = 0;
    this.wasTrackPlayingLastFrame = false;
    this.pendingDashSfx = false;
    this.resetRunUpgradeBonuses();
    clearRunBalanceBonuses();
    this.ui.hideRunUpgradeModal();
    this.ui.hidePauseMenu();
    this.clearDamagePulseRings();
    this.clearPhantomSplashEffects();
    this.clearBloodEffects();
    this.clearAllEnemies();
    this.clearEnemyProjectiles();
    this.hideComboOverlay();
    this.player.resetForNewRun();
    this.spawner.reset();
    this.resetBeatHitTracking();
    this.nextBeatIndex = 0;
    this.beatFloor.onTrackEnded();
    this.audio.pause();
    this.audio.reset();
    void this.ensureBackgroundMusicPlaying();
    this.cameraShake = 0;
    this.deathScreenTimer = 0;
    this.runPhase = 'menu';
    this.ui.hideDeathScreen();
    this.ui.showMainMenu();
  }

  private async startGameFromMenu(): Promise<void> {
    if (this.runPhase === 'playing') {
      return;
    }
    await ensureLvlupAssetsLoaded();
    clearRunBalanceBonuses();
    this.runCheatModeActive = this.ui.isCheatModeEnabled();
    this.resetRunSurvivalClock();
    this.runEnemiesKilled = 0;
    this.runGold = 0;
    this.runMana = 0;
    this.runScoreBonus = 0;
    this.runScoreLastSecondFloor = -1;
    this.currentTrackMissed = false;
    this.runXpTotal = 0;
    this.runLevelUpsAwarded = 0;
    this.runNextUpgradeAtXp = CONFIG.runXpPerLevel;
    this.runPendingUpgradeMilestones.length = 0;
    this.wasTrackPlayingLastFrame = false;
    this.pendingDashSfx = false;
    this.resetRunUpgradeBonuses();
    this.clearDamagePulseRings();
    this.clearPhantomSplashEffects();
    this.clearBloodEffects();
    this.clearAllEnemies();
    this.clearEnemyProjectiles();
    this.hideComboOverlay();
    this.player.resetForNewRun();
    this.ui.rebuildHpBarSegments();
    this.spawner.reset();
    this.spawner.spawnBurstAround(
      this.player.x,
      this.player.z,
      CONFIG.initialEnemyCount,
      this.getMaxEnemySlots(),
    );
    this.spawner.spawnGuaranteedVaultIfRoom(
      this.player.x,
      this.player.z,
      this.getMaxEnemySlots(),
    );
    this.resetBeatHitTracking();
    this.nextBeatIndex = 0;
    this.beatFloor.onTrackEnded();
    this.audio.reset();
    this.cameraShake = 0;
    this.runPhase = 'playing';
    this.syncRunHudLayout();
    this.ui.hideMainMenu();
    this.ui.hideDeathScreen();
    this.ui.hidePauseMenu();
    this.ui.hideRunUpgradeModal();
    this.ui.setRunKills(0);
    this.syncRunScoreUi();
    this.syncRunXpUi();
    this.syncRunLootUi();
    void this.ensureBackgroundMusicPlaying();
  }

  private syncRunLootUi(): void {
    this.ui.setRunGoldMana(this.runGold, this.runMana);
    this.syncWalletGoldUi();
  }

  private depositRunGold(): void {
    if (this.runGold > 0) {
      addPlayerGold(this.runGold);
      this.runGold = 0;
    }
    this.syncWalletGoldUi();
  }

  private syncWalletGoldUi(): void {
    const gold = getPlayerGold() + this.runGold;
    const inRun =
      this.runPhase === 'playing' ||
      this.runPhase === 'paused' ||
      this.runPhase === 'runUpgrade';
    this.ui.setWalletDisplay(gold, inRun ? this.runMana : null);
  }

  private goToMainMenuAfterDeath(): void {
    this.abandonRunToMainMenu();
  }

  private resetBeatHitTracking(): void {
    this.beatHitIndices.clear();
    this.beatPenaltyIndices.clear();
    this.dashSerialsWithBeatHit.clear();
    this.beatHitCount = 0;
    this.currentTrackMissed = false;
  }

  /** Total run score: per-second survival + kill/track bonuses. */
  private getRunScore(): number {
    const perSecond =
      Math.floor(this.runElapsedSec) * CONFIG.runScorePerSecond;
    return perSecond + this.runScoreBonus;
  }

  private syncRunScoreUi(): void {
    const secFloor = Math.floor(this.runElapsedSec);
    if (secFloor > this.runScoreLastSecondFloor) {
      this.runScoreLastSecondFloor = secFloor;
    }
    this.ui.setRunScore(this.getRunScore());
  }

  private addRunScoreBonus(amount: number): void {
    const n = Math.floor(Number(amount));
    if (!Number.isFinite(n) || n <= 0) return;
    this.runScoreBonus += n;
    this.syncRunScoreUi();
  }

  private awardKillScore(): void {
    let add = CONFIG.runScorePerMobKill;
    if (this.comboCount >= 2) {
      add += CONFIG.runScorePerComboKill;
    }
    this.addRunScoreBonus(add);
  }

  private finalizeTrackPlaybackEnd(): void {
    this.addRunScoreBonus(CONFIG.runScoreTrackComplete);
    if (!this.currentTrackMissed) {
      this.addRunScoreBonus(CONFIG.runScoreTrackPerfectBonus);
    }
  }

  private markTrackBeatMissed(): void {
    this.currentTrackMissed = true;
  }

  /** Closest beat index whose dash timing window contains `t`, or -1. */
  private findBestBeatInDashWindowAtTime(t: number): number {
    if (!this.beatmap) return -1;
    const beats = this.beatmap.beats;
    const before = CONFIG.dashBeatWindowBeforeSec;
    const after = CONFIG.dashBeatWindowAfterSec;
    let bestI = -1;
    let bestAbs = Number.POSITIVE_INFINITY;
    for (let i = 0; i < beats.length; i++) {
      const bt = beats[i]!.time;
      if (t < bt - before || t > bt + after) continue;
      const d = Math.abs(t - bt);
      if (d < bestAbs) {
        bestAbs = d;
        bestI = i;
      }
    }
    return bestI;
  }

  /**
   * If the player is about to start a main dash this frame and it will newly hit a beat,
   * scale dash length & trail width (see selected track-stage boost).
   */
  private getDashLengthWidthMultForThisFrame(): number {
    const base = this.getActiveDashLengthMult();
    if (!this.input.wouldDashTriggerThisFrame()) return 1;
    if (!this.beatmap || this.player.hp <= 0) return base;
    if (this.player.isMicroDashing) return base;
    if (this.player.dash.cooldownLeft > 0 || this.player.dash.timeLeft > 0) return base;
    const i = this.findBestBeatInDashWindowAtTime(this.audio.currentTime);
    if (i < 0 || this.beatHitIndices.has(i)) return base;
    const mult = this.selectedTrackStage.boost.onBeatDashLengthWidthMult;
    const beatMult = Number.isFinite(mult) && mult > 0 ? mult : 1;
    return base * beatMult;
  }

  private getActiveDashLengthMult(): number {
    if (!this.audio.isPlaying) return 1;
    const mult = this.selectedTrackStage.boost.dashLengthMultWhilePlaying;
    return Number.isFinite(mult) && mult > 0 ? mult : 1;
  }

  private getActivePlayerSpeedMult(): number {
    if (!this.audio.isPlaying) return 1;
    const mult = this.selectedTrackStage.boost.playerSpeedMultWhilePlaying;
    return Number.isFinite(mult) && mult > 0 ? mult : 1;
  }

  private getActiveDashCooldownSec(): number {
    return resolveDashCooldownSecWhilePlaying(
      this.selectedTrackStage.boost,
      this.audio.isPlaying,
    );
  }

  private getRunEnemySlowFactor(): number {
    if (this.runEnemySlowLevel <= 0) return 1;
    const t = (Math.min(RUN_UPGRADE_MAX_LEVEL, this.runEnemySlowLevel) - 1) / 4;
    return 1.2 + t * 0.8;
  }

  private getSpiralEnemySpeedMult(): number {
    if (!this.runSpiralDashUnlocked) return 1;
    const m = CONFIG.spiralEnemySpeedMult;
    return Number.isFinite(m) && m > 0 ? m : 1;
  }

  private syncRunHudLayout(): void {
    if (this.runPhase === 'menu') {
      this.ui.syncRunHudLayout('menu', false);
    } else {
      this.ui.syncRunHudLayout('run', this.ui.isCheatModeEnabled());
    }
    this.syncMobileMoveControls();
  }

  private syncMobileMoveControls(): void {
    this.mobileMoveControls.setVisible(this.runPhase === 'playing');
    if (this.runPhase !== 'playing') {
      this.input.clearVirtualMove();
    }
  }

  private getRunRocketIntervalSec(): number {
    if (this.runRocketLevel <= 0) return Number.POSITIVE_INFINITY;
    const t = (Math.min(RUN_UPGRADE_MAX_LEVEL, this.runRocketLevel) - 1) / 4;
    return 10 - t * 5;
  }

  private getRunLightningStats(): { threshold: number; count: number } | null {
    if (this.runLightningLevel <= 0) return null;
    const lv = Math.min(RUN_UPGRADE_MAX_LEVEL, this.runLightningLevel);
    const thresholds = [10, 8, 6, 4, 3] as const;
    const counts = [1, 1, 2, 2, 3] as const;
    return { threshold: thresholds[lv - 1]!, count: counts[lv - 1]! };
  }

  private syncLightningMeter(): void {
    const stats = this.getRunLightningStats();
    if (!stats || this.runPhase === 'menu') {
      this.lightningMeterEl.classList.add('lightning-meter--hidden');
      this.lightningMeterEl.replaceChildren();
      return;
    }
    this.lightningMeterEl.classList.remove('lightning-meter--hidden');
    const filled = Math.max(0, Math.min(stats.threshold, this.runLightningDashCounter));
    this.lightningMeterEl.replaceChildren(
      ...Array.from({ length: stats.threshold }, (_, i) => {
        const bar = document.createElement('div');
        bar.className = 'lightning-meter__bar';
        bar.classList.toggle('lightning-meter__bar--filled', i < filled);
        const t = stats.threshold <= 1 ? 1 : i / (stats.threshold - 1);
        bar.style.width = `${16 + t * 44}px`;
        return bar;
      }),
    );
  }

  private getActiveDashLandingPulseRadiusMult(): number {
    if (!this.audio.isPlaying) return 0;
    const mult = this.selectedTrackStage.boost.dashLandingPulseRadiusMult;
    return Number.isFinite(mult) && mult > 0 ? mult : 0;
  }

  private shouldPulseForSuccessfulBeatDash(): boolean {
    return this.dashSerialsWithBeatHit.delete(this.player.getDashHitSerial());
  }

  private getTrack3PhantomBeatDashCount(): number {
    if (!this.audio.isPlaying || !this.selectedTrackStage.id.startsWith('track-3-')) {
      return 0;
    }
    const n = this.selectedTrackStage.boost.phantomBeatDashCount;
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(3, Math.floor(n));
  }

  private queueTrack3PhantomSplashes(): void {
    const count = this.getTrack3PhantomBeatDashCount();
    for (let i = 0; i < count; i++) {
      this.pendingPhantomSplashes.push({
        delay: (i + 1) * TRACK_3_PHANTOM_BEAT_DASH_STEP_SEC,
      });
    }
  }

  private applyVaultWalkPseudoCollision(): void {
    if (this.player.isDashing || this.player.isMicroDashing || this.player.hp <= 0) {
      return;
    }
    for (const e of this.enemies) {
      if (!e.isVault()) continue;
      const dx = this.player.x - e.mesh.position.x;
      const dz = this.player.z - e.mesh.position.z;
      const d = Math.hypot(dx, dz);
      if (d >= VAULT_WALK_PSEUDO_COLLISION_RADIUS) continue;

      const nx = d > 1e-5 ? dx / d : 1;
      const nz = d > 1e-5 ? dz / d : 0;
      this.player.mesh.position.x =
        e.mesh.position.x + nx * VAULT_WALK_PSEUDO_COLLISION_RADIUS;
      this.player.mesh.position.z =
        e.mesh.position.z + nz * VAULT_WALK_PSEUDO_COLLISION_RADIUS;
    }
  }

  private handleRunLightningDashStart(): void {
    const stats = this.getRunLightningStats();
    if (!stats) return;
    this.runLightningDashCounter += 1;
    this.syncLightningMeter();
    if (this.runLightningDashCounter < stats.threshold) return;
    this.runLightningDashCounter = 0;
    this.pendingLightningAutoDashes += stats.count;
    this.lightningChainActive = true;
    this.syncLightningMeter();
  }

  private updateLightningAutoDashChain(dt: number): void {
    if (!this.lightningChainActive) return;
    if (this.lightningAutoDashInProgress && !this.player.isDashing) {
      this.lightningAutoDashInProgress = false;
      if (this.pendingLightningAutoDashes > 0) {
        this.lightningAutoDashDelaySec = LIGHTNING_AUTO_DASH_DELAY_SEC;
      } else {
        this.lightningChainActive = false;
        this.lightningAutoDashDelaySec = 0;
        this.player.clearDashCooldownAfterOnBeatHit();
      }
    }
    if (this.lightningAutoDashDelaySec > 0) {
      this.lightningAutoDashDelaySec = Math.max(0, this.lightningAutoDashDelaySec - dt);
      if (this.lightningAutoDashDelaySec > 0) return;
    }
    this.tryStartPendingLightningAutoDash();
  }

  private tryStartPendingLightningAutoDash(): void {
    if (this.pendingLightningAutoDashes <= 0) return;
    if (this.runPhase !== 'playing' || this.player.hp <= 0 || this.player.isDashing) return;
    const target = this.findNearestEnemyToPlayer();
    if (!target) {
      this.pendingLightningAutoDashes = 0;
      this.lightningChainActive = false;
      this.lightningAutoDashInProgress = false;
      this.lightningAutoDashDelaySec = 0;
      this.player.clearDashCooldownAfterOnBeatHit();
      return;
    }
    if (this.player.forceStartAutoDashToward(target.mesh.position.x, target.mesh.position.z, 1)) {
      this.pendingLightningAutoDashes -= 1;
      this.lightningAutoDashInProgress = true;
      this.pendingDashSfx = true;
      this.spawnPhantomSplashTrail(
        this.player.x,
        this.player.z,
        target.mesh.position.x,
        target.mesh.position.z,
        LIGHTNING_COLOR,
        'lightning',
      );
    }
  }

  private findNearestEnemyToPlayer(): Enemy | null {
    let best: Enemy | null = null;
    let bestD2 = Number.POSITIVE_INFINITY;
    for (const e of this.enemies) {
      const dx = e.mesh.position.x - this.player.x;
      const dz = e.mesh.position.z - this.player.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= bestD2) continue;
      bestD2 = d2;
      best = e;
    }
    return best;
  }

  private updateRunRockets(dt: number): void {
    if (this.runRocketLevel <= 0 || this.runPhase !== 'playing') return;
    this.runRocketTimerSec -= dt;
    if (this.runRocketTimerSec > 0) return;
    this.runRocketTimerSec += this.getRunRocketIntervalSec();
    if (this.runRocketTimerSec <= 0) {
      this.runRocketTimerSec = this.getRunRocketIntervalSec();
    }
    const aspect = (this.renderer.domElement.clientWidth || 1) /
      Math.max(1, this.renderer.domElement.clientHeight || 1);
    const halfH = this.cameraViewHalfExtentCurrent * 0.5;
    const halfW = halfH * aspect;
    const x = this.player.x + (Math.random() * 2 - 1) * halfW;
    const z = this.player.z + (Math.random() * 2 - 1) * halfH;
    this.spawnDamagePulseRingAt(x, z, 0.6);
    this.runEnemiesKilled += this.applyPlayerDamagePulseToEnemiesAt(x, z, 0.6);
  }

  private syncOrbitShieldVisuals(): void {
    this.orbitShieldGroup.visible = this.runOrbitShieldLevel > 0;
    for (let i = 0; i < this.orbitShieldSegments.length; i++) {
      this.orbitShieldSegments[i]!.visible = i < this.runOrbitShieldLevel;
    }
  }

  private updateOrbitShield(dt: number): void {
    if (this.runOrbitShieldLevel <= 0 || this.player.hp <= 0) {
      this.orbitShieldGroup.visible = false;
      return;
    }
    this.orbitShieldGroup.visible = true;
    this.orbitShieldGroup.position.x = this.player.x;
    this.orbitShieldGroup.position.z = this.player.z;
    this.orbitShieldGroup.rotation.y += dt * 1.7;
  }

  private projectileHitsOrbitShield(x: number, z: number): boolean {
    if (this.runOrbitShieldLevel <= 0) return false;
    const dx = x - this.player.x;
    const dz = z - this.player.z;
    const dist = Math.hypot(dx, dz);
    if (dist < ORBIT_SHIELD_RADIUS - 0.28 || dist > ORBIT_SHIELD_RADIUS + 0.28) {
      return false;
    }
    const tau = Math.PI * 2;
    const angle = ((Math.atan2(dz, dx) - this.orbitShieldGroup.rotation.y) % tau + tau) % tau;
    for (let i = 0; i < this.runOrbitShieldLevel; i++) {
      const start = (i * ORBIT_SHIELD_THETA * 1.22) % tau;
      if (angle >= start && angle <= start + ORBIT_SHIELD_THETA) return true;
    }
    return false;
  }

  private playSfxPool(pool: SfxPool, source: HTMLAudioElement, rateVariance: number): void {
    const rate =
      rateVariance > 0
        ? 1 + (Math.random() * 2 - 1) * rateVariance
        : 1;
    pool.play(source.volume, rate);
  }

  private playDashSfx(): void {
    this.playSfxPool(this.dashSfxPool, this.dashSfx, Game.DASH_SFX_RATE_VARIANCE);
  }

  private playHitSfx(): void {
    const index = Math.floor(Math.random() * this.hitSfxPools.length);
    const pool = this.hitSfxPools[index] ?? this.hitSfxPools[0]!;
    const source = this.hitSfxSources[index] ?? this.hitSfxSources[0]!;
    this.playSfxPool(pool, source, Game.HIT_SFX_RATE_VARIANCE);
  }

  private playDeathSfx(): void {
    const now = performance.now();
    if (now - this.lastDeathSfxAtMs < Game.DEATH_SFX_COOLDOWN_MS) return;
    this.lastDeathSfxAtMs = now;
    this.playSfxPool(this.deathSfxPool, this.deathSfx, 0);
  }

  private markDashImpactSfx(): void {
    if (!this.pendingDashSfx) return;
    this.pendingDashSfx = false;
    this.playHitSfx();
  }

  private flushPendingDashSfxIfDashEnded(): void {
    if (!this.pendingDashSfx || this.player.isDashing) return;
    this.pendingDashSfx = false;
    this.playDashSfx();
  }

  /** If the player just started a main dash, maybe count an on-beat hit vs audio time. */
  private tryRegisterDashBeatHit(mainDashStarted: boolean): void {
    if (!mainDashStarted) return;
    if (!this.beatmap || !this.audio.isPlaying || this.runPhase !== 'playing') return;
    const t = this.audio.currentTime;
    const bestI = this.findBestBeatInDashWindowAtTime(t);
    if (bestI >= 0 && !this.beatHitIndices.has(bestI)) {
      this.beatHitIndices.add(bestI);
      this.beatPenaltyIndices.add(bestI);
      this.dashSerialsWithBeatHit.add(this.player.getDashHitSerial());
      this.beatHitCount += 1;
      this.beatEffects.triggerOnBeatHitFlash();
      if (this.getTrack3PhantomBeatDashCount() > 0) {
        this.queueTrack3PhantomSplashes();
      }
      if (this.audio.isPlaying && this.selectedTrackStage.boost.resetDashCooldownOnBeat) {
        this.player.clearDashCooldownAfterOnBeatHit();
      }
      return;
    }
    // During tape: only beat-timeout misses hurt — not extra off-beat dashes.
    if (!this.isTapeTrackPlaying()) {
      this.damagePlayerForBeatMistake();
    }
  }

  private onBeatReached(beat: BeatEvent): void {
    this.beatEffects.triggerBeat(beat);
  }

  /** Beat lane canvas: after movement so the center hit ring matches `player.isDashing`. */
  private syncBeatLaneUi(): void {
    const tapePlaying = this.audio.isPlaying;
    const tapeMana = this.getBeatLaneTapeManaDisplay(tapePlaying);
    if (!this.beatmap) {
      this.ui.updateBeatLane(
        0,
        null,
        this.beatHitIndices,
        this.player.isDashing,
        tapePlaying,
        tapeMana,
      );
      return;
    }
    this.ui.updateBeatLane(
      this.audio.currentTime,
      this.beatmap.beats,
      this.beatHitIndices,
      this.player.isDashing,
      tapePlaying,
      tapeMana,
    );
  }

  private getBeatLaneTapeManaDisplay(tapePlaying: boolean): {
    current: number;
    required: number;
  } | null {
    if (tapePlaying) return null;
    if (!CONFIG.playTrackManaCostEnabled) return null;
    if (this.runPhase !== 'playing' && this.runPhase !== 'runUpgrade') {
      return null;
    }
    return {
      current: this.runMana,
      required: CONFIG.playTrackMinManaToActivate,
    };
  }

  /** Center-screen quarter-circle arc: bearing from canvas center to vault (screen pixels). */
  private syncVaultBearingUi(): void {
    if (this.runPhase !== 'playing') {
      this.ui.setVaultBearingAngle(null);
      return;
    }
    const vault = this.enemies.find((e) => e.isVault());
    if (!vault) {
      this.ui.setVaultBearingAngle(null);
      return;
    }
    if (!isArtifactEnabled('vaultBearing')) {
      this.ui.setVaultBearingAngle(null);
      return;
    }
    this.syncRenderCamera();
    const y = CONFIG.floorY;
    this.vaultBearingProj.set(vault.mesh.position.x, y, vault.mesh.position.z);
    this.vaultBearingProj.project(this.renderCamera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    const vx = rect.left + (this.vaultBearingProj.x * 0.5 + 0.5) * rect.width;
    const vy = rect.top + (-this.vaultBearingProj.y * 0.5 + 0.5) * rect.height;
    const mx = rect.left + rect.width * 0.5;
    const my = rect.top + rect.height * 0.5;
    const phi = Math.atan2(vy - my, vx - mx);
    this.ui.setVaultBearingAngle(phi);
  }

  private getRunXpRequiredForLevelUp(level: number): number {
    const lv = Math.max(1, Math.floor(level));
    return CONFIG.runXpPerLevel + (lv - 1) * Game.RUN_XP_STEP_PER_LEVEL;
  }

  private getRunXpProgress(totalXp: number): {
    level: number;
    xpInLevel: number;
    xpForNextLevel: number;
  } {
    let level = 1;
    let rest = Math.max(0, Math.floor(Number.isFinite(totalXp) ? totalXp : 0));
    let need = this.getRunXpRequiredForLevelUp(level);
    while (rest >= need) {
      rest -= need;
      level += 1;
      need = this.getRunXpRequiredForLevelUp(level);
    }
    return { level, xpInLevel: rest, xpForNextLevel: need };
  }

  private syncRunXpUi(): void {
    const p = this.getRunXpProgress(this.runXpTotal);
    this.ui.setRunXp(p.level, p.xpInLevel, p.xpForNextLevel);
  }

  /** XP to add so that `runXpTotal` reaches the next level threshold. */
  private vaultXpFillToNextSegment(): number {
    const p = this.getRunXpProgress(this.runXpTotal);
    return Math.max(1, p.xpForNextLevel - p.xpInLevel);
  }

  private grantResourceLootFromSack(
    enemy: Enemy,
  ): { amount: number; color: string; label: 'Gold' | 'Mana' } | null {
    if (enemy.isGoldSack()) {
      const amount = rollResourceSackDropAmount();
      this.runGold += amount;
      return { amount, color: LOOT_FLOAT_COLOR_GOLD, label: 'Gold' };
    }
    if (enemy.isManaSack()) {
      if (!this.canGainRunMana()) return null;
      const amount = 10;
      this.runMana += amount;
      return { amount, color: LOOT_FLOAT_COLOR_MANA, label: 'Mana' };
    }
    return null;
  }

  private worldToCanvasOverlay(
    worldX: number,
    worldY: number,
    worldZ: number,
  ): { x: number; y: number } | null {
    this.comboScreenPos.set(worldX, worldY, worldZ);
    this.comboScreenPos.project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: (this.comboScreenPos.x * 0.5 + 0.5) * rect.width,
      y: (-this.comboScreenPos.y * 0.5 + 0.5) * rect.height,
    };
  }

  private handleResourceSackLoot(enemy: Enemy): void {
    const loot = this.grantResourceLootFromSack(enemy);
    if (!loot) return;
    const pos = this.worldToCanvasOverlay(
      enemy.mesh.position.x,
      CONFIG.floorY + 0.9,
      enemy.mesh.position.z,
    );
    if (pos) {
      this.ui.spawnLootGainFloat(
        pos.x,
        pos.y,
        `+${loot.amount} ${loot.label}`,
        loot.color,
      );
    }
    this.syncRunLootUi();
  }

  private tryVaultTapeFragmentDrop(): void {
    if (Math.random() >= CONFIG.vaultTapeFragmentDropChance) return;
    const unlock = tryUnlockRandomTapeFragment();
    if (!unlock) return;
    this.ui.showTapeFragmentUnlocked(unlock.trackLabel, unlock.stageLabel);
    this.ui.setSelectedTrackStage(this.selectedTrackStage);
  }

  private tryGrantEnemyKillBonusLoot(): void {
    if (Math.random() >= CONFIG.enemyKillBonusLootChance) return;
    if (Math.random() < 0.5) {
      this.runGold += 1;
    } else if (this.canGainRunMana()) {
      this.runMana += 1;
    } else {
      return;
    }
    this.syncRunLootUi();
  }

  private awardEnemyKillXp(enemy: Enemy): void {
    this.tryGrantEnemyKillBonusLoot();
    if (enemy.isResourceSack()) return;
    let xp: number;
    if (enemy.isVault()) {
      xp = this.vaultXpFillToNextSegment();
      this.tryVaultTapeFragmentDrop();
    } else if (enemy.isTank() || enemy.isAngel()) {
      xp = CONFIG.runXpKillTank;
    } else {
      xp = CONFIG.runXpKillMob;
    }
    this.runXpTotal += xp;
    this.awardKillScore();
  }

  private maybeEnterRunUpgrade(): void {
    if (this.runPhase !== 'playing') return;
    this.collectReachedRunUpgradeMilestones();
    if (this.runPendingUpgradeMilestones.length <= 0) return;
    // While the beat-track ability is active, queue upgrades but do not interrupt gameplay.
    if (this.audio.isPlaying) return;
    void this.openNextRunUpgradeModal();
  }

  private collectReachedRunUpgradeMilestones(): void {
    while (this.runXpTotal >= this.runNextUpgradeAtXp) {
      this.runPendingUpgradeMilestones.push(this.runNextUpgradeAtXp);
      this.runLevelUpsAwarded += 1;
      this.runNextUpgradeAtXp += this.getRunXpRequiredForLevelUp(this.runLevelUpsAwarded + 1);
    }
  }

  private async openNextRunUpgradeModal(): Promise<void> {
    if (this.runPendingUpgradeMilestones.length <= 0) return;
    this.runPhase = 'runUpgrade';
    this.syncRunHudLayout();
    await ensureLvlupAssetsLoaded();
    const choices = this.getRunUpgradeChoices();
    const isCheatMode = this.ui.isCheatModeEnabled();
    this.ui.showRunUpgradeModal({
      milestoneXp: this.runPendingUpgradeMilestones[0]!,
      choices: isCheatMode ? choices : this.pickRandomRunUpgradeChoices(choices, 3),
      isCheatMode,
      onChoice: (id) => this.applyRunUpgradeChoice(id),
    });
  }

  private pickRandomRunUpgradeChoices(
    choices: readonly RunUpgradeChoiceView[],
    count: number,
  ): RunUpgradeChoiceView[] {
    const pool = [...choices];
    const picked: RunUpgradeChoiceView[] = [];
    const pickCount = Math.max(1, Math.min(count, pool.length));
    while (picked.length < pickCount && pool.length > 0) {
      let total = 0;
      for (const choice of pool) {
        total += this.getRunUpgradeDropWeight(choice);
      }
      let roll = Math.random() * Math.max(1e-6, total);
      let pickIndex = 0;
      for (let i = 0; i < pool.length; i++) {
        roll -= this.getRunUpgradeDropWeight(pool[i]!);
        if (roll <= 0) {
          pickIndex = i;
          break;
        }
      }
      picked.push(pool.splice(pickIndex, 1)[0]!);
    }
    return picked;
  }

  private getRunUpgradeDropWeight(choice: RunUpgradeChoiceView): number {
    const base =
      Number.isFinite(choice.dropWeight) && choice.dropWeight! > 0
        ? choice.dropWeight!
        : 1;
    const startedBonus =
      (this.runUpgradePickCounts.get(choice.id) ?? 0) > 0
        ? RUN_UPGRADE_STARTED_WEIGHT_BONUS
        : 0;
    return base + startedBonus;
  }

  private getRunUpgradeChoices(): RunUpgradeChoiceView[] {
    const choices: RunUpgradeChoiceView[] = [
      {
        id: 'dash',
        label: 'Dash Range +1',
        description: 'Longer main dash.',
      },
      {
        id: 'speed',
        label: 'Character Speed +1',
        description: 'Move faster.',
        secondary: true,
      },
      {
        id: 'shields',
        label: 'Shields +1',
        description: 'Adds max shield and restores one.',
        accentColor: RUN_UPGRADE_COLOR_UTILITY,
        dropWeight: 0.5,
        secondary: true,
      },
      {
        id: 'shieldRegen',
        label: `Shield Regen -0.5 s`,
        description: `Faster passive shield recovery. Minimum: ${CONFIG.shieldRegenMinIntervalSec} s.`,
        accentColor: RUN_UPGRADE_COLOR_UTILITY,
        dropWeight: 0.5,
        secondary: true,
      },
    ];
    if (this.runEnemySlowLevel < RUN_UPGRADE_MAX_LEVEL) {
      choices.push({
        id: 'enemySlow',
        label: `Enemy Slow ${this.runEnemySlowLevel + 1}/5`,
        description: 'Slows all enemies.',
        secondary: true,
      });
    }
    if (this.runRocketLevel < RUN_UPGRADE_MAX_LEVEL) {
      choices.push({
        id: 'rockets',
        label: `Rockets ${this.runRocketLevel + 1}/5`,
        description: 'Random visible explosions. Higher levels trigger more often.',
        accentColor: RUN_UPGRADE_COLOR_ARTIFACT,
        dropWeight: 0.25,
        secondary: true,
      });
    }
    if (this.runLightningLevel < RUN_UPGRADE_MAX_LEVEL) {
      choices.push({
        id: 'artifactLightning',
        label: `Artifact: Lightning ${this.runLightningLevel + 1}/5`,
        description: 'Auto-dashes into nearby enemies after enough dashes. Higher levels trigger faster and add more hits.',
        accentColor: RUN_UPGRADE_COLOR_ARTIFACT,
        dropWeight: 0.25,
        secondary: true,
      });
    }
    if (this.runSideDashLevel < SIDE_DASH_MAX_LEVEL) {
      choices.push({
        id: 'artifactSideDashes',
        label: `Artifact: Claw-Dash ${this.runSideDashLevel + 1}/2`,
        description: 'Adds delayed Claw-Dashes. Level two adds the other side.',
        accentColor: RUN_UPGRADE_COLOR_ARTIFACT,
        dropWeight: 0.25,
        secondary: true,
      });
    }
    if (this.runOrbitShieldLevel < RUN_UPGRADE_MAX_LEVEL) {
      choices.push({
        id: 'artifactOrbitShield',
        label: `Artifact: Projectile Shields ${this.runOrbitShieldLevel + 1}/5`,
        description: 'Rotating projectile shield. Each level adds another segment.',
        accentColor: RUN_UPGRADE_COLOR_UTILITY,
        dropWeight: 0.5,
        secondary: true,
      });
    }
    if (!this.runPhaseDashUnlocked) {
      choices.push({
        id: 'artifactPhaseDash',
        label: 'Artifact: Phase Dash',
        description: 'Dash through normal mobs and shooters.',
        accentColor: RUN_UPGRADE_COLOR_RARE_ARTIFACT,
        dropWeight: 0.1,
        secondary: true,
      });
    }
    if (!this.runSpiralDashUnlocked) {
      choices.push({
        id: 'artifactSpiral',
        label: 'Artifact: Spiral',
        description: ARTIFACT_SPIRAL_DESCRIPTION,
        accentColor: RUN_UPGRADE_COLOR_RARE_ARTIFACT,
        dropWeight: 0.1,
        secondary: true,
      });
    }
    return choices;
  }

  private applyRunUpgradeChoice(kind: string): void {
    if (this.runPhase !== 'runUpgrade') return;
    if (kind === 'dash') {
      addRunDashNominalLengthBonus(CONFIG.runUpgradeDashLengthDeltaWorld);
    } else if (kind === 'speed') {
      addRunPlayerSpeedBonus(CONFIG.runUpgradePlayerSpeedDelta);
    } else if (kind === 'shields') {
      addRunPlayerMaxHpBonus(CONFIG.runUpgradeShieldsDelta);
      this.player.hp = Math.min(
        this.player.hp + CONFIG.runUpgradeShieldsDelta,
        getPlayerMaxHp(),
      );
      this.ui.rebuildHpBarSegments();
    } else if (kind === 'shieldRegen') {
      this.player.accelerateShieldRegenFromUpgrade();
    } else if (kind === 'enemySlow') {
      this.runEnemySlowLevel = Math.min(RUN_UPGRADE_MAX_LEVEL, this.runEnemySlowLevel + 1);
    } else if (kind === 'rockets') {
      this.runRocketLevel = Math.min(RUN_UPGRADE_MAX_LEVEL, this.runRocketLevel + 1);
      this.runRocketTimerSec = Math.min(this.runRocketTimerSec, this.getRunRocketIntervalSec());
    } else if (kind === 'artifactLightning') {
      this.runLightningLevel = Math.min(RUN_UPGRADE_MAX_LEVEL, this.runLightningLevel + 1);
      this.syncLightningMeter();
    } else if (kind === 'artifactSideDashes') {
      this.runSideDashLevel = Math.min(SIDE_DASH_MAX_LEVEL, this.runSideDashLevel + 1);
    } else if (kind === 'artifactOrbitShield') {
      this.runOrbitShieldLevel = Math.min(RUN_UPGRADE_MAX_LEVEL, this.runOrbitShieldLevel + 1);
      this.syncOrbitShieldVisuals();
    } else if (kind === 'artifactPhaseDash') {
      this.runPhaseDashUnlocked = true;
    } else if (kind === 'artifactSpiral') {
      this.runSpiralDashUnlocked = true;
    } else {
      return;
    }
    this.runUpgradePickCounts.set(
      kind,
      (this.runUpgradePickCounts.get(kind) ?? 0) + 1,
    );
    if (this.runPendingUpgradeMilestones.length > 0) {
      this.runPendingUpgradeMilestones.shift();
    }
    this.ui.hideRunUpgradeModal();
    this.runPhase = 'playing';
    this.syncRunHudLayout();
    this.syncRunXpUi();
    this.syncRunLootUi();
    this.maybeEnterRunUpgrade();
  }

  private updateBeatPlayback(dt: number): void {
    this.beatEffects.update(dt);
    if (!this.beatmap) {
      return;
    }

    const now = this.audio.currentTime;
    const beats = this.beatmap.beats;
    if (this.audio.isPlaying && this.runPhase === 'playing') {
      for (let i = 0; i < beats.length; i++) {
        const beat = beats[i]!;
        if (now < beat.time + CONFIG.dashBeatWindowAfterSec) break;
        if (this.beatHitIndices.has(i) || this.beatPenaltyIndices.has(i)) continue;
        this.beatPenaltyIndices.add(i);
        this.damagePlayerForBeatMistake();
      }
    }
    while (this.nextBeatIndex < beats.length && now >= beats[this.nextBeatIndex]!.time) {
      if (this.lightningChainActive && !this.beatHitIndices.has(this.nextBeatIndex)) {
        this.beatHitIndices.add(this.nextBeatIndex);
        this.beatPenaltyIndices.add(this.nextBeatIndex);
        this.beatHitCount += 1;
        this.beatEffects.triggerOnBeatHitFlash();
      }
      this.onBeatReached(beats[this.nextBeatIndex]!);
      this.nextBeatIndex += 1;
    }

    if (
      this.audio.isPlaying &&
      beats.length > 0 &&
      this.nextBeatIndex >= beats.length
    ) {
      const lastBeat = beats[beats.length - 1]!;
      if (now >= lastBeat.time + CONFIG.dashBeatWindowAfterSec) {
        this.audio.pause();
      }
    }

    const nextBeatTime = this.nextBeatIndex < beats.length ? beats[this.nextBeatIndex]!.time : null;
    this.ui.setBeatDebug(now, nextBeatTime);

    if (this.audio.isPlaying) {
      this.ui.setBeatmapState('Playing');
    } else if (now > 0 && this.nextBeatIndex >= beats.length) {
      this.ui.setBeatmapState('Ended');
    }

    const trackPlayingNow = this.audio.isPlaying;
    // Detect track end edge and immediately flush queued upgrade modals.
    if (this.wasTrackPlayingLastFrame && !trackPlayingNow) {
      this.beatFloor.onTrackEnded();
      void this.ensureBackgroundMusicPlaying();
      this.finalizeTrackPlaybackEnd();
      this.maybeEnterRunUpgrade();
    }
    this.wasTrackPlayingLastFrame = trackPlayingNow;
  }

  private resolveDashKills(): number {
    const seg = this.player.consumeDashSweep();
    this.dashDebugSweepThisFrame = seg;
    if (!seg) return 0;
    const dashDx = seg.bx - seg.ax;
    const dashDz = seg.bz - seg.az;
    const dashLen = Math.hypot(dashDx, dashDz);
    const dashKillDir =
      dashLen > 1e-4
        ? { x: dashDx / dashLen, z: dashDz / dashLen }
        : { x: this.player.dash.dirX, z: this.player.dash.dirZ };
    const sideDashSegs = this.getSideDashSegments(seg, dashKillDir.x, dashKillDir.z);
    if (sideDashSegs.length > 0) {
      this.queueSideDashes(sideDashSegs, dashKillDir);
    }
    const dashSerial = this.player.getDashHitSerial();
    const scaledPlayer = CONFIG.playerRadius * getDashKillRadiusScale();
    let kills = 0;
    const vaultShieldJoin = this.getVaultShieldJoinRadius(scaledPlayer);
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (e.isVault() || e.isAngel()) {
        const hitR = scaledPlayer + e.bodyRadius;
        const hitSeg = this.pickDashHitSegment(
          [seg],
          e.mesh.position.x,
          e.mesh.position.z,
          hitR,
        );
        if (!hitSeg) continue;

        const tx = e.mesh.position.x;
        const tz = e.mesh.position.z;
        const tr = e.bodyRadius;

        if (e.isAngel()) {
          const canDamageAngel =
            e.canDashDamageFromOpenShieldSide(hitSeg, vaultShieldJoin);
          this.markDashImpactSfx();
          if (!canDamageAngel) {
            if (e.tryBreakVaultShieldWithDash(hitSeg, vaultShieldJoin)) {
              this.queueShieldBloodSplash(e, this.getDashBloodImpact(tx, tz, e.bodyRadius, dashKillDir));
            }
          }
          if (e.vaultLastClipDashSerial !== dashSerial) {
            this.player.clipDashPastTank(tx, tz, tr, hitR + 0.35);
            e.vaultLastClipDashSerial = dashSerial;
          }
          if (!canDamageAngel) {
            continue;
          }
        }

        if (e.isVault() && e.getActiveShieldCount() > 0) {
          this.markDashImpactSfx();
          if (e.tryBreakVaultShieldWithDash(hitSeg, vaultShieldJoin)) {
            this.queueShieldBloodSplash(e, this.getDashBloodImpact(tx, tz, e.bodyRadius, dashKillDir));
          }
          if (e.vaultLastClipDashSerial !== dashSerial) {
            this.player.clipDashPastTank(tx, tz, tr, hitR + 0.35);
            e.vaultLastClipDashSerial = dashSerial;
          }
          continue;
        }

        if (e.damagedInDashHitSerial === dashSerial) continue;
        e.damagedInDashHitSerial = dashSerial;
        this.markDashImpactSfx();
        const died = e.takeDashHit(e.isAngel());
        if (e.vaultLastClipDashSerial !== dashSerial) {
          this.player.clipDashPastTank(tx, tz, tr, hitR + 0.35);
          e.vaultLastClipDashSerial = dashSerial;
        }
        if (died) {
          this.awardEnemyKillXp(e);
          this.removeEnemyFromGameplayAt(
            i,
            this.getDashBloodImpact(tx, tz, e.bodyRadius, dashKillDir),
          );
          kills += 1;
        }
        continue;
      }

      const hitR = scaledPlayer + e.bodyRadius;
      if (
        this.pickDashHitSegment(
          [seg],
          e.mesh.position.x,
          e.mesh.position.z,
          hitR,
        )
      ) {
        const isTank = e.isTank();
        const tx = e.mesh.position.x;
        const tz = e.mesh.position.z;
        const tr = e.bodyRadius;
        // One impact per dash serial: tank — same clip args as vault body, then deferred HP; others — immediate damage.
        if (e.damagedInDashHitSerial === dashSerial) continue;
        e.damagedInDashHitSerial = dashSerial;
        this.markDashImpactSfx();
        if (isTank) {
          this.player.clipDashPastTank(tx, tz, tr, hitR + 0.35);
          e.scheduleDeferredTankDashDamage();
        } else {
          const canPhaseDashThrough =
            this.runPhaseDashUnlocked &&
            (e.isShooter() || (!e.isResourceSack() && !e.isTank()));
          if (canPhaseDashThrough && e.vaultLastClipDashSerial !== dashSerial) {
            this.player.clipDashPastTank(tx, tz, tr, hitR + 0.35);
            e.vaultLastClipDashSerial = dashSerial;
          }
          const died = e.takeDashHit();
          if (died) {
            this.handleResourceSackLoot(e);
            this.awardEnemyKillXp(e);
            this.removeEnemyFromGameplayAt(
              i,
              this.getDashBloodImpact(tx, tz, e.bodyRadius, dashKillDir),
            );
            kills += 1;
          }
        }
      }
    }
    return kills;
  }

  private getSideDashSegments(
    seg: DashSweepSegment,
    dirX: number,
    dirZ: number,
  ): DashSweepSegment[] {
    if (this.runSideDashLevel <= 0) return [];
    const sideX = -dirZ;
    const sideZ = dirX;
    const offset = CONFIG.playerRadius * 3.2;
    const sides = this.runSideDashLevel >= 2 ? [-1, 1] : [-1];
    return sides.map((side) => ({
      ax: seg.ax + sideX * offset * side,
      az: seg.az + sideZ * offset * side,
      bx: seg.bx + sideX * offset * side,
      bz: seg.bz + sideZ * offset * side,
    }));
  }

  private queueSideDashes(
    segs: readonly DashSweepSegment[],
    dir: { x: number; z: number },
  ): void {
    this.pendingSideDashes.push({
      delay: SIDE_DASH_DELAY_SEC,
      segs: segs.map((seg) => ({ ...seg })),
      dir,
    });
  }

  private updatePendingSideDashes(dt: number): void {
    for (let i = this.pendingSideDashes.length - 1; i >= 0; i--) {
      const p = this.pendingSideDashes[i]!;
      p.delay -= dt;
      if (p.delay > 0) continue;
      this.pendingSideDashes.splice(i, 1);
      this.spawnSideDashTrails(p.segs);
      this.runEnemiesKilled += this.resolveSideDashHits(p.segs, p.dir);
    }
  }

  private resolveSideDashHits(
    segs: readonly DashSweepSegment[],
    dir: { x: number; z: number },
  ): number {
    const scaledPlayer = CONFIG.playerRadius * getDashKillRadiusScale();
    const vaultShieldJoin = this.getVaultShieldJoinRadius(scaledPlayer);
    let kills = 0;
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i]!;
      const hitR = scaledPlayer + e.bodyRadius;
      const hitSeg = this.pickDashHitSegment(segs, e.mesh.position.x, e.mesh.position.z, hitR);
      if (!hitSeg) continue;
      this.markDashImpactSfx();
      if ((e.isVault() || e.isAngel()) && e.getActiveShieldCount() > 0) {
        if (e.tryBreakVaultShieldWithDash(hitSeg, vaultShieldJoin)) {
          this.queueShieldBloodSplash(
            e,
            this.getDashBloodImpact(e.mesh.position.x, e.mesh.position.z, e.bodyRadius, dir),
          );
        }
        continue;
      }
      const died = e.takeDashHit(e.isAngel());
      if (!died) continue;
      this.handleResourceSackLoot(e);
      this.awardEnemyKillXp(e);
      this.removeEnemyFromGameplayAt(
        i,
        this.getDashBloodImpact(e.mesh.position.x, e.mesh.position.z, e.bodyRadius, dir),
      );
      kills += 1;
    }
    return kills;
  }

  private getVaultShieldJoinRadius(scaledPlayerRadius: number): number {
    const defaultDashRadius =
      CONFIG.playerRadius * CONFIG.dashKillPlayerRadiusScale;
    const fixedExtra =
      CONFIG.vaultShieldDashJoinRadius - defaultDashRadius;
    return Math.max(
      CONFIG.vaultShieldDashJoinRadius,
      scaledPlayerRadius + Math.max(0, fixedExtra),
    );
  }

  private pickDashHitSegment(
    segs: readonly DashSweepSegment[],
    x: number,
    z: number,
    hitR: number,
  ): DashSweepSegment | null {
    for (const seg of segs) {
      if (segmentHitsCircle(seg.ax, seg.az, seg.bx, seg.bz, x, z, hitR)) {
        return seg;
      }
    }
    return null;
  }

  private spawnSideDashTrails(segs: readonly DashSweepSegment[]): void {
    for (const seg of segs) {
      const dx = seg.bx - seg.ax;
      const dz = seg.bz - seg.az;
      const len = Math.hypot(dx, dz);
      if (len <= 1e-4) continue;
      const nx = -dz / len;
      const nz = dx / len;
      const startHalfW = CONFIG.dashTrailWidth * 0.12;
      const midHalfW = CONFIG.dashTrailWidth * 1.05;
      const endHalfW = CONFIG.dashTrailWidth * 0.12;
      const midX = seg.ax + dx * 0.5;
      const midZ = seg.az + dz * 0.5;
      const y = CONFIG.floorY + 0.235;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute(
        'position',
        new THREE.BufferAttribute(
          new Float32Array([
            seg.ax + nx * startHalfW, y, seg.az + nz * startHalfW,
            seg.ax - nx * startHalfW, y, seg.az - nz * startHalfW,
            midX + nx * midHalfW, y, midZ + nz * midHalfW,
            midX - nx * midHalfW, y, midZ - nz * midHalfW,
            seg.bx + nx * endHalfW, y, seg.bz + nz * endHalfW,
            seg.bx - nx * endHalfW, y, seg.bz - nz * endHalfW,
          ]),
          3,
        ),
      );
      geo.setIndex([0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5]);
      geo.computeBoundingSphere();
      const mat = new THREE.MeshBasicMaterial({
        color: 0xe8f799,
        transparent: true,
        opacity: 0.72,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 9;
      this.scene.add(mesh);
      this.sideDashTrails.push({
        mesh,
        mat,
        age: 0,
        life: SIDE_DASH_TRAIL_LIFE_SEC,
      });
    }
  }

  private updateSideDashTrails(dt: number): void {
    for (let i = this.sideDashTrails.length - 1; i >= 0; i--) {
      const p = this.sideDashTrails[i]!;
      p.age += dt;
      const t = Math.min(1, p.age / Math.max(0.001, p.life));
      p.mat.opacity = 0.72 * (1 - t);
      if (p.age < p.life) continue;
      this.scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mat.dispose();
      this.sideDashTrails.splice(i, 1);
    }
  }

  /** Apply tank dash hits that were deferred after clip/slide (see `CONFIG.tankDashDamageDelayMs`). */
  private applyDeferredTankDashDamage(): number {
    let kills = 0;
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (!e.isTank()) continue;
      if (!e.tickDeferredTankDashDamage()) continue;
      this.awardEnemyKillXp(e);
      this.removeEnemyFromGameplayAt(
        i,
        this.getDashBloodImpact(
          e.mesh.position.x,
          e.mesh.position.z,
          e.bodyRadius,
          { x: this.player.dash.dirX, z: this.player.dash.dirZ },
        ),
      );
      kills += 1;
    }
    return kills;
  }

  private clearDashPastTankDebugOverlay(): void {
    this.dashDebugSweepThisFrame = null;
    if (!this.debugDashTankGroup) return;
    this.disposeDebugDashTankChildren(this.debugDashTankGroup);
    this.debugDashTankGroup.visible = false;
  }

  /**
   * Console + scene overlay when `CONFIG.debugDashPastTank` or `?debugDashTank` is set.
   * Run after `tickDashAfterHits` so logged `timeLeft` matches end of frame.
   */
  private syncDashPastTankDebug(): void {
    if (!isDebugDashPastTankEnabled()) {
      if (this.debugDashTankGroup) this.debugDashTankGroup.visible = false;
      return;
    }

    const seg = this.dashDebugSweepThisFrame;
    if (!this.debugDashTankGroup) {
      this.debugDashTankGroup = new THREE.Group();
      this.debugDashTankGroup.name = 'debugDashPastTank';
      this.scene.add(this.debugDashTankGroup);
    }
    const g = this.debugDashTankGroup;
    this.disposeDebugDashTankChildren(g);

    if (!seg) {
      g.visible = false;
      return;
    }

    g.visible = true;
    const yLine = CONFIG.floorY + 0.28;
    const sweepGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(seg.ax, yLine, seg.az),
      new THREE.Vector3(seg.bx, yLine, seg.bz),
    ]);
    const sweepLine = new THREE.Line(
      sweepGeo,
      new THREE.LineBasicMaterial({ color: 0xffdd44 }),
    );
    g.add(sweepLine);

    const scaledPlayer = CONFIG.playerRadius * getDashKillRadiusScale();
    const tankHits: {
      x: number;
      z: number;
      bodyRadius: number;
      hitR: number;
    }[] = [];

    for (const e of this.enemies) {
      if (!e.isTank()) continue;
      const hitR = scaledPlayer + e.bodyRadius;
      const cx = e.mesh.position.x;
      const cz = e.mesh.position.z;
      if (
        !segmentHitsCircle(
          seg.ax,
          seg.az,
          seg.bx,
          seg.bz,
          cx,
          cz,
          hitR,
        )
      ) {
        continue;
      }
      tankHits.push({ x: cx, z: cz, bodyRadius: e.bodyRadius, hitR });
      const inner = Math.max(0.04, hitR - 0.08);
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(inner, hitR + 0.08, 56),
        new THREE.MeshBasicMaterial({
          color: 0xff44aa,
          transparent: true,
          opacity: 0.82,
          depthTest: true,
          side: THREE.DoubleSide,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(cx, CONFIG.floorY + 0.27, cz);
      g.add(ring);
    }

    if (tankHits.length > 0) {
      console.log('[dash-past-tank] frame', {
        sweep: { ...seg },
        tankHits,
        dashTimeLeftAfterTick: this.player.dash.timeLeft,
      });
    }
  }

  private disposeDebugDashTankChildren(group: THREE.Group): void {
    while (group.children.length > 0) {
      const ch = group.children[0]!;
      if (ch instanceof THREE.Line) {
        ch.geometry.dispose();
        (ch.material as THREE.Material).dispose();
      } else if (ch instanceof THREE.Mesh) {
        ch.geometry.dispose();
        (ch.material as THREE.Material).dispose();
      }
      group.remove(ch);
    }
  }

  private spawnDamagePulseRingAt(x: number, z: number, radiusMult = 1): void {
    const safeRadiusMult =
      Number.isFinite(radiusMult) && radiusMult > 0 ? radiusMult : 1;
    const inner = 0.1;
    const outer = Game.DAMAGE_PULSE_RING_OUTER_LOCAL;
    const geo = new THREE.RingGeometry(inner, outer, 56);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, CONFIG.floorY + 0.06, z);
    mesh.renderOrder = 8;
    const scaleMax =
      (CONFIG.playerRadius * CONFIG.playerDamagePulseVisualRadiusMult * safeRadiusMult) /
      Game.DAMAGE_PULSE_RING_OUTER_LOCAL;
    mesh.scale.setScalar(0.2 * scaleMax);
    this.scene.add(mesh);
    this.damagePulseRings.push({
      mesh,
      mat,
      age: 0,
      baseOpacity: 0.92,
      radiusMult: safeRadiusMult,
    });
  }

  private updateDamagePulseRings(dt: number): void {
    const dur = 0.24;
    const ringOuterLocal = Game.DAMAGE_PULSE_RING_OUTER_LOCAL;
    for (let i = this.damagePulseRings.length - 1; i >= 0; i--) {
      const p = this.damagePulseRings[i]!;
      p.age += dt;
      const t = Math.min(1, p.age / dur);
      const targetWorldOuter =
        CONFIG.playerRadius *
        CONFIG.playerDamagePulseVisualRadiusMult *
        p.radiusMult;
      const scaleMax = targetWorldOuter / ringOuterLocal;
      const scale = (0.2 + 0.8 * t) * scaleMax;
      p.mesh.scale.setScalar(scale);
      p.mat.opacity = p.baseOpacity * (1 - t);
      if (p.age >= dur) {
        this.scene.remove(p.mesh);
        p.mesh.geometry.dispose();
        p.mat.dispose();
        this.damagePulseRings.splice(i, 1);
      }
    }
  }

  private applyPlayerDamagePulseToEnemiesAt(
    px: number,
    pz: number,
    radiusMult = 1,
  ): number {
    const safeRadiusMult =
      Number.isFinite(radiusMult) && radiusMult > 0 ? radiusMult : 1;
    const r =
      CONFIG.playerRadius * CONFIG.playerDamagePulseRadiusMult * safeRadiusMult;
    const r2 = r * r;
    const pulseDmg = CONFIG.playerDamagePulseEnemyDamage;
    let kills = 0;
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i]!;
      const dx = e.mesh.position.x - px;
      const dz = e.mesh.position.z - pz;
      if (dx * dx + dz * dz > r2) continue;
      if (e.applyDamage(pulseDmg)) {
        this.handleResourceSackLoot(e);
        this.awardEnemyKillXp(e);
        this.removeEnemyFromGameplayAt(i);
        kills += 1;
      }
    }
    return kills;
  }

  private updateCamera(dt: number): void {
    this.cameraShake *= Math.exp(-16 * dt);
    if (this.cameraShake < 0.002) {
      this.cameraShake = 0;
    }
    const amp = this.cameraShake * 0.55;
    const shakeX = (Math.random() * 2 - 1) * amp;
    const shakeZ = (Math.random() * 2 - 1) * amp;
    this.cameraController.update(
      this.camera,
      dt,
      this.player.x,
      this.player.z,
      shakeX,
      shakeZ,
    );
  }

  private updateCameraZoomFromInput(): void {
    const delta = this.input.consumeWheelZoomDelta();
    if (!Number.isFinite(delta) || Math.abs(delta) < 1e-6) return;
    const speed = Math.max(1e-6, CONFIG.cameraZoomWheelSpeed);
    const mult = Math.exp(delta * speed);
    const next = this.cameraViewHalfExtentCurrent * mult;
    const limits = getCameraZoomHalfExtentLimits();
    const clamped = Math.min(limits.max, Math.max(limits.min, next));
    if (Math.abs(clamped - this.cameraViewHalfExtentCurrent) < 1e-6) return;
    this.cameraViewHalfExtentCurrent = clamped;
    this.onResize();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.beatFloor.onTrackEnded();
    this.audio.pause();
    this.backgroundAudio.pause();
    this.clearBackgroundPauseTimer();
    window.removeEventListener('resize', this.onResize);
    this.mobileMoveControls.dispose();
    this.clearDamagePulseRings();
    this.clearPhantomSplashEffects();
    this.clearBloodEffects();
    if (this.debugDashTankGroup) {
      this.disposeDebugDashTankChildren(this.debugDashTankGroup);
      this.scene.remove(this.debugDashTankGroup);
      this.debugDashTankGroup = null;
    }
    this.clearAllEnemies();
    this.clearEnemyProjectiles();
    this.ui.disposeMenuOverlays();
    this.mount.removeChild(this.renderer.domElement);
    this.composer.dispose();
    this.bloomPass.dispose();
    this.lensPass.dispose();
    this.renderer.dispose();
  }
}
