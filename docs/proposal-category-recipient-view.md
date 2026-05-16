# Proposal: Support Category-Level Recipient View Grants

**Extension:** pi-mono-ext-privacy-filter
**Author:** mlx-community/MiniMax-M2.7-8bit
**Date:** 2026-05-15
**Status:** Draft

---

## 1. Summary

Currently `grant-view-to-recipient` only supports instance-level grants (per PII hash). This proposal adds support for **category-level recipient view grants** — allowing a recipient to receive all PII of a given category (e.g. `recipient:harness` can view all `private_email`).

This avoids the need to grant view permission for every individual PII instance and is the natural primitive for the harness use case, where the harness should be able to receive all output PII from a model.

---

## 2. Problem Statement

The sharing authorization flow requires `recipient --can_view--> pii_instance` to be true. At present the only way to grant this is with a per-instance (per-hash) tuple:

```bash
./scripts/openfga-tuple.sh grant-view-to-recipient "sha256-abc123" "recipient:harness"
```

This is impractical because:

- Each PII occurrence has a different SHA256 hash — a new tuple must be written for every detection event
- The extension would need to dynamically write these tuples at runtime, which adds latency and complexity
- The harness needs to receive **all** PII of a given category, not just specific instances

The natural solution is to allow `recipient --can_view--> category:private_email`, so all emails are visible to the recipient without per-instance grants.

---

## 3. Changes Required

### 3.1 OpenFGA Schema (`scripts/openfga-init.sh`)

Add `can_view` to the `category` type definition:

```json
{
  "type": "category",
  "relations": {
    "defines": { "this": {} },
    "can_view": { "this": {} }
  },
  "metadata": {
    "relations": {
      "defines": { "directly_related_user_types": [{ "type": "model_instance" }] },
      "can_view": { "directly_related_user_types": [{ "type": "recipient" }] }
    }
  }
}
```

This allows the check `check(recipient:harness, can_view, category:private_email)` to resolve via `category.can_view`.

**Migration note:** This is a backwards-compatible schema change. Existing tuples are unaffected. `can_view` on `category` is independent of `can_view` on `pii_instance` — OpenFGA resolves the relation on the object type.

---

### 3.2 SDK Wrapper (`src/openfga-sdk-wrapper.ts`)

Add a `checkRecipientCanViewCategory()` method to support category-level recipient checks:

```typescript
/**
 * Check if a recipient can view all PII of a given category.
 * Resolves check(recipient:R, can_view, category:C).
 */
async checkRecipientCanViewCategory(recipientId: string, category: string): Promise<boolean>
```

This is a simple single-check call (no 4-step sequence needed). It can be called from the sharing authorization path to short-circuit per-instance checks when a category-level recipient grant exists.

---

### 3.3 Tuple Script (`scripts/openfga-tuple.sh`)

Update `grant_view_to_recipient()` to detect whether the first argument is a `category:` prefix (or bare category name like `private_email`) and dispatch to the correct object type:

```bash
grant_view_to_recipient() {
    local target="$1"       # pii hash or category name
    local recipient_id="$2"

    # Auto-detect: if target starts with "category:" or is a known bare category
    # name, write category type; otherwise write pii_instance type
    local object_type
    case "${target}" in
        category:*|private_email|private_phone|private_address|private_url|private_date|private_person|account_number|secret)
            object_type="category"
            ;;
        *)
            object_type="pii_instance"
            ;;
    esac

    write_tuple "${recipient_id}" "recipient" "can_view" "${target}" "${object_type}"
}
```

A matching `revoke_view_from_recipient()` update would be symmetrical.

---

### 3.4 Extension Runtime (`privacy-auth.ts`)

In `buildSharingDeniedCategoriesSet()`, before performing per-instance sharing checks, first check if the recipient has category-level view permission. If `recipient --can_view--> category:C` is ALLOWED, skip all per-instance checks for that category.

This is an optimization: if the recipient can already view the category, individual instance checks are unnecessary.

---

## 4. New Tuple Examples

After implementation, these commands would all be valid:

```bash
# Allow harness to view all emails (category-level)
./scripts/openfga-tuple.sh grant-view-to-recipient "private_email" "recipient:harness"

# Allow harness to view all phone numbers
./scripts/openfga-tuple.sh grant-view-to-recipient "private_phone" "recipient:harness"

# Revoke category-level permission
./scripts/openfga-tuple.sh revoke-view-from-recipient "private_email" "recipient:harness"
```

---

## 5. Backwards Compatibility

- **Schema:** Adding a new relation to `category` is backwards-compatible. Existing tuples and checks are unaffected.
- **SDK:** New method is additive. Existing `checkShare()` behaviour is unchanged.
- **Scripts:** Auto-detection is backward-compatible. Existing `grant-view-to-recipient "sha256-abc123" "recipient:harness"` commands continue to work as before (object type will be `pii_instance`).
- **Runtime:** The category-level check is an optimization — it makes existing per-instance grants more efficient but does not change the result of any existing authorization decision.

---

## 6. Open Questions

1. Should the extension **write** category-level recipient tuples dynamically at runtime, or only support manually created tuples?
   - If dynamically written: when a new PII category is first detected in output, the extension could write `recipient:current --can_view--> category:that_category`.
   - This would require the extension to have write access to OpenFGA (currently it only reads).

2. Should `pii_instance --can_view--> recipient` and `category --can_view--> recipient` be mutually exclusive for a given recipient+category combination?

3. Should `buildSharingDeniedCategoriesSet()` also use category-level recipient checks as a **gate** — if the recipient can already view the category, skip both per-instance checks entirely (optimization)?

---

## 7. Checklist

- [ ] Add `can_view` relation to `category` type in `scripts/openfga-init.sh`
- [ ] Update `grant_view_to_recipient()` in `scripts/openfga-tuple.sh` to dispatch on object type
- [ ] Update `revoke_view_from_recipient()` in `scripts/openfga-tuple.sh` to dispatch on object type
- [ ] Add `checkRecipientCanViewCategory()` to `src/openfga-sdk-wrapper.ts`
- [ ] Update `buildSharingDeniedCategoriesSet()` in `privacy-auth.ts` to short-circuit on category-level recipient permission
- [ ] Add test for category-level recipient view grant
- [ ] Update `docs/openfga-model-tutorial.md` to reflect new capability

---

## 8. See Also

- [OpenFGA Authorization Model Tutorial](./openfga-model-tutorial.md)
- [OpenFGA Modeling: Object-to-Object Relationships](https://openfga.dev/docs/modeling/object-to-object-access)
- OpenFGA schema 1.1 specification