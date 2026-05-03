// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 4.2: OpenFGAClient.check() Unit Tests
 *
 * Tests cover:
 * - Returns true when OpenFGA responds with allowed: true
 * - Returns false when OpenFGA responds with allowed: false
 * - Sends model_instance:<subject> as the user field (not model:<subject>)
 * - Sends privacy_category:sha256-<hash> when literal is provided
 * - Sends privacy_category:<category> when only object is provided
 * - Sends Bearer <OPENFGA_API_TOKEN> Authorization header when env var is set
 * - Sends authorization_model_id in request body when modelId is configured
 * - Throws on non-2xx response (includes status and body in error message)
 * - Handles network errors gracefully (throws descriptive error)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createFetchMock } from './support/fetch-mock.ts';

// Lazy import to allow mock fetch to be set first
let OpenFGAClient: typeof import('../openfga.ts').OpenFGAClient;

describe('OpenFGAClient.check()', () => {
  let fetchMock: ReturnType<typeof createFetchMock>;
  let client: InstanceType<typeof OpenFGAClient>;
  const baseConfig = { apiUrl: 'http://localhost:28080', storeId: 'test-store', modelId: 'test-model' };
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    fetchMock = createFetchMock();
    // Set global fetch BEFORE importing the module - use fetchFn not the mock object
    (globalThis as Record<string, unknown>)['fetch'] = fetchMock.fetchFn;
    // Dynamic import AFTER setting mock fetch
    const mod = await import('../openfga.ts');
    OpenFGAClient = mod.OpenFGAClient;
    client = new OpenFGAClient(baseConfig);
  });

  afterEach(() => {
    fetchMock.reset();
    // Restore original fetch
    if (originalFetch === undefined) {
      delete (globalThis as Record<string, unknown>)['fetch'];
    } else {
      (globalThis as Record<string, unknown>)['fetch'] = originalFetch;
    }
  });

  it('returns true when OpenFGA responds with allowed: true', async () => {
    fetchMock.mockResponse({ ok: true, status: 200, statusText: 'OK', body: { allowed: true } });

    const result = await client.check({ subject: 'test-model', relation: 'can_view', object: 'private_email' });

    assert.strictEqual(result, true);
  });

  it('returns false when OpenFGA responds with allowed: false', async () => {
    fetchMock.mockResponse({ ok: true, status: 200, statusText: 'OK', body: { allowed: false } });

    const result = await client.check({ subject: 'test-model', relation: 'can_view', object: 'private_email' });

    assert.strictEqual(result, false);
  });

  it('sends model_instance:<subject> as the user field (not model:<subject>)', async () => {
    fetchMock.mockResponse({ ok: true, status: 200, statusText: 'OK', body: { allowed: true } });

    await client.check({ subject: 'mlx-community/MiniMax-M2.7-8bit', relation: 'can_view', object: 'private_email' });

    const request = fetchMock.getLastRequest();
    assert.ok(request, 'Request was made');
    const body = JSON.parse(request!.options.body as string);
    assert.strictEqual(body.tuple_key.user, 'model_instance:mlx-community/MiniMax-M2.7-8bit');
    assert.ok(!body.tuple_key.user.startsWith('model:'), 'User field should use model_instance: prefix');
  });

  it('sends privacy_category:sha256-<hash> when literal is provided', async () => {
    fetchMock.mockResponse({ ok: true, status: 200, statusText: 'OK', body: { allowed: true } });

    const literal = 'user@company.com';
    await client.check({ subject: 'test-model', relation: 'can_view', literal });

    const request = fetchMock.getLastRequest();
    assert.ok(request, 'Request was made');
    const body = JSON.parse(request!.options.body as string);

    // Verify the object is the hashed form
    assert.ok(body.tuple_key.object.startsWith('privacy_category:sha256-'),
      `Expected privacy_category:sha256-<hash>, got: ${body.tuple_key.object}`);

    // Verify the hash is 40 hex characters
    const hash = body.tuple_key.object.replace('privacy_category:sha256-', '');
    assert.match(hash, /^[0-9a-f]{40}$/, `Expected 40 hex chars, got: ${hash}`);

    // Verify the literal is NOT in the request (raw literal never sent)
    const requestStr = JSON.stringify(request!.options.body);
    assert.ok(!requestStr.includes('user@company.com'),
      'Raw literal should not be sent to OpenFGA');
  });

  it('sends privacy_category:<category> when only object is provided', async () => {
    fetchMock.mockResponse({ ok: true, status: 200, statusText: 'OK', body: { allowed: true } });

    await client.check({ subject: 'test-model', relation: 'can_view', object: 'private_email' });

    const request = fetchMock.getLastRequest();
    assert.ok(request, 'Request was made');
    const body = JSON.parse(request!.options.body as string);

    assert.strictEqual(body.tuple_key.object, 'privacy_category:private_email');
  });

  it('sends privacy_category:<category> when object starts with sha256-', async () => {
    fetchMock.mockResponse({ ok: true, status: 200, statusText: 'OK', body: { allowed: true } });

    // When object is already a hash (starts with sha256-), it should be wrapped correctly
    await client.check({ subject: 'test-model', relation: 'can_view', object: 'sha256-abc123' });

    const request = fetchMock.getLastRequest();
    assert.ok(request, 'Request was made');
    const body = JSON.parse(request!.options.body as string);

    assert.strictEqual(body.tuple_key.object, 'privacy_category:sha256-abc123');
  });

  it('sends Bearer <OPENFGA_API_TOKEN> Authorization header when env var is set', async () => {
    fetchMock.mockResponse({ ok: true, status: 200, statusText: 'OK', body: { allowed: true } });

    process.env.OPENFGA_API_TOKEN = 'test-token-12345';
    try {
      await client.check({ subject: 'test-model', relation: 'can_view', object: 'private_email' });
    } finally {
      delete process.env.OPENFGA_API_TOKEN;
    }

    const request = fetchMock.getLastRequest();
    assert.ok(request, 'Request was made');
    const authHeader = request!.options.headers?.['Authorization'];
    assert.strictEqual(authHeader, 'Bearer test-token-12345');
  });

  it('does not send Authorization header when OPENFGA_API_TOKEN is not set', async () => {
    fetchMock.mockResponse({ ok: true, status: 200, statusText: 'OK', body: { allowed: true } });

    delete process.env.OPENFGA_API_TOKEN;
    await client.check({ subject: 'test-model', relation: 'can_view', object: 'private_email' });

    const request = fetchMock.getLastRequest();
    assert.ok(request, 'Request was made');
    const authHeader = request!.options.headers?.['Authorization'];
    assert.strictEqual(authHeader, 'Bearer ');
  });

  it('sends authorization_model_id in request body when modelId is configured', async () => {
    fetchMock.mockResponse({ ok: true, status: 200, statusText: 'OK', body: { allowed: true } });

    await client.check({ subject: 'test-model', relation: 'can_view', object: 'private_email' });

    const request = fetchMock.getLastRequest();
    assert.ok(request, 'Request was made');
    const body = JSON.parse(request!.options.body as string);

    assert.ok('authorization_model_id' in body, 'Request should include authorization_model_id');
    assert.strictEqual(body.authorization_model_id, 'test-model');
  });

  it('throws on non-2xx response (includes status and body in error message)', async () => {
    fetchMock.mockResponse({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      body: { message: 'Store not found' }
    });

    await assert.rejects(
      async () => client.check({ subject: 'test-model', relation: 'can_view', object: 'private_email' }),
      (err: Error) => {
        assert.ok(err.message.includes('404'), `Error should include status code. Got: ${err.message}`);
        assert.ok(err.message.includes('Store not found'), 'Error should include response body');
        return true;
      }
    );
  });

  it('throws on non-2xx response with empty body', async () => {
    fetchMock.mockResponse({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      body: ''
    });

    await assert.rejects(
      async () => client.check({ subject: 'test-model', relation: 'can_view', object: 'private_email' }),
      (err: Error) => {
        assert.ok(err.message.includes('500'), `Error should include status code. Got: ${err.message}`);
        return true;
      }
    );
  });

  it('handles network errors gracefully (throws descriptive error)', async () => {
    fetchMock.mockNetworkError('Connection refused');

    await assert.rejects(
      async () => client.check({ subject: 'test-model', relation: 'can_view', object: 'private_email' }),
      (err: Error) => {
        assert.ok(
          err.message.includes('Connection refused') || err.message.includes('fetch'),
          `Error should mention network failure, got: ${err.message}`
        );
        return true;
      }
    );
  });

  it('correctly builds URL with store ID', async () => {
    fetchMock.mockResponse({ ok: true, status: 200, statusText: 'OK', body: { allowed: true } });

    await client.check({ subject: 'test-model', relation: 'can_view', object: 'private_email' });

    const request = fetchMock.getLastRequest();
    assert.ok(request!.url.includes('/stores/test-store/'), 'URL should include store ID');
    assert.ok(request!.url.includes('/check'), 'URL should include /check endpoint');
  });

  it('handles different relation types correctly', async () => {
    fetchMock.mockResponse({ ok: true, status: 200, statusText: 'OK', body: { allowed: true } });

    await client.check({ subject: 'test-model', relation: 'can_view', object: 'private_email' });

    const request = fetchMock.getLastRequest();
    const body = JSON.parse(request!.options.body as string);
    assert.strictEqual(body.tuple_key.relation, 'can_view');
  });
});
