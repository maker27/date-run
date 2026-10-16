import { expect, test } from '@playwright/test';
import type { ThemeId } from '../../src/shared/model.js';
import {
  assertNoBrowserIssues,
  completeRound,
  controlPost,
  createRoom,
  joinRoom,
  newPage,
  readSnapshot,
  startRound,
  waitForSnapshot,
} from './helpers.js';

const themes: readonly ThemeId[] = ['first-date', 'retro', 'winter'];

for (const theme of themes) {
  test(`loads the ${theme} theme in a real two-player round`, async ({ browser, request }) => {
    const context = await browser.newContext();
    const diagnostics: Array<() => void> = [];
    try {
      const host = await newPage(context, diagnostics);
      const guest = await newPage(context, diagnostics);
      const roomId = await createRoom(host, theme, 'a');
      await joinRoom(guest, roomId);
      await startRound(host, guest, request, roomId);
      await completeRound(host, guest, request, roomId, 'a', 'b');
      const snapshot = await waitForSnapshot(request, roomId, (current) => current.state.phase === 'complete');
      expect(snapshot.state.themeId).toBe(theme);
      await expect(host.getByRole('img', { name: 'Игровой мир Date Run' })).toBeVisible();
      await expect(guest.getByRole('img', { name: 'Игровой мир Date Run' })).toBeVisible();
      expect((await readSnapshot(request, roomId)).state.players).toHaveLength(2);
      assertNoBrowserIssues(diagnostics);
    } finally {
      await context.close();
      await controlPost(request, '/restart', {}, (value) => expect(value).toMatchObject({ status: 'restarted' }));
    }
  });
}
