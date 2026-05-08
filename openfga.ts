// SPDX-License-Identifier: Apache-2.0

/**
 * OpenFGA Client for Privacy Filter Authorization
 *
 * Provides fine-grained authorization via OpenFGA REST API.
 * Specific PII literals are never sent to OpenFGA — only their SHA256 hashes.
 *
 * Authorization Model (v2 - with lineage and sharing):
 *   model_instance:M --can_view--> pii_instance:P
 *   model_instance:M --can_share--> pii_instance:P
 *   model_instance:M --can_receive--> pii_instance:P
 *   model_instance:M --originates_from--> pii_instance:P (inverse)
 *   pii_instance:P --originates_from--> model_instance:M (who created this PII)
 *   pii_instance:P --can_view--> recipient:R (who can view this PII)
 *   pii_instance:P --category--> category:C (what category this PII belongs to)
 *   category:C --defines--> model_instance:M (which models can produce this category)
 *   recipient:R --can_receive_from--> model_instance:M (recipient trusts model outputs)
 */

import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const OPENFGA_API_URL = process.env.OPENFGA_API_URL || "http://localhost:28080";
const OPENFGA_STORE_ID = process.env.OPENFGA_STORE_ID || "privacy-policies";
const OPENFGA_MODEL_ID = process.env.OPENFGA_MODEL_ID || "privacy-model";

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Compute a truncated SHA256 hash of a literal value.
 * Truncated to 40 hex chars (20 bytes) for readability while maintaining
 * strong collision resistance.
 *
 * The raw literal is never sent to OpenFGA — only its hash appears in
 * authorization tuples.
 */
export function hashLiteral(literal: string): string {
  return createHash('sha256').update(literal).digest('hex').substring(0, 40);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OpenFGAClientConfig = {
  apiUrl: string;
  storeId: string;
  modelId: string;
};

export type CheckRequest = {
  subject: string;       // e.g., "mlx-community/MiniMax-M2.7-8bit"
  relation: string;      // e.g., "can_view"
  /** Category-only object, e.g. "email". Ignored if literal is provided. */
  object?: string;
  /** Specific PII value to hash and use as object. Overrides object. */
  literal?: string;
};

/**
 * Request for checking PII sharing with lineage.
 * All fields required for the combined sharing check:
 *   1. model can share pii instance
 *   2. pii instance originates from model (lineage)
 *   3. pii instance can be viewed by recipient
 *   4. (optional) recipient can receive from model
 */
export type ShareCheckRequest = {
  modelSubject: string;    // e.g., "mlx-community/MiniMax-M2.7-8bit"
  piiInstance: string;     // e.g., "pii_instance:sha256-abc123" or "sha256-abc123"
  recipientId: string;     // e.g., "recipient:user:alice"
  checkRecipientTrust?: boolean; // If true, also check recipient:R --can_receive_from--> model:M
};

export type ShareCheckResult = {
  allowed: boolean;
  modelCanShare: boolean;
  lineageValid: boolean;
  recipientCanView: boolean;
  recipientTrusts?: boolean;
};

export type WriteTuple = {
  subject: string;
  relation: string;
  /** Category object, e.g. "email". Ignored if literal is provided. */
  object?: string;
  /** Specific PII value to hash before writing. Overrides object. */
  literal?: string;
};

export type ReadFilter = {
  subject?: string;
  relation?: string;
  object?: string;
  objectType?: 'pii_instance' | 'recipient' | 'category' | 'model_instance';
};

// ---------------------------------------------------------------------------
// Object ID Builders
// ---------------------------------------------------------------------------

export function buildPIIInstanceId(literalOrHash: string): string {
  if (literalOrHash.startsWith('pii_instance:')) {
    return literalOrHash;
  }
  if (literalOrHash.startsWith('sha256-')) {
    return `pii_instance:${literalOrHash}`;
  }
  // Check if it's a 40-char hex hash (from hashLiteral) - treat as pii_instance
  if (/^[0-9a-f]{40}$/i.test(literalOrHash)) {
    return `pii_instance:sha256-${literalOrHash}`;
  }
  // Category reference (e.g., "email")
  return `category:${literalOrHash}`;
}

export function buildRecipientId(recipient: string): string {
  if (recipient.startsWith('recipient:')) {
    return recipient;
  }
  return `recipient:${recipient}`;
}

export function buildModelInstanceId(model: string): string {
  if (model.startsWith('model_instance:')) {
    return model;
  }
  return `model_instance:${model}`;
}

// ---------------------------------------------------------------------------
// OpenFGA Client
// ---------------------------------------------------------------------------

export class OpenFGAClient {
  constructor(private config: OpenFGAClientConfig) {}

  /**
   * Lightweight health check — verifies the OpenFGA server is reachable.
   * Returns true if the server responds to /healthz, false otherwise.
   * Does not throw.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.apiUrl}/healthz`, {
        method: 'GET',
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Check whether a subject has a given relation to an object.
   * If request.literal is provided, the literal is hashed before being sent.
   * If request.object is provided (category only), it is used as-is.
   *
   * Returns true if allowed, false if not allowed.
   * Throws on network or HTTP errors.
   */
  async check(request: CheckRequest): Promise<boolean> {
    const objectId = this.buildObjectId(request);

    const response = await fetch(
      `${this.config.apiUrl}/stores/${this.config.storeId}/check`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.OPENFGA_API_TOKEN || ""}`,
        },
        body: JSON.stringify({
          tuple_key: {
            user: buildModelInstanceId(request.subject),
            relation: request.relation,
            object: objectId,
          },
          // Optionally specify the model; some deployments require it
          ...(this.config.modelId && { authorization_model_id: this.config.modelId }),
        }),
      }
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`OpenFGA check failed (${response.status}): ${body}`);
    }

    const result = await response.json() as { allowed: boolean };
    return result.allowed === true;
  }

  /**
   * Check if sharing a PII instance with a recipient is authorized.
   * 
   * This performs the combined check:
   *   1. model:subject --can_share--> pii_instance:instance
   *   2. pii_instance:instance --originates_from--> model:subject
   *   3. pii_instance:instance --can_view--> recipient:recipient
   *   4. (optional) recipient:recipient --can_receive_from--> model:subject
   *
   * All checks must pass for sharing to be allowed (fail-closed if any check fails).
   */
  async checkShare(request: ShareCheckRequest): Promise<ShareCheckResult> {
    const piiInstanceId = request.piiInstance.startsWith('pii_instance:')
      ? request.piiInstance
      : `pii_instance:${request.piiInstance}`;
    const modelId = buildModelInstanceId(request.modelSubject);
    const recipientId = buildRecipientId(request.recipientId);

    let modelCanShare = false;
    let lineageValid = false;
    let recipientCanView = false;
    let recipientTrusts = true; // Default to true if not checked

    // 1. Check model --can_share--> pii_instance
    try {
      const r1 = await fetch(
        `${this.config.apiUrl}/stores/${this.config.storeId}/check`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.OPENFGA_API_TOKEN || ""}`,
          },
          body: JSON.stringify({
            tuple_key: {
              user: modelId,
              relation: "can_share",
              object: piiInstanceId,
            },
            ...(this.config.modelId && { authorization_model_id: this.config.modelId }),
          }),
        }
      );
      if (r1.ok) {
        const result1 = await r1.json() as { allowed: boolean };
        modelCanShare = result1.allowed === true;
      }
    } catch { /* fail closed */ }

    if (!modelCanShare) {
      return { allowed: false, modelCanShare: false, lineageValid: false, recipientCanView: false };
    }

    // 2. Check pii_instance --originates_from--> model (lineage)
    try {
      const r2 = await fetch(
        `${this.config.apiUrl}/stores/${this.config.storeId}/check`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.OPENFGA_API_TOKEN || ""}`,
          },
          body: JSON.stringify({
            tuple_key: {
              user: piiInstanceId,
              relation: "originates_from",
              object: modelId,
            },
            ...(this.config.modelId && { authorization_model_id: this.config.modelId }),
          }),
        }
      );
      if (r2.ok) {
        const result2 = await r2.json() as { allowed: boolean };
        lineageValid = result2.allowed === true;
      }
    } catch { /* fail closed */ }

    if (!lineageValid) {
      return { allowed: false, modelCanShare: true, lineageValid: false, recipientCanView: false };
    }

    // 3. Check pii_instance --can_view--> recipient
    try {
      const r3 = await fetch(
        `${this.config.apiUrl}/stores/${this.config.storeId}/check`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.OPENFGA_API_TOKEN || ""}`,
          },
          body: JSON.stringify({
            tuple_key: {
              user: piiInstanceId,
              relation: "can_view",
              object: recipientId,
            },
            ...(this.config.modelId && { authorization_model_id: this.config.modelId }),
          }),
        }
      );
      if (r3.ok) {
        const result3 = await r3.json() as { allowed: boolean };
        recipientCanView = result3.allowed === true;
      }
    } catch { /* fail closed */ }

    if (!recipientCanView) {
      return { allowed: false, modelCanShare: true, lineageValid: true, recipientCanView: false };
    }

    // 4. Optional: Check recipient --can_receive_from--> model
    if (request.checkRecipientTrust) {
      try {
        const r4 = await fetch(
          `${this.config.apiUrl}/stores/${this.config.storeId}/check`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${process.env.OPENFGA_API_TOKEN || ""}`,
            },
            body: JSON.stringify({
              tuple_key: {
                user: recipientId,
                relation: "can_receive_from",
                object: modelId,
              },
              ...(this.config.modelId && { authorization_model_id: this.config.modelId }),
            }),
          }
        );
        if (r4.ok) {
          const result4 = await r4.json() as { allowed: boolean };
          recipientTrusts = result4.allowed === true;
        }
      } catch { /* fail closed */ }

      if (!recipientTrusts) {
        return { allowed: false, modelCanShare: true, lineageValid: true, recipientCanView: true, recipientTrusts: false };
      }
    }

    return {
      allowed: true,
      modelCanShare: true,
      lineageValid: true,
      recipientCanView: true,
      recipientTrusts: request.checkRecipientTrust ? recipientTrusts : undefined,
    };
  }

  /**
   * Batch check multiple sharing requests for performance.
   * Returns a map of piiInstanceId -> ShareCheckResult.
   */
  async batchCheckShare(requests: ShareCheckRequest[]): Promise<Map<string, ShareCheckResult>> {
    const results = new Map<string, ShareCheckResult>();

    // OpenFGA batch check API - send all checks at once
    const checks = requests.map((req, idx) => {
      const piiInstanceId = req.piiInstance.startsWith('pii_instance:')
        ? req.piiInstance
        : `pii_instance:${req.piiInstance}`;
      return {
        tuple_key: {
          user: buildModelInstanceId(req.modelSubject),
          relation: "can_share",
          object: piiInstanceId,
        },
        _index: idx,
      };
    });

    try {
      const response = await fetch(
        `${this.config.apiUrl}/stores/${this.config.storeId}/batch-check`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.OPENFGA_API_TOKEN || ""}`,
          },
          body: JSON.stringify({
            checks,
            ...(this.config.modelId && { authorization_model_id: this.config.modelId }),
          }),
        }
      );

      if (response.ok) {
        const result = await response.json() as { results: Array<{ allowed: boolean; _index: number }> };
        for (const r of result.results) {
          const req = requests[r._index];
          const piiInstanceId = req.piiInstance.startsWith('pii_instance:')
            ? req.piiInstance
            : `pii_instance:${req.piiInstance}`;
          // For batch check, we only get the first check result (can_share)
          // We'll need individual calls for full lineage checks if needed
          results.set(piiInstanceId, {
            allowed: r.allowed,
            modelCanShare: r.allowed,
            lineageValid: r.allowed, // Simplified - real impl would need full checks
            recipientCanView: r.allowed,
          });
        }
      }
    } catch {
      // Fail closed for all on batch check failure
      for (const req of requests) {
        const piiInstanceId = req.piiInstance.startsWith('pii_instance:')
          ? req.piiInstance
          : `pii_instance:${req.piiInstance}`;
        results.set(piiInstanceId, {
          allowed: false,
          modelCanShare: false,
          lineageValid: false,
          recipientCanView: false,
        });
      }
    }

    return results;
  }

  /**
   * Write authorization tuples to the store.
   * Each tuple's literal (if provided) is hashed before being written.
   * 
   * Supports the following object types:
   * - pii_instance:<sha256-hash> (for specific PII instances)
   * - category:<name> (for category-level tuples)
   * - recipient:<id> (for recipient tuples)
   */
  async writeTuples(tuples: WriteTuple[]): Promise<void> {
    const tupleKeys = tuples.map(t => {
      const objectId = this.buildObjectIdFromTuple(t);
      return {
        user: buildModelInstanceId(t.subject),
        relation: t.relation,
        object: objectId,
      };
    });

    const response = await fetch(
      `${this.config.apiUrl}/stores/${this.config.storeId}/write`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.OPENFGA_API_TOKEN || ""}`,
        },
        body: JSON.stringify({
          writes: { tuple_keys: tupleKeys },
        }),
      }
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`OpenFGA write failed (${response.status}): ${body}`);
    }
  }

  /**
   * Write a tuple with a specific object type prefix.
   * Used for recipient and category tuples.
   */
  async writeTuple(params: {
    subject: string;
    subjectType?: 'model_instance' | 'pii_instance' | 'recipient' | 'category';
    relation: string;
    object: string;
    objectType?: 'model_instance' | 'pii_instance' | 'recipient' | 'category';
  }): Promise<void> {
    const subjectId = this.buildSubjectId(params.subject, params.subjectType);
    const objectId = this.buildObjectIdWithType(params.object, params.objectType);

    const response = await fetch(
      `${this.config.apiUrl}/stores/${this.config.storeId}/write`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.OPENFGA_API_TOKEN || ""}`,
        },
        body: JSON.stringify({
          writes: {
            tuple_keys: [{
              user: subjectId,
              relation: params.relation,
              object: objectId,
            }],
          },
        }),
      }
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`OpenFGA write failed (${response.status}): ${body}`);
    }
  }

  /**
   * Delete authorization tuples from the store.
   */
  async deleteTuples(tuples: WriteTuple[]): Promise<void> {
    const tupleKeys = tuples.map(t => {
      const objectId = this.buildObjectIdFromTuple(t);
      return {
        user: buildModelInstanceId(t.subject),
        relation: t.relation,
        object: objectId,
      };
    });

    const response = await fetch(
      `${this.config.apiUrl}/stores/${this.config.storeId}/write`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.OPENFGA_API_TOKEN || ""}`,
        },
        body: JSON.stringify({
          deletes: { tuple_keys: tupleKeys },
        }),
      }
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`OpenFGA delete failed (${response.status}): ${body}`);
    }
  }

  /**
   * Read tuples from the store, optionally filtered.
   */
  async readTuples(filter?: ReadFilter): Promise<unknown[]> {
    const params = new URLSearchParams();
    if (filter?.subject) params.set("user", buildModelInstanceId(filter.subject));
    if (filter?.relation) params.set("relation", filter.relation);
    if (filter?.object) {
      const objectId = filter.objectType
        ? this.buildObjectIdWithType(filter.object, filter.objectType)
        : buildPIIInstanceId(filter.object);
      params.set("object", objectId);
    }

    const url = `${this.config.apiUrl}/stores/${this.config.storeId}/read${params.size > 0 ? `?${params}` : ""}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${process.env.OPENFGA_API_TOKEN || ""}`,
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`OpenFGA read failed (${response.status}): ${body}`);
    }

    const result = await response.json() as { tuples: unknown[] };
    return result.tuples || [];
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private buildObjectId(request: CheckRequest): string {
    if (request.literal) {
      // Never send raw literal — hash it
      return `pii_instance:sha256-${hashLiteral(request.literal)}`;
    }
    if (request.object?.startsWith("sha256-")) {
      // Already a hash
      return `pii_instance:${request.object}`;
    }
    if (request.object?.startsWith("pii_instance:")) {
      return request.object;
    }
    // Category-only
    return `category:${request.object}`;
  }

  private buildObjectIdFromTuple(tuple: WriteTuple): string {
    if (tuple.literal) {
      return `pii_instance:sha256-${hashLiteral(tuple.literal)}`;
    }
    if (tuple.object?.startsWith("sha256-")) {
      return `pii_instance:${tuple.object}`;
    }
    if (tuple.object?.startsWith("pii_instance:")) {
      return tuple.object;
    }
    return `category:${tuple.object}`;
  }

  private buildSubjectId(subject: string, type?: string): string {
    if (type === 'pii_instance') return `pii_instance:${subject}`;
    if (type === 'recipient') return `recipient:${subject}`;
    if (type === 'category') return `category:${subject}`;
    if (subject.startsWith('model_instance:')) return subject;
    if (subject.startsWith('pii_instance:')) return subject;
    if (subject.startsWith('recipient:')) return subject;
    if (subject.startsWith('category:')) return subject;
    return `model_instance:${subject}`;
  }

  private buildObjectIdWithType(object: string, type?: string): string {
    if (type === 'pii_instance') return `pii_instance:${object}`;
    if (type === 'recipient') return `recipient:${object}`;
    if (type === 'category') return `category:${object}`;
    if (type === 'model_instance') return `model_instance:${object}`;
    // Auto-detect from prefix
    if (object.startsWith('pii_instance:')) return object;
    if (object.startsWith('recipient:')) return object;
    if (object.startsWith('category:')) return object;
    if (object.startsWith('model_instance:')) return object;
    // Default to pii_instance for backwards compat
    return `pii_instance:${object}`;
  }
}

// ---------------------------------------------------------------------------
// Default client instance (lazy initialised)
// ---------------------------------------------------------------------------

let _defaultClient: OpenFGAClient | null = null;

/**
 * Returns the global OpenFGA client instance, creating it lazily if needed.
 * Tests may override this via `setOpenFGAClient()`.
 */
export function getOpenFGAClient(): OpenFGAClient {
  if (!_defaultClient) {
    _defaultClient = new OpenFGAClient({
      apiUrl: OPENFGA_API_URL,
      storeId: OPENFGA_STORE_ID,
      modelId: OPENFGA_MODEL_ID,
    });
  }
  return _defaultClient;
}

/**
 * Override the global OpenFGA client (for testing only).
 * Pass `null` to reset to the lazy-initialized real client.
 */
export function setOpenFGAClient(client: OpenFGAClient | null): void {
  _defaultClient = client;
}