import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildThemeAssets, parseSourceThemeManifest } from './build-assets.js';

const root = fileURLToPath(new URL('..', import.meta.url));
async function main(): Promise<void> {
  const [, , command, mode] = process.argv;
  if (!['build', 'check'].includes(command ?? '') || (mode !== undefined && mode !== '--pilot')) throw new Error('Usage: assets-cli.ts build|check [--pilot]');
  const names = mode === '--pilot' ? ['first-date-pilot'] : ['first-date', 'retro', 'winter'];
  for (const name of names) {
    const sourcePath = path.join(root, `art/manifests/${name}.json`);
    if (mode !== '--pilot') {
      try { await access(sourcePath); } catch { continue; }
    }
    const input: unknown = JSON.parse(await readFile(sourcePath, 'utf8'));
    const source = parseSourceThemeManifest(input);
    if (source.mode !== (mode === '--pilot' ? 'pilot' : 'release') || name !== (mode === '--pilot' ? `${source.themeId}-pilot` : source.themeId)) throw new Error('Invalid source manifest');
  if (command === 'build') {
    const report = await buildThemeAssets(source, { projectRoot: root });
    process.stdout.write(`Built ${report.manifestPath}, ${report.pagePaths.length} page(s), ${Object.keys(report.artPaths).length} art image(s)\n`);
    continue;
  }
  const scratch = await mkdtemp(path.join(root, '.asset-check-'));
  try {
    const report = await buildThemeAssets(source, { projectRoot: root, outputDir: `${path.basename(scratch)}/generated` });
    const target = path.join(root, source.mode === 'pilot' ? `art/preview/generated/${source.themeId}` : `src/client/themes/generated/${source.themeId}`);
    for (const relative of [report.manifestPath, ...report.pagePaths, ...Object.values(report.artPaths)]) {
      const name = path.basename(relative);
      const [actual, expected] = await Promise.all([readFile(path.join(target, name)), readFile(path.join(root, relative))]);
      if (!actual.equals(expected)) throw new Error(`Generated asset differs: ${name}`);
    }
    process.stdout.write(`Checked ${source.themeId} ${source.mode} assets\n`);
  } finally { await rm(scratch, { recursive: true, force: true }); }
  }
}
main().catch(() => { process.stderr.write('Asset command failed\n'); process.exitCode = 1; });
