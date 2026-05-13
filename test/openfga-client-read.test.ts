// SPDX-License-Identifier: Apache-2.0
/**
 * OpenFGAClientWrapper.readTuples() Unit Tests
 *
 * Tests verify answers (return values) only — never inspect HTTP request bodies.
 * HTTP responses are mocked via nock at the network level.
 * readTuples uses the SDK's read() method which sends POST /stores/{id}/read.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import nock from 'nock';
import { OpenFGAClientWrapper, createSDKClient } from '../src/openfga-sdk-wrapper.ts';

const TEST_API_URL = 'http://172.19.0.4:8080';
const TEST_STORE_ID = '01KQJZGZ068QK7JFY96GSNFFSW';
const TEST_MODEL_ID = '01KQK0PXQE92V0KXJMHWRJRS4M';

describe('OpenFGAClientWrapper.readTuples()', () => {
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

  it('returns result.tuples array from response body', async () => {
    const mockTuples = [
      { user: 'model_instance:test-model', relation: 'can_view', object: 'privacy_category:email' },
      { user: 'model_instance:test-model', relation: 'can_view', object: 'privacy_category:sha256-abc123' },
    ];
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/read`)
      .reply(200, { tuples: mockTuples });

    const result = await wrapper.readTuples();

    assert.ok(Array.isArray(result), 'Result should be an array');
    assert.strictEqual(result.length, 2, 'Should return all tuples');
    assert.deepStrictEqual(result, mockTuples, 'Should return exact tuples from response');
    nock.cleanAll();
  });

  it('returns empty array when response has no tuples', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/read`)
      .reply(200, { tuples: [] });

    const result = await wrapper.readTuples();

    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, 0);
    nock.cleanAll();
  });

  it('sends correct URL with store ID and /read endpoint', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/read`)
      .reply(200, { tuples: [] });

    await wrapper.readTuples();

    nock.cleanAll();
  });

  it('sends Authorization header with Bearer token when OPENFGA_API_TOKEN is set', async () => {
    process.env.OPENFGA_API_TOKEN = 'test-token-abc123';

    nock(TEST_API_URL, { reqheaders: { Authorization: 'Bearer test-token-abc123' } })
      .post(`/stores/${TEST_STORE_ID}/read`)
      .reply(200, { tuples: [] });

    // Need to recreate wrapper to pick up the new env
    const sdk = createSDKClient();
    const w2 = new OpenFGAClientWrapper(sdk);
    await w2.readTuples();

    delete process.env.OPENFGA_API_TOKEN;
    nock.cleanAll();
  });

  it('throws on non-2xx response with status and body in error message', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/read`, () => true)
      .reply(404, { message: 'Store not found' });

    await assert.rejects(
      async () => wrapper.readTuples(),
      (err: Error) => {
        assert.ok(err.message.includes('404'), `Error should include status code. Got: ${err.message}`);
        return true;
      }
    );
    nock.cleanAll();
  });

  it('throws on non-2xx response with empty body', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/read`, () => true)
      .reply(500, '');

    await assert.rejects(
      async () => wrapper.readTuples(),
      (err: Error) => {
        assert.ok(err instanceof Error, `Expected an Error, got: ${err}`);
        return true;
      }
    );
    nock.cleanAll();
  });

  it('throws on network errors with descriptive message', async () => {
    nock.disableNetConnect();

    await assert.rejects(
      async () => wrapper.readTuples(),
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
});