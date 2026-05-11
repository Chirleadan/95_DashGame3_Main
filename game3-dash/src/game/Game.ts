import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { CONFIG } from './config.ts';
import { Input } from './Input.ts';
import { Player } from './Player.ts';
import { Enemy } from './Enemy.ts';
import { EnemySpawner } from './EnemySpawner.ts';
import { circlesOverlap, segmentHitsCircle } from './Collision.ts';
import { UI } from './UI.ts';
import { CameraController } from './CameraController.ts';
import { screenToGroundXZ } from './screenToGround.ts';
import { loadBeatmap, type Beatmap } from './Beatmap.ts';
import { AudioManager } from './AudioManager.ts';
import { BeatEffects } from './BeatEffects.ts';
import { LensDistortionPass } from './render/LensDistortionPass.ts';

export class Game {
  private readonly mount: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly composer: EffectComposer;
  private readonly lensPass: LensDistortionPass;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.OrthographicCamera;
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
  private fpsSmoothed = 0;

  constructor(mount: HTMLElement) {
    this.mount = mount;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x07080c);

    const w = mount.clientWidth || window.innerWidth;
    const h = mount.clientHeight || window.innerHeight;
    const aspect = w / Math.max(1, h);
    const view = 18;
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

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(this.renderer.domElement);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.lensPass = new LensDistortionPass();
    this.composer.addPass(this.lensPass);
    this.composer.addPass(new OutputPass());
    this.composer.setSize(w, h);

    this.addLights();
    this.addArena();

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
      this.lensPass.setAmount(v);
    });
    void this.initBeatmap();

    this.spawner.spawnBurstAround(
      this.player.x,
      this.player.z,
      CONFIG.initialEnemyCount,
    );

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
    dir.shadow.camera.far = 80;
    dir.shadow.camera.left = -30;
    dir.shadow.camera.right = 30;
    dir.shadow.camera.top = 30;
    dir.shadow.camera.bottom = -30;
    this.scene.add(dir);
  }

  private addArena(): void {
    const size = CONFIG.arenaHalfSize * 2 + 2;
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
      CONFIG.arenaHalfSize * 2,
      16,
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
    } catch {
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
    } catch {
      this.ui.setBeatmapState('Playback blocked');
    }
  }

  private onResize = (): void => {
    const w = this.mount.clientWidth || window.innerWidth;
    const h = this.mount.clientHeight || window.innerHeight;
    const aspect = w / Math.max(1, h);
    const view = 18;
    this.camera.left = (-view * aspect) / 2;
    this.camera.right = (view * aspect) / 2;
    this.camera.top = view / 2;
    this.camera.bottom = -view / 2;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.ui.resizeBeatLane();
  };

  private loop(): void {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.update(dt);
    this.composer.render();
  }

  private update(dt: number): void {
    this.input.beginFrame();

    const aimOk = screenToGroundXZ(
      this.input.lastPointerClientX,
      this.input.lastPointerClientY,
      this.renderer.domElement,
      this.camera,
      CONFIG.floorY,
      this.groundHit,
    );

    this.player.update(
      dt,
      this.input,
      aimOk ? this.groundHit : null,
      aimOk,
      this.getDashLengthWidthMultForThisFrame(),
    );
    this.tryRegisterDashBeatHit();
    this.updateBeatPlayback(dt);

    const dashKills = this.resolveDashKills();
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
      for (const e of this.enemies) {
        e.update(dt, this.player.x, this.player.z);
      }
    }

    this.spawner.update(dt, this.player.x, this.player.z);

    let touching = 0;
    for (const e of this.enemies) {
      if (
        circlesOverlap(
          this.player.x,
          this.player.z,
          CONFIG.playerRadius,
          e.mesh.position.x,
          e.mesh.position.z,
          CONFIG.enemyRadius,
        )
      ) {
        touching += 1;
      }
    }
    if (touching > 0 && this.player.hp > 0 && !this.player.isInvulnerable()) {
      this.player.takeDamage(CONFIG.contactDamagePerTick * touching);
    }

    this.updateCamera(dt);

    const instFps = dt > 1e-6 ? 1 / dt : 0;
    this.fpsSmoothed =
      this.fpsSmoothed <= 0
        ? instFps
        : this.fpsSmoothed * 0.92 + instFps * 0.08;

    this.ui.update(this.player.hp, this.enemies.length, this.player.dashCooldownRemaining);
    this.ui.setFps(this.fpsSmoothed);
    this.ui.setBeatHitCount(this.beatHitCount);
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
    }
  }

  private updateBeatPlayback(dt: number): void {
    this.beatEffects.update(dt);
    if (!this.beatmap) {
      this.ui.updateBeatLane(0, null, this.beatHitIndices);
      return;
    }

    const now = this.audio.currentTime;
    const beats = this.beatmap.beats;
    while (this.nextBeatIndex < beats.length && now >= beats[this.nextBeatIndex]!.time) {
      this.nextBeatIndex += 1;
    }

    const nextBeatTime = this.nextBeatIndex < beats.length ? beats[this.nextBeatIndex]!.time : null;
    this.ui.setBeatDebug(now, nextBeatTime);
    this.ui.updateBeatLane(now, beats, this.beatHitIndices);

    if (this.audio.isPlaying) {
      this.ui.setBeatmapState('Playing');
    } else if (now > 0 && this.nextBeatIndex >= beats.length) {
      this.ui.setBeatmapState('Ended');
    }
  }

  private resolveDashKills(): number {
    const seg = this.player.consumeDashSweep();
    if (!seg) return 0;
    const hitR =
      CONFIG.playerRadius * CONFIG.dashKillPlayerRadiusScale +
      CONFIG.enemyRadius;
    let kills = 0;
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
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
    for (const e of this.enemies) e.dispose(this.scene);
    this.enemies.length = 0;
    this.mount.removeChild(this.renderer.domElement);
    this.composer.dispose();
    this.lensPass.dispose();
    this.renderer.dispose();
  }
}
