import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
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

export class Game {
  /** Outer radius of `RingGeometry` used for damage pulse (local units). */
  private static readonly DAMAGE_PULSE_RING_OUTER_LOCAL = 0.36;

  private readonly mount: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly composer: EffectComposer;
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
  private readonly spawner: EnemySpawner;
  private readonly ui: UI;
  private readonly audio = new AudioManager();
  private readonly beatEffects: BeatEffects;
  private beatmap: Beatmap | null = null;
  private nextBeatIndex = 0;
  /** Beat indices the player dashed on-time (lane draws them green). */
  private readonly beatHitIndices = new Set<number>();
  private beatHitCount = 0;
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
  /** Next XP total that triggers the in-run upgrade modal (10, 20, …). */
  private runNextUpgradeAtXp = CONFIG.runXpPerLevel;
  /** Active run time (seconds), only while `playing`; resets each new run. */
  private runElapsedSec = 0;
  /** Enemies killed this run (removed from arena by dash/tank resolve/damage pulse). */
  private runEnemiesKilled = 0;
  /** Post-process: render frustum scale vs gameplay ortho (lens overscan). */
  private lensOverscan = 1.35;
  /** Lens distortion from UI slider; effective value adds boost while beatmap audio plays. */
  private lensDistortionBase = 0.15;

  private readonly damagePulseRings: {
    mesh: THREE.Mesh;
    mat: THREE.MeshBasicMaterial;
    age: number;
    baseOpacity: number;
  }[] = [];

  /** Dash sweep consumed in `resolveDashKills` this frame (debug overlay / logs). */
  private dashDebugSweepThisFrame: DashSweepSegment | null = null;
  private debugDashTankGroup: THREE.Group | null = null;

  constructor(mount: HTMLElement) {
    this.mount = mount;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x07080c);

    const w = mount.clientWidth || window.innerWidth;
    const h = mount.clientHeight || window.innerHeight;
    const aspect = w / Math.max(1, h);
    const view = CONFIG.cameraViewHalfExtent;
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
    this.ui.onPlayRequested(() => {
      void this.startAudioPlayback();
    });
    this.ui.setPlayEnabled(false);
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
    const boost = this.audio.isPlaying ? CONFIG.lensDistortionWhileTrackPlaysBoost : 0;
    this.lensPass.setAmount(this.lensDistortionBase + boost);
  }

  private addArena(): void {
    const size = CONFIG.arenaFloorVisualHalfExtent * 2 + 2;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshStandardMaterial({
        color: 0x12141c,
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
      0x1e2433,
      0x141822,
    );
    grid.position.y = 0.01;
    this.scene.add(grid);
  }

  private async initBeatmap(): Promise<void> {
    try {
      const beatmap = await loadBeatmap('/beatmaps/test.json');
      this.beatmap = beatmap;
      this.nextBeatIndex = 0;
      this.resetBeatHitTracking();
      await this.audio.setTrack(beatmap.track);
      this.ui.setBeatmapState('Ready');
      this.ui.setPlayEnabled(true);
      this.ui.setBeatDebug(this.audio.currentTime, beatmap.beats[0]?.time ?? null);
    } catch (e) {
      console.error('[Beatmap] init failed:', e instanceof Error ? e.message : e, e);
      this.beatmap = null;
      this.ui.setBeatmapState('Beatmap load failed');
      this.ui.setPlayEnabled(false);
    }
  }

  private async startAudioPlayback(): Promise<void> {
    if (!this.beatmap) return;
    try {
      if (this.audio.currentTime >= (this.beatmap.beats.at(-1)?.time ?? 0) + 0.25) {
        this.audio.reset();
        this.nextBeatIndex = 0;
        this.resetBeatHitTracking();
      }
      await this.audio.play();
      this.ui.setBeatmapState('Playing');
    } catch (e) {
      console.error('[Beatmap] audio play failed:', e instanceof Error ? e.message : e, e);
      this.ui.setBeatmapState('Playback blocked');
    }
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
    const view = CONFIG.cameraViewHalfExtent;
    this.camera.left = (-view * aspect) / 2;
    this.camera.right = (view * aspect) / 2;
    this.camera.top = view / 2;
    this.camera.bottom = -view / 2;
    this.camera.updateProjectionMatrix();
    this.syncRenderCamera();
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
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
    this.updateDamagePulseRings(dt);
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
      this.ui.setRunXp(this.runXpTotal, CONFIG.runXpPerLevel);
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
      this.ui.setRunXp(0, CONFIG.runXpPerLevel);
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
      this.ui.setRunXp(this.runXpTotal, CONFIG.runXpPerLevel);
      this.ui.setVaultBearingAngle(null);
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
      this.enemies,
      isArtifactEnabled('reverseDash'),
    );
    this.tryRegisterDashBeatHit();

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
    if (isArtifactEnabled('bomb')) {
      const land = this.player.consumeDashLandingPulseXZ();
      if (land) {
        this.spawnDamagePulseRingAt(land.x, land.z);
        this.runEnemiesKilled += this.applyPlayerDamagePulseToEnemiesAt(land.x, land.z);
      }
    } else {
      this.player.consumeDashLandingPulseXZ();
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
      }
    }

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
      const hpBefore = this.player.hp;
      this.player.takeDamage(CONFIG.contactDamagePerTick * touching);
      if (this.player.hp < hpBefore) {
        this.ui.triggerDamageScreenFlash();
        this.spawnDamagePulseRingAt(this.player.x, this.player.z);
        this.runEnemiesKilled += this.applyPlayerDamagePulseToEnemiesAt(
          this.player.x,
          this.player.z,
        );
      }
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
    this.ui.setRunXp(this.runXpTotal, CONFIG.runXpPerLevel);
    this.syncVaultBearingUi();

    if (this.player.hp > 0) {
      this.maybeEnterRunUpgrade();
    }

    if (this.player.hp <= 0) {
      this.ui.hideRunUpgradeModal();
      this.runPhase = 'death';
      this.deathScreenTimer = 0;
      this.ui.setDeathScreenRunSummary({
        survivedSec: this.runElapsedSec,
        kills: this.runEnemiesKilled,
        level: 1 + Math.floor(this.runXpTotal / CONFIG.runXpPerLevel),
      });
      this.ui.showDeathScreen();
      this.audio.pause();
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
  }

  private startGameFromMenu(): void {
    if (this.runPhase === 'playing') {
      return;
    }
    clearRunBalanceBonuses();
    this.runElapsedSec = 0;
    this.runEnemiesKilled = 0;
    this.runXpTotal = 0;
    this.runNextUpgradeAtXp = CONFIG.runXpPerLevel;
    this.clearDamagePulseRings();
    this.clearAllEnemies();
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
    this.ui.setRunXp(0, CONFIG.runXpPerLevel);
  }

  private goToMainMenuAfterDeath(): void {
    this.runElapsedSec = 0;
    this.runEnemiesKilled = 0;
    this.runXpTotal = 0;
    this.runNextUpgradeAtXp = CONFIG.runXpPerLevel;
    clearRunBalanceBonuses();
    this.ui.hideRunUpgradeModal();
    this.clearDamagePulseRings();
    this.clearAllEnemies();
    this.player.resetForNewRun();
    this.spawner.reset();
    this.resetBeatHitTracking();
    this.nextBeatIndex = 0;
    this.audio.pause();
    this.audio.reset();
    this.cameraShake = 0;
    this.deathScreenTimer = 0;
    this.runPhase = 'menu';
    this.ui.hideDeathScreen();
    this.ui.showMainMenu();
  }

  private resetBeatHitTracking(): void {
    this.beatHitIndices.clear();
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
   * scale dash length & trail width (see `CONFIG.dashOnBeatLengthWidthMult`).
   */
  private getDashLengthWidthMultForThisFrame(): number {
    if (!this.input.wouldDashTriggerThisFrame()) return 1;
    if (!this.beatmap || this.player.hp <= 0) return 1;
    if (this.player.isMicroDashing) return 1;
    if (this.player.dash.cooldownLeft > 0 || this.player.dash.timeLeft > 0) return 1;
    const i = this.findBestBeatInDashWindowAtTime(this.audio.currentTime);
    if (i < 0 || this.beatHitIndices.has(i)) return 1;
    return CONFIG.dashOnBeatLengthWidthMult;
  }

  /** If the player just started a main dash, maybe count an on-beat hit vs audio time. */
  private tryRegisterDashBeatHit(): void {
    if (!this.player.consumeMainDashStarted()) return;
    if (!this.beatmap) return;
    const t = this.audio.currentTime;
    const bestI = this.findBestBeatInDashWindowAtTime(t);
    if (bestI >= 0 && !this.beatHitIndices.has(bestI)) {
      this.beatHitIndices.add(bestI);
      this.beatHitCount += 1;
      this.beatEffects.triggerOnBeatHitFlash();
      this.player.clearDashCooldownAfterOnBeatHit();
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

  /** XP to add so that `runXpTotal` reaches the next multiple of `runXpPerLevel` (vault kill). */
  private vaultXpFillToNextSegment(): number {
    const per = CONFIG.runXpPerLevel;
    const t = this.runXpTotal;
    const r = t % per;
    return r === 0 ? per : per - r;
  }

  private awardEnemyKillXp(enemy: Enemy): void {
    let xp: number;
    if (enemy.isVault()) {
      xp = this.vaultXpFillToNextSegment();
    } else if (enemy.isTank()) {
      xp = CONFIG.runXpKillTank;
    } else {
      xp = CONFIG.runXpKillMob;
    }
    this.runXpTotal += xp;
  }

  private maybeEnterRunUpgrade(): void {
    if (this.runPhase !== 'playing') return;
    if (this.runXpTotal < this.runNextUpgradeAtXp) return;
    this.runPhase = 'runUpgrade';
    this.ui.showRunUpgradeModal({
      milestoneXp: this.runNextUpgradeAtXp,
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
    this.runNextUpgradeAtXp += CONFIG.runXpPerLevel;
    this.ui.hideRunUpgradeModal();
    this.runPhase = 'playing';
    this.ui.setRunXp(this.runXpTotal, CONFIG.runXpPerLevel);
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
      if (e.isVault()) {
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

        if (e.getActiveShieldCount() > 0) {
          e.tryBreakVaultShieldWithDash(seg, vaultShieldJoin);
          if (e.vaultLastClipDashSerial !== dashSerial) {
            this.player.clipDashPastTank(tx, tz, tr, hitR + 0.35);
            e.vaultLastClipDashSerial = dashSerial;
          }
          continue;
        }

        if (e.damagedInDashHitSerial === dashSerial) continue;
        e.damagedInDashHitSerial = dashSerial;
        const died = e.takeDashHit();
        if (e.vaultLastClipDashSerial !== dashSerial) {
          this.player.clipDashPastTank(tx, tz, tr, hitR + 0.35);
          e.vaultLastClipDashSerial = dashSerial;
        }
        if (died) {
          this.awardEnemyKillXp(e);
          e.dispose(this.scene);
          this.enemies.splice(i, 1);
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
        if (isTank) {
          this.player.clipDashPastTank(tx, tz, tr, hitR + 0.35);
          e.scheduleDeferredTankDashDamage();
        } else {
          const died = e.takeDashHit();
          if (died) {
            this.awardEnemyKillXp(e);
            e.dispose(this.scene);
            this.enemies.splice(i, 1);
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
      e.dispose(this.scene);
      this.enemies.splice(i, 1);
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

  private spawnDamagePulseRingAt(x: number, z: number): void {
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
      (CONFIG.playerRadius * CONFIG.playerDamagePulseVisualRadiusMult) /
      Game.DAMAGE_PULSE_RING_OUTER_LOCAL;
    mesh.scale.setScalar(0.2 * scaleMax);
    this.scene.add(mesh);
    this.damagePulseRings.push({ mesh, mat, age: 0, baseOpacity: 0.92 });
  }

  private updateDamagePulseRings(dt: number): void {
    const dur = 0.24;
    const ringOuterLocal = Game.DAMAGE_PULSE_RING_OUTER_LOCAL;
    const targetWorldOuter =
      CONFIG.playerRadius * CONFIG.playerDamagePulseVisualRadiusMult;
    const scaleMax = targetWorldOuter / ringOuterLocal;
    for (let i = this.damagePulseRings.length - 1; i >= 0; i--) {
      const p = this.damagePulseRings[i]!;
      p.age += dt;
      const t = Math.min(1, p.age / dur);
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

  private applyPlayerDamagePulseToEnemiesAt(px: number, pz: number): number {
    const r = CONFIG.playerRadius * CONFIG.playerDamagePulseRadiusMult;
    const r2 = r * r;
    const pulseDmg = CONFIG.playerDamagePulseEnemyDamage;
    let kills = 0;
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i]!;
      const dx = e.mesh.position.x - px;
      const dz = e.mesh.position.z - pz;
      if (dx * dx + dz * dz > r2) continue;
      if (e.applyDamage(pulseDmg)) {
        this.awardEnemyKillXp(e);
        e.dispose(this.scene);
        this.enemies.splice(i, 1);
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

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.audio.pause();
    window.removeEventListener('resize', this.onResize);
    this.clearDamagePulseRings();
    if (this.debugDashTankGroup) {
      this.disposeDebugDashTankChildren(this.debugDashTankGroup);
      this.scene.remove(this.debugDashTankGroup);
      this.debugDashTankGroup = null;
    }
    for (const e of this.enemies) e.dispose(this.scene);
    this.enemies.length = 0;
    this.ui.disposeMenuOverlays();
    this.mount.removeChild(this.renderer.domElement);
    this.composer.dispose();
    this.lensPass.dispose();
    this.renderer.dispose();
  }
}
