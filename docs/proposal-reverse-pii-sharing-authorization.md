# Proposal: Reverse PII Sharing Authorization

> **Note:** This proposal was **implemented** and extended using the
> [PII Check Directions Analysis](../docs/pii-check-directions-analysis.md) document
> (which introduced the input/output direction model superseding this proposal's
> forward/reverse framing). See `feature/official-openfga-sdk` for the full
> implementation.

---

## 1. Summary

This proposal adds a **reverse authorization relationship** to the Privacy Filter extension, complementing the existing "model can view PII" check. The new relationship controls whether a model is authorized to **share (output) PII** to a specific recipient (user, harness, or agent).

| Direction | Subject | Relation | Object | Purpose |
|-----------|---------|----------|--------|---------|
| Forward (existing) | `model_instance:<model-id>` | `can_view` | `privacy_category:<category>` | Controls what PII the model can see in prompts |
| Reverse (proposed) | `model_instance:<model-id>` | `can_share` | `recipient:<recipient-id>` | Controls what PII the model can share with recipients |

---

## 2. Background

### 2.1 Current Authorization Model

The current OpenFGA authorization model implements a **one-directional consumption check**:

```
model_instance:<model-id> --can_view--> privacy_category:<category>
model_instance:<model-id> --can_view--> privacy_category:sha256-<hash>
```

Flow:
1. User sends a prompt containing PII (e.g., `user@company.com`)
2. Extension detects the PII entity and its category (`private_email`)
3. Extension queries OpenFGA: "can this model view this category/literal?"
4. If **allowed**: PII passes through unmasked to the model
5. If **denied** or OpenFGA unavailable: PII is masked before being sent to the model

This model controls the **input direction** (prompt → model).

### 2.2 Gap: Output Direction (Model → Recipient)

There is no equivalent control for the **output direction** (model → recipient). When a model generates responses that contain PII (e.g., summarizing an email, generating personalized content), the extension currently has no mechanism to authorize or deny this sharing.

Example scenarios requiring output authorization:

| Scenario | Model Input | Model Output | Concern |
|----------|-------------|--------------|---------|
| Email summarization | Email body with `user@company.com` | "The email was from user@company.com" | Model shares sender's email |
| Customer support | Customer name and phone | "I'll call 555-1234 tomorrow" | Model exposes phone number |
| Report generation | PII in context | Full PII in generated report | Model outputs sensitive data |
| RAG with sensitive docs | Retrieved context contains PII | Generated answer includes PII | Model leaks retrieved PII |

### 2.3 OpenFGA Agents-as-Principals Pattern

The [OpenFGA agents-as-principals](https://openfga.dev/docs/modeling/agents/agents-as-principals) pattern demonstrates that agents can be modeled as first-class principals alongside users, participating in the same relation structures.

For the reverse relationship, we apply the same pattern but **inverted**:
- Instead of the agent (model) being the subject that receives permissions on domain resources (privacy categories), we make the **recipient** (user/harness/agent) the object that the model can share PII with.
- This is analogous to the pattern where `agent:triage-bot` receives `member` permissions on `project:alpha`.

---

## 3. Proposed Authorization Model

### 3.1 New Types and Relations

Add two new types to the authorization model:

```python
model
  schema 1.1

type model_instance
  relations
    define can_view: [privacy_category]
    define can_share: [recipient]  # NEW: models can share PII with recipients

type privacy_category
  relations
    define can_view: [model_instance]

type recipient  # NEW: represents a user, harness, or agent
  relations
    define can_receive: [model_instance]  # inverse of can_share
```

### 3.2 Tuple Examples

```json
{
  "writes": {
    "tuple_keys": [
      {"user": "model_instance:mlx-community/MiniMax-M2.7-8bit", "relation": "can_share", "object": "recipient:user:alice"},
      {"user": "model_instance:mlx-community/MiniMax-M2.7-8bit", "relation": "can_share", "object": "recipient:agent:support-bot"},
      {"user": "model_instance:gpt-4o", "relation": "can_share", "object": "recipient:harness:prod-evaluation"}
    ]
  }
}
```

### 3.3 Alternative: Category-Scoped Sharing

For more granular control, sharing can be scoped to specific PII categories:

```python
type model_instance
  relations
    define can_view: [privacy_category]
    define can_share_email: [recipient]      # can share emails with recipient
    define can_share_phone: [recipient]      # can share phone numbers with recipient
    define can_share_address: [recipient]    # can share addresses with recipient
    # ... per-category relations
```

This approach adds complexity but matches the granularity of the existing `can_view` checks.

---

## 4. Implementation Plan

### 4.1 Authorization Model Changes

1. **Add `recipient` type** to the OpenFGA authorization model
2. **Add `can_share` relation** to `model_instance`
3. **Add `can_receive` relation** to `recipient` (inverse, for query flexibility)

### 4.2 Extension Code Changes

#### New Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PRIVACY_FILTER_RECIPIENT_ID` | _(empty)_ | The current recipient ID (user/harness/agent) for sharing checks |
| `PRIVACY_FILTER_SHARING_ENABLED` | `false` | Enable reverse (output) PII checking |

#### New Functions in `openfga.ts`

```typescript
export type ShareCheckRequest = {
  subject: string;       // e.g., "mlx-community/MiniMax-M2.7-8bit"
  relation: string;      // e.g., "can_share"
  recipient: string;     // e.g., "user:alice", "harness:prod", "agent:support-bot"
  category?: string;     // Optional: check sharing for specific category only
  literal?: string;      // Optional: check sharing for specific literal only
};

async checkShare(request: ShareCheckRequest): Promise<boolean>;
```

#### New Function in `privacy-auth.ts`

```typescript
export type SharingDecision = {
  category: string;
  allowed: boolean;
  level: 'category' | 'literal';
};

/**
 * Build the set of PII categories that should be blocked from sharing.
 * A category is blocked when the model is NOT authorized to share it
 * with the current recipient, or when OpenFGA is unavailable (fail-closed).
 */
export async function buildSharingDeniedCategoriesSet(
  results: AggregatedAnnotation[],
  modelSubject: string,
  recipientId: string,
): Promise<Set<string>>;
```

### 4.3 New Chat Commands

| Command | Description |
|---------|-------------|
| `/check-pii-share <text>` | Scan text for PII and check if the model can share each entity with the current recipient |
| `/check-pii-share-auth <text>` | Scan text for PII, check sharing authorization, and show per-entity ALLOWED/MASKED status |

### 4.4 Updated Scripts

#### `openfga-init.sh` - Updated Authorization Model

```bash
create_model() {
    # ... existing code ...
    response=$(curl -sf -X POST "${OPENFGA_API_URL}/stores/${STORE_ID}/authorization-models" \
        -H "Content-Type: application/json" \
        -d '{
            "schema_version": "1.1",
            "type_definitions": [
                {
                    "type": "model_instance",
                    "relations": {
                        "can_view": { "this": {} },
                        "can_share": { "this": {} }  # NEW
                    },
                    "metadata": {
                        "relations": {
                            "can_view": {
                                "directly_related_user_types": [{ "type": "model_instance" }]
                            },
                            "can_share": {
                                "directly_related_user_types": [{ "type": "recipient" }]  # NEW
                            }
                        }
                    }
                },
                {
                    "type": "privacy_category",
                    "relations": {
                        "can_view": { "this": {} }
                    },
                    "metadata": {
                        "relations": {
                            "can_view": {
                                "directly_related_user_types": [{ "type": "model_instance" }]
                            }
                        }
                    }
                },
                {  // NEW
                    "type": "recipient",
                    "relations": {
                        "can_receive": { "this": {} }
                    },
                    "metadata": {
                        "relations": {
                            "can_receive": {
                                "directly_related_user_types": [{ "type": "model_instance" }]
                            }
                        }
                    }
                }
            ]
        }')
}
```

#### `openfga-tuple.sh` - New Commands

```bash
# Grant sharing permission
./scripts/openfga-tuple.sh grant-share "mlx-community/MiniMax-M2.7-8bit" "user:alice"

# Revoke sharing permission
./scripts/openfga-tuple.sh revoke-share "mlx-community/MiniMax-M2.7-8bit" "user:alice"

# Check sharing permission
./scripts/openfga-tuple.sh check-share "mlx-community/MiniMax-M2.7-8bit" "user:alice"
```

---

## 5. Security Considerations

### 5.1 Fail-Closed Behavior

Similar to the existing `can_view` checks, when OpenFGA is unreachable during a sharing check, all PII sharing is denied (fail-closed). This ensures no PII leaks when the authorization server is unavailable.

### 5.2 Recipient Identification

The `recipient` ID must be derived from a trusted source. Suggested derivation:

| Source | Recipient ID Format | Example |
|--------|---------------------|---------|
| User identity from session | `user:<user-id>` | `user:alice` |
| Harness identifier | `harness:<harness-id>` | `harness:prod-evaluation` |
| Agent ID from pi-mono context | `agent:<agent-id>` | `agent:support-bot` |

The extension should derive the recipient ID from pi-mono's session context, not from user-provided input, to prevent authorization bypass via prompt injection.

### 5.3 Hashing for Literal-Level Sharing

For literal-level sharing checks, the PII literal should be hashed with SHA256 (same as `can_view`) to avoid sending raw PII to OpenFGA:

```typescript
// Check sharing for a specific literal
const canShareLiteral = await openfga.checkShare({
  subject: modelSubject,
  relation: "can_share",
  recipient: recipientId,
  literal: entity.word,  // Will be hashed before sending
});
```

---

## 6. Backward Compatibility

- The new authorization model adds new types and relations without modifying existing ones
- Existing `can_view` tuples and checks continue to work unchanged
- The new sharing checks are only active when `PRIVACY_FILTER_SHARING_ENABLED=true`
- Existing metrics and logging remain unchanged

---

## 7. Migration Strategy

1. **Phase 1**: Add new types/relations to OpenFGA model (non-breaking)
   - Run `./scripts/openfga-init.sh --reset` to update the authorization model
   - Existing tuples remain valid

2. **Phase 2**: Implement code changes in `openfga.ts`, `privacy-auth.ts`
   - Add `checkShare()` method
   - Add `buildSharingDeniedCategoriesSet()` function
   - Add new chat commands

3. **Phase 3**: Add recipient tuples via `./scripts/openfga-tuple.sh`
   ```bash
   ./scripts/openfga-tuple.sh grant-share "mlx-community/MiniMax-M2.7-8bit" "user:alice"
   ```

4. **Phase 4**: Enable sharing checks via environment variable
   ```bash
   PRIVACY_FILTER_SHARING_ENABLED=true \
   PRIVACY_FILTER_RECIPIENT_ID=user:alice \
   pi -e ./index.ts
   ```

---

## 8. Open Questions

1. **Should sharing be all-or-nothing per recipient, or per-category?**
   The per-category approach (`can_share_email`, `can_share_phone`) offers finer control but adds complexity. The all-or-nothing approach (`can_share`) is simpler but less granular.

2. **Should the extension support wildcards for recipients?**
   e.g., `model_instance:x --can_share--> recipient:user:*` to allow sharing with all users. OpenFGA does not support wildcards in the standard way, so this would need to be modeled differently (e.g., a group or organization type).

3. **Should there be a distinction between "sharing with user" and "sharing with agent/harness"?**
   The recipient type already supports this via prefixes, but the semantics of sharing with a human user vs. another AI agent may differ.

4. **How should the extension handle batch sharing checks for performance?**
   When multiple PII entities are detected in model output, many sharing checks may be needed. OpenFGA supports batch check endpoints that could be leveraged.

---

## 9. References

- [OpenFGA Agents as Principals](https://openfga.dev/docs/modeling/agents/agents-as-principals)
- [OpenFGA Task-Based Authorization](https://openfga.dev/docs/modeling/agents/task-based-authorization)
- [OpenFGA RAG Authorization](https://openfga.dev/docs/modeling/agents/rag-authorization)
- Existing `can_view` implementation in `openfga.ts` and `privacy-auth.ts`