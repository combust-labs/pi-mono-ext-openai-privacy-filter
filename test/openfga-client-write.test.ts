// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 4.2: OpenFGAClient.writeTuples() Unit Tests
 *
 * Tests cover:
 * - Hashes each tuple's literal before writing to OpenFGA
 * - Uses category-only object when object is provided without literal
 * - Sends model_instance:<subject> as the user field
 * - Throws on non-2xx response
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createFetchMock } from './support/fetch-mock.ts';

// Lazy import to allow mock fetch to be set first
let OpenFGAClient: typeof import('../openfga.ts').OpenFGAClient;

describe('OpenFGAClient.writeTuples()', () => {
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

  it('hashes each tuple literal before writing to OpenFGA', async () => {
    fetchMock.mockResponse({ ok: true, status: 200, statusText: 'OK', body: {} });

    const literal = 'user@company.com';
    await client.writeTuples([
      { subject: 'test-model', relation: 'can_view', literal }
    ]);

    const request = fetchMock.getLastRequest();
    assert.ok(request, 'Request was made');

    const body = JSON.parse(request!.options.body as string);
    const tupleKeys = body.writes.tuple_keys;
    assert.ok(Array.isArray(tupleKeys), 'writes.tuple_keys should be an array');
    assert.strictEqual(tupleKeys.length, 1, 'Should have exactly one tuple key');

    // Verify the object is the hashed form
    assert.ok(
      tupleKeys[0].object.startsWith('privacy_category:sha256-'),
      `Expected privacy_category:sha256-<hash>, got: ${tupleKeys[0].object}`
    );

    // Verify the hash is 40 hex characters
    const hash = tupleKeys[0].object.replace('privacy_category:sha256-', '');
    assert.match(hash, /^[0-9a-f]{40}$/, `Expected 40 hex chars, got: ${hash}`);

    // Verify the raw literal is NOT in the request (never sent to OpenFGA)
    const requestStr = JSON.stringify(request!.options.body);
    assert.ok(
      !requestStr.includes('user@company.com'),
      'Raw literal should not be sent to OpenFGA'
    );
  });

  it('uses category-only object when object is provided without literal', async () => {
    fetchMock.mockResponse({ ok: true, status: 200, statusText: 'OK', body: {} });

    await client.writeTuples([
      { subject: 'test-model', relation: 'can_view', object: 'private_email' }
    ]);

    const request = fetchMock.getLastRequest();
    assert.ok(request, 'Request was made');

    const body = JSON.parse(request!.options.body as string);
    const tupleKeys = body.writes.tuple_keys;
    assert.strictEqual(tupleKeys[0].object, 'privacy_category:private_email');
  });

  it('sends model_instance:<subject> as the user field', async () => {
    fetchMock.mockResponse({ ok: true, status: 200, statusText: 'OK', body: {} });

    await client.writeTuples([
      { subject: 'mlx-community/MiniMax-M2.7-8bit', relation: 'can_view', object: 'private_email' }
    ]);

    const request = fetchMock.getLastRequest();
    assert.ok(request, 'Request was made');

    const body = JSON.parse(request!.options.body as string);
    const tupleKeys = body.writes.tuple_keys;
    assert.strictEqual(
      tupleKeys[0].user,
      'model_instance:mlx-community/MiniMax-M2.7-8bit',
      'User field should use model_instance: prefix'
    );
    assert.ok(
      !tupleKeys[0].user.startsWith('model:'),
      'User field should not use model: prefix'
    );
  });

  it('writes multiple tuples in a single call', async () => {
    fetchMock.mockResponse({ ok: true, status: 200, statusText: 'OK', body: {} });

    await client.writeTuples([
      { subject: 'model-a', relation: 'can_view', object: 'email' },
      { subject: 'model-b', relation: 'can_view', literal: 'secret@example.com' },
      { subject: 'model-c', relation: 'can_edit', object: 'document' }
    ]);

    const request = fetchMock.getLastRequest();
    assert.ok(request, 'Request was made');

    const body = JSON.parse(request!.options.body as string);
    const tupleKeys = body.writes.tuple_keys;
    assert.strictEqual(tupleKeys.length, 3, 'Should have three tuple keys');

    // Verify each tuple has correct structure
    assert.strictEqual(tupleKeys[0].user, 'model_instance:model-a');
    assert.strictEqual(tupleKeys[0].object, 'privacy_category:email');
    assert.strictEqual(tupleKeys[0].relation, 'can_view');

    assert.strictEqual(tupleKeys[1].user, 'model_instance:model-b');
    assert.ok(tupleKeys[1].object.startsWith('privacy_category:sha256-'));
    assert.strictEqual(tupleKeys[1].relation, 'can_view');

    assert.strictEqual(tupleKeys[2].user, 'model_instance:model-c');
    assert.strictEqual(tupleKeys[2].object, 'privacy_category:document');
    assert.strictEqual(tupleKeys[2].relation, 'can_edit');
  });

  it('sends correct URL with store ID and /write endpoint', async () => {
    fetchMock.mockResponse({ ok: true, status: 200, statusText: 'OK', body: {} });

    await client.writeTuples([
      { subject: 'test-model', relation: 'can_view', object: 'email' }
    ]);

    const request = fetchMock.getLastRequest();
    assert.ok(request!.url.includes('/stores/test-store/'), 'URL should include store ID');
    assert.ok(request!.url.includes('/write'), 'URL should include /write endpoint');
  });

  it('sends Authorization header with Bearer token when OPENFGA_API_TOKEN is set', async () => {
    fetchMock.mockResponse({ ok: true, status: 200, statusText: 'OK', body: {} });

    process.env.OPENFGA_API_TOKEN = 'test-token-abc123';
    try {
      await client.writeTuples([
        { subject: 'test-model', relation: 'can_view', object: 'email' }
      ]);
    } finally {
      delete process.env.OPENFGA_API_TOKEN;
    }

    const request = fetchMock.getLastRequest();
    assert.ok(request, 'Request was made');
    const authHeader = request!.options.headers?.['Authorization'];
    assert.strictEqual(authHeader, 'Bearer test-token-abc123');
  });

  it('does not send Authorization header when OPENFGA_API_TOKEN is not set', async () => {
    fetchMock.mockResponse({ ok: true, status: 200, statusText: 'OK', body: {} });

    delete process.env.OPENFGA_API_TOKEN;
    await client.writeTuples([
      { subject: 'test-model', relation: 'can_view', object: 'email' }
    ]);

    const request = fetchMock.getLastRequest();
    assert.ok(request, 'Request was made');
    const authHeader = request!.options.headers?.['Authorization'];
    assert.strictEqual(authHeader, 'Bearer ');
  });

  it('throws on non-2xx response with status and body in error message', async () => {
    fetchMock.mockResponse({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      body: { message: 'Write operation failed' }
    });

    await assert.rejects(
      async () => client.writeTuples([
        { subject: 'test-model', relation: 'can_view', object: 'email' }
      ]),
      (err: Error) => {
        assert.ok(
          err.message.includes('500'),
          `Error should include status code. Got: ${err.message}`
        );
        assert.ok(
          err.message.includes('Write operation failed'),
          'Error should include response body'
        );
        return true;
      }
    );
  });

  it('throws on non-2xx response with empty body', async () => {
    fetchMock.mockResponse({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      body: ''
    });

    await assert.rejects(
      async () => client.writeTuples([
        { subject: 'test-model', relation: 'can_view', object: 'email' }
      ]),
      (err: Error) => {
        assert.ok(
          err.message.includes('400'),
          `Error should include status code. Got: ${err.message}`
        );
        return true;
      }
    );
  });

  it('throws on network errors with descriptive message', async () => {
    fetchMock.mockNetworkError('Connection refused');

    await assert.rejects(
      async () => client.writeTuples([
        { subject: 'test-model', relation: 'can_view', object: 'email' }
      ]),
      (err: Error) => {
        assert.ok(
          err.message.includes('Connection refused') || err.message.includes('fetch'),
          `Error should mention network failure, got: ${err.message}`
        );
        return true;
      }
    );
  });

  it('correctly handles tuple with only literal (no object)', async () => {
    fetchMock.mockResponse({ ok: true, status: 200, statusText: 'OK', body: {} });

    await client.writeTuples([
      { subject: 'test-model', relation: 'can_view', literal: 'sensitive@data.com' }
    ]);

    const request = fetchMock.getLastRequest();
    assert.ok(request, 'Request was made');

    const body = JSON.parse(request!.options.body as string);
    const tupleKeys = body.writes.tuple_keys;

    // Should have hashed object
    assert.ok(tupleKeys[0].object.startsWith('privacy_category:sha256-'));
    // Should NOT have privacy_category:undefined or similar
    assert.ok(!tupleKeys[0].object.includes('undefined'));
  });
});
