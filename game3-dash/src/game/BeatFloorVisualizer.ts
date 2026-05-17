import * as THREE from 'three';
import { CONFIG } from './config.ts';

/** World XZ size of one checker cell (matches arena floor texture repeat). */
export const ARENA_CHECKER_CELL_WORLD = 4;

const TRACK_FLOOR_TINT = new THREE.Color(0xffb8d8);
const FLOOR_COLOR_NORMAL = new THREE.Color(0xffffff);

type LitCell = { cellX: number; cellZ: number };

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

function createBeatCellHighlightTexture(subdivisions: number): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Beat cell highlight texture canvas unavailable');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);

  const step = size / subdivisions;
  ctx.strokeStyle = 'rgba(40, 40, 48, 0.55)';
  ctx.lineWidth = 1;
  for (let i = 1; i < subdivisions; i++) {
    const p = i * step;
    ctx.beginPath();
    ctx.moveTo(p + 0.5, 0);
    ctx.lineTo(p + 0.5, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, p + 0.5);
    ctx.lineTo(size, p + 0.5);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Track playback: pink floor tint + random white lit tiles (30% near hero per beat).
 * Shrinking beat rings are disabled for now.
 */
export class BeatFloorVisualizer {
  private static readonly CELL_MESH_SIZE = ARENA_CHECKER_CELL_WORLD * 0.96;
  private static readonly CELL_RENDER_ORDER = 1;
  private static readonly CELL_Y = CONFIG.floorY + 0.011;
  private static readonly CELL_OPACITY = 0.15;
  private static readonly CELL_SUBGRID_DIVISIONS = 4;
  /** Share of candidate floor cells lit on each beat. */
  private static readonly BEAT_LIT_TILE_FRACTION = 0.3;
  private static readonly VIEW_CELL_RADIUS_MULT = 2.25;

  private readonly floorMat: THREE.MeshStandardMaterial;
  private readonly highlightGroup: THREE.Group;
  private readonly cellHighlightMap: THREE.CanvasTexture;
  private readonly cellMeshPool: THREE.Mesh[] = [];
  private readonly activeCellMeshes: THREE.Mesh[] = [];
  private readonly cellGeo: THREE.PlaneGeometry;
  private readonly litCells: LitCell[] = [];
  private trackVisualsActive = false;

  constructor(scene: THREE.Scene, floorMat: THREE.MeshStandardMaterial) {
    this.floorMat = floorMat;
    this.highlightGroup = new THREE.Group();
    this.highlightGroup.renderOrder = BeatFloorVisualizer.CELL_RENDER_ORDER;
    scene.add(this.highlightGroup);
    this.cellGeo = new THREE.PlaneGeometry(
      BeatFloorVisualizer.CELL_MESH_SIZE,
      BeatFloorVisualizer.CELL_MESH_SIZE,
    );
    this.cellHighlightMap = createBeatCellHighlightTexture(
      BeatFloorVisualizer.CELL_SUBGRID_DIVISIONS,
    );
  }

  onTrackStarted(): void {
    this.trackVisualsActive = true;
    this.floorMat.color.copy(TRACK_FLOOR_TINT);
    this.litCells.length = 0;
    this.releaseHighlightCells();
  }

  onTrackEnded(): void {
    if (!this.trackVisualsActive) return;
    this.trackVisualsActive = false;
    this.litCells.length = 0;
    this.floorMat.color.copy(FLOOR_COLOR_NORMAL);
    this.releaseHighlightCells();
  }

  /** New random 30% tile highlights for this beat (held until the next beat). */
  onBeat(playerX: number, playerZ: number): void {
    if (!this.trackVisualsActive) return;
    this.litCells.length = 0;
    this.pickRandomLitCells(playerX, playerZ);
    this.rebuildLitCellMeshes();
  }

  update(_dt: number, _playerX: number, _playerZ: number): void {
    /* Lit tiles stay until the next beat; nothing to animate per frame. */
  }

  private pickRandomLitCells(playerX: number, playerZ: number): void {
    const cell = ARENA_CHECKER_CELL_WORLD;
    const playerCellX = Math.floor(playerX / cell);
    const playerCellZ = Math.floor(playerZ / cell);
    const range = Math.ceil(
      (CONFIG.cameraViewHalfExtent * BeatFloorVisualizer.VIEW_CELL_RADIUS_MULT) /
        cell,
    );

    const candidates: LitCell[] = [];
    for (let dz = -range; dz <= range; dz++) {
      for (let dx = -range; dx <= range; dx++) {
        candidates.push({ cellX: playerCellX + dx, cellZ: playerCellZ + dz });
      }
    }

    const want = Math.max(
      1,
      Math.floor(candidates.length * BeatFloorVisualizer.BEAT_LIT_TILE_FRACTION),
    );
    shuffleInPlace(candidates);
    for (let i = 0; i < want && i < candidates.length; i++) {
      this.litCells.push(candidates[i]!);
    }
  }

  private rebuildLitCellMeshes(): void {
    this.releaseHighlightCells();
    const cell = ARENA_CHECKER_CELL_WORLD;
    const y = BeatFloorVisualizer.CELL_Y;
    for (const { cellX, cellZ } of this.litCells) {
      const mesh = this.obtainCellMesh();
      mesh.position.set((cellX + 0.5) * cell, y, (cellZ + 0.5) * cell);
      const mat = mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = BeatFloorVisualizer.CELL_OPACITY;
      mesh.visible = true;
      this.highlightGroup.add(mesh);
      this.activeCellMeshes.push(mesh);
    }
  }

  private obtainCellMesh(): THREE.Mesh {
    const mesh = this.cellMeshPool.pop();
    if (mesh) return mesh;
    const mat = new THREE.MeshBasicMaterial({
      map: this.cellHighlightMap,
      color: 0xffffff,
      transparent: true,
      opacity: BeatFloorVisualizer.CELL_OPACITY,
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

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = t;
  }
}
