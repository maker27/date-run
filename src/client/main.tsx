import { render } from 'preact';
import { App } from './app.js';
import { GameSession } from './application/game-session.js';

const root = document.getElementById('app');
if (!root) throw new Error('App mount element is missing');
const session = new GameSession();
window.addEventListener('pagehide', () => session.destroy(), { once: true });
render(<App session={session} />, root);
