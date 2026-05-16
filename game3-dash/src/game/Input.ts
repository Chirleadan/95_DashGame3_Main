import { shouldIgnoreGameplayInput } from './inputFocus.ts';

const KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyE',
  'Space',
  'ShiftLeft',
  'ShiftRight',
]);

export class Input {
  private readonly down = new Set<string>();

  lastPointerClientX = 0;
  lastPointerClientY = 0;

  private prevKeyDash = false;
  private keyDashEdge = false;
  private pointerDashEdge = false;
  private pointerDown = false;
  private pointerDragPoints: { x: number; y: number }[] = [];
  private pointerDragReleasePoints: { x: number; y: number }[] | null = null;
  private pointerDragReleaseDurationSec = 0;
  private pointerDragStartMs = 0;
  private prevKeyPlayTrack = false;
  private keyPlayTrackEdge = false;
  private prevKeyEscape = false;
  private keyEscapeEdge = false;
  private wheelZoomDelta = 0;

  constructor(
    keyboardTarget: HTMLElement = document.body,
    pointerTarget: HTMLElement,
  ) {
    const onDown = (e: KeyboardEvent) => {
      if (shouldIgnoreGameplayInput(e)) return;
      if (e.code === 'Escape') {
        e.preventDefault();
        this.down.add('Escape');
        return;
      }
      if (KEYS.has(e.code)) {
        e.preventDefault();
        this.down.add(e.code);
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (shouldIgnoreGameplayInput(e)) return;
      if (e.code === 'Escape') {
        e.preventDefault();
        this.down.delete('Escape');
        return;
      }
      if (KEYS.has(e.code)) {
        e.preventDefault();
        this.down.delete(e.code);
      }
    };
    keyboardTarget.addEventListener('keydown', onDown);
    keyboardTarget.addEventListener('keyup', onUp);
    window.addEventListener('blur', () => this.down.clear());

    const onPointerMove = (e: PointerEvent) => {
      this.lastPointerClientX = e.clientX;
      this.lastPointerClientY = e.clientY;
      if (this.pointerDown) {
        const last = this.pointerDragPoints.at(-1);
        if (!last || Math.hypot(e.clientX - last.x, e.clientY - last.y) >= 8) {
          this.pointerDragPoints.push({ x: e.clientX, y: e.clientY });
        }
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.button === 0 || e.pointerType === 'touch') {
        this.lastPointerClientX = e.clientX;
        this.lastPointerClientY = e.clientY;
        this.pointerDashEdge = true;
        this.pointerDown = true;
        this.pointerDragStartMs = performance.now();
        this.pointerDragPoints = [{ x: e.clientX, y: e.clientY }];
        pointerTarget.setPointerCapture?.(e.pointerId);
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!this.pointerDown) return;
      this.lastPointerClientX = e.clientX;
      this.lastPointerClientY = e.clientY;
      this.pointerDown = false;
      this.pointerDragPoints.push({ x: e.clientX, y: e.clientY });
      this.pointerDragReleasePoints = this.pointerDragPoints;
      this.pointerDragReleaseDurationSec = Math.max(
        0,
        (performance.now() - this.pointerDragStartMs) / 1000,
      );
      this.pointerDragPoints = [];
      pointerTarget.releasePointerCapture?.(e.pointerId);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      this.wheelZoomDelta += e.deltaY;
    };
    pointerTarget.addEventListener('pointermove', onPointerMove);
    pointerTarget.addEventListener('pointerdown', onPointerDown);
    pointerTarget.addEventListener('pointerup', onPointerUp);
    pointerTarget.addEventListener('pointercancel', onPointerUp);
    pointerTarget.addEventListener('wheel', onWheel, { passive: false });
  }

  centerPointerOn(domElement: HTMLElement): void {
    const r = domElement.getBoundingClientRect();
    this.lastPointerClientX = r.left + r.width * 0.5;
    this.lastPointerClientY = r.top + r.height * 0.5;
  }

  /** Call once per frame before reading dash / aim. */
  beginFrame(): void {
    const kd = this.keysDashDown();
    this.keyDashEdge = kd && !this.prevKeyDash;
    this.prevKeyDash = kd;

    const pe = this.down.has('KeyE');
    this.keyPlayTrackEdge = pe && !this.prevKeyPlayTrack;
    this.prevKeyPlayTrack = pe;

    const esc = this.down.has('Escape');
    this.keyEscapeEdge = esc && !this.prevKeyEscape;
    this.prevKeyEscape = esc;
  }

  /** Escape key edge this frame (consumed once). */
  consumeEscapeTrigger(): boolean {
    const v = this.keyEscapeEdge;
    this.keyEscapeEdge = false;
    return v;
  }

  /** Key `E` edge this frame (consumed once). */
  consumePlayTrackTrigger(): boolean {
    const v = this.keyPlayTrackEdge;
    this.keyPlayTrackEdge = false;
    return v;
  }

  /** True if `consumePlayTrackTrigger()` would return true (does not consume). */
  wouldPlayTrackTriggerThisFrame(): boolean {
    return this.keyPlayTrackEdge;
  }

  /** Space/Shift edge or primary pointer down this frame (consumed once). */
  consumeDashTrigger(includePointer = true): boolean {
    const k = this.keyDashEdge;
    this.keyDashEdge = false;
    const p = includePointer ? this.pointerDashEdge : false;
    if (includePointer) this.pointerDashEdge = false;
    return k || p;
  }

  consumePointerDashTrigger(): boolean {
    const p = this.pointerDashEdge;
    this.pointerDashEdge = false;
    return p;
  }

  consumePointerDragRelease(): {
    points: { x: number; y: number }[];
    durationSec: number;
  } | null {
    const points = this.pointerDragReleasePoints;
    if (!points) return null;
    const durationSec = this.pointerDragReleaseDurationSec;
    this.pointerDragReleasePoints = null;
    this.pointerDragReleaseDurationSec = 0;
    return { points, durationSec };
  }

  getPointerDragPoints(): readonly { x: number; y: number }[] {
    return this.pointerDragPoints;
  }

  /** True if `consumeDashTrigger()` would return true this frame (does not consume). */
  wouldDashTriggerThisFrame(): boolean {
    return this.keyDashEdge || this.pointerDashEdge;
  }

  /** Accumulated mouse-wheel delta for camera zoom (consumed once per frame). */
  consumeWheelZoomDelta(): number {
    const d = this.wheelZoomDelta;
    this.wheelZoomDelta = 0;
    return d;
  }

  private keysDashDown(): boolean {
    return (
      this.down.has('Space') ||
      this.down.has('ShiftLeft') ||
      this.down.has('ShiftRight')
    );
  }

  get forward(): boolean {
    return this.down.has('KeyW');
  }
  get back(): boolean {
    return this.down.has('KeyS');
  }
  get left(): boolean {
    return this.down.has('KeyA');
  }
  get right(): boolean {
    return this.down.has('KeyD');
  }

  /** Movement intent in world XZ; not normalized. */
  movementVector(): { x: number; z: number } {
    let x = 0;
    let z = 0;
    if (this.forward) z -= 1;
    if (this.back) z += 1;
    if (this.left) x -= 1;
    if (this.right) x += 1;
    return { x, z };
  }
}
