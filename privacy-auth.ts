// SPDX-License-Identifier: Apache-2.0
/**
 * Privacy Authorization Logic
 *
 * Implements fine-grained PII access control via OpenFGA.
 * This module has no extension dependencies and can be unit-tested in isolation.
 * 
 * Supports two authorization directions:
 * - can_view: Controls what PII a model can SEE in prompts (input direction)
 * - can_share: Controls what PII a model can OUTPUT to recipients (output direction)
 * 
 * The sharing check includes lineage verification to ensure PII originated
 * from the model attempting to share it.
 */

import { getOpenFGAClient, hashLiteral, buildPIIInstanceId, buildRecipientId } from './openfga.ts';
import {
  logCategoryAllowed,
  logCategoryDenied,
  logLiteralAllowed,
  logLiteralDenied,
  logAuthError,
  logFailClosed,
  logHealthCheckFailed,
} from './privacy-logger.ts';
import {
  recordAuthAllowed,
  recordAuthDenied,
  recordAuthError,
  recordCheckDuration,
  recordFailClosed,
} from './privacy-metrics.ts';

// ---------------------------------------------------------------------------
// Configuration - read at call time to support testing
// ---------------------------------------------------------------------------

function getPrivacyFilterRecipientId(): string {
  return process.env.PRIVACY_FILTER_RECIPIENT_ID || "";
}

function isPrivacyFilterSharingEnabled(): boolean {
  return process.env.PRIVACY_FILTER_SHARING_ENABLED === "true";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AggregatedAnnotation = {
  entity_group: string;
  score: number;
  word: string;
};

export type SharingDecision = {
  category: string;
  allowed: boolean;
  level: 'category' | 'literal';
  literal?: string;
  checks?: {
    modelCanShare: boolean;
    lineageValid: boolean;
    recipientCanView: boolean;
    recipientTrusts?: boolean;
  };
};

// ---------------------------------------------------------------------------
// Input Direction: can_view (existing functionality)
// ---------------------------------------------------------------------------

/**
 * Build the set of PII categories that should be masked.
 * A category is denied (masked) when BOTH the literal-level check
 * and the category-level check return false or throw.
 *
 * If OpenFGA is unreachable, ALL categories are denied (fail-closed).
 *
 * @param results - PII entities detected by the classifier
 * @param modelSubject - The model ID from pi-mono's current context (e.g. "mlx-community/MiniMax-M2.7-8bit")
 */
export async function buildDeniedCategoriesSet(
  results: AggregatedAnnotation[],
  modelSubject: string,
): Promise<Set<string>> {
  const deniedCategories = new Set<string>();

  // Group by category to avoid redundant OpenFGA calls for same category
  const categoryEntities = new Map<string, AggregatedAnnotation[]>();
  for (const entity of results) {
    if (!categoryEntities.has(entity.entity_group)) {
      categoryEntities.set(entity.entity_group, []);
    }
    categoryEntities.get(entity.entity_group)!.push(entity);
  }

  const openfga = getOpenFGAClient();
  let openfgaAvailable = true;

  // Health check once before any authorization calls — fail fast if OpenFGA is down
  if (!(await openfga.healthCheck())) {
    logHealthCheckFailed('OpenFGA health check failed — fail-closing all categories');
    // Log fail-closed for each category
    const allCategories = [...categoryEntities.keys()];
    logFailClosed(modelSubject, 'health_check_failed', allCategories);
    recordFailClosed('health_check_failed', modelSubject);
    openfgaAvailable = false;
  }

  for (const [category, entities] of categoryEntities) {
    if (!openfgaAvailable) break;
    let categoryAllowed = false;
    // Try category-level check first (more efficient — one check covers all literals)
    try {
      const t0 = Date.now();
      const canViewCategory = await openfga.check({
        subject: modelSubject,
        relation: "can_view",
        object: category,
      });
      recordCheckDuration(Date.now() - t0);
      if (canViewCategory) {
        categoryAllowed = true;
        logCategoryAllowed(modelSubject, category);
        recordAuthAllowed('category', modelSubject, category);
      } else {
        logCategoryDenied(modelSubject, category);
        recordAuthDenied('category', modelSubject, category);
      }
    } catch (err) {
      logAuthError(modelSubject, category, undefined, (err as Error).message);
      recordAuthError(modelSubject, category);
      // OpenFGA unavailable — fail closed
      openfgaAvailable = false;
      break;
    }

    if (categoryAllowed) continue;

    // Check each literal under this category individually
    for (const entity of entities) {
      if (!openfgaAvailable) break;
      try {
        const t0 = Date.now();
        const canViewLiteral = await openfga.check({
          subject: modelSubject,
          relation: "can_view",
          literal: entity.word,
        });
        recordCheckDuration(Date.now() - t0);
        if (canViewLiteral) {
          categoryAllowed = true;
          logLiteralAllowed(modelSubject, category, entity.word);
          recordAuthAllowed('literal', modelSubject, category);
          break;
        } else {
          logLiteralDenied(modelSubject, category, entity.word);
          recordAuthDenied('literal', modelSubject, category);
        }
      } catch (err) {
        logAuthError(modelSubject, category, entity.word, (err as Error).message);
        recordAuthError(modelSubject, category);
        // OpenFGA unavailable — fail closed
        openfgaAvailable = false;
        break;
      }
    }

    if (!categoryAllowed) {
      deniedCategories.add(category);
    }

    if (!openfgaAvailable) break;
  }

  // Fail-closed: if OpenFGA was unreachable, mask everything
  if (!openfgaAvailable) {
    const allCategories = [...categoryEntities.keys()];
    logFailClosed(modelSubject, 'openfga_unreachable', allCategories);
    recordFailClosed('openfga_unreachable', modelSubject);
    for (const category of categoryEntities.keys()) {
      deniedCategories.add(category);
    }
  }

  return deniedCategories;
}

// ---------------------------------------------------------------------------
// Output Direction: can_share (new functionality with lineage)
// ---------------------------------------------------------------------------

/**
 * Build the set of PII categories/literals that should be blocked from sharing.
 * 
 * A category/literal is blocked when ANY of these conditions are met:
 *   1. Model is NOT authorized to share it (model --can_share--> pii)
 *   2. PII does NOT have lineage to this model (pii --lineage--> model)
 *   3. Recipient is NOT authorized to view this PII (pii --can_view--> recipient)
 *   4. Recipient does NOT trust this model (recipient --can_receive_from--> model)
 *      [only checked if PRIVACY_FILTER_RECIPIENT_ID is set and checkRecipientTrust is true]
 * 
 * If OpenFGA is unreachable, ALL sharing is denied (fail-closed).
 *
 * @param results - PII entities detected in the model's output
 * @param modelSubject - The model ID attempting to share PII
 * @param recipientId - The recipient ID (user/harness/agent) - defaults to PRIVACY_FILTER_RECIPIENT_ID env var
 * @param options.checkRecipientTrust - If true, also verify recipient --can_receive_from--> model
 */
export async function buildSharingDeniedCategoriesSet(
  results: AggregatedAnnotation[],
  modelSubject: string,
  recipientId?: string,
  options?: { checkRecipientTrust?: boolean },
): Promise<Set<string>> {
  const effectiveRecipientId = recipientId || getPrivacyFilterRecipientId();
  
  if (!effectiveRecipientId) {
    throw new Error("PRIVACY_FILTER_RECIPIENT_ID is not set and no recipientId was provided to buildSharingDeniedCategoriesSet");
  }

  const deniedCategories = new Set<string>();

  // Group by category to avoid redundant sharing checks for same category
  const categoryEntities = new Map<string, AggregatedAnnotation[]>();
  for (const entity of results) {
    if (!categoryEntities.has(entity.entity_group)) {
      categoryEntities.set(entity.entity_group, []);
    }
    categoryEntities.get(entity.entity_group)!.push(entity);
  }

  const openfga = getOpenFGAClient();
  let openfgaAvailable = true;

  // Health check once before any sharing authorization calls
  if (!(await openfga.healthCheck())) {
    logHealthCheckFailed('OpenFGA health check failed during sharing check — fail-closing all categories');
    logFailClosed(modelSubject, 'sharing_health_check_failed', [...categoryEntities.keys()], effectiveRecipientId);
    recordFailClosed('sharing_health_check_failed', modelSubject);
    openfgaAvailable = false;
  }

  for (const [category, entities] of categoryEntities) {
    if (!openfgaAvailable) break;
    
    // For category-level check, verify the category itself can be shared
    // This checks: category --can_share--> recipient (if such tuple exists)
    // If not, we fall through to per-entity checks
    
    let sharingAllowed = false;
    
    // Try per-entity sharing checks with lineage
    for (const entity of entities) {
      if (!openfgaAvailable) break;
      
      try {
        const piiHash = hashLiteral(entity.word);
        const piiInstanceId = buildPIIInstanceId(piiHash);
        
        const t0 = Date.now();
        const shareCheck = await openfga.checkShare({
          modelSubject,
          piiInstance: piiInstanceId,
          recipientId: effectiveRecipientId,
          checkRecipientTrust: options?.checkRecipientTrust,
        });
        recordCheckDuration(Date.now() - t0);

        if (shareCheck.allowed) {
          sharingAllowed = true;
          logSharingAllowed(modelSubject, category, entity.word, shareCheck.checks);
          recordAuthAllowed('sharing', modelSubject, category);
        } else {
          logSharingDenied(modelSubject, category, entity.word, shareCheck);
          recordAuthDenied('sharing', modelSubject, category);
          // Still need to check all entities before marking category as denied
        }
      } catch (err) {
        logAuthError(modelSubject, category, entity.word, (err as Error).message);
        recordAuthError(modelSubject, category);
        openfgaAvailable = false;
        break;
      }
    }

    if (!sharingAllowed) {
      deniedCategories.add(category);
    }

    if (!openfgaAvailable) break;
  }

  // Fail-closed: if OpenFGA was unreachable, block all sharing
  if (!openfgaAvailable) {
    const allCategories = [...categoryEntities.keys()];
    logFailClosed(modelSubject, 'sharing_openfga_unreachable', allCategories, effectiveRecipientId);
    recordFailClosed('sharing_openfga_unreachable', modelSubject);
    for (const category of categoryEntities.keys()) {
      deniedCategories.add(category);
    }
  }

  return deniedCategories;
}

/**
 * Check sharing authorization for a single PII entity.
 * Returns a detailed SharingDecision with per-check results.
 */
export async function checkSharingAuthorization(
  entity: AggregatedAnnotation,
  modelSubject: string,
  recipientId?: string,
  options?: { checkRecipientTrust?: boolean },
): Promise<SharingDecision> {
  const effectiveRecipientId = recipientId || getPrivacyFilterRecipientId();

  if (!effectiveRecipientId) {
    throw new Error("PRIVACY_FILTER_RECIPIENT_ID is not set and no recipientId was provided");
  }

  const openfga = getOpenFGAClient();
  const piiHash = hashLiteral(entity.word);
  const piiInstanceId = buildPIIInstanceId(piiHash);

  try {
    const shareCheck = await openfga.checkShare({
      modelSubject,
      piiInstance: piiInstanceId,
      recipientId: effectiveRecipientId,
      checkRecipientTrust: options?.checkRecipientTrust,
    });

    return {
      category: entity.entity_group,
      allowed: shareCheck.allowed,
      level: 'literal',
      literal: entity.word,
      checks: {
        modelCanShare: shareCheck.modelCanShare,
        lineageValid: shareCheck.lineageValid,
        recipientCanView: shareCheck.recipientCanView,
        recipientTrusts: shareCheck.recipientTrusts,
      },
    };
  } catch (err) {
    return {
      category: entity.entity_group,
      allowed: false,
      level: 'literal',
      literal: entity.word,
      checks: {
        modelCanShare: false,
        lineageValid: false,
        recipientCanView: false,
      },
    };
  }
}

/**
 * Check if sharing is enabled (PRIVACY_FILTER_SHARING_ENABLED=true).
 * Used to gate sharing checks in the extension.
 */
export function isSharingEnabled(): boolean {
  return isPrivacyFilterSharingEnabled();
}

/**
 * Get the configured recipient ID.
 * Used by the extension to determine the current recipient context.
 */
export function getRecipientId(): string {
  return getPrivacyFilterRecipientId();
}

// ---------------------------------------------------------------------------
// Logging helpers (placeholder - would be implemented in privacy-logger.ts)
// ---------------------------------------------------------------------------

function logSharingAllowed(
  modelSubject: string,
  category: string,
  literal: string,
  checks?: { modelCanShare: boolean; lineageValid: boolean; recipientCanView: boolean; recipientTrusts?: boolean }
): void {
  console.log(`[SHARING-ALLOWED] model=${modelSubject} category=${category} literal=${literal.substring(0, 3)}... checks=${JSON.stringify(checks)}`);
}

function logSharingDenied(
  modelSubject: string,
  category: string,
  literal: string,
  result: { modelCanShare: boolean; lineageValid: boolean; recipientCanView: boolean; recipientTrusts?: boolean }
): void {
  console.log(`[SHARING-DENIED] model=${modelSubject} category=${category} literal=${literal.substring(0, 3)}... result=${JSON.stringify(result)}`);
}