// SPDX-License-Identifier: Apache-2.0
/**
 * Mock OpenFGA Client for testing buildDeniedCategoriesSet().
 *
 * Records all check() calls and returns configurable responses.
 * Use createMockOpenFGAClient() to instantiate, then configure
 * per-test via mock.checkResult() or mock.checkResultFn().
 */

import type { CheckRequest } from '../../openfga.ts';

export type RecordedCall = {
  subject: string;
  relation: string;
  object?: string;
  literal?: string;
  /** The resolved object ID sent to OpenFGA (includes privacy_category: prefix) */
  resolvedObjectId: string;
};

export type MockOpenFGAClient = {
  /**
   * Configure a fixed boolean result for ALL check() calls.
   * Call this before each test (or use checkResultFn for per-call logic).
   */
  checkResult(result: boolean): void;

  /**
   * Configure a per-call result function.
   * The function receives the CheckRequest and returns the boolean.
   * Use this for tests with mixed allow/deny outcomes.
   */
  checkResultFn(fn: (call: RecordedCall) => boolean): void;

  /**
   * Make every check() call throw the configured error.
   */
  throwError(error: Error): void;

  /** Reset call history and configured behavior between tests. */
  reset(): void;

  /** All check() calls made since the last reset. */
  calls: RecordedCall[];

  /** The check() method implementing OpenFGAClient's interface. */
  check(request: CheckRequest): Promise<boolean>;
};

export function createMockOpenFGAClient(): MockOpenFGAClient {
  let fixedResult: boolean | null = null;
  let resultFn: ((call: RecordedCall) => boolean) | null = null;
  let error: Error | null = null;
  const calls: RecordedCall[] = [];

  async function buildResolvedObjectId(request: CheckRequest): Promise<string> {
    if (request.literal) {
      // Mirrors OpenFGAClient.buildObjectId — hash the literal
      const { createHash } = await import('crypto');
      const hash = createHash('sha256').update(request.literal).digest('hex').substring(0, 40);
      return `privacy_category:sha256-${hash}`;
    }
    if (request.object?.startsWith('sha256-')) {
      return `privacy_category:${request.object}`;
    }
    return `privacy_category:${request.object}`;
  }

  async function check(request: CheckRequest): Promise<boolean> {
    const resolvedObjectId = await buildResolvedObjectId(request);
    calls.push({
      subject: request.subject,
      relation: request.relation,
      object: request.object,
      literal: request.literal,
      resolvedObjectId,
    });

    if (error) throw error;

    if (resultFn) return resultFn(calls[calls.length - 1]);
    if (fixedResult !== null) return fixedResult;

    // Default: deny everything
    return false;
  }

  return {
    check,

    checkResult(result: boolean) {
      fixedResult = result;
      resultFn = null;
      error = null;
    },

    checkResultFn(fn: (call: RecordedCall) => boolean) {
      resultFn = fn;
      fixedResult = null;
      error = null;
    },

    throwError(err: Error) {
      error = err;
      fixedResult = null;
      resultFn = null;
    },

    reset() {
      calls.length = 0;
      fixedResult = null;
      resultFn = null;
      error = null;
    },

    get calls() {
      return calls;
    },
  };
}
