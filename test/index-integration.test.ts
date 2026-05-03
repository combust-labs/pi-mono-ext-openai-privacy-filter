// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 4.4: index.ts Integration Tests
 *
 * Tests piiExtension's before_agent_start, context, and /check-pii handler
 * using mocks for the HuggingFace pipeline and OpenFGA client.
 *
 * Infrastructure:
 * - pi-extension-shim.ts: fake ExtensionAPI that records sendMessage calls
 *   and lets us invoke event handlers directly
 * - mock-pipeline.ts: fake pipeline for @huggingface/transformers
 * - mock-openfga-client.ts: fake OpenFGA client (existing)
 *
 * Each test gets its own dynamic import of index.ts (via cache-busting
 * query param) so that the pipeline mock installation and module state
 * are isolated per test.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';

import { createShimExtensionAPI, type ShimExtensionAPI } from './support/pi-extension-shim.ts';
import { createMockPipeline } from './support/mock-pipeline.ts';
import { createMockOpenFGAClient, type MockOpenFGAClient } from './support/mock-openfga-client.ts';
import { setOpenFGAClient } from '../openfga.ts';
import type { AggregatedAnnotation } from '../privacy-auth.ts';

function makeEntity(group: string, word: string, score = 0.99): AggregatedAnnotation {
  return { entity_group: group, score, word };
}

// ---------------------------------------------------------------------------
// Module-level state — installed once at load time
// ---------------------------------------------------------------------------

let shim: ShimExtensionAPI;
let mockOpenFGA: MockOpenFGAClient;
let mockPipeline: ReturnType<typeof createMockPipeline>;

// The ESM register-loader.mjs intercepts '@huggingface/transformers' and
// resolves it to mock-pipeline.ts — no installMock() call needed here.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Dynamically import index.ts with a cache-busting query param so each call
 * gets a fresh module instance (and fresh privacyPipeline closure variable).
 */
async function importIndex(t: number): Promise<{ default: (pi: unknown) => void }> {
  return import(`../index.ts?t=${t}`) as Promise<{ default: (pi: unknown) => void }>;
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

before(() => {
  shim = createShimExtensionAPI();
  mockOpenFGA = createMockOpenFGAClient();
  mockPipeline = createMockPipeline();
  setOpenFGAClient(mockOpenFGA as unknown as import('../openfga.ts').OpenFGAClient);
});

beforeEach(() => {
  shim.reset();
  mockOpenFGA.reset();
  mockPipeline.reset();
  mockOpenFGA.checkResult(false); // default: deny everything (fail-closed)
});

// ---------------------------------------------------------------------------
// before_agent_start tests
// ---------------------------------------------------------------------------

describe('before_agent_start', () => {
  // Use a counter to ensure each import gets a unique URL (cache-busting)
  let importCounter = 0;

  it('masks PII when OpenFGA denies both literal and category (fail-closed)', async () => {
    mockPipeline.mockResults([
      makeEntity('email', 'user@company.com'),
      makeEntity('phone_number', '555-123-4567'),
    ]);
    mockOpenFGA.checkResult(false); // deny all

    const { default: piiExtension } = await importIndex(importCounter++);
    piiExtension(shim.api);

    const result = await shim.trigger('before_agent_start', {
      prompt: 'My email is user@company.com and phone is 555-123-4567',
      systemPrompt: 'You are a helpful assistant.',
    });

    assert.ok(result, 'handler should return a result');
    assert.ok(result!.prompt!.includes('[EMAIL REDACTED]'), 'email should be masked');
    assert.ok(result!.prompt!.includes('[PHONE_NUMBER REDACTED]'), 'phone should be masked');
    assert.ok(
      result!.systemPrompt!.includes('[PRIVACY NOTICE]'),
      'systemPrompt should include privacy injection'
    );
  });

  it('does NOT mask PII when OpenFGA allows category-level access', async () => {
    mockPipeline.mockResults([makeEntity('email', 'user@company.com')]);
    // Category-level check passes
    mockOpenFGA.checkResultFn(call => {
      if (call.resolvedObjectId === 'privacy_category:email') return true;
      return false;
    });

    const { default: piiExtension } = await importIndex(importCounter++);
    piiExtension(shim.api);

    const result = await shim.trigger('before_agent_start', {
      prompt: 'My email is user@company.com',
      systemPrompt: '',
    });

    assert.ok(result, 'handler should return a result');
    assert.strictEqual(result!.prompt!, 'My email is user@company.com', 'email should NOT be masked');
  });

  it('does NOT mask PII when OpenFGA allows the specific literal', async () => {
    mockPipeline.mockResults([makeEntity('email', 'user@company.com')]);
    // Category-level fails, but literal-level passes
    mockOpenFGA.checkResultFn(call => {
      if (call.literal === 'user@company.com') return true;
      return false;
    });

    const { default: piiExtension } = await importIndex(importCounter++);
    piiExtension(shim.api);

    const result = await shim.trigger('before_agent_start', {
      prompt: 'My email is user@company.com',
      systemPrompt: '',
    });

    assert.ok(result);
    assert.strictEqual(result!.prompt!, 'My email is user@company.com', 'email should NOT be masked');
  });

  it('masks all PII when OpenFGA is unreachable (fail-closed on global error)', async () => {
    mockPipeline.mockResults([
      makeEntity('email', 'a@b.com'),
      makeEntity('phone_number', '555-123-4567'),
    ]);
    mockOpenFGA.throwError(new Error('OpenFGA unavailable'));

    const { default: piiExtension } = await importIndex(importCounter++);
    piiExtension(shim.api);

    const result = await shim.trigger('before_agent_start', {
      prompt: 'Email a@b.com and phone 555-123-4567',
      systemPrompt: '',
    });

    assert.ok(result);
    assert.ok(result!.prompt!.includes('[EMAIL REDACTED]'), 'email should be masked on error');
    assert.ok(result!.prompt!.includes('[PHONE_NUMBER REDACTED]'), 'phone should be masked on error');
  });

  it('sends inline pii-alert message with correct MASKED / ALLOWED per entity', async () => {
    mockPipeline.mockResults([
      makeEntity('email', 'allowed@company.com'),
      makeEntity('phone_number', '555-123-4567'),
    ]);
    mockOpenFGA.checkResultFn(call => {
      if (call.resolvedObjectId === 'privacy_category:email') return true; // category-level allows email
      return false; // phone denied
    });

    const { default: piiExtension } = await importIndex(importCounter++);
    piiExtension(shim.api);

    await shim.trigger('before_agent_start', {
      prompt: 'Email allowed@company.com and phone 555-123-4567',
      systemPrompt: '',
    });

    assert.strictEqual(shim.sentMessages.length, 1);
    const msg = shim.sentMessages[0];
    assert.strictEqual(msg.customType, 'pii-alert');
    const data = JSON.parse(msg.content);
    assert.ok(data.piiLines.some((l: string) => l.includes('ALLOWED')), 'alert should include ALLOWED');
    assert.ok(data.piiLines.some((l: string) => l.includes('MASKED')), 'alert should include MASKED');
  });

  it('injects systemPrompt with privacy notice (independent of PII presence)', async () => {
    mockPipeline.mockResults([makeEntity('email', 'a@b.com')]);
    mockOpenFGA.checkResult(true); // allowed

    const { default: piiExtension } = await importIndex(importCounter++);
    piiExtension(shim.api);

    const result = await shim.trigger('before_agent_start', {
      prompt: 'My email is a@b.com',
      systemPrompt: 'You are a helpful assistant.',
    });

    assert.ok(result);
    assert.ok(
      result!.systemPrompt!.includes('[PRIVACY NOTICE]'),
      'systemPrompt should include privacy injection even when PII is allowed'
    );
  });

  it('when ctx.model?.id is absent, all detected PII is masked (fail-closed)', async () => {
    mockPipeline.mockResults([makeEntity('email', 'a@b.com')]);
    // Model id is null in shim.ctx.model — no OpenFGA check needed, fail-closed
    shim.ctx.model = null;

    const { default: piiExtension } = await importIndex(importCounter++);
    piiExtension(shim.api);

    const result = await shim.trigger('before_agent_start', {
      prompt: 'My email is a@b.com',
      systemPrompt: '',
    });

    assert.ok(result);
    assert.ok(result!.prompt!.includes('[EMAIL REDACTED]'), 'email should be masked when model absent');
  });

  it('handles empty prompt — returns undefined (no processing)', async () => {
    mockPipeline.mockResults([]);
    mockOpenFGA.checkResult(false);

    const { default: piiExtension } = await importIndex(importCounter++);
    piiExtension(shim.api);

    const result = await shim.trigger('before_agent_start', {
      prompt: '',
      systemPrompt: '',
    });

    assert.strictEqual(result, undefined);
  });

  it('handles no PII detected — returns undefined (no processing)', async () => {
    mockPipeline.mockResults([]);

    const { default: piiExtension } = await importIndex(importCounter++);
    piiExtension(shim.api);

    const result = await shim.trigger('before_agent_start', {
      prompt: 'Hello world, no PII here',
      systemPrompt: '',
    });

    assert.strictEqual(result, undefined);
  });
});

// ---------------------------------------------------------------------------
// context handler tests
// ---------------------------------------------------------------------------

describe('context handler', () => {
  let importCounter = 1000;

  it('applies same OpenFGA logic to historical user messages', async () => {
    mockPipeline.mockResults([makeEntity('email', 'a@b.com')]);
    mockOpenFGA.checkResult(false); // denied

    const { default: piiExtension } = await importIndex(importCounter++);
    piiExtension(shim.api);

    const result = await shim.trigger('context', {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'My email is a@b.com' }] },
      ],
    });

    assert.ok(result);
    const maskedMsg = result!.messages[0].content[0] as { type: 'text'; text: string };
    assert.ok(maskedMsg.text.includes('[EMAIL REDACTED]'), 'PII in context should be masked');
  });

  it('filters out pii-alert custom messages before returning', async () => {
    mockPipeline.mockResults([]);
    mockOpenFGA.checkResult(false);

    const { default: piiExtension } = await importIndex(importCounter++);
    piiExtension(shim.api);

    const result = await shim.trigger('context', {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
        { role: 'custom', customType: 'pii-alert', content: [{ type: 'text', text: '{"piiTypes":[],"piiLines":[]}' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Got it' }] },
      ],
    });

    assert.ok(result);
    assert.strictEqual(result!.messages.length, 2, 'pii-alert should be filtered out');
    assert.ok(!result!.messages.some(m => m.role === 'custom' && (m as { customType?: string }).customType === 'pii-alert'));
  });

  it('allows PII in context when OpenFGA allows category access', async () => {
    mockPipeline.mockResults([makeEntity('email', 'a@b.com')]);
    mockOpenFGA.checkResult(true); // allowed

    const { default: piiExtension } = await importIndex(importCounter++);
    piiExtension(shim.api);

    const result = await shim.trigger('context', {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'My email is a@b.com' }] },
      ],
    });

    assert.ok(result);
    const msg = result!.messages[0].content[0] as { type: 'text'; text: string };
    assert.strictEqual(msg.text, 'My email is a@b.com', 'PII should NOT be masked when allowed');
  });
});

// ---------------------------------------------------------------------------
// /check-pii command tests
// ---------------------------------------------------------------------------

describe('/check-pii command', () => {
  let importCounter = 2000;

  it('sends inline alert with detected PII (no masking, no OpenFGA check)', async () => {
    mockPipeline.mockResults([
      makeEntity('email', 'a@b.com'),
      makeEntity('phone_number', '555-123-4567'),
    ]);
    // No OpenFGA mock setup needed — /check-pii should NOT call OpenFGA

    const { default: piiExtension } = await importIndex(importCounter++);
    piiExtension(shim.api);

    await shim.invokeCommand('check-pii', 'My email is a@b.com and phone is 555-123-4567');

    assert.strictEqual(shim.sentMessages.length, 1);
    const msg = shim.sentMessages[0];
    assert.strictEqual(msg.customType, 'pii-alert');
    const data = JSON.parse(msg.content);
    assert.ok(data.piiLines.length === 2, 'should list both PII items');
    assert.ok(!msg.content.includes('MASKED') && !msg.content.includes('ALLOWED'),
      '/check-pii should not label items as MASKED/ALLOWED');
  });

  it('notifies when no PII detected', async () => {
    mockPipeline.mockResults([]);
    let notifiedMessage = '';
    let notifiedType = '';
    shim.ctx.ui.notify = (msg, type) => {
      notifiedMessage = msg;
      notifiedType = type;
    };

    const { default: piiExtension } = await importIndex(importCounter++);
    piiExtension(shim.api);

    await shim.invokeCommand('check-pii', 'Hello world, no PII here');

    assert.strictEqual(notifiedMessage, 'No PII detected');
    assert.strictEqual(notifiedType, 'info');
  });

  it('notifies usage when args are empty', async () => {
    let notifiedMessage = '';
    let notifiedType = '';
    shim.ctx.ui.notify = (msg, type) => {
      notifiedMessage = msg;
      notifiedType = type;
    };

    const { default: piiExtension } = await importIndex(importCounter++);
    piiExtension(shim.api);

    await shim.invokeCommand('check-pii', '');

    assert.strictEqual(notifiedMessage, 'Usage: /check-pii <text>');
    assert.strictEqual(notifiedType, 'warning');
  });
});