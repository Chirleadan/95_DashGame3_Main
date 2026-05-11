import './style.css';
import { Game } from './game/Game.ts';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) {
  throw new Error('#app missing');
}

const game = new Game(root);

window.addEventListener('beforeunload', () => {
  game.dispose();
});
