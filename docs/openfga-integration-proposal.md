# OpenFGA Integration Proposal

## Overview

Integrate **OpenFGA** (Open Fine-Grained Authorization) as a REST API-driven authorization layer to control which PII categories the model can access. This adds a policy engine on top of the existing PII detection/masking.

---

## Conceptual Model

```
Subject:    mlx-community/MiniMax-M2.7-8bit  (the LLM model)
Relation:   can_view
Object:     privacy_category or privacy_category:literal_value
```

### Example Authorization Tuples

| Tuple | Meaning |
|-------|---------|
| `model:mlx-community/MiniMax-M2.7-8bit can_view privacy_category:email` | Model can view all emails |
| `model:mlx-community/MiniMax-M2.7-8bit can_view privacy_category:email:user@company.com` | Model can view this specific email |
| `model:mlx-community/MiniMax-M2.7-8bit can_view privacy_category:secret` | Model can view secrets (generally discouraged) |

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

type model
  relations
    define can_view: [privacy_category, privacy_category:literal]

type privacy_category
  relations
    define can_view: [model]

type privacy_category#literal
  relations
    define can_view: [model]
```

Alternatively, use a flat model without relations on `privacy_category`:

```python
model
  schema 1.1

type privacy_category
  relations
    define can_view: [model]

type privacy_category#literal
  relations
    define can_view: [model]
```

In this case, the authorization check uses `model` as the subject type directly.

---

## Proposed Code Changes

### 1. New file: `openfga.ts`

```typescript
// SPDX-License-Identifier: Apache-2.0

type OpenFGAClientConfig = {
  apiUrl: string;      // e.g., "http://localhost:8080"
  storeId: string;     // e.g., "privacy-policies"
  modelId: string;     // e.g., "privacy-model"
};

type CheckRequest = {
  subject: string;       // e.g., "mlx-community/MiniMax-M2.7-8bit"
  relation: string;      // e.g., "can_view"
  object: string;        // e.g., "email" or "email:user@company.com"
};

export class OpenFGAClient {
  constructor(private config: OpenFGAClientConfig) {}

  async check(request: CheckRequest): Promise<boolean> {
    const response = await fetch(
      `${this.config.apiUrl}/stores/${this.config.storeId}/check`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tuple_key: {
            user: `model:${request.subject}`,
            relation: request.relation,
            object: `privacy_category:${request.object}`,
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

  async writeTuples(tuples: Array<{ subject: string; relation: string; object: string }>): Promise<void> {
    await fetch(
      `${this.config.apiUrl}/stores/${this.config.storeId}/write`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          writes: {
            tuple_keys: tuples.map(t => ({
              user: `model:${t.subject}`,
              relation: t.relation,
              object: `privacy_category:${t.object}`,
            })),
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

const OPENFGA_API_URL = process.env.OPENFGA_API_URL || "http://localhost:8080";
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
const allowedCategories = new Set<string>();

for (const entity of results) {
  const category = entity.entity_group;           // e.g., "email"
  const literal = `${category}:${entity.word}`;   // e.g., "email:user@company.com"

  // Check both specific literal AND general category
  const canViewLiteral = await openfga.check({
    subject: MODEL_SUBJECT,
    relation: "can_view",
    object: literal,
  });

  const canViewCategory = await openfga.check({
    subject: MODEL_SUBJECT,
    relation: "can_view",
    object: category,
  });

  // Only mask if NOT authorized
  if (!canViewLiteral && !canViewCategory) {
    allowedCategories.add(category);
  }
}

// Mask PII categories that are NOT authorized
const maskedText = maskPII(text, results.filter(r => allowedCategories.has(r.entity_group)));
```

### 3. Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENFGA_API_URL` | `http://localhost:8080` | OpenFGA REST API URL |
| `OPENFGA_STORE_ID` | `privacy-policies` | OpenFGA store ID |
| `OPENFGA_MODEL_ID` | `privacy-model` | Authorization model ID |
| `PRIVACY_FILTER_MODEL_SUBJECT` | `mlx-community/MiniMax-M2.7-8bit` | Model subject ID for authorization |

---

## REST API Endpoints (OpenFGA)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/stores/{storeId}/check` | Check if model can view a category |
| `POST` | `/stores/{storeId}/write` | Add/remove authorization tuples |
| `POST` | `/stores/{storeId}/read` | Read current tuples |
| `GET` | `/stores/{storeId}` | Store info |

---

## Workflow Example

### Step 1: Admin writes authorization tuples

```bash
curl -X POST http://localhost:8080/stores/privacy-policies/write \
  -H "Content-Type: application/json" \
  -d '{
    "writes": {
      "tuple_keys": [
        {"user": "model:mlx-community/MiniMax-M2.7-8bit", "relation": "can_view", "object": "privacy_category:email"},
        {"user": "model:mlx-community/MiniMax-M2.7-8bit", "relation": "can_view", "object": "privacy_category:email:admin@company.com"}
      ]
    }
  }'
```

### Step 2: User sends prompt with PII

```
"Please summarize the emails from admin@company.com and user@company.com"
```

### Step 3: Extension queries OpenFGA for each detected PII

| PII Entity | OpenFGA Check | Result |
|------------|---------------|--------|
| `admin@company.com` (email) | `check(model:mlx-community/MiniMax-M2.7-8bit, can_view, privacy_category:email:admin@company.com)` | **allowed** → not masked |
| `user@company.com` (email) | `check(model:mlx-community/MiniMax-M2.7-8bit, can_view, privacy_category:email:user@company.com)` | **denied** → masked as `[EMAIL REDACTED]` |

### Step 4: Prompt to model after masking

```
"Please summarize the emails from admin@company.com and [EMAIL REDACTED]"
```

---

## Implementation Order

1. Create `openfga.ts` client class with REST API calls
2. Modify `index.ts` to integrate OpenFGA checks after PII detection
3. Add environment variables to README documentation
4. Add `docker-compose.yaml` for local OpenFGA development
5. Write unit tests with a mock OpenFGA server (e.g., using MSW or a simple test server)

---

## Alternative: Direct Object Notation

If using OpenFGA's object type notation with `#literal` relation:

```typescript
// Check for specific literal value
await openfga.check({
  subject: MODEL_SUBJECT,
  relation: "can_view",
  object: "email#literal:user@company.com",  // Note the #literal syntax
});
```

This requires the model to define:

```python
type privacy_category
  relations
    define can_view: [model]
    define literal(name: string): [model]
```

Note: This requires OpenFGA's typed tuples which have specific syntax. The flat approach with `privacy_category:email:user@company.com` is simpler to implement and debug.

---

## Security Considerations

1. **Default deny**: If OpenFGA is unavailable or returns an error, the extension should default to masking all PII (fail-closed).
2. **Store validation**: Validate `storeId` and `modelId` match expected values.
3. **Network isolation**: OpenFGA server should run in a trusted network segment.
4. **Audit logging**: Consider logging all authorization decisions for compliance.