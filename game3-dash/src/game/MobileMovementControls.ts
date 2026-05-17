import type { Input } from './Input.ts';
import { isMobileGameViewport } from './MobileViewport.ts';

type MoveDir = 'forward' | 'back' | 'left' | 'right';

const DIR_BUTTONS: { dir: MoveDir; label: string; className: string }[] = [
  { dir: 'forward', label: '↑', className: 'mobile-move-pad__btn--up' },
  { dir: 'left', label: '←', className: 'mobile-move-pad__btn--left' },
  { dir: 'right', label: '→', className: 'mobile-move-pad__btn--right' },
  { dir: 'back', label: '↓', className: 'mobile-move-pad__btn--down' },
];

/**
 * On-screen movement pad for touch viewports (bottom of screen).
 * Desktop mouse/keyboard builds do not mount this control.
 */
export class MobileMovementControls {
  private readonly root: HTMLDivElement;
  private input: Input | null = null;

  constructor(mount: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'mobile-move-controls';
    this.root.hidden = true;
    this.root.setAttribute('aria-label', 'Movement');
    if (!isMobileGameViewport()) {
      return;
    }

    const pad = document.createElement('div');
    pad.className = 'mobile-move-pad';
    for (const spec of DIR_BUTTONS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `mobile-move-pad__btn ${spec.className}`;
      btn.textContent = spec.label;
      btn.setAttribute('aria-label', spec.dir);
      this.bindDirectionButton(btn, spec.dir);
      pad.appendChild(btn);
    }
    this.root.appendChild(pad);
    mount.appendChild(this.root);
  }

  attach(input: Input): void {
    this.input = input;
  }

  setVisible(visible: boolean): void {
    if (!isMobileGameViewport()) return;
    this.root.hidden = !visible;
  }

  dispose(): void {
    this.root.remove();
    this.input = null;
  }

  private bindDirectionButton(btn: HTMLButtonElement, dir: MoveDir): void {
    const setActive = (active: boolean) => {
      this.input?.setVirtualMoveDir(dir, active);
    };
    const stop = (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.hasPointerCapture(e.pointerId)) {
        btn.releasePointerCapture(e.pointerId);
      }
      setActive(false);
    };
    const start = (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      btn.setPointerCapture(e.pointerId);
      setActive(true);
    };
    btn.addEventListener('pointerdown', start);
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointercancel', stop);
    btn.addEventListener('pointerleave', (e) => {
      if (btn.hasPointerCapture(e.pointerId)) return;
      setActive(false);
    });
    btn.addEventListener('lostpointercapture', () => setActive(false));
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}
