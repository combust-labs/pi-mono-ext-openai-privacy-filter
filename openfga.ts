// SPDX-License-Identifier: Apache-2.0
/**
 * OpenFGA Client Facade
 *
 * This file re-exports from src/openfga-sdk-wrapper.ts, which wraps
 * the upstream @openfga/sdk with the project's privacy-preserving conventions.
 * All application code imports from this file.
 *
 * For tests: use setOpenFGAClient() to inject a mock or test wrapper.
 */

export {
  getOpenFGAClient,
  setOpenFGAClient,
  createSDKClient,
  OpenFGAClientWrapper,
  hashLiteral,
  buildPIIInstanceId,
  buildRecipientId,
  buildModelInstanceId,
} from './src/openfga-sdk-wrapper.ts';

export type {
  OpenFGAClientConfig,
  CheckRequest,
  ShareCheckRequest,
  ShareCheckResult,
  WriteTuple,
  ReadFilter,
} from './src/openfga-sdk-wrapper.ts';