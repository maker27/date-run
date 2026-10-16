import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const templateUrl = new URL('./nginx-location.conf.template', import.meta.url);

export function renderNginxLocation(port: string): string {
  if (!/^[0-9]+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('Port must be a decimal integer from 1 to 65535');
  }
  return readFileSync(templateUrl, 'utf8').replaceAll('HOST_PORT', port);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    if (process.argv.length !== 3) throw new Error('Expected exactly one port argument');
    process.stdout.write(renderNginxLocation(process.argv[2] ?? ''));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
