// SPDX-License-Identifier: Apache-2.0
/**
 * Structured audit logger for the Privacy Filter extension.
 *
 * Logs authorization decisions, errors, and fallbacks to stderr as
 * structured JSON lines. Each entry includes a timestamp, event type,
 * model subject, and relevant context.
 *
 * Log output is written to stderr (not stdout) to avoid polluting
 * command output and to integrate cleanly with log aggregation tools.
 *
 * Tests may replace the logger via `setLogger()` for capture and assertion.
 */

export type LogLevel = 'info' | 'warn' | 'error';

export type LogEvent =
  | AuthAllowedEvent
  | AuthDeniedEvent
  | AuthErrorEvent
  | FailClosedEvent
  | HealthCheckFailedEvent;

export type AuthAllowedEvent = {
  event: 'auth_allowed';
  level: 'category' | 'literal';
  model: string;
  category: string;
  literal?: string;
};

export type AuthDeniedEvent = {
  event: 'auth_denied';
  level: 'category' | 'literal';
  model: string;
  category: string;
  literal?: string;
};

export type AuthErrorEvent = {
  event: 'auth_error';
  model: string;
  category: string;
  literal?: string;
  error: string;
};

export type FailClosedEvent = {
  event: 'fail_closed';
  reason: 'openfga_unreachable' | 'health_check_failed';
  model: string;
  categories: string[];
};

export type HealthCheckFailedEvent = {
  event: 'health_check_failed';
  error: string;
};

export type LoggerFn = (event: LogEvent) => void;

// ---------------------------------------------------------------------------
// Default logger — writes structured JSON to stderr
// ---------------------------------------------------------------------------

function defaultLogger(event: LogEvent): void {
  const entry = {
    timestamp: new Date().toISOString(),
    ...event,
  };
  // eslint-disable-next-line no-console
  console.error(JSON.stringify(entry));
}

// ---------------------------------------------------------------------------
// Global logger state
// ---------------------------------------------------------------------------

let _logger: LoggerFn = defaultLogger;
let _enabled = false;

/**
 * Set a custom logger function.
 * Tests use this to capture log entries for assertion.
 */
export function setLogger(fn: LoggerFn): void {
  _logger = fn;
}

/**
 * Restore the default stderr logger.
 */
export function resetLogger(): void {
  _logger = defaultLogger;
  _enabled = false;
}

/**
 * Enable or disable logging.
 */
export function setLoggingEnabled(enabled: boolean): void {
  _enabled = enabled;
}

function log(event: LogEvent): void {
  if (_enabled) {
    _logger(event);
  }
}

// ---------------------------------------------------------------------------
// Log helpers — called by authorization logic
// ---------------------------------------------------------------------------

/**
 * Log that a category was allowed at category-level.
 */
export function logCategoryAllowed(model: string, category: string): void {
  log({ event: 'auth_allowed', level: 'category', model, category });
}

/**
 * Log that a literal was allowed at literal-level.
 */
export function logLiteralAllowed(model: string, category: string, literal: string): void {
  log({ event: 'auth_allowed', level: 'literal', model, category, literal });
}

/**
 * Log that a category was denied at category-level.
 */
export function logCategoryDenied(model: string, category: string): void {
  log({ event: 'auth_denied', level: 'category', model, category });
}

/**
 * Log that a literal was denied at literal-level.
 */
export function logLiteralDenied(model: string, category: string, literal: string): void {
  log({ event: 'auth_denied', level: 'literal', model, category, literal });
}

/**
 * Log an error that occurred during an authorization check.
 */
export function logAuthError(model: string, category: string, literal: string | undefined, error: string): void {
  log({ event: 'auth_error', model, category, literal, error });
}

/**
 * Log a fail-closed event — all given categories were masked because
 * OpenFGA was unreachable or the health check failed.
 */
export function logFailClosed(model: string, reason: FailClosedEvent['reason'], categories: string[]): void {
  log({ event: 'fail_closed', reason, model, categories });
}

/**
 * Log a health check failure.
 */
export function logHealthCheckFailed(error: string): void {
  log({ event: 'health_check_failed', error });
}