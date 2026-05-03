# OpenFGA Integration Proposal

## Overview

Integrate **OpenFGA** (Open Fine-Grained Authorization) as a REST API-driven authorization layer to control which PII categories the model can access. This adds a policy engine on top of the existing PII detection/masking.

---

## Conceptual Model

```
Subject:    mlx-community/MiniMax-M2.7-8bit  (the LLM model)
Relation:   can_view
Object:     privacy_category or privacy_category:sha256_hash_of_literal
```

### Design Rationale

- **Category** is stored as a plain string (e.g., `private_email`, `secret`) since it is not sensitive metadata.
- **Specific literals** (e.g., `user@company.com`) are **never** stored in the policy engine. Instead, a SHA256 hash of the literal is used as the object identifier.
- This prevents the authorization policy from leaking or inadvertently logging sensitive PII values.

### Example Authorization Tuples

| Tuple | Meaning |
|-------|---------|
| `model_instance:mlx-community/MiniMax-M2.7-8bit can_view privacy_category:private_email` | Model can view all emails (category-level) |
| `model_instance:mlx-community/MiniMax-M2.7-8bit can_view privacy_category:sha256-3f2e8d7c4b1a` | Model can view the specific email whose SHA256 is `3f2e8d7c4b1a` |
| `model_instance:mlx-community/MiniMax-M2.7-8bit can_view privacy_category:secret` | Model can view secrets (generally discouraged) |

### SHA256 Hash Computation

```typescript
import { createHash } from 'crypto';

function hashLiteral(literal: string): string {
  return createHash('sha256').update(literal).digest('hex');
}

// Example:
// hashLiteral("user@company.com") -> "3f2e8d7c4b1a9f0e2d6c8b4a1f3e2d9c8b4a1f3e"
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     pi-mono agent                           │
├─────────────────────────────────────────────────────────────┤
│  Privacy Filter Extension (index.ts)                        │
│                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │ PII Detector │───▶│ OpenFGA      │───▶│ Masking      │  │
│  │ (Transformers)│    │ Check        │    │ Engine       │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
│                            │                                │
│                            ▼                                │
│                     ┌──────────────┐                        │
│                     │ OpenFGA REST │                        │
│                     │ API          │                        │
│                     └──────────────┘                        │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│              OpenFGA Server (separate process)               │
│                                                             │
│  Model: DSL or JSON                                         │
│  Store: privacy-policies                                    │
└─────────────────────────────────────────────────────────────┘
```

---

## OpenFGA Model (DSL)

```python
model
  schema 1.1

type model_instance
  relations
    define can_view: [privacy_category]

type privacy_category
  relations
    define can_view: [model_instance]
```

> **Note**: The object portion of a tuple uses `privacy_category:<category>` for category-level checks and `privacy_category:sha256-<hash>` for specific literal checks. The SHA256 hash is stored directly in the object ID — no special relation type is needed.

---

## Proposed Code Changes

### 1. New file: `openfga.ts`

```typescript
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'crypto';

type OpenFGAClientConfig = {
  apiUrl: string;      // e.g., "http://localhost:28080"
  storeId: string;     // e.g., "privacy-policies"
  modelId: string;     // e.g., "privacy-model"
};

type CheckRequest = {
  subject: string;       // e.g., "mlx-community/MiniMax-M2.7-8bit"
  relation: string;      // e.g., "can_view"
  object: string;        // e.g., "private_email" or "sha256-3f2e8d7c4b1a..."
  literal?: string;      // e.g., "user@company.com" — if provided, object is ignored and hash is computed
};

function hashLiteral(literal: string): string {
  // Truncated to 40 hex chars (20 bytes) for readability while maintaining collision resistance
  return createHash('sha256').update(literal).digest('hex').substring(0, 40);
}

export class OpenFGAClient {
  constructor(private config: OpenFGAClientConfig) {}

  async check(request: CheckRequest): Promise<boolean> {
    let objectId: string;

    if (request.literal) {
      // Hash the literal — never use raw value in policy engine
      objectId = `privacy_category:sha256-${hashLiteral(request.literal)}`;
    } else if (request.object.startsWith('sha256-')) {
      // Already a hash
      objectId = `privacy_category:${request.object}`;
    } else {
      // Category-only object
      objectId = `privacy_category:${request.object}`;
    }

    const response = await fetch(
      `${this.config.apiUrl}/stores/${this.config.storeId}/check`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tuple_key: {
            user: `model_instance:${request.subject}`,
            relation: request.relation,
            object: objectId,
          },
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`OpenFGA check failed: ${response.statusText}`);
    }

    const result = await response.json();
    return result.allowed === true;
  }

  async writeTuples(tuples: Array<{
    subject: string;
    relation: string;
    object: string;
    literal?: string;
  }>): Promise<void> {
    await fetch(
      `${this.config.apiUrl}/stores/${this.config.storeId}/write`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          writes: {
            tuple_keys: tuples.map(t => {
              let objectId: string;
              if (t.literal) {
                objectId = `privacy_category:sha256-${hashLiteral(t.literal)}`;
              } else {
                objectId = `privacy_category:${t.object}`;
              }
              return {
                user: `model_instance:${t.subject}`,
                relation: t.relation,
                object: objectId,
              };
            }),
          },
        }),
      }
    );
  }
}
```

### 2. Modified `index.ts` — Integration Point

```typescript
import { OpenFGAClient } from "./openfga";

const OPENFGA_API_URL = process.env.OPENFGA_API_URL || "http://localhost:28080";
const OPENFGA_STORE_ID = process.env.OPENFGA_STORE_ID || "privacy-policies";
const OPENFGA_MODEL_ID = process.env.OPENFGA_MODEL_ID || "privacy-model";
const MODEL_SUBJECT = process.env.PRIVACY_FILTER_MODEL_SUBJECT || "mlx-community/MiniMax-M2.7-8bit";

// Initialize OpenFGA client
const openfga = new OpenFGAClient({
  apiUrl: OPENFGA_API_URL,
  storeId: OPENFGA_STORE_ID,
  modelId: OPENFGA_MODEL_ID,
});

// In before_agent_start handler, after PII detection:
const deniedCategories = new Set<string>();

for (const entity of results) {
  const category = entity.entity_group;    // e.g., "private_email"
  const literal = entity.word;             // e.g., "user@company.com"

  // Check specific literal (hashed) AND general category
  const canViewLiteral = await openfga.check({
    subject: MODEL_SUBJECT,
    relation: "can_view",
    literal,  // internally hashed before being sent to OpenFGA
  });

  const canViewCategory = await openfga.check({
    subject: MODEL_SUBJECT,
    relation: "can_view",
    object: category,
  });

  // Only mask if NOT authorized by either check
  if (!canViewLiteral && !canViewCategory) {
    deniedCategories.add(category);
  }
}

// Mask PII categories that are NOT authorized
const maskedText = maskPII(text, results.filter(r => deniedCategories.has(r.entity_group)));
```

### 3. Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENFGA_API_URL` | `http://localhost:28080` | OpenFGA REST API URL |
| `OPENFGA_STORE_ID` | `privacy-policies` | OpenFGA store ID |
| `OPENFGA_MODEL_ID` | `privacy-model` | Authorization model ID |

> **Note**: The model subject (e.g. `mlx-community/MiniMax-M2.7-8bit`) is read from pi-mono's active model via `ctx.model?.id` at runtime. No environment variable is needed.

---

## REST API Endpoints (OpenFGA)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/stores/{storeId}/check` | Check if model can view a category or hashed literal |
| `POST` | `/stores/{storeId}/write` | Add/remove authorization tuples |
| `POST` | `/stores/{storeId}/read` | Read current tuples |
| `GET` | `/stores/{storeId}` | Store info |

---

## Workflow Example

### Step 1: Admin writes authorization tuples (with hashed literals)

```bash
# SHA256("admin@company.com") = 3f2e8d7c4b1a9f0e2d6c8b4a1f3e2d9c8b4a1f3e
# SHA256("user@company.com")  = 7c8b4a1f3e2d9c8b4a1f3e2d9c8b4a1f3e2d

curl -X POST http://localhost:28080/stores/privacy-policies/write \
  -H "Content-Type: application/json" \
  -d '{
    "writes": {
      "tuple_keys": [
        {"user": "model_instance:mlx-community/MiniMax-M2.7-8bit", "relation": "can_view", "object": "privacy_category:private_email"},
        {"user": "model_instance:mlx-community/MiniMax-M2.7-8bit", "relation": "can_view", "object": "privacy_category:sha256-3f2e8d7c4b1a9f0e2d6c8b4a1f3e2d9c8b4a1f3e"}
      ]
    }
  }'
```

> **Note**: The actual email addresses are **never** sent to or stored in OpenFGA. Only their SHA256 hashes appear in authorization tuples.

### Step 2: User sends prompt with PII

```
"Please summarize the emails from admin@company.com and user@company.com"
```

### Step 3: Extension queries OpenFGA for each detected PII

For each detected PII entity, the extension computes the SHA256 hash locally and queries OpenFGA:

| PII Entity | SHA256 Hash (truncated) | OpenFGA Check | Result |
|------------|-------------------------|---------------|--------|
| `admin@company.com` (email) | `3f2e8d7c4b1a...` | `check(model_instance:mlx-community/MiniMax-M2.7-8bit, can_view, privacy_category:sha256-3f2e8d7c4b1a...)` | **allowed** → not masked |
| `user@company.com` (email) | `7c8b4a1f3e2d...` | `check(model_instance:mlx-community/MiniMax-M2.7-8bit, can_view, privacy_category:sha256-7c8b4a1f3e2d...)` | **denied** → masked as `[EMAIL REDACTED]` |

The category-level check (`privacy_category:private_email`) is also performed as a fallback — if the model has category-level access, any literal under that category is allowed.

### Step 4: Prompt to model after masking

```
"Please summarize the emails from admin@company.com and [EMAIL REDACTED]"
```

---

## Implementation Order

1. Create `openfga.ts` client class with REST API calls and SHA256 hashing
2. Modify `index.ts` to integrate OpenFGA checks after PII detection
3. Add environment variables to README documentation
4. Document `docker-compose.yaml` for local OpenFGA development in the readme file.
5. Write unit tests with a mock OpenFGA server (e.g., using MSW or a simple test server)

---

## Detailed Implementation Plan

### Phase 1: OpenFGA Client (`openfga.ts`) — ✅ DONE

- [x] Add `openfga.ts` to project root
- [x] Implement `hashLiteral()` using Node.js `crypto.createHash('sha256')`, truncated to 40 chars
- [x] Implement `OpenFGAClient` class with:
  - [x] Constructor accepting `apiUrl`, `storeId`, `modelId`
  - [x] `check(request)` — POST to `/stores/{storeId}/check`, hash literal if provided, return `boolean`
  - [x] `writeTuples(tuples)` — POST to `/stores/{storeId}/write`, hash literals before writing
  - [x] `readTuples(filter?)` — GET from `/stores/{storeId}/read`, optional filter by tuple_key
- [x] Add `OPENFGA_API_URL`, `OPENFGA_STORE_ID`, `OPENFGA_MODEL_ID` env var handling with defaults
- [x] Handle errors gracefully — throw on non-2xx responses from OpenFGA
- [x] Export `OpenFGAClient` and `hashLiteral` for testing

  > Added: `deleteTuples()` for completeness, `getOpenFGAClient()` singleton helper, Bearer token auth support via `OPENFGA_API_TOKEN` env var. Note: model subject is not read from an env var — it is sourced from `ctx.model?.id` at runtime in `index.ts`.

### Phase 2: Integration (`index.ts`) — ✅ DONE

- [x] Import `OpenFGAClient` from `./openfga`
- [x] Initialize client with env vars in extension setup (lazy init on first use)
- [x] In `before_agent_start` handler:
  - [x] After PII detection via `classifier(text)`
  - [x] For each detected entity, check category-level first (one call per unique category), then individual literals only if category check fails
  - [x] Build `deniedCategories` set (categories where both literal and category checks fail or throw)
  - [x] Apply `maskPII()` only to entities in `deniedCategories`
  - [x] If OpenFGA is unreachable, default to masking all PII (fail-closed)
- [x] In `context` handler:
  - [x] Apply same OpenFGA authorization logic before masking PII in message history
  - [x] Only mask categories not authorized by either literal or category-level check

  > Model subject is now read from `ctx.model?.id` (pi-mono's active model) at runtime — no `PRIVACY_FILTER_MODEL_SUBJECT` env var needed. If no model is set, extension fail-closes (masks all PII). `buildDeniedCategoriesSet()` helper accepts `modelSubject` as parameter. PII alert now distinguishes MASKED vs ALLOWED per entity.

### Phase 3: Configuration & Documentation — ✅ DONE

- [x] Add `docker run` commands and/or scripts for local OpenFGA startup (see `scripts/openfga-init.sh`)
- [x] Add initialization script or curl commands to create store and model on first startup
  - [x] Add tuple management script (`scripts/openfga-tuple.sh`) for grant/revoke/list operations
- [x] Update README.md:
  - [x] Document all new environment variables (OPENFGA_API_URL, OPENFGA_STORE_ID, OPENFGA_MODEL_ID, OPENFGA_API_TOKEN)
  - [x] Add a "Quick Start" section: run docker-compose, set env vars, use extension
  - [x] Document the OpenFGA authorization model (DSL and JSON) so operators can recreate it
  - [x] Add troubleshooting section for common OpenFGA connection issues
  - [x] Document helper scripts (openfga-init.sh, openfga-tuple.sh) with usage examples

### Phase 4: Testing

#### 4.1 `hashLiteral()` Unit Tests — ✅ DONE

- [x] Deterministic output: same input always produces same hash
- [x] Different inputs produce different hashes (no collisions on small set)
- [x] Output is truncated to exactly 40 hex characters
- [x] Empty string produces a valid 40-char hash

#### 4.2 `OpenFGAClient` Unit Tests

Using a mock HTTP handler (e.g., MSW or a simple `fetch` override) so tests run without a live OpenFGA server:

**`check()` tests:** — ✅ DONE
- [x] Returns `true` when OpenFGA responds with `allowed: true`
- [x] Returns `false` when OpenFGA responds with `allowed: false`
- [x] Sends `model_instance:<subject>` as the user field (not `model:<subject>`)
- [x] Sends `privacy_category:sha256-<hash>` when `literal` is provided
- [x] Sends `privacy_category:<category>` when only `object` is provided
- [x] Sends `Bearer <OPENFGA_API_TOKEN>` Authorization header when env var is set
- [x] Sends `authorization_model_id` in request body when `modelId` is configured
- [x] Throws on non-2xx response (includes status and body in error message)
- [x] Handles network errors gracefully (throws descriptive error)

**`writeTuples()` tests:** — ✅ DONE
- [x] Hashes each tuple's `literal` before writing to OpenFGA
- [x] Uses category-only object when `object` is provided without `literal`
- [x] Sends `model_instance:<subject>` as the user field
- [x] Throws on non-2xx response

**`deleteTuples()` tests:** — ✅ DONE
- [x] Same hashing and user field behavior as `writeTuples()`
- [x] Sends tuples under the `deletes` key in request body
- [x] Throws on non-2xx response

**`readTuples()` tests:** — ✅ DONE
- [x] Builds correct query params when `filter.subject` is provided
- [x] Builds correct query params when `filter.relation` is provided
- [x] Builds correct query params when `filter.object` is provided (prefixes with `privacy_category:`)
- [x] Returns `result.tuples` array from response body
- [x] Throws on non-2xx response

#### 4.3 `buildDeniedCategoriesSet()` Unit Tests

> **Prerequisites**: The `buildDeniedCategoriesSet()` function must be exported from `index.ts` (or moved to a testable module) so it can be directly imported in tests. Additionally, `getOpenFGAClient()` must be mockable — either by making it injectable or by adding a `setOpenFGAClient(client)` setter in `openfga.ts` for testing purposes.

**Test infrastructure needed**:

1. **`test/support/mock-openfga-client.ts`** — A mock implementing the `OpenFGAClient` interface:
   ```typescript
   type MockOpenFGAClient = {
     checkResults: Map<string, boolean>;  // key: `${subject}:${relation}:${object|literal}` → result
     checkCalls: Array<{ subject: string; relation: string; literal?: string; object?: string }>;
     shouldThrow: boolean;
     throwError: Error;
     check: (req: CheckRequest) => Promise<boolean>;
   };
   ```

2. **`test/support/mock-openfga-client.ts`** — A `createMockOpenFGAClient()` factory:
   ```typescript
   export function createMockOpenFGAClient(): MockOpenFGAClient;
   export function resetOpenFGAClient(): void;  // resets singleton for test isolation
   ```

3. **In `openfga.ts`**, add a test injection point (e.g., `setOpenFGAClient(client)` that overrides the singleton for tests). Alternatively, refactor `buildDeniedCategoriesSet()` to accept an optional `openfgaClient` parameter, defaulting to `getOpenFGAClient()`.

**Implementation approach**:
- Import `buildDeniedCategoriesSet` directly (after exporting it from `index.ts`).
- Use `createMockOpenFGAClient()` to get a configurable mock.
- Override the singleton via `setOpenFGAClient(mock)` before each test.
- Call `buildDeniedCategoriesSet(results, modelSubject)` and assert on the returned `Set<string>`.
- Reset the singleton in `afterEach`.

**Test cases**:

- [x] `fail-closed when OpenFGA throws on first category-level check` — verify all detected categories are in the returned set
- [x] `fail-closed when OpenFGA throws mid-batch after some category checks succeed` — verifies no partial results are used; all categories denied
- [x] `returns empty set when all categories pass category-level check` — mock `check()` to return `true` for category-level calls
- [x] `returns empty set when all individual literals pass but no category-level access` — mock category-level `false`, literal-level `true` for each entity
- [x] `returns only categories that fail BOTH literal and category checks` — mock both levels `false`; verify only those categories are in the set
- [x] `one category allowed, one denied` — mixed results across categories
- [x] `groups entities by category and makes exactly one category-level check per unique category` — verify `checkCalls` has exactly one category-level call per unique `entity_group`
- [x] `short-circuits on first error — no additional check() calls after throw` — mock error on 2nd category; verify only 1 call was made before error
- [x] `handles empty results array` — returns empty set with zero OpenFGA calls
- [x] `handles single entity` — verifies correct behavior for n=1

**What to assert**:
- Return value (`Set<string>` contents)
- Number of `check()` calls made and their arguments (call counting)
- That call ordering is: category-level first, then per-literal only if category-level fails
- That `openfgaAvailable = false` path covers all categories

**Key complexity**: The function groups entities by category and makes **at most one** category-level check per unique category. If the category-level check fails, it then checks each literal under that category individually. If **any** literal passes, the category is allowed. Only if the category-level fails AND all literals fail is the category denied. Tests must verify the happy path (all allowed/denied) and the mixed-path (some categories allowed, some not). The fail-closed behavior on error is especially important to test — on the first `check()` throw, all categories must be denied regardless of prior results.

#### 4.4 `index.ts` Integration Tests (mock OpenFGA + mock classifier)

Mock both the HuggingFace `pipeline` (token-classification) and the OpenFGA `check()` responses:

- [x] PII is masked when OpenFGA denies both literal and category (fail-closed for specific entity)
- [x] PII is NOT masked when OpenFGA allows category-level access
- [x] PII is NOT masked when OpenFGA allows the specific literal
- [x] All PII is masked when OpenFGA is unreachable (fail-closed on global error)
- [x] Inline `pii-alert` message is sent with correct `MASKED` / `ALLOWED` per entity
- [x] `systemPrompt` injection is always present (independent of PII presence)
- [x] `context` handler applies same OpenFGA logic to historical messages
- [x] `context` handler filters out `pii-alert` custom messages before sending to model
- [x] `/check-pii` command sends inline alert with detected PII (no masking, no OpenFGA check)
- [x] When `ctx.model?.id` is absent, all detected PII is masked (fail-closed)

**Implementation approach**:

The integration tests require a shim that mimics the pi coding agent's `ExtensionAPI` and a mock for the HuggingFace `pipeline`. Both existing mocks (`test/support/mock-openfga-client.ts`, `test/support/fetch-mock.ts`) are reused.

```typescript
// test/support/pi-extension-shim.ts
// Provides a fake ExtensionAPI that captures sendMessage calls,
// registers message renderers/commands, and lets us invoke
// before_agent_start and context handlers directly.

export interface ShimExtensionAPI {
  api: ExtensionAPI;
  sentMessages: Array<{ customType?: string; content: string; display: boolean }>;
  registeredRenderers: Map<string, Function>;
  registeredCommands: Map<string, { description: string; handler: Function }>;
  reset(): void;
}

export function createShimExtensionAPI(): ShimExtensionAPI;
```

```typescript
// test/support/mock-pipeline.ts
// Mocks the @huggingface/transformers pipeline for token-classification.
// Returns configurable PII detection results.

export interface MockPipeline {
  mockResults: AggregatedAnnotation[];
  shouldThrow: boolean;
}
export function createMockPipeline(): MockPipeline;
```

**Test structure** (`test/index-integration.test.ts`):

1. **Setup**: Import `piiExtension`, install pipeline mock, install OpenFGA mock, create shim API
2. **before_agent_start tests**: Call the handler with a mock event/ctx, verify:
   - Return value contains modified `prompt` (masked or original)
   - Return value contains `systemPrompt` with injection
   - `sendMessage` was called with `pii-alert` custom message
3. **context handler tests**: Call the handler with mock event/ctx containing messages, verify:
   - PII in user messages is masked/allowed based on OpenFGA
   - `pii-alert` messages are filtered out of returned messages
4. **Command tests**: Invoke `/check-pii` handler directly, verify no masking occurs

**Prerequisites to implement**:

1. **`test/support/pi-extension-shim.ts`** — Shim `ExtensionAPI` with:
   - `registerMessageRenderer(id, renderer)` — records renderers for later inspection
   - `registerCommand(name, config, handler)` — records commands for direct invocation
   - `on(event, handler)` — records event handlers; provides a `triggerEvent(name, event, ctx)` helper to invoke them
   - `sendMessage(msg)` — records sent messages for assertion
   - `ctx` mock object with `model?.id` (configurable) and `ui.notify()` (records calls)

2. **`test/support/mock-pipeline.ts`** — Mock `pipeline` function:
   - Intercepts calls to `@huggingface/transformers` pipeline
   - Returns configurable `AggregatedAnnotation[]` results
   - Can be set to throw (simulate model load failure)
   - Uses `beforeEach`/`afterEach` to install/uninstall via `Module._registerHook` or similar

3. **In `test/index-integration.test.ts`**:
   - Import `piiExtension` and call it with shim API to register handlers
   - For each test case, configure mock pipeline results + mock OpenFGA responses
   - Trigger `before_agent_start` or `context` handlers via shim's `triggerEvent()`
   - Assert on returned prompt, systemPrompt, sent messages

**Key complexity**: The `context` handler must filter out `pii-alert` custom messages before processing — this prevents recursive masking of alerts generated in earlier turns. Tests must verify both the filtering (messages absent from output) and the masking of remaining user message content.

#### 4.5 Test Infrastructure

- [x] Add `test/support/mock-openfga-client.ts` — exports a `createMockOpenFGAClient()` that records calls and returns configurable responses, implementing the same interface as `OpenFGAClient`
- [x] Add `test/support/pi-extension-shim.ts` — fake `ExtensionAPI` for testing extension handlers, message renderers, and commands (see Section 4.4)
- [x] Tests run with `node --import tsx --test` (tsx handles TypeScript transpilation; no live OpenFGA or HuggingFace model needed)
- [x] All tests pass in headless CI environment

#### 4.6 GitHub CI Integration

**Implementation approach**:

A GitHub Actions workflow runs the test suite on every PR and after every merge to `main`. No external services (OpenFGA, HuggingFace) are required — all tests use mocks.

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm ci
      - run: npm test
```

**What the workflow does**:

1. **Checkout** the repository code
2. **Setup Node.js 22** with npm cache for faster installs
3. **`npm ci`** — install exact dependencies from `package-lock.json`
4. **`npm test`** — runs `node --import tsx --import ./test/support/register-loader.mjs --test` (all 87+ tests, no live services needed)

**Failure handling**:

- If any test fails, the PR check fails and cannot be merged
- After a merge to `main`, a failing test run triggers a notification (configure via GitHub repository settings → Notifications)
- The workflow does **not** deploy or release — it is test-only

**Secrets**:

- No secrets are required; tests mock all external services
- If real OpenFGA integration tests are added in the future, `OPENFGA_API_URL`, `OPENFGA_API_TOKEN`, and `OPENFGA_STORE_ID` would be added as repository secrets and passed via `env` in the workflow

**Extending later**:

- Add `npm run build` step if a compilation step is added
- Add `npm run check` (lint/type-check) as a separate job
- Add a job that publishes coverage reports on merge to `main`
- Add a job that runs real OpenFGA integration tests against a live server (skipped in PRs unless explicitly requested)

### Phase 5: Operational Readiness

- [ ] Add health check: verify OpenFGA server is reachable before first authorization check
- [ ] Add metrics/logging for:
  - [ ] Number of PII entities detected per prompt
  - [ ] Authorization decisions (allowed/denied) per category
  - [ ] OpenFGA latency
  - [ ] Errors and fallbacks (fail-closed events)
- [ ] Document tuple management: how to grant/revoke model access to categories and specific literals
- [ ] Add example curl commands for common admin operations (grant category, grant specific literal, revoke)
- [ ] Consider adding a `/check-auth` debug command (similar to `/check-pii`) to inspect authorization state

---

## Security Considerations

1. **Default deny**: If OpenFGA is unavailable or returns an error, the extension should default to masking all PII (fail-closed).
2. **No raw literals in policy engine**: Specific PII values are hashed before being sent to OpenFGA. The authorization store never contains plaintext PII.
3. **Store validation**: Validate `storeId` and `modelId` match expected values.
4. **Network isolation**: OpenFGA server should run in a trusted network segment.
5. **Audit logging**: Consider logging all authorization decisions for compliance.
6. **Collision resistance**: SHA256 truncation (40 chars) maintains strong collision resistance for the intended use case.
