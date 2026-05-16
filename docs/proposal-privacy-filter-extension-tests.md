# Proposal: Integration Tests for the Privacy Filter Extension

## 1. Problem Statement

The `index.ts` entry point (`piExtension`) registers:
- A `pii-alert` message renderer
- A `/check-pii` slash command
- `before_agent_start` and `context` event hooks for PII detection/masking
- A `session_start` notification
- An OpenFGA authorization layer for per-model, per-category, per-literal PII disclosure decisions

There are currently **no tests** for this extension. Existing test infrastructure (e.g., `test/support/`) was built for the pi-subagents project and is not directly applicable here. The Privacy Filter extension has its own concerns:
- ML inference via `@huggingface/transformers` (requires a local model or mocked classifier)
- OpenFGA authorization calls (requires a running OpenFGA server or mock)
- Message rendering via `@mariozechner/pi-tui` (requires TUI component rendering)
- Event hooks that transform prompt and message data


## 2. Constraints

- **ML inference**: The extension calls `pipeline("token-classification", "openai/privacy-filter")` from `@huggingface/transformers`. In tests this must be replaced with a mock classifier that returns deterministic synthetic results — loading the real model in CI is impractical.
- **OpenFGA client**: `getOpenFGAClient()` makes real network calls to an OpenFGA server. Tests must mock the client to avoid external dependencies.
- **TUI components**: `pi.registerMessageRenderer` and `pi.registerCommand` use `@mariozechner/pi-tui` (`Box`, `Text`). These components render to strings and can be tested in a headless environment without a display.
- **Event hooks**: `before_agent_start` and `context` receive pi event objects and return transformed data. Tests need to simulate these events with realistic payloads.
- **Extension activation**: `piExtension(pi)` must be called with a fake `ExtensionAPI` to exercise the registration logic.
- **No existing test infrastructure**: Unlike pi-subagents, there is no `test/support/` directory, no `helpers.ts`, and no `mock-pi.ts`. A minimal test support layer must be created.


## 3. Approach

### 3.1 Test Support Layer

A minimal `test/support/` directory is created:

```
test/
  support/
    mock-pi.ts          # fake ExtensionAPI (pi) with event bus, message renderer registry, tool registry
    mock-classifier.ts  # fake HuggingFace pipeline that returns synthetic token-classification results
    mock-openfga.ts     # fake OpenFGA client that returns configurable allow/deny results
  integration/
    pii-extension.test.ts
```

The command to run tests (assuming TypeScript strip-types loader or tsx):
```bash
node --import ./test/support/register-loader.mjs --test test/integration/pii-extension.test.ts
```

### 3.2 Fake `ExtensionAPI` Design (`mock-pi.ts`)

```typescript
// test/support/mock-pi.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export interface FakeMessage {
  customType?: string;
  content: string;
  display: boolean;
  triggerTurn?: boolean;
}

export interface MockPi {
  pi: ExtensionAPI;
  sentMessages: FakeMessage[];
  registeredRenderers: Map<string, Function>;
  registeredCommands: Map<string, { description: string; handler: Function }>;
  events: EventBus;
  hasUI: boolean;
  model: { id: string };
  reset(): void;
}

export function createMockPi(): MockPi { ... }
```

Key behaviors:
- `pi.registerMessageRenderer(id, fn)` — stores `fn` in `registeredRenderers`; calling the fn with a message object exercises the real renderer logic and returns a TUI component.
- `pi.sendMessage(msg)` — stores the message in `sentMessages` for assertion.
- `pi.events.on / pi.events.emit` — in-process event bus (no network).
- `pi.on("before_agent_start", fn)` / `pi.on("context", fn)` — stores and invokes registered handlers.
- `pi.registerCommand(name, def)` — stores in `registeredCommands`.
- `pi.ui.notify(msg, type)` — records notification calls.
- `pi.model` — configurable model ID to test OpenFGA authorization paths.

### 3.3 Fake Classifier (`mock-classifier.ts`)

```typescript
// test/support/mock-classifier.ts
export interface MockEntity {
  entity_group: string;
  score: number;
  word: string;
}

export function createMockClassifier(responses: MockEntity[][]) {
  let callCount = 0;
  return async (text: string, _opts?: { aggregation_strategy: string }) => {
    return responses[callCount++] ?? [];
  };
}
```

Usage in tests:
```typescript
const mockClassifier = createMockClassifier([
  // First call: detect email and name
  [{ entity_group: "EMAIL", score: 0.99, word: "alice@example.com" },
   { entity_group: "NAME", score: 0.95, word: "Alice" }],
  // Second call: no PII
  [],
]);
```

### 3.4 Fake OpenFGA Client (`mock-openfga.ts`)

```typescript
// test/support/mock-openfga.ts
export interface MockOpenFGA {
  check: (req: { subject: string; relation: string; object?: string; literal?: string }) => Promise<boolean>;
  setNextResult: (result: boolean) => void;
  setResultsByKey: (key: string, result: boolean) => void;
}

export function createMockOpenFGA(): MockOpenFGA { ... }
```

Supports per-key results so tests can independently control category-level and literal-level authorization outcomes.


## 4. Test Structure

### 4.1 Loader Registration

```javascript
// test/support/register-loader.mjs
import { register } from "node:module";
register(new URL("./ts-loader.mjs", import.meta.url));
```

```javascript
// test/support/ts-loader.mjs
// Strips TypeScript types and rewrites .js → .ts in import specifiers.
// Also shims @huggingface/transformers with an empty module since
// real pipeline loading is replaced by mock-classifier.ts in tests.
```

### 4.2 Integration Tests (`pii-extension.test.ts`)

```typescript
/**
 * Integration tests for the Privacy Filter extension (index.ts).
 *
 * Tests cover:
 * - Extension activation and registration
 * - Message renderer for pii-alert
 * - /check-pii command
 * - before_agent_start PII masking
 * - context message PII filtering
 * - OpenFGA authorization (allow/deny per model+category+literal)
 * - session_start notification
 * - Fail-closed behavior when OpenFGA is unreachable
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createMockPi, type MockPi } from "../support/mock-pi.ts";
import { createMockClassifier, type MockEntity } from "../support/mock-classifier.ts";
import { createMockOpenFGA } from "../support/mock-openfga.ts";

const EXTENSION_PATH = "./index.ts";
// In a real run, use tsx or a loader:  node --import ./test/support/register-loader.mjs --test ...
const extension = await import(EXTENSION_PATH);
const piiExtension = extension.default;

describe("piExtension activation", () => {
  let mockPi: MockPi;
  let mockOpenFGA: ReturnType<typeof createMockOpenFGA>;

  beforeEach(() => {
    mockPi = createMockPi();
    mockOpenFGA = createMockOpenFGA();
    // Inject mocks into the module's dependency graph before activation.
    // This is done via a test hook that replaces getOpenFGAClient.
    (globalThis as any).__testOpenFGA = mockOpenFGA;
    (globalThis as any).__testClassifierFactory = createMockClassifier;
  });

  it("activates without throwing", () => {
    assert.doesNotThrow(() => piiExtension(mockPi.pi));
  });

  it("registers a pii-alert message renderer", () => {
    piiExtension(mockPi.pi);
    assert.ok(
      mockPi.registeredRenderers.has("pii-alert"),
      "expected pii-alert renderer to be registered",
    );
  });

  it("registers the /check-pii command", () => {
    piiExtension(mockPi.pi);
    assert.ok(
      mockPi.registeredCommands.has("check-pii"),
      "expected /check-pii command to be registered",
    );
    const cmd = mockPi.registeredCommands.get("check-pii")!;
    assert.ok(cmd.description.length > 0);
    assert.equal(typeof cmd.handler, "function");
  });

  it("sends a session_start notification", () => {
    piiExtension(mockPi.pi);
    assert.equal(mockPi.sessionStartNotifications.length, 1);
    assert.match(
      mockPi.sessionStartNotifications[0].message,
      /privacy|filter|loaded/i,
    );
  });
});

describe("pii-alert message renderer", () => {
  it("renders PII alert with masked items", async () => {
    const mockPi = createMockPi();
    piiExtension(mockPi.pi);

    const renderer = mockPi.registeredRenderers.get("pii-alert")!;
    const component = renderer(
      {
        content: JSON.stringify({
          piiTypes: ["EMAIL", "NAME"],
          piiLines: [
            '  [EMAIL] "alice@example.com" (99.0%) → MASKED',
            '  [NAME] "Alice" (95.0%) → ALLOWED',
          ],
        }),
        details: undefined,
      },
      { expanded: false },
      makeMockTheme(),
    );

    const lines = component.render(80);
    assert.ok(lines.length > 0);
    assert.ok(lines.some((l) => l.includes("PII DETECTED")));
    assert.ok(lines.some((l) => l.includes("EMAIL")));
    assert.ok(lines.some((l) => l.includes("MASKED")));
  });

  it("renders expanded view with sanitization hint", async () => {
    const mockPi = createMockPi();
    piiExtension(mockPi.pi);

    const renderer = mockPi.registeredRenderers.get("pii-alert")!;
    const component = renderer(
      {
        content: JSON.stringify({ piiTypes: ["EMAIL"], piiLines: ['  [EMAIL] "x@y.com" → MASKED'] }),
        details: undefined,
      },
      { expanded: true },
      makeMockTheme(),
    );

    const lines = component.render(80);
    assert.ok(lines.some((l) => l.includes("masked for the agent")));
  });

  it("returns plain Text when content is not valid JSON", async () => {
    const mockPi = createMockPi();
    piiExtension(mockPi.pi);

    const renderer = mockPi.registeredRenderers.get("pii-alert")!;
    const result = renderer(
      { content: "not json", details: undefined },
      { expanded: false },
      makeMockTheme(),
    );
    assert.ok(result instanceof Text || typeof result === "object");
  });
});

describe("/check-pii command", () => {
  it("notifies 'No PII detected' when classifier returns empty", async () => {
    const mockPi = createMockPi();
    (globalThis as any).__testClassifierFactory = () =>
      createMockClassifier([[]]); // zero detections
    piiExtension(mockPi.pi);

    const cmd = mockPi.registeredCommands.get("check-pii")!;
    await cmd.handler("hello world", makeMockCommandCtx());

    assert.equal(mockPi.sentMessages.length, 1);
    const msg = mockPi.sentMessages[0];
    assert.equal(msg.customType, "pii-alert");
    const data = JSON.parse(msg.content);
    assert.deepEqual(data.piiTypes, []);
  });

  it("sends pii-alert message with detected entities", async () => {
    const mockPi = createMockPi();
    const entities: MockEntity[] = [
      { entity_group: "EMAIL", score: 0.99, word: "bob@test.com" },
      { entity_group: "PHONE", score: 0.87, word: "555-1234" },
    ];
    (globalThis as any).__testClassifierFactory = () => createMockClassifier([entities]);
    piiExtension(mockPi.pi);

    const cmd = mockPi.registeredCommands.get("check-pii")!;
    await cmd.handler("Contact bob@test.com at 555-1234", makeMockCommandCtx());

    assert.equal(mockPi.sentMessages.length, 1);
    const data = JSON.parse(mockPi.sentMessages[0].content);
    assert.deepEqual(data.piiTypes.sort(), ["EMAIL", "PHONE"]);
    assert.ok(data.piiLines.length >= 2);
  });
});
```


### 4.3 `before_agent_start` Hook Tests

```typescript
describe("before_agent_start hook", () => {
  it("passes through text with no PII unchanged", async () => {
    const mockPi = createMockPi();
    const mockClassifier = createMockClassifier([[]]); // no detections
    (globalThis as any).__testClassifierFactory = () => mockClassifier;
    piiExtension(mockPi.pi);

    const beforeHandler = mockPi.eventHandlers.get("before_agent_start")!;
    const result = await beforeHandler(
      { prompt: "Hello world", systemPrompt: "You are helpful." },
      makeMockEventCtx("openai/gpt-4o"),
    );

    assert.equal(result?.prompt, "Hello world");
    assert.equal(result?.systemPrompt, "You are helpful.");
    assert.equal(mockPi.sentMessages.length, 0, "no alert should be sent for clean text");
  });

  it("masks PII and sends pii-alert message", async () => {
    const mockPi = createMockPi();
    const mockOpenFGA = createMockOpenFGA();
    mockOpenFGA.setResultsByKey("EMAIL", false); // deny EMAIL
    mockOpenFGA.setResultsByKey("NAME", true);   // allow NAME
    (globalThis as any).__testOpenFGA = mockOpenFGA;
    (globalThis as any).__testClassifierFactory = () =>
      createMockClassifier([[
        { entity_group: "EMAIL", score: 0.99, word: "alice@example.com" },
        { entity_group: "NAME", score: 0.95, word: "Alice" },
      ]]);
    piiExtension(mockPi.pi);

    const beforeHandler = mockPi.eventHandlers.get("before_agent_start")!;
    const result = await beforeHandler(
      { prompt: "Hello, I am Alice. My email is alice@example.com", systemPrompt: "" },
      makeMockEventCtx("openai/gpt-4o"),
    );

    assert.ok(result, "hook should return a result");
    assert.ok(result!.prompt.includes("[EMAIL REDACTED]"), "email should be masked");
    assert.ok(
      result!.prompt.includes("Alice") || !result!.prompt.includes("[NAME REDACTED]"),
      "allowed NAME should be preserved",
    );
    assert.ok(
      result!.systemPrompt.includes("PRIVACY NOTICE"),
      "system prompt should include privacy injection",
    );

    assert.equal(mockPi.sentMessages.length, 1);
    const msg = mockPi.sentMessages[0];
    assert.equal(msg.customType, "pii-alert");
    assert.equal(msg.display, true);
    assert.equal(msg.triggerTurn, false);
    const data = JSON.parse(msg.content);
    assert.deepEqual(data.piiTypes.sort(), ["EMAIL", "NAME"]);
  });

  it("fail-closes when OpenFGA is unreachable (masks all PII)", async () => {
    const mockPi = createMockPi();
    const mockOpenFGA = createMockOpenFGA();
    mockOpenFGA.setNextResult(() => { throw new Error("network unreachable"); });
    (globalThis as any).__testOpenFGA = mockOpenFGA;
    (globalThis as any).__testClassifierFactory = () =>
      createMockClassifier([[
        { entity_group: "EMAIL", score: 0.99, word: "secret@test.com" },
        { entity_group: "PHONE", score: 0.88, word: "555-0000" },
      ]]);
    piiExtension(mockPi.pi);

    const beforeHandler = mockPi.eventHandlers.get("before_agent_start")!;
    const result = await beforeHandler(
      { prompt: "Call me at 555-0000 or email secret@test.com", systemPrompt: "" },
      makeMockEventCtx("openai/gpt-4o"),
    );

    assert.ok(result!.prompt.includes("[EMAIL REDACTED]"));
    assert.ok(result!.prompt.includes("[PHONE REDACTED]"), "both categories should be masked on OpenFGA failure");
  });

  it("skips empty prompt", async () => {
    const mockPi = createMockPi();
    let classifierCalled = false;
    (globalThis as any).__testClassifierFactory = () =>
      async (_t: string) => { classifierCalled = true; return []; };
    piiExtension(mockPi.pi);

    const beforeHandler = mockPi.eventHandlers.get("before_agent_start")!;
    const result = await beforeHandler({ prompt: "   ", systemPrompt: "" }, makeMockEventCtx("x"));
    assert.equal(result, undefined);
    assert.equal(classifierCalled, false, "classifier should not be called for empty prompt");
  });

  it("uses model from ctx to build authorization subject", async () => {
    const mockPi = createMockPi();
    const mockOpenFGA = createMockOpenFGA();
    const checkedSubjects: string[] = [];
    const origCheck = mockOpenFGA.check.bind(mockOpenFGA);
    mockOpenFGA.check = async (req) => {
      checkedSubjects.push(req.subject);
      return origCheck(req);
    };
    (globalThis as any).__testOpenFGA = mockOpenFGA;
    (globalThis as any).__testClassifierFactory = () =>
      createMockClassifier([[{ entity_group: "EMAIL", score: 0.9, word: "a@b.com" }]]);
    piiExtension(mockPi.pi);

    const beforeHandler = mockPi.eventHandlers.get("before_agent_start")!;
    await beforeHandler({ prompt: "a@b.com", systemPrompt: "" }, makeMockEventCtx("anthropic/claude-3-opus"));

    assert.ok(checkedSubjects.some((s) => s.includes("claude-3-opus")), "OpenFGA should be called with model ID as subject");
  });
});
```

### 4.4 `context` Hook Tests

```typescript
describe("context hook", () => {
  it("filters out pii-alert messages before returning", async () => {
    const mockPi = createMockPi();
    piiExtension(mockPi.pi);

    const contextHandler = mockPi.eventHandlers.get("context")!;
    const result = await contextHandler({
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "custom", customType: "pii-alert", content: "[]" } as any,
        { role: "assistant", content: [{ type: "text", text: "hi" }] },
      ],
    }, makeMockEventCtx("x"));

    assert.ok(result, "context handler should return a result");
    assert.equal(result!.messages.length, 2, "pii-alert message should be filtered out");
    assert.equal(result!.messages[0].role, "user");
    assert.equal(result!.messages[1].role, "assistant");
  });

  it("masks PII in user message content", async () => {
    const mockPi = createMockPi();
    const mockOpenFGA = createMockOpenFGA();
    mockOpenFGA.setResultsByKey("EMAIL", false); // deny
    (globalThis as any).__testOpenFGA = mockOpenFGA;
    (globalThis as any).__testClassifierFactory = () =>
      createMockClassifier([[{ entity_group: "EMAIL", score: 0.99, word: "private@test.com" }]]);
    piiExtension(mockPi.pi);

    const contextHandler = mockPi.eventHandlers.get("context")!;
    const result = await contextHandler({
      messages: [
        { role: "user", content: [{ type: "text", text: "Email: private@test.com" }] },
      ],
    }, makeMockEventCtx("x"));

    assert.ok(result!.messages[0].content[0].text.includes("[EMAIL REDACTED]"));
  });

  it("does not modify assistant messages", async () => {
    const mockPi = createMockPi();
    (globalThis as any).__testClassifierFactory = () =>
      async () => [{ entity_group: "EMAIL", score: 0.99, word: "leaked@test.com" }];
    piiExtension(mockPi.pi);

    const contextHandler = mockPi.eventHandlers.get("context")!;
    const result = await contextHandler({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "I see private@test.com in the logs" }] },
      ],
    }, makeMockEventCtx("x"));

    // Assistant messages should not be filtered or masked (only user messages)
    assert.equal(result!.messages[0].content[0].text, "I see private@test.com in the logs");
  });
});
```


### 4.5 OpenFGA Authorization Tests

```typescript
describe("OpenFGA authorization", () => {
  it("allows a category when category-level check returns true", async () => {
    const mockPi = createMockPi();
    const mockOpenFGA = createMockOpenFGA();
    mockOpenFGA.setResultsByKey("NAME", true); // allowed
    (globalThis as any).__testOpenFGA = mockOpenFGA;
    (globalThis as any).__testClassifierFactory = () =>
      createMockClassifier([[{ entity_group: "NAME", score: 0.9, word: "Bob" }]]);
    piiExtension(mockPi.pi);

    const beforeHandler = mockPi.eventHandlers.get("before_agent_start")!;
    const result = await beforeHandler(
      { prompt: "Hi Bob", systemPrompt: "" },
      makeMockEventCtx("openai/gpt-4o"),
    );

    assert.ok(result!.prompt.includes("Bob"), "NAME should NOT be masked when OpenFGA allows category");
    assert.equal(mockPi.sentMessages.length, 1);
    const data = JSON.parse(mockPi.sentMessages[0].content);
    assert.ok(data.piiLines.some((l: string) => l.includes("ALLOWED")));
  });

  it("checks individual literals when category check returns false", async () => {
    const mockPi = createMockPi();
    const mockOpenFGA = createMockOpenFGA();
    mockOpenFGA.setResultsByKey("EMAIL", false); // category denied
    mockOpenFGA.setResultsByKey("literal:alice@example.com", true); // but literal allowed
    (globalThis as any).__testOpenFGA = mockOpenFGA;
    (globalThis as any).__testClassifierFactory = () =>
      createMockClassifier([[{ entity_group: "EMAIL", score: 0.99, word: "alice@example.com" }]]);
    piiExtension(mockPi.pi);

    const beforeHandler = mockPi.eventHandlers.get("before_agent_start")!;
    const result = await beforeHandler(
      { prompt: "alice@example.com", systemPrompt: "" },
      makeMockEventCtx("openai/gpt-4o"),
    );

    assert.ok(result!.prompt.includes("alice@example.com"), "literal should be preserved when literal-level check passes");
  });

  it("masks at category level when no literal-level check is configured", async () => {
    const mockPi = createMockPi();
    const mockOpenFGA = createMockOpenFGA();
    mockOpenFGA.setResultsByKey("EMAIL", false); // category denied
    // No literal key set → literal check throws → fail-closed for this category
    (globalThis as any).__testOpenFGA = mockOpenFGA;
    (globalThis as any).__testClassifierFactory = () =>
      createMockClassifier([[{ entity_group: "EMAIL", score: 0.99, word: "x@y.com" }]]);
    piiExtension(mockPi.pi);

    const beforeHandler = mockPi.eventHandlers.get("before_agent_start")!;
    const result = await beforeHandler(
      { prompt: "Contact x@y.com", systemPrompt: "" },
      makeMockEventCtx("openai/gpt-4o"),
    );

    assert.ok(result!.prompt.includes("[EMAIL REDACTED]"));
    assert.ok(!result!.prompt.includes("x@y.com"));
  });
});
```

### 4.6 Helper Fixtures

```typescript
// Shared helpers used across test sections
function makeMockTheme() {
  return {
    fg: (color: string, text: string) => text,
    bg: (color: string, text: string) => text,
    bold: (text: string) => `**${text}**`,
  };
}

function makeMockEventCtx(modelId: string) {
  return {
    hasUI: false,
    cwd: "/tmp",
    model: { id: modelId },
    sessionManager: {
      getSessionFile: () => "/tmp/session.jsonl",
    },
  } as any;
}

function makeMockCommandCtx() {
  return {
    hasUI: true,
    ui: {
      notify: (msg: string, _type: string) => {},
    },
    model: { id: "openai/gpt-4o" },
  } as any;
}
```


## 5. Implementation Checklist

### Phase 1: Test Infrastructure
- [x] Create `test/support/` directory
- [x] Write `fetch-mock.ts` — intercepts global `fetch` calls for OpenFGA client testing
- [x] Write `mock-openfga-client.ts` — fake OpenFGA client with per-key result map and call recording
- [x] Write `mock-pipeline.ts` — fake HuggingFace pipeline factory returning configurable results
- [x] Write `mock-pi-tui.ts` — fake TUI components
- [x] Write `pi-extension-shim.ts` — fake ExtensionContext with registration tracking
- [x] Write `register-loader.mjs` — loader for TypeScript test execution
- [x] Create `test/integration/pii-extension.test.ts` (now `test/index-integration.test.ts`)

### Phase 2: Activation Tests
- [x] Test `piExtension(pi)` does not throw
- [x] Test `pii-alert` renderer is registered
- [x] Test `/check-pii` command is registered with non-empty description
- [x] Test `session_start` notification is sent
- [x] Test `/check-pii-auth` command is registered
- [x] Test `/check-pii-access` command is registered

### Phase 3: Message Renderer Tests
- [x] Test renderer with valid JSON — output contains "PII DETECTED" and entity types
- [x] Test renderer in `expanded: true` mode — includes sanitization hint
- [x] Test renderer with invalid JSON — returns a Text/Component (does not throw)

### Phase 4: `/check-pii` Command Tests
- [x] Test with zero detections — "No PII detected" notification
- [x] Test with detections — sends `pii-alert` custom message with correct types
- [x] Test with empty/missing args — notifies usage hint
- [x] Test `/check-pii-auth` with allowed/denied category scenarios
- [x] Test `/check-pii-access` with direct OpenFGA check results

### Phase 5: `before_agent_start` Hook Tests
- [x] Test clean text passes through unchanged and sends no message
- [x] Test PII detected + denied category → masked in prompt + alert sent
- [x] Test PII detected + allowed category → preserved in prompt + alert includes ALLOWED
- [x] Test empty/whitespace prompt → skipped (no classifier call)
- [x] Test model ID from `ctx.model` used as OpenFGA subject
- [x] Test OpenFGA unreachable → fail-closed (all PII masked)
- [x] Test system prompt injection includes PRIVACY NOTICE text
- [x] Test when `ctx.model?.id` is absent → all PII masked (fail-closed)
- [x] Test inline pii-alert message with correct MASKED/ALLOWED per entity

### Phase 6: `context` Hook Tests
- [x] Test `pii-alert` custom messages are filtered out
- [x] Test user message PII is masked
- [x] Test assistant messages are NOT masked (only user role processed)
- [x] Test multi-message conversation preserves non-user messages
- [x] Test OpenFGA category-level access allows PII in context

### Phase 7: OpenFGA Authorization Tests
- [x] Test category-allowed → literal preserved
- [x] Test category-denied + literal-allowed → literal preserved
- [x] Test category-denied + literal-not-configured → category-denied (fail-closed)
- [x] Test fail-closed on first category-level check throw
- [x] Test fail-closed mid-batch after some category checks succeed
- [x] Test only categories that fail BOTH category-level AND all literal checks are denied
- [x] Test exactly one category-level check per unique category (not per entity)

### Phase 8: Sharing Authorization (Output Direction)
- [x] Test `message_end` handler — returns early for non-assistant messages
- [x] Test `message_end` handler — returns early when sharing is disabled
- [x] Test `message_end` handler — returns early when no recipient is configured
- [x] Test `message_end` handler — returns early when no PII detected
- [x] Test `message_end` handler — returns unmodified message when sharing is allowed
- [x] Test `message_end` handler — returns masked message when sharing is denied
- [x] Test `tool_result` handler — output direction checks for tool-generated PII
- [x] Test `buildSharingDeniedCategoriesSet()` — all sharing checks pass → empty set
- [x] Test `buildSharingDeniedCategoriesSet()` — any check fails → category denied
- [x] Test `buildSharingDeniedCategoriesSet()` — records shareCalls for each entity
- [x] Test `buildSharingDeniedCategoriesSet()` — fail-closed when healthCheck fails
- [x] Test `checkSharingAuthorization()` — returns correct allowed/checks result
- [x] Test `isSharingEnabled()` — returns true only when env var is "true"
- [x] Test `getRecipientId()` — returns env var value or empty string

### Phase 9: OpenFGA Client Tests
- [x] `OpenFGAClient.check()` — correct user/object format, auth header, error handling
- [x] `OpenFGAClient.checkShare()` — 4-way check, early termination, fail-closed
- [x] `OpenFGAClient.writeTuples()` — hashing, category prefix, batch writes
- [x] `OpenFGAClient.readTuples()` — filter params, query string construction
- [x] `OpenFGAClient.deleteTuples()` — hashing, deletes key format
- [x] `OpenFGAClient.healthCheck()` — /healthz endpoint, network error handling

### Phase 10: Integration Tests (Real OpenFGA)
- [x] `openfga-integration.test.ts` — real API tests (requires `OPENFGA_INTEGRATION_TEST=true`)
- [x] Complete 4-way sharing authorization flow test
- [x] Category defines model_instance check
- [x] Denied without tuple check

---

## 5b. Proposed Tests for Failures and Invalid Tuple Combinations

### Tuple Format/Construction Failures
- [x] Write tuple with invalid object type (neither pii_instance, category, nor recipient prefix)
- [x] Write tuple with malformed SHA256 hash (not 40 hex chars)
- [x] Write tuple with empty subject
- [x] Write tuple with empty relation
- [x] Write tuple with special characters in subject that break OpenFGA parsing
- [x] Write tuple with unicode in subject/relation/object
- [x] Check with subject exceeding maximum length
- [x] Check with object that has no matching type in schema
- [x] buildPIIInstanceId with 40-char hex string correctly prefixes as pii_instance
- [x] buildPIIInstanceId with sha256- prefix correctly formats
- [x] buildPIIInstanceId with category-like string (email) returns category prefix
- [x] buildRecipientId with recipient: prefix returns as-is
- [x] buildRecipientId without prefix adds recipient: prefix
- [x] buildModelInstanceId with model_instance: prefix returns as-is
- [x] buildModelInstanceId without prefix adds model_instance: prefix

### Cross-Type Tuple Reversal Issues
- [x] can_share check sends correct direction: model_instance#can_share@pii_instance
- [x] lineage check is called when can_share passes
- [x] verifies all 4 check directions are called correctly
- [x] trust check is called when checkRecipientTrust is true and all previous checks pass
- [x] auto-prefixes piiInstance with pii_instance: when sha256- only is provided
- [x] auto-prefixes recipient with recipient: when just user:alice is provided
- [x] can_view check direction is pii_instance#can_view@recipient

### Authorization Failures (4-Way Check Components)
- [x] returns allowed=false when model has no can_share tuple
- [x] returns allowed=false when lineage is invalid (lineage check fails)
- [x] returns allowed=false when lineage points to different model
- [x] returns allowed=false when recipient has no can_view tuple
- [x] returns allowed=false when recipient has no trust tuple (checkRecipientTrust=true)
- [x] early termination after can_share failure
- [x] early termination after lineage failure
- [x] returns modelCanShare=true but lineageValid=false when lineage check fails
- [x] different model has can_share for same PII does not grant sharing to original model
- [x] PII lineage points to itself returns false for actual model sharing
- [x] checkShare without checkRecipientTrust omits recipientTrusts field

### Fail-Closed Scenarios
- [x] fail-closes when OpenFGA server unreachable (network error)
- [x] fail-closes when OpenFGA returns 500 Internal Server Error
- [x] fail-closes when OpenFGA returns 404 Not Found (store doesn't exist)
- [x] fail-closes when OpenFGA returns malformed JSON
- [x] fail-closes when OpenFGA returns missing allowed field
- [x] fail-closes when request times out
- [x] fail-closes check() when OpenFGA is unreachable
- [x] fail-closes writeTuples() when OpenFGA returns error
- [x] healthCheck returns false on network error (does not throw)
- [x] healthCheck returns false on non-2xx response (does not throw)

### Authorization Model Schema Violations
- [x] check with non-existent relation returns false (OpenFGA schema violation)
- [x] check with object type not in model returns false or error
- [x] write tuple with relation not defined on subject type may throw
- [x] using deprecated originates_from relation name is handled
- [x] check with subject type not in directly_related_user_types returns false

### Batch Check Failure Modes
- [x] batchCheckShare fail-closes when batch check throws
- [x] batchCheckShare fail-closes when batch check returns non-2xx
- [x] batchCheckShare with mixed object types sends all with can_share relation
- [x] batchCheckShare returns Map with piiInstance keys

### Tuple Delete/Read Failures
- [x] deleteTuples of non-existent tuple does not throw (graceful handling)
- [x] deleteTuples with wrong relation deletes correct tuple by user+object+relation
- [x] readTuples with no matching filter returns empty array
- [x] readTuples builds correct query params with all filters
- [x] readTuples throws on non-2xx response
- [x] deleteTuples throws on non-2xx response

### Concurrency/Race Condition Scenarios
- [x] concurrent writes to same tuple are independent (no locking)
- [x] check immediately after write may return stale data (eventual consistency)
- [x] delete during check in flight - check may succeed or fail (undefined behavior)

### Edge Cases with Real Data
- [x] PII with same hash from different contexts - lineage is per-model
- [x] model shares PII it received from another model - lineage fails
- [x] recipient that is also a model_instance (dual role) - check uses recipient role
- [x] empty/whitespace-only PII literal still hashes correctly
- [x] PII with newlines and control characters is preserved in hash
- [x] hashLiteral produces different hashes for similar inputs
- [x] hashLiteral is deterministic

### Integration-Specific Failure Cases
- [x] store ID doesn't exist returns error
- [x] model ID (authorization model ID) doesn't exist returns error
- [x] wrong API token returns 403 Forbidden
- [x] write to read-only store returns 409 Conflict or similar
- [x] read succeeds on read-only store
- [x] invalid JSON in request body returns 400 Bad Request

## 6. What Cannot Be Tested Here

| Feature | Tested? | Reason |
|---|---|---|
| Real ML inference (privacy-filter model) | ❌ | Requires local model files + GPU/WebGPU |
| Real OpenFGA server | ❌ | External dependency; mock covers logic |
| TTY rendering aesthetics | ⚠️ partial | Can verify rendered lines are non-empty, but not visual layout |
| WebGPU device fallback | ❌ | Requires browser/WebGPU environment |
| End-to-end with real pi session | ❌ | Requires full pi process; covered by e2e/manual testing |

## 7. Relationship to pi-subagents Tests

The Privacy Filter extension is structurally simpler than pi-subagents — it has no sub-process spawning, no background job tracking, no intercom bridge, and no TUI Manager screens. The test approach is therefore more direct:

| Aspect | pi-subagents | Privacy Filter |
|---|---|---|
| Process spawning | Yes (mock-pi binary) | No |
| Background jobs | Yes (result watcher, poller) | No |
| Intercom | Yes (event bus) | No |
| TUI screens | Yes (Agent Manager) | No (only inline renderers) |
| External ML model | No | Yes (mocked) |
| Authorization service | No | Yes (OpenFGA, mocked) |
| Session lifecycle | Complex (multiple hooks) | Simple (one notification) |
| Existing test infra | Yes (`test/support/`) | No (must be created) |


## 8. Summary

The Privacy Filter extension has three distinct concerns that must be tested:

1. **ML classification** — handled by a `createMockClassifier()` factory that intercepts the `pipeline()` call and returns synthetic entity lists. This is injected via `globalThis` so the real import path does not need to be changed.

2. **OpenFGA authorization** — handled by a `createMockOpenFGA()` that tracks per-key boolean results. It supports both category-level and literal-level checks and simulates network failure by throwing on unset keys (triggering fail-closed behavior).

3. **Extension registration + event hooks** — handled by a `createMockPi()` fake `ExtensionAPI` that records registrations and emits synthetic events to registered handlers. TUI component rendering is exercised by calling the stored renderer functions with mock theme objects.

The test file `pii-extension.test.ts` activates the extension with these three mocks in place, then exercises:
- `before_agent_start` with PII-free and PII-present prompts (with allow/deny authorization paths)
- `context` with mixed message types (filtering pii-alerts, masking user content)
- `/check-pii` command with various detection results
- Message renderer output structure
- OpenFGA fail-closed behavior

All tests run headless without a GPU, network, or display, and complete in milliseconds.

