import './style.css';
import { LoadingScreen } from './game/LoadingScreen.ts';

function dismissBootSplash(): void {
  document.getElementById('boot-splash')?.remove();
}

async function bootstrap(mount: HTMLDivElement): Promise<void> {
  mount.classList.add('app--booting');

  const loading = new LoadingScreen();
  loading.mount();
  dismissBootSplash();

  const gameModulePromise = import('./game/Game.ts');
  const ok = await loading.run();

  if (!ok) {
    mount.classList.remove('app--booting');
    loading.hide();
    mount.innerHTML =
      '<p style="color:#ff6b9d;font-family:monospace;padding:2rem;text-align:center">Failed to load game assets. Check the console and refresh.</p>';
    return;
  }

  const { Game } = await gameModulePromise;
  const game = new Game(mount);
  await game.whenReadyForDisplay();
  mount.classList.remove('app--booting');
  loading.hide();

  window.addEventListener('beforeunload', () => {
    game.dispose();
  });
}

const appRoot = document.querySelector<HTMLDivElement>('#app');
if (!appRoot) {
  throw new Error('#app missing');
}

void bootstrap(appRoot);
