// SPDX-License-Identifier: Apache-2.0
/**
 * OpenFGA Real Integration Tests
 * 
 * Key insight from docs: check(user=U, relation=R, object=O) checks if
 * user U has relation R to object O. The relation R must be defined on type(O).
 * 
 * Model structure:
 * - model_instance: the AI model/agent (principal)
 * - pii_instance: a specific PII occurrence (resource)  
 * - recipient: who can receive PII (resource)
 * - category: PII category (resource)
 * 
 * Based on MCP docs pattern: user:role:admin#assignee relation:can_call object:tool:greet
 * means can_call is defined on tool type. So:
 * - check(model_instance:X, can_share, pii_instance:Y) requires can_share on pii_instance type
 * - check(pii_instance:Y, can_view, recipient:Z) requires can_view on recipient type  
 * - check(recipient:Z, can_receive_from, model_instance:X) requires can_receive_from on model_instance type
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
  // Key insight: relation is defined on type(O) where check(user, relation, object) has object of type O
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
            can_receive: { this: {} },     
            can_receive_from: { this: {} }, // which recipients this model trusts
            lineage: { this: {} },         // lineage relation for checking pii origins (needed for cross-type checks)
          },
          metadata: {
            relations: {
              // model_instance can be the user when checking can_share/can_view on pii_instance
              can_view: { directly_related_user_types: [{ type: "pii_instance" }] },
              can_share: { directly_related_user_types: [{ type: "pii_instance" }] },
              can_receive: { directly_related_user_types: [{ type: "pii_instance" }] },
              // model_instance receives trust from recipients
              can_receive_from: { directly_related_user_types: [{ type: "recipient" }] },
              // lineage is on model_instance so pii_instance can check it
              lineage: { directly_related_user_types: [{ type: "pii_instance" }] },
            },
          },
        },
        { 
          type: "pii_instance", 
          relations: { 
            can_view: { this: {} },           // who can view this PII (and for pii_instance to be checked)
            can_share: { this: {} },          // who can share this PII
            can_receive: { this: {} },        // who can receive this PII
            lineage: { this: {} },            // which model created this PII (renamed from originates_from to avoid OpenFGA _from suffix reversal)
            category: { this: {} },           // category of this PII
          },
          metadata: {
            relations: {
              // pii_instance can be viewed by recipients (for check(recipient, can_view, pii))
              can_view: { directly_related_user_types: [{ type: "recipient" }, { type: "pii_instance" }] },
              // pii_instance can be shared by models
              can_share: { directly_related_user_types: [{ type: "model_instance" }] },
              // pii_instance can be received by models
              can_receive: { directly_related_user_types: [{ type: "model_instance" }] },
              // pii_instance lineage points to model_instance (user is pii_instance, but cross-type checks need relation on target)
              lineage: { directly_related_user_types: [{ type: "pii_instance" }] },
              // pii_instance belongs to categories
              category: { directly_related_user_types: [{ type: "category" }] },
            },
          },
        },
        { 
          type: "recipient", 
          relations: { 
            can_receive_from: { this: {} },   // which models this recipient trusts
            can_view: { this: {} },           // can view PII instances
          },
          metadata: {
            relations: {
              // recipient receives trust from models (inverse of model.can_receive_from)
              can_receive_from: { directly_related_user_types: [{ type: "model_instance" }] },
              // recipient can view pii_instance (user is recipient, object is pii_instance)
              // Also allow recipient as user type for check(recipient, can_view, pii) to work
              can_view: { directly_related_user_types: [{ type: "pii_instance" }, { type: "recipient" }] },
            },
          },
        },
        { 
          type: "category", 
          relations: { 
            defines: { this: {} },            // which models produce this category
          },
          metadata: {
            relations: {
              // category is defined by models
              defines: { directly_related_user_types: [{ type: "model_instance" }] },
            },
          },
        },
      ],
    }),
  })) as { authorization_model_id: string };
}

async function write(storeId: string, modelId: string, tuples: Array<{ user: string; relation: string; object: string }>): Promise<void> {
  console.log('[WRITE]', JSON.stringify(tuples, null, 2));
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
  const piiInstanceId = `pii_instance:sha256-${emailHash}`;

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

  // Test: model_instance can_share pii_instance
  // check(model_instance:support-bot, can_share, pii_instance:xxx)
  // can_share is on pii_instance, so model_instance must be allowed user type
  it('model_instance can_share pii_instance', async () => {
    const tuple = { user: 'model_instance:support-bot', relation: 'can_share', object: piiInstanceId };
    await write(storeId, modelId, [tuple]);
    const allowed = await check(storeId, modelId, tuple.user, tuple.relation, tuple.object);
    assert.strictEqual(allowed, true, 'Model should be able to share PII instance');
    await del(storeId, modelId, [tuple]);
  });

  // Test: pii_instance can_view recipient
  // check(recipient:alice, can_view, pii_instance:xxx)
  // can_view is on pii_instance, so recipient must be allowed user type
  it('pii_instance can_view recipient', async () => {
    // The user field contains the subject (recipient), object is pii_instance
    const tuple = { user: 'recipient:alice', relation: 'can_view', object: piiInstanceId };
    await write(storeId, modelId, [tuple]);
    const allowed = await check(storeId, modelId, tuple.user, tuple.relation, tuple.object);
    assert.strictEqual(allowed, true, 'PII instance should be viewable by recipient');
    await del(storeId, modelId, [tuple]);
  });

  // Test: recipient can_receive_from model_instance (trust from recipient perspective)
  // check(recipient:alice, can_receive_from, model_instance:support-bot)
  // can_receive_from is on model_instance, so recipient must be allowed user type
  it('recipient can_receive_from model_instance (trust)', async () => {
    const tuple = { user: 'recipient:alice', relation: 'can_receive_from', object: 'model_instance:support-bot' };
    await write(storeId, modelId, [tuple]);
    const allowed = await check(storeId, modelId, tuple.user, tuple.relation, tuple.object);
    assert.strictEqual(allowed, true, 'Recipient should be able to receive from model (trust)');
    await del(storeId, modelId, [tuple]);
  });

  // Test: pii_instance lineage model_instance (lineage)
  // check(pii_instance:xxx, lineage, model_instance:support-bot)
  // lineage is on pii_instance, so pii_instance must be allowed user type
  it('pii_instance lineage model_instance (lineage)', async () => {
    // The user field contains the subject (pii_instance), object is model_instance
    const tuple = { user: piiInstanceId, relation: 'lineage', object: 'model_instance:support-bot' };
    await write(storeId, modelId, [tuple]);
    const allowed = await check(storeId, modelId, tuple.user, tuple.relation, tuple.object);
    assert.strictEqual(allowed, true, 'PII should have lineage to model');
    await del(storeId, modelId, [tuple]);
  });

  // Test: category defines model_instance
  // check(model_instance:scanning-bot, defines, category:email)
  // defines is on category, so model_instance must be allowed user type
  it('category defines model_instance', async () => {
    // The user field contains the subject (model_instance), object is category
    const tuple = { user: 'model_instance:scanning-bot', relation: 'defines', object: 'category:email' };
    await write(storeId, modelId, [tuple]);
    const allowed = await check(storeId, modelId, tuple.user, tuple.relation, tuple.object);
    assert.strictEqual(allowed, true, 'Category should define model_instance');
    await del(storeId, modelId, [tuple]);
  });

  // Test: denied without tuple
  it('denied without tuple', async () => {
    const allowed = await check(storeId, modelId, 'model_instance:unknown', 'can_share', piiInstanceId);
    assert.strictEqual(allowed, false, 'Should be denied without tuple');
  });

  // Test: complete sharing authorization flow (simulating checkShare)
  // For sharing to be allowed:
  // 1. model --can_share--> pii  (check model, can_share, pii)
  // 2. pii --originates_from--> model  (check pii, originates_from, model)
  // 3. pii --can_view--> recipient  (check pii, can_view, recipient)
  // 4. recipient --can_receive_from--> model  (check recipient, can_receive_from, model)
  it('complete sharing authorization flow', async () => {
    const tuples = [
      { user: 'model_instance:support-bot', relation: 'can_share', object: piiInstanceId },
      { user: piiInstanceId, relation: 'lineage', object: 'model_instance:support-bot' },
      { user: 'recipient:alice', relation: 'can_view', object: piiInstanceId },
      { user: 'recipient:alice', relation: 'can_receive_from', object: 'model_instance:support-bot' },
    ];
    await write(storeId, modelId, tuples);
    
    const checks = {
      modelCanShare: await check(storeId, modelId, 'model_instance:support-bot', 'can_share', piiInstanceId),
      // Lineage: pii_instance lineage model_instance (pii_instance is user, model is object)
      lineageValid: await check(storeId, modelId, piiInstanceId, 'lineage', 'model_instance:support-bot'),
      recipientCanView: await check(storeId, modelId, 'recipient:alice', 'can_view', piiInstanceId),
      recipientTrustsModel: await check(storeId, modelId, 'recipient:alice', 'can_receive_from', 'model_instance:support-bot'),
    };
    
    const sharingAllowed = checks.modelCanShare && checks.lineageValid && checks.recipientCanView && checks.recipientTrustsModel;
    assert.strictEqual(sharingAllowed, true, `All checks should pass: ${JSON.stringify(checks)}`);
    
    await del(storeId, modelId, tuples);
  });
});