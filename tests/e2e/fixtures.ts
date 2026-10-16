import { test as base, type Page } from '@playwright/test';

export { expect } from '@playwright/test';
export type { APIRequestContext, BrowserContext, Page } from '@playwright/test';

const cpuRate = Number(process.env.E2E_CPU_RATE ?? '1');
if (!Number.isFinite(cpuRate) || cpuRate < 1) throw new Error('E2E_CPU_RATE must be a finite number >= 1');
const throttledPages = new WeakSet<Page>();

export async function applyCpuThrottle(page: Page): Promise<void> {
  if (cpuRate === 1 || throttledPages.has(page)) return;
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
  throttledPages.add(page);
}

export const test = base.extend<{ cpuThrottling: void }>({
  cpuThrottling: [async ({ browser }, use, info) => {
    if (cpuRate === 1) { await use(); return; }
    const pages = new Set<Page>();
    const newContext = browser.newContext;
    browser.newContext = async (...args) => {
      const context = await newContext.apply(browser, args);
      context.on('page', (page) => pages.add(page));
      const newPage = context.newPage.bind(context);
      context.newPage = async () => {
        const page = await newPage();
        pages.add(page);
        await applyCpuThrottle(page);
        return page;
      };
      return context;
    };
    let configuredPages: number;
    try {
      await use();
    } finally {
      browser.newContext = newContext;
      configuredPages = [...pages].filter((page) => throttledPages.has(page)).length;
      await info.attach('cpu-profile', {
        body: JSON.stringify({ rate: cpuRate, pages: pages.size, configuredPages }),
        contentType: 'application/json',
      });
    }
    if (configuredPages !== pages.size) throw new Error('CPU throttling was not applied to every page');
  }, { auto: true }],
});
