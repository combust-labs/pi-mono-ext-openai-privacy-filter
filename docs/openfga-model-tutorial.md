# OpenFGA Authorization Model Tutorial

This document provides a comprehensive tutorial on the OpenFGA authorization model used by the Privacy Filter extension, covering both **input direction** (viewing) and **output direction** (sharing) use cases.

## Table of Contents

1. [Overview](#overview)
2. [Authorization Model Types](#authorization-model-types)
3. [Input Direction: Viewing PII](#input-direction-viewing-pii)
4. [Output Direction: Sharing PII](#output-direction-sharing-pii)
5. [Key OpenFGA Insights](#key-openfga-insights)
6. [Tuple Direction Cheat Sheet](#tuple-direction-cheat-sheet)

---

## Overview

The Privacy Filter extension uses OpenFGA to authorization control two directions of PII flow:

1. **Input Direction**: Can a model **view** (receive as input) specific PII?
2. **Output Direction**: Can a model **share** (output) specific PII to specific recipients?

The authorization model is defined in `scripts/openfga-init.sh` and uses OpenFGA schema version 1.1.

---

## Authorization Model Types

The v2 authorization model defines four types:

| Type | Description | Example |
|------|-------------|---------|
| `model_instance` | An AI model or agent | `model_instance:mlx-community/MiniMax-M2.7-8bit` |
| `pii_instance` | A specific PII occurrence (SHA256 hash) | `pii_instance:sha256-f660ab912ec121d1b1e928a0bb4bc61b15f5ad44` |
| `category` | A PII category | `category:private_email` |
| `recipient` | A user/harness/agent that can receive PII | `recipient:user:alice` |

---

## Input Direction: Viewing PII

### Use Case

When a user prompt contains PII, the extension checks if the model is authorized to **view** (receive as input) that PII.

### Authorization Flow

```
User Prompt with PII → Extension checks OpenFGA → Model authorized?
                                                    ↓
                              No ──→ Mask PII ──→ Continue
                              │
                             Yes ──→ Keep PII ──→ Continue
```

### Relations Used

| Relation | Definition Location | Meaning |
|----------|---------------------|---------|
| `can_view` | `model_instance` | `model_instance --can_view--> pii_instance` or `category` |
| `can_view` | `pii_instance` | `pii_instance --can_view--> recipient` |

### Example Authorization Checks

**Check 1: Can model view a PII category?**
```
check(model_instance:mlx-community/MiniMax-M2.7-8bit, can_view, category:private_email)
```
- Tuple: `model_instance:mlx-community/MiniMax-M2.7-8bit#can_view@category:private_email`
- Meaning: Model is authorized to view all emails

**Check 2: Can model view a specific PII instance?**
```
check(model_instance:mlx-community/MiniMax-M2.7-8bit, can_view, pii_instance:sha256-abc123)
```
- Tuple: `model_instance:mlx-community/MiniMax-M2.7-8bit#can_view@pii_instance:sha256-abc123`
- Meaning: Model is authorized to view this specific email instance

### Tuple Commands for Input Direction

```bash
# Grant category-level access (model can view all emails)
./scripts/openfga-tuple.sh grant-view "mlx-community/MiniMax-M2.7-8bit" private_email

# Grant specific instance access (model can view a specific PII)
./scripts/openfga-tuple.sh grant-view "mlx-community/MiniMax-M2.7-8bit" "sha256-abc123"

# Revoke access
./scripts/openfga-tuple.sh revoke-view "mlx-community/MiniMax-M2.7-8bit" private_email
```

---

## Output Direction: Sharing PII

### Use Case

When a model's output contains PII, the extension checks if the model is authorized to **share** (output) that PII to a specific recipient, with lineage verification.

### Authorization Flow

```
Model Output with PII → Extension checks OpenFGA → All 4 checks pass?
                                                    ↓
                              No ──→ Mask PII ──→ Continue
                              │
                             Yes ──→ Keep PII ──→ Continue
```

### The Four Checks

For sharing to be allowed, ALL four conditions must be true:

| # | Check | Relation | Meaning |
|---|-------|----------|---------|
| 1 | `model --can_share--> pii` | `can_share` | Model is authorized to share this PII |
| 2 | `pii --lineage--> model` | `lineage` | PII originated from this model (not leaked from elsewhere) |
| 3 | `recipient --can_view--> pii` | `can_view` | Recipient is allowed to view this PII |
| 4 | `recipient --can_receive_from--> model` | `can_receive_from` | Recipient trusts this model |

### Relations Used

| Relation | Definition Location | Allowed User Types |
|----------|---------------------|-------------------|
| `can_share` | `pii_instance` | `model_instance` |
| `lineage` | `pii_instance` | `pii_instance` (self-reference for cross-type checks) |
| `lineage` | `model_instance` | `pii_instance` (needed for cross-type checks) |
| `can_view` | `pii_instance` | `recipient`, `pii_instance` |
| `can_view` | `recipient` | `pii_instance`, `recipient` |
| `can_receive_from` | `model_instance` | `recipient` |
| `can_receive_from` | `recipient` | `model_instance` |

### Example Authorization Checks

**Check 1: Can model share this PII?**
```
check(model_instance:support-bot, can_share, pii_instance:sha256-abc123)
```
- Tuple: `model_instance:support-bot#can_share@pii_instance:sha256-abc123`

**Check 2: Does PII have lineage to model?**
```
check(pii_instance:sha256-abc123, lineage, model_instance:support-bot)
```
- Tuple: `pii_instance:sha256-abc123#lineage@model_instance:support-bot`

**Check 3: Can recipient view this PII?**
```
check(recipient:alice, can_view, pii_instance:sha256-abc123)
```
- Tuple: `recipient:alice#can_view@pii_instance:sha256-abc123`

**Check 4: Does recipient trust this model?**
```
check(recipient:alice, can_receive_from, model_instance:support-bot)
```
- Tuple: `recipient:alice#can_receive_from@model_instance:support-bot`

### Tuple Commands for Output Direction

```bash
# 1. Grant model sharing access to a PII instance
./scripts/openfga-tuple.sh grant-share "support-bot" "sha256-abc123"

# 2. Set lineage (this PII originated from the model)
./scripts/openfga-tuple.sh set-lineage "sha256-abc123" "support-bot"

# 3. Grant recipient access to view this PII
./scripts/openfga-tuple.sh grant-view-to-recipient "sha256-abc123" "user:alice"

# 4. Establish trust (recipient trusts this model)
./scripts/openfga-tuple.sh grant-trust "user:alice" "support-bot"
```

### Environment Variables for Sharing

| Variable | Description |
|----------|-------------|
| `PRIVACY_FILTER_RECIPIENT_ID` | Current recipient (e.g., `user:alice`) |
| `PRIVACY_FILTER_SHARING_ENABLED` | Set to `true` to enable sharing checks |

---

## Key OpenFGA Insights

### 1. Relation Directionality

For a check `check(user, relation, object)`:
- The `relation` must be defined on `type(object)`
- The `user` must be in `directly_related_user_types` for that relation

**Example**: `check(recipient:alice, can_view, pii_instance:xxx)`
- `can_view` is on `pii_instance` type
- Therefore `recipient` must be in `directly_related_user_types` for `pii_instance.can_view`

### 2. Cross-Type Tuple Reversal

OpenFGA may reverse tuples when writing cross-type relations:
- Write: `pii_instance:sha256-xxx#lineage@model_instance:support-bot`
- OpenFGA may interpret as: `model_instance:support-bot#lineage@pii_instance:sha256-xxx`

**Solution**: Define the relation on BOTH types with appropriate `directly_related_user_types`.

### 3. The `lineage` Relation Name

We renamed from `originates_from` to `lineage` because:
- Relations ending in `_from` have special handling in OpenFGA
- This caused unexpected tuple reversals
- `lineage` works correctly for cross-type references

### 4. Self-Referential User Types

For cross-type checks to work, you may need self-reference in `directly_related_user_types`:
```json
{
  "type": "pii_instance",
  "relations": {
    "can_view": {
      "metadata": {
        "directly_related_user_types": [
          { "type": "recipient" },
          { "type": "pii_instance" }
        ]
      }
    }
  }
}
```

This allows both `recipient#can_view@pii_instance` and `pii_instance#can_view@pii_instance` to work.

---

## Tuple Direction Cheat Sheet

### Input Direction (Viewing)

| Check | Write Tuple | Relation On |
|-------|-------------|-------------|
| model can view category | `model_instance:M#can_view@category:C` | `category` |
| model can view pii | `model_instance:M#can_view@pii_instance:P` | `pii_instance` |

### Output Direction (Sharing)

| Check | Write Tuple | Relation On |
|-------|-------------|-------------|
| model can share pii | `model_instance:M#can_share@pii_instance:P` | `pii_instance` |
| pii lineage to model | `pii_instance:P#lineage@model_instance:M` | Both types |
| recipient can view pii | `recipient:R#can_view@pii_instance:P` | `recipient` + `pii_instance` |
| recipient trusts model | `recipient:R#can_receive_from@model_instance:M` | `recipient` + `model_instance` |

### Category Definitions

| Check | Write Tuple | Relation On |
|-------|-------------|-------------|
| category defines model | `category:C#defines@model_instance:M` | `model_instance` |

---

## Complete Authorization Model (DSL)

Below is the complete OpenFGA authorization model in DSL format. This can be used with the FGA CLI to generate the JSON model.

```fga
model
  schema 1.1

# AI model or agent that can view/share PII
type model_instance
  relations
    define can_view: [pii_instance]
    define can_share: [pii_instance]
    define can_receive: [pii_instance]
    define can_receive_from: [recipient]
    define lineage: [pii_instance]

# A specific PII occurrence (identified by SHA256 hash of the literal)
type pii_instance
  relations
    define can_view: [recipient, pii_instance]
    define can_share: [model_instance]
    define can_receive: [model_instance]
    define lineage: [pii_instance]
    define category: [category]

# A user, harness, or agent that can receive PII
type recipient
  relations
    define can_receive: [pii_instance]
    define can_receive_from: [model_instance]
    define can_view: [pii_instance, recipient]

# A PII category (e.g., private_email, private_phone)
type category
  relations
    define defines: [model_instance]
```

### Model Explanation

#### Type: model_instance
| Relation | Allowed Users | Purpose |
|----------|---------------|---------|
| `can_view` | `pii_instance` | Check if model can view PII (input direction) |
| `can_share` | `pii_instance` | Check if model is authorized to share PII |
| `can_receive` | `pii_instance` | Check if model can receive PII |
| `can_receive_from` | `recipient` | Check if model is trusted by recipient |
| `lineage` | `pii_instance` | For cross-type lineage checks |

#### Type: pii_instance
| Relation | Allowed Users | Purpose |
|----------|---------------|---------|
| `can_view` | `recipient`, `pii_instance` | Who can view this PII |
| `can_share` | `model_instance` | Who can share this PII |
| `can_receive` | `model_instance` | Who can receive this PII |
| `lineage` | `pii_instance` | Self-reference for cross-type checks |
| `category` | `category` | Category of this PII |

#### Type: recipient
| Relation | Allowed Users | Purpose |
|----------|---------------|---------|
| `can_receive` | `pii_instance` | What PII recipient can receive |
| `can_receive_from` | `model_instance` | Which models recipient trusts |
| `can_view` | `pii_instance`, `recipient` | What PII recipient can view |

#### Type: category
| Relation | Allowed Users | Purpose |
|----------|---------------|---------|
| `defines` | `model_instance` | Which models produce this category |

### Generating JSON from DSL

If you need the JSON representation, use the FGA CLI:

```bash
fga model transform --file=model.fga
```

Or use the API endpoint directly as shown in `scripts/openfga-init.sh`.

---

## Complete Example

### Scenario

Model `support-bot` wants to share PII instance `sha256-abc123` to recipient `user:alice`.

### Setup Commands

```bash
# 1. Grant sharing permission
./scripts/openfga-tuple.sh grant-share "support-bot" "sha256-abc123"

# 2. Set lineage
./scripts/openfga-tuple.sh set-lineage "sha256-abc123" "support-bot"

# 3. Grant recipient view permission
./scripts/openfga-tuple.sh grant-view-to-recipient "sha256-abc123" "user:alice"

# 4. Establish trust
./scripts/openfga-tuple.sh grant-trust "user:alice" "support-bot"
```

### Environment

```bash
export PRIVACY_FILTER_SHARING_ENABLED=true
export PRIVACY_FILTER_RECIPIENT_ID=user:alice
```

### What Happens

1. Model outputs text containing PII
2. Extension extracts PII and computes hash: `sha256-abc123`
3. Extension performs 4 OpenFGA checks:
   - `check(model_instance:support-bot, can_share, pii_instance:sha256-abc123)` → ALLOWED
   - `check(pii_instance:sha256-abc123, lineage, model_instance:support-bot)` → ALLOWED
   - `check(recipient:user:alice, can_view, pii_instance:sha256-abc123)` → ALLOWED
   - `check(recipient:user:alice, can_receive_from, model_instance:support-bot)` → ALLOWED
4. All checks pass → PII is kept in output (not masked)

If any check fails → PII is masked.

---

## See Also

- [Proposal: Reverse PII Sharing Authorization](./proposal-reverse-pii-sharing-authorization.md)
- [OpenFGA Documentation](https://openfga.dev/docs)
- [OpenFGA Modeling Getting Started](https://openfga.dev/docs/modeling/getting-started)
- OpenFGA schema 1.1 specification