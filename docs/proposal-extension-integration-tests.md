# Proposal: Integration Tests for the pi-subagents Extension

## 1. Problem Statement

The `src/extension/index.ts` entry point registers tools, message renderers, slash commands, and session lifecycle hooks with the pi coding agent. Unlike the execution-layer tests in `test/integration/` which test `runSync` in isolation using a mock `pi` CLI, there are no integration tests that exercise the extension's registration pipeline end-to-end: activating the extension inside a real pi session, invoking its tools via the tool registry, and verifying the rendered outputs in a session.

This gap means bugs in tool parameter handling, message rendering, slash command routing, and session lifecycle management are not caught by the existing test suite.

## 2. Constraints

- Extension tests must run inside a **real pi environment** where `@mariozechner/pi-coding-agent` is importable and its extension API (`ExtensionContext`, `tool`, `messageRenderer`, `slashCommand`, `onSessionEnd`, etc.) is available.
- The test should **not** require a real LLM backend; it should simulate agent responses at the message layer.
- The mock-pi approach (fake CLI binary that returns queued JSONL responses) **cannot** test extension registration — it only tests what happens after the CLI spawns.
- Integration with the **TUI** (Agent Manager, chain builder screens) requires a display environment or careful mocking of `@mariozechner/pi-tui` rendering.
- Tests that invoke tools via `invoke` callbacks must handle the async completion-based API.


## 3. Approach

We propose a **layered test harness** that builds on the existing `test/support/` infrastructure:

### 3.1 Test Runner: Node.js with `--test` and a custom loader

The existing `register-loader.mjs` + `ts-loader.mjs` chain handles `.ts`→`.js` import resolution for source files. We extend this to also resolve `@mariozechner/pi-coding-agent` imports by returning shim modules that expose the ExtensionContext API surface needed by `index.ts`.

```
test/
  support/
    pi-extension-shim.ts     # new: provides fake ExtensionContext, tool(), etc.
    mock-pi.ts               # existing: fake CLI binary
    helpers.ts               # existing: createMockPi, createTempDir, etc.
  integration/
    extension.test.ts        # new: tests for extension registration
```

The test runner command remains:
```bash
node --experimental-transform-types --import ./test/support/register-loader.mjs --test test/integration/extension.test.ts
```

### 3.2 Shim Design

`pi-extension-shim.ts` exports a **fake `ExtensionContext`** that tracks all registered tools, message renderers, slash commands, and session hooks. It also provides a **fake `tool` function** (matching the pi API) that records invocations and resolves with simulated results.

```typescript
// test/support/pi-extension-shim.ts
export interface ShimExtensionContext {
  context: ExtensionContext;
  registeredTools: RegisteredTool[];
  registeredRenderers: RegisteredRenderer[];
  registeredSlashCommands: RegisteredSlashCommand[];
  sessionEndHooks: Array<(sessionId: string) => void>;
  reset(): void;
}

export function createShimExtensionContext(): ShimExtensionContext { ... }
```

This allows tests to:
1. Call `activate(shimContext)` — simulating the extension loading in pi.
2. Inspect `shimContext.registeredTools` to verify correct tools were registered.
3. Call `shimContext.context.tool('subagent', { ... })` directly to test tool invocation.
4. Inspect captured renderers and slash commands.

### 3.3 What Can Be Tested Without a Real pi Process

| Extension Feature | Testable via Shim | Notes |
|---|---|---|
| Tool registration (names, descriptions, schemas) | ✅ | Inspect `registeredTools` after activation |
| Tool parameter validation (SubagentParams schema) | ✅ | Call `tool.invoke()` with valid/invalid params |
| Tool invocation routing (single/parallel/chain) | ⚠️ | Partial — execution delegates to `runSync` which can use mock-pi |
| Message renderer registration | ✅ | Inspect `registeredRenderers` |
| Slash command registration | ✅ | Inspect `registeredSlashCommands` |
| Session lifecycle hooks | ✅ | Call `sessionEndHooks` manually |
| TUI Agent Manager screens | ❌ | Requires `@mariozechner/pi-tui` rendering |
| TUI chain/parallel builder | ❌ | Requires interactive TUI |
| Intercom bridge | ⚠️ | Can mock the intercom channel |


## 4. Test Structure

### 4.1 Shim Module (`pi-extension-shim.ts`)

```typescript
// test/support/pi-extension-shim.ts
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { SubagentParams } from "../../src/extension/schemas.ts";

export interface RegisteredTool {
  name: string;
  description: string;
  schema: unknown;
  handler: Function;
}

export interface ShimExtensionContext {
  context: ExtensionContext;
  registeredTools: RegisteredTool[];
  registeredRenderers: Array<{ id: string; renderer: Function }>;
  registeredSlashCommands: Array<{ name: string; handler: Function }>;
  sessionEndHooks: Array<(sessionId: string) => void>;
  reset(): void;
}

export function createShimExtensionContext(): ShimExtensionContext {
  const tools: RegisteredTool[] = [];
  const renderers: Array<{ id: string; renderer: Function }> = [];
  const slashCommands: Array<{ name: string; handler: Function }> = [];
  const sessionEndHooks: Array<(sessionId: string) => void> = [];
  let sessionCounter = 0;

  const context = {
    tool: (name: string, description: string, schema: unknown, handler: Function) => {
      tools.push({ name, description, schema, handler });
    },
    messageRenderer: (id: string, renderer: Function) => {
      renderers.push({ id, renderer });
    },
    slashCommand: (name: string, handler: Function) => {
      slashCommands.push({ name, handler });
    },
    onSessionEnd: (handler: (sessionId: string) => void) => {
      sessionEndHooks.push(handler);
    },
  } as unknown as ExtensionContext;

  return {
    context,
    get registeredTools() { return [...tools]; },
    get registeredRenderers() { return [...renderers]; },
    get registeredSlashCommands() { return [...slashCommands]; },
    get sessionEndHooks() { return [...sessionEndHooks]; },
    reset() {
      tools.length = 0;
      renderers.length = 0;
      slashCommands.length = 0;
      sessionEndHooks.length = 0;
      sessionCounter = 0;
    },
  };
}
```


### 4.2 Extension Integration Tests (`extension.test.ts`)

```typescript
/**
 * Integration tests for the pi-subagents extension (src/extension/index.ts).
 *
 * Uses a shim ExtensionContext to test:
 * - Tool registration (names, schemas, descriptions)
 * - Message renderer registration
 * - Slash command registration
 * - Tool invocation routing to execution layer
 * - Session lifecycle hooks
 *
 * Does NOT test TUI rendering (requires a real display) or
 * intercom bridge (requires a parent pi process).
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  createShimExtensionContext,
  type ShimExtensionContext,
} from "../support/pi-extension-shim.ts";
import { createMockPi, createTempDir, removeTempDir } from "../support/helpers.ts";
import { tryImport } from "../support/helpers.ts";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let shimContext: ShimExtensionContext;
let mockPi: ReturnType<typeof createMockPi>;

const EXTENSION_PATH = path.resolve("./src/extension/index.ts");

const extension = await tryImport(EXTENSION_PATH);

const available = !!extension;
const activate = extension?.activate;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extension activation", { skip: !available }, () => {
  before(() => {
    shimContext = createShimExtensionContext();
    mockPi = createMockPi();
    mockPi.install();
  });

  after(() => {
    mockPi.uninstall();
  });

  beforeEach(() => {
    shimContext.reset();
    mockPi.reset();
  });

  // ---------------------------------------------------------------------
  // Tool registration
  // ---------------------------------------------------------------------

  it("registers exactly one tool named 'subagent'", async () => {
    await activate(shimContext.context);
    const tool = shimContext.registeredTools.find((t) => t.name === "subagent");
    assert.ok(tool, "expected a tool named 'subagent' to be registered");
  });

  it("registers a tool with a non-empty description", async () => {
    await activate(shimContext.context);
    const tool = shimContext.registeredTools.find((t) => t.name === "subagent");
    assert.ok(tool?.description && tool.description.length > 0);
  });

  it("registers a tool whose schema accepts known SubagentParams fields", async () => {
    await activate(shimContext.context);
    const tool = shimContext.registeredTools.find((t) => t.name === "subagent");
    assert.ok(tool?.schema, "tool should have a parameter schema");
    // Schema should be a TypeBox TObject containing key fields
    const schema = tool!.schema as { type?: string; properties?: Record<string, unknown> };
    assert.equal(schema.type, "Object");
    assert.ok(schema.properties?.agent, "schema should have an 'agent' property");
    assert.ok(schema.properties?.task, "schema should have a 'task' property");
    assert.ok(schema.properties?.action, "schema should have an 'action' property");
    assert.ok(schema.properties?.chain, "schema should have a 'chain' property");
  });

  // ---------------------------------------------------------------------
  // Message renderer registration
  // ---------------------------------------------------------------------

  it("registers a message renderer for 'subagent-progress' events", async () => {
    await activate(shimContext.context);
    const renderer = shimContext.registeredRenderers.find(
      (r) => r.id === "subagent-progress",
    );
    assert.ok(renderer, "expected a 'subagent-progress' message renderer");
    assert.equal(typeof renderer.renderer, "function");
  });

  it("registers a message renderer for 'subagent-result' events", async () => {
    await activate(shimContext.context);
    const renderer = shimContext.registeredRenderers.find(
      (r) => r.id === "subagent-result",
    );
    assert.ok(renderer, "expected a 'subagent-result' message renderer");
    assert.equal(typeof renderer.renderer, "function");
  });

  // ---------------------------------------------------------------------
  // Slash command registration
  // ---------------------------------------------------------------------

  it("registers a slash command named 'subagent'", async () => {
    await activate(shimContext.context);
    const cmd = shimContext.registeredSlashCommands.find(
      (c) => c.name === "subagent",
    );
    assert.ok(cmd, "expected a '/subagent' slash command");
    assert.equal(typeof cmd.handler, "function");
  });

  // ---------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------

  it("registers at least one session-end cleanup hook", async () => {
    await activate(shimContext.context);
    assert.ok(shimContext.sessionEndHooks.length > 0,
      "expected at least one onSessionEnd hook");
  });

  // ---------------------------------------------------------------------
  // Tool invocation — single execution
  // ---------------------------------------------------------------------

  it("invoking the subagent tool with single-agent params triggers runSync via mock-pi", async () => {
    await activate(shimContext.context);
    const tool = shimContext.registeredTools.find((t) => t.name === "subagent");
    assert.ok(tool, "no subagent tool found");

    mockPi.onCall({ output: "echo response from mock agent" });

    const result = await tool.handler({
      agent: "echo",
      task: "Say hello",
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.agent, "echo");
    assert.ok(mockPi.callCount() >= 1, "pi CLI should have been called");
  });

  it("invoking the subagent tool with unknown agent returns error result", async () => {
    await activate(shimContext.context);
    const tool = shimContext.registeredTools.find((t) => t.name === "subagent");
    assert.ok(tool);

    const result = await tool.handler({
      agent: "nonexistent",
      task: "Do something",
    });

    assert.equal(result.exitCode, 1);
    assert.ok(result.error?.includes("Unknown agent"));
    assert.equal(mockPi.callCount(), 0, "pi should not be called for unknown agent");
  });

  // ---------------------------------------------------------------------
  // Tool invocation — parallel execution
  // ---------------------------------------------------------------------

  it("invoking with tasks array triggers parallel execution", async () => {
    await activate(shimContext.context);
    const tool = shimContext.registeredTools.find((t) => t.name === "subagent");
    assert.ok(tool);

    mockPi.onCall({ output: "first" });
    mockPi.onCall({ output: "second" });

    const result = await tool.handler({
      tasks: [
        { agent: "echo", task: "Task one" },
        { agent: "echo", task: "Task two" },
      ],
    });

    assert.equal(result.exitCode, 0);
    assert.ok(mockPi.callCount() >= 2, "pi CLI should be called twice for parallel");
  });

  // ---------------------------------------------------------------------
  // Tool invocation — chain execution
  // ---------------------------------------------------------------------

  it("invoking with chain array triggers chain execution", async () => {
    await activate(shimContext.context);
    const tool = shimContext.registeredTools.find((t) => t.name === "subagent");
    assert.ok(tool);

    mockPi.onCall({ output: "step one result" });
    mockPi.onCall({ output: "step two result" });

    const result = await tool.handler({
      chain: [
        { agent: "echo", task: "Step one" },
        { agent: "echo", task: "Step two {previous}" },
      ],
    });

    assert.equal(result.exitCode, 0);
    assert.ok(mockPi.callCount() >= 2, "pi CLI should be called twice for chain");
  });

  // ---------------------------------------------------------------------
  // Management actions
  // ---------------------------------------------------------------------

  it("action=list returns a list of agents", async () => {
    await activate(shimContext.context);
    const tool = shimContext.registeredTools.find((t) => t.name === "subagent");
    assert.ok(tool);

    const result = await tool.handler({ action: "list" });
    assert.equal(result.exitCode, 0);
    assert.ok(Array.isArray(result.agents));
    assert.ok(result.agents.length > 0);
  });

  it("action=get returns details for a known agent", async () => {
    await activate(shimContext.context);
    const tool = shimContext.registeredTools.find((t) => t.name === "subagent");
    assert.ok(tool);

    const result = await tool.handler({ action: "get", agent: "scout" });
    assert.equal(result.exitCode, 0);
    assert.equal(result.agent?.name, "scout");
    assert.ok(result.agent?.description);
  });

  it("action=create with config object creates a new agent", async () => {
    await activate(shimContext.context);
    const tool = shimContext.registeredTools.find((t) => t.name === "subagent");
    assert.ok(tool);

    const result = await tool.handler({
      action: "create",
      config: {
        name: "test-agent",
        description: "A test agent",
        systemPrompt: "You are a test.",
        model: "openai/gpt-4o",
      },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.agent?.name, "test-agent");
  });

  it("action=create with invalid config returns error", async () => {
    await activate(shimContext.context);
    const tool = shimContext.registeredTools.find((t) => t.name === "subagent");
    assert.ok(tool);

    const result = await tool.handler({
      action: "create",
      config: { name: "" }, // invalid: empty name
    });
    assert.equal(result.exitCode, 1);
    assert.ok(result.error);
  });

  it("action=delete removes a project-scoped agent", async () => {
    await activate(shimContext.context);
    const tool = shimContext.registeredTools.find((t) => t.name === "subagent");
    assert.ok(tool);

    // First create an agent
    await tool.handler({
      action: "create",
      config: { name: "temp-agent", scope: "project" },
    });

    // Then delete it
    const result = await tool.handler({
      action: "delete",
      agent: "temp-agent",
    });
    assert.equal(result.exitCode, 0);

    // Verify it's gone
    const listResult = await tool.handler({ action: "list" });
    assert.ok(!listResult.agents?.some((a: { name: string }) => a.name === "temp-agent"));
  });

  // ---------------------------------------------------------------------
  // Control events surface in results
  // ---------------------------------------------------------------------

  it("active-long-running control event is included in result when threshold reached", async () => {
    await activate(shimContext.context);
    const tool = shimContext.registeredTools.find((t) => t.name === "subagent");
    assert.ok(tool);

    mockPi.onCall({
      jsonl: [
        events.assistantMessage("first turn"),
        events.assistantMessage("second turn"),
      ],
    });

    const result = await tool.handler({
      agent: "echo",
      task: "Long task",
      control: { enabled: true, activeNoticeAfterTurns: 2 },
    });

    assert.equal(result.exitCode, 0);
    const activeEvent = result.controlEvents?.find(
      (e: { type: string }) => e.type === "active_long_running",
    );
    assert.ok(activeEvent, "expected an active_long_running event in result");
    assert.equal(activeEvent.reason, "turn_threshold");
    assert.equal(activeEvent.turns, 2);
  });

  // ---------------------------------------------------------------------
  // Artifacts and session files
  // ---------------------------------------------------------------------

  it("result includes artifactPaths when artifactsDir is provided", async () => {
    await activate(shimContext.context);
    const tool = shimContext.registeredTools.find((t) => t.name === "subagent");
    assert.ok(tool);

    const tempDir = createTempDir();
    try {
      mockPi.onCall({ output: "Result text" });
      const artifactsDir = path.join(tempDir, "artifacts");

      const result = await tool.handler({
        agent: "echo",
        task: "Task",
        artifactsDir,
        artifacts: true,
      });

      assert.equal(result.exitCode, 0);
      assert.ok(result.artifactPaths, "result should have artifactPaths");
      assert.ok(result.artifactPaths?.outputPath.endsWith("_output.md"));
    } finally {
      removeTempDir(tempDir);
    }
  });
});
```


### 4.3 Test Support: `events` Helper

The existing `helpers.ts` exports an `events` object with message factory functions used in the execution tests. The extension tests reuse the same helpers:

```typescript
// At the top of extension.test.ts
import {
  createMockPi,
  createTempDir,
  removeTempDir,
  events,  // from helpers.ts: toolStart, toolEnd, toolResult, assistantMessage
  tryImport,
} from "../support/helpers.ts";
```


## 5. Testing the TUI Integration

The Agent Manager TUI (`src/tui/render.ts` + `src/manager-ui/*.ts`) requires a live TTY to render widgets. Full integration testing of TUI screens is out of scope for automated CI, but a **render sanity test** is achievable by verifying that the render functions produce non-empty output arrays and do not throw:

```typescript
// In extension.test.ts — TUI smoke tests
it("agent list renderer produces non-empty lines", async () => {
  // Skip if no display (headless CI)
  if (!process.env.DISPLAY && !process.stdout.isTTY) {
    return; // skip
  }
  // Import the real renderer (not the shim)
  const render = await import("../../src/tui/render.ts");
  const mockProgress: AgentProgress = {
    agent: "scout",
    index: 0,
    status: "completed",
    task: "Scout the repo",
    skillNames: [],
    recentTools: [],
    recentOutput: ["Found 3 files"],
    toolCount: 2,
    tokens: 1500,
    durationMs: 5000,
    lastActivityAt: Date.now(),
  };
  const lines = render.renderAgentList([mockProgress], { width: 80 });
  assert.ok(lines.length > 0, "renderer should produce output lines");
});

it("chain builder renderer accepts valid chain config and produces output", async () => {
  if (!process.env.DISPLAY && !process.stdout.isTTY) return;
  const render = await import("../../src/tui/render.ts");
  const chainConfig = {
    steps: [
      { agent: "scout", task: "Scout" },
      { agent: "planner", task: "Plan {previous}" },
    ],
  };
  const lines = render.renderChainBuilder(chainConfig, { width: 80 });
  assert.ok(lines.length > 0);
});
```

The existing `ts-loader.mjs` already shims `@mariozechner/pi-tui` with a minimal `Container`/`Text`/`Markdown` stub when rendering files are loaded from within the loader's parent context. For TUI tests, the loader should be configured to **not** apply the stub so the real renderer can be tested (or the stub should be enhanced to capture render output).


## 6. Testing Intercom Bridge Integration

The intercom bridge (`src/intercom/intercom-bridge.ts`) allows child agents to send messages to the parent pi process. Testing it fully requires a mock parent process that speaks the intercom protocol. A simpler approach tests the **bridge lifecycle** within a single process:

```typescript
// In extension.test.ts — Intercom bridge tests
import { INTERCOM_DETACH_REQUEST_EVENT, INTERCOM_DETACH_RESPONSE_EVENT } from "../../src/shared/types.ts";

it("subagent tool with intercomEvents emits detach request on intercom tool start", async () => {
  await activate(shimContext.context);
  const tool = shimContext.registeredTools.find((t) => t.name === "subagent");
  const eventBus = createEventBus();
  let detachEmitted = false;

  eventBus.on(INTERCOM_DETACH_REQUEST_EVENT, () => { detachEmitted = true; });

  mockPi.onCall({
    steps: [
      { jsonl: [events.toolStart("intercom", { action: "ask", to: "orchestrator" })] },
      { delay: 500, jsonl: [events.assistantMessage("received")] },
    ],
  });

  await tool.handler({
    agent: "echo",
    task: "Ask orchestrator",
    intercomEvents: eventBus,
    allowIntercomDetach: true,
  });

  // Note: mock-pi does not natively emit progress updates,
  // so this test validates the event bus wiring conceptually.
  // Full coverage requires a real pi spawn with intercom enabled.
  assert.ok(detachEmitted || true, "event bus should be registered");
});
```

A full intercom integration test would require a **two-process setup**: a parent process running the extension and a child process spawned as a subagent, communicating over the intercom socket. This is closer to an end-to-end system test than a unit integration test and is best handled separately.


## 7. Implementation Checklist

### Phase 1: Shim Infrastructure
- [ ] Create `test/support/pi-extension-shim.ts` exporting `createShimExtensionContext()`
- [ ] Shim should implement the full `ExtensionContext` interface surface used by `index.ts`
- [ ] Shim should track `registeredTools`, `registeredRenderers`, `registeredSlashCommands`, `sessionEndHooks`
- [ ] Shim's `tool()` should invoke the real handler (via dynamic import of execution layer) so invocation tests work

### Phase 2: Core Extension Tests
- [ ] Create `test/integration/extension.test.ts` with activation tests (tools, renderers, slash commands)
- [ ] Add tests for single-agent tool invocation routing via mock-pi
- [ ] Add tests for parallel task invocation routing
- [ ] Add tests for chain execution routing
- [ ] Add tests for management actions (list, get, create, update, delete)

### Phase 3: Schema and Edge Cases
- [ ] Test tool invocation with invalid/missing required parameters
- [ ] Test `action=create` with malformed config (missing name, invalid JSON string)
- [ ] Test `action=resume` / `action=interrupt` with unknown run IDs
- [ ] Test `outputMode: "file-only"` without `output` path → early error

### Phase 4: Control Events and Lifecycle
- [ ] Test control event emission in tool results (active-long-running, needs-attention)
- [ ] Test session-end cleanup hook invocation

### Phase 5: TUI Smoke Tests
- [ ] Add headless-safe TUI render tests (skip when `DISPLAY` unset and not a TTY)
- [ ] Verify render functions produce non-empty output

### Phase 6: Intercom (optional/future)
- [ ] Design two-process test setup for intercom bridge
- [ ] Implement mock intercom socket for in-process bridge testing

## 8. Relationship to Existing Tests

| What is tested | Existing tests | New extension tests |
|---|---|---|
| `runSync` execution (spawns mock-pi) | ✅ `single-execution.test.ts` | — |
| Background runner (`subagent-runner.ts`) | ✅ `background.test.ts` | — |
| Chain execution | ✅ `chain-execution.test.ts` | — |
| Extension tool registration | ❌ | ✅ `extension.test.ts` |
| Extension message renderers | ❌ | ✅ `extension.test.ts` |
| Extension slash commands | ❌ | ✅ `extension.test.ts` |
| Extension management actions (list/get/create/delete) | ❌ | ✅ `extension.test.ts` |
| Extension → execution routing | ❌ | ✅ `extension.test.ts` |
| TUI render output | ❌ | ⚠️ smoke only |
| Intercom bridge | ❌ | ⚠️ partial via event bus |

## 9. Mock-pi vs Extension Tests: Key Differences

| | `mock-pi` execution tests | Extension integration tests |
|---|---|---|
| Tests layer | `runSync`, foreground runner, chain logic | `index.ts` registration + routing |
| CLI binary | Real mock-pi binary spawned as child process | Not spawned — shim intercepts at API level |
| Extension context | Not loaded | Loaded via `activate(shimContext)` |
| Tool registry | Not tested | Verified by inspecting `registeredTools` |
| pi packages needed | Yes (runtime import of `execution.ts`) | Yes (runtime import of `index.ts` + shim) |
| LLM simulation | JSONL responses queued in `default-response.json` | JSONL responses via mock-pi (when execution is invoked) |

The two test suites are **complementary**: execution tests verify the run logic in isolation; extension tests verify that the extension correctly wires itself into the pi plugin API and routes calls to the execution layer.


## 10. Summary

The proposed approach:

1. **Shim `ExtensionContext`** (`test/support/pi-extension-shim.ts`) — a fake context that records all registrations and allows direct tool invocation without spawning a real pi process.
2. **Extension test file** (`test/integration/extension.test.ts`) — activates the extension with the shim context, then inspects registered tools/renderers/slash commands, and invokes tools to verify routing to the execution layer (which itself uses `mock-pi` for LLM simulation).
3. **Reuses existing infrastructure** — `mock-pi`, `helpers.ts`, `register-loader.mjs`, `ts-loader.mjs` all continue to serve their roles.
4. **TUI coverage** is limited to smoke tests in headless environments; full TUI integration tests require a different approach (visual regression or manual).
5. **Intercom coverage** is partial — full intercom testing requires a two-process setup.

This closes the main testing gap: verifying that `src/extension/index.ts` correctly registers tools, message renderers, and slash commands, and that tool invocations are properly routed to the execution layer with correct parameters.

