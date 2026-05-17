import * as THREE from 'three';
import { CONFIG } from './config.ts';
import type { BeatEvent, Beatmap } from './Beatmap.ts';

/** World XZ size of one checker cell (matches arena floor texture repeat). */
export const ARENA_CHECKER_CELL_WORLD = 4;

const TRACK_FLOOR_TINT = new THREE.Color(0xffb8d8);
const FLOOR_COLOR_NORMAL = new THREE.Color(0xffffff);

type BeatFloorPulse = {
  hitTime: number;
  startTime: number;
  startRadius: number;
  endRadius: number;
};

export function createArenaCheckerCanvasTexture(): THREE.CanvasTexture {
  const cellSize = 32;
  const cellsPerSide = 16;
  const colors = ['#1f3a40', '#285c78'] as const;
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

  for (let y = 0; y < cellsPerSide - 1; y += 2) {
    for (let x = 0; x < cellsPerSide - 1; x += 2) {
      if (Math.random() > 0.18) continue;
      ctx.fillStyle = colors[Math.floor(Math.random() * colors.length)]!;
      ctx.fillRect(x * cellSize, y * cellSize, cellSize * 2, cellSize * 2);
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
 * Track playback: pink-tinted floor (same checker pattern) + per-cell white
 * highlights forming shrinking rings toward the hero on each beat.
 */
export class BeatFloorVisualizer {
  private static readonly PULSE_START_RADIUS_MULT = 3.5;
  private static readonly PULSE_END_RADIUS_WORLD = 2.5;
  private static readonly RING_BAND_WORLD = ARENA_CHECKER_CELL_WORLD * 1.4;
  private static readonly PULSE_FADE_SEC = 0.07;
  private static readonly CELL_MESH_SIZE = ARENA_CHECKER_CELL_WORLD * 0.96;
  /** Below enemies (4+) and player (5–10); above the floor mesh (0). */
  private static readonly CELL_RENDER_ORDER = 1;
  private static readonly CELL_Y = CONFIG.floorY + 0.011;

  private readonly floorMat: THREE.MeshStandardMaterial;
  private readonly highlightGroup: THREE.Group;
  private readonly cellMeshPool: THREE.Mesh[] = [];
  private readonly activeCellMeshes: THREE.Mesh[] = [];
  private readonly cellGeo: THREE.PlaneGeometry;
  private readonly pulses: BeatFloorPulse[] = [];
  private trackVisualsActive = false;
  private shimmerPhase = 0;

  constructor(scene: THREE.Scene, floorMat: THREE.MeshStandardMaterial) {
    this.floorMat = floorMat;
    this.highlightGroup = new THREE.Group();
    this.highlightGroup.renderOrder = BeatFloorVisualizer.CELL_RENDER_ORDER;
    scene.add(this.highlightGroup);
    this.cellGeo = new THREE.PlaneGeometry(
      BeatFloorVisualizer.CELL_MESH_SIZE,
      BeatFloorVisualizer.CELL_MESH_SIZE,
    );
  }

  onTrackStarted(beatmap: Beatmap, audioTime: number): void {
    this.trackVisualsActive = true;
    this.floorMat.color.copy(TRACK_FLOOR_TINT);
    this.pulses.length = 0;
    this.scheduleBeats(beatmap.beats, audioTime);
    this.releaseHighlightCells();
  }

  onTrackEnded(): void {
    if (!this.trackVisualsActive) return;
    this.trackVisualsActive = false;
    this.pulses.length = 0;
    this.floorMat.color.copy(FLOOR_COLOR_NORMAL);
    this.releaseHighlightCells();
  }

  update(
    dt: number,
    audioTime: number,
    playerX: number,
    playerZ: number,
    advancePulses: boolean,
  ): void {
    if (!this.trackVisualsActive) return;
    if (advancePulses) this.shimmerPhase += dt;
    this.cullPulses(audioTime);
    this.syncBeatRingCells(playerX, playerZ, audioTime, advancePulses);
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
      const dur = THREE.MathUtils.clamp(gap * 0.9, 0.32, 1.05);
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

  private syncBeatRingCells(
    playerX: number,
    playerZ: number,
    audioTime: number,
    drawRings: boolean,
  ): void {
    this.releaseHighlightCells();
    if (!drawRings || this.pulses.length === 0) return;

    const band = BeatFloorVisualizer.RING_BAND_WORLD;
    const t = this.shimmerPhase;
    let maxRadius = BeatFloorVisualizer.PULSE_END_RADIUS_WORLD;
    for (const pulse of this.pulses) {
      if (audioTime >= pulse.startTime) {
        maxRadius = Math.max(maxRadius, pulse.startRadius);
      }
    }

    const cell = ARENA_CHECKER_CELL_WORLD;
    const cellRange = Math.ceil((maxRadius + band) / cell) + 1;
    const playerCellX = Math.floor(playerX / cell);
    const playerCellZ = Math.floor(playerZ / cell);
    const y = BeatFloorVisualizer.CELL_Y;

    for (let dz = -cellRange; dz <= cellRange; dz++) {
      for (let dx = -cellRange; dx <= cellRange; dx++) {
        const wx = (playerCellX + dx + 0.5) * cell;
        const wz = (playerCellZ + dz + 0.5) * cell;
        const dist = Math.hypot(wx - playerX, wz - playerZ);

        let bestStrength = 0;
        for (const pulse of this.pulses) {
          if (
            audioTime < pulse.startTime ||
            audioTime > pulse.hitTime + BeatFloorVisualizer.PULSE_FADE_SEC
          ) {
            continue;
          }
          const span = Math.max(1e-4, pulse.hitTime - pulse.startTime);
          const u = THREE.MathUtils.clamp((audioTime - pulse.startTime) / span, 0, 1);
          const eased = 1 - (1 - u) ** 2.15;
          const radius =
            pulse.startRadius + (pulse.endRadius - pulse.startRadius) * eased;
          const delta = Math.abs(dist - radius);
          if (delta > band) continue;

          const edge = 1 - delta / band;
          const shimmer =
            0.5 +
            0.5 *
              Math.sin(
                t * 24 +
                  (playerCellX + dx) * 2.1 +
                  (playerCellZ + dz) * 1.7 +
                  dist * 0.4 +
                  pulse.hitTime * 4,
              );
          const fadeOut =
            audioTime > pulse.hitTime
              ? 1 -
                (audioTime - pulse.hitTime) / BeatFloorVisualizer.PULSE_FADE_SEC
              : 1;
          bestStrength = Math.max(
            bestStrength,
            edge * fadeOut * (0.5 + 0.55 * shimmer),
          );
        }

        if (bestStrength < 0.2) continue;
        const mesh = this.obtainCellMesh();
        mesh.position.set(wx, y, wz);
        const mat = mesh.material as THREE.MeshBasicMaterial;
        mat.opacity = Math.min(0.98, 0.35 + bestStrength * 0.65);
        mesh.visible = true;
        this.highlightGroup.add(mesh);
        this.activeCellMeshes.push(mesh);
      }
    }
  }

  private obtainCellMesh(): THREE.Mesh {
    const mesh = this.cellMeshPool.pop();
    if (mesh) return mesh;
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(this.cellGeo, mat);
    m.rotation.x = -Math.PI / 2;
    m.renderOrder = BeatFloorVisualizer.CELL_RENDER_ORDER;
    m.frustumCulled = false;
    return m;
  }

  private releaseHighlightCells(): void {
    for (const mesh of this.activeCellMeshes) {
      mesh.visible = false;
      this.highlightGroup.remove(mesh);
      this.cellMeshPool.push(mesh);
    }
    this.activeCellMeshes.length = 0;
  }
}
