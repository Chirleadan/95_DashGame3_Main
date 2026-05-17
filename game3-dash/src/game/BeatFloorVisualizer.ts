import * as THREE from 'three';
import { CONFIG } from './config.ts';
import type { BeatEvent, Beatmap } from './Beatmap.ts';

/** World XZ size of one checker cell (matches `Game.createArenaCheckerTexture` repeat). */
export const ARENA_CHECKER_CELL_WORLD = 4;

const MENU_PINK_LIGHT = '#ffd0e8';
const MENU_PINK_DARK = '#ff6b9d';
const TEAL_A = '#1f3a40';
const TEAL_B = '#285c78';

type BeatFloorPulse = {
  hitTime: number;
  startTime: number;
  startRadius: number;
  endRadius: number;
};

export function createArenaCheckerCanvasTexture(pinkMenuPalette: boolean): THREE.CanvasTexture {
  const cellSize = 32;
  const cellsPerSide = 16;
  const colors = pinkMenuPalette
    ? ([MENU_PINK_LIGHT, MENU_PINK_DARK] as const)
    : ([TEAL_A, TEAL_B] as const);
  const canvas = document.createElement('canvas');
  canvas.width = cellSize * cellsPerSide;
  canvas.height = cellSize * cellsPerSide;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not create arena checker texture canvas');
  }

  for (let y = 0; y < cellsPerSide; y++) {
    for (let x = 0; x < cellsPerSide; x++) {
      ctx.fillStyle = colors[(x + y) % 2]!;
      ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
    }
  }

  if (!pinkMenuPalette) {
    for (let y = 0; y < cellsPerSide - 1; y += 2) {
      for (let x = 0; x < cellsPerSide - 1; x += 2) {
        if (Math.random() > 0.18) continue;
        ctx.fillStyle = colors[Math.floor(Math.random() * colors.length)]!;
        ctx.fillRect(x * cellSize, y * cellSize, cellSize * 2, cellSize * 2);
      }
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    CONFIG.arenaFloorVisualHalfExtent / 32,
    CONFIG.arenaFloorVisualHalfExtent / 32,
  );
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Track playback: pink checker floor + shrinking beat rings drawn as white
 * checker cells on a local overlay above the hero.
 */
export class BeatFloorVisualizer {
  private static readonly OVERLAY_CELLS = 52;
  private static readonly OVERLAY_WORLD =
    BeatFloorVisualizer.OVERLAY_CELLS * ARENA_CHECKER_CELL_WORLD;
  private static readonly PULSE_START_RADIUS_MULT = 3.4;
  private static readonly PULSE_END_RADIUS_WORLD = 2.35;
  private static readonly RING_BAND_CELLS = 2.1;
  private static readonly PULSE_FADE_SEC = 0.06;

  private readonly floorMat: THREE.MeshStandardMaterial;
  private readonly baseMap: THREE.CanvasTexture;
  private readonly trackMap: THREE.CanvasTexture;
  private readonly overlayMesh: THREE.Mesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly overlayTexture: THREE.CanvasTexture;
  private readonly pulses: BeatFloorPulse[] = [];
  private trackVisualsActive = false;
  private shimmerPhase = 0;

  constructor(
    scene: THREE.Scene,
    floorMat: THREE.MeshStandardMaterial,
    baseMap: THREE.CanvasTexture,
    trackMap: THREE.CanvasTexture,
  ) {
    this.floorMat = floorMat;
    this.baseMap = baseMap;
    this.trackMap = trackMap;

    this.canvas = document.createElement('canvas');
    this.canvas.width = BeatFloorVisualizer.OVERLAY_CELLS;
    this.canvas.height = BeatFloorVisualizer.OVERLAY_CELLS;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Beat floor overlay canvas unavailable');
    this.ctx = ctx;

    this.overlayTexture = new THREE.CanvasTexture(this.canvas);
    this.overlayTexture.magFilter = THREE.NearestFilter;
    this.overlayTexture.minFilter = THREE.NearestFilter;
    this.overlayTexture.colorSpace = THREE.SRGBColorSpace;

    const overlayMat = new THREE.MeshBasicMaterial({
      map: this.overlayTexture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.overlayMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(
        BeatFloorVisualizer.OVERLAY_WORLD,
        BeatFloorVisualizer.OVERLAY_WORLD,
      ),
      overlayMat,
    );
    this.overlayMesh.rotation.x = -Math.PI / 2;
    this.overlayMesh.position.y = CONFIG.floorY + 0.018;
    this.overlayMesh.renderOrder = 2;
    this.overlayMesh.visible = false;
    scene.add(this.overlayMesh);
  }

  onTrackStarted(beatmap: Beatmap, audioTime: number): void {
    this.trackVisualsActive = true;
    this.floorMat.map = this.trackMap;
    this.floorMat.needsUpdate = true;
    this.pulses.length = 0;
    this.scheduleBeats(beatmap.beats, audioTime);
    this.overlayMesh.visible = true;
  }

  onTrackEnded(): void {
    if (!this.trackVisualsActive) return;
    this.trackVisualsActive = false;
    this.pulses.length = 0;
    this.floorMat.map = this.baseMap;
    this.floorMat.needsUpdate = true;
    this.overlayMesh.visible = false;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.overlayTexture.needsUpdate = true;
  }

  update(
    dt: number,
    audioTime: number,
    playerX: number,
    playerZ: number,
    advancePulses: boolean,
  ): void {
    if (!this.trackVisualsActive) return;
    if (advancePulses) {
      this.shimmerPhase += dt;
    }
    this.syncOverlayPosition(playerX, playerZ);
    this.cullPulses(audioTime);
    this.paintOverlay(playerX, playerZ, audioTime);
  }

  private scheduleBeats(beats: readonly BeatEvent[], fromTime: number): void {
    let prevTime = fromTime;
    const startR =
      CONFIG.cameraViewHalfExtent *
      2 *
      BeatFloorVisualizer.PULSE_START_RADIUS_MULT;
    const endR = BeatFloorVisualizer.PULSE_END_RADIUS_WORLD;
    for (let i = 0; i < beats.length; i++) {
      const hitTime = beats[i]!.time;
      if (hitTime <= fromTime + 0.02) {
        prevTime = hitTime;
        continue;
      }
      const gap = hitTime - prevTime;
      const dur = THREE.MathUtils.clamp(gap * 0.9, 0.3, 1.05);
      this.pulses.push({
        hitTime,
        startTime: hitTime - dur,
        startRadius: startR,
        endRadius: endR,
      });
      prevTime = hitTime;
    }
  }

  private cullPulses(audioTime: number): void {
    const cutoff = audioTime - BeatFloorVisualizer.PULSE_FADE_SEC;
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      if (this.pulses[i]!.hitTime < cutoff) {
        this.pulses.splice(i, 1);
      }
    }
  }

  private syncOverlayPosition(playerX: number, playerZ: number): void {
    const half = BeatFloorVisualizer.OVERLAY_WORLD * 0.5;
    const cell = ARENA_CHECKER_CELL_WORLD;
    const snapX = Math.floor(playerX / cell) * cell + half;
    const snapZ = Math.floor(playerZ / cell) * cell + half;
    this.overlayMesh.position.set(snapX, CONFIG.floorY + 0.018, snapZ);
  }

  private paintOverlay(playerX: number, playerZ: number, audioTime: number): void {
    const ctx = this.ctx;
    const cells = BeatFloorVisualizer.OVERLAY_CELLS;
    const cellWorld = ARENA_CHECKER_CELL_WORLD;
    const halfWorld = BeatFloorVisualizer.OVERLAY_WORLD * 0.5;
    const originX = this.overlayMesh.position.x - halfWorld;
    const originZ = this.overlayMesh.position.z - halfWorld;
    const band = BeatFloorVisualizer.RING_BAND_CELLS * cellWorld;
    const pinkA = MENU_PINK_LIGHT;
    const pinkB = MENU_PINK_DARK;

    ctx.clearRect(0, 0, cells, cells);

    for (let cy = 0; cy < cells; cy++) {
      for (let cx = 0; cx < cells; cx++) {
        const wx = originX + (cx + 0.5) * cellWorld;
        const wz = originZ + (cy + 0.5) * cellWorld;
        const base = (Math.floor(wx / cellWorld) + Math.floor(wz / cellWorld)) % 2;
        ctx.fillStyle = base === 0 ? pinkA : pinkB;
        ctx.fillRect(cx, cy, 1, 1);
      }
    }

    const t = this.shimmerPhase;
    for (const pulse of this.pulses) {
      if (audioTime < pulse.startTime || audioTime > pulse.hitTime + BeatFloorVisualizer.PULSE_FADE_SEC) {
        continue;
      }
      const span = Math.max(1e-4, pulse.hitTime - pulse.startTime);
      const u = THREE.MathUtils.clamp((audioTime - pulse.startTime) / span, 0, 1);
      const eased = 1 - (1 - u) ** 2.1;
      const radius = pulse.startRadius + (pulse.endRadius - pulse.startRadius) * eased;
      const fadeOut =
        audioTime > pulse.hitTime
          ? 1 - (audioTime - pulse.hitTime) / BeatFloorVisualizer.PULSE_FADE_SEC
          : 1;

      for (let cy = 0; cy < cells; cy++) {
        for (let cx = 0; cx < cells; cx++) {
          const wx = originX + (cx + 0.5) * cellWorld;
          const wz = originZ + (cy + 0.5) * cellWorld;
          const dist = Math.hypot(wx - playerX, wz - playerZ);
          const delta = Math.abs(dist - radius);
          if (delta > band) continue;

          const edge = 1 - delta / band;
          const shimmer =
            0.5 +
            0.5 *
              Math.sin(
                t * 22 +
                  cx * 1.9 +
                  cy * 2.4 +
                  dist * 0.35 +
                  pulse.hitTime * 3.1,
              );
          if (shimmer < 0.38 && edge < 0.55) continue;

          const alpha = Math.min(1, edge * 1.15 * fadeOut * (0.55 + shimmer * 0.55));
          ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
          ctx.fillRect(cx, cy, 1, 1);
        }
      }
    }

    this.overlayTexture.needsUpdate = true;
  }
}
