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

## Direction 1: Input Direction (User → LLM)

**Purpose**: Detect and mask/control PII in what the user sends to the model.

### Lifecycle Events for Input Direction

| Event | Purpose |
|-------|---------|
| `input` | Raw user input received - can intercept/transform |
| `before_agent_start` | User prompt + system prompt - can inject messages |
| `context` | Messages array before each LLM call - can modify/filter |
| `before_provider_request` | Full API payload - can inspect/replace |

### PII Check Points (Input)

1. **`input` event**: 
   - First opportunity to see user input
   - Can transform or block before any processing
   - Example: `if (event.text.includes("secret")) return { block: true }`

2. **`before_agent_start` event**:
   - User prompt is available at `event.prompt`
   - Can inject additional context/messages
   - System prompt can be modified via `event.systemPrompt`

3. **`context` event**:
   - Messages array (`event.messages`) is mutable
   - Can filter out messages with PII before LLM call
   - Deep copy - safe to modify

4. **`before_provider_request` event**:
   - Final payload before sending to LLM
   - Can inspect full message structure
   - Can replace payload entirely if needed

### Implementation Pattern (Input)

```typescript
pi.on("context", async (event, ctx) => {
  const filtered = event.messages.map(msg => {
    if (msg.role === "user") {
      return {
        ...msg,
        content: maskPII(msg.content)
      };
    }
    return msg;
  });
  return { messages: filtered };
});
```

---

## Direction 2: Output Direction (LLM → User)

**Purpose**: Detect and mask/control PII in what the model generates (shared output).

### Lifecycle Events for Output Direction

| Event | Purpose |
|-------|---------|
| `message_start` | Assistant message begins - can inspect initial structure |
| `message_update` | Token-by-token streaming - can catch PII as it appears |
| `message_end` | Finalized message - can replace/modify before delivery |
| `tool_result` | Tool execution results - can modify before LLM sees them |

### PII Check Points (Output)

1. **`message_start` event**:
   - Assistant message begins
   - Role is `"assistant"`
   - Early hook before any content is generated

2. **`message_update` event**:
   - Token-by-token streaming updates
   - `event.assistantMessageEvent` contains stream data
   - Can detect PII as it streams in

3. **`message_end` event** (most reliable for output checks):
   - Message is finalized
   - Full content available at `event.message.content`
   - Can replace the message entirely via return value
   - **This is the primary hook for output PII checks**

4. **`tool_result` event**:
   - Tool results returned to LLM
   - Can modify results before LLM processes them
   - Useful if model-generated content comes through tools

### Implementation Pattern (Output)

```typescript
pi.on("message_end", async (event, ctx) => {
  if (event.message.role !== "assistant") return;
  
  const content = event.message.content;
  const masked = maskPII(content);
  
  if (masked !== content) {
    return {
      message: {
        ...event.message,
        content: masked
      }
    };
  }
});
```

---

## Complete 4-Way Check Model

Based on the Privacy Filter extension's sharing authorization feature, a complete PII control system requires checking in all four directions:

### Direction Matrix

| Direction | Source | Target | Check Point | Purpose |
|-----------|--------|--------|-------------|---------|
| **Input** | User | LLM | `context`, `before_provider_request` | Control what model sees |
| **Output** | LLM | User | `message_end` | Control what user receives |
| **Tool Input** | LLM | Tool | `tool_call` | Control tool execution |
| **Tool Output** | Tool | LLM | `tool_result` | Control tool results returned |

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
│                           │                                 │
│                     (can detect PII                        │
│                      as it streams)                        │
│                                                             │
│   If sharing enabled:                                       │
│     - Extract PII from finalized message                    │
│     - Perform 4-way OpenFGA authorization check             │
│     - Mask if any check fails                              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
Output delivered to user
```

---

## Key Differences: Input vs Output Checks

| Aspect | Input Direction | Output Direction |
|--------|-----------------|------------------|
| **Primary event** | `context` | `message_end` |
| **Content source** | User's prompt + history | Model's generated response |
| **Authorization** | Category/literal level | Sharing + lineage required |
| **OpenFGA checks** | `can_view` | `can_share` + `lineage` + `can_view` + `can_receive_from` |
| **Failure behavior** | Mask before LLM sees | Mask before user sees |
| **Streaming support** | N/A (content complete before LLM call) | `message_update` can catch PII as it streams |

---

## Recommendations

1. **Input checks** should use `context` event for filtering messages before LLM call
2. **Output checks** should use `message_end` event for final content validation
3. **For streaming output**, consider `message_update` for early PII detection but be aware content is incomplete
4. **OpenFGA authorization** for output direction requires the 4-check model (can_share, lineage, recipient_can_view, recipient_trusts)
5. **Environment variables** `PRIVACY_FILTER_RECIPIENT_ID` and `PRIVACY_FILTER_SHARING_ENABLED` control output direction behavior

---

## See Also

- [Lifecycle Overview](./extensions.md#lifecycle-overview) - Original pi-mono events documentation
- [OpenFGA Model Tutorial](./openfga-model-tutorial.md) - Complete authorization model DSL
- [Proposal: Reverse PII Sharing Authorization](./proposal-reverse-pii-sharing-authorization.md)