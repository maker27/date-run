import { Application, Container, Graphics, Sprite, Texture, Rectangle, Text } from 'pixi.js';
import { createThemeLoader, pixiTextureAssets, type LoadedTheme } from '../../src/client/themes/theme-loader.js';
import { PlayerVisual } from '../../src/client/game/player-visual.js';
import { ANIMATION_SPECS, type AnimationState } from '../../src/client/themes/theme-schema.js';
import metadata from './generated/first-date/manifest.json';
import atlasUrl from './generated/first-date/atlas-0.png?url';

const loader = createThemeLoader({
  catalog: { 'first-date': async () => ({ metadata, urls: { 'atlas-0': atlasUrl } }) },
  assets: pixiTextureAssets,
  mode: 'pilot',
});
const stageElement = document.querySelector<HTMLDivElement>('#stage');
const stateElement = document.querySelector<HTMLSelectElement>('#state');
const sizeElement = document.querySelector<HTMLSelectElement>('#size');
const playButton = document.querySelector<HTMLButtonElement>('#play');
const stepButton = document.querySelector<HTMLButtonElement>('#step');
const retryButton = document.querySelector<HTMLButtonElement>('#retry');
const status = document.querySelector<HTMLParagraphElement>('#status');
if (!stageElement || !stateElement || !sizeElement || !playButton || !stepButton || !retryButton || !status) throw new Error('Preview controls missing');
const stageHost = stageElement;
const animationChoice = stateElement;
const sizeChoice = sizeElement;
const playback = playButton;
const retry = retryButton;
const announcement = status;
const app = new Application();
let lease: LoadedTheme<Texture> | null = null;
let controller: AbortController | null = null;
let players: PlayerVisual[] = [];
let strips: Container[] = [];
let stripTextures: Texture[] = [];
let currentState: AnimationState = 'run';
let frame = 0;
let elapsed = 0;
let playing = !matchMedia('(prefers-reduced-motion: reduce)').matches;
let loading = false;

function text(message: string): void { announcement.textContent = message; }
function draw(): void {
  if (!lease) return;
  const size = Number(sizeChoice.value);
  players.forEach((player) => player.destroy());
  app.stage.removeChildren().forEach((child) => { if (!child.destroyed) child.destroy({ children: true, texture: false, textureSource: false }); });
  stripTextures.forEach((texture) => texture.destroy(false));
  stripTextures = [];
  players = [];
  strips = [];
  for (const [row, role] of (['a', 'b'] as const).entries()) {
    const ground = 175 + row * 190;
    const line = new Graphics().moveTo(20, ground).lineTo(1080, ground).stroke({ color: 0x44606e, width: 2 });
    app.stage.addChild(line);
    app.stage.addChild(new Text({ text: `Роль ${role.toUpperCase()}`, style: { fontSize: 15, fill: 0x172536 } })).position.set(20, ground - 145);
    const player = new PlayerVisual(lease, role, size);
    player.container.position.set(100, ground);
    player.setState(currentState);
    player.setFacing(role === 'b' ? -1 : 1);
    player.advance(frame * (1000 / ANIMATION_SPECS[currentState].fps));
    app.stage.addChild(player.container);
    players.push(player);
    const strip = new Container();
    strip.position.set(190, ground);
    const ids = lease.manifest.animations[role][currentState];
    if (!ids) throw new Error('Pilot sequence missing');
    ids.forEach((id, index) => {
      const rectangle = lease?.manifest.frames[id];
      const page = rectangle ? lease?.pages.get(rectangle.imageKey) : undefined;
      if (!rectangle || !page) throw new Error('Pilot frame missing');
      const sprite = new Sprite(new Texture({ source: page.source, frame: new Rectangle(rectangle.x, rectangle.y, 256, 256) }));
      stripTextures.push(sprite.texture);
      sprite.anchor.set(0.5, 0.88);
      sprite.scale.set(size / 190);
      sprite.position.x = index * (size + 8) + size / 2;
      strip.addChild(sprite);
      const label = new Text({ text: String(index), style: { fontSize: 13, fill: 0x172536 } });
      label.position.set(index * (size + 8) + size / 2 - 3, 8);
      strip.addChild(label);
    });
    app.stage.addChild(strip);
    strips.push(strip);
  }
  highlight();
}
function highlight(): void {
  for (const strip of strips) for (let index = 0; index < strip.children.length; index += 2) {
    const sprite = strip.children[index];
    if (sprite) sprite.alpha = index / 2 === frame ? 1 : 0.55;
  }
  text(`${currentState === 'run' ? 'Бег' : 'Ожидание'}: кадр ${frame + 1} из ${ANIMATION_SPECS[currentState].frameCount}. ${playing ? 'Воспроизведение.' : 'Пауза.'}`);
}
function nextFrame(): void {
  frame = (frame + 1) % ANIMATION_SPECS[currentState].frameCount;
  for (const player of players) player.advance(1000 / ANIMATION_SPECS[currentState].fps);
  highlight();
}
function setPlaying(value: boolean): void { playing = value; playback.textContent = value ? 'Пауза' : 'Воспроизвести'; if (lease) highlight(); }
async function start(): Promise<void> {
  if (loading) return;
  loading = true; retry.hidden = true; text('Загрузка пилотного атласа…');
  controller?.abort(); controller = new AbortController();
  try {
    if (!app.renderer) {
      await app.init({ width: 1100, height: 400, backgroundColor: 0xfffdf6, autoStart: false, sharedTicker: false, preference: 'webgl' });
      stageHost.appendChild(app.canvas);
      app.ticker.add((ticker) => {
        if (!playing || !lease) return;
        elapsed += ticker.deltaMS;
        const interval = 1000 / ANIMATION_SPECS[currentState].fps;
        while (elapsed >= interval) { elapsed -= interval; nextFrame(); }
      });
      app.start();
    }
    lease = await loader('first-date', controller.signal);
    draw(); setPlaying(playing);
  } catch (error) {
    text(navigator.onLine ? 'Не удалось загрузить пилотный атлас.' : 'Нет подключения. Проверьте сеть.');
    retry.hidden = false;
    if (error instanceof Error) console.error('Preview initialization failed');
  } finally { loading = false; }
}
stateElement.addEventListener('change', () => { currentState = animationChoice.value === 'idle' ? 'idle' : 'run'; frame = 0; elapsed = 0; draw(); });
sizeElement.addEventListener('change', draw);
playButton.addEventListener('click', () => setPlaying(!playing));
stepButton.addEventListener('click', () => { setPlaying(false); nextFrame(); });
retryButton.addEventListener('click', () => { void start(); });
window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLElement && ['SELECT', 'BUTTON'].includes(event.target.tagName)) return;
  if (event.code === 'Space') { event.preventDefault(); setPlaying(!playing); }
  if (event.code === 'ArrowRight') { event.preventDefault(); setPlaying(false); nextFrame(); }
});
window.addEventListener('beforeunload', () => { controller?.abort(); players.forEach((player) => player.destroy()); stripTextures.forEach((texture) => texture.destroy(false)); lease?.release(); app.destroy(true, { children: true }); });
window.addEventListener('online', () => { if (retry.hidden) return; void start(); });
void start();
