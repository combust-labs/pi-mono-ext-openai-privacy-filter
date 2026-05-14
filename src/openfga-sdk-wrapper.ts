// SPDX-License-Identifier: Apache-2.0

/**
 * OpenFGA SDK Wrapper — Privacy Abstraction Layer
 *
 * Wraps the upstream @openfga/sdk with privacy-preserving behavior:
 * - Raw PII literals are never sent to OpenFGA (hashed first)
 * - ID builder conventions (model_instance:, pii_instance:, recipient:, category:)
 * - checkShare() 4-step composition
 * - Project-specific error message format
 *
 * This is the designated replacement for openfga.ts.
 */

import { createHash } from 'crypto';
import {
  OpenFgaClient,
  type ClientCheckRequest,
  type ClientWriteRequest,
  type ClientBatchCheckItem,
  type ClientBatchCheckRequest,
} from '@openfga/sdk';
import { CredentialsMethod } from '@openfga/sdk';
import { FgaError, FgaApiError } from '@openfga/sdk';
import type { RetryParams } from '@openfga/sdk';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const OPENFGA_API_URL = process.env.OPENFGA_API_URL || "http://localhost:28080";
const OPENFGA_STORE_ID = process.env.OPENFGA_STORE_ID || "privacy-policies";
const OPENFGA_MODEL_ID = process.env.OPENFGA_MODEL_ID || "privacy-model";

// ---------------------------------------------------------------------------
// Hashing (privacy-preserving — raw literals never sent to OpenFGA)
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

export type ShareCheckRequest = {
  modelSubject: string;    // e.g., "mlx-community/MiniMax-M2.7-8bit"
  piiInstance: string;     // e.g., "pii_instance:sha256-abc123" or "sha256-abc123"
  recipientId: string;     // e.g., "recipient:user:alice"
  checkRecipientTrust?: boolean;
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
  object?: string;
  literal?: string;
};

export type ReadFilter = {
  subject?: string;
  relation?: string;
  object?: string;
  objectType?: 'pii_instance' | 'recipient' | 'category' | 'model_instance';
};

// ---------------------------------------------------------------------------
// ID Builders
// ---------------------------------------------------------------------------

export function buildPIIInstanceId(literalOrHash: string): string {
  if (literalOrHash.startsWith('pii_instance:')) {
    return literalOrHash;
  }
  if (literalOrHash.startsWith('sha256-')) {
    return `pii_instance:${literalOrHash}`;
  }
  if (/^[0-9a-f]{40}$/i.test(literalOrHash)) {
    return `pii_instance:sha256-${literalOrHash}`;
  }
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
// SDK Client
// ---------------------------------------------------------------------------

/**
 * Create and return an OpenFgaClient instance configured from environment variables.
 * The client is lazily created on first call.
 */
export function createSDKClient(): OpenFgaClient {
  // Build credentials config
  const apiToken = process.env.OPENFGA_API_TOKEN;
  const clientId = process.env.FGA_CLIENT_ID;
  const clientSecret = process.env.FGA_CLIENT_SECRET;
  const apiTokenIssuer = process.env.FGA_API_TOKEN_ISSUER;
  const apiAudience = process.env.FGA_API_AUDIENCE;

  let credentialsConfig: undefined | { method: CredentialsMethod; config?: Record<string, string> };

  if (clientId && clientSecret) {
    // Client Credentials OAuth
    credentialsConfig = {
      method: CredentialsMethod.ClientCredentials,
      config: {
        clientId,
        clientSecret,
        ...(apiTokenIssuer && { apiTokenIssuer }),
        ...(apiAudience && { apiAudience }),
      },
    };
  } else if (apiToken) {
    // Static Bearer token
    credentialsConfig = {
      method: CredentialsMethod.ApiToken,
      config: { token: apiToken },
    };
  }

  // Retry params — SDK retries 429/5xx automatically (default maxRetry=3)
  const retryParams: RetryParams | undefined = (() => {
    const maxRetry = parseInt(process.env.FGA_MAX_RETRIES || '3', 10);
    const minWaitInMs = parseInt(process.env.FGA_MIN_WAIT_MS || '100', 10);
    return { maxRetry, minWaitInMs };
  })();

  const apiUrl = process.env.OPENFGA_API_URL || 'http://localhost:28080';
  const storeId = process.env.OPENFGA_STORE_ID || 'privacy-policies';
  const modelId = process.env.OPENFGA_MODEL_ID || 'privacy-model';

  const client = new OpenFgaClient({
    apiUrl,
    storeId,
    authorizationModelId: modelId,
    credentials: credentialsConfig as any,
    retryParams,
  });

  return client;
}

// ---------------------------------------------------------------------------
// Privacy Abstraction Layer Client
// ---------------------------------------------------------------------------

export class OpenFGAClientWrapper {
  private sdk: OpenFgaClient;

  constructor(sdk: OpenFgaClient) {
    this.sdk = sdk;
  }

  /**
   * Lightweight health check — verifies the OpenFGA server is reachable.
   * Returns true if /healthz responds, false otherwise.
   * Does not throw.
   */
  async healthCheck(): Promise<boolean> {
    const apiUrl = process.env.OPENFGA_API_URL || 'http://localhost:28080';
    try {
      const response = await fetch(`${apiUrl}/healthz`, {
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
   *
   * Returns true if allowed, false if not allowed.
   * Throws on network or HTTP errors.
   */
  async check(request: CheckRequest): Promise<boolean> {
    const objectId = this.buildObjectId(request);
    const user = buildModelInstanceId(request.subject);

    let result: { allowed: boolean };
    try {
      const response = await this.sdk.check(
        {
          tuple_key: {
            user,
            relation: request.relation,
            object: objectId,
          },
        } as ClientCheckRequest,
        {}
      );
      result = response as { allowed: boolean };
    } catch (err) {
      throw this.wrapError(err);
    }

    return result.allowed === true;
  }

  /**
   * Check if sharing a PII instance with a recipient is authorized.
   *
   * Performs the combined check:
   *   1. model:subject --can_share--> pii_instance:instance
   *   2. pii_instance:instance --lineage--> model:subject
   *   3. pii_instance:instance --can_view--> recipient:recipient
   *   4. (optional) recipient:recipient --can_receive_from--> model:subject
   *
   * All checks must pass for sharing to be allowed (fail-closed if any check fails).
   */
  async checkShare(request: ShareCheckRequest): Promise<ShareCheckResult> {
    const piiInstanceId = normalizePIIInstanceId(request.piiInstance);
    const modelId = buildModelInstanceId(request.modelSubject);
    const recipientId = buildRecipientId(request.recipientId);

    let modelCanShare = false;
    let lineageValid = false;
    let recipientCanView = false;
    let recipientTrusts = true;

    // 1. Check model --can_share--> pii_instance
    try {
      const r1 = await this.sdk.check(
        {
          tuple_key: {
            user: modelId,
            relation: 'can_share',
            object: piiInstanceId,
          },
        } as ClientCheckRequest,
        {}
      );
      modelCanShare = (r1 as { allowed: boolean }).allowed === true;
    } catch {
      modelCanShare = false;
    }

    if (!modelCanShare) {
      return { allowed: false, modelCanShare: false, lineageValid: false, recipientCanView: false };
    }

    // 2. Check pii_instance --lineage--> model
    try {
      const r2 = await this.sdk.check(
        {
          tuple_key: {
            user: piiInstanceId,
            relation: 'lineage',
            object: modelId,
          },
        } as ClientCheckRequest,
        {}
      );
      lineageValid = (r2 as { allowed: boolean }).allowed === true;
    } catch {
      lineageValid = false;
    }

    if (!lineageValid) {
      return { allowed: false, modelCanShare: true, lineageValid: false, recipientCanView: false };
    }

    // 3. Check pii_instance --can_view--> recipient
    try {
      const r3 = await this.sdk.check(
        {
          tuple_key: {
            user: piiInstanceId,
            relation: 'can_view',
            object: recipientId,
          },
        } as ClientCheckRequest,
        {}
      );
      recipientCanView = (r3 as { allowed: boolean }).allowed === true;
    } catch {
      recipientCanView = false;
    }

    if (!recipientCanView) {
      return { allowed: false, modelCanShare: true, lineageValid: true, recipientCanView: false };
    }

    // 4. Optional: Check recipient --can_receive_from--> model
    if (request.checkRecipientTrust) {
      try {
        const r4 = await this.sdk.check(
          {
            tuple_key: {
              user: recipientId,
              relation: 'can_receive_from',
              object: modelId,
            },
          } as ClientCheckRequest,
          {}
        );
        recipientTrusts = (r4 as { allowed: boolean }).allowed === true;
      } catch {
        recipientTrusts = false;
      }

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
   * Batch check multiple sharing requests.
   * Uses SDK's batchCheck() which calls /batch-check endpoint (OpenFGA v1.8+).
   * For each request, only the can_share check is performed.
   * Results are mapped by piiInstanceId.
   */
  async batchCheckShare(requests: ShareCheckRequest[]): Promise<Map<string, ShareCheckResult>> {
    const results = new Map<string, ShareCheckResult>();

    if (requests.length === 0) {
      return results;
    }

    const checks: ClientBatchCheckItem[] = requests.map((req, idx) => {
      const piiInstanceId = normalizePIIInstanceId(req.piiInstance);
      return {
        user: buildModelInstanceId(req.modelSubject),
        relation: 'can_share',
        object: piiInstanceId,
        correlationId: String(idx),
      };
    });

    try {
      const batchRequest: ClientBatchCheckRequest = { checks };
      const batchResponse = await (this.sdk as any).batchCheck(batchRequest, {});
      const body = batchResponse as { result: Array<{ allowed: boolean; request: ClientBatchCheckItem; correlationId: string }> };

      for (const item of body.result) {
        const idx = parseInt(item.correlationId, 10);
        const req = requests[idx];
        const piiInstanceId = normalizePIIInstanceId(req.piiInstance);
        results.set(piiInstanceId, {
          allowed: item.allowed,
          modelCanShare: item.allowed,
          lineageValid: item.allowed,
          recipientCanView: item.allowed,
        });
      }
    } catch {
      // Fail closed for all on batch check failure
      for (const req of requests) {
        const piiInstanceId = normalizePIIInstanceId(req.piiInstance);
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

    const body: ClientWriteRequest = {
      writes: tupleKeys as any,
    };

    try {
      await this.sdk.write(body, {});
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  /**
   * Write a tuple with a specific object type prefix.
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

    const body: ClientWriteRequest = {
      writes: [{ user: subjectId, relation: params.relation, object: objectId }] as any,
    };

    try {
      await this.sdk.write(body, {});
    } catch (err) {
      throw this.wrapError(err);
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

    const body: ClientWriteRequest = {
      deletes: tupleKeys as any,
    };

    try {
      await this.sdk.write(body, {});
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  /**
   * Read tuples from the store, optionally filtered.
   */
  async readTuples(filter?: ReadFilter): Promise<unknown[]> {
    try {
      const readFilter: Record<string, string> = {};
      if (filter?.subject) readFilter.user = buildModelInstanceId(filter.subject);
      if (filter?.relation) readFilter.relation = filter.relation;
      if (filter?.object) {
        readFilter.object = filter.objectType
          ? this.buildObjectIdWithType(filter.object, filter.objectType)
          : buildPIIInstanceId(filter.object);
      }

      const response = await this.sdk.read(
        { filter: readFilter } as any,
        {}
      );
      // SDK's read() returns the body directly (not { body: ... })
      const tuples = (response as unknown as { tuples?: unknown[] }).tuples;
      return tuples || [];
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private buildObjectId(request: CheckRequest): string {
    if (request.literal) {
      return `pii_instance:sha256-${hashLiteral(request.literal)}`;
    }
    if (request.object?.startsWith('sha256-')) {
      return `pii_instance:${request.object}`;
    }
    if (request.object?.startsWith('pii_instance:')) {
      return request.object;
    }
    return `category:${request.object}`;
  }

  private buildObjectIdFromTuple(tuple: WriteTuple): string {
    if (tuple.literal) {
      return `pii_instance:sha256-${hashLiteral(tuple.literal)}`;
    }
    if (tuple.object?.startsWith('sha256-')) {
      return `pii_instance:${tuple.object}`;
    }
    if (tuple.object?.startsWith('pii_instance:')) {
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
    if (object.startsWith('pii_instance:')) return object;
    if (object.startsWith('recipient:')) return object;
    if (object.startsWith('category:')) return object;
    if (object.startsWith('model_instance:')) return object;
    return `pii_instance:${object}`;
  }

  /**
   * Wrap SDK errors into the project's custom Error format.
   * This preserves the existing error message format so callers don't break.
   */
  private wrapError(err: unknown): Error {
    if (err instanceof FgaApiError) {
      return new Error(`OpenFGA check failed (${err.statusCode}): ${err.apiErrorMessage || err.message}`);
    }
    if (err instanceof FgaError) {
      return new Error(`OpenFGA error: ${err.message}`);
    }
    if (err instanceof Error) {
      // Network errors
      if (err.message.includes('fetch') || err.message.includes('network') || err.message.includes('ECONNREFUSED')) {
        return new Error(`OpenFGA check failed: ${err.message}`);
      }
      return err;
    }
    return new Error(`OpenFGA check failed: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Default instance (lazy)
// ---------------------------------------------------------------------------

let _defaultClient: OpenFGAClientWrapper | null = null;

/**
 * Returns the global OpenFGA client wrapper instance, creating it lazily if needed.
 */
export function getOpenFGAClient(): OpenFGAClientWrapper {
  if (!_defaultClient) {
    _defaultClient = new OpenFGAClientWrapper(createSDKClient());
  }
  return _defaultClient;
}

/**
 * Override the global OpenFGA client wrapper (for testing only).
 */
export function setOpenFGAClient(client: OpenFGAClientWrapper | null): void {
  _defaultClient = client;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizePIIInstanceId(id: string): string {
  if (id.startsWith('pii_instance:')) return id;
  if (id.startsWith('sha256-')) return `pii_instance:${id}`;
  return `pii_instance:${id}`;
}