import { CONFIG } from './config.ts';

/** Inclusive [min, max] integer. */
export function rollIntInclusive(min: number, max: number): number {
  const a = Math.ceil(min);
  const b = Math.floor(max);
  if (b < a) return a;
  return a + Math.floor(Math.random() * (b - a + 1));
}

/** Gold / mana sack drop on destruction (see `CONFIG.resourceSackDropMin` / `Max`). */
export function rollResourceSackDropAmount(): number {
  return rollIntInclusive(CONFIG.resourceSackDropMin, CONFIG.resourceSackDropMax);
}
