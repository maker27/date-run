import { expect, test } from './fixtures.js';
import {
  assertNoBrowserIssues,
  controlPost,
  createRoom,
  joinRoom,
  newPage,
  readSnapshot,
  startRound,
} from './helpers.js';

test('keeps movement responsive with only four animation frames per second', async ({ browser, request }) => {
  const context = await browser.newContext();
  const diagnostics: Array<() => void> = [];
  try {
    await context.addInitScript(() => {
      window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(performance.now()), 250);
      window.cancelAnimationFrame = (id) => window.clearTimeout(id);
    });
    const host = await newPage(context, diagnostics);
    const guest = await newPage(context, diagnostics);
    const roomId = await createRoom(host, 'winter', 'a');
    await joinRoom(guest, roomId);
    await startRound(host, guest, request, roomId);
    const initial = await readSnapshot(request, roomId);
    await Promise.all([host.keyboard.down('ArrowRight'), guest.keyboard.down('ArrowLeft')]);
    try {
      await expect.poll(async () => {
        const snapshot = await readSnapshot(request, roomId);
        return initial.state.players.map((player) => {
          const current = snapshot.state.players.find(({ id }) => id === player.id);
          return current !== undefined && Math.abs(current.body.x - player.body.x) >= 120;
        });
      }, { timeout: 2000, intervals: [20, 40] }).toEqual([true, true]);
    } finally {
      await Promise.all([host.keyboard.up('ArrowRight'), guest.keyboard.up('ArrowLeft')]);
    }
    assertNoBrowserIssues(diagnostics);
  } finally {
    await context.close();
    await controlPost(request, '/restart', {}, (value) => expect(value).toMatchObject({ status: 'restarted' }));
  }
});
