// SPDX-License-Identifier: Apache-2.0
/**
 * OpenFGA Real Integration Tests
 *
 * These tests verify the full authorization flow against a real OpenFGA
 * server with actual check/write operations.
 *
 * Two environments are supported:
 *
 *  1. Inside the harness container — uses the `agent-openfga` Docker
 *     DNS name. The harness sets OPENFGA_API_URL before tests run, so
 *     the env var is picked up directly. No container management needed.
 *
 *  2. On the host or in GitHub CI — uses testcontainers to spin up a
 *     real `openfga/openfga` container on a random host port. The
 *     OPENFGA_API_URL, OPENFGA_STORE_ID, and OPENFGA_MODEL_ID env vars
 *     are set from the container's mapped address so the SDK wrapper
 *     and scripts pick them up automatically.
 *
 * Run with: OPENFGA_INTEGRATION_TEST=true npm test
 *
 * To force testcontainers even when OPENFGA_API_URL is set (e.g. on host):
 * USE_TESTCONTAINERS=true OPENFGA_INTEGRATION_TEST=true npm test
 */

import { createHash } from 'crypto';
import nock from 'nock';
import assert from 'node:assert';
import { createHash } from 'crypto';
import { createRequire } from 'node:module';
import { lookup } from 'node:dns';
import { ulid } from 'ulidx';

/** Fallback ULID used when the harness does not provide the store/model IDs.
 *  OpenFGA requires valid ULIDs (26 uppercase base32 chars) for store and model IDs.
 *  We generate one upfront so createModel always receives a non-undefined storeId.
 *  The actual store is still created via the API (OpenFGA assigns its own ID).
 *  The fallback is only used if the API call to create the store fails.
 */
const FALLBACK_STORE_ID = ulid();
const FALLBACK_MODEL_ID = ulid();
import { after, before, describe, it } from 'node:test';
import { GenericContainer, StartedTestContainer, type, Wait } from 'testcontainers';

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

export const runIntegrationTests = process.env.OPENFGA_INTEGRATION_TEST === 'true';

/**
 * Sync check for Docker availability. testcontainers uses the Docker socket
 * at /var/run/docker.sock (Linux) or the named pipe on Windows. If Docker is
 * not available, testcontainers cannot start containers.
 */
function isDockerAvailable(): boolean {
  try {
    // Use createRequire to get a working require() in ESM context.
    const req = createRequire(import.meta.url);
    const { existsSync } = req('node:fs');
    // Check the default Linux socket and Windows named pipe
    return existsSync('/var/run/docker.sock') || existsSync('//./pipe/docker_engine');
  } catch {
    return false;
  }
}

const dockerAvailable = isDockerAvailable();

/**
 * True when the testcontainers path should be used.
 *
 * Decision order:
 *  1. Docker must be available — otherwise testcontainers would throw
 *  2. Either USE_TESTCONTAINERS=true is set, or OPENFGA_API_URL is absent
 *     (meaning we have no harness address to fall back to)
 *
 * If Docker is unavailable and OPENFGA_API_URL is also not set but
 * OPENFGA_INTEGRATION_TEST=true, we throw at module load time — the
 * integration tests cannot run in this environment.
 */
const useTestcontainers =
  dockerAvailable &&
  (process.env.USE_TESTCONTAINERS === 'true' || !process.env.OPENFGA_API_URL);

if (!runIntegrationTests) {
  console.log('[INFO] Skipping OpenFGA integration tests (set OPENFGA_INTEGRATION_TEST=true to run)');
} else if (useTestcontainers) {
  console.log('[INFO] Using testcontainers for OpenFGA (Docker available, no OPENFGA_API_URL)');
} else if (!dockerAvailable && !process.env.OPENFGA_API_URL) {
  // Both paths failed: no Docker for testcontainers, no harness env var.
  // Fail immediately so the test run is clearly broken.
  throw new Error(
    'OPENFGA_INTEGRATION_TEST=true but Docker is not available and OPENFGA_API_URL is not set. ' +
    'Either: (1) start Docker and set USE_TESTCONTAINERS=true, or (2) run inside the harness container.',
  );
} else {
  console.log('[INFO] Using harness OpenFGA (OPENFGA_API_URL is set)');
}

// ---------------------------------------------------------------------------
// Harness path (agent-openfga inside Docker)
// ---------------------------------------------------------------------------

/** Synchronous URL construction — used at module load time before async is available */
function getOpenFGAUrlSync(): string {
  const envUrl = process.env.OPENFGA_API_URL;
  if (envUrl) return envUrl;
  // Fallback: agent-openfga is the Docker-internal DNS name for the OpenFGA
  // server. This only works inside the harness container network.
  return 'http://agent-openfga:8080';
}

/** Async resolver — resolves agent-openfga hostname to IP via Node.js DNS */
async function resolveOpenFGAUrl(): Promise<string> {
  const envUrl = process.env.OPENFGA_API_URL;
  if (envUrl) return envUrl;

  const hostname = 'agent-openfga';
  try {
    const addresses = await new Promise<import('node:dns').LookupAddress[]>(
      (resolve, reject) => {
        lookup(hostname, { all: true }, (err, addr) =>
          err ? reject(err) : resolve(addr),
        );
      },
    );
    if (addresses.length > 0) {
      return `http://${addresses[0].address}:8080`;
    }
  } catch { /* fall through to fallback */ }

  return 'http://agent-openfga:8080';
}

// ---------------------------------------------------------------------------
// Shared constants and helpers
// ---------------------------------------------------------------------------

const STORE_NAME = 'privacy-integration-test';

let OPENFGA_API_URL = getOpenFGAUrlSync();

// ---------------------------------------------------------------------------
// API helper — uses the process.env.OPENFGA_API_URL that is set at runtime
// ---------------------------------------------------------------------------

async function api<T = unknown>(
  path: string,
  opts: RequestInit = {},
  retries = 3,
  delayMs = 1000,
): Promise<T> {
  const base = process.env.OPENFGA_API_URL ?? OPENFGA_API_URL;
  let lastError: Error | null = null;

  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(`${base}${path}`, {
        ...opts,
        headers: { 'Content-Type': 'application/json', ...opts.headers },
      });
      // Read body as text first so it is fully consumed. Subsequent fetch
      // calls (retries) use a fresh Request — never re-enter fetch with the
      // same body stream that was already consumed by the interceptors.
      const bodyText = await r.text();
      if (!r.ok) {
        throw new Error(`OpenFGA ${path} (${r.status}): ${bodyText}`);
      }
      return JSON.parse(bodyText) as T;
    } catch (e) {
      lastError = e as Error;
      if (i < retries - 1) {
        console.log(`[RETRY] ${path} failed (attempt ${i + 1}/${retries}): ${lastError.message}`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Store and model helpers
// ---------------------------------------------------------------------------

async function createStore(name: string): Promise<string> {
  return (await api<{ id: string }>('/stores', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })).id;
}

async function createModel(storeId: string): Promise<string> {
  const sid = storeId ?? FALLBACK_STORE_ID;
  return (await api<{ authorization_model_id: string }>(
    `/stores/${sid}/authorization-models`,
    {
      method: 'POST',
      body: JSON.stringify({
        schema_version: '1.1',
        type_definitions: [
          {
            type: 'model_instance',
            relations: {
              can_view: { this: {} },
              can_share: { this: {} },
              can_receive: { this: {} },
              can_receive_from: { this: {} },
              lineage: { this: {} },
            },
            metadata: {
              relations: {
                can_view: { directly_related_user_types: [{ type: 'pii_instance' }] },
                can_share: { directly_related_user_types: [{ type: 'pii_instance' }] },
                can_receive: { directly_related_user_types: [{ type: 'pii_instance' }] },
                can_receive_from: { directly_related_user_types: [{ type: 'recipient' }] },
                lineage: { directly_related_user_types: [{ type: 'pii_instance' }] },
              },
            },
          },
          {
            type: 'pii_instance',
            relations: {
              can_view: { this: {} },
              can_share: { this: {} },
              can_receive: { this: {} },
              lineage: { this: {} },
              category: { this: {} },
            },
            metadata: {
              relations: {
                can_view: {
                  directly_related_user_types: [{ type: 'recipient' }, { type: 'pii_instance' }],
                },
                can_share: { directly_related_user_types: [{ type: 'model_instance' }] },
                can_receive: { directly_related_user_types: [{ type: 'model_instance' }] },
                lineage: { directly_related_user_types: [{ type: 'pii_instance' }, { type: 'model_instance' }] },
                category: { directly_related_user_types: [{ type: 'category' }] },
              },
            },
          },
          {
            type: 'recipient',
            relations: {
              can_receive_from: { this: {} },
              can_view: { this: {} },
            },
            metadata: {
              relations: {
                can_receive_from: { directly_related_user_types: [{ type: 'model_instance' }] },
                can_view: {
                  directly_related_user_types: [{ type: 'pii_instance' }, { type: 'recipient' }],
                },
              },
            },
          },
          {
            type: 'category',
            relations: {
              defines: { this: {} },
            },
            metadata: {
              relations: {
                defines: { directly_related_user_types: [{ type: 'model_instance' }] },
              },
            },
          },
        ],
      }),
    },
  )).authorization_model_id;
}

async function write(
  storeId: string,
  modelId: string,
  tuples: Array<{ user: string; relation: string; object: string }>,
): Promise<void> {
  console.log('[WRITE]', JSON.stringify(tuples, null, 2));
  await api(`/stores/${storeId}/write`, {
    method: 'POST',
    body: JSON.stringify({ writes: { tuple_keys: tuples }, authorization_model_id: modelId }),
  });
}

async function del(
  storeId: string,
  modelId: string,
  tuples: Array<{ user: string; relation: string; object: string }>,
): Promise<void> {
  try {
    await api(`/stores/${storeId}/write`, {
      method: 'POST',
      body: JSON.stringify({ deletes: { tuple_keys: tuples }, authorization_model_id: modelId }),
    });
  } catch { /* ignore */ }
}

async function check(
  storeId: string,
  modelId: string,
  user: string,
  relation: string,
  object: string,
): Promise<boolean> {
  console.log(`[CHECK] ${user}#${relation}@${object}`);
  const result = await api<{ allowed: boolean }>(`/stores/${storeId}/check`, {
    method: 'POST',
    body: JSON.stringify({ tuple_key: { user, relation, object }, authorization_model_id: modelId }),
  });
  console.log(`[RESULT] ${result.allowed}`);
  return result.allowed;
}

async function cleanupStores(): Promise<void> {
  try {
    const { stores } = await api<{ stores: Array<{ id: string; name: string }> }>('/stores');
    for (const s of stores) {
      if (s.name.startsWith('privacy-integration-test')) {
        try {
          await api(`/stores/${s.id}`, { method: 'DELETE' });
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Testcontainers state (used in host / CI environments)
// ---------------------------------------------------------------------------

let tcContainer: StartedTestContainer | null = null;

// ---------------------------------------------------------------------------
// beforeAll / afterAll — unified setup/teardown for both paths
// ---------------------------------------------------------------------------

before(async function () {
  // Give tests a generous timeout — testcontainers may need to pull the image
  // on first run (30-60s). The harness path runs in milliseconds.
  // NOTE: this.timeout() is not available in before() hook context in Node 24.
  // The timeout is set via describe() instead.

  if (!runIntegrationTests) return;

  // Unit tests leave nock interceptors active and disableNetConnect() may be
  // stuck in "block" mode. nock.restore() completely removes nock's patch on
  // globalThis.fetch, allowing real HTTP calls to pass through unhindered.
  nock.restore();

  // ── Path 1: Harness container — env vars already set by the harness ────
  // The harness sets OPENFGA_API_URL, OPENFGA_STORE_ID, OPENFGA_MODEL_ID.
  // Verify the connection and ensure the authorization model exists in the
  // harness store. If the model is absent (model_id not in store), create it.
  if (!useTestcontainers) {
    // OPENFGA_API_URL is set from env at module scope; use it directly.
    // If absent, fall back to the harness hostname (agent-openfga).
    OPENFGA_API_URL = process.env.OPENFGA_API_URL || (await resolveOpenFGAUrl());
    process.env.OPENFGA_API_URL = OPENFGA_API_URL;
    await api('/healthz');
    console.log('[SETUP] OpenFGA connection verified');

    // Store: use harness env var, or create one (OpenFGA returns a valid ULID).
    if (!process.env.OPENFGA_STORE_ID) {
      console.log('[SETUP] OPENFGA_STORE_ID not set — creating store...');
      const newStoreId = (await api<{ id: string }>('/stores', {
        method: 'POST',
        body: JSON.stringify({ name: STORE_NAME }),
      })).id;
      process.env.OPENFGA_STORE_ID = newStoreId;
      console.log(`[SETUP] store=${newStoreId} (created)`);
    }

    const storeId = process.env.OPENFGA_STORE_ID ?? FALLBACK_STORE_ID;

    // Model: use harness env var, or create one in the store.
    if (!process.env.OPENFGA_MODEL_ID) {
      console.log('[SETUP] OPENFGA_MODEL_ID not set — creating model...');
      const newModelId = await createModel(storeId);
      process.env.OPENFGA_MODEL_ID = newModelId;
      console.log(`[SETUP] model=${newModelId} (created)\n`);
    } else {
      const existingModelId = process.env.OPENFGA_MODEL_ID;
      try {
        await api(`/stores/${storeId}/authorization-models/${existingModelId}`);
        process.env.OPENFGA_MODEL_ID = existingModelId;
        console.log(`[SETUP] store=${storeId} model=${existingModelId} (existing)\n`);
      } catch {
        console.log(`[SETUP] Model ${existingModelId} not found; creating...`);
        const newModelId = await createModel(storeId);
        process.env.OPENFGA_MODEL_ID = newModelId;
        console.log(`[SETUP] model=${newModelId} (created)\n`);
      }
    }
    return;
  }

  // ── Path 2: testcontainers (host / GitHub CI) ─────────────────────────────
  console.log('[SETUP] Pulling and starting openfga/openfga container...');

  // Start container with a random host port mapped to container port 8080.
  // The OS picks an available port automatically — no conflicts.
  tcContainer = await new GenericContainer('openfga/openfga:latest')
    .withExposedPorts({ container: 8080, host: undefined })
    .withCommand(['run'])
    .withStartupTimeout(60_000)
    // Wait for the HTTP server startup log line before accepting connections.
    // OpenFGA logs "starting HTTP server" when the API is ready to accept requests.
    .withWaitStrategy(Wait.forLogMessage('starting HTTP server'))
    .start();

  const httpPort = tcContainer.getMappedPort(8080);
  const host = tcContainer.getHost();
  const openFgaUrl = `http://${host}:${httpPort}`;

  // Inject env vars so the SDK wrapper, api() helper, and scripts all pick
  // up the correct address automatically.
  process.env.OPENFGA_API_URL = openFgaUrl;
  console.log(`[SETUP] OpenFGA (testcontainers) at ${openFgaUrl}`);

  // Wait for the server to be ready
  await api('/healthz');
  console.log('[SETUP] OpenFGA healthy');

  // Create store and model
  console.log('[SETUP] Creating store and model...');
  const storeId = (await createStore(STORE_NAME)).id;
  const modelId = (await createModel(storeId ?? FALLBACK_STORE_ID)).id;
  process.env.OPENFGA_STORE_ID = storeId;
  process.env.OPENFGA_MODEL_ID = modelId;
  console.log(`[SETUP] store=${storeId}, model=${modelId}\n`);
});

after(async () => {
  // Only run cleanup when integration tests were actually active.
  // The after() hook fires even when the describe is skipped, but before()
  // may not have called nock.restore() in that case.
  if (!runIntegrationTests) return;

  console.log('\n[CLEANUP]');
  if (tcContainer) {
    await tcContainer.stop();
    tcContainer = null;
    console.log('[CLEANUP] testcontainers stopped');
  } else {
    await cleanupStores();
  }

  // Re-activate nock so any subsequent test files still have HTTP mocking.
  nock.activate();

  console.log('[CLEANUP] done\n');
});

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('OpenFGA Integration', { skip: !runIntegrationTests, timeout: 120_000 }, () => {
  const emailHash = createHash('sha256').update('test@test.com').digest('hex').substring(0, 40);
  const piiInstanceId = `pii_instance:sha256-${emailHash}`;

  // The store and model IDs are read from process.env, set by beforeAll
  const storeId = (): string => process.env.OPENFGA_STORE_ID!;
  const modelId = (): string => process.env.OPENFGA_MODEL_ID!;

  // -------------------------------------------------------------------------
  // model_instance can_share pii_instance
  // check(model_instance:support-bot, can_share, pii_instance:xxx)
  // can_share is on pii_instance, so model_instance must be an allowed user type
  // -------------------------------------------------------------------------
  it('model_instance can_share pii_instance', async () => {
    const tuple = { user: 'model_instance:support-bot', relation: 'can_share', object: piiInstanceId };
    await write(storeId(), modelId(), [tuple]);
    const allowed = await check(storeId(), modelId(), tuple.user, tuple.relation, tuple.object);
    assert.strictEqual(allowed, true, 'Model should be able to share PII instance');
    await del(storeId(), modelId(), [tuple]);
  });

  // -------------------------------------------------------------------------
  // pii_instance can_view recipient
  // check(recipient:alice, can_view, pii_instance:xxx)
  // can_view is on pii_instance, so recipient must be an allowed user type
  // -------------------------------------------------------------------------
  it('pii_instance can_view recipient', async () => {
    const tuple = { user: 'recipient:alice', relation: 'can_view', object: piiInstanceId };
    await write(storeId(), modelId(), [tuple]);
    const allowed = await check(storeId(), modelId(), tuple.user, tuple.relation, tuple.object);
    assert.strictEqual(allowed, true, 'PII instance should be viewable by recipient');
    await del(storeId(), modelId(), [tuple]);
  });

  // -------------------------------------------------------------------------
  // recipient can_receive_from model_instance (trust)
  // check(recipient:alice, can_receive_from, model_instance:support-bot)
  // can_receive_from is on model_instance, so recipient must be allowed user type
  // -------------------------------------------------------------------------
  it('recipient can_receive_from model_instance (trust)', async () => {
    const tuple = {
      user: 'recipient:alice',
      relation: 'can_receive_from',
      object: 'model_instance:support-bot',
    };
    await write(storeId(), modelId(), [tuple]);
    const allowed = await check(storeId(), modelId(), tuple.user, tuple.relation, tuple.object);
    assert.strictEqual(allowed, true, 'Recipient should be able to receive from model (trust)');
    await del(storeId(), modelId(), [tuple]);
  });

  // -------------------------------------------------------------------------
  // pii_instance lineage model_instance
  // check(pii_instance:xxx, lineage, model_instance:support-bot)
  // lineage is on pii_instance, so pii_instance must be the allowed user type
  // -------------------------------------------------------------------------
  it('pii_instance lineage model_instance (lineage)', async () => {
    const tuple = { user: piiInstanceId, relation: 'lineage', object: 'model_instance:support-bot' };
    await write(storeId(), modelId(), [tuple]);
    const allowed = await check(storeId(), modelId(), tuple.user, tuple.relation, tuple.object);
    assert.strictEqual(allowed, true, 'PII should have lineage to model');
    await del(storeId(), modelId(), [tuple]);
  });

  // -------------------------------------------------------------------------
  // category defines model_instance
  // check(model_instance:scanning-bot, defines, category:email)
  // defines is on category, so model_instance must be allowed user type
  // -------------------------------------------------------------------------
  it('category defines model_instance', async () => {
    const tuple = { user: 'model_instance:scanning-bot', relation: 'defines', object: 'category:email' };
    await write(storeId(), modelId(), [tuple]);
    const allowed = await check(storeId(), modelId(), tuple.user, tuple.relation, tuple.object);
    assert.strictEqual(allowed, true, 'Category should define model_instance');
    await del(storeId(), modelId(), [tuple]);
  });

  // -------------------------------------------------------------------------
  // denied without tuple
  // -------------------------------------------------------------------------
  it('denied without tuple', async () => {
    const allowed = await check(
      storeId(),
      modelId(),
      'model_instance:unknown',
      'can_share',
      piiInstanceId,
    );
    assert.strictEqual(allowed, false, 'Should be denied without tuple');
  });

  // -------------------------------------------------------------------------
  // complete sharing authorization flow (4-step checkShare simulation)
  // 1. model --can_share--> pii
  // 2. pii --lineage--> model
  // 3. pii --can_view--> recipient
  // 4. recipient --can_receive_from--> model
  // -------------------------------------------------------------------------
  it('complete sharing authorization flow', async () => {
    const tuples = [
      { user: 'model_instance:support-bot', relation: 'can_share', object: piiInstanceId },
      { user: piiInstanceId, relation: 'lineage', object: 'model_instance:support-bot' },
      { user: 'recipient:alice', relation: 'can_view', object: piiInstanceId },
      { user: 'recipient:alice', relation: 'can_receive_from', object: 'model_instance:support-bot' },
    ];
    await write(storeId(), modelId(), tuples);

    const checks = {
      modelCanShare: await check(storeId(), modelId(), 'model_instance:support-bot', 'can_share', piiInstanceId),
      lineageValid: await check(storeId(), modelId(), piiInstanceId, 'lineage', 'model_instance:support-bot'),
      recipientCanView: await check(storeId(), modelId(), 'recipient:alice', 'can_view', piiInstanceId),
      recipientTrustsModel: await check(
        storeId(),
        modelId(),
        'recipient:alice',
        'can_receive_from',
        'model_instance:support-bot',
      ),
    };

    const sharingAllowed =
      checks.modelCanShare && checks.lineageValid && checks.recipientCanView && checks.recipientTrustsModel;
    assert.strictEqual(sharingAllowed, true, `All checks should pass: ${JSON.stringify(checks)}`);

    await del(storeId(), modelId(), tuples);
  });
});
