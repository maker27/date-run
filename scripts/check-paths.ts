import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const excludedDirectories = new Set([
  '.git', '.work', '.vite', 'node_modules', 'dist', 'coverage', 'playwright-report',
  'test-results', 'servicefiles', '.idea', '.vscode',
]);
const excludedFiles = new Set(['AGENTS.md', 'CLAUDE.md', 'CONTEXT.md', 'HANDOFF.md']);
const textExtensions = /\.(?:cjs|conf|css|html|js|json|md|mjs|sh|svg|template|ts|tsx|txt|xml|ya?ml)$/i;
const unixHome = /\/(?:home|Users)\/[^/\\\s"'`]+(?:\/|\\)/;
const windowsHome = /\b[A-Za-z]:\\{1,2}Users\\{1,2}[^\\\s"'`]+\\/i;

function containsCheckoutPath(contents: string, checkoutRoot: string): boolean {
  const variants = [checkoutRoot, checkoutRoot.replaceAll('/', '\\'), checkoutRoot.replaceAll('/', '\\\\')];
  return variants.some((path) => contents.includes(path));
}

function containsPrivatePath(contents: string, checkoutRoot: string): boolean {
  return unixHome.test(contents) || windowsHome.test(contents) || containsCheckoutPath(contents, checkoutRoot);
}

export async function checkPaths(root: string): Promise<string[]> {
  const absoluteRoot = resolve(root);
  const checkoutRoot = resolve(import.meta.dirname, '..');
  const flagged: string[] = [];

  async function scan(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) await scan(path);
        continue;
      }
      if (!entry.isFile() || excludedFiles.has(entry.name) || !textExtensions.test(entry.name)) continue;
      if (entry.name.startsWith('.env') || /\.(?:env|key|pem)$/i.test(entry.name)) continue;
      const contents = await readFile(path, 'utf8');
      if (containsPrivatePath(contents, checkoutRoot)) flagged.push(relative(absoluteRoot, path).split('\\').join('/'));
    }
  }

  await scan(absoluteRoot);
  return [...new Set(flagged)].sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const repoRoot = resolve(import.meta.dirname, '..');
  const productionRoot = join(repoRoot, 'dist/client');
  const sourceMatches = await checkPaths(repoRoot);
  const productionMatches = (await checkPaths(productionRoot)).map((path) => `dist/client/${path}`);
  const testHookMatches = await findTestHooks(productionRoot);
  const matches = [...new Set([...sourceMatches, ...productionMatches, ...testHookMatches])].sort();
  if (matches.length) {
    process.stderr.write(`${matches.join('\n')}\n`);
    process.exitCode = 1;
  }
}

async function findTestHooks(productionRoot: string): Promise<string[]> {
  const flagged: string[] = [];
  async function scan(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await scan(path); continue; }
      if (!entry.isFile() || !/\.(?:html|js|mjs)$/i.test(entry.name)) continue;
      const contents = await readFile(path, 'utf8');
      if (/__dateRunTest|date-run-test-|SHORT_LEVEL/.test(contents)) {
        flagged.push(`dist/client/${relative(productionRoot, path).split('\\').join('/')}`);
      }
    }
  }
  await scan(productionRoot);
  return flagged;
}
