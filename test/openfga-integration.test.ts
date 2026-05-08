// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 6: OpenFGA Real Integration Tests
 *
 * These tests connect to a real OpenFGA instance and perform end-to-end
 * authorization checks. They are gated behind the OPENFGA_INTEGRATION_TEST
 * environment variable and clean up after themselves.
 *
 * Usage:
 *   OPENFGA_INTEGRATION_TEST=true npm test
 *
 * Prerequisites:
 *   - OpenFGA running at http://agent-openfga:8080 (or OPENFGA_API_URL)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'crypto';
import { execSync } from 'child_process';

const runIntegrationTests = process.env.OPENFGA_INTEGRATION_TEST === 'true';

if (!runIntegrationTests) {
  console.log('[INFO] Skipping OpenFGA integration tests (set OPENFGA_INTEGRATION_TEST=true to run)');
}

function resolveOpenFGAUrl(): string {
  const envUrl = process.env.OPENFGA_API_URL;
  if (envUrl) return envUrl;
  try {
    const ip = execSync(`getent hosts agent-openfga | awk '{print $1; exit}'`, { encoding: 'utf8' }).trim();
    if (ip) return `http://${ip}:8080`;
  } catch { /* fall back */ }
  return "http://agent-openfga:8080";
}

const OPENFGA_API_URL = resolveOpenFGAUrl();
const STORE_NAME = "privacy-integration-test";

async function api(path: string, opts: RequestInit = {}): Promise<unknown> {
  const r = await fetch(`${OPENFGA_API_URL}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...opts.headers },
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`OpenFGA ${path} (${r.status}): ${body}`);
  }
  return r.json();
}

async function cleanup(): Promise<void> {
  try { await api('/stores', { method: 'POST', body: JSON.stringify({ name: STORE_NAME + '-cleanup' }) }); } catch { /* ignore */ }
  const stores = await api('/stores') as { stores: Array<{ id: string; name: string }> };
  for (const s of stores.stores) {
    if (s.name.startsWith('privacy-integration-test')) {
      try { await api(`/stores/${s.id}`, { method: 'DELETE' }); } catch { /* ignore */ }
    }
  }
}

async function createStore(name: string): Promise<string> {
  return (await api('/stores', { method: 'POST', body: JSON.stringify({ name }) })) as { id: string };
}

async function createModel(storeId: string): Promise<string> {
  return (await api(`/stores/${storeId}/authorization-models`, {
    method: 'POST',
    body: JSON.stringify({
      schema_version: "1.1",
      type_definitions: [
        { 
          type: "model_instance", 
          relations: { 
            can_view: { this: {} }, 
            can_share: { this: {} },
          },
          metadata: {
            relations: {
              can_view: { directly_related_user_types: [{ type: "pii_instance" }] },
              can_share: { directly_related_user_types: [{ type: "pii_instance" }] },
            },
          },
        },
        { 
          type: "pii_instance", 
          relations: { 
            can_view: { this: {} }, 
            originates_from: { this: {} },
          },
          metadata: {
            relations: {
              can_view: { directly_related_user_types: [{ type: "recipient" }] },
              originates_from: { directly_related_user_types: [{ type: "model_instance" }] },
            },
          },
        },
        { 
          type: "recipient", 
          relations: { 
            can_receive_from: { this: {} },
          },
          metadata: {
            relations: {
              can_receive_from: { directly_related_user_types: [{ type: "model_instance" }] },
            },
          },
        },
      ],
    }),
  })) as { authorization_model_id: string };
}

async function write(storeId: string, modelId: string, tuples: Array<{ user: string; relation: string; object: string }>): Promise<void> {
  console.log('[WRITE]', JSON.stringify(tuples));
  await api(`/stores/${storeId}/write`, {
    method: 'POST',
    body: JSON.stringify({ writes: { tuple_keys: tuples }, authorization_model_id: modelId }),
  });
}

async function del(storeId: string, modelId: string, tuples: Array<{ user: string; relation: string; object: string }>): Promise<void> {
  try {
    await api(`/stores/${storeId}/write`, {
      method: 'POST',
      body: JSON.stringify({ deletes: { tuple_keys: tuples }, authorization_model_id: modelId }),
    });
  } catch { /* ignore */ }
}

async function check(storeId: string, modelId: string, user: string, relation: string, object: string): Promise<boolean> {
  console.log(`[CHECK] ${user}#${relation}@${object}`);
  const result = await api(`/stores/${storeId}/check`, {
    method: 'POST',
    body: JSON.stringify({ tuple_key: { user, relation, object }, authorization_model_id: modelId }),
  }) as { allowed: boolean };
  console.log(`[RESULT] ${result.allowed}`);
  return result.allowed;
}

describe('OpenFGA Integration', { skip: !runIntegrationTests }, () => {
  let storeId: string;
  let modelId: string;
  const emailHash = createHash('sha256').update('test@test.com').digest('hex').substring(0, 40);

  before(async () => {
    console.log('\n[SETUP] Creating store and model...');
    storeId = (await createStore(STORE_NAME)).id;
    modelId = (await createModel(storeId)).id;
    console.log(`[SETUP] store=${storeId}, model=${modelId}\n`);
  });

  after(async () => {
    console.log('\n[CLEANUP]');
    await cleanup();
    console.log('[DONE]\n');
  });

  it('model_instance can_view pii_instance', async () => {
    const tuple = { user: 'model_instance:support-bot', relation: 'can_view', object: `pii_instance:sha256-${emailHash}` };
    await write(storeId, modelId, [tuple]);
    const allowed = await check(storeId, modelId, tuple.user, tuple.relation, tuple.object);
    assert.strictEqual(allowed, true);
    await del(storeId, modelId, [tuple]);
  });

  it('pii_instance can_view recipient', async () => {
    const tuple = { user: `pii_instance:sha256-${emailHash}`, relation: 'can_view', object: 'recipient:user:alice' };
    await write(storeId, modelId, [tuple]);
    const allowed = await check(storeId, modelId, tuple.user, tuple.relation, tuple.object);
    assert.strictEqual(allowed, true);
    await del(storeId, modelId, [tuple]);
  });

  it('recipient can_receive_from model_instance', async () => {
    const tuple = { user: 'recipient:user:alice', relation: 'can_receive_from', object: 'model_instance:support-bot' };
    await write(storeId, modelId, [tuple]);
    const allowed = await check(storeId, modelId, tuple.user, tuple.relation, tuple.object);
    assert.strictEqual(allowed, true);
    await del(storeId, modelId, [tuple]);
  });

  it('category defines model_instance', async () => {
    const tuple = { user: 'category:email', relation: 'defines', object: 'model_instance:scanning-bot' };
    await write(storeId, modelId, [tuple]);
    const allowed = await check(storeId, modelId, tuple.user, tuple.relation, tuple.object);
    assert.strictEqual(allowed, true);
    await del(storeId, modelId, [tuple]);
  });

  it('denied without tuple', async () => {
    const allowed = await check(storeId, modelId, 'model_instance:unknown', 'can_view', `pii_instance:sha256-${emailHash}`);
    assert.strictEqual(allowed, false);
  });

  it('complete sharing flow simulation', async () => {
    const tuples = [
      { user: 'model_instance:support-bot', relation: 'can_view', object: `pii_instance:sha256-${emailHash}` },
      { user: `pii_instance:sha256-${emailHash}`, relation: 'can_view', object: 'recipient:user:alice' },
      { user: 'recipient:user:alice', relation: 'can_receive_from', object: 'model_instance:support-bot' },
    ];
    await write(storeId, modelId, tuples);
    
    const checks = {
      modelCanView: await check(storeId, modelId, 'model_instance:support-bot', 'can_view', `pii_instance:sha256-${emailHash}`),
      piiCanBeViewedByRecipient: await check(storeId, modelId, `pii_instance:sha256-${emailHash}`, 'can_view', 'recipient:user:alice'),
      recipientTrustsModel: await check(storeId, modelId, 'recipient:user:alice', 'can_receive_from', 'model_instance:support-bot'),
    };
    
    const sharingAllowed = checks.modelCanView && checks.piiCanBeViewedByRecipient && checks.recipientTrustsModel;
    assert.strictEqual(sharingAllowed, true, `All checks should pass: ${JSON.stringify(checks)}`);
    
    await del(storeId, modelId, tuples);
  });
});