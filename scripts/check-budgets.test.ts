import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { checkBudgets, collectBudgets } from './check-budgets.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'date-run-budget-'));
  roots.push(root);
  return root;
}

describe('asset budgets', () => {
  it('measures emitted JavaScript and only the selected theme graphics', async () => {
    const rootDir = await makeRoot();
    const clientDistDir = path.join(rootDir, 'dist');
    await mkdir(path.join(clientDistDir, 'assets'), { recursive: true });
    const selectedGraphics = [
      { file: 'atlas-0-A1b2C3d4.png', width: 12, height: 8 },
      { file: 'art-background-E5f6G7h8.png', width: 6, height: 4 },
    ];
    const otherThemeGraphics = [{ file: 'atlas-0-J9k0L1m2.png', width: 24, height: 16 }];
    const pngSizes = new Map<string, number>();
    for (const graphic of [...selectedGraphics, ...otherThemeGraphics]) {
      const imagePath = path.join(clientDistDir, 'assets', graphic.file);
      await sharp({ create: { width: graphic.width, height: graphic.height, channels: 4, background: '#c45b63' } }).png().toFile(imagePath);
      pngSizes.set(graphic.file, (await stat(imagePath)).size);
    }
    await writeFile(path.join(clientDistDir, 'assets', 'first-date-P3q4R5s6.js'), `export const urls = ${JSON.stringify(selectedGraphics.map(({ file }) => `/assets/${file}`))};`);
    await writeFile(path.join(clientDistDir, 'assets', 'retro-T7u8V9w0.js'), `export const urls = ${JSON.stringify(otherThemeGraphics.map(({ file }) => `/assets/${file}`))};`);
    await writeFile(path.join(clientDistDir, 'assets', 'index-X1y2Z3a4.js'), `import('/assets/first-date-P3q4R5s6.js');`);
    await writeFile(path.join(clientDistDir, 'index.html'), '<script type="module" src="/assets/index-X1y2Z3a4.js"></script>');

    const budgets = await collectBudgets({ rootDir, clientDistDir, themeId: 'first-date' });
    const selectedPngBytes = selectedGraphics.reduce((total, graphic) => total + (pngSizes.get(graphic.file) ?? 0), 0);
    const selectedPixelBytes = selectedGraphics.reduce((total, graphic) => total + graphic.width * graphic.height * 4, 0);

    expect(budgets.jsGzipBytes).toBeGreaterThan(0);
    expect(budgets.selectedThemeGraphicsBytes).toBe(selectedPngBytes);
    expect(budgets.gpuActiveTextureBytes).toBe(selectedPixelBytes);
    expect(budgets.prefetchedThemes).toEqual([]);
    expect(checkBudgets(budgets).overages).toEqual([]);
  });

  it('fails measured overages and unexpected theme prefetches', () => {
    const result = checkBudgets({
      jsGzipBytes: 500 * 1024 + 1,
      selectedThemeGraphicsBytes: 4 * 1024 * 1024 + 1,
      gpuActiveTextureBytes: 64 * 1024 * 1024 + 1,
      prefetchedThemes: ['retro'],
    });

    expect(result.overages).toEqual(expect.arrayContaining([
      expect.objectContaining({ budget: 'jsGzipBytes' }),
      expect.objectContaining({ budget: 'selectedThemeGraphicsBytes' }),
      expect.objectContaining({ budget: 'gpuActiveTextureBytes' }),
      expect.objectContaining({ budget: 'prefetchedThemes' }),
    ]));
  });

  it('detects another theme chunk statically imported by the emitted entry', async () => {
    const rootDir = await makeRoot();
    const clientDistDir = path.join(rootDir, 'dist');
    const assetsDir = path.join(clientDistDir, 'assets');
    await mkdir(assetsDir, { recursive: true });
    await sharp({ create: { width: 2, height: 2, channels: 4, background: '#c45b63' } })
      .png().toFile(path.join(assetsDir, 'atlas-0-A1b2C3d4.png'));
    await writeFile(path.join(assetsDir, 'first-date-P3q4R5s6.js'), "export const art = '/assets/atlas-0-A1b2C3d4.png';");
    await writeFile(path.join(assetsDir, 'retro-T7u8V9w0.js'), 'export const theme = "retro";');
    await writeFile(path.join(assetsDir, 'index-X1y2Z3a4.js'), [
      "import '/assets/first-date-P3q4R5s6.js';",
      "import '/assets/retro-T7u8V9w0.js';",
    ].join('\n'));
    await writeFile(path.join(clientDistDir, 'index.html'), '<script type="module" src="/assets/index-X1y2Z3a4.js"></script>');

    const budgets = await collectBudgets({ rootDir, clientDistDir, themeId: 'first-date' });

    expect(budgets.prefetchedThemes).toEqual(['retro']);
  });

  it('fails when selected theme output is missing instead of reporting a zero-byte pass', async () => {
    const rootDir = await makeRoot();
    const clientDistDir = path.join(rootDir, 'dist');
    await mkdir(path.join(clientDistDir, 'assets'), { recursive: true });
    await writeFile(path.join(clientDistDir, 'assets', 'index-A1b2C3d4.js'), 'export {};');
    await writeFile(path.join(clientDistDir, 'index.html'), '<script type="module" src="/assets/index-A1b2C3d4.js"></script>');

    await expect(collectBudgets({ rootDir, clientDistDir, themeId: 'winter' })).rejects.toThrow(/winter/);
  });
});
