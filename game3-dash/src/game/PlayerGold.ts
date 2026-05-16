import { CONFIG } from './config.ts';

const STORAGE_KEY = 'game3-dash-player-gold';

let walletGold = 0;

export function loadPlayerGold(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      walletGold = 0;
      return;
    }
    const n = Math.floor(Number(JSON.parse(raw)));
    walletGold = Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    walletGold = 0;
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(walletGold));
  } catch {
    /* ignore quota */
  }
}

export function getPlayerGold(): number {
  return walletGold;
}

export function addPlayerGold(amount: number): void {
  const n = Math.floor(amount);
  if (!Number.isFinite(n) || n <= 0) return;
  walletGold += n;
  persist();
}

/** Returns `false` if the wallet does not have enough gold. */
export function trySpendPlayerGold(amount: number = CONFIG.upgradeGoldCost): boolean {
  const cost = Math.max(0, Math.floor(amount));
  if (cost <= 0) return true;
  if (walletGold < cost) return false;
  walletGold -= cost;
  persist();
  return true;
}
