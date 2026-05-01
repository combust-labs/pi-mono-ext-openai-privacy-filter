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

- **Category** is stored as a plain string (e.g., `email`, `secret`) since it is not sensitive metadata.
- **Specific literals** (e.g., `user@company.com`) are **never** stored in the policy engine. Instead, a SHA256 hash of the literal is used as the object identifier.
- This prevents the authorization policy from leaking or inadvertently logging sensitive PII values.

### Example Authorization Tuples

| Tuple | Meaning |
|-------|---------|
| `model:mlx-community/MiniMax-M2.7-8bit can_view privacy_category:email` | Model can view all emails (category-level) |
| `model:mlx-community/MiniMax-M2.7-8bit can_view privacy_category:sha256:3f2e8d7c4b1a` | Model can view the specific email whose SHA256 is `3f2e8d7c4b1a` |
| `model:mlx-community/MiniMax-M2.7-8bit can_view privacy_category:secret` | Model can view secrets (generally discouraged) |

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

type model
  relations
    define can_view: [privacy_category]

type privacy_category
  relations
    define can_view: [model]
```

> **Note**: The object portion of a tuple uses `privacy_category:<category>` for category-level checks and `privacy_category:sha256:<hash>` for specific literal checks. The SHA256 hash is stored directly in the object ID — no special relation type is needed.

---

## Proposed Code Changes

### 1. New file: `openfga.ts`

```typescript
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'crypto';

type OpenFGAClientConfig = {
  apiUrl: string;      // e.g., "http://localhost:8080"
  storeId: string;     // e.g., "privacy-policies"
  modelId: string;     // e.g., "privacy-model"
};

type CheckRequest = {
  subject: string;       // e.g., "mlx-community/MiniMax-M2.7-8bit"
  relation: string;      // e.g., "can_view"
  object: string;        // e.g., "email" or "sha256:3f2e8d7c4b1a..."
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
      objectId = `privacy_category:sha256:${hashLiteral(request.literal)}`;
    } else if (request.object.startsWith('sha256:')) {
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
            user: `model:${request.subject}`,
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
                objectId = `privacy_category:sha256:${hashLiteral(t.literal)}`;
              } else {
                objectId = `privacy_category:${t.object}`;
              }
              return {
                user: `model:${t.subject}`,
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
const deniedCategories = new Set<string>();

for (const entity of results) {
  const category = entity.entity_group;    // e.g., "email"
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
| `OPENFGA_API_URL` | `http://localhost:8080` | OpenFGA REST API URL |
| `OPENFGA_STORE_ID` | `privacy-policies` | OpenFGA store ID |
| `OPENFGA_MODEL_ID` | `privacy-model` | Authorization model ID |
| `PRIVACY_FILTER_MODEL_SUBJECT` | `mlx-community/MiniMax-M2.7-8bit` | Model subject ID for authorization |

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

curl -X POST http://localhost:8080/stores/privacy-policies/write \
  -H "Content-Type: application/json" \
  -d '{
    "writes": {
      "tuple_keys": [
        {"user": "model:mlx-community/MiniMax-M2.7-8bit", "relation": "can_view", "object": "privacy_category:email"},
        {"user": "model:mlx-community/MiniMax-M2.7-8bit", "relation": "can_view", "object": "privacy_category:sha256:3f2e8d7c4b1a9f0e2d6c8b4a1f3e2d9c8b4a1f3e"}
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
| `admin@company.com` (email) | `3f2e8d7c4b1a...` | `check(model:mlx-community/MiniMax-M2.7-8bit, can_view, privacy_category:sha256:3f2e8d7c4b1a...)` | **allowed** → not masked |
| `user@company.com` (email) | `7c8b4a1f3e2d...` | `check(model:mlx-community/MiniMax-M2.7-8bit, can_view, privacy_category:sha256:7c8b4a1f3e2d...)` | **denied** → masked as `[EMAIL REDACTED]` |

The category-level check (`privacy_category:email`) is also performed as a fallback — if the model has category-level access, any literal under that category is allowed.

### Step 4: Prompt to model after masking

```
"Please summarize the emails from admin@company.com and [EMAIL REDACTED]"
```

---

## Implementation Order

1. Create `openfga.ts` client class with REST API calls and SHA256 hashing
2. Modify `index.ts` to integrate OpenFGA checks after PII detection
3. Add environment variables to README documentation
4. Add `docker-compose.yaml` for local OpenFGA development
5. Write unit tests with a mock OpenFGA server (e.g., using MSW or a simple test server)

---

## Security Considerations

1. **Default deny**: If OpenFGA is unavailable or returns an error, the extension should default to masking all PII (fail-closed).
2. **No raw literals in policy engine**: Specific PII values are hashed before being sent to OpenFGA. The authorization store never contains plaintext PII.
3. **Store validation**: Validate `storeId` and `modelId` match expected values.
4. **Network isolation**: OpenFGA server should run in a trusted network segment.
5. **Audit logging**: Consider logging all authorization decisions for compliance.
6. **Collision resistance**: SHA256 truncation (40 chars) maintains strong collision resistance for the intended use case.