// SPDX-License-Identifier: Apache-2.0
/**
 * Privacy Authorization Logic
 *
 * Implements fine-grained PII access control via OpenFGA.
 * This module has no extension dependencies and can be unit-tested in isolation.
 */

import { getOpenFGAClient } from './openfga.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AggregatedAnnotation = {
  entity_group: string;
  score: number;
  word: string;
};

// ---------------------------------------------------------------------------
// Authorization
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
    openfgaAvailable = false;
  }

  for (const [category, entities] of categoryEntities) {
    if (!openfgaAvailable) break;
    let categoryAllowed = false;
    // Try category-level check first (more efficient — one check covers all literals)
    try {
      const canViewCategory = await openfga.check({
        subject: modelSubject,
        relation: "can_view",
        object: category,
      });
      if (canViewCategory) {
        categoryAllowed = true;
      }
    } catch {
      // OpenFGA unavailable — fail closed
      openfgaAvailable = false;
      break;
    }

    if (categoryAllowed) continue;

    // Check each literal under this category individually
    for (const entity of entities) {
      try {
        const canViewLiteral = await openfga.check({
          subject: modelSubject,
          relation: "can_view",
          literal: entity.word,
        });
        if (canViewLiteral) {
          categoryAllowed = true;
          break;
        }
      } catch {
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
    for (const category of categoryEntities.keys()) {
      deniedCategories.add(category);
    }
  }

  return deniedCategories;
}
