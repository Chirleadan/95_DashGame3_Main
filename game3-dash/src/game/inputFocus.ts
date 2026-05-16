/** True when focus is in a field where gameplay keys must not be captured. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return Boolean(
    target.closest('input, textarea, select, [contenteditable="true"]'),
  );
}

export function isNicknameModalOpen(): boolean {
  const modal = document.getElementById('nickname-modal');
  return modal !== null && !modal.hidden;
}

/** Skip global gameplay key handling (movement, dash, E, Escape). */
export function shouldIgnoreGameplayInput(event: KeyboardEvent): boolean {
  if (isTypingTarget(event.target)) return true;
  if (isTypingTarget(document.activeElement)) return true;
  if (isNicknameModalOpen()) return true;
  return false;
}
