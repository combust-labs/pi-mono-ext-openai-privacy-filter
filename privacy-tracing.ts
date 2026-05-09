// SPDX-License-Identifier: Apache-2.0
/**
 * OpenTelemetry Tracing for Privacy Filter Extension
 * 
 * Provides distributed tracing for PII authorization checks without
 * exposing any PII data in traces.
 * 
 * Traces are only generated when:
 * - OTEL is properly configured (OTEL_SERVICE_NAME or OTEL_EXPORTER_OTLP_ENDPOINT set)
 * - The extension is processing PII
 * 
 * IMPORTANT: No PII (entity words, hashes, or content) is ever included in traces.
 * Only authorization decisions and metadata are recorded.
 */

import { trace, context, Span, SpanStatusCode, Tracer, Attributes } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Check if tracing is enabled via environment variables.
 * Tracing is enabled when OTEL_EXPORTER_OTLP_ENDPOINT is set.
 */
function isTracingEnabled(): boolean {
  return !!(
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
    process.env.OTEL_SERVICE_NAME ||
    process.env.OTEL_ENABLED === 'true'
  );
}

/**
 * Get the service name for tracing, defaulting to 'pi-privacy-filter'.
 */
function getServiceName(): string {
  return process.env.OTEL_SERVICE_NAME || 'pi-privacy-filter';
}

// ---------------------------------------------------------------------------
// SDK State
// ---------------------------------------------------------------------------

let sdk: NodeSDK | null = null;
let tracer: Tracer | null = null;
let initializationAttempted = false;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the OpenTelemetry SDK for tracing.
 * This should be called once at extension load time.
 * Safe to call multiple times - only initializes once.
 */
export function initTracing(): void {
  if (initializationAttempted) return;
  initializationAttempted = true;

  if (!isTracingEnabled()) {
    return;
  }

  try {
    const serviceName = getServiceName();
    
    // Create resource with service info using resourceFromAttributes
    const resource = resourceFromAttributes({
      [SEMRESATTRS_SERVICE_NAME]: serviceName,
      [SEMRESATTRS_SERVICE_VERSION]: '1.0.0',
    });

    // Create OTLP exporter if endpoint is configured
    let exporter = undefined;
    if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
      exporter = new OTLPTraceExporter({
        url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`,
      });
    }

    // Create SDK with trace exporter
    sdk = new NodeSDK({
      resource,
      spanProcessors: exporter ? [new BatchSpanProcessor(exporter)] : [],
    });

    sdk.start();

    // Get tracer for creating spans
    tracer = trace.getTracer(serviceName, '1.0.0');

  } catch (err) {
    console.error('[TRACING] Failed to initialize OpenTelemetry:', err);
  }
}

/**
 * Shutdown the OpenTelemetry SDK gracefully.
 * Should be called when the extension is unloaded.
 */
export async function shutdownTracing(): Promise<void> {
  if (sdk) {
    try {
      await sdk.shutdown();
    } catch (err) {
      console.error('[TRACING] Error shutting down SDK:', err);
    }
    sdk = null;
    tracer = null;
    initializationAttempted = false;
  }
}

// ---------------------------------------------------------------------------
// Tracing Types
// ---------------------------------------------------------------------------

export type PiiCheckDirection = 'input' | 'output';

export type PiiCheckResult = 'allowed' | 'denied';

export type PiiCheckAttributes = {
  /** Direction of the check: 'input' (model viewing) or 'output' (model sharing) */
  direction: PiiCheckDirection;
  /** The model ID performing the check */
  modelId: string;
  /** The recipient ID (for output checks only) */
  recipientId?: string;
  /** Number of PII entities detected */
  entityCount: number;
  /** List of PII categories detected (without values) */
  categories: string[];
  /** Overall result: 'allowed' or 'denied' */
  result: PiiCheckResult;
  /** Number of entities that were denied */
  deniedCount: number;
  /** Whether OpenFGA was available */
  openFgaAvailable: boolean;
  /** Duration of the check in milliseconds */
  durationMs: number;
  /** For output checks: whether lineage check passed */
  lineageValid?: boolean;
  /** For output checks: whether recipient trust check was performed */
  recipientTrustChecked?: boolean;
  /** For output checks: whether recipient trust check passed */
  recipientTrustValid?: boolean;
};

// ---------------------------------------------------------------------------
// Tracing Functions
// ---------------------------------------------------------------------------

/**
 * Get the tracer instance, initializing if necessary.
 * Returns null if tracing is not enabled or initialization failed.
 */
function getTracer(): Tracer | null {
  if (!tracer && !initializationAttempted) {
    // Try lazy initialization
    initTracing();
  }
  return tracer;
}

/**
 * Create a span for a PII check operation.
 * 
 * @param operationName - Name of the operation (e.g., 'pii_input_check', 'pii_output_check')
 * @param attributes - Attributes to record (no PII values!)
 * @param fn - The function to execute within the span
 * @returns The result of fn, with tracing around it
 */
export async function tracePiiCheck<T>(
  operationName: string,
  attributes: PiiCheckAttributes,
  fn: () => Promise<T>
): Promise<T> {
  const currentTracer = getTracer();
  
  if (!currentTracer) {
    // Tracing not enabled, just execute the function
    return fn();
  }

  const spanName = `pii.${operationName}`;
  
  // Filter attributes to only include safe ones (no PII)
  const safeAttributes: Attributes = {
    'pii.direction': attributes.direction,
    'pii.model_id': attributes.modelId,
    'pii.entity_count': attributes.entityCount,
    'pii.categories': attributes.categories.join(','),
    'pii.result': attributes.result,
    'pii.denied_count': attributes.deniedCount,
    'pii.openfga_available': attributes.openFgaAvailable,
    'pii.check_duration_ms': attributes.durationMs,
  };

  // Add output-specific attributes
  if (attributes.direction === 'output') {
    if (attributes.recipientId) {
      safeAttributes['pii.recipient_id'] = attributes.recipientId;
    }
    if (attributes.lineageValid !== undefined) {
      safeAttributes['pii.lineage_valid'] = attributes.lineageValid;
    }
    if (attributes.recipientTrustChecked !== undefined) {
      safeAttributes['pii.recipient_trust_checked'] = attributes.recipientTrustChecked;
    }
    if (attributes.recipientTrustValid !== undefined) {
      safeAttributes['pii.recipient_trust_valid'] = attributes.recipientTrustValid;
    }
  }

  return currentTracer.startActiveSpan(spanName, async (span: Span) => {
    try {
      // Set span attributes
      for (const [key, value] of Object.entries(safeAttributes)) {
        if (value !== undefined) {
          span.setAttribute(key, value);
        }
      }

      // Set span status based on result
      span.setStatus({
        code: attributes.result === 'denied' ? SpanStatusCode.OK : SpanStatusCode.OK,
      });

      // Add result event
      span.addEvent('pii_check_completed', {
        'pii.result': attributes.result,
        'pii.denied_categories': attributes.deniedCount > 0 ? attributes.categories.filter((_, i) => i < attributes.deniedCount).join(',') : 'none',
      });

      const result = await fn();
      return result;

    } catch (err) {
      // Record error in span
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : 'Unknown error',
      });
      span.recordException(err as Error);
      throw err;

    } finally {
      span.end();
    }
  });
}

/**
 * Create a simple span for a single PII check without callback pattern.
 * Useful for simple, synchronous operations.
 */
export function createPiiCheckSpan(
  operationName: string,
  attributes: PiiCheckAttributes
): Span | null {
  const currentTracer = getTracer();
  if (!currentTracer) return null;

  const spanName = `pii.${operationName}`;
  const span = currentTracer.startSpan(spanName);

  const safeAttributes: Attributes = {
    'pii.direction': attributes.direction,
    'pii.model_id': attributes.modelId,
    'pii.entity_count': attributes.entityCount,
    'pii.categories': attributes.categories.join(','),
    'pii.result': attributes.result,
    'pii.denied_count': attributes.deniedCount,
    'pii.openfga_available': attributes.openFgaAvailable,
    'pii.check_duration_ms': attributes.durationMs,
  };

  if (attributes.direction === 'output' && attributes.recipientId) {
    safeAttributes['pii.recipient_id'] = attributes.recipientId;
  }

  for (const [key, value] of Object.entries(safeAttributes)) {
    if (value !== undefined) {
      span.setAttribute(key, value);
    }
  }

  return span;
}

/**
 * End a span with the result.
 */
export function endPiiCheckSpan(
  span: Span | null,
  attributes: PiiCheckAttributes,
  error?: Error
): void {
  if (!span) return;

  if (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error.message,
    });
    span.recordException(error);
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
    span.addEvent('pii_check_completed', {
      'pii.result': attributes.result,
    });
  }

  span.end();
}