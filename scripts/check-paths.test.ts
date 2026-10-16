import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkPaths } from './check-paths.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'date-run-path-check-'));
  roots.push(root);
  return root;
}

describe('source path checker', () => {
  it('reports relative filenames for Unix, Windows and current checkout absolute paths', async () => {
    const root = await makeRoot();
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), [
      `const unixPath = "${['', 'home', 'example-user', 'private', 'project', 'asset.png'].join('/')}";`,
      `const windowsPath = "${['C:', 'Users', 'fixture-user', 'Documents', 'secret.txt'].join(String.fromCharCode(92))}";`,
      `const checkoutPath = "${resolve(process.cwd()).replaceAll('\\', '\\\\')}\\src\\client\\main.ts";`,
    ].join('\n'));
    await writeFile(join(root, 'src', 'z.ts'), `const duplicate = "${['', 'home', 'example-user', 'private', 'project', 'asset.png'].join('/')}";`);

    expect(await checkPaths(root)).toEqual(['src/a.ts', 'src/z.ts']);
  });

  it('accepts relative source structure and ignores work, service, dependency, git and secret files', async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, '.work'), { recursive: true });
    await mkdir(join(root, 'servicefiles'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'private-package'), { recursive: true });
    await mkdir(join(root, '.git'), { recursive: true });
    await mkdir(join(root, 'config'), { recursive: true });
    await writeFile(join(root, 'src', 'entry.ts'), "import icon from './assets/icon.png';\nconst route = '../api/rooms';");
    await writeFile(join(root, '.work', 'notes.md'), ['', 'home', 'example-user', 'private', 'workspace'].join('/'));
    await writeFile(join(root, 'node_modules', 'private-package', 'index.js'), ['C:', 'Users', 'fixture-user', 'private'].join(String.fromCharCode(92)));
    await writeFile(join(root, '.git', 'config'), ['', 'home', 'example-user', 'private', 'git'].join('/'));
    await writeFile(join(outside, 'service-notes.md'), ['', 'home', 'example-user', 'private', 'service'].join('/'));
    await symlink(join(outside, 'service-notes.md'), join(root, 'servicefiles', 'local-notes.md'));
    await writeFile(join(outside, 'token.env'), ['C:', 'Users', 'fixture-user', 'private', 'token'].join(String.fromCharCode(92)));
    await symlink(join(outside, 'token.env'), join(root, 'config', 'local.env'));

    expect(await checkPaths(root)).toEqual([]);
  });
});
