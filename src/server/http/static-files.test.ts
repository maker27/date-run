import { createHttpFixture, requestRawPath } from '../../../tests/fixtures/http-test-helpers.js';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { serveStatic } from './static-files.js';

describe('static file serving', () => {
  it('redirects the prefix while preserving the query and serves the app entry without caching', async () => {
    const fixture = await createHttpFixture((request, response, root) => serveStatic(request, response, root));
    try {
      const redirect = await fetch(`${fixture.origin}/date-run?invite=ABCDEFGH`, { redirect: 'manual' });
      expect(redirect.status).toBe(308);
      expect(redirect.headers.get('location')).toBe('/date-run/?invite=ABCDEFGH');

      const index = await fetch(`${fixture.origin}/date-run/`);
      expect(index.status).toBe(200);
      expect(index.headers.get('content-type')).toMatch(/^text\/html\b/);
      expect(index.headers.get('cache-control')).toBe('no-store');
      expect(await index.text()).toContain('<title>fixture</title>');
      expect(index.headers.get('content-security-policy')).toContain("default-src 'self'");
      expect(index.headers.get('x-content-type-options')).toBe('nosniff');
    } finally {
      await fixture.close();
    }
  });

  it('uses the app entry for HTML routes and never falls back for assets or non-HTML requests', async () => {
    const fixture = await createHttpFixture((request, response, root) => serveStatic(request, response, root));
    try {
      const route = await fetch(`${fixture.origin}/date-run/room/ABCDEFGH`, { headers: { accept: 'text/html' } });
      expect(route.status).toBe(200);
      expect(route.headers.get('content-type')).toMatch(/^text\/html\b/);
      expect(await route.text()).toContain('<title>fixture</title>');
      expect((await fetch(`${fixture.origin}/date-run/room/ABCDEFGH`, { headers: { accept: 'application/json' } })).status).toBe(404);
      expect((await fetch(`${fixture.origin}/date-run/assets/missing.js`, { headers: { accept: 'text/html' } })).status).toBe(404);
    } finally {
      await fixture.close();
    }
  });

  it('serves only allowlisted MIME types and marks hashed assets immutable', async () => {
    const fixture = await createHttpFixture((request, response, root) => serveStatic(request, response, root));
    try {
      const asset = await fetch(`${fixture.origin}/date-run/assets/app-a1b2c3d4.js`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get('content-type')).toMatch(/^text\/javascript\b|^application\/javascript\b/);
      expect(asset.headers.get('cache-control')).toMatch(/immutable/);

      expect((await fetch(`${fixture.origin}/date-run/assets/missing.js`)).status).toBe(404);
      expect((await fetch(`${fixture.origin}/date-run/outside-link.js`)).status).toBe(404);
    } finally {
      await fixture.close();
    }
  });

  it('supports HEAD, rejects unsupported methods, and returns 404 outside its prefix', async () => {
    const fixture = await createHttpFixture((request, response, root) => serveStatic(request, response, root));
    try {
      const head = await fetch(`${fixture.origin}/date-run/`, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('content-type')).toMatch(/^text\/html\b/);
      expect(await head.text()).toBe('');

      const unsupported = await fetch(`${fixture.origin}/date-run/`, { method: 'POST' });
      expect(unsupported.status).toBe(405);
      expect(unsupported.headers.get('allow')).toBe('GET, HEAD');
      expect((await fetch(`${fixture.origin}/outside`)).status).toBe(404);
    } finally {
      await fixture.close();
    }
  });

  it('rejects malformed encoding and traversal without reading outside the client root', async () => {
    const fixture = await createHttpFixture((request, response, root) => serveStatic(request, response, root));
    try {
      expect((await requestRawPath(fixture.origin, '/date-run/%')).status).toBe(400);
      expect((await requestRawPath(fixture.origin, '/date-run/%2e%2e/outside.js')).status).toBe(404);
      expect((await requestRawPath(fixture.origin, '/date-run/%2e%2e%2foutside.js')).status).toBe(404);
      const link = await fetch(`${fixture.origin}/date-run/outside-link.js`);
      expect(link.status).toBe(404);
      expect(await link.text()).not.toContain('outside-root-secret');
    } finally {
      await fixture.close();
    }
  });

  it('returns HTTP 500 when an allowlisted asset cannot be opened before the response body starts', async () => {
    const fixture = await createHttpFixture((request, response, root) => serveStatic(request, response, root));
    const asset = join(fixture.root, 'assets', 'app-a1b2c3d4.js');
    try {
      await chmod(asset, 0);
      const response = await fetch(`${fixture.origin}/date-run/assets/app-a1b2c3d4.js`, {
        signal: AbortSignal.timeout(2000),
      });

      expect(response.status).toBe(500);
      expect(await response.text()).toBe('');
    } finally {
      await chmod(asset, 0o644);
      await fixture.close();
    }
  });
});
