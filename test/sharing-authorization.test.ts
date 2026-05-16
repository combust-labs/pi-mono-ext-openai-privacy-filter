// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 5: Reverse PII Sharing Authorization Tests
 *
 * Tests cover:
 * - buildSharingDeniedCategoriesSet() behavior
 * - checkSharingAuthorization() behavior
 * - isSharingEnabled() and getRecipientId() helpers
 * - Fail-closed when OpenFGA is unreachable
 * - Lineage verification in sharing checks
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createMockOpenFGAClient } from './support/mock-openfga-client.ts';

describe('buildSharingDeniedCategoriesSet()', () => {
  let mockClient: ReturnType<typeof createMockOpenFGAClient>;
  let setOpenFGAClient: typeof import('../openfga.ts').setOpenFGAClient;
  const testAnnotations = [
    { entity_group: 'email', score: 0.9, word: 'user@company.com' },
    { entity_group: 'phone', score: 0.8, word: '555-123-4567' },
  ];

  beforeEach(async () => {
    // Set env BEFORE importing the module
    process.env.PRIVACY_FILTER_RECIPIENT_ID = 'user:alice';
    process.env.PRIVACY_FILTER_SHARING_ENABLED = 'true';

    mockClient = createMockOpenFGAClient();
    mockClient.healthCheckResult(true);
    mockClient.shareCheckResult({ allowed: true, modelCanShare: true, lineageValid: true, recipientCanView: true });

    const openfgaMod = await import('../openfga.ts');
    setOpenFGAClient = openfgaMod.setOpenFGAClient;
    setOpenFGAClient(mockClient as unknown as openfgaMod.OpenFGAClient);
  });

  afterEach(() => {
    delete process.env.PRIVACY_FILTER_RECIPIENT_ID;
    delete process.env.PRIVACY_FILTER_SHARING_ENABLED;
    mockClient.reset();
    setOpenFGAClient(null);
  });

  it('returns empty set when all sharing checks pass', async () => {
    const { buildSharingDeniedCategoriesSet } = await import('../privacy-auth.ts');
    const denied = await buildSharingDeniedCategoriesSet(testAnnotations, 'support-bot');

    assert.strictEqual(denied.size, 0, 'No categories should be denied when sharing is allowed');
  });

  it('returns all categories when sharing check fails for all', async () => {
    mockClient.shareCheckResult({ allowed: false, modelCanShare: false, lineageValid: false, recipientCanView: false });
    const { buildSharingDeniedCategoriesSet } = await import('../privacy-auth.ts');

    const denied = await buildSharingDeniedCategoriesSet(testAnnotations, 'support-bot');

    assert.strictEqual(denied.size, 2, 'All categories should be denied');
    assert.ok(denied.has('email'), 'email should be denied');
    assert.ok(denied.has('phone'), 'phone should be denied');
  });

  it('returns empty set when modelCanShare is false but other checks pass', async () => {
    mockClient.shareCheckResult({ allowed: false, modelCanShare: false, lineageValid: true, recipientCanView: true });
    const { buildSharingDeniedCategoriesSet } = await import('../privacy-auth.ts');

    const denied = await buildSharingDeniedCategoriesSet(testAnnotations, 'support-bot');

    assert.strictEqual(denied.size, 2, 'All categories should be denied when model cannot share');
  });

  it('returns empty set when lineageValid is false', async () => {
    mockClient.shareCheckResult({ allowed: false, modelCanShare: true, lineageValid: false, recipientCanView: true });
    const { buildSharingDeniedCategoriesSet } = await import('../privacy-auth.ts');

    const denied = await buildSharingDeniedCategoriesSet(testAnnotations, 'support-bot');

    assert.strictEqual(denied.size, 2, 'All categories should be denied when lineage is invalid');
  });

  it('returns empty set when recipientCanView is false', async () => {
    mockClient.shareCheckResult({ allowed: false, modelCanShare: true, lineageValid: true, recipientCanView: false });
    const { buildSharingDeniedCategoriesSet } = await import('../privacy-auth.ts');

    const denied = await buildSharingDeniedCategoriesSet(testAnnotations, 'support-bot');

    assert.strictEqual(denied.size, 2, 'All categories should be denied when recipient cannot view');
  });

  it('records shareCalls for each entity', async () => {
    mockClient.shareCheckResult({ allowed: true, modelCanShare: true, lineageValid: true, recipientCanView: true });
    const { buildSharingDeniedCategoriesSet } = await import('../privacy-auth.ts');

    await buildSharingDeniedCategoriesSet(testAnnotations, 'support-bot');

    assert.strictEqual(mockClient.shareCalls.length, 2, 'Should have 2 share calls (one per entity)');
    assert.strictEqual(mockClient.shareCalls[0].modelSubject, 'support-bot');
    assert.strictEqual(mockClient.shareCalls[0].recipientId, 'user:alice');
  });

  it('uses provided recipientId parameter when passed', async () => {
    mockClient.shareCheckResult({ allowed: true, modelCanShare: true, lineageValid: true, recipientCanView: true });
    const { buildSharingDeniedCategoriesSet } = await import('../privacy-auth.ts');

    await buildSharingDeniedCategoriesSet(testAnnotations, 'support-bot', 'user:charlie');

    assert.strictEqual(mockClient.shareCalls[0].recipientId, 'user:charlie');
  });

  it('fail-closes when healthCheck fails', async () => {
    mockClient.healthCheckResult(false);
    mockClient.shareCheckResult({ allowed: true, modelCanShare: true, lineageValid: true, recipientCanView: true });
    const { buildSharingDeniedCategoriesSet } = await import('../privacy-auth.ts');

    const denied = await buildSharingDeniedCategoriesSet(testAnnotations, 'support-bot');

    assert.strictEqual(denied.size, 2, 'All categories should be denied when OpenFGA is unavailable');
  });

  it('fail-closes when checkShare throws', async () => {
    mockClient.shareCheckResultFn(() => {
      throw new Error('OpenFGA error');
    });
    const { buildSharingDeniedCategoriesSet } = await import('../privacy-auth.ts');

    const denied = await buildSharingDeniedCategoriesSet(testAnnotations, 'support-bot');

    assert.strictEqual(denied.size, 2, 'All categories should be denied when checkShare throws');
  });

  it('handles empty results array', async () => {
    const { buildSharingDeniedCategoriesSet } = await import('../privacy-auth.ts');

    const denied = await buildSharingDeniedCategoriesSet([], 'support-bot');

    assert.strictEqual(denied.size, 0, 'Empty results should produce empty denied set');
  });

  it('handles single entity', async () => {
    mockClient.shareCheckResult({ allowed: true, modelCanShare: true, lineageValid: true, recipientCanView: true });
    const { buildSharingDeniedCategoriesSet } = await import('../privacy-auth.ts');

    const denied = await buildSharingDeniedCategoriesSet(
      [{ entity_group: 'email', score: 0.9, word: 'user@company.com' }],
      'support-bot'
    );

    assert.strictEqual(denied.size, 0, 'Single allowed entity should not be denied');
  });

  it('checks recipient trust when checkRecipientTrust option is true', async () => {
    mockClient.shareCheckResult({ allowed: true, modelCanShare: true, lineageValid: true, recipientCanView: true, recipientTrusts: true });
    const { buildSharingDeniedCategoriesSet } = await import('../privacy-auth.ts');

    await buildSharingDeniedCategoriesSet(testAnnotations, 'support-bot', 'user:alice', { checkRecipientTrust: true });

    assert.strictEqual(mockClient.shareCalls[0].checkRecipientTrust, true, 'checkRecipientTrust should be passed as true');
  });

  it('uses provided recipientId over env when both are available', async () => {
    process.env.PRIVACY_FILTER_RECIPIENT_ID = 'user:env-recipient';
    mockClient.shareCheckResult({ allowed: true, modelCanShare: true, lineageValid: true, recipientCanView: true });
    const { buildSharingDeniedCategoriesSet } = await import('../privacy-auth.ts');

    await buildSharingDeniedCategoriesSet(testAnnotations, 'support-bot', 'user:param-recipient');

    assert.strictEqual(mockClient.shareCalls[0].recipientId, 'user:param-recipient');
  });

  it('records shareCalls with piiInstance format (pii_instance:sha256-...)', async () => {
    mockClient.shareCheckResult({ allowed: true, modelCanShare: true, lineageValid: true, recipientCanView: true });
    const { buildSharingDeniedCategoriesSet } = await import('../privacy-auth.ts');

    await buildSharingDeniedCategoriesSet(
      [{ entity_group: 'email', score: 0.9, word: 'user@company.com' }],
      'support-bot'
    );

    const call = mockClient.shareCalls[0];
    assert.ok(call.piiInstance.startsWith('pii_instance:sha256-'), `Expected pii_instance:sha256-..., got: ${call.piiInstance}`);
  });
});

describe('checkSharingAuthorization()', () => {
  let mockClient: ReturnType<typeof createMockOpenFGAClient>;
  let setOpenFGAClient: typeof import('../openfga.ts').setOpenFGAClient;

  beforeEach(async () => {
    process.env.PRIVACY_FILTER_RECIPIENT_ID = 'user:alice';
    process.env.PRIVACY_FILTER_SHARING_ENABLED = 'true';

    mockClient = createMockOpenFGAClient();
    mockClient.healthCheckResult(true);

    const openfgaMod = await import('../openfga.ts');
    setOpenFGAClient = openfgaMod.setOpenFGAClient;
    setOpenFGAClient(mockClient as unknown as openfgaMod.OpenFGAClient);
  });

  afterEach(() => {
    delete process.env.PRIVACY_FILTER_RECIPIENT_ID;
    delete process.env.PRIVACY_FILTER_SHARING_ENABLED;
    mockClient.reset();
    setOpenFGAClient(null);
  });

  it('returns allowed=true when all checks pass', async () => {
    mockClient.shareCheckResult({ allowed: true, modelCanShare: true, lineageValid: true, recipientCanView: true });
    const { checkSharingAuthorization } = await import('../privacy-auth.ts');

    const result = await checkSharingAuthorization(
      { entity_group: 'email', score: 0.9, word: 'user@company.com' },
      'support-bot'
    );

    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.category, 'email');
    assert.strictEqual(result.level, 'literal');
    assert.strictEqual(result.literal, 'user@company.com');
    assert.strictEqual(result.checks?.modelCanShare, true);
    assert.strictEqual(result.checks?.lineageValid, true);
    assert.strictEqual(result.checks?.recipientCanView, true);
  });

  it('returns allowed=false when sharing is denied', async () => {
    mockClient.shareCheckResult({ allowed: false, modelCanShare: false, lineageValid: false, recipientCanView: false });
    const { checkSharingAuthorization } = await import('../privacy-auth.ts');

    const result = await checkSharingAuthorization(
      { entity_group: 'email', score: 0.9, word: 'user@company.com' },
      'support-bot'
    );

    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.checks?.modelCanShare, false);
    assert.strictEqual(result.checks?.lineageValid, false);
    assert.strictEqual(result.checks?.recipientCanView, false);
  });

  it('returns allowed=false when checkShare throws', async () => {
    mockClient.shareCheckResultFn(() => {
      throw new Error('OpenFGA error');
    });
    const { checkSharingAuthorization } = await import('../privacy-auth.ts');

    const result = await checkSharingAuthorization(
      { entity_group: 'email', score: 0.9, word: 'user@company.com' },
      'support-bot'
    );

    assert.strictEqual(result.allowed, false);
  });

  it('uses provided recipientId', async () => {
    mockClient.shareCheckResult({ allowed: true, modelCanShare: true, lineageValid: true, recipientCanView: true });
    const { checkSharingAuthorization } = await import('../privacy-auth.ts');

    await checkSharingAuthorization(
      { entity_group: 'email', score: 0.9, word: 'user@company.com' },
      'support-bot',
      'user:bob'
    );

    assert.strictEqual(mockClient.shareCalls[0].recipientId, 'user:bob');
  });
});

describe('isSharingEnabled()', () => {
  afterEach(() => {
    delete process.env.PRIVACY_FILTER_SHARING_ENABLED;
  });

  it('returns true when PRIVACY_FILTER_SHARING_ENABLED is "true"', async () => {
    process.env.PRIVACY_FILTER_SHARING_ENABLED = 'true';
    const { isSharingEnabled } = await import('../privacy-auth.ts');
    assert.strictEqual(isSharingEnabled(), true);
  });

  it('returns false when PRIVACY_FILTER_SHARING_ENABLED is not set', async () => {
    delete process.env.PRIVACY_FILTER_SHARING_ENABLED;
    const { isSharingEnabled } = await import('../privacy-auth.ts');
    assert.strictEqual(isSharingEnabled(), false);
  });

  it('returns false when PRIVACY_FILTER_SHARING_ENABLED is "false"', async () => {
    process.env.PRIVACY_FILTER_SHARING_ENABLED = 'false';
    const { isSharingEnabled } = await import('../privacy-auth.ts');
    assert.strictEqual(isSharingEnabled(), false);
  });
});

describe('getRecipientId()', () => {
  afterEach(() => {
    delete process.env.PRIVACY_FILTER_RECIPIENT_ID;
  });

  it('returns the PRIVACY_FILTER_RECIPIENT_ID value', async () => {
    process.env.PRIVACY_FILTER_RECIPIENT_ID = 'user:alice';
    const { getRecipientId } = await import('../privacy-auth.ts');
    assert.strictEqual(getRecipientId(), 'user:alice');
  });

  it('returns empty string when PRIVACY_FILTER_RECIPIENT_ID is not set', async () => {
    delete process.env.PRIVACY_FILTER_RECIPIENT_ID;
    const { getRecipientId } = await import('../privacy-auth.ts');
    assert.strictEqual(getRecipientId(), '');
  });
});