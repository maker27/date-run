import { expect, test } from '@playwright/test';
import {
  assertNoBrowserIssues,
  collectOwnGift,
  controlPost,
  createRoom,
  joinRoom,
  newPage,
  occupySwitch,
  startRound,
  waitForSnapshot,
} from './helpers.js';

test('keeps both players on their switches when control snapshots arrive late', async ({ browser, request }) => {
  const context = await browser.newContext();
  const diagnostics: Array<() => void> = [];
  const get = request.get.bind(request);
  try {
    const host = await newPage(context, diagnostics);
    const guest = await newPage(context, diagnostics);
    const roomId = await createRoom(host, 'winter', 'a');
    await joinRoom(guest, roomId);
    await startRound(host, guest, request, roomId);
    await Promise.all([
      collectOwnGift(host, request, roomId, 'a'),
      collectOwnGift(guest, request, roomId, 'b'),
    ]);
    request.get = async (...args) => {
      const response = await get(...args);
      await new Promise<void>((resolve) => setTimeout(resolve, 450));
      return response;
    };
    await Promise.all([
      occupySwitch(host, request, roomId, 'a'),
      occupySwitch(guest, request, roomId, 'b'),
    ]);
    const snapshot = await waitForSnapshot(request, roomId, (current) =>
      current.state.gateOpen && current.state.players.every(({ body }) => body.vx === 0));
    expect(snapshot.state.switches.every(({ occupant }) => occupant !== null)).toBe(true);
    assertNoBrowserIssues(diagnostics);
  } finally {
    request.get = get;
    await context.close();
    await controlPost(request, '/restart', {}, (value) => expect(value).toMatchObject({ status: 'restarted' }));
  }
});
