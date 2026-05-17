import * as THREE from 'three';
import { CONFIG } from './config.ts';
import type { BeatEvent, Beatmap } from './Beatmap.ts';

/** World XZ size of one checker cell (matches arena floor texture repeat). */
export const ARENA_CHECKER_CELL_WORLD = 4;

/** Main-menu backdrop (`style.css`). */
const MENU_BACKGROUND_COLOR = 0xff25b6;

type BeatTraveler = {
  hitTime: number;
  approachStart: number;
  departEnd: number;
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
 * One menu-pink tile per beat: travels along the hero's floor row (screen R→L),
 * reaches the hero on the beat, then continues left.
 */
export class BeatFloorVisualizer {
  private static readonly CELL_MESH_SIZE = ARENA_CHECKER_CELL_WORLD * 0.96;
  private static readonly CELL_RENDER_ORDER = 1;
  private static readonly CELL_Y = CONFIG.floorY + 0.011;
  /** Half-width of travel in cells (spawn far off-screen, fly in). */
  private static readonly TRAVEL_HALF_CELLS_MULT = 6.75;
  /** Approach / depart durations × this (1.25 = 25% slower). */
  private static readonly TRAVEL_DURATION_MULT = 1.25;

  private readonly highlightGroup: THREE.Group;
  private readonly travelerMesh: THREE.Mesh;
  private readonly travelers: BeatTraveler[] = [];
  private trackVisualsActive = false;

  constructor(scene: THREE.Scene) {
    this.highlightGroup = new THREE.Group();
    this.highlightGroup.renderOrder = BeatFloorVisualizer.CELL_RENDER_ORDER;
    scene.add(this.highlightGroup);

    const geo = new THREE.PlaneGeometry(
      BeatFloorVisualizer.CELL_MESH_SIZE,
      BeatFloorVisualizer.CELL_MESH_SIZE,
    );
    const mat = new THREE.MeshBasicMaterial({
      color: MENU_BACKGROUND_COLOR,
      transparent: false,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.travelerMesh = new THREE.Mesh(geo, mat);
    this.travelerMesh.rotation.x = -Math.PI / 2;
    this.travelerMesh.renderOrder = BeatFloorVisualizer.CELL_RENDER_ORDER;
    this.travelerMesh.frustumCulled = false;
    this.travelerMesh.visible = false;
    this.highlightGroup.add(this.travelerMesh);
  }

  onTrackStarted(beatmap: Beatmap, audioTime: number): void {
    this.trackVisualsActive = true;
    this.travelers.length = 0;
    this.scheduleTravelers(beatmap.beats, audioTime);
    this.travelerMesh.visible = false;
  }

  onTrackEnded(): void {
    if (!this.trackVisualsActive) return;
    this.trackVisualsActive = false;
    this.travelers.length = 0;
    this.travelerMesh.visible = false;
  }

  update(
    _dt: number,
    audioTime: number,
    playerX: number,
    playerZ: number,
    trackPlaying: boolean,
  ): void {
    if (!this.trackVisualsActive || !trackPlaying) {
      this.travelerMesh.visible = false;
      return;
    }

    const cell = this.getTravelerCell(audioTime, playerX, playerZ);
    if (!cell) {
      this.travelerMesh.visible = false;
      return;
    }

    this.travelerMesh.position.set(
      (cell.cellX + 0.5) * ARENA_CHECKER_CELL_WORLD,
      BeatFloorVisualizer.CELL_Y,
      (cell.cellZ + 0.5) * ARENA_CHECKER_CELL_WORLD,
    );
    this.travelerMesh.visible = true;
  }

  private scheduleTravelers(beats: readonly BeatEvent[], fromTime: number): void {
    let prevTime = fromTime;
    for (let i = 0; i < beats.length; i++) {
      const hitTime = beats[i]!.time;
      if (hitTime <= fromTime + 0.02) {
        prevTime = hitTime;
        continue;
      }
      const gap = hitTime - prevTime;
      const durM = BeatFloorVisualizer.TRAVEL_DURATION_MULT;
      const approachDur = THREE.MathUtils.clamp(gap * 0.9 * durM, 0.4 * durM, 1.35 * durM);
      const departDur = THREE.MathUtils.clamp(gap * 0.45 * durM, 0.25 * durM, 0.7 * durM);
      this.travelers.push({
        hitTime,
        approachStart: hitTime - approachDur,
        departEnd: hitTime + departDur,
      });
      prevTime = hitTime;
    }
  }

  private getTravelerCell(
    audioTime: number,
    playerX: number,
    playerZ: number,
  ): { cellX: number; cellZ: number } | null {
    const traveler = this.findActiveTraveler(audioTime);
    if (!traveler) return null;

    const cell = ARENA_CHECKER_CELL_WORLD;
    const playerCellX = Math.floor(playerX / cell);
    const rowCellZ = Math.floor(playerZ / cell);
    const halfCells = Math.ceil(
      (CONFIG.cameraViewHalfExtent * BeatFloorVisualizer.TRAVEL_HALF_CELLS_MULT) /
        cell,
    );
    const startCellX = playerCellX + halfCells;
    const endCellX = playerCellX - halfCells;

    let cellX: number;
    if (audioTime <= traveler.hitTime) {
      const span = Math.max(1e-4, traveler.hitTime - traveler.approachStart);
      const u = THREE.MathUtils.clamp((audioTime - traveler.approachStart) / span, 0, 1);
      const eased = 1 - (1 - u) ** 2.1;
      cellX = Math.round(startCellX + (playerCellX - startCellX) * eased);
    } else {
      const span = Math.max(1e-4, traveler.departEnd - traveler.hitTime);
      const u = THREE.MathUtils.clamp((audioTime - traveler.hitTime) / span, 0, 1);
      const eased = 1 - (1 - u) ** 2;
      cellX = Math.round(playerCellX + (endCellX - playerCellX) * eased);
    }

    return { cellX, cellZ: rowCellZ };
  }

  private findActiveTraveler(audioTime: number): BeatTraveler | null {
    let best: BeatTraveler | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const t of this.travelers) {
      if (audioTime < t.approachStart || audioTime > t.departEnd) continue;
      const d = Math.abs(t.hitTime - audioTime);
      if (d < bestDist) {
        bestDist = d;
        best = t;
      }
    }
    return best;
  }
}
