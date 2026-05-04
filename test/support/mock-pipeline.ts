// SPDX-License-Identifier: Apache-2.0
/**
 * Mock pipeline for @huggingface/transformers token-classification.
 *
 * Loaded by the ESM register-loader (register-loader.mjs) whenever
 * '@huggingface/transformers' is imported. The real module is never loaded.
 *
 * The loader intercepts:
 *   import { pipeline } from '@huggingface/transformers'
 * and resolves it here instead, providing a configurable mock.
 *
 * Usage:
 *   import { createMockPipeline } from './support/mock-pipeline.ts';
 *   const mock = createMockPipeline();
 *   beforeEach(() => { mock.reset(); mock.mockResults([...]); });
 */

import type { AggregatedAnnotation } from '../privacy-auth.ts';

export type PipelineOptions = {
  aggregation_strategy?: string;
};

export type PipelineResult = AggregatedAnnotation[];

type PipelineFn = (
  task: string,
  model?: string,
  options?: { device?: string; dtype?: string }
) => Promise<(text: string, options?: PipelineOptions) => Promise<PipelineResult>>;

// Module-level singleton state — shared across all calls to the mock pipeline
let _mockResults: PipelineResult = [];
let _mockError: Error | null = null;
const _calls: PipelineResult[] = [];

/**
 * Configure what results the mock classifier should return.
 */
export function configureMockResults(results: AggregatedAnnotation[]): void {
  _mockResults = results;
  _mockError = null;
}

/**
 * Make the mock throw on the next classifier call.
 */
export function configureMockError(error: Error): void {
  _mockError = error;
  _mockResults = [];
}

/** Reset all state. Call in beforeEach. */
export function resetMockPipeline(): void {
  _mockResults = [];
  _mockError = null;
  _calls.length = 0;
}

/** All classifier calls recorded since last reset. */
export function getMockCalls(): PipelineResult[] {
  return _calls;
}

/**
 * Returns a mock classifier function that, when called with (text, options),
 * returns a Promise resolving to the configured mock results.
 *
 * Matches the return type of @huggingface/transformers' pipeline().
 */
function makeMockClassifier() {
  return async (_text: string, _options?: PipelineOptions): Promise<PipelineResult> => {
    _calls.push([..._mockResults]);
    if (_mockError) {
      throw _mockError;
    }
    return [..._mockResults];
  };
}

// This is the 'pipeline' named export that gets used when the loader
// redirects '@huggingface/transformers' to this file
export const pipeline: PipelineFn = async (
  _task: string,
  _model?: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _options?: { device?: string; dtype?: string }
) => {
  // The real pipeline() returns a function that performs classification.
  // Our mock returns a function that returns pre-configured results.
  return makeMockClassifier();
};

// env object — used by index.ts to configure model paths (no-op in mock)
export const env = {
  allowRemoteModels: false,
  localModelPath: '',
};

// Default export (satisfies module shape but not used by index.ts)
export default { pipeline, env };

export interface MockPipeline {
  mockResults(results: AggregatedAnnotation[]): void;
  mockError(error: Error): void;
  reset(): void;
  get calls(): PipelineResult[];
}

/**
 * Fluent interface for configuring the mock from tests.
 */
export function createMockPipeline(): MockPipeline {
  return {
    mockResults(results: AggregatedAnnotation[]) {
      configureMockResults(results);
    },
    mockError(error: Error) {
      configureMockError(error);
    },
    reset() {
      resetMockPipeline();
    },
    get calls() {
      return getMockCalls();
    },
  };
}
