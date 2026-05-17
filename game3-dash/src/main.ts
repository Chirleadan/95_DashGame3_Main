import './style.css';
import { LoadingScreen } from './game/LoadingScreen.ts';

function dismissBootSplash(): void {
  document.getElementById('boot-splash')?.remove();
}

function waitFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (left: number) => {
      if (left <= 0) {
        resolve();
        return;
      }
      requestAnimationFrame(() => step(left - 1));
    };
    step(count);
  });
}

async function bootstrap(mount: HTMLDivElement): Promise<void> {
  document.body.classList.add('game-booting');
  mount.classList.add('app--booting');

  const loading = new LoadingScreen();
  loading.mount();
  await waitFrames(1);
  dismissBootSplash();

  const gameModulePromise = import('./game/Game.ts');
  const ok = await loading.run();

  if (!ok) {
    mount.classList.remove('app--booting');
    document.body.classList.remove('game-booting');
    loading.hide();
    mount.innerHTML =
      '<p style="color:#ff6b9d;font-family:monospace;padding:2rem;text-align:center">Failed to load game assets. Check the console and refresh.</p>';
    return;
  }

  const { Game } = await gameModulePromise;
  const game = new Game(mount);
  await game.whenReadyForDisplay();
  await waitFrames(1);
  mount.classList.remove('app--booting');
  document.body.classList.remove('game-booting');
  loading.hide();
  game.showMainMenu();

  window.addEventListener('beforeunload', () => {
    game.dispose();
  });
}

const appRoot = document.querySelector<HTMLDivElement>('#app');
if (!appRoot) {
  throw new Error('#app missing');
}

void bootstrap(appRoot);
