// SPDX-License-Identifier: Apache-2.0
/**
 * OpenFGAClientWrapper.checkShare() Unit Tests
 *
 * Tests verify answers (ShareCheckResult) only — never inspect HTTP request bodies.
 * HTTP responses are mocked via nock at the network level.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import nock from 'nock';
import { OpenFGAClientWrapper, createSDKClient } from '../src/openfga-sdk-wrapper.ts';

const TEST_API_URL = 'http://172.19.0.4:8080';
const TEST_STORE_ID = '01KQJZGZ068QK7JFY96GSNFFSW';
const TEST_MODEL_ID = '01KQK0PXQE92V0KXJMHWRJRS4M';

describe('OpenFGAClientWrapper.checkShare()', () => {
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

  it('returns allowed=true when all checks pass', async () => {
    // All 3 checks (without recipient trust) return allowed=true
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/check`)
      .times(3)
      .reply(200, { allowed: true });

    const result = await wrapper.checkShare({
      modelSubject: 'support-bot',
      piiInstance: 'sha256-abc123',
      recipientId: 'user:alice',
    });

    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.modelCanShare, true);
    assert.strictEqual(result.lineageValid, true);
    assert.strictEqual(result.recipientCanView, true);
    nock.cleanAll();
  });

  it('returns allowed=false when model cannot share (can_share check fails)', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/check`)
      .reply(200, { allowed: false });

    const result = await wrapper.checkShare({
      modelSubject: 'support-bot',
      piiInstance: 'sha256-abc123',
      recipientId: 'user:alice',
    });

    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.modelCanShare, false);
    nock.cleanAll();
  });

  it('fail-closes when can_share check throws network error', async () => {
    nock.disableNetConnect();

    const result = await wrapper.checkShare({
      modelSubject: 'support-bot',
      piiInstance: 'sha256-abc123',
      recipientId: 'user:alice',
    });

    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.modelCanShare, false);
    nock.enableNetConnect();
    nock.cleanAll();
  });

  it('fail-closes when can_share check returns non-2xx', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/check`)
      .reply(500, 'Internal Server Error');

    const result = await wrapper.checkShare({
      modelSubject: 'support-bot',
      piiInstance: 'sha256-abc123',
      recipientId: 'user:alice',
    });

    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.modelCanShare, false);
    nock.cleanAll();
  });

  it('auto-prefixes piiInstance with pii_instance: when not provided', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/check`)
      .reply(200, { allowed: false });

    // With can_share=false, only one call is made
    const result = await wrapper.checkShare({
      modelSubject: 'support-bot',
      piiInstance: 'sha256-abc123', // Without pii_instance: prefix
      recipientId: 'user:alice',
    });

    assert.strictEqual(result.modelCanShare, false);
    nock.cleanAll();
  });

  it('uses correct URL with store ID', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/check`)
      .reply(200, { allowed: false });

    await wrapper.checkShare({
      modelSubject: 'support-bot',
      piiInstance: 'sha256-abc123',
      recipientId: 'user:alice',
    });

    nock.cleanAll();
  });

  it('includes recipientTrusts when checkRecipientTrust is true and all pass', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/check`)
      .times(4)
      .reply(200, { allowed: true });

    const result = await wrapper.checkShare({
      modelSubject: 'support-bot',
      piiInstance: 'sha256-abc123',
      recipientId: 'user:alice',
      checkRecipientTrust: true,
    });

    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.recipientTrusts, true);
    nock.cleanAll();
  });

  it('fail-closes when any check throws', async () => {
    nock.disableNetConnect();

    const result = await wrapper.checkShare({
      modelSubject: 'support-bot',
      piiInstance: 'sha256-abc123',
      recipientId: 'user:alice',
    });

    assert.strictEqual(result.allowed, false);
    nock.enableNetConnect();
    nock.cleanAll();
  });

  it('fail-closes when check returns non-2xx', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/check`)
      .reply(503, 'Service Unavailable');

    const result = await wrapper.checkShare({
      modelSubject: 'support-bot',
      piiInstance: 'sha256-abc123',
      recipientId: 'user:alice',
    });

    assert.strictEqual(result.allowed, false);
    nock.cleanAll();
  });
});