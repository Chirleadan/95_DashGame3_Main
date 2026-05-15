import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { CONFIG, isDebugDashPastTankEnabled } from './config.ts';
import { Input } from './Input.ts';
import { Player, type DashSweepSegment } from './Player.ts';
import { Enemy } from './Enemy.ts';
import { EnemySpawner } from './EnemySpawner.ts';
import { circlesOverlap, segmentHitsCircle } from './Collision.ts';
import { UI } from './UI.ts';
import { CameraController } from './CameraController.ts';
import { screenToGroundXZ } from './screenToGround.ts';
import { loadBeatmap, type Beatmap, type BeatEvent } from './Beatmap.ts';
import { AudioManager } from './AudioManager.ts';
import { BeatEffects } from './BeatEffects.ts';
import { LensDistortionPass } from './render/LensDistortionPass.ts';
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
import {
  getDefaultTrackStage,
  type TrackStage,
} from './TrackCatalog.ts';

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
  private readonly spawner: EnemySpawner;
  private readonly ui: UI;
  private readonly audio = new AudioManager();
  private readonly backgroundAudio = new AudioManager();
  private readonly dashSfx = new Audio(Game.DASH_SFX_URL);
  private readonly deathSfx = new Audio(Game.DEATH_SFX_URL);
  private readonly hitSfxPool = Game.HIT_SFX_URLS.map((url) => new Audio(url));
  private backgroundPauseTimer: number | null = null;
  private readonly beatEffects: BeatEffects;
  private beatmap: Beatmap | null = null;
  private nextBeatIndex = 0;
  /** Beat indices the player dashed on-time (lane draws them green). */
  private readonly beatHitIndices = new Set<number>();
  private beatHitCount = 0;
  private readonly dashSerialsWithBeatHit = new Set<number>();
  private raf = 0;
  /** Orthographic camera shake after dash kills (decays each frame). */
  private cameraShake = 0;
  private readonly groundHit = new THREE.Vector3();
  private readonly vaultBearingProj = new THREE.Vector3();
  private fpsSmoothed = 0;
  private runPhase: 'menu' | 'playing' | 'death' | 'runUpgrade' = 'menu';
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
  /** Active run time (seconds), only while `playing`; resets each new run. */
  private runElapsedSec = 0;
  /** Enemies killed this run (removed from arena by dash/tank resolve/damage pulse). */
  private runEnemiesKilled = 0;
  /** Gold picked up this run (мешки золота); пока ни на что не тратится. */
  private runGold = 0;
  /** Mana picked up this run (мешки маны); пока ни на что не тратится. */
  private runMana = 0;
  /** Post-process: render frustum scale vs gameplay ortho (lens overscan). */
  private lensOverscan = 1.35;
  /** Lens distortion from UI slider; effective value adds boost while beatmap audio plays. */
  private lensDistortionBase = 0.15;
  private bloomThreshold = 0.35;
  private bloomStrength = 0.3;
  private pendingDashSfx = false;
  private lastDeathSfxAtMs = -Infinity;
  /** Current ortho camera half-height (world units), changed by wheel zoom. */
  private cameraViewHalfExtentCurrent: number = CONFIG.cameraViewHalfExtent;
  private selectedTrackStage: TrackStage = getDefaultTrackStage();
  private beatmapLoadSerial = 0;

  private readonly damagePulseRings: {
    mesh: THREE.Mesh;
    mat: THREE.MeshBasicMaterial;
    age: number;
    baseOpacity: number;
    radiusMult: number;
  }[] = [];

  /** Dash sweep consumed in `resolveDashKills` this frame (debug overlay / logs). */
  private dashDebugSweepThisFrame: DashSweepSegment | null = null;
  private debugDashTankGroup: THREE.Group | null = null;

  constructor(mount: HTMLElement) {
    this.mount = mount;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9eaaad);

    const w = mount.clientWidth || window.innerWidth;
    const h = mount.clientHeight || window.innerHeight;
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
    this.composer.addPass(new OutputPass());
    this.composer.setSize(w, h);

    this.addLights();
    this.addArena();

    loadBalanceSettings();

    this.input = new Input(window.document.documentElement, mount);
    this.input.centerPointerOn(this.renderer.domElement);
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
    for (const hitSfx of this.hitSfxPool) {
      hitSfx.preload = 'auto';
      hitSfx.volume = 0.78 * Game.SFX_VOLUME_MULT;
      hitSfx.load();
    }
    void this.backgroundAudio.setTrack(CONFIG.backgroundMusicUrl).catch((e) => {
      console.error('[BackgroundAudio] init failed:', e instanceof Error ? e.message : e, e);
    });
    this.ui.onPlayRequested(() => {
      void this.requestStartAudioPlayback();
    });
    this.ui.onTrackStageSelected((stage) => {
      void this.selectTrackStage(stage);
    });
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
    this.ui.showMainMenu();
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

  private applyLensDistortionEffective(): void {
    const boost = this.audio.isPlaying
      ? this.selectedTrackStage.boost.lensDistortionWhilePlaying
      : 0;
    this.lensPass.setAmount(this.lensDistortionBase + boost);
  }

  private addArena(): void {
    const size = CONFIG.arenaFloorVisualHalfExtent * 2 + 2;
    const checkerTexture = this.createArenaCheckerTexture();
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshStandardMaterial({
        map: checkerTexture,
        color: 0xffffff,
        metalness: 0.05,
        roughness: 0.92,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

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

  private createArenaCheckerTexture(): THREE.CanvasTexture {
    const tileSize = 96;
    const canvas = document.createElement('canvas');
    canvas.width = tileSize * 2;
    canvas.height = tileSize * 2;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Could not create arena checker texture canvas');
    }

    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#1a1d24';
    ctx.fillRect(tileSize, 0, tileSize, tileSize);
    ctx.fillRect(0, tileSize, tileSize, tileSize);

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(
      CONFIG.arenaFloorVisualHalfExtent / 4,
      CONFIG.arenaFloorVisualHalfExtent / 4,
    );
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.needsUpdate = true;
    return texture;
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
    if (!stage.enabled) return;
    this.selectedTrackStage = stage;
    this.ui.setSelectedTrackStage(stage);
    this.audio.pause();
    this.audio.reset();
    this.beatmap = null;
    this.nextBeatIndex = 0;
    this.resetBeatHitTracking();
    this.ui.setBeatDebug(0, null);
    this.ui.setBeatmapState('Loading...');
    this.syncBeatPlayButton();
    await this.initBeatmap();
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
    const spendMana =
      this.runPhase === 'playing' || this.runPhase === 'runUpgrade';
    if (spendMana && this.runMana < CONFIG.playTrackMinManaToActivate) {
      this.ui.setPlayEnabled(
        false,
        `Во время раунда нужно минимум ${CONFIG.playTrackMinManaToActivate} маны (старт: −${CONFIG.playTrackManaCost}).`,
      );
      return;
    }
    this.ui.setPlayEnabled(true, '');
  }

  private async requestStartAudioPlayback(): Promise<void> {
    void this.ensureBackgroundMusicPlaying();
    if (!this.beatmap) return;
    const spendMana =
      this.runPhase === 'playing' || this.runPhase === 'runUpgrade';
    if (spendMana) {
      if (this.runMana < CONFIG.playTrackMinManaToActivate) return;
      this.runMana -= CONFIG.playTrackManaCost;
      this.ui.setRunGoldMana(this.runGold, this.runMana);
      const ok = await this.startAudioPlayback();
      if (!ok) {
        this.runMana += CONFIG.playTrackManaCost;
        this.ui.setRunGoldMana(this.runGold, this.runMana);
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

  private async ensureBackgroundMusicPlaying(): Promise<void> {
    this.clearBackgroundPauseTimer();
    if (this.audio.isPlaying || this.backgroundAudio.isPlaying) return;
    try {
      await this.backgroundAudio.play();
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

  private onResize = (): void => {
    const w = this.mount.clientWidth || window.innerWidth;
    const h = this.mount.clientHeight || window.innerHeight;
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
    this.ui.resizeBeatLane();
  };

  private loop(): void {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.update(dt);
    this.syncRenderCamera();
    this.composer.render();
  }

  private update(dt: number): void {
    this.input.beginFrame();
    this.updateCameraZoomFromInput();
    this.syncBeatPlayButton();
    this.updateDamagePulseRings(dt);
    this.updateDyingEnemies(dt);
    this.applyLensDistortionEffective();

    if (this.runPhase === 'death') {
      this.clearDashPastTankDebugOverlay();
      this.deathScreenTimer += dt;
      this.beatEffects.update(dt);
      this.updateCamera(dt);
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
      this.ui.setRunRoundElapsedSec(this.runElapsedSec);
      this.ui.setRunKills(this.runEnemiesKilled);
      this.syncRunXpUi();
      this.ui.setRunGoldMana(this.runGold, this.runMana);
      this.ui.setVaultBearingAngle(null);
      if (this.deathScreenTimer >= CONFIG.deathScreenToMenuDelaySec) {
        this.goToMainMenuAfterDeath();
      }
      return;
    }

    if (this.runPhase === 'menu') {
      this.clearDashPastTankDebugOverlay();
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
      this.ui.setRunRoundElapsedSec(0);
      this.ui.setRunKills(0);
      this.syncRunXpUi();
      this.ui.setRunGoldMana(0, 0);
      this.ui.setVaultBearingAngle(null);
      return;
    }

    if (this.runPhase === 'runUpgrade') {
      this.clearDashPastTankDebugOverlay();
      this.beatEffects.update(dt);
      this.updateCamera(dt);
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
      this.ui.setRunRoundElapsedSec(this.runElapsedSec);
      this.ui.setRunKills(this.runEnemiesKilled);
      this.syncRunXpUi();
      this.ui.setRunGoldMana(this.runGold, this.runMana);
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

    if (this.input.consumePlayTrackTrigger()) {
      void this.requestStartAudioPlayback();
    }

    this.runElapsedSec += dt;
    const diffMult = this.getDifficultyMultiplier();
    const maxSlots = this.getMaxEnemySlots();

    this.updateBeatPlayback(dt);

    this.player.update(
      dt,
      this.input,
      aimOk ? this.groundHit : null,
      aimOk,
      this.getDashLengthWidthMultForThisFrame(),
      this.getActivePlayerSpeedMult(),
      this.enemies,
    );
    const mainDashStarted = this.player.consumeMainDashStarted();
    if (mainDashStarted) {
      this.pendingDashSfx = true;
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
        e.update(dt, this.player.x, this.player.z, diffMult, storageNav);
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
      !this.player.isInvulnerable()
    ) {
      this.damagePlayerAndPulse(CONFIG.contactDamagePerTick * touching);
    }

    this.updateCamera(dt);

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
    this.ui.setRunRoundElapsedSec(this.runElapsedSec);
    this.ui.setRunKills(this.runEnemiesKilled);
    this.syncRunXpUi();
    this.ui.setRunGoldMana(this.runGold, this.runMana);
    this.syncVaultBearingUi();

    if (this.player.hp > 0) {
      this.maybeEnterRunUpgrade();
    }

    if (this.player.hp <= 0) {
      this.ui.hideRunUpgradeModal();
      this.pendingDashSfx = false;
      this.runPhase = 'death';
      this.deathScreenTimer = 0;
      this.clearEnemyProjectiles();
      this.ui.setDeathScreenRunSummary({
        survivedSec: this.runElapsedSec,
        kills: this.runEnemiesKilled,
        level: this.getRunXpProgress(this.runXpTotal).level,
      });
      this.ui.showDeathScreen();
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

  private removeEnemyFromGameplayAt(index: number): Enemy | null {
    const enemy = this.enemies[index];
    if (!enemy) return null;
    this.enemies.splice(index, 1);
    this.playDeathSfx();
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

  private clearEnemyProjectiles(): void {
    for (const p of this.enemyProjectiles) {
      this.scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      (p.mesh.material as THREE.Material).dispose();
    }
    this.enemyProjectiles.length = 0;
  }

  private spawnEnemyProjectile(enemy: Enemy): void {
    const dx = this.player.x - enemy.mesh.position.x;
    const dz = this.player.z - enemy.mesh.position.z;
    const len = Math.hypot(dx, dz);
    if (len <= 1e-4) return;
    const nx = dx / len;
    const nz = dz / len;
    const r = CONFIG.shooterProjectileRadius;
    const geo = new THREE.SphereGeometry(r, 12, 8);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xa8f2ff,
      transparent: true,
      opacity: 0.96,
    });
    const mesh = new THREE.Mesh(geo, mat);
    const startOffset = enemy.bodyRadius + r + 0.08;
    mesh.position.set(
      enemy.mesh.position.x + nx * startOffset,
      CONFIG.floorY + 0.28,
      enemy.mesh.position.z + nz * startOffset,
    );
    this.scene.add(mesh);
    this.enemyProjectiles.push({
      mesh,
      vx: nx * CONFIG.shooterProjectileSpeed,
      vz: nz * CONFIG.shooterProjectileSpeed,
      age: 0,
    });
  }

  private updateEnemyProjectiles(dt: number): void {
    const maxAge = Math.max(0.1, CONFIG.shooterProjectileMaxAgeSec);
    for (let i = this.enemyProjectiles.length - 1; i >= 0; i--) {
      const p = this.enemyProjectiles[i]!;
      p.age += dt;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.z += p.vz * dt;
      if (
        this.player.hp > 0 &&
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

  private damagePlayerAndPulse(amount: number): void {
    if (this.player.hp <= 0) return;
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

  private startGameFromMenu(): void {
    if (this.runPhase === 'playing') {
      return;
    }
    clearRunBalanceBonuses();
    this.runElapsedSec = 0;
    this.runEnemiesKilled = 0;
    this.runGold = 0;
    this.runMana = 0;
    this.runXpTotal = 0;
    this.runLevelUpsAwarded = 0;
    this.runNextUpgradeAtXp = CONFIG.runXpPerLevel;
    this.runPendingUpgradeMilestones.length = 0;
    this.wasTrackPlayingLastFrame = false;
    this.pendingDashSfx = false;
    this.clearDamagePulseRings();
    this.clearAllEnemies();
    this.clearEnemyProjectiles();
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
    this.audio.reset();
    this.cameraShake = 0;
    this.runPhase = 'playing';
    this.ui.hideMainMenu();
    this.ui.hideDeathScreen();
    this.ui.hideRunUpgradeModal();
    this.ui.setRunKills(0);
    this.syncRunXpUi();
    this.ui.setRunGoldMana(0, 0);
    void this.ensureBackgroundMusicPlaying();
  }

  private goToMainMenuAfterDeath(): void {
    this.runElapsedSec = 0;
    this.runEnemiesKilled = 0;
    this.runGold = 0;
    this.runMana = 0;
    this.runXpTotal = 0;
    this.runLevelUpsAwarded = 0;
    this.runNextUpgradeAtXp = CONFIG.runXpPerLevel;
    this.runPendingUpgradeMilestones.length = 0;
    this.wasTrackPlayingLastFrame = false;
    this.pendingDashSfx = false;
    clearRunBalanceBonuses();
    this.ui.hideRunUpgradeModal();
    this.clearDamagePulseRings();
    this.clearAllEnemies();
    this.clearEnemyProjectiles();
    this.player.resetForNewRun();
    this.spawner.reset();
    this.resetBeatHitTracking();
    this.nextBeatIndex = 0;
    this.audio.pause();
    this.audio.reset();
    void this.ensureBackgroundMusicPlaying();
    this.cameraShake = 0;
    this.deathScreenTimer = 0;
    this.runPhase = 'menu';
    this.ui.hideDeathScreen();
    this.ui.showMainMenu();
  }

  private resetBeatHitTracking(): void {
    this.beatHitIndices.clear();
    this.dashSerialsWithBeatHit.clear();
    this.beatHitCount = 0;
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

  private getActiveDashLandingPulseRadiusMult(): number {
    if (!this.audio.isPlaying) return 0;
    const mult = this.selectedTrackStage.boost.dashLandingPulseRadiusMult;
    return Number.isFinite(mult) && mult > 0 ? mult : 0;
  }

  private shouldPulseForSuccessfulBeatDash(): boolean {
    return this.dashSerialsWithBeatHit.delete(this.player.getDashHitSerial());
  }

  private playSfx(source: HTMLAudioElement, rateVariance: number): void {
    const sfx = source.cloneNode(true) as HTMLAudioElement;
    sfx.playbackRate = rateVariance > 0
      ? 1 + (Math.random() * 2 - 1) * rateVariance
      : 1;
    sfx.volume = source.volume;
    void sfx.play().catch(() => {
      // The first user gesture may still be required by the browser.
    });
  }

  private playDashSfx(): void {
    this.playSfx(this.dashSfx, Game.DASH_SFX_RATE_VARIANCE);
  }

  private playHitSfx(): void {
    const index = Math.floor(Math.random() * this.hitSfxPool.length);
    this.playSfx(this.hitSfxPool[index] ?? this.hitSfxPool[0]!, Game.HIT_SFX_RATE_VARIANCE);
  }

  private playDeathSfx(): void {
    const now = performance.now();
    if (now - this.lastDeathSfxAtMs < Game.DEATH_SFX_COOLDOWN_MS) return;
    this.lastDeathSfxAtMs = now;
    this.playSfx(this.deathSfx, 0);
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
    if (!this.beatmap) return;
    const t = this.audio.currentTime;
    const bestI = this.findBestBeatInDashWindowAtTime(t);
    if (bestI >= 0 && !this.beatHitIndices.has(bestI)) {
      this.beatHitIndices.add(bestI);
      this.dashSerialsWithBeatHit.add(this.player.getDashHitSerial());
      this.beatHitCount += 1;
      this.beatEffects.triggerOnBeatHitFlash();
      if (this.audio.isPlaying && this.selectedTrackStage.boost.resetDashCooldownOnBeat) {
        this.player.clearDashCooldownAfterOnBeatHit();
      }
    }
  }

  private onBeatReached(beat: BeatEvent): void {
    this.beatEffects.triggerBeat(beat);
  }

  /** Beat lane canvas: after movement so the center hit ring matches `player.isDashing`. */
  private syncBeatLaneUi(): void {
    if (!this.beatmap) {
      this.ui.updateBeatLane(0, null, this.beatHitIndices, this.player.isDashing);
      return;
    }
    this.ui.updateBeatLane(
      this.audio.currentTime,
      this.beatmap.beats,
      this.beatHitIndices,
      this.player.isDashing,
    );
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

  private grantResourceLootFromSack(enemy: Enemy): void {
    if (enemy.isGoldSack()) {
      this.runGold += rollResourceSackDropAmount();
    } else if (enemy.isManaSack()) {
      this.runMana += 10;
    }
  }

  private awardEnemyKillXp(enemy: Enemy): void {
    if (enemy.isResourceSack()) return;
    let xp: number;
    if (enemy.isVault()) {
      xp = this.vaultXpFillToNextSegment();
    } else if (enemy.isTank() || enemy.isAngel()) {
      xp = CONFIG.runXpKillTank;
    } else {
      xp = CONFIG.runXpKillMob;
    }
    this.runXpTotal += xp;
  }

  private maybeEnterRunUpgrade(): void {
    if (this.runPhase !== 'playing') return;
    this.collectReachedRunUpgradeMilestones();
    if (this.runPendingUpgradeMilestones.length <= 0) return;
    // While the beat-track ability is active, queue upgrades but do not interrupt gameplay.
    if (this.audio.isPlaying) return;
    this.openNextRunUpgradeModal();
  }

  private collectReachedRunUpgradeMilestones(): void {
    while (this.runXpTotal >= this.runNextUpgradeAtXp) {
      this.runPendingUpgradeMilestones.push(this.runNextUpgradeAtXp);
      this.runLevelUpsAwarded += 1;
      this.runNextUpgradeAtXp += this.getRunXpRequiredForLevelUp(this.runLevelUpsAwarded + 1);
    }
  }

  private openNextRunUpgradeModal(): void {
    if (this.runPendingUpgradeMilestones.length <= 0) return;
    this.runPhase = 'runUpgrade';
    this.ui.showRunUpgradeModal({
      milestoneXp: this.runPendingUpgradeMilestones[0]!,
      onDash: () => this.applyRunUpgradeChoice('dash'),
      onSpeed: () => this.applyRunUpgradeChoice('speed'),
      onShields: () => this.applyRunUpgradeChoice('shields'),
      onShieldRegen: () => this.applyRunUpgradeChoice('shieldRegen'),
    });
  }

  private applyRunUpgradeChoice(
    kind: 'dash' | 'speed' | 'shields' | 'shieldRegen',
  ): void {
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
    } else {
      this.player.accelerateShieldRegenFromUpgrade();
    }
    if (this.runPendingUpgradeMilestones.length > 0) {
      this.runPendingUpgradeMilestones.shift();
    }
    this.ui.hideRunUpgradeModal();
    this.runPhase = 'playing';
    this.syncRunXpUi();
    this.ui.setRunGoldMana(this.runGold, this.runMana);
    this.maybeEnterRunUpgrade();
  }

  private updateBeatPlayback(dt: number): void {
    this.beatEffects.update(dt);
    if (!this.beatmap) {
      return;
    }

    const now = this.audio.currentTime;
    const beats = this.beatmap.beats;
    while (this.nextBeatIndex < beats.length && now >= beats[this.nextBeatIndex]!.time) {
      this.onBeatReached(beats[this.nextBeatIndex]!);
      this.nextBeatIndex += 1;
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
      void this.ensureBackgroundMusicPlaying();
      this.maybeEnterRunUpgrade();
    }
    this.wasTrackPlayingLastFrame = trackPlayingNow;
  }

  private resolveDashKills(): number {
    const seg = this.player.consumeDashSweep();
    this.dashDebugSweepThisFrame = seg;
    if (!seg) return 0;
    const dashSerial = this.player.getDashHitSerial();
    const scaledPlayer = CONFIG.playerRadius * getDashKillRadiusScale();
    let kills = 0;
    const vaultShieldJoin = CONFIG.vaultShieldDashJoinRadius;
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (e.isVault() || e.isAngel()) {
        const hitR = scaledPlayer + e.bodyRadius;
        const bodyHit = segmentHitsCircle(
          seg.ax,
          seg.az,
          seg.bx,
          seg.bz,
          e.mesh.position.x,
          e.mesh.position.z,
          hitR,
        );
        if (!bodyHit) continue;

        const tx = e.mesh.position.x;
        const tz = e.mesh.position.z;
        const tr = e.bodyRadius;

        if (e.isAngel()) {
          const canDamageAngel =
            e.canDashDamageFromOpenShieldSide(seg, vaultShieldJoin);
          this.markDashImpactSfx();
          if (!canDamageAngel) {
            e.tryBreakVaultShieldWithDash(seg, vaultShieldJoin);
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
          e.tryBreakVaultShieldWithDash(seg, vaultShieldJoin);
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
          this.removeEnemyFromGameplayAt(i);
          kills += 1;
        }
        continue;
      }

      const hitR = scaledPlayer + e.bodyRadius;
      if (
        segmentHitsCircle(
          seg.ax,
          seg.az,
          seg.bx,
          seg.bz,
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
          const died = e.takeDashHit();
          if (died) {
            this.grantResourceLootFromSack(e);
            this.awardEnemyKillXp(e);
            this.removeEnemyFromGameplayAt(i);
            kills += 1;
          }
        }
      }
    }
    return kills;
  }

  /** Apply tank dash hits that were deferred after clip/slide (see `CONFIG.tankDashDamageDelayMs`). */
  private applyDeferredTankDashDamage(): number {
    let kills = 0;
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (!e.isTank()) continue;
      if (!e.tickDeferredTankDashDamage()) continue;
      this.awardEnemyKillXp(e);
      this.removeEnemyFromGameplayAt(i);
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
        this.grantResourceLootFromSack(e);
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
    const clamped = Math.min(
      CONFIG.cameraZoomMaxHalfExtent,
      Math.max(CONFIG.cameraZoomMinHalfExtent, next),
    );
    if (Math.abs(clamped - this.cameraViewHalfExtentCurrent) < 1e-6) return;
    this.cameraViewHalfExtentCurrent = clamped;
    this.onResize();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.audio.pause();
    this.backgroundAudio.pause();
    this.clearBackgroundPauseTimer();
    window.removeEventListener('resize', this.onResize);
    this.clearDamagePulseRings();
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
