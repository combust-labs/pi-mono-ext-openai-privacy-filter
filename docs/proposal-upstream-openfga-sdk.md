# Proposal: Replace Custom OpenFGA Client with Upstream `@openfga/sdk`

**Status:** Draft  
**Date:** 2026-05-12  
**References:**
- Current implementation: `openfga.ts` (custom client, ~400 LOC)
- Test mock: `test/support/fetch-mock.ts` (~90 LOC)
- Upstream SDK: https://github.com/openfga/js-sdk (`@openfga/sdk` on npm)

---

## 0. Relation to Existing Documents

This proposal is authored in the context of existing work documented in `docs/`. The following describes how it relates to those documents.

| Document | Relationship | Key Dependencies / Notes |
|---|---|---|
| **`openfga-integration-proposal.md`** | **Complements** — does not supersede | This proposal evaluates swapping the custom OpenFGA client for the upstream SDK. It does not change the authorization model (tuples, `model_instance:`, `pii_instance:`, `recipient:`, `category:`, relations like `can_view`, `can_share`, `lineage`, `can_receive_from`) described in the integration proposal. The abstraction layer (§7.1) preserves all existing model conventions. |
| **`proposal-privacy-filter-extension-tests.md`** | **Complements and informs** | That proposal identifies the need to mock `getOpenFGAClient()` in tests. This proposal directly answers that need: replace the custom `fetch-mock.ts` / `getOpenFGAClient()` pattern with the upstream SDK + **nock** for HTTP response mocking only. Test rewrite guidance in §4.5 applies directly here. |
| **`proposal-reverse-pii-sharing-authorization.md`** | **Complements** | Extends the authorization model with `can_share` and `recipient:` tuples, built on top of the same base OpenFGA integration. The abstraction layer in this proposal (privacy hashing, ID builders, `checkShare()`) applies unchanged to those new relations. |
| **`openfga-model-tutorial.md`** | **Complements** | A tutorial on the OpenFGA authorization model. This proposal does not change the model; it changes only the HTTP transport. No changes needed to the tutorial. |
| **`proposal-extension-integration-tests.md`** | **Loose complement** | Deals with extension integration tests at a higher level (tool registration, TUI rendering). Less directly connected to the OpenFGA HTTP transport, but the test infrastructure approach described here (mocking network calls) is consistent with what that proposal would need for any OpenFGA-related test scenarios. |
| **`pii-check-directions-analysis.md`** | **No direct relationship** | Analyzes PII check directions (input/output) in the extension lifecycle. Unrelated to the OpenFGA client implementation. |

**What this proposal does not change:**
- The authorization model (tuples, types, relations)
- The privacy hashing behavior (`hashLiteral()`, the `pii_instance:sha256-` prefix convention)
- The ID builder conventions (`model_instance:`, `recipient:`, `category:`)
- The `checkShare()` composition logic
- The error message format (wrapped by the abstraction layer)
- Any existing policy tuples in the OpenFGA store

---

## 1. Summary

The project currently ships a hand-rolled `OpenFGAClient` that wraps raw `fetch` calls to the OpenFGA REST API. It handles auth, request construction, error mapping, and privacy-preserving PII hashing internally. A custom test mock (`fetch-mock.ts`) intercepts `globalThis.fetch` to verify request shapes during tests.

The upstream [JS SDK](https://github.com/openfga/js-sdk) (`@openfga/sdk`) provides a fully-featured, maintained client that covers the same API surface and more. This proposal evaluates the tradeoffs of replacing the custom client with the upstream SDK.

---

## 2. What We Would Lose

### 2.1 Privacy-Preserving PII Hashing

This is the most significant loss.

The current client's core value proposition is that **raw PII literals are never sent to OpenFGA**:

```typescript
// Current behavior — literal "user@company.com" never touches the wire
await client.check({ subject: "model", relation: "can_view", literal: "user@company.com" });
// → sends: { tuple_key: { user: "model_instance:model", object: "pii_instance:sha256-<40-hex-hash>" } }
```

The upstream SDK has **no concept of this**. It accepts raw `user`, `relation`, `object` strings and sends them as-is. If we simply substituted the SDK, we would leak PII to OpenFGA.

**Mitigation:** We would need to retain an **abstraction layer** that wraps the SDK and applies `hashLiteral()` before forwarding requests. This is extra code we must maintain, and it partially negates the "use upstream" benefit.

### 2.2 Custom ID Builder Functions

The current client has a suite of private helpers:

| Function | Role |
|---|---|
| `buildModelInstanceId()` | Prefixes `model_instance:` |
| `buildPIIInstanceId()` | Handles `pii_instance:`, `sha256-`, bare hashes, categories |
| `buildRecipientId()` | Prefixes `recipient:` |
| `buildSubjectId()` | Routes by `subjectType` |
| `buildObjectId()` | Core privacy mapping (literal → hash, object → category, etc.) |

These implement the project's **object-model conventions** (the `model_instance:X`, `pii_instance:sha256-Y`, `recipient:Z`, `category:C` taxonomy). The SDK is agnostic to these conventions — it takes any `type:id` string.

**Result:** The ID builders must be kept as part of the wrapping layer. They are not replaced by the SDK; they simply move outside.

### 2.3 The `checkShare()` Multi-Check Composition

The current client exposes a `checkShare(request: ShareCheckRequest)` method that performs a **4-step authorization check**:

1. `model --can_share--> pii_instance`
2. `pii_instance --lineage--> model` (who created the PII)
3. `pii_instance --can_view--> recipient`
4. `recipient --can_receive_from--> model` (optional trust check)

The result is a structured `ShareCheckResult` with per-check booleans, not just a flat `allowed: boolean`.

The upstream SDK has **no equivalent**. `check()` returns `{ allowed: boolean }` for a single tuple. `batchCheck()` checks multiple tuples in parallel but returns flat `allowed` booleans per tuple with no composition logic.

**Result:** `checkShare()` must be kept as a custom method, likely calling the SDK's `check()` or `batchCheck()` multiple times and composing results.

### 2.4 The `batchCheckShare()` Using `/batch-check` Endpoint

The current `batchCheckShare()` sends requests to a non-standard `/stores/{id}/batch-check` endpoint. This is **not** the same as the upstream SDK's `batchCheck()` which uses the official OpenFGA v1.8+ `/batch-check` API.

If we adopt the SDK's `batchCheck()`, the behavior changes:
- SDK's `batchCheck()` returns results **without guaranteed ordering** (uses `correlationId` to match)
- SDK's `batchCheck()` requires OpenFGA v1.8.0+
- The current `/batch-check` usage appears to be a custom/non-standard endpoint

If the current `/batch-check` usage is non-standard, migration to the SDK's official batch check is an improvement. If it is the correct endpoint, we need to verify the SDK's semantics match.

### 2.5 Custom `fetch-mock.ts` and Request Inspection in Tests

The current test suite uses a custom `createFetchMock()` that intercepts `globalThis.fetch` and exposes `getLastRequest()` to let tests assert on exact HTTP request shapes (URL, headers, body).

**What is lost:** The ability to inspect request bodies in tests. This is **not a bug** — it is the correct behavior for integration tests. We test answers, not wire format. See §7.2 for how **nock** replaces `fetch-mock.ts` for response mocking, and why request inspection is the right thing to give up.

### 2.6 Error Message Format

Current client:
```typescript
throw new Error(`OpenFGA check failed (${response.status}): ${body}`);
```

SDK wraps errors in its own `FgaError` type. The error messages would change format, which could affect any error-handling code that parses error messages.

### 2.7 Custom `healthCheck()` Implementation

The current `healthCheck()` hits `/healthz` with a plain `GET` and returns a boolean.

The SDK does not appear to have a dedicated `healthCheck()` method. One could be approximated with `client.getStore()` (which calls `GET /stores/{store_id}`), but this is not the same as a liveness probe.

---

## 3. What We Would Gain

### 3.1 Built-In Retries

The SDK retries on `429` and `5xx` responses automatically (up to 3 times by default, configurable via `retryParams`).

The current client has **no retry logic** — a transient server error propagates directly to the caller.

> **Note for tests:** Automatic retries mean a mocked 429 or 5xx response will be hit multiple times by the SDK. Use `.times(N)` or `.persist()` on the nock interceptor so it doesn't run out after the first attempt. Alternatively, disable retries in the SDK config during tests via `retryParams: { maxRetry: 0 }`.

### 3.2 Full API Surface Coverage

The SDK provides methods the current client does not have:

| Feature | Current | SDK |
|---|---|---|
| `listObjects()` | ✗ | ✓ |
| `streamedListObjects()` | ✗ | ✓ |
| `expand()` | ✗ | ✓ |
| `listUsers()` | ✗ | ✓ |
| `listRelations()` | ✗ | ✓ |
| `readChanges()` | ✗ | ✓ |
| `readAssertions()` / `writeAssertions()` | ✗ | ✓ |
| `createStore()` / `listStores()` / `deleteStore()` | ✗ | ✓ |
| `readAuthorizationModels()` / `writeAuthorizationModel()` | ✗ | ✓ |
| `executeApiRequest()` for custom endpoints | ✗ | ✓ |
| `executeStreamedApiRequest()` + `parseNDJSONStream()` | ✗ | ✓ |

### 3.3 Client Credentials OAuth

The SDK supports **OAuth 2.0 Client Credentials** flow in addition to static API tokens:

```typescript
credentials: {
  method: CredentialsMethod.ClientCredentials,
  config: {
    apiTokenIssuer: process.env.FGA_API_TOKEN_ISSUER,
    apiAudience: process.env.FGA_API_AUDIENCE,
    clientId: process.env.FGA_CLIENT_ID,
    clientSecret: process.env.FGA_CLIENT_SECRET,
  }
}
```

The current client only supports static bearer tokens via `OPENFGA_API_TOKEN`.

### 3.4 OpenTelemetry Support

The SDK has [documented OpenTelemetry integration](https://github.com/openfga/js-sdk/blob/main/docs/opentelemetry.md). The current client has no telemetry.

### 3.5 Auto-Generated TypeScript Types

The SDK's types are generated from the OpenAPI spec and maintained upstream. The current client's types (`CheckRequest`, `ShareCheckRequest`, `WriteTuple`, etc.) are hand-written and could drift from the actual API.

### 3.6 Reduced Maintenance Burden

- No need to track OpenFGA API changes and update request/response shapes manually
- No need to maintain `fetch-mock.ts`
- Upstream handles bug fixes, security patches, and spec changes

### 3.7 Better Batch Check

The SDK's `clientBatchCheck()` performs parallel `check()` calls as a fallback for OpenFGA versions < 1.8.0, while the official `batchCheck()` uses the server-side batch API for v1.8.0+.

The current `batchCheckShare()` uses a non-standard `/batch-check` endpoint with uncertain semantics. Migration to the SDK would bring correct behavior.

---

## 4. Scope Changes

### 4.1 New Dependency

Add `@openfga/sdk` to `package.json`. This introduces:
- A new third-party dependency requiring security review
- A version to track and update
- Potential compatibility constraints with Node.js version (SDK has [supported runtimes](https://github.com/openfga/js-sdk/blob/main/SUPPORTED_RUNTIMES.md))

### 4.2 Two-Layer Architecture

Instead of a **single** custom client, the project would have a **two-layer architecture**:

```
┌─────────────────────────────────────────┐
│  Application code                        │
│  (checkShare, check, writeTuples, etc.)  │
└──────────────┬──────────────────────────┘
               │
┌──────────────▼──────────────────────────┐
│  Privacy Abstraction Layer (NEW)         │
│  - hashLiteral()                         │
│  - ID builders (model_instance:, etc.)   │
│  - checkShare() composition              │
│  - batchCheckShare()                     │
│  - healthCheck()                         │
└──────────────┬──────────────────────────┘
               │ calls SDK methods
┌──────────────▼──────────────────────────┐
│  @openfga/sdk OpenFgaClient (UPSTREAM)   │
│  - check(), write(), read(), etc.        │
│  - Auth, retries, OpenTelemetry          │
└─────────────────────────────────────────┘
```

The **upstream SDK is a lower-level transport**; the **current client moves to an abstraction layer** above it.

### 4.3 Request Format Differences

The SDK uses the standard OpenFGA `type:id` format throughout:

```typescript
// SDK format
{ user: "user:81684243", relation: "viewer", object: "document:roadmap" }
```

The current client uses project-specific conventions:
```typescript
// Current project format
{ user: "model_instance:mlx-community/MiniMax-M2.7-8bit", object: "pii_instance:sha256-abc123" }
{ user: "pii_instance:sha256-abc123", object: "recipient:user:alice" }
{ user: "category:private_email", object: "model_instance:mlx-community/MiniMax-M2.7-8bit" }
```

The ID builders must translate between these formats when wrapping SDK calls.

### 4.4 Response Format Differences

| Aspect | Current | SDK |
|---|---|---|
| `check()` return | `boolean` (true if `allowed === true`) | `{ allowed: boolean }` |
| `batchCheck()` return | `Map<piiInstanceId, ShareCheckResult>` | `{ result: Array<{ allowed, request, correlationId }> }` |
| Error type | `Error` with custom message | `FgaError` with `code`, `status`, `message` |
| `writeTuples()` return | `void` | `{ writes: [...], deletes: [...] }` with status per tuple |

### 4.5 Test Rewrite

All existing tests in `test/openfga-client-check.test.ts` and any other test file that uses `fetchMock` would need to be rewritten.

**Old style** (fetch-mock.ts — request inspection):
```typescript
await client.check({ subject: 'test-model', relation: 'can_view', literal: 'user@company.com' });
const request = fetchMock.getLastRequest();
const body = JSON.parse(request.options.body as string);
assert.ok(body.tuple_key.object.startsWith('pii_instance:sha256-'));
assert.ok(!JSON.stringify(request.options.body).includes('user@company.com'));
```

**New style with nock** (response-only mocking — no request inspection):
```typescript
// Integration test: mock the response, verify the answer. Request body is never inspected.
const scope = nock('http://localhost:28080')
  .post('/stores/test-store/check')
  .reply(200, { allowed: true });

const result = await client.check({ subject: 'test-model', relation: 'can_view', literal: 'user@company.com' });

assert.strictEqual(result, true);  // Only verify the answer
scope.done();                      // Asserts the request was made
nock.cleanAll();
```

**Alternative: sinon** (mock SDK methods directly — no HTTP involved at all):
```typescript
// Stub SDK method directly — tests verify behavior, no HTTP
sinon.stub(sdk, 'check').resolves({ allowed: true });
const result = await privacyClient.check({ subject: 'test-model', relation: 'can_view', literal: 'user@company.com' });
assert.strictEqual(result, true);
```

For integration tests, the nock style is preferred over sinon: it tests the full HTTP contract (URL path, serialization, headers) without ever inspecting request bodies. The SDK handles request construction correctly — that is not the integration test's concern.

### 4.6 Breaking API Changes for Callers

If the application code calls `getOpenFGAClient()` and uses `client.check()` directly (returning `boolean`), the behavior stays the same. However:

- Error types change (`Error` → `FgaError`)
- `ShareCheckResult` shape may need to be re-defined to match what the new composition produces
- Any code parsing error messages (e.g., extracting status codes) would break
- The `batchCheckShare()` API may need to change if the SDK's batch semantics differ

---

## 5. Migration Path

### Phase 1: Add SDK as Dependency
```bash
npm install @openfga/sdk
```

Create `src/openfga-sdk-wrapper.ts` that instantiates the SDK client.

### Phase 2: Build Abstraction Layer
- Port `hashLiteral()` from `openfga.ts`
- Port `buildPIIInstanceId()`, `buildRecipientId()`, `buildModelInstanceId()` from `openfga.ts`
- Re-implement `checkShare()` using SDK `check()` calls
- Re-implement `healthCheck()` using a simple API call
- Re-implement `writeTuples()`, `deleteTuples()`, `readTuples()` delegating to SDK

### Phase 3: Test Rewrite
- Replace `fetch-mock.ts` with **nock** for HTTP response mocking only — no request inspection
- Set `NODE_OPTIONS=--import=nock` in the test runner configuration
- Tests only assert on return values (`true`/`false`, `ShareCheckResult` fields, thrown error messages) — never on request bodies, headers, or URL paths
- Remove all `getLastRequest()`, `JSON.parse(request.options.body)`, `getRequestCount()` calls
- Privacy invariants (hashing) are **enforced by code, not verified by integration tests** — they are an implementation concern
- `nock.cleanAll()` in teardown (replaces `fetchMock.reset()`)
- Use `.persist()` or `.times(N)` on nock interceptors when the SDK's retry logic might hit the same endpoint multiple times

### Phase 4: Migrate Application Code
- Update imports from `openfga.ts` to the new wrapper
- Update error handling for `FgaError` type
- Validate end-to-end with a real OpenFGA instance

### Phase 5: Remove Legacy Code
- Delete `openfga.ts` (old custom client)
- Delete `fetch-mock.ts`
- Delete test files that are no longer applicable

---

## 6. Open Questions

1. **Is the current `/batch-check` endpoint usage correct?** The current `batchCheckShare()` uses `/stores/{id}/batch-check` which may be non-standard. If it is incorrect, migration to the SDK fixes a bug. If it is correct, we need to verify SDK `batchCheck()` semantics are equivalent.

2. **What is the minimum OpenFGA server version we must support?** The SDK's official `batchCheck()` requires v1.8.0+. The current client's batch approach may have different requirements.

3. **Do we need Client Credentials OAuth?** If not now, should the wrapper support it for future use?

4. **How should `healthCheck()` work in the new architecture?** The SDK has no liveness probe. Should we keep hitting `/healthz` directly or use a lightweight API call?

5. **Should we keep the `OpenFGAClient` class name to minimize diff surface?** The SDK also has `OpenFgaClient` (case difference). A renamed export could minimize code changes.

---

## 7. Q&A: What Can Stay in the Abstraction Layer?

### 7.1 Everything from the "Lose" List Is Actually Preservable

Critically, **none of the listed "losses" are truly lost** — they all live in the privacy abstraction layer that sits above the SDK. The SDK becomes a lower-level transport; it doesn't replace the project's domain logic. The abstraction layer is where the project's added value lives.

| "Loss" from §3 | Lives in abstraction layer? | How |
|---|---|---|
| Privacy PII hashing (`hashLiteral()`) | **Yes — fully preserved** | `buildObjectId()` in the wrapper calls `hashLiteral()` before forwarding to SDK. Raw literal never reaches SDK |
| ID builders (`model_instance:`, `pii_instance:`, `recipient:`, `category:`) | **Yes — fully preserved** | These ARE the abstraction layer's public helpers; SDK never sees raw project IDs |
| `checkShare()` 4-step composition | **Yes — fully preserved** | Wrapper calls SDK's `check()` four times with correct IDs, composes `ShareCheckResult` |
| `batchCheckShare()` | **Yes — fully preserved** | Wrapper calls SDK's `batchCheck()` or multiple `check()` calls, maps results back |
| Custom error message format | **Yes — fully preserved** | Wrapper catches `FgaError`, unwraps it, re-throws as `Error` with project's own message format |
| Custom `healthCheck()` | **Yes — fully preserved** | Wrapper implements directly against SDK or the raw HTTP layer |

The two things that are **actually lost** (not just moved) are:

- **`fetch-mock.ts` request inspection in tests** — this is a testing concern, not application logic. See §7.2.
- **The exact current request-inspection test style** — tests would need to be rewritten, not just the client. See §7.2.

### 7.2 Can We Replace `fetch-mock.ts` with Nock?

**Short answer: Yes, but with important caveats.**

**What nock does differently from `fetch-mock.ts`:**

- `fetch-mock.ts` intercepts `globalThis.fetch` — the WHATWG Fetch API — by replacing the global. Tests call `getLastRequest()` to inspect exact URL, headers, and serialized body.
- Nock intercepts **Node's `http.request` / `http.ClientRequest`** — the lower-level HTTP layer — by monkey-patching the Node.js core modules.

**The SDK uses `fetch` (WHATWG), not `http.request`.** In Node.js 18+, the standard `globalThis.fetch` is implemented on top of `node:http`/`node:https`. Nock overrides `http.ClientRequest`, which is the underlying mechanism that the fetch implementation calls internally. So **nock should intercept SDK HTTP calls** — but only if the SDK uses Node's built-in fetch. If the SDK uses a custom HTTP client (e.g., `axios`, `undici` directly, or its own HTTP abstraction), nock will not catch it.

**Known nock limitation with ES modules** (from nock docs):
> "When an ES module imports `request` with a namespaced import like `import * as http from 'node:http'`, requests made by this module are not intercepted. You can fix this by telling Node to preload nock using `--import=nock`."

Since the project appears to use ES modules (`import` syntax in test files), nock's HTTP interception may require `NODE_OPTIONS=--import=nock` or the `--import=nock` CLI flag to be set globally. This is a **test runner configuration concern**, not a code change.

**Test style for integration tests:** Since these are integration tests — not unit tests — the goal is to verify **answers are correct**, not to verify HTTP request shapes. Nock is used only to mock **responses**, never to inspect requests. The test logic barely changes.

```typescript
// Old fetch-mock style — inspects request body after the call (not appropriate for integration tests)
await client.check({ subject: 'test-model', relation: 'can_view', literal: 'user@co.com' });
const request = fetchMock.getLastRequest();
const body = JSON.parse(request.options.body as string);
assert.ok(body.tuple_key.object.startsWith('pii_instance:sha256-'));
assert.ok(!JSON.stringify(request.options.body).includes('user@co.com'));

// New nock style — mocks the response, verifies the answer (integration test appropriate)
const scope = nock('http://localhost:28080')
  .post('/stores/test-store/check')
  .reply(200, { allowed: true });

const result = await client.check({ subject: 'test-model', relation: 'can_view', literal: 'user@co.com' });
assert.strictEqual(result, true);  // Only verify the answer
scope.done();                      // Asserts the request was made
nock.cleanAll();
```

**The big shift:** No request body is ever inspected. We trust the SDK (and our privacy wrapper) to serialize requests correctly. Tests only verify: did we get the right `true`/`false` answer? Did an error with the right message get thrown? Does `ShareCheckResult` have the right fields? The nock interceptor matching is purely to ensure the HTTP call succeeds — not to verify wire format.

Privacy invariants (hashing raw literals before they reach the network) are **enforced by the code**, not verified by integration tests. Unit tests or code review cover that concern.

**Recommendation:** Replace `fetch-mock.ts` with nock, under these conditions:

1. Set `NODE_OPTIONS=--import=nock` in the test runner environment to handle ESM interception
2. Add `nock.disableNetConnect()` in test setup to catch any unmocked HTTP calls
3. Use `nock.cleanAll()` in test teardown (equivalent to current `fetchMock.reset()`)
4. Tests mock responses only — never use `filteringRequestBody`, body RegExp matching, or any other request inspection
5. Use `.persist()` or `.times(N)` on nock interceptors when the SDK's retry logic may hit the same endpoint multiple times
6. Rewrite tests: remove all `getLastRequest()`, `JSON.parse`, body assertions; keep only answer assertions

**What we gain by switching to nock:**
- No custom mock to maintain (~90 LOC of `fetch-mock.ts` removed)
- Dead simple integration test setup: mock the URL/verb, return the response, verify the answer
- Built-in `replyWithError()` for network error simulation
- `scope.done()` / `nock.isDone()` for asserting expected calls were made
- `nock.disableNetConnect()` catches any unmocked HTTP calls — great safety net
- Well-maintained, widely-used library with strong community
- `nockBack` fixture recording for integration-level tests against live servers

**What changes:**
- Tests only mock **responses**, never inspect requests — test logic barely changes beyond removing `getLastRequest()` calls
- ESM loading concern requires `NODE_OPTIONS=--import=nock` setup
- Interceptors are consumed on first use — use `.persist()` or `.times(N)` for repeated calls in the same test (especially relevant since the SDK retries on 429/5xx)
- `nock.cleanAll()` replaces `fetchMock.reset()`; no direct equivalent for `getRequestCount()` (use `nock.pendingMocks()` or `nock.isDone()` instead)

---

## 8. Recommendation

**Adopt the upstream SDK** with a privacy-preserving wrapper layer, under the following conditions:

- The privacy abstraction layer is explicitly scoped and tested (especially the `hashLiteral()` and ID builder logic)
- Tests are rewritten: nock mocks HTTP **responses only** (never request bodies), tests assert only on return values — the integration test philosophy is "verify answers, not wire format"
- The team accepts the error type migration (`Error` → `FgaError`)
- The project validates that the SDK's `batchCheck()` semantics match the current `/batch-check` usage
- `NODE_OPTIONS=--import=nock` is configured in the test environment if nock is adopted

This proposal **complements, not supersedes**, the existing authorization model described in `openfga-integration-proposal.md`, `proposal-reverse-pii-sharing-authorization.md`, and `openfga-model-tutorial.md`. None of those documents need to change. Only `openfga.ts`, `fetch-mock.ts`, and the test files that exercise them are in scope.

---

## 9. Implementation Checklist

The following checklist provides a sequential task list for implementing this proposal. Tasks are grouped into phases.

### Phase 1 — SDK Onboarding

- [ ] 1.1. Review `@openfga/sdk` npm package page: https://www.npmjs.com/package/@openfga/sdk
- [ ] 1.2. Review the upstream JS SDK README and supported runtimes: https://github.com/openfga/js-sdk/blob/main/SUPPORTED_RUNTIMES.md
- [ ] 1.3. Review the OpenTelemetry integration docs: https://github.com/openfga/js-sdk/blob/main/docs/opentelemetry.md
- [ ] 1.4. Run `npm install @openfga/sdk` and verify installation succeeds
- [ ] 1.5. Add `nock` as a dev dependency (`npm install --save-dev nock`)
- [ ] 1.6. Verify the SDK compiles correctly in the project (no ESM/CommonJS conflicts, correct Node.js version)

### Phase 2 — SDK Client Instantiation

- [ ] 2.1. Create `src/openfga-sdk-wrapper.ts` (new file)
- [ ] 2.2. Import `OpenFgaClient` and `CredentialsMethod` from `@openfga/sdk`
- [ ] 2.3. Instantiate the SDK client with config from env vars (`OPENFGA_API_URL`, `OPENFGA_STORE_ID`, `OPENFGA_MODEL_ID`, `OPENFGA_API_TOKEN`)
- [ ] 2.4. Configure Client Credentials OAuth if `FGA_CLIENT_ID`/`FGA_CLIENT_SECRET` env vars are present (optional future use)
- [ ] 2.5. Configure retry params via `retryParams` (max 3 retries by default)
- [ ] 2.6. Export the SDK client instance from `src/openfga-sdk-wrapper.ts`
- [ ] 2.7. Verify the SDK client initializes without making network calls

### Phase 3 — Build Privacy Abstraction Layer

- [ ] 3.1. Port `hashLiteral()` from `openfga.ts` — keep identical behavior (SHA256, 40 hex chars)
- [ ] 3.2. Port `buildModelInstanceId(subject: string)` — prepends `model_instance:`
- [ ] 3.3. Port `buildPIIInstanceId(literal?: string, hash?: string, category?: string)` — handles `pii_instance:sha256-`, bare hashes, categories
- [ ] 3.4. Port `buildRecipientId(recipient: string)` — prepends `recipient:`
- [ ] 3.5. Port `buildSubjectId(subject: string, subjectType: string)` — routes by subjectType
- [ ] 3.6. Port `buildObjectId()` — core privacy mapping (literal → hash, object → category)
- [ ] 3.7. Implement `check(request: CheckRequest): Promise<boolean>` — calls SDK `check()`, applies hashing, returns `boolean`
- [ ] 3.8. Implement `checkShare(request: ShareCheckRequest): Promise<ShareCheckResult>` — 4-step composition: `model --can_share--> pii`, `pii --lineage--> model`, `pii --can_view--> recipient`, `recipient --can_receive_from--> model`
- [ ] 3.9. Implement `batchCheckShare(requests: ShareCheckRequest[]): Promise<Map<string, ShareCheckResult>>` — parallel checkShare calls
- [ ] 3.10. Implement `writeTuples(tuples: WriteTuple[]): Promise<void>` — hashes literals, delegates to SDK `write()`
- [ ] 3.11. Implement `deleteTuples(tuples: WriteTuple[]): Promise<void>` — hashes literals, delegates to SDK `write()` (deletes key)
- [ ] 3.12. Implement `readTuples(filter?: TupleFilter): Promise<ReadResponse>>` — delegates to SDK `read()`
- [ ] 3.13. Implement `healthCheck(): Promise<boolean>` — hits `/healthz` or lightweight API call
- [ ] 3.14. Wrap SDK `FgaError` exceptions — re-throw as `Error` with project's custom message format
- [ ] 3.15. Export the abstraction layer class and all public types from `src/openfga-sdk-wrapper.ts`

### Phase 4 — Validate Batch-Check Semantics

- [ ] 4.1. Audit current `batchCheckShare()` usage in `openfga.ts` — identify all call sites
- [ ] 4.2. Verify whether current `/batch-check` endpoint usage is standard or non-standard
- [ ] 4.3. If standard: validate SDK's `batchCheck()` semantics match (ordering, correlationId)
- [ ] 4.4. If non-standard: document the behavioral change when migrating to SDK's `batchCheck()`
- [ ] 4.5. Update `batchCheckShare()` in abstraction layer to use SDK's `batchCheck()` or parallel `check()` fallback
- [ ] 4.6. Write a test that exercises `batchCheckShare()` with mixed success/failure results

### Phase 5 — Test Rewrite (Replace fetch-mock with nock)

- [ ] 5.1. Review all existing test files that use `fetch-mock.ts` or `getLastRequest()`
  - [ ] `test/openfga-client-check.test.ts`
  - [ ] Any other test files referencing `fetchMock`
- [ ] 5.2. Add `NODE_OPTIONS=--import=nock` to test runner configuration (vitest.config.ts or package.json test script)
- [ ] 5.3. In test setup: call `nock.disableNetConnect()` to catch unmocked HTTP calls
- [ ] 5.4. In test teardown: call `nock.cleanAll()` (replace `fetchMock.reset()`)
- [ ] 5.5. For each test file:
  - [ ] Remove all `fetchMock.getLastRequest()` calls
  - [ ] Remove all `JSON.parse(request.options.body)` inspections
  - [ ] Remove all `getRequestCount()` assertions
  - [ ] Remove all RegExp or body-assertion patterns (`filteringRequestBody`, body matching)
- [ ] 5.6. For each test, replace fetch-mock with nock interceptor:
  ```typescript
  const scope = nock('http://localhost:28080')
    .post('/stores/test-store/check')
    .reply(200, { allowed: true });
  ```
- [ ] 5.7. Assert only on return values (`true`/`false`, `ShareCheckResult` fields) — never on request body/headers/URL
- [ ] 5.8. Use `.persist()` or `.times(N)` on interceptors for SDK retry scenarios (429/5xx)
- [ ] 5.9. Use `scope.done()` to assert the HTTP call was made
- [ ] 5.10. For unit tests that don't need HTTP at all: use `sinon.stub(sdk, 'check')` instead of nock
- [ ] 5.11. Verify all rewritten tests pass (`npm test`)

### Phase 6 — Migrate Application Code

- [ ] 6.1. Find all imports of `openfga.ts` / `getOpenFGAClient()` in `src/index.ts`
- [ ] 6.2. Update imports to use the new `src/openfga-sdk-wrapper.ts`
- [ ] 6.3. Update error handling where `Error` → `FgaError` migration matters
- [ ] 6.4. Verify `checkShare()` calls still return correct `ShareCheckResult` shape
- [ ] 6.5. Verify `batchCheckShare()` calls still return correct `Map<string, ShareCheckResult>` shape
- [ ] 6.6. Run full test suite end-to-end — all tests pass with real SDK client

### Phase 7 — End-to-End Validation

- [ ] 7.1. Spin up a local OpenFGA instance (docker or `scripts/openfga-init.sh`)
- [ ] 7.2. Run the authorization model initialization script
- [ ] 7.3. Write a tuple or two using the new `writeTuples()` wrapper
- [ ] 7.4. Run `check()` with a known literal and verify correct `true`/`false` response
- [ ] 7.5. Run `checkShare()` with the 4-step sequence and verify `ShareCheckResult`
- [ ] 7.6. Verify OpenTelemetry spans are emitted if OTEL env vars are set
- [ ] 7.7. Verify retries work: mock a 429 response and confirm SDK retries up to 3 times
- [ ] 7.8. Verify health check returns `true` when OpenFGA is reachable, `false` when not

### Phase 8 — Remove Legacy Code

- [ ] 8.1. Delete `openfga.ts` (old custom client)
- [ ] 8.2. Delete `test/support/fetch-mock.ts`
- [ ] 8.3. Delete any test files that were exclusively for the old request-inspection style
- [ ] 8.4. Update `package.json` — remove any fetch-mock references
- [ ] 8.5. Update `tsconfig.json` or `vitest.config.ts` if any legacy paths need cleanup
- [ ] 8.6. Run `npm test` one final time — all tests pass without legacy files

### Phase 9 — Documentation Updates

- [ ] 9.1. Update `README.md` if it references `openfga.ts` or `fetch-mock.ts`
- [ ] 9.2. Update `docs/openfga-integration-proposal.md` — no changes needed (confirm)
- [ ] 9.3. Update `docs/openfga-model-tutorial.md` — no changes needed (confirm)
- [ ] 9.4. Update any inline JSDoc comments in the new wrapper
- [ ] 9.5. Mark this proposal status as **Accepted** (instead of Draft) once all tasks are complete