import type { Input } from './Input.ts';
import { isMobileGameViewport } from './MobileViewport.ts';

/** Outer ring radius (px); thumb travels within this. */
const JOYSTICK_RADIUS_PX = 64;
const JOYSTICK_SIZE_PX = JOYSTICK_RADIUS_PX * 2 + 24;

/**
 * Circular virtual joystick for touch viewports (bottom of screen).
 * Desktop mouse/keyboard builds do not mount this control.
 */
export class MobileMovementControls {
  private readonly root: HTMLDivElement;
  private readonly base: HTMLDivElement;
  private readonly thumb: HTMLDivElement;
  private input: Input | null = null;
  private activePointerId: number | null = null;

  constructor(mount: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'mobile-move-controls';
    this.root.hidden = true;
    this.root.setAttribute('aria-label', 'Movement joystick');

    this.base = document.createElement('div');
    this.base.className = 'mobile-joystick';
    this.base.style.width = `${JOYSTICK_SIZE_PX}px`;
    this.base.style.height = `${JOYSTICK_SIZE_PX}px`;

    this.thumb = document.createElement('div');
    this.thumb.className = 'mobile-joystick__thumb';
    this.base.appendChild(this.thumb);
    this.root.appendChild(this.base);

    if (!isMobileGameViewport()) {
      return;
    }

    this.bindJoystick();
    mount.appendChild(this.root);
  }

  attach(input: Input): void {
    this.input = input;
  }

  setVisible(visible: boolean): void {
    if (!isMobileGameViewport()) return;
    this.root.hidden = !visible;
    if (!visible) {
      this.resetJoystick();
    }
  }

  dispose(): void {
    this.resetJoystick();
    this.root.remove();
    this.input = null;
  }

  private bindJoystick(): void {
    this.base.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.base.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.base.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.base.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    this.base.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private onPointerDown(e: PointerEvent): void {
    if (this.activePointerId !== null) return;
    e.preventDefault();
    e.stopPropagation();
    this.activePointerId = e.pointerId;
    this.base.setPointerCapture(e.pointerId);
    this.updateFromPointer(e);
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.activePointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    this.updateFromPointer(e);
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.activePointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    if (this.base.hasPointerCapture(e.pointerId)) {
      this.base.releasePointerCapture(e.pointerId);
    }
    this.resetJoystick();
  }

  private updateFromPointer(e: PointerEvent): void {
    const rect = this.base.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = e.clientX - cx;
    let dy = e.clientY - cy;
    const len = Math.hypot(dx, dy);
    if (len > JOYSTICK_RADIUS_PX) {
      const s = JOYSTICK_RADIUS_PX / len;
      dx *= s;
      dy *= s;
    }
    this.thumb.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    this.input?.setVirtualMoveVector(dx / JOYSTICK_RADIUS_PX, dy / JOYSTICK_RADIUS_PX);
  }

  private resetJoystick(): void {
    this.activePointerId = null;
    this.thumb.style.transform = 'translate(-50%, -50%)';
    this.input?.clearVirtualMove();
  }
}
