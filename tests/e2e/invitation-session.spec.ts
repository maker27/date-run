import { expect, test } from './fixtures.js';
import { assertNoBrowserIssues, controlPost, createRoom, joinRoom, newPage } from './helpers.js';

test('opens an invitation instead of restoring another room and restores the invited room after reload', async ({ browser, request }) => {
  const context = await browser.newContext();
  const diagnostics: Array<() => void> = [];
  try {
    const host = await newPage(context, diagnostics);
    const guest = await newPage(context, diagnostics);
    const invitedRoom = await createRoom(host, 'winter', 'a');
    const previousRoom = await createRoom(guest, 'retro', 'b');
    expect(previousRoom).not.toBe(invitedRoom);
    await joinRoom(guest, invitedRoom);
    await expect(host.locator('.player-list li')).toHaveCount(2);
    await expect(guest.locator('.player-list li')).toHaveCount(2);
    await guest.reload();
    await expect(guest.getByRole('heading', { name: `Комната ${invitedRoom}` })).toBeVisible();
    await expect(guest.locator('.player-list li')).toHaveCount(2);
    expect(new URL(guest.url()).searchParams.get('room')).toBe(invitedRoom);
    assertNoBrowserIssues(diagnostics);
  } finally {
    await context.close();
    await controlPost(request, '/restart', {}, (value) => expect(value).toMatchObject({ status: 'restarted' }));
  }
});
