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
  private prevKeyPlayTrack = false;
  private keyPlayTrackEdge = false;

  constructor(
    keyboardTarget: HTMLElement = document.body,
    pointerTarget: HTMLElement,
  ) {
    const onDown = (e: KeyboardEvent) => {
      if (KEYS.has(e.code)) {
        e.preventDefault();
        this.down.add(e.code);
      }
    };
    const onUp = (e: KeyboardEvent) => {
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
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.button === 0 || e.pointerType === 'touch') {
        this.lastPointerClientX = e.clientX;
        this.lastPointerClientY = e.clientY;
        this.pointerDashEdge = true;
      }
    };
    pointerTarget.addEventListener('pointermove', onPointerMove);
    pointerTarget.addEventListener('pointerdown', onPointerDown);
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
  consumeDashTrigger(): boolean {
    const k = this.keyDashEdge;
    this.keyDashEdge = false;
    const p = this.pointerDashEdge;
    this.pointerDashEdge = false;
    return k || p;
  }

  /** True if `consumeDashTrigger()` would return true this frame (does not consume). */
  wouldDashTriggerThisFrame(): boolean {
    return this.keyDashEdge || this.pointerDashEdge;
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
