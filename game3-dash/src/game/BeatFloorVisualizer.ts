import * as THREE from 'three';
import { CONFIG } from './config.ts';
import type { BeatEvent, Beatmap } from './Beatmap.ts';

/** World XZ size of one checker cell (matches arena floor texture repeat). */
export const ARENA_CHECKER_CELL_WORLD = 4;

/** Main-menu backdrop (`style.css`). */
const MENU_BACKGROUND_COLOR = 0xff25b6;

type SpawnDir = 'right' | 'left' | 'top' | 'bottom';

const SPAWN_DIRS: readonly SpawnDir[] = ['right', 'left', 'top', 'bottom'];

type BeatTraveler = {
  hitTime: number;
  approachStart: number;
  departEnd: number;
  spawnFar: boolean;
  spawnDirection: SpawnDir;
  /** Beat aim on travel axis, locked at launch. */
  hitCellX?: number;
  hitCellZ?: number;
  /** Row (horizontal fly) or column (vertical fly) frozen after passing the hero. */
  frozenLaneX?: number;
  frozenLaneZ?: number;
};

function isHorizontalFlight(dir: SpawnDir): boolean {
  return dir === 'right' || dir === 'left';
}

function pickRandomSpawnDir(): SpawnDir {
  return SPAWN_DIRS[Math.floor(Math.random() * SPAWN_DIRS.length)]!;
}

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
 * Menu-pink tile per beat: flies in from a random screen edge, crosses the hero on the beat,
 * then exits. Row/column follows the hero until 150 ms before the beat, then stays fixed.
 */
export class BeatFloorVisualizer {
  private static readonly CELL_MESH_SIZE = ARENA_CHECKER_CELL_WORLD * 0.96;
  private static readonly CELL_RENDER_ORDER = 1;
  private static readonly CELL_Y = CONFIG.floorY + 0.011;
  private static readonly TRAVEL_HALF_CELLS_MULT_FAR = 6.75;
  private static readonly TRAVEL_HALF_CELLS_MULT_CLOSE = 2.35;
  private static readonly TRAVEL_DURATION_MULT = 2;
  /** Perpendicular row/column locks this many seconds before the beat. */
  private static readonly LANE_FREEZE_BEFORE_HIT_SEC = 0.15;

  private readonly highlightGroup: THREE.Group;
  private readonly cellGeo: THREE.PlaneGeometry;
  private readonly cellMeshPool: THREE.Mesh[] = [];
  private readonly activeMeshes: THREE.Mesh[] = [];
  private readonly travelers: BeatTraveler[] = [];
  private trackVisualsActive = false;

  constructor(scene: THREE.Scene) {
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
    this.travelers.length = 0;
    this.scheduleTravelers(beatmap.beats, audioTime);
    this.releaseMeshes();
  }

  onTrackEnded(): void {
    if (!this.trackVisualsActive) return;
    this.trackVisualsActive = false;
    this.travelers.length = 0;
    this.releaseMeshes();
  }

  update(
    _dt: number,
    audioTime: number,
    playerX: number,
    playerZ: number,
    trackPlaying: boolean,
  ): void {
    if (!this.trackVisualsActive || !trackPlaying) {
      this.releaseMeshes();
      return;
    }

    const positions = this.getActiveTravelerCells(audioTime, playerX, playerZ);
    this.syncMeshes(positions);
  }

  private scheduleTravelers(beats: readonly BeatEvent[], fromTime: number): void {
    let prevTime = fromTime;
    let firstScheduled = true;
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
        spawnFar: firstScheduled,
        spawnDirection: pickRandomSpawnDir(),
      });
      firstScheduled = false;
      prevTime = hitTime;
    }
  }

  private getActiveTravelerCells(
    audioTime: number,
    playerX: number,
    playerZ: number,
  ): { cellX: number; cellZ: number }[] {
    const out: { cellX: number; cellZ: number }[] = [];
    const cell = ARENA_CHECKER_CELL_WORLD;
    const playerCellX = Math.floor(playerX / cell);
    const playerCellZ = Math.floor(playerZ / cell);

    for (const traveler of this.travelers) {
      if (audioTime > traveler.departEnd) continue;

      const horizontal = isHorizontalFlight(traveler.spawnDirection);

      if (audioTime < traveler.approachStart) {
        if (horizontal) traveler.hitCellX = playerCellX;
        else traveler.hitCellZ = playerCellZ;
        continue;
      }

      if (horizontal) {
        if (traveler.hitCellX === undefined) traveler.hitCellX = playerCellX;
      } else if (traveler.hitCellZ === undefined) {
        traveler.hitCellZ = playerCellZ;
      }

      const mult = traveler.spawnFar
        ? BeatFloorVisualizer.TRAVEL_HALF_CELLS_MULT_FAR
        : BeatFloorVisualizer.TRAVEL_HALF_CELLS_MULT_CLOSE;
      const halfCells = Math.ceil((CONFIG.cameraViewHalfExtent * mult) / cell);

      let cellX: number;
      let cellZ: number;

      if (horizontal) {
        const hitCellX = traveler.hitCellX!;
        cellX = this.travelCoordAlongAxis(
          audioTime,
          traveler,
          hitCellX,
          halfCells,
          traveler.spawnDirection === 'right',
        );
        cellZ = this.laneCoordUntilHitThenFreeze(
          audioTime,
          traveler,
          playerCellZ,
          'z',
        );
      } else {
        const hitCellZ = traveler.hitCellZ!;
        cellZ = this.travelCoordAlongAxis(
          audioTime,
          traveler,
          hitCellZ,
          halfCells,
          traveler.spawnDirection === 'top',
        );
        cellX = this.laneCoordUntilHitThenFreeze(
          audioTime,
          traveler,
          playerCellX,
          'x',
        );
      }

      out.push({ cellX: Math.round(cellX), cellZ: Math.round(cellZ) });
    }
    return out;
  }

  /** Position along travel axis (approach → hit → depart). */
  private travelCoordAlongAxis(
    audioTime: number,
    traveler: BeatTraveler,
    hitCoord: number,
    halfCells: number,
    fromPositiveSide: boolean,
  ): number {
    const start = fromPositiveSide ? hitCoord + halfCells : hitCoord - halfCells;
    const end = fromPositiveSide ? hitCoord - halfCells : hitCoord + halfCells;

    if (audioTime <= traveler.hitTime) {
      const span = Math.max(1e-4, traveler.hitTime - traveler.approachStart);
      const u = THREE.MathUtils.clamp((audioTime - traveler.approachStart) / span, 0, 1);
      const eased = u ** 2.2;
      return start + (hitCoord - start) * eased;
    }

    const span = Math.max(1e-4, traveler.departEnd - traveler.hitTime);
    const u = THREE.MathUtils.clamp((audioTime - traveler.hitTime) / span, 0, 1);
    const eased = u ** 2;
    return hitCoord + (end - hitCoord) * eased;
  }

  /** Perpendicular lane: follows hero until 150 ms before the beat, then frozen. */
  private laneCoordUntilHitThenFreeze(
    audioTime: number,
    traveler: BeatTraveler,
    playerLane: number,
    axis: 'x' | 'z',
  ): number {
    const freezeAt =
      traveler.hitTime - BeatFloorVisualizer.LANE_FREEZE_BEFORE_HIT_SEC;
    if (audioTime < freezeAt) {
      return playerLane;
    }
    if (axis === 'x') {
      if (traveler.frozenLaneX === undefined) traveler.frozenLaneX = playerLane;
      return traveler.frozenLaneX;
    }
    if (traveler.frozenLaneZ === undefined) traveler.frozenLaneZ = playerLane;
    return traveler.frozenLaneZ;
  }

  private syncMeshes(positions: { cellX: number; cellZ: number }[]): void {
    this.releaseMeshes();
    const cell = ARENA_CHECKER_CELL_WORLD;
    const y = BeatFloorVisualizer.CELL_Y;
    for (const { cellX, cellZ } of positions) {
      const mesh = this.obtainMesh();
      mesh.position.set((cellX + 0.5) * cell, y, (cellZ + 0.5) * cell);
      mesh.visible = true;
      this.highlightGroup.add(mesh);
      this.activeMeshes.push(mesh);
    }
  }

  private obtainMesh(): THREE.Mesh {
    const mesh = this.cellMeshPool.pop();
    if (mesh) return mesh;
    const mat = new THREE.MeshBasicMaterial({
      color: MENU_BACKGROUND_COLOR,
      transparent: false,
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

  private releaseMeshes(): void {
    for (const mesh of this.activeMeshes) {
      mesh.visible = false;
      this.highlightGroup.remove(mesh);
      this.cellMeshPool.push(mesh);
    }
    this.activeMeshes.length = 0;
  }
}
