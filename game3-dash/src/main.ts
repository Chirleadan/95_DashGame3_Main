import './style.css';
import { LoadingScreen } from './game/LoadingScreen.ts';

async function bootstrap(mount: HTMLDivElement): Promise<void> {
  const loading = new LoadingScreen();
  loading.mount();

  const ok = await loading.run();
  loading.hide();

  if (!ok) {
    mount.innerHTML =
      '<p style="color:#ff6b9d;font-family:monospace;padding:2rem;text-align:center">Failed to load game assets. Check the console and refresh.</p>';
    return;
  }

  const { Game } = await import('./game/Game.ts');
  const game = new Game(mount);

  window.addEventListener('beforeunload', () => {
    game.dispose();
  });
}

const appRoot = document.querySelector<HTMLDivElement>('#app');
if (!appRoot) {
  throw new Error('#app missing');
}

void bootstrap(appRoot);
