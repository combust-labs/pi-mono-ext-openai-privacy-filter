// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 4.2 / Phase 5: OpenFGAClientWrapper.check() Unit Tests
 *
 * Tests verify answers (return values) only — never inspect HTTP request bodies.
 * HTTP responses are mocked via nock at the network level.
 * The SDK makes real axios HTTP calls; nock intercepts them via Node's http module.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import nock from 'nock';
import { OpenFGAClientWrapper, createSDKClient } from '../src/openfga-sdk-wrapper.ts';

// NOTE: TEST_API_URL must be set via OPENFGA_API_URL env var.
// Fallback to harness address only when OPENFGA_INTEGRATION_TEST=true
// (allows unit test files to load in the same run as integration tests).
const TEST_API_URL = (() => {
  const url = process.env.OPENFGA_API_URL;
  if (url) return url;
  // When OPENFGA_INTEGRATION_TEST=true, allow unit test files to load.
  // The integration test's beforeAll overrides process.env with the correct
  // testcontainers address. This fallback is only for loading.
  if (process.env.OPENFGA_INTEGRATION_TEST === 'true') {
    return 'http://172.19.0.4:8080';
  }
  throw new Error('OPENFGA_API_URL env var is required for tests');
})();
const TEST_STORE_ID = '01KQJZGZ068QK7JFY96GSNFFSW';
const TEST_MODEL_ID = '01KQK0PXQE92V0KXJMHWRJRS4M';

describe('OpenFGAClientWrapper.check()', () => {
  let wrapper: OpenFGAClientWrapper;

  beforeEach(() => {
    // Create wrapper with clean env — use test store/model
    process.env.OPENFGA_API_URL = TEST_API_URL;
    process.env.OPENFGA_STORE_ID = TEST_STORE_ID;
    process.env.OPENFGA_MODEL_ID = TEST_MODEL_ID;
    delete process.env.OPENFGA_API_TOKEN;
    const sdk = createSDKClient();
    wrapper = new OpenFGAClientWrapper(sdk);
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('returns true when OpenFGA responds with allowed: true', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/check`)
      .reply(200, { allowed: true });

    const result = await wrapper.check({ subject: 'test-model', relation: 'can_view', object: 'private_email' });

    assert.strictEqual(result, true);
    nock.cleanAll();
  });

  it('returns false when OpenFGA responds with allowed: false', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/check`)
      .reply(200, { allowed: false });

    const result = await wrapper.check({ subject: 'test-model', relation: 'can_view', object: 'private_email' });

    assert.strictEqual(result, false);
    nock.cleanAll();
  });

  it('returns false when OpenFGA response has allowed: null', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/check`)
      .reply(200, { allowed: null });

    const result = await wrapper.check({ subject: 'test-model', relation: 'can_view', object: 'private_email' });

    assert.strictEqual(result, false);
    nock.cleanAll();
  });

  it('returns false when OpenFGA response is missing allowed field', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/check`)
      .reply(200, { notallowed: true });

    const result = await wrapper.check({ subject: 'test-model', relation: 'can_view', object: 'private_email' });

    assert.strictEqual(result, false);
    nock.cleanAll();
  });

  it('throws on non-2xx response with status and body in error message', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/check`, () => true)
      .reply(404, { message: 'Store not found' });

    await assert.rejects(
      async () => wrapper.check({ subject: 'test-model', relation: 'can_view', object: 'private_email' }),
      (err: Error) => {
        assert.ok(err.message.includes('404'), `Error should include status code. Got: ${err.message}`);
        assert.ok(err.message.includes('Store not found'), 'Error should include response body');
        return true;
      }
    );
    nock.cleanAll();
  });

  it('throws on non-2xx response with empty body', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/check`, () => true)
      .reply(500, '');

    await assert.rejects(
      async () => wrapper.check({ subject: 'test-model', relation: 'can_view', object: 'private_email' }),
      (err: Error) => {
        assert.ok(err instanceof Error, `Expected an Error, got: ${err}`);
        return true;
      }
    );
    nock.cleanAll();
  });

  it('throws on network error', async () => {
    // Don't mock — any request will fail with network error
    nock.disableNetConnect();

    await assert.rejects(
      async () => wrapper.check({ subject: 'test-model', relation: 'can_view', object: 'private_email' }),
      (err: Error) => {
        assert.ok(
          err.message.includes('fetch') || err.message.includes('network') || err.message.includes('OpenFGA'),
          `Error should mention network failure, got: ${err.message}`
        );
        return true;
      }
    );
    nock.enableNetConnect();
    nock.cleanAll();
  });

  it('handles different relation types correctly', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/check`)
      .reply(200, { allowed: true });

    const result = await wrapper.check({ subject: 'test-model', relation: 'can_share', object: 'email' });

    assert.strictEqual(result, true);
    nock.cleanAll();
  });
});

describe('OpenFGAClientWrapper.healthCheck()', () => {
  let wrapper: OpenFGAClientWrapper;

  beforeEach(() => {
    process.env.OPENFGA_API_URL = TEST_API_URL;
    process.env.OPENFGA_STORE_ID = TEST_STORE_ID;
    process.env.OPENFGA_MODEL_ID = TEST_MODEL_ID;
    delete process.env.OPENFGA_API_TOKEN;
    const sdk = createSDKClient();
    wrapper = new OpenFGAClientWrapper(sdk);
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('returns true when /healthz returns 200', async () => {
    nock(TEST_API_URL)
      .get('/healthz')
      .reply(200, 'OK');

    const result = await wrapper.healthCheck();

    assert.strictEqual(result, true);
    nock.cleanAll();
  });

  it('returns false when /healthz returns non-2xx', async () => {
    nock(TEST_API_URL)
      .get('/healthz')
      .reply(503, 'Service Unavailable');

    const result = await wrapper.healthCheck();

    assert.strictEqual(result, false);
    nock.cleanAll();
  });

  it('returns false on network error', async () => {
    nock.disableNetConnect();

    const result = await wrapper.healthCheck();

    assert.strictEqual(result, false);
    nock.enableNetConnect();
    nock.cleanAll();
  });
});