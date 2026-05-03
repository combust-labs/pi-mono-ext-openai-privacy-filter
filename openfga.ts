// SPDX-License-Identifier: Apache-2.0

/**
 * OpenFGA Client for Privacy Filter Authorization
 *
 * Provides fine-grained authorization via OpenFGA REST API.
 * Specific PII literals are never sent to OpenFGA — only their SHA256 hashes.
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
};

// ---------------------------------------------------------------------------
// OpenFGA Client
// ---------------------------------------------------------------------------

export class OpenFGAClient {
  constructor(private config: OpenFGAClientConfig) {}

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
            user: `model_instance:${request.subject}`,
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
   * Write authorization tuples to the store.
   * Each tuple's literal (if provided) is hashed before being written.
   */
  async writeTuples(tuples: WriteTuple[]): Promise<void> {
    const tupleKeys = tuples.map(t => {
      const objectId = this.buildObjectIdFromTuple(t);
      return {
        user: `model_instance:${t.subject}`,
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
   * Delete authorization tuples from the store.
   */
  async deleteTuples(tuples: WriteTuple[]): Promise<void> {
    const tupleKeys = tuples.map(t => {
      const objectId = this.buildObjectIdFromTuple(t);
      return {
        user: `model_instance:${t.subject}`,
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
    if (filter?.subject) params.set("user", `model_instance:${filter.subject}`);
    if (filter?.relation) params.set("relation", filter.relation);
    if (filter?.object) params.set("object", `privacy_category:${filter.object}`);

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
      return `privacy_category:sha256-${hashLiteral(request.literal)}`;
    }
    if (request.object?.startsWith("sha256-")) {
      // Already a hash
      return `privacy_category:${request.object}`;
    }
    // Category-only
    return `privacy_category:${request.object}`;
  }

  private buildObjectIdFromTuple(tuple: WriteTuple): string {
    if (tuple.literal) {
      return `privacy_category:sha256-${hashLiteral(tuple.literal)}`;
    }
    return `privacy_category:${tuple.object}`;
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
