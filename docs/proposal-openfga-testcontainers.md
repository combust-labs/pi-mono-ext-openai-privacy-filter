# Proposal: OpenFGA Integration Tests with Testcontainers

**Status:** Draft  
**Date:** 2026-05-13  
**Supersedes:** `test/openfga-integration.test.ts` — the current file's `agent-openfga` hostname approach (which only works inside a specific Docker harness network)  
**Complements:** `docs/proposal-upstream-openfga-sdk.md`, `docs/openfga-integration-proposal.md`

---

## 0. Relation to Existing Documents

| Document | Relationship |
|---|---|
| **`proposal-upstream-openfga-sdk.md`** | **Complemented** — this proposal adds testcontainers-based integration testing for the migrated SDK client. No changes to the wrapper itself. |
| **`openfga-integration-proposal.md`** | **Complemented** — the integration test in this proposal exercises the full authorization model described there. |
| **`docs/proposal-extension-integration-tests.md`** | **Loose complement** — that proposal covers extension integration tests; this proposal covers the OpenFGA data-plane integration tests. |
| **`test/openfga-integration.test.ts`** | **Superseded** — the existing file uses `agent-openfga` hostname resolution which only works inside a specific Docker harness container. This proposal replaces it with a testcontainers approach that works on any host or CI environment. |

---

## 1. Problem Statement

The existing `test/openfga-integration.test.ts` is skipped by default (`runIntegrationTests = process.env.OPENFGA_INTEGRATION_TEST === 'true'`). When enabled, it relies on a Docker-internal hostname `agent-openfga` that resolves to the OpenFGA container's IP inside the harness network. It also falls back to `http://agent-openfga:8080` at module load time via a `DNS.lookup()` call.

This approach fails in two of the three target environments:

| Environment | Current approach | Works? |
|---|---|---|
| Inside harness container | `agent-openfga` hostname + DNS lookup | ✅ Yes |
| On host machine | `agent-openfga` not in host DNS | ❌ No — falls back to invalid hostname |
| GitHub CI | No Docker harness, no `agent-openfga` | ❌ No — tests cannot run |

Additionally, the existing test hardcodes port `8080`. If that port is busy on the host, the test fails with no recourse.

---

## 2. Goals

1. OpenFGA integration tests run **automatically** in all three environments without manual container setup.
2. The OpenFGA server uses a **random host port** assigned by the OS — no port conflicts.
3. The `OPENFGA_API_URL`, `OPENFGA_STORE_ID`, and `OPENFGA_MODEL_ID` env vars are set from the container's mapped port and are consumed by the SDK wrapper.
4. The test file remains in `test/openfga-integration.test.ts` (rewritten), replacing the current hostname-based approach.
5. All other unit/integration tests continue to use **nock** (no real server) as before.

---

## 3. Solution: Testcontainers

[testcontainers-node](https://node.testcontainers.org/) spins up a Docker container per test suite, exposes a random host port, and returns the connection details. This replaces the `agent-openfga` hostname hack entirely.

### 3.1 New Dependency

```bash
npm install testcontainers --save-dev
```

### 3.2 Container Configuration

```typescript
import { GenericContainer, type StartedTestContainer } from 'testcontainers';

const container: StartedTestContainer = await new GenericContainer('openfga/openfga:latest')
  .withExposedPorts({ container: 8080, host: undefined }) // random host port
  .withCommand(['run'])
  .withWaitStrategy(Wait.forLogMessage('starting HTTP server'))
  .start();

const httpPort = container.getMappedPort(8080);
const host = container.getHost();

// e.g. http://127.0.0.1:54321
const openFgaUrl = `http://${host}:${httpPort}`;
```

> **Why random host port?** Binding to a fixed port like `8080` on the host fails if that port is already in use (another test, a local service, etc.). Using `withExposedPorts({ container: 8080, host: undefined })` asks Docker to allocate an available port, and `getMappedPort(8080)` returns what the OS assigned.

### 3.3 Env Var Injection

After the container starts, set `process.env` so the SDK wrapper and helper scripts pick it up automatically:

```typescript
process.env.OPENFGA_API_URL = `http://${container.getHost()}:${container.getMappedPort(8080)}`;
process.env.OPENFGA_STORE_ID = storeId;   // created in beforeAll
process.env.OPENFGA_MODEL_ID = modelId;   // created in beforeAll
```

The SDK wrapper (`src/openfga-sdk-wrapper.ts`) reads `OPENFGA_API_URL` at call time in `createSDKClient()` and `healthCheck()`, so setting the env var is sufficient — no code changes needed.

### 3.4 Store and Model Creation

OpenFGA's in-memory storage is ephemeral (data lost on container stop), so the test must create the store and authorization model in `beforeAll`. The model creation from the existing `openfga-integration.test.ts` can be reused directly.

```typescript
// Create store
const storeResponse = await api('/stores', { method: 'POST', body: JSON.stringify({ name: STORE_NAME }) });
const storeId = storeResponse.id;

// Create authorization model
const modelResponse = await api(`/stores/${storeId}/authorization-models`, {
  method: 'POST',
  body: JSON.stringify({ schema_version: '1.1', type_definitions: [...] }),
});
const modelId = modelResponse.authorization_model_id;
```

### 3.5 Teardown

```typescript
afterAll(async () => {
  await container.stop();  // also kills the in-memory store
});
```

---

## 4. Rewritten `test/openfga-integration.test.ts`

### 4.1 Structure

```typescript
// SPDX-License-Identifier: Apache-2.0
/**
 * OpenFGA Real Integration Tests — testcontainers-based
 *
 * These tests spin up a real OpenFGA server in a Docker container
 * using testcontainers. The server is accessible at a random host
 * port (no fixed port required). OPENFGA_API_URL is set as an env
 * var so the SDK wrapper picks it up automatically.
 *
 * Run with: OPENFGA_INTEGRATION_TEST=true npm test
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';

const STORE_NAME = 'privacy-integration-test';

let container: StartedTestContainer;
let storeId: string;
let modelId: string;

/** Lightweight fetch-based API helper using the dynamically-set OPENFGA_API_URL */
async function api(path: string, opts: RequestInit = {}): Promise<unknown> {
  const base = process.env.OPENFGA_API_URL;
  const r = await fetch(`${base}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...opts.headers },
  });
  if (!r.ok) throw new Error(`OpenFGA ${path} (${r.status}): ${await r.text()}`);
  return r.json();
}

// ---------------------------------------------------------------------------
// Container lifecycle
// ---------------------------------------------------------------------------

before(async () => {
  // 1. Start container with random host port
  container = await new GenericContainer('openfga/openfga:latest')
    .withExposedPorts({ container: 8080, host: undefined })
    .withCommand(['run'])
    .withWaitStrategy(Wait.forLogMessage('starting HTTP server'))
    .start();

  const httpPort = container.getMappedPort(8080);
  const host = container.getHost();

  // 2. Inject connection env vars for SDK wrapper and scripts
  process.env.OPENFGA_API_URL = `http://${host}:${httpPort}`;
  console.log(`[SETUP] OpenFGA at ${process.env.OPENFGA_API_URL}`);

  // 3. Wait for server to be ready
  await api('/healthz');
  console.log('[SETUP] OpenFGA healthy');

  // 4. Create store
  storeId = (await api('/stores', {
    method: 'POST',
    body: JSON.stringify({ name: STORE_NAME }),
  })) as { id: string };

  // 5. Create authorization model (reuse existing model definition)
  modelId = (await api(`/stores/${storeId}/authorization-models`, {
    method: 'POST',
    body: JSON.stringify({ schema_version: '1.1', type_definitions: [...] }),
  })) as { authorization_model_id: string };

  process.env.OPENFGA_STORE_ID = storeId;
  process.env.OPENFGA_MODEL_ID = modelId;

  console.log(`[SETUP] store=${storeId}, model=${modelId}`);
});

after(async () => {
  await container?.stop();
});

// ---------------------------------------------------------------------------
// Integration tests (same test cases as before, now portable)
// ---------------------------------------------------------------------------
describe('OpenFGA Integration', () => {
  // ... existing test cases unchanged ...
});
```

### 4.2 `Wait` Import

`testcontainers` exports `Wait` for wait strategies:

```typescript
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
```

### 4.3 `runIntegrationTests` Guard

The guard remains — tests are opt-in via `OPENFGA_INTEGRATION_TEST=true`. In CI and on the host, this avoids requiring Docker when running unit tests.

---

## 5. Interaction with Unit Tests

- Unit tests (all other test files) use **nock** — they are unaffected.
- The `test/openfga-integration.test.ts` file is **never compiled into the main test run** unless `OPENFGA_INTEGRATION_TEST=true`. Node.js `--test` will discover it but skip it via the `describe({ skip: !runIntegrationTests }, ...)`.
- Since `OPENFGA_API_URL` is set in the `beforeAll` hook of the integration test file (not at module load time), and unit tests run in a separate Node.js process, the env var does not leak between test types.
- If a unit test file imports `openfga-sdk-wrapper.ts` at module scope and that module reads `process.env.OPENFGA_API_URL` at call time (not module scope), it reads the env var when the function is called — which is always after the test harness has set it. This is already the case and working correctly.

---

## 6. GitHub CI Changes

A new `integration` job is added to `.github/workflows/ci.yml`:

```yaml
jobs:
  integration:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: read
    services:
      docker:
        image: docker:24-git
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm ci
      - run: docker pull openfga/openfga:latest  # pre-pull to avoid timeout
      - name: Run integration tests
        run: OPENFGA_INTEGRATION_TEST=true npm test
        env:
          OPENFGA_INTEGRATION_TEST: 'true'
```

> **Note:** `testcontainers` uses the Docker socket mounted into the action runner (`/var/run/docker.sock`), which is available on `ubuntu-latest` runners by default. No additional Docker service containers configuration are needed — testcontainers manages its own container lifecycle.

---

## 7. On the Host Machine

Developers run integration tests with:

```bash
OPENFGA_INTEGRATION_TEST=true npm test
```

Docker must be running. testcontainers pulls the `openfga/openfga:latest` image on first run (may take a minute; subsequent runs reuse the cached image).

---

## 8. Security Considerations

- The in-memory OpenFGA image is for **testing only** — no data persists after the container stops.
- No authentication is configured on the testcontainer OpenFGA instance — appropriate for an isolated test environment.
- The random port prevents testcontainers from conflicting with any existing service on the host.

---

## 9. Open Questions

1. **Playground port (3000):** The OpenFGA image also exposes port 3000 for the Playground. Should we also map it for debugging? If not, we can use `.withExposedPorts(8080)` only (Docker assigns a random host port for 3000 automatically if `withExposedPorts` is not called for it, which is fine since the tests don't need the Playground).

2. **Image tag:** Using `openfga/openfga:latest` ensures the latest features. Pinning to a specific version (e.g., `openfga/openfga:1.8`) provides reproducibility at the cost of needing updates. Recommend pinning in `package.json` or a env var, defaulting to `latest` for CI.

3. **Test isolation:** Each test run creates a new store (`privacy-integration-test-{timestamp}`) so parallel test runs or rapid re-runs do not conflict. The `afterAll` cleanup calls `container.stop()` which destroys the container and all its data.

4. **Timeout:** Pulling the Docker image on first run in CI may exceed the default test timeout. Mitigations: (a) pre-pull in the CI step before tests, (b) increase Jest/node test timeout via `testTimeout: 120_000`.

---

## 10. Implementation Checklist

### Phase A: Install testcontainers
- [x] `npm install testcontainers --save-dev`

### Phase B: Rewrite `test/openfga-integration.test.ts`
- [x] Import `GenericContainer`, `Wait`, `StartedTestContainer` from `testcontainers`
- [x] Keep `getOpenFGAUrlSync()` / `resolveOpenFGAUrl()` for harness container path
- [x] Add `USE_TESTCONTAINERS` env var detection to trigger testcontainers path
- [x] Use `withExposedPorts({ container: 8080, host: undefined })` for random port
- [x] Use `Wait.forLogMessage('starting HTTP server')` for container readiness
- [x] Set `process.env.OPENFGA_API_URL`, `OPENFGA_STORE_ID`, `OPENFGA_MODEL_ID` in `beforeAll`
- [x] Create store and authorization model in `beforeAll` (reuse existing logic)
- [x] Stop container in `afterAll`; harness path calls `cleanupStores()`
- [x] Keep `runIntegrationTests` guard and `describe({ skip: !runIntegrationTests }, ...)`
- [ ] Verify tests pass with `OPENFGA_INTEGRATION_TEST=true npm test` on host (deferred — outside container)

### Phase C: GitHub CI
- [ ] Add `integration` job to `.github/workflows/ci.yml`
- [ ] Pre-pull `openfga/openfga:latest` image
- [ ] Run with `OPENFGA_INTEGRATION_TEST=true`
- [ ] Verify CI passes

### Phase D: Cleanup
- [ ] Remove `test/support/fetch-mock.ts` (not present — superseded by prior nock migration)
- [ ] Confirm all 200 unit tests still pass without `OPENFGA_INTEGRATION_TEST`