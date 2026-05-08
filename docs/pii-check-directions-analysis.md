# PII Check Directions Analysis

## Overview

This document analyzes how PII (Personally Identifiable Information) checks can be applied in both message directions between pi-mono and the LLM, based on the pi-mono extension lifecycle events.

## Message Flow Architecture

```
User ──prompt──► pi-mono ──messages──► LLM ──response──► pi-mono ──output──► User
                      ▲                                                        │
                      │                                                        │
                   Tools                                                   Tools
                   Called                                                  Called
```

---

## Direction 1: Input Direction (User → LLM)

**Purpose**: Detect and mask/control PII in what the user sends to the model.

### Lifecycle Events for Input Direction

| Event | Required? | Purpose |
|-------|-----------|---------|
| `input` | ❌ Optional | Raw user input - fires before skill/template expansion |
| `before_agent_start` | ✅ Required | Current prompt + system prompt - where current PII is detected |
| `context` | ✅ Required | Full messages array (history) - where historical PII is filtered |
| `before_provider_request` | ❌ Optional | Final API payload - useful for debugging but not required |

### Event Analysis

**1. `input` event** - ❌ OPTIONAL
- Fires with raw text BEFORE skill/template expansion
- **Not required** because:
  - Whatever PII exists after expansion will be caught by `before_agent_start`
  - Early interception adds complexity without additional filtering benefit
  - Could be useful for blocking specific patterns before expansion

**2. `before_agent_start` event** - ✅ REQUIRED
- User prompt is available at `event.prompt`
- System prompt can be modified via `event.systemPrompt`
- **This is where the current prompt's PII is detected and masked**
- Can inject additional context/messages

**3. `context` event** - ✅ REQUIRED
- Messages array (`event.messages`) is mutable - deep copy, safe to modify
- **This is where conversation history PII is filtered**
- Catches PII in previous user messages before LLM processes them
- Also filters out extension-generated messages (like PII alerts)

**4. `before_provider_request` event** - ❌ OPTIONAL
- Final payload before sending to LLM
- **Useful for debugging** to verify what actually gets sent
- Not required for filtering since `before_agent_start` + `context` cover everything

### Minimal Implementation: Input Direction

```typescript
// Only TWO events are strictly required for input direction PII checks

pi.on("before_agent_start", async (event, ctx) => {
  // Detect and mask PII in current prompt
  const results = await classifier(event.prompt, { aggregation_strategy: "simple" });
  const modelSubject = ctx.model?.id;
  const deniedCategories = await buildDeniedCategoriesSet(results, modelSubject);
  const piiToMask = results.filter(r => deniedCategories.has(r.entity_group));
  
  return {
    prompt: maskPII(event.prompt, piiToMask),
    systemPrompt: event.systemPrompt + injection,  // Add privacy notice
  };
});

pi.on("context", async (event, ctx) => {
  // Filter PII from message history
  for (const msg of event.messages) {
    if (msg.role === "user") {
      // Detect and mask PII in each user message
      const results = await classifier(extractText(msg.content), {...});
      // ... apply authorization and mask
    }
  }
  return { messages: filteredMessages };
});
```

### Why Input Direction Works with Only 2 Events

| Source of PII | Covered By |
|---------------|------------|
| Current user prompt | `before_agent_start` ✅ |
| Conversation history (user messages) | `context` ✅ |
| Expanded content (from skills/templates) | `before_agent_start` (after expansion) ✅ |

---

## Direction 2: Output Direction (LLM → User)

**Purpose**: Detect and mask/control PII in what the model generates (shared output).

### Lifecycle Events for Output Direction

| Event | Required? | Purpose |
|-------|-----------|---------|
| `message_start` | ❌ Optional | Assistant message begins - fires before any content |
| `message_update` | ❌ Optional | Token-by-token streaming - catches PII as it appears |
| `message_end` | ✅ **REQUIRED** | Finalized message - **primary and only required hook** |
| `tool_result` | ❌ Optional | Tool results returned to LLM - not to user directly |

### Event Analysis

**1. `message_start` event** - ❌ OPTIONAL
- Assistant message begins
- Role is `"assistant"`
- **No content yet** - too early to do anything useful
- Could initialize state for streaming detection, but not required

**2. `message_update` event** - ❌ OPTIONAL (but useful)
- Token-by-token streaming updates
- `event.assistantMessageEvent` contains stream data
- **Caveat**: Content is incomplete, complicating hash computation for authorization
- Could be used for early detection/streaming mask, but adds complexity

**3. `message_end` event** - ✅ **REQUIRED**
- Message is finalized
- Full content available at `event.message.content`
- Can return `{ message }` to replace/modify before delivery
- **This is the primary and essentially only required event for output PII checks**
- 4-way sharing authorization works best with complete content

**4. `tool_result` event** - ❌ OPTIONAL
- Tool results returned to LLM (not to user)
- **Only relevant if**:
  - Model-generated PII comes via tool execution
  - AND you want to filter it before LLM sees the result
- Typically not needed for output direction user-facing checks

### Why `message_end` is Sufficient for Output Direction

1. **Complete content** - Full message available, no partial hash issues
2. **Can replace message** - Return `{ message }` to modify before delivery
3. **Single point** - One event covers all output scenarios
4. **Authorization-friendly** - 4-way check requires hashing literal → need full content

### Minimal Implementation: Output Direction

```typescript
// ONLY message_end is strictly required for output direction PII checks

pi.on("message_end", async (event, ctx) => {
  if (event.message.role !== "assistant") return;
  
  // Check if sharing is enabled
  if (!isSharingEnabled()) return;
  
  // Extract full content - available at message_end
  const content = extractText(event.message.content);
  if (!content) return;
  
  // Detect PII in model's response
  const results = await classifier(content, { aggregation_strategy: "simple" });
  if (results.length === 0) return;
  
  // Apply 4-way sharing authorization check
  const modelSubject = ctx.model?.id;
  const recipientId = getRecipientId();
  
  const deniedCategories = await buildSharingDeniedCategoriesSet(
    results, 
    modelSubject, 
    recipientId,
    { checkRecipientTrust: true }
  );
  
  // Mask if any category is denied
  const piiToMask = results.filter(r => deniedCategories.has(r.entity_group));
  if (piiToMask.length > 0) {
    const maskedContent = maskPII(content, piiToMask);
    return {
      message: {
        ...event.message,
        content: maskedContent
      }
    };
  }
});
```

### Streaming Consideration

If you want to mask PII **as it streams** (before message is complete):

```typescript
// This adds complexity and is NOT required
pi.on("message_update", async (event, ctx) => {
  // Problem: Content is incomplete, so:
  // 1. SHA256 hash won't match full content
  // 2. Authorization checks may fail incorrectly
  // 3. Masking partial content breaks the stream
  
  // Only viable if: you detect PII and set a flag to mask at message_end
  // This adds significant complexity for marginal benefit
});
```

**Recommendation**: Stick with `message_end` only. The latency between streaming completion and message_end delivery is minimal.

### When `tool_result` Matters

`tool_result` is **NOT required** for basic output direction filtering, but becomes important in these scenarios:

#### 1. Tool Output Feeds Back to LLM (Input Direction Supplement)

When a tool executes, its results become part of the conversation context for the LLM's next turn:

```
User → LLM → Tool Call → Tool Executes → tool_result → LLM (next turn)
                                              ↑
                                     PII might appear here!
```

**Example cases**:
- `bash` command outputs a CSV with emails
- `read` reads a config file containing secrets
- `grep` finds patterns with sensitive data

In this case, `tool_result` is **part of input direction** - you're filtering what the LLM can see through tool execution.

#### 2. Tool Output Goes to Other Agents or Recipients

If your setup includes:
- **Agent-to-agent communication**
- **Harnesses that receive tool outputs**
- **External systems consuming tool results**

Tool output may be displayed to users or other systems, making `tool_result` relevant for **output direction**.

#### 3. Direct Tool Output to User

Some tools (e.g., `read`, `grep`) return results directly displayed to users. If tool output contains PII that shouldn't be shown, `tool_result` is the place to filter.

### When to Use `tool_result`

| Scenario | Use `tool_result`? | Direction Classification |
|----------|-------------------|--------------------------|
| Filter tool PII before LLM sees it | ✅ Yes | Input (supplemental) |
| Tool output goes to other agents/recipients | ✅ Yes | Output (supplemental) |
| Tool output displayed directly to user | ✅ Yes | Output |
| Basic model text response filtering | ❌ No | `message_end` sufficient |

### Important Clarification: `context` vs `tool_result`

**You are correct** that in most cases, existing input direction checks cover tool results:

| Scenario | Goes Through `context`? | Which Checks Apply |
|----------|------------------------|-------------------|
| Same LLM sees tool result in next turn | ✅ Yes | Input (`can_view` via `buildDeniedCategoriesSet()`) |
| Tool result displayed to user who called it | ✅ Yes (eventually) | Input (`can_view`) |
| Tool result displayed to **different** user/agent | ❌ No | Output (`can_share` via `buildSharingDeniedCategoriesSet()`) |

**When `context` covers it (no `tool_result` needed)**:
- Tool result is added to conversation as a `tool` role message
- `context` event sees it when LLM makes next call
- `buildDeniedCategoriesSet()` applies `can_view` checks automatically

**When `tool_result` is needed (different recipient)**:
- Multi-agent scenarios where Agent A's tool output goes to Agent B or User B
- The recipient is NOT the same entity that called the tool
- Output direction checks (`can_share` + lineage) would apply

In short: **if the tool result stays within the same conversation loop, `context` + `before_agent_start` are sufficient. `tool_result` is only needed when crossing to different agents or users.**

### Implementation Pattern: `tool_result`

```typescript
pi.on("tool_result", async (event, ctx) => {
  // event.toolName, event.toolCallId, event.content, event.details
  
  const content = extractText(event.content);
  const results = await classifier(content, {...});
  
  if (results.length === 0) return;
  
  // For input direction (LLM seeing tool results):
  // Use buildDeniedCategoriesSet() with can_view
  
  // For output direction (user/others seeing tool results):
  // Use buildSharingDeniedCategoriesSet() with can_share + lineage
  
  const piiToMask = results.filter(r => ...);
  if (piiToMask.length > 0) {
    return {
      content: maskPII(content, piiToMask),
      details: event.details,
      isError: event.isError
    };
  }
});
```

---

## Complete 4-Way Check Model

Based on the Privacy Filter extension's sharing authorization feature, a complete PII control system requires checking in all four directions:

### Direction Matrix

| Direction | Source | Target | Required Events | Purpose |
|-----------|--------|--------|-----------------|---------|
| **Input (primary)** | User | LLM | `before_agent_start` + `context` | Control what model sees from prompts |
| **Input (supplemental)** | Tool Result | LLM | `tool_result` | Control what model sees from tool execution |
| **Output (primary)** | LLM | User | `message_end` | Control what user receives in text responses |
| **Output (supplemental)** | Tool Result | User/Other | `tool_result` | Control tool output displayed to users/agents |

### The Sharing Authorization Flow (Output Direction with Authorization)

For output direction PII checks with OpenFGA authorization:

```
Model Output with PII
    │
    ▼
message_end event fires
    │
    ├── Extract PII from content
    ├── Compute SHA256 hashes
    │
    ├── Check 1: model --can_share--> pii_instance
    ├── Check 2: pii_instance --lineage--> model  
    ├── Check 3: recipient --can_view--> pii_instance
    ├── Check 4: recipient --can_receive_from--> model
    │
    ▼
All pass? ──No──► Mask PII
    │
   Yes
    │
    ▼
Keep PII in output
```

---

## OpenFGA Authorization for Output Direction

The Privacy Filter extension uses OpenFGA to authorize PII sharing with the 4-check model:

### Required Tuples

```bash
# 1. Model is authorized to share this PII
model_instance:<model>#can_share@pii_instance:<hash>

# 2. PII has lineage to this model (was created by this model)
pii_instance:<hash>#lineage@model_instance:<model>

# 3. Recipient can view this PII  
recipient:<recipient>#can_view@pii_instance:<hash>

# 4. Recipient trusts this model
recipient:<recipient>#can_receive_from@model_instance:<model>
```

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `PRIVACY_FILTER_RECIPIENT_ID` | Current recipient ID for sharing checks |
| `PRIVACY_FILTER_SHARING_ENABLED` | Enable output direction checks (`true`/`false`) |

---

## Event Timing Summary

```
user prompt
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ INPUT CHECKS (before LLM sees anything)                     │
│                                                             │
│   input ──► before_agent_start ──► context ──► before_provider_request │
│   (opt)     (REQUIRED)────(REQUIRED)─── (debug only)       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
LLM processes and responds
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ OUTPUT CHECKS (before user sees response)                   │
│                                                             │
│   message_start ──► message_update ──► message_end          │
│      (skip)           (skip)           (REQUIRED)          │
│                                                             │
│   message_end:                                               │
│     - Extract PII from finalized message                    │
│     - Perform 4-way OpenFGA authorization check             │
│     - Mask if any check fails                              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
Output delivered to user
```

### Legend
- `(REQUIRED)` = Strictly required for PII checks
- `(opt)` = Optional, not needed for basic PII filtering
- `(debug only)` = Useful for debugging but not required

---

## Key Differences: Input vs Output Checks

| Aspect | Input Direction | Output Direction |
|--------|-----------------|------------------|
| **Required events** | `before_agent_start` + `context` | `message_end` only |
| **Optional events** | `input`, `before_provider_request` | `message_update`, `tool_result` |
| **Content source** | User's prompt + history | Model's generated response |
| **Authorization** | Category/literal level via `can_view` | Sharing + lineage via 4-way check |
| **Failure behavior** | Mask before LLM sees | Mask before user sees |
| **Streaming support** | N/A (content complete before LLM call) | Full content at `message_end` |

---

## Required vs Optional Events Summary

| Direction | Strictly Required | Optional (Use When Needed) |
|-----------|-------------------|----------------------------|
| **Input (User → LLM)** | `before_agent_start`, `context` | `tool_result` (if tools reveal PII to LLM) |
| **Output (LLM → User)** | `message_end` | `tool_result` (if tool output goes to users/agents) |

---

## Current Implementation Status

Based on analysis of `index.ts`, `openfga.ts`, and `privacy-auth.ts`:

### Input Direction (User → LLM) ✅ CORRECTLY IMPLEMENTED

| Event | Status | Implementation Details |
|-------|--------|------------------------|
| `before_agent_start` | ✅ IMPLEMENTED | Detects PII, applies `buildDeniedCategoriesSet()` with `can_view` checks, masks prompt, injects system prompt |
| `context` | ✅ IMPLEMENTED | Scans user messages in history, applies same authorization, filters PII alert messages |
| `input` | ❌ NOT IMPLEMENTED | Not required - optional early interception |
| `before_provider_request` | ❌ NOT IMPLEMENTED | Not required - `before_agent_start` + `context` cover everything |

**Note**: Current implementation correctly uses only the required events.

### Output Direction (LLM → User) ❌ NOT IMPLEMENTED

| Event | Status | Implementation Details |
|-------|--------|------------------------|
| `message_end` | ❌ NOT IMPLEMENTED | **Primary hook - only event strictly required** |
| `tool_result` | ❌ NOT IMPLEMENTED | Optional - needed only if tool output goes to users/agents | |
| `message_update` | ❌ NOT IMPLEMENTED | Not required - `message_end` is sufficient |
| `tool_result` | ❌ NOT IMPLEMENTED | Not required for user-facing output |

**Available but Not Used:**
- `buildSharingDeniedCategoriesSet()` in `privacy-auth.ts` ✅ Ready
- `checkSharingAuthorization()` in `privacy-auth.ts` ✅ Ready
- `isSharingEnabled()` gating function ✅ Ready
- All OpenFGA tuple functions in `openfga.ts` ✅ Ready

### What's Missing for Output Direction

The extension has all necessary authorization functions but is missing only:

```typescript
// This single handler is all that's needed for output direction
pi.on("message_end", async (event, ctx) => {
  if (event.message.role !== "assistant") return;
  if (!isSharingEnabled()) return;
  
  const content = extractText(event.message.content);
  const results = await classifier(content, {...});
  const modelSubject = ctx.model?.id;
  const recipientId = getRecipientId();
  
  const deniedCategories = await buildSharingDeniedCategoriesSet(
    results, modelSubject, recipientId, { checkRecipientTrust: true }
  );
  
  const piiToMask = results.filter(r => deniedCategories.has(r.entity_group));
  if (piiToMask.length > 0) {
    return { message: { ...event.message, content: maskPII(content, piiToMask) } };
  }
});
```

### Code Location Reference

```
index.ts:
  ✅ before_agent_start handler - Input PII checks (current prompt)
  ✅ context handler - Input PII checks (history)
  ❌ message_end handler - MISSING (only event needed for output)

privacy-auth.ts:
  ✅ buildDeniedCategoriesSet() - Input direction (ready)
  ✅ buildSharingDeniedCategoriesSet() - Output direction (ready but not called)
  ✅ checkSharingAuthorization() - Per-entity sharing (ready but not called)
  ✅ isSharingEnabled() - Gating function (ready but not used)

openfga.ts:
  ✅ check() - Basic can_view checks
  ✅ checkShare() - 4-way sharing authorization
  ✅ hashLiteral() - Hash function for PII
  ✅ buildPIIInstanceId() - Build pii_instance object ID
```

---

## Recommendations

1. **Input direction** is correctly implemented with `before_agent_start` + `context`
2. **Add only `message_end` handler** to implement output direction - it's the only required event
3. **Don't need** `input` or `before_provider_request` for input direction
4. **Don't need** `message_start`, `message_update`, or `tool_result` for output direction
5. **Environment variables** `PRIVACY_FILTER_RECIPIENT_ID` and `PRIVACY_FILTER_SHARING_ENABLED` exist but need wiring to the new `message_end` handler

---

## See Also

- [Lifecycle Overview](./extensions.md#lifecycle-overview) - Original pi-mono events documentation
- [OpenFGA Model Tutorial](./openfga-model-tutorial.md) - Complete authorization model DSL
- [Proposal: Reverse PII Sharing Authorization](./proposal-reverse-pii-sharing-authorization.md)