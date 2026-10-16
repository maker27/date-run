import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');

describe('nginx prefix deployment contract', () => {
  it('renders only a validated port and preserves nginx variables', async () => {
    for (const port of ['1', '80', '65535']) {
      const output = await render(port);
      expect(output).toContain(`127.0.0.1:${port}`);
      expect(output).toContain('$http_upgrade');
      expect(output).toContain('$date_run_connection_upgrade');
      expect(output).toContain('$host');
      expect(output).toContain('$remote_addr');
      expect(output).toContain('$scheme');
      expect(output).toContain('$is_args$args');
    }
    for (const port of ['', '0', '65536', ' 80', '80 ', '+80', '1e3', '80;return 200', '80\nserver{}']) {
      await expect(render(port)).rejects.toMatchObject({ code: 1 });
    }
  });

  it('keeps the one-time upgrade map in HTTP context and server locations separate', async () => {
    const [httpConfig, generated] = await Promise.all([
      import('node:fs/promises').then(({ readFile }) => readFile(resolve(root, 'deploy/nginx-http.conf'), 'utf8')),
      render('18080'),
    ]);
    expect(httpConfig).toMatch(/map\s+\$http_upgrade\s+\$date_run_connection_upgrade\s*\{/);
    expect(httpConfig.match(/map\s+\$http_upgrade/g)).toHaveLength(1);
    expect(httpConfig).not.toMatch(/\bserver\s*\{/);
    expect(generated).not.toMatch(/\bserver\s*\{/);
    expect(generated).toMatch(/location\s*=\s*\/date-run\s*\{/);
    expect(generated).toMatch(/return\s+308\s+\/date-run\/\$is_args\$args/);
    expect(generated).toMatch(/location\s+\^~\s+\/date-run\//);
    expect(generated).toMatch(/proxy_pass\s+http:\/\/127\.0\.0\.1:18080\s*;/);
    expect(generated).not.toMatch(/proxy_pass\s+http:\/\/127\.0\.0\.1:18080\//);
    expect(generated).toMatch(/proxy_http_version\s+1\.1/);
    expect(generated).toMatch(/proxy_set_header\s+Upgrade\s+\$http_upgrade/);
    expect(generated).toMatch(/proxy_set_header\s+Connection\s+\$date_run_connection_upgrade/);
    expect(generated).toMatch(/proxy_read_timeout\s+60s/);
    expect(generated).toMatch(/proxy_send_timeout\s+60s/);
  });

  it('prints the rendered config on stdout and rejects invalid CLI ports', async () => {
    const valid = await render('18080');
    expect(valid).toContain('127.0.0.1:18080');
    for (const port of ['0', '65536', '80;echo unsafe']) {
      await expect(execFileAsync('node', ['--import', 'tsx', 'deploy/render-nginx.ts', port], {
        cwd: root,
        timeout: 10_000,
      })).rejects.toMatchObject({ code: 1 });
    }
  });
});

async function render(port: string): Promise<string> {
  const { stdout } = await execFileAsync('node', ['--import', 'tsx', 'deploy/render-nginx.ts', port], {
    cwd: root,
    timeout: 10_000,
  });
  return stdout;
}
