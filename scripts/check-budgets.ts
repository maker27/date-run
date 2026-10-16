import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import sharp from 'sharp';
import type { ThemeId } from '../src/shared/model.js';

export interface Budgets {
  jsGzipBytes: number;
  selectedThemeGraphicsBytes: number;
  gpuActiveTextureBytes: number;
  prefetchedThemes: string[];
}

export interface BudgetOptions { rootDir: string; clientDistDir: string; themeId: ThemeId }

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory() ? listFiles(path.join(directory, entry.name)) : [path.join(directory, entry.name)]));
  return nested.flat();
}

function referencedPngs(source: string): string[] {
  return [...new Set([...source.matchAll(/(?:\/date-run)?\/assets\/([A-Za-z0-9_-]+\.png)/g)].map((match) => match[1]).filter((name): name is string => name !== undefined))];
}

function staticImports(source: string): string[] {
  return [...source.matchAll(/\bimport\s*(?:[^;]*?\bfrom\s*)?["']([^"']+\.js)["']/g)]
    .map((match) => match[1]).filter((name): name is string => name !== undefined);
}

function assetName(specifier: string): string | null {
  const name = path.posix.basename(specifier);
  return /^[A-Za-z0-9_-]+\.js$/.test(name) ? name : null;
}

export async function collectBudgets(options: BudgetOptions): Promise<Budgets> {
  const assetsDir = path.join(options.clientDistDir, 'assets');
  const files = await listFiles(options.clientDistDir);
  const scripts = files.filter((file) => file.endsWith('.js'));
  if (!scripts.length) throw new Error('No emitted JavaScript found');
  const contents = new Map<string, string>();
  let jsGzipBytes = 0;
  for (const script of scripts) {
    const buffer = await readFile(script);
    jsGzipBytes += gzipSync(buffer).length;
    contents.set(path.basename(script), buffer.toString('utf8'));
  }
  const themeChunks = scripts.filter((file) => path.basename(file).startsWith(`${options.themeId}-`));
  if (themeChunks.length !== 1) throw new Error(`Expected one emitted ${options.themeId} theme chunk`);
  const themeChunk = themeChunks[0];
  if (!themeChunk) throw new Error(`Missing ${options.themeId} theme chunk`);
  const imageNames = referencedPngs(contents.get(path.basename(themeChunk)) ?? '');
  if (!imageNames.length) throw new Error(`No emitted ${options.themeId} graphics found`);
  let selectedThemeGraphicsBytes = 0;
  let gpuActiveTextureBytes = 0;
  for (const name of imageNames) {
    const image = path.join(assetsDir, name);
    const info = await stat(image);
    const metadata = await sharp(image).metadata();
    if (!metadata.width || !metadata.height) throw new Error(`Invalid emitted image ${name}`);
    selectedThemeGraphicsBytes += info.size;
    gpuActiveTextureBytes += metadata.width * metadata.height * 4;
  }

  const html = await readFile(path.join(options.clientDistDir, 'index.html'), 'utf8');
  const initial = [...html.matchAll(/(?:src|href)=["']([^"']+\.js)["']/g)]
    .map((match) => match[1]).filter((name): name is string => name !== undefined).map(assetName).filter((name): name is string => name !== null);
  if (!initial.length) throw new Error('No emitted JavaScript entry in index.html');
  const visited = new Set<string>();
  const stack = [...initial];
  while (stack.length) {
    const name = stack.pop();
    if (!name || visited.has(name)) continue;
    visited.add(name);
    const source = contents.get(name);
    if (!source) throw new Error(`Missing emitted JavaScript ${name}`);
    for (const specifier of staticImports(source)) {
      const dependency = assetName(specifier);
      if (dependency) stack.push(dependency);
    }
  }
  const prefetchedThemes = (['first-date', 'retro', 'winter'] as const)
    .filter((themeId) => themeId !== options.themeId && [...visited].some((name) => name.startsWith(`${themeId}-`)));
  return { jsGzipBytes, selectedThemeGraphicsBytes, gpuActiveTextureBytes, prefetchedThemes };
}

export function checkBudgets(budgets: Budgets): { overages: Array<{ budget: keyof Budgets; actual: number | string[]; limit: number }> } {
  const overages: Array<{ budget: keyof Budgets; actual: number | string[]; limit: number }> = [];
  const limits = { jsGzipBytes: 500 * 1024, selectedThemeGraphicsBytes: 4 * 1024 * 1024, gpuActiveTextureBytes: 64 * 1024 * 1024 };
  for (const budget of ['jsGzipBytes', 'selectedThemeGraphicsBytes', 'gpuActiveTextureBytes'] as const) {
    if (budgets[budget] > limits[budget]) overages.push({ budget, actual: budgets[budget], limit: limits[budget] });
  }
  if (budgets.prefetchedThemes.length) overages.push({ budget: 'prefetchedThemes', actual: budgets.prefetchedThemes, limit: 0 });
  return { overages };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const rootDir = path.resolve(import.meta.dirname, '..');
    for (const themeId of ['first-date', 'retro', 'winter'] as const) {
      const budgets = await collectBudgets({ rootDir, clientDistDir: path.join(rootDir, 'dist/client'), themeId });
      const result = checkBudgets(budgets);
      process.stdout.write(`${themeId}: ${JSON.stringify({ ...budgets, ...result })}\n`);
      if (result.overages.length) process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Budget check failed'}\n`);
    process.exitCode = 1;
  }
}
