// SPDX-License-Identifier: Apache-2.0
/**
 * OpenFGAClientWrapper.writeTuples() Unit Tests
 *
 * Tests verify answers (return values) only — never inspect HTTP request bodies.
 * HTTP responses are mocked via nock at the network level.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import nock from 'nock';
import { OpenFGAClientWrapper, createSDKClient } from '../src/openfga-sdk-wrapper.ts';

const TEST_API_URL = 'http://172.19.0.4:8080';
const TEST_STORE_ID = '01KQJZGZ068QK7JFY96GSNFFSW';
const TEST_MODEL_ID = '01KQK0PXQE92V0KXJMHWRJRS4M';

describe('OpenFGAClientWrapper.writeTuples()', () => {
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

  it('writes tuples successfully', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/write`)
      .reply(200, { writes: [], deletes: [] });

    await wrapper.writeTuples([
      { subject: 'test-model', relation: 'can_view', object: 'email' }
    ]);

    nock.cleanAll();
  });

  it('throws on non-2xx response with status in error message', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/write`, () => true)
      .reply(500, { message: 'Write operation failed' });

    await assert.rejects(
      async () => wrapper.writeTuples([
        { subject: 'test-model', relation: 'can_view', object: 'email' }
      ]),
      (err: Error) => {
        assert.ok(err instanceof Error, `Expected an Error, got: ${err}`);
        return true;
      }
    );
    nock.cleanAll();
  });

  it('throws on non-2xx response with empty body', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/write`, () => true)
      .reply(400, '');

    await assert.rejects(
      async () => wrapper.writeTuples([
        { subject: 'test-model', relation: 'can_view', object: 'email' }
      ]),
      (err: Error) => {
        assert.ok(err.message.includes('400'), `Error should include status code. Got: ${err.message}`);
        return true;
      }
    );
    nock.cleanAll();
  });

  it('throws on network error', async () => {
    nock.disableNetConnect();

    await assert.rejects(
      async () => wrapper.writeTuples([
        { subject: 'test-model', relation: 'can_view', object: 'email' }
      ]),
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

describe('OpenFGAClientWrapper.deleteTuples()', () => {
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

  it('deletes tuples successfully', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/write`)
      .reply(200, { writes: [], deletes: [] });

    await wrapper.deleteTuples([
      { subject: 'test-model', relation: 'can_view', object: 'email' }
    ]);

    nock.cleanAll();
  });

  it('throws on non-2xx response with status in error message', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/write`)
      .reply(500, { message: 'Delete operation failed' });

    await assert.rejects(
      async () => wrapper.deleteTuples([
        { subject: 'test-model', relation: 'can_view', object: 'email' }
      ]),
      (err: Error) => {
        assert.ok(err instanceof Error, `Expected an Error, got: ${err}`);
        return true;
      }
    );
    nock.cleanAll();
  });

  it('throws on network error', async () => {
    nock.disableNetConnect();

    await assert.rejects(
      async () => wrapper.deleteTuples([
        { subject: 'test-model', relation: 'can_view', object: 'email' }
      ]),
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