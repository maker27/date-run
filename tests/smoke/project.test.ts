import { existsSync, readFileSync } from 'node:fs';
import { h } from 'preact';
import { render, screen } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/client/app.tsx';

describe('project scaffold', () => {
  it('renders the Date Run heading', () => {
    render(h(App, {}));

    const heading = screen.getByRole('heading', { name: 'Date Run' });
    expect(heading.textContent).toBe('Date Run');
  });

  it('defines the scaffold commands and build configuration', () => {
    const packageJson = readProjectFile('../../package.json');

    for (const script of ['build:client', 'build:server', 'build', 'test', 'lint', 'typecheck']) {
      expect(packageJson).toContain(`"${script}":`);
    }

    for (const config of ['../../vite.config.ts', '../../tsconfig.client.json', '../../tsconfig.server.json']) {
      expect(existsSync(new URL(config, import.meta.url))).toBe(true);
    }
  });
});

function readProjectFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}
