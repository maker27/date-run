import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const cliMocks = vi.hoisted(() => {
  const copyCalls: Array<{ source: string; destination: string }> = [];
  return { manifestPath: '', manifestContents: '', copyCalls };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    cp: async (source: unknown, destination: unknown) => {
      cliMocks.copyCalls.push({ source: String(source), destination: String(destination) });
    },
    readFile: async (file: unknown, encoding: unknown) => {
      if (String(file) !== cliMocks.manifestPath || encoding !== 'utf8') throw new Error('Unexpected CLI file read');
      return cliMocks.manifestContents;
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  cliMocks.copyCalls.length = 0;
});

describe('assets CLI', () => {
  it('rejects a traversal source path before attempting any copy', async () => {
    cliMocks.manifestPath = fileURLToPath(new URL('../art/manifests/first-date-pilot.json', import.meta.url));
    const frames: Array<{
      role: 'a' | 'b';
      state: 'idle' | 'run';
      index: number;
      sourcePath: string;
      rect: { x: number; y: number; width: number; height: number };
      pivot: { x: number; y: number };
      scale: number;
    }> = [];
    const frameCounts: Readonly<Record<'idle' | 'run', number>> = { idle: 4, run: 8 };
    for (const role of ['a', 'b'] as const) {
      for (const state of ['idle', 'run'] as const) {
        for (let index = 0; index < frameCounts[state]; index += 1) {
          frames.push({
            role,
            state,
            index,
            sourcePath: `source/${role}-${state}-${index}.png`,
            rect: { x: 0, y: 0, width: 1, height: 1 },
            pivot: { x: 0, y: 0 },
            scale: 1,
          });
        }
      }
    }
    const source = { schemaVersion: 1, themeId: 'first-date', mode: 'pilot', frames };
    const firstFrame = source.frames[0];
    if (firstFrame === undefined) throw new Error('Pilot manifest has no source frames');
    firstFrame.sourcePath = '../task13-cli-traversal-target-must-not-exist.png';
    cliMocks.manifestContents = JSON.stringify(source);

    const previousArgv = process.argv.slice();
    const previousExitCode = process.exitCode;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    process.exitCode = 0;
    process.argv.splice(2, process.argv.length - 2, 'check', '--pilot');
    try {
      await import('./assets-cli.js');
      await vi.waitFor(() => expect(process.exitCode).toBe(1));
      expect(cliMocks.copyCalls).toHaveLength(0);
      expect(stderr).toHaveBeenCalledWith('Asset command failed\n');
    } finally {
      process.argv.splice(0, process.argv.length, ...previousArgv);
      process.exitCode = previousExitCode;
      stderr.mockRestore();
    }
  });
});
