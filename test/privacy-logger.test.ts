// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 5: Logging Tests
 *
 * Tests that the audit logger emits structured JSON entries for:
 * - Category-level allow/deny
 * - Literal-level allow/deny
 * - Authorization errors
 * - Fail-closed events (health check failed, openfga unreachable)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  setLogger,
  resetLogger,
  setLoggingEnabled,
  logCategoryAllowed,
  logCategoryDenied,
  logLiteralAllowed,
  logLiteralDenied,
  logAuthError,
  logFailClosed,
  logHealthCheckFailed,
  type LogEvent,
} from '../privacy-logger.ts';

describe('privacy-logger', () => {
  let events: LogEvent[];

  beforeEach(() => {
    events = [];
    setLoggingEnabled(true); // Ensure logging is enabled for tests
    setLogger((event) => events.push(event));
  });

  afterEach(() => {
    resetLogger();
  });

  // -------------------------------------------------------------------------
  // Auth allowed events
  // -------------------------------------------------------------------------

  it('logCategoryAllowed emits auth_allowed event with category level', () => {
    logCategoryAllowed('test-model/1.0', 'email');

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event, 'auth_allowed');
    assert.strictEqual((events[0]).level, 'category');
    assert.strictEqual((events[0]).model, 'test-model/1.0');
    assert.strictEqual((events[0]).category, 'email');
  });

  it('logLiteralAllowed emits auth_allowed event with literal level and value', () => {
    logLiteralAllowed('test-model/1.0', 'email', 'user@company.com');

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event, 'auth_allowed');
    assert.strictEqual((events[0]).level, 'literal');
    assert.strictEqual((events[0]).model, 'test-model/1.0');
    assert.strictEqual((events[0]).category, 'email');
    assert.strictEqual((events[0]).literal, 'user@company.com');
  });

  // -------------------------------------------------------------------------
  // Auth denied events
  // -------------------------------------------------------------------------

  it('logCategoryDenied emits auth_denied event', () => {
    logCategoryDenied('test-model/1.0', 'phone_number');

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event, 'auth_denied');
    assert.strictEqual((events[0]).level, 'category');
    assert.strictEqual((events[0]).model, 'test-model/1.0');
    assert.strictEqual((events[0]).category, 'phone_number');
  });

  it('logLiteralDenied emits auth_denied event with literal', () => {
    logLiteralDenied('test-model/1.0', 'phone_number', '555-123-4567');

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event, 'auth_denied');
    assert.strictEqual((events[0]).level, 'literal');
    assert.strictEqual((events[0]).literal, '555-123-4567');
  });

  // -------------------------------------------------------------------------
  // Auth error events
  // -------------------------------------------------------------------------

  it('logAuthError emits auth_error event with error message', () => {
    logAuthError('test-model/1.0', 'email', undefined, 'Connection refused');

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event, 'auth_error');
    assert.strictEqual((events[0]).model, 'test-model/1.0');
    assert.strictEqual((events[0]).category, 'email');
    assert.strictEqual((events[0]).error, 'Connection refused');
  });

  it('logAuthError with literal emits auth_error with literal field set', () => {
    logAuthError('test-model/1.0', 'email', 'a@b.com', 'Timeout');

    const ev = events[0] as { event: string; literal?: string };
    assert.strictEqual(ev.event, 'auth_error');
    assert.strictEqual(ev.literal, 'a@b.com');
  });

  // -------------------------------------------------------------------------
  // Fail-closed events
  // -------------------------------------------------------------------------

  it('logFailClosed emits fail_closed event with all affected categories', () => {
    logFailClosed('test-model/1.0', 'health_check_failed', ['email', 'phone_number']);

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event, 'fail_closed');
    assert.strictEqual((events[0]).reason, 'health_check_failed');
    assert.strictEqual((events[0]).model, 'test-model/1.0');
    assert.deepStrictEqual((events[0]).categories, ['email', 'phone_number']);
  });

  it('logFailClosed with openfga_unreachable reason', () => {
    logFailClosed('test-model/1.0', 'openfga_unreachable', ['email']);

    assert.strictEqual((events[0]).reason, 'openfga_unreachable');
  });

  // -------------------------------------------------------------------------
  // Health check failure events
  // -------------------------------------------------------------------------

  it('logHealthCheckFailed emits health_check_failed event', () => {
    logHealthCheckFailed('Connection refused');

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event, 'health_check_failed');
    assert.strictEqual((events[0]).error, 'Connection refused');
  });

  // -------------------------------------------------------------------------
  // Enable / disable
  // -------------------------------------------------------------------------

  it('setLoggingEnabled(false) suppresses all log output', () => {
    setLoggingEnabled(false);
    logCategoryAllowed('model', 'email');
    assert.strictEqual(events.length, 0);
  });

  it('setLoggingEnabled(true) resumes log output', () => {
    setLoggingEnabled(false);
    logCategoryAllowed('model', 'email');
    assert.strictEqual(events.length, 0);
    setLoggingEnabled(true);
    logCategoryAllowed('model', 'email');
    assert.strictEqual(events.length, 1);
  });

  // -------------------------------------------------------------------------
  // resetLogger restores default stderr behavior
  // -------------------------------------------------------------------------

  it('resetLogger removes the custom logger (logs go to default stderr)', () => {
    setLogger((e) => events.push(e)); // set custom logger
    resetLogger(); // restore to default

    logCategoryAllowed('test-model', 'email'); // custom logger should NOT receive this

    assert.strictEqual(events.length, 0, 'custom logger should be gone after resetLogger');
  });
});