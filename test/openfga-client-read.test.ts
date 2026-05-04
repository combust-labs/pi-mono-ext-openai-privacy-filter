// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 4.2: OpenFGAClient.readTuples() Unit Tests
 *
 * Tests cover:
 * - Builds correct query params when filter.subject is provided
 * - Builds correct query params when filter.relation is provided
 * - Builds correct query params when filter.object is provided (prefixes with privacy_category:)
 * - Returns result.tuples array from response body
 * - Throws on non-2xx response
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createFetchMock } from './support/fetch-mock.ts';

// Lazy import to allow mock fetch to be set first
let OpenFGAClient: typeof import('../openfga.ts').OpenFGAClient;

describe('OpenFGAClient.readTuples()', () => {
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

  it('returns result.tuples array from response body', async () => {
    const mockTuples = [
      { user: 'model_instance:test-model', relation: 'can_view', object: 'privacy_category:email' },
      { user: 'model_instance:test-model', relation: 'can_view', object: 'privacy_category:sha256-abc123' }
    ];
    fetchMock.mockResponse({ ok: true, status: 200, statusText: 'OK', body: { tuples: mockTuples } });

    const result = await client.readTuples();

    assert.ok(Array.isArray(result), 'Result should be an array');
    assert.strictEqual(result.length, 2, 'Should return all tuples');
    assert.deepStrictEqual(result, mockTuples, 'Should return exact tuples from response');
  });

  it('returns empty array when response has no tuples', async () => {
    fetchMock.mockResponse({ ok: true, status: 200, statusText: 'OK', body: { tuples: [] } });

    const result = await client.readTuples();

    assert.ok(Array.isArray(result), 'Result should be an array');
    assert.strictEqual(result.length, 0, 'Should return empty array');
  });

  it('builds correct query params when filter.subject is provided', async () => {
    fetchMock.mockResponse({ ok: true, status: 200, statusText: 'OK', body: { tuples: [] } });

    await client.readTuples({ subject: 'mlx-community/MiniMax-M2.7-8bit' });

    const request = fetchMock.getLastRequest();
    assert.ok(request, 'Request was made');
    const url = new URL(request!.url);
    assert.strictEqual(url.searchParams.get('user'), 'model_instance:mlx-community/MiniMax-M2.7-8bit',
      'Subject should be prefixed with model_instance:');
    assert.ok(!url.searchParams.get('user')!.startsWith('model:'),
      'Subject should use model_instance: prefix, not model:');
  });

  it('builds correct query params when filter.relation is provided', async () => {
    fetchMock.mockResponse({ ok: true, status: 200, statusText: 'OK', body: { tuples: [] } });

    await client.readTuples({ relation: 'can_view' });

    const request = fetchMock.getLastRequest();
    assert.ok(request, 'Request was made');
    const url = new URL(request!.url);
    assert.strictEqual(url.searchParams.get('relation'), 'can_view',
      'Relation should be set correctly');
  });

  it('builds correct query params when filter.object is provided (prefixes with privacy_category:)', async () => {
    fetchMock.mockResponse({ ok: true, status: 200, statusText: 'OK', body: { tuples: [] } });

    await client.readTuples({ object: 'private_email' });

    const request = fetchMock.getLastRequest();
    assert.ok(request, 'Request was made');
    const url = new URL(request!.url);
    assert.strictEqual(url.searchParams.get('object'), 'privacy_category:private_email',
      'Object should be prefixed with privacy_category:');
    assert.ok(!url.searchParams.get('object')!.startsWith('sha256-'),
      'Object should NOT have sha256- prefix when filtering (it is already hashed in writes)');
  });

  it('combines multiple filter params correctly', async () => {
    fetchMock.mockResponse({ ok: true, status: 200, statusText: 'OK', body: { tuples: [] } });

    await client.readTuples({
      subject: 'test-model',
      relation: 'can_view',
      object: 'email'
    });

    const request = fetchMock.getLastRequest();
    assert.ok(request, 'Request was made');
    const url = new URL(request!.url);
    assert.strictEqual(url.searchParams.get('user'), 'model_instance:test-model');
    assert.strictEqual(url.searchParams.get('relation'), 'can_view');
    assert.strictEqual(url.searchParams.get('object'), 'privacy_category:email');
  });

  it('sends correct URL with store ID and /read endpoint', async () => {
    fetchMock.mockResponse({ ok: true, status: 200, statusText: 'OK', body: { tuples: [] } });

    await client.readTuples();

    const request = fetchMock.getLastRequest();
    assert.ok(request!.url.includes('/stores/test-store/'), 'URL should include store ID');
    assert.ok(request!.url.includes('/read'), 'URL should include /read endpoint');
  });

  it('does not include query string when no filter is provided', async () => {
    fetchMock.mockResponse({ ok: true, status: 200, statusText: 'OK', body: { tuples: [] } });

    await client.readTuples();

    const request = fetchMock.getLastRequest();
    assert.ok(request, 'Request was made');
    const url = new URL(request!.url);
    assert.strictEqual(url.search, '', 'URL should have no query string when no filter');
  });

  it('sends Authorization header with Bearer token when OPENFGA_API_TOKEN is set', async () => {
    fetchMock.mockResponse({ ok: true, status: 200, statusText: 'OK', body: { tuples: [] } });

    process.env.OPENFGA_API_TOKEN = 'test-token-abc123';
    try {
      await client.readTuples();
    } finally {
      delete process.env.OPENFGA_API_TOKEN;
    }

    const request = fetchMock.getLastRequest();
    assert.ok(request, 'Request was made');
    const authHeader = request!.options.headers?.['Authorization'];
    assert.strictEqual(authHeader, 'Bearer test-token-abc123');
  });

  it('uses GET method for reading tuples', async () => {
    fetchMock.mockResponse({ ok: true, status: 200, statusText: 'OK', body: { tuples: [] } });

    await client.readTuples();

    const request = fetchMock.getLastRequest();
    assert.ok(request, 'Request was made');
    assert.strictEqual(request!.options.method, 'GET', 'Should use GET method');
  });

  it('throws on non-2xx response with status and body in error message', async () => {
    fetchMock.mockResponse({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      body: { message: 'Store not found' }
    });

    await assert.rejects(
      async () => client.readTuples(),
      (err: Error) => {
        assert.ok(
          err.message.includes('404'),
          `Error should include status code. Got: ${err.message}`
        );
        assert.ok(
          err.message.includes('Store not found'),
          'Error should include response body'
        );
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
      async () => client.readTuples(),
      (err: Error) => {
        assert.ok(
          err.message.includes('500'),
          `Error should include status code. Got: ${err.message}`
        );
        return true;
      }
    );
  });

  it('throws on network errors with descriptive message', async () => {
    fetchMock.mockNetworkError('Connection refused');

    await assert.rejects(
      async () => client.readTuples(),
      (err: Error) => {
        assert.ok(
          err.message.includes('Connection refused') || err.message.includes('fetch'),
          `Error should mention network failure, got: ${err.message}`
        );
        return true;
      }
    );
  });
});
