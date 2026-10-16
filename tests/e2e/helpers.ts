import { expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { WorldSnapshotSchema, type Role, type ThemeId, type WorldSnapshot } from '../../src/shared/model.js';
import type { ServerMessage } from '../../src/shared/protocol.js';
import { DECELERATION, MOVE_SPEED } from '../../src/shared/simulation-config.js';
import { SHORT_LEVEL } from '../fixtures/short-level.js';

type InteractionOutcome = Extract<ServerMessage, { type: 'world:interact:result' }>['outcome'];

declare global {
  interface Window {
    __dateRunTest: {
      snapshot(): WorldSnapshot | null;
      connectionId(): string;
      dropNext(type: 'room:complete' | 'world:update' | 'room:state'): void;
      setVisibility(state: DocumentVisibilityState): void;
      setStorageFailure(value: boolean): void;
      attemptInteraction(objectId: string): Promise<InteractionOutcome>;
      lastResyncedInputGeneration(): number | null;
    };
  }
}

const themes: Record<ThemeId, string> = {
  'first-date': 'Первое свидание',
  retro: 'Ретро',
  winter: 'Зимнее свидание',
};

type Expected404 = { active: boolean; confirmed: boolean };
type BrowserIssue =
  | { kind: 'console'; type: string; text: string; location: string; expected404?: Expected404 }
  | { kind: 'pageerror'; name: string; message: string };

const expected404ByPage = new WeakMap<Page, Map<string, Expected404>>();

function safeLocation(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.replace(/[?#].*$/, '');
  }
}

function safeMessage(value: string): string {
  return value
    .replace(/https?:\/\/[^\s'"`]+/g, safeLocation)
    .replace(/(sessionToken|session_token|credential|authorization|token|secret)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[redacted]');
}

export function watchBrowserIssues(page: Page): () => void {
  const issues: BrowserIssue[] = [];
  const expected404 = new Map<string, Expected404>();
  expected404ByPage.set(page, expected404);
  page.on('console', (message) => {
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    const location = safeLocation(message.location().url);
    const allowance = expected404.get(location);
    issues.push({
      kind: 'console',
      type: message.type(),
      text: safeMessage(message.text()),
      location,
      ...(allowance?.active ? { expected404: allowance } : {}),
    });
  });
  page.on('pageerror', (error) => issues.push({ kind: 'pageerror', name: safeMessage(error.name), message: safeMessage(error.message) }));
  page.on('response', (response) => {
    const responseUrl = new URL(response.url());
    const expected = expected404.get(`${responseUrl.origin}${responseUrl.pathname}`);
    if (expected?.active && response.request().method() === 'GET' && response.status() === 404) expected.confirmed = true;
  });
  return () => {
    const consumed = new Set<Expected404>();
    const remaining = issues.filter((issue) => {
      if (issue.kind !== 'console' || issue.type !== 'error' ||
        issue.text !== 'Failed to load resource: the server responded with a status of 404 (Not Found)' ||
        !issue.expected404?.confirmed || consumed.has(issue.expected404)) return true;
      consumed.add(issue.expected404);
      return false;
    });
    expect(remaining).toEqual([]);
  };
}

export function allowExpected404(page: Page, url: string): () => void {
  const expected = expected404ByPage.get(page);
  if (!expected) throw new Error('Browser issue watcher is not registered for this page');
  const parsed = new URL(url);
  const exactUrl = `${parsed.origin}${parsed.pathname}`;
  if (parsed.search || parsed.hash) throw new Error('Expected 404 URL must identify only an exact origin and path');
  const entry: Expected404 = { active: true, confirmed: false };
  expected.set(exactUrl, entry);
  return () => { entry.active = false; };
}

export async function controlGet<T>(request: APIRequestContext, path: string, parse: (value: unknown) => T): Promise<T> {
  const response = await request.get(`http://127.0.0.1:4174${path}`);
  expect(response.status()).toBe(200);
  const value: unknown = await response.json();
  return parse(value);
}

export async function controlPost<T>(request: APIRequestContext, path: string, data: object, parse: (value: unknown) => T): Promise<T> {
  const response = await request.post(`http://127.0.0.1:4174${path}`, { data });
  expect(response.status()).toBe(200);
  const value: unknown = await response.json();
  return parse(value);
}

export async function readSnapshot(request: APIRequestContext, roomId: string): Promise<WorldSnapshot> {
  return controlGet(request, `/snapshot?room=${encodeURIComponent(roomId)}`, (value) => WorldSnapshotSchema.parse(value));
}

export async function waitForSnapshot(
  request: APIRequestContext,
  roomId: string,
  predicate: (snapshot: WorldSnapshot) => boolean,
  timeout = 10_000,
): Promise<WorldSnapshot> {
  await expect.poll(async () => predicate(await readSnapshot(request, roomId)), { timeout }).toBe(true);
  return readSnapshot(request, roomId);
}

export async function createRoom(page: Page, theme: ThemeId, role: Role): Promise<string> {
  await page.getByRole('radio', { name: themes[theme] }).check();
  await page.getByRole('radio', { name: role === 'a' ? 'Слева' : 'Справа' }).check();
  await page.getByRole('button', { name: 'Создать комнату' }).click();
  const heading = page.getByRole('heading', { name: /^Комната [A-Z2-9]{8}$/ });
  await expect(heading).toBeVisible();
  const text = await heading.innerText();
  return text.slice('Комната '.length);
}

export async function joinRoom(page: Page, roomId: string): Promise<void> {
  const base = new URL('/date-run/', page.url());
  base.searchParams.set('room', roomId);
  await page.goto(base.href);
  await expect(page.getByRole('status').filter({ hasText: `Комната найдена:` })).toBeVisible();
  await page.getByRole('button', { name: 'Войти в комнату' }).click();
  await expect(page.getByRole('heading', { name: `Комната ${roomId}` })).toBeVisible();
}

export async function waitForSceneReady(page: Page): Promise<void> {
  const ready = page.getByRole('button', { name: 'Готов' });
  await expect(ready).toBeEnabled();
}

export async function startRound(host: Page, guest: Page, request: APIRequestContext, roomId: string): Promise<void> {
  await Promise.all([waitForSceneReady(host), waitForSceneReady(guest)]);
  await Promise.all([
    host.getByRole('button', { name: 'Готов' }).click(),
    guest.getByRole('button', { name: 'Готов' }).click(),
  ]);
  await waitForSnapshot(request, roomId, (snapshot) => snapshot.state.phase === 'playing');
  await expect(host.getByRole('heading', { name: 'Бегите навстречу!' })).toBeVisible();
  await expect(guest.getByRole('heading', { name: 'Бегите навстречу!' })).toBeVisible();
}

export async function playerForRole(snapshot: WorldSnapshot, role: Role) {
  const player = snapshot.state.players.find((candidate) => candidate.role === role);
  expect(player).toBeDefined();
  if (!player) throw new Error(`Player ${role} missing from authoritative snapshot`);
  return player;
}

export async function collectOwnGift(page: Page, request: APIRequestContext, roomId: string, role: Role): Promise<void> {
  const initial = await readSnapshot(request, roomId);
  const player = await playerForRole(initial, role);
  const gift = initial.state.gifts.find((candidate) => candidate.ownerRole === role);
  const giftDefinition = SHORT_LEVEL.gifts.find((candidate) => candidate.ownerRole === role);
  expect(gift).toBeDefined();
  expect(giftDefinition).toBeDefined();
  if (!gift || !giftDefinition) throw new Error(`Gift ${role} missing from the level or authoritative snapshot`);
  const direction = role === 'a' ? 'ArrowRight' : 'ArrowLeft';
  await page.keyboard.down(direction);
  try {
    await expect.poll(async () => {
      const snapshot = await readSnapshot(request, roomId);
      const current = snapshot.state.players.find(({ id }) => id === player.id);
      return current ? Math.hypot(current.body.x + 16 - giftDefinition.position.x, current.body.y + 24 - giftDefinition.position.y) <= 40 : false;
    }, { timeout: 10_000, intervals: [16, 20, 24] }).toBe(true);
  } finally {
    await page.keyboard.up(direction);
  }
  await page.keyboard.press('e');
  await waitForSnapshot(request, roomId, (snapshot) => snapshot.state.gifts.some(({ id, collectedBy }) => id === gift.id && collectedBy === player.id));
  await expect(page.getByRole('region', { name: 'Статус игры' })).toContainText('Ваш подарок собран');
}

export async function occupySwitch(page: Page, request: APIRequestContext, roomId: string, role: Role): Promise<void> {
  const initial = await readSnapshot(request, roomId);
  const player = await playerForRole(initial, role);
  const switchState = initial.state.switches[role === 'a' ? 0 : 1];
  expect(switchState).toBeDefined();
  if (!switchState) throw new Error(`Switch for ${role} missing from authoritative snapshot`);
  const switchDefinition = SHORT_LEVEL.switches.find(({ id }) => id === switchState.id);
  expect(switchDefinition).toBeDefined();
  if (!switchDefinition) throw new Error(`Switch ${switchState.id} is missing from the level`);
  const targetX = switchDefinition.bounds.x + switchDefinition.bounds.width / 2 - 16;
  const brakingDistance = MOVE_SPEED * MOVE_SPEED / (2 * DECELERATION);
  await expect.poll(async () => {
    const snapshot = await readSnapshot(request, roomId);
    const current = await playerForRole(snapshot, role);
    if (current.body.vx === 0 && snapshot.state.switches.some(({ id, occupant }) =>
      id === switchState.id && occupant === player.id)) return true;
    const axis = current.body.x < targetX ? 1 : -1;
    const direction = axis === 1 ? 'ArrowRight' : 'ArrowLeft';
    await page.keyboard.down(direction);
    try {
      await page.waitForFunction(({ playerId, stopX, axis }) => {
        const body = window.__dateRunTest.snapshot()?.state.players.find(({ id }) => id === playerId)?.body;
        return body !== undefined && (body.x - stopX) * axis >= 0;
      }, { playerId: player.id, stopX: targetX - axis * brakingDistance, axis });
    } finally {
      await page.keyboard.up(direction);
    }
    await page.waitForFunction((playerId) =>
      window.__dateRunTest.snapshot()?.state.players.find(({ id }) => id === playerId)?.body.vx === 0, player.id);
    return false;
  }, { timeout: 30_000, intervals: [16, 20, 24] }).toBe(true);
}

export async function completeRound(
  host: Page,
  guest: Page,
  request: APIRequestContext,
  roomId: string,
  hostRole: Role,
  guestRole: Role,
): Promise<void> {
  await triggerCompletion(host, guest, request, roomId, hostRole, guestRole);
  await expect(host.getByRole('heading', { name: 'Вы встретились!' })).toBeVisible();
  await expect(guest.getByRole('heading', { name: 'Вы встретились!' })).toBeVisible();
  await expect(host.getByRole('heading', { name: 'Готовность к новой игре' })).toBeVisible();
  await expect(guest.getByRole('heading', { name: 'Готовность к новой игре' })).toBeVisible();
}

export async function triggerCompletion(
  host: Page,
  guest: Page,
  request: APIRequestContext,
  roomId: string,
  hostRole: Role,
  guestRole: Role,
): Promise<void> {
  await Promise.all([
    collectOwnGift(host, request, roomId, hostRole),
    collectOwnGift(guest, request, roomId, guestRole),
  ]);
  await Promise.all([
    occupySwitch(host, request, roomId, hostRole),
    occupySwitch(guest, request, roomId, guestRole),
  ]);
  await waitForSnapshot(request, roomId, (snapshot) => snapshot.state.gateOpen);

  const approachFinish = async (page: Page, role: Role): Promise<void> => {
    const snapshot = await readSnapshot(request, roomId);
    const player = await playerForRole(snapshot, role);
    const finishCenter = SHORT_LEVEL.finish.x + SHORT_LEVEL.finish.width / 2;
    const direction = player.body.x + 16 < finishCenter ? 'ArrowRight' : 'ArrowLeft';
    await page.keyboard.down(direction);
    try {
      await expect.poll(async () => {
        const currentSnapshot = await readSnapshot(request, roomId);
        const current = currentSnapshot.state.players.find(({ id }) => id === player.id);
        if (!current) return false;
        const centerX = current.body.x + 16;
        const centerY = current.body.y + 28;
        return centerX >= SHORT_LEVEL.finish.x && centerX <= SHORT_LEVEL.finish.x + SHORT_LEVEL.finish.width &&
          centerY >= SHORT_LEVEL.finish.y && centerY <= SHORT_LEVEL.finish.y + SHORT_LEVEL.finish.height;
      }, { timeout: 10_000, intervals: [16, 20, 24] }).toBe(true);
    } finally {
      await page.keyboard.up(direction);
    }
  };

  await Promise.all([approachFinish(host, hostRole), approachFinish(guest, guestRole)]);
  await waitForSnapshot(request, roomId, (snapshot) => snapshot.state.phase === 'complete');
}

export async function newPage(context: BrowserContext, diagnostics: Array<() => void>): Promise<Page> {
  const page = await context.newPage();
  diagnostics.push(watchBrowserIssues(page));
  await page.goto('/date-run/');
  await expect(page.getByRole('heading', { name: 'Date Run' })).toBeVisible();
  return page;
}

export function assertNoBrowserIssues(diagnostics: readonly (() => void)[]): void {
  for (const assertClean of diagnostics) assertClean();
}
