// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 4.3: buildDeniedCategoriesSet() Unit Tests
 *
 * Tests buildDeniedCategoriesSet(), which:
 * - Groups entities by category and checks category-level first
 * - If category-level fails, checks each literal individually
 * - Fail-closes (masks all) if OpenFGA is unreachable
 * - Only denies categories where BOTH category and all literal checks fail
 *
 * Test infrastructure:
 * - Mock OpenFGA client via setOpenFGAClient() in openfga.ts
 * - createMockOpenFGAClient() from test/support/mock-openfga-client.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createMockOpenFGAClient, type MockOpenFGAClient, type RecordedCall } from './support/mock-openfga-client.ts';
import { setOpenFGAClient, type OpenFGAClient } from '../openfga.ts';
import { buildDeniedCategoriesSet, type AggregatedAnnotation } from '../privacy-auth.ts';

function makeEntity(group: string, word: string, score = 0.99): AggregatedAnnotation {
  return { entity_group: group, score, word };
}

describe('buildDeniedCategoriesSet()', () => {
  let mock: MockOpenFGAClient;

  beforeEach(() => {
    mock = createMockOpenFGAClient();
    setOpenFGAClient(mock as unknown as import('../openfga.ts').OpenFGAClient);
  });

  afterEach(() => {
    mock.reset();
    setOpenFGAClient(null); // reset to lazy-initialized real client
  });

  // -------------------------------------------------------------------------
  // Fail-closed behavior
  // -------------------------------------------------------------------------

  it('fail-closed when OpenFGA throws on first category-level check', async () => {
    mock.throwError(new Error('OpenFGA unavailable'));

    const results = [
      makeEntity('private_email', 'user@company.com'),
      makeEntity('phone_number', '555-123-4567'),
    ];

    const denied = await buildDeniedCategoriesSet(results, 'model-1');

    assert.strictEqual(denied.size, 2, 'All categories should be denied when OpenFGA throws');
    assert.ok(denied.has('private_email'), 'private_email should be denied');
    assert.ok(denied.has('phone_number'), 'phone_number should be denied');
  });

  it('fail-closed when OpenFGA throws mid-batch after some category checks succeed', async () => {
    // Allow first category, throw error on second
    let callCount = 0;
    mock.checkResultFn((call) => {
      callCount++;
      if (callCount === 1) return true; // first category allowed
      throw new Error('OpenFGA unavailable');
    });

    const results = [
      makeEntity('private_email', 'user@company.com'),
      makeEntity('phone_number', '555-123-4567'),
      makeEntity('secret', 'api-key-123'),
    ];

    const denied = await buildDeniedCategoriesSet(results, 'model-1');

    // All categories denied due to error mid-batch — no partial results used
    assert.strictEqual(denied.size, 3, 'All categories should be denied on mid-batch error');
    assert.ok(denied.has('private_email'));
    assert.ok(denied.has('phone_number'));
    assert.ok(denied.has('secret'));
  });

  // -------------------------------------------------------------------------
  // Happy path: all allowed / all denied
  // -------------------------------------------------------------------------

  it('returns empty set when all categories pass category-level check', async () => {
    mock.checkResult(true); // all category-level checks return true

    const results = [
      makeEntity('private_email', 'user@company.com'),
      makeEntity('private_email', 'admin@company.com'),
      makeEntity('phone_number', '555-123-4567'),
    ];

    const denied = await buildDeniedCategoriesSet(results, 'model-1');

    assert.strictEqual(denied.size, 0, 'No categories should be denied');
  });

  it('returns empty set when at least one literal passes but category-level fails', async () => {
    // Category-level returns false, but one literal returns true
    mock.checkResultFn((call) => {
      if (call.literal) return true; // all literal-level checks pass
      return false; // category-level checks fail
    });

    const results = [
      makeEntity('private_email', 'user@company.com'),
      makeEntity('private_email', 'admin@company.com'),
    ];

    const denied = await buildDeniedCategoriesSet(results, 'model-1');

    assert.strictEqual(denied.size, 0, 'No categories should be denied when at least one literal passes');
  });

  it('returns only categories that fail BOTH category-level AND all literal checks', async () => {
    // private_email: category-level false, all literal-level false → denied
    // phone_number: category-level true → allowed
    mock.checkResultFn((call) => {
      if (call.object === 'phone_number') return true; // category allowed
      if (call.object === 'private_email') return false; // category denied
      return false;
    });

    const results = [
      makeEntity('private_email', 'user@company.com'),
      makeEntity('phone_number', '555-123-4567'),
    ];

    const denied = await buildDeniedCategoriesSet(results, 'model-1');

    assert.strictEqual(denied.size, 1);
    assert.ok(denied.has('private_email'), 'private_email should be denied');
    assert.ok(!denied.has('phone_number'), 'phone_number should be allowed');
  });

  // -------------------------------------------------------------------------
  // Mixed results
  // -------------------------------------------------------------------------



  it('one category allowed (category-level), one denied (category-level fails and all literals fail)', async () => {
    // private_email: category-level true → allowed
    // phone_number: category-level false, literals false → denied
    mock.checkResultFn((call) => {
      if (call.object === 'private_email') return true;
      if (call.object === 'phone_number') return false;
      return false;
    });

    const results = [
      makeEntity('private_email', 'user@company.com'),
      makeEntity('phone_number', '555-123-4567'),
    ];

    const denied = await buildDeniedCategoriesSet(results, 'model-1');

    assert.strictEqual(denied.size, 1);
    assert.ok(!denied.has('private_email'), 'private_email should be allowed');
    assert.ok(denied.has('phone_number'), 'phone_number should be denied');
  });

  // -------------------------------------------------------------------------
  // Call counting and ordering
  // -------------------------------------------------------------------------

  it('makes exactly one category-level check per unique category (not per entity)', async () => {
    mock.checkResult(false); // default: deny everything

    const results = [
      makeEntity('private_email', 'user@company.com'),
      makeEntity('private_email', 'admin@company.com'),
      makeEntity('private_email', 'test@company.com'),
      makeEntity('phone_number', '555-123-4567'),
      makeEntity('phone_number', '555-987-6543'),
    ];

    await buildDeniedCategoriesSet(results, 'model-1');

    // Count how many unique categories were checked at category-level
    // private_email entities: 3 → 1 category-level check
    // phone_number entities: 2 → 1 category-level check
    const categoryCalls = mock.calls.filter(c => !c.literal && c.object && !c.object.startsWith('sha256-'));

    assert.strictEqual(categoryCalls.length, 2, 'Should make exactly 2 category-level checks for 2 unique categories');
    const categories = new Set(categoryCalls.map(c => c.object));
    assert.ok(categories.has('private_email'), 'Should check private_email category');
    assert.ok(categories.has('phone_number'), 'Should check phone_number category');
  });

  it('short-circuits on first error — no additional check() calls after throw', async () => {
    let callCount = 0;
    mock.checkResultFn((call) => {
      callCount++;
      if (callCount >= 2) throw new Error('OpenFGA unavailable');
      return false;
    });

    const results = [
      makeEntity('private_email', 'user@company.com'),
      makeEntity('private_email', 'admin@company.com'),
      makeEntity('phone_number', '555-123-4567'),
    ];

    await buildDeniedCategoriesSet(results, 'model-1');

    // Should have stopped after error on 2nd call (first category check succeeded or first literal)
    // The function should have tried at most 2 calls before the error stopped it
    assert.ok(callCount <= 2, `Expected at most 2 calls before error, got ${callCount}`);
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it('handles empty results array', async () => {
    mock.checkResult(true); // should not be called

    const denied = await buildDeniedCategoriesSet([], 'model-1');

    assert.strictEqual(denied.size, 0, 'Empty results should return empty set');
    assert.strictEqual(mock.calls.length, 0, 'No OpenFGA calls should be made');
  });

  it('handles single entity', async () => {
    mock.checkResult(true); // category-level allowed

    const results = [makeEntity('private_email', 'user@company.com')];

    const denied = await buildDeniedCategoriesSet(results, 'model-1');

    assert.strictEqual(denied.size, 0, 'Single allowed entity should not be denied');
    assert.strictEqual(mock.calls.length, 1, 'One category-level check should be made');
  });

  it('uses correct model subject in check calls', async () => {
    mock.checkResult(false);

    const results = [makeEntity('private_email', 'user@company.com')];

    await buildDeniedCategoriesSet(results, 'mlx-community/MiniMax-M2.7-8bit');

    assert.ok(mock.calls.length > 0, 'Should make at least one call');
    for (const call of mock.calls) {
      assert.strictEqual(call.subject, 'mlx-community/MiniMax-M2.7-8bit');
    }
  });

  it('sends can_view relation in all check calls', async () => {
    mock.checkResult(false);

    const results = [
      makeEntity('private_email', 'user@company.com'),
      makeEntity('phone_number', '555-123-4567'),
    ];

    await buildDeniedCategoriesSet(results, 'model-1');

    for (const call of mock.calls) {
      assert.strictEqual(call.relation, 'can_view');
    }
  });

  it('fail-closed immediately when healthCheck fails (no check() calls made)', async () => {
    // Make healthCheck return false — buildDeniedCategoriesSet should immediately
    // fail-closed without making any check() calls.
    mock.healthCheckResult(false);

    const results = [
      makeEntity('private_email', 'user@company.com'),
      makeEntity('phone_number', '555-123-4567'),
    ];

    const denied = await buildDeniedCategoriesSet(results, 'model-1');

    assert.strictEqual(denied.size, 2, 'All categories should be denied');
    assert.strictEqual(mock.calls.length, 0, 'No check() calls when healthCheck fails');
  });
});
