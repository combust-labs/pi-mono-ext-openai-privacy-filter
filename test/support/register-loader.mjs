// SPDX-License-Identifier: Apache-2.0
/**
 * Register mock hooks for Node.js test runner.
 *
 * Loaded via --import alongside tsx:
 *   node --import tsx --import ./test/support/register-loader.mjs --test
 *
 * Hooks:
 * - '@huggingface/transformers' → mock-pipeline.ts
 * - '@mariozechner/pi-tui' → mock-pi-tui.ts
 *
 * tsx handles TypeScript transformation for all other imports.
 */
import { pathToFileURL } from 'node:url';
import { Module } from 'node:module';

// Derive paths from the current working directory rather than a hardcoded /code/
const cwd = process.cwd();
const mockPipelineUrl = pathToFileURL(cwd + '/test/support/mock-pipeline.ts').href;
const mockPiTuiUrl = pathToFileURL(cwd + '/test/support/mock-pi-tui.ts').href;

Module.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@huggingface/transformers') {
      return { shortCircuit: true, url: mockPipelineUrl };
    }
    if (specifier === '@mariozechner/pi-tui') {
      return { shortCircuit: true, url: mockPiTuiUrl };
    }
    return nextResolve(specifier, context);
  },
});