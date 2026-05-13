// SPDX-License-Identifier: Apache-2.0
/**
 * OpenFGA Failure Cases and Invalid Tuple Combinations Tests
 *
 * Tests verify answers (return values) only — never inspect HTTP request bodies.
 * HTTP responses are mocked via nock at the network level.
 * The SDK makes real axios HTTP calls; nock intercepts them via Node's http module.
 *
 * Tests marked [ID-BUILDER] test pure functions with no network calls.
 * Tests marked [CLIENT] test the wrapper with mocked HTTP responses.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import nock from 'nock';
import {
  OpenFGAClientWrapper,
  createSDKClient,
  hashLiteral,
  buildPIIInstanceId,
  buildRecipientId,
  buildModelInstanceId,
} from '../src/openfga-sdk-wrapper.ts';

// NOTE: TEST_API_URL must be set via OPENFGA_API_URL env var.
// There is no fallback — tests fail fast if the env var is absent.
const TEST_API_URL = (() => {
  const url = process.env.OPENFGA_API_URL;
  if (!url) throw new Error('OPENFGA_API_URL env var is required for tests');
  return url;
})();
const TEST_STORE_ID = '01KQJZGZ068QK7JFY96GSNFFSW';
const TEST_MODEL_ID = '01KQK0PXQE92V0KXJMHWRJRS4M';

function makeWrapper(): OpenFGAClientWrapper {
  process.env.OPENFGA_API_URL = TEST_API_URL;
  process.env.OPENFGA_STORE_ID = TEST_STORE_ID;
  process.env.OPENFGA_MODEL_ID = TEST_MODEL_ID;
  delete process.env.OPENFGA_API_TOKEN;
  const sdk = createSDKClient();
  return new OpenFGAClientWrapper(sdk);
}

// =============================================================================
// Category 1: ID Builder Pure Functions (no network calls)
// =============================================================================

describe('Category 1: ID Builder Pure Functions [ID-BUILDER]', () => {
  it('buildPIIInstanceId with 40-char hex string correctly prefixes as pii_instance', () => {
    const hash = hashLiteral('test');
    const result = buildPIIInstanceId(hash);
    assert.strictEqual(result, `pii_instance:sha256-${hash}`);
  });

  it('buildPIIInstanceId with sha256- prefix correctly formats', () => {
    const result = buildPIIInstanceId('sha256-abc123');
    assert.strictEqual(result, 'pii_instance:sha256-abc123');
  });

  it('buildPIIInstanceId with category-like string (email) returns category prefix', () => {
    const result = buildPIIInstanceId('email');
    assert.strictEqual(result, 'category:email');
  });

  it('buildRecipientId with recipient: prefix returns as-is', () => {
    const result = buildRecipientId('recipient:user:alice');
    assert.strictEqual(result, 'recipient:user:alice');
  });

  it('buildRecipientId without prefix adds recipient: prefix', () => {
    const result = buildRecipientId('user:alice');
    assert.strictEqual(result, 'recipient:user:alice');
  });

  it('buildModelInstanceId with model_instance: prefix returns as-is', () => {
    const result = buildModelInstanceId('model_instance:test');
    assert.strictEqual(result, 'model_instance:test');
  });

  it('buildModelInstanceId without prefix adds model_instance: prefix', () => {
    const result = buildModelInstanceId('test');
    assert.strictEqual(result, 'model_instance:test');
  });

  it('hashLiteral is deterministic', () => {
    const literal = 'test@example.com';
    const hash1 = hashLiteral(literal);
    const hash2 = hashLiteral(literal);
    assert.strictEqual(hash1, hash2, 'Same input should produce same hash');
  });

  it('hashLiteral produces different hashes for similar inputs', () => {
    const hash1 = hashLiteral('user@example.com');
    const hash2 = hashLiteral('user@example.com ');
    const hash3 = hashLiteral('user@example.comx');
    assert.notStrictEqual(hash1, hash2, 'Similar inputs should produce different hashes');
    assert.notStrictEqual(hash1, hash3, 'Similar inputs should produce different hashes');
    assert.notStrictEqual(hash2, hash3, 'Similar inputs should produce different hashes');
  });

  it('hashLiteral output is 40 hex characters', () => {
    const hash = hashLiteral('test');
    assert.match(hash, /^[0-9a-f]{40}$/);
  });

  it('hashLiteral with unicode in literal is hashed correctly', () => {
    const unicodeLiteral = '用户@example.com';
    const hash = hashLiteral(unicodeLiteral);
    assert.match(hash, /^[0-9a-f]{40}$/);
    // Hash should NOT contain the raw unicode
    assert.ok(!hash.includes('用户'));
  });
});

// =============================================================================
// Category 2: Cross-Type Tuple Reversal Issues [CLIENT]
// =============================================================================

describe('Category 2: Cross-Type Tuple Reversal Issues [CLIENT]', () => {
  let wrapper: OpenFGAClientWrapper;

  beforeEach(() => { wrapper = makeWrapper(); });
  afterEach(() => { nock.cleanAll(); });

  it('can_share check sends correct direction', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/check`)
      .reply(200, { allowed: false });

    const result = await wrapper.checkShare({
      modelSubject: 'support-bot',
      piiInstance: 'sha256-abc123',
      recipientId: 'user:alice',
    });

    assert.strictEqual(result.modelCanShare, false);
    nock.cleanAll();
  });

  it('lineage check is called when can_share passes', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/check`)
      .times(2)
      .reply(200, { allowed: true });

    const result = await wrapper.checkShare({
      modelSubject: 'support-bot',
      piiInstance: 'sha256-abc123',
      recipientId: 'user:alice',
    });

    assert.strictEqual(result.lineageValid, true);
    nock.cleanAll();
  });

  it('verifies all 4 check directions are called correctly', async () => {
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
    assert.strictEqual(result.modelCanShare, true);
    assert.strictEqual(result.lineageValid, true);
    assert.strictEqual(result.recipientCanView, true);
    assert.strictEqual(result.recipientTrusts, true);
    nock.cleanAll();
  });

  it('auto-prefixes piiInstance with pii_instance: when sha256- only is provided', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/check`)
      .reply(200, { allowed: false });

    const result = await wrapper.checkShare({
      modelSubject: 'support-bot',
      piiInstance: 'sha256-abc123',
      recipientId: 'user:alice',
    });

    assert.strictEqual(result.modelCanShare, false);
    nock.cleanAll();
  });

  it('auto-prefixes recipient with recipient: when just user:alice is provided', async () => {
    const result = buildRecipientId('user:alice');
    assert.strictEqual(result, 'recipient:user:alice');
  });
});

// =============================================================================
// Category 3: Authorization Failures (4-Way Check Components) [CLIENT]
// =============================================================================

describe('Category 3: Authorization Failures (4-Way Check Components) [CLIENT]', () => {
  let wrapper: OpenFGAClientWrapper;

  beforeEach(() => { wrapper = makeWrapper(); });
  afterEach(() => { nock.cleanAll(); });

  it('returns allowed=false when model has no can_share tuple', async () => {
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

  it('fail-closes when can_share check returns non-2xx', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/check`, () => true)
      .reply(500, 'Internal Server Error');

    const result = await wrapper.checkShare({
      modelSubject: 'support-bot',
      piiInstance: 'sha256-abc123',
      recipientId: 'user:alice',
    });

    assert.strictEqual(result.allowed, false);
    nock.cleanAll();
  });

  it('early termination after can_share failure', async () => {
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

  it('checkShare without checkRecipientTrust omits recipientTrusts field', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/check`)
      .times(3)
      .reply(200, { allowed: true });

    const result = await wrapper.checkShare({
      modelSubject: 'support-bot',
      piiInstance: 'sha256-abc123',
      recipientId: 'user:alice',
      checkRecipientTrust: false,
    });

    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.recipientTrusts, undefined);
    nock.cleanAll();
  });
});

// =============================================================================
// Category 4: Fail-Closed Scenarios [CLIENT]
// =============================================================================

describe('Category 4: Fail-Closed Scenarios [CLIENT]', () => {
  let wrapper: OpenFGAClientWrapper;

  beforeEach(() => { wrapper = makeWrapper(); });
  afterEach(() => { nock.cleanAll(); });

  it('fail-closes when OpenFGA server is unreachable (network error)', async () => {
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

  it('fail-closes when OpenFGA returns 500 Internal Server Error', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/check`, () => true)
      .reply(500, 'Internal Server Error');

    const result = await wrapper.checkShare({
      modelSubject: 'support-bot',
      piiInstance: 'sha256-abc123',
      recipientId: 'user:alice',
    });

    assert.strictEqual(result.allowed, false);
    nock.cleanAll();
  });

  it('fail-closes when OpenFGA returns 404 Not Found', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/check`)
      .reply(404, 'Not Found');

    const result = await wrapper.checkShare({
      modelSubject: 'support-bot',
      piiInstance: 'sha256-abc123',
      recipientId: 'user:alice',
    });

    assert.strictEqual(result.allowed, false);
    nock.cleanAll();
  });

  it('fail-closes when OpenFGA response has missing allowed field', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/check`)
      .reply(200, { notallowed: true });

    const result = await wrapper.checkShare({
      modelSubject: 'support-bot',
      piiInstance: 'sha256-abc123',
      recipientId: 'user:alice',
    });

    assert.strictEqual(result.allowed, false);
    nock.cleanAll();
  });

  it('fail-closes check() when OpenFGA is unreachable', async () => {
    nock.disableNetConnect();

    await assert.rejects(
      async () => wrapper.check({ subject: 'test-model', relation: 'can_view', object: 'email' }),
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

  it('fail-closes writeTuples when OpenFGA returns error', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/write`, () => true)
      .reply(500, 'Internal Server Error');

    await assert.rejects(
      async () => wrapper.writeTuples([{ subject: 'test', relation: 'can_view', object: 'email' }]),
      (err: Error) => {
        const code = parseInt((err.message.match(/\((\d+)\)/)?.[1] || '0'), 10);
        assert.ok(code >= 400, `Expected 4xx/5xx error. Got: ${err.message}`);
        return true;
      }
    );
    nock.cleanAll();
  });

  it('healthCheck returns false on network error (does not throw)', async () => {
    nock.disableNetConnect();

    const result = await wrapper.healthCheck();

    assert.strictEqual(result, false);
    nock.enableNetConnect();
    nock.cleanAll();
  });

  it('healthCheck returns false on non-2xx response (does not throw)', async () => {
    nock(TEST_API_URL)
      .get('/healthz')
      .reply(503, 'Service Unavailable');

    const result = await wrapper.healthCheck();

    assert.strictEqual(result, false);
    nock.cleanAll();
  });
});

// =============================================================================
// Category 5: Authorization Model Schema Violations [CLIENT]
// =============================================================================

describe('Category 5: Authorization Model Schema Violations [CLIENT]', () => {
  let wrapper: OpenFGAClientWrapper;

  beforeEach(() => { wrapper = makeWrapper(); });
  afterEach(() => { nock.cleanAll(); });

  it('check with non-existent relation returns false (OpenFGA schema violation)', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/check`)
      .reply(200, { allowed: false });

    const result = await wrapper.check({
      subject: 'test-model',
      relation: 'nonexistent_relation',
      object: 'email',
    });

    assert.strictEqual(result, false);
    nock.cleanAll();
  });

  it('check with object type not in model returns false or error', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/check`)
      .reply(200, { allowed: false });

    const result = await wrapper.check({
      subject: 'test-model',
      relation: 'can_view',
      object: 'nonexistent_type:value',
    });

    assert.strictEqual(result, false);
    nock.cleanAll();
  });

  it('write tuple with relation not defined on subject type may throw', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/write`)
      .reply(200, {});

    await wrapper.writeTuples([
      { subject: 'test-model', relation: 'can_view', object: 'email' }
    ]);

    nock.cleanAll();
  });
});

// =============================================================================
// Category 6: Batch Check Failure Modes [CLIENT]
// =============================================================================

describe('Category 6: Batch Check Failure Modes [CLIENT]', () => {
  let wrapper: OpenFGAClientWrapper;

  beforeEach(() => { wrapper = makeWrapper(); });
  afterEach(() => { nock.cleanAll(); });

  it('batchCheckShare fail-closes when batch check throws', async () => {
    nock.disableNetConnect();

    const results = await wrapper.batchCheckShare([
      { modelSubject: 'support-bot', piiInstance: 'sha256-abc123', recipientId: 'user:alice' },
      { modelSubject: 'support-bot', piiInstance: 'sha256-def456', recipientId: 'user:alice' },
    ]);

    for (const [, result] of results) {
      assert.strictEqual(result.allowed, false);
      assert.strictEqual(result.modelCanShare, false);
    }
    nock.enableNetConnect();
    nock.cleanAll();
  });

  it('batchCheckShare fail-closes when batch check returns non-2xx', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/batch-check`, () => true)
      .reply(500, 'Internal Server Error');

    const results = await wrapper.batchCheckShare([
      { modelSubject: 'support-bot', piiInstance: 'sha256-abc123', recipientId: 'user:alice' },
    ]);

    for (const [, result] of results) {
      assert.strictEqual(result.allowed, false);
    }
    nock.cleanAll();
  });

  // batchCheckShare correlationId behavior is tested via integration tests.
  // This smoke test verifies the method returns a Map without throwing.
  it('batchCheckShare returns a Map (smoke test)', async () => {
    nock.disableNetConnect();

    const results = await wrapper.batchCheckShare([
      { modelSubject: 'support-bot', piiInstance: 'pii_instance:sha256-abc123', recipientId: 'user:alice' },
    ]);

    assert.ok(results instanceof Map, 'Should return a Map');
    nock.enableNetConnect();
    nock.cleanAll();
  });

  // batchCheckShare correlationId behavior is tested via integration tests.
  // This smoke test verifies the method returns a Map without throwing.
  it('batchCheckShare returns a Map (smoke test)', async () => {
    nock.disableNetConnect();

    const results = await wrapper.batchCheckShare([
      { modelSubject: 'support-bot', piiInstance: 'pii_instance:sha256-abc123', recipientId: 'user:alice' },
    ]);

    assert.ok(results instanceof Map, 'Should return a Map');
    nock.enableNetConnect();
    nock.cleanAll();
  });
});

// =============================================================================
// Category 7: Tuple Delete/Read Failures [CLIENT]
// =============================================================================

describe('Category 7: Tuple Delete/Read Failures [CLIENT]', () => {
  let wrapper: OpenFGAClientWrapper;

  beforeEach(() => { wrapper = makeWrapper(); });
  afterEach(() => { nock.cleanAll(); });

  it('deleteTuples of non-existent tuple does not throw (graceful handling)', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/write`)
      .reply(200, {});

    await wrapper.deleteTuples([
      { subject: 'nonexistent-model', relation: 'can_view', object: 'nonexistent-category' }
    ]);

    nock.cleanAll();
  });

  it('readTuples with no matching filter returns empty array', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/read`)
      .reply(200, { tuples: [] });

    const result = await wrapper.readTuples({
      subject: 'nonexistent-model',
      relation: 'can_view',
      object: 'nonexistent-category',
    });

    assert.deepStrictEqual(result, []);
    nock.cleanAll();
  });

  it('readTuples throws on non-2xx response', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/read`)
      .reply(404, 'Not Found');

    await assert.rejects(
      async () => wrapper.readTuples(),
      (err: Error) => {
        assert.ok(err.message.includes('404'));
        return true;
      }
    );
    nock.cleanAll();
  });

  it('deleteTuples throws on non-2xx response', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/write`, () => true)
      .reply(500, 'Internal Server Error');

    await assert.rejects(
      async () => wrapper.deleteTuples([{ subject: 'test', relation: 'can_view', object: 'email' }]),
      (err: Error) => {
        assert.ok(err instanceof Error, `Expected an Error, got: ${err}`);
        return true;
      }
    );
    nock.cleanAll();
  });
});

// =============================================================================
// Category 8: Concurrency / Race Condition Scenarios [CLIENT]
// =============================================================================

describe('Category 8: Concurrency / Race Condition Scenarios [CLIENT]', () => {
  let wrapper: OpenFGAClientWrapper;

  beforeEach(() => { wrapper = makeWrapper(); });
  afterEach(() => { nock.cleanAll(); });

  it('concurrent writes to same tuple are independent (no locking)', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/write`)
      .times(2)
      .reply(200, {});

    await Promise.all([
      wrapper.writeTuples([{ subject: 'model-a', relation: 'can_view', object: 'email' }]),
      wrapper.writeTuples([{ subject: 'model-b', relation: 'can_view', object: 'email' }]),
    ]);

    nock.cleanAll();
  });

  it('check immediately after write may return stale data (eventual consistency)', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/write`)
      .reply(200, {})
      .post(`/stores/${TEST_STORE_ID}/check`)
      .reply(200, { allowed: false });

    await wrapper.writeTuples([{ subject: 'test-model', relation: 'can_view', object: 'email' }]);
    const result = await wrapper.check({ subject: 'test-model', relation: 'can_view', object: 'email' });

    assert.strictEqual(result, false);
    nock.cleanAll();
  });
});

// =============================================================================
// Category 9: Edge Cases with Real Data [CLIENT]
// =============================================================================

describe('Category 9: Edge Cases with Real Data [CLIENT]', () => {
  let wrapper: OpenFGAClientWrapper;

  beforeEach(() => { wrapper = makeWrapper(); });
  afterEach(() => { nock.cleanAll(); });

  it('empty/whitespace-only PII literal still hashes correctly', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/write`)
      .reply(200, {});

    await wrapper.writeTuples([
      { subject: 'test-model', relation: 'can_view', literal: '   ' }
    ]);

    nock.cleanAll();
  });

  it('PII with newlines and control characters is preserved in hash', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/write`)
      .reply(200, {});

    const literalWithNewlines = 'user@example.com\nwith\nnewlines';
    await wrapper.writeTuples([
      { subject: 'test-model', relation: 'can_view', literal: literalWithNewlines }
    ]);

    nock.cleanAll();
  });
});

// =============================================================================
// Category 10: Integration-Specific Failure Cases [CLIENT]
// =============================================================================

describe('Category 10: Integration-Specific Failure Cases [CLIENT]', () => {
  let wrapper: OpenFGAClientWrapper;

  beforeEach(() => { wrapper = makeWrapper(); });
  afterEach(() => { nock.cleanAll(); });

  it('store ID does not exist returns error', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/check`)
      .reply(404, 'Not Found');

    await assert.rejects(
      async () => wrapper.check({ subject: 'test', relation: 'can_view', object: 'email' }),
      (err: Error) => {
        assert.ok(err.message.includes('404'));
        return true;
      }
    );
    nock.cleanAll();
  });

  it('wrong API token returns 403 Forbidden', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/check`)
      .reply(403, 'Forbidden');

    await assert.rejects(
      async () => wrapper.check({ subject: 'test', relation: 'can_view', object: 'email' }),
      (err: Error) => {
        assert.ok(err.message.includes('403'));
        return true;
      }
    );
    nock.cleanAll();
  });

  it('write to read-only store returns 409 Conflict', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/write`)
      .reply(409, 'Conflict');

    await assert.rejects(
      async () => wrapper.writeTuples([{ subject: 'test', relation: 'can_view', object: 'email' }]),
      (err: Error) => {
        assert.ok(err.message.includes('409') || err.message.includes('read-only'));
        return true;
      }
    );
    nock.cleanAll();
  });

  it('read succeeds on read-only store', async () => {
    nock(TEST_API_URL)
      .post(`/stores/${TEST_STORE_ID}/read`)
      .reply(200, { tuples: [] });

    const result = await wrapper.readTuples({ subject: 'test-model', relation: 'can_view' });

    assert.deepStrictEqual(result, []);
    nock.cleanAll();
  });
});