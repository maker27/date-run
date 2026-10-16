import { expect, test } from './fixtures.js';
import { allowExpected404, assertNoBrowserIssues, controlPost, createRoom, newPage, watchBrowserIssues } from './helpers.js';

test('allows one exact preview 404 and rejects another 404 inside the same active scope', async ({ browser, request }) => {
  const context = await browser.newContext();
  try {
    const expectedOnly = await context.newPage();
    const assertExpectedOnly = watchBrowserIssues(expectedOnly);
    await expectedOnly.goto('/date-run/');
    const expectedUrl = new URL('/date-run/assets/expected-preview-404.js', expectedOnly.url()).href;
    const stopExpectedOnly = allowExpected404(expectedOnly, expectedUrl);
    try {
      const consoleError = expectedOnly.waitForEvent('console', (message) =>
        message.type() === 'error' && message.text() === 'Failed to load resource: the server responded with a status of 404 (Not Found)' &&
        message.location().url === expectedUrl,
      );
      const response = expectedOnly.waitForResponse((candidate) => candidate.url() === expectedUrl);
      const status = await expectedOnly.evaluate(async (path) => (await fetch(path)).status, new URL(expectedUrl).pathname);
      expect(status).toBe(404);
      expect((await response).status()).toBe(404);
      await consoleError;
    } finally {
      stopExpectedOnly();
    }
    expect(assertExpectedOnly).not.toThrow();

    const withUnexpected = await context.newPage();
    const assertWithUnexpected = watchBrowserIssues(withUnexpected);
    await withUnexpected.goto('/date-run/');
    const allowedUrl = new URL('/date-run/assets/allowed-preview-404.js', withUnexpected.url()).href;
    const unexpectedUrl = new URL('/date-run/assets/unexpected-preview-404.js', withUnexpected.url()).href;
    const stopAllowed = allowExpected404(withUnexpected, allowedUrl);
    try {
      const consoleErrors = Promise.all([allowedUrl, unexpectedUrl].map((url) =>
        withUnexpected.waitForEvent('console', (message) =>
          message.type() === 'error' && message.text() === 'Failed to load resource: the server responded with a status of 404 (Not Found)' &&
          message.location().url === url,
        ),
      ));
      const responses = Promise.all([allowedUrl, unexpectedUrl].map((url) =>
        withUnexpected.waitForResponse((candidate) => candidate.url() === url),
      ));
      const statuses = await withUnexpected.evaluate(async (paths) =>
        Promise.all(paths.map(async (path) => (await fetch(path)).status)),
      [new URL(allowedUrl).pathname, new URL(unexpectedUrl).pathname]);
      expect(statuses).toEqual([404, 404]);
      expect((await responses).map((response) => response.status())).toEqual([404, 404]);
      await consoleErrors;
    } finally {
      stopAllowed();
    }
    expect(assertWithUnexpected).toThrow();
  } finally {
    await context.close();
    await controlPost(request, '/restart', {}, (value) => expect(value).toMatchObject({ status: 'restarted' }));
  }
});

test('keeps redirects and browser traffic under the application prefix', async ({ browser, request }) => {
  const context = await browser.newContext();
  const diagnostics: Array<() => void> = [];
  const paths: string[] = [];
  const socketPaths: string[] = [];
  try {
    const page = await context.newPage();
    diagnostics.push(watchBrowserIssues(page));
    page.on('request', (browserRequest) => paths.push(new URL(browserRequest.url()).pathname));
    page.on('websocket', (socket) => socketPaths.push(new URL(socket.url()).pathname));
    const redirects: Array<{ status: number; location: string | undefined }> = [];
    page.on('response', (response) => {
      if (new URL(response.url()).pathname === '/date-run') {
        redirects.push({ status: response.status(), location: response.headers()['location'] });
      }
    });

    await page.goto('/date-run?invite=preserved');
    await expect(page).toHaveURL(/\/date-run\/\?invite=preserved$/);
    expect(redirects).toContainEqual({ status: 308, location: '/date-run/?invite=preserved' });
    await createRoom(page, 'first-date', 'a');
    expect(paths.some((path) => path === '/assets' || path.startsWith('/assets/'))).toBe(false);
    expect(socketPaths).toEqual(['/date-run/ws']);
    const unknownAsset = await request.get('http://127.0.0.1:4173/date-run/assets/unknown-e2e.js');
    expect(unknownAsset.status()).toBe(404);
    await expect(page.getByLabel('Ссылка-приглашение')).toHaveValue(/^http:\/\/127\.0\.0\.1:4173\/date-run\/\?room=/);
    assertNoBrowserIssues(diagnostics);
  } finally {
    await context.close();
    await controlPost(request, '/restart', {}, (value) => expect(value).toMatchObject({ status: 'restarted' }));
  }
});

test('shows retry after renderer context loss and warns when session storage fails', async ({ browser, request }) => {
  const context = await browser.newContext();
  const diagnostics: Array<() => void> = [];
  try {
    const page = await newPage(context, diagnostics);
    await page.evaluate(() => window.__dateRunTest.setStorageFailure(true));
    await createRoom(page, 'winter', 'a');
    await expect(page.getByText('Браузер не может сохранить место в комнате для перезагрузки.')).toBeVisible();
    await page.evaluate(() => window.__dateRunTest.setStorageFailure(false));

    await page.locator('canvas').evaluate((canvas) => {
      canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    });
    await expect(page.getByRole('alert')).toContainText('Не удалось показать игру.');
    await page.getByRole('button', { name: 'Повторить' }).click();
    await expect(page.getByRole('img', { name: 'Игровой мир Date Run' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    assertNoBrowserIssues(diagnostics);
  } finally {
    await context.close();
    await controlPost(request, '/restart', {}, (value) => expect(value).toMatchObject({ status: 'restarted' }));
  }
});

for (const { scheme, port } of [{ scheme: 'http', port: 4180 }, { scheme: 'https', port: 4181 }]) {
  test(`serves invites over ${scheme} on the current host and leaves a sibling site untouched`, async ({ browser, request }) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: scheme === 'https' });
    const diagnostics: Array<() => void> = [];
    const paths: string[] = [];
    const socketPaths: string[] = [];
    const socketUrls: string[] = [];
    try {
      const hostA = await context.newPage();
      diagnostics.push(watchBrowserIssues(hostA));
      hostA.on('request', (browserRequest) => paths.push(new URL(browserRequest.url()).pathname));
      hostA.on('websocket', (socket) => { socketPaths.push(new URL(socket.url()).pathname); socketUrls.push(socket.url()); });
      await hostA.goto(`${scheme}://first.test:${port}/date-run/`);
      const roomId = await createRoom(hostA, 'retro', 'a');
      const inviteA = await hostA.getByLabel('Ссылка-приглашение').inputValue();
      expect(inviteA).toBe(`${scheme}://first.test:${port}/date-run/?room=${roomId}`);
      expect(socketPaths).toContain('/date-run/ws');
      expect(socketUrls).toContain(`${scheme === 'https' ? 'wss' : 'ws'}://first.test:${port}/date-run/ws`);
      if (scheme === 'https') expect(await hostA.evaluate(() => window.isSecureContext)).toBe(true);

      const hostB = await context.newPage();
      diagnostics.push(watchBrowserIssues(hostB));
      await hostB.goto(`${scheme}://second.test:${port}/date-run/`);
      const inviteOnB = inviteA.replace('first.test', 'second.test');
      await hostB.goto(inviteOnB);
      await expect(hostB.getByRole('status').filter({ hasText: 'Комната найдена:' })).toBeVisible();
      await hostB.getByRole('button', { name: 'Войти в комнату' }).click();
      await expect(hostB.getByRole('heading', { name: `Комната ${roomId}` })).toBeVisible();
      await expect(hostB.getByLabel('Ссылка-приглашение')).toHaveValue(`${scheme}://second.test:${port}/date-run/?room=${roomId}`);

      const missingAsset = await request.get(`${scheme}://127.0.0.1:${port}/date-run/assets/not-present.js`, {
        headers: { Host: `first.test:${port}` },
        ignoreHTTPSErrors: scheme === 'https',
      });
      expect(missingAsset.status()).toBe(404);
      const sibling = await context.newPage();
      diagnostics.push(watchBrowserIssues(sibling));
      await sibling.goto(`${scheme}://first.test:${port}/`);
      await expect(sibling.getByText('Sibling site')).toBeVisible();
      expect(paths.some((path) => path === '/assets' || path.startsWith('/assets/'))).toBe(false);
      assertNoBrowserIssues(diagnostics);
    } finally {
      await context.close();
      await controlPost(request, '/restart', {}, (value) => expect(value).toMatchObject({ status: 'restarted' }));
    }
  });
}


test('creates and restores a room by touch on an insecure mobile origin', async ({ browser, request }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const diagnostics: Array<() => void> = [];
  try {
    const host = await context.newPage();
    diagnostics.push(watchBrowserIssues(host));
    await host.goto('http://first.test:4180/date-run/');
    expect(await host.evaluate(() => window.isSecureContext)).toBe(false);
    expect(await host.evaluate(() => typeof crypto.randomUUID)).toBe('undefined');
    await host.getByRole('button', { name: 'Создать комнату', exact: true }).tap();
    await expect(host.getByRole('heading', { name: /^Комната [A-Z2-9]{8}$/ })).toBeVisible();
    const invite = await host.getByLabel('Ссылка-приглашение').inputValue();

    const guest = await context.newPage();
    diagnostics.push(watchBrowserIssues(guest));
    await guest.goto(invite);
    await expect(guest.getByRole('status').filter({ hasText: 'Комната найдена:' })).toBeVisible();
    await guest.getByRole('button', { name: 'Войти в комнату', exact: true }).tap();
    for (const page of [host, guest]) await expect(page.getByRole('button', { name: 'Готов', exact: true })).toBeEnabled();
    await Promise.all([host, guest].map((page) => page.getByRole('button', { name: 'Готов', exact: true }).tap()));
    for (const page of [host, guest]) await expect(page.getByRole('heading', { name: 'Бегите навстречу!' })).toBeVisible();
    await host.reload();
    await expect(host.getByRole('heading', { name: 'Бегите навстречу!' })).toBeVisible();
    assertNoBrowserIssues(diagnostics);
  } finally {
    await context.close();
    await controlPost(request, '/restart', {}, (value) => expect(value).toMatchObject({ status: 'restarted' }));
  }
});
