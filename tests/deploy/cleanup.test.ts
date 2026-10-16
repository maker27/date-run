import { describe, expect, it } from 'vitest';
import { cleanupOwnedResources } from './cleanup.js';

describe('owned resource cleanup', () => {
  it('attempts every cleanup and reports failures after the final attempt', async () => {
    const attempted: string[] = [];
    const cleanup = cleanupOwnedResources([
      {
        name: 'first resource',
        async cleanup() {
          attempted.push('first');
          throw new Error('first removal failed');
        },
      },
      {
        name: 'second resource',
        async cleanup() {
          attempted.push('second');
        },
      },
    ]);

    await expect(cleanup).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'Failed to clean first resource' })],
    });
    expect(attempted).toEqual(['first', 'second']);
  });
});
