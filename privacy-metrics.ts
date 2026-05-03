// SPDX-License-Identifier: Apache-2.0
/**
 * Metrics collection and OTLP/Prometheus push for the Privacy Filter extension.
 *
 * Tracks:
 * - pii_entities_detected (counter): total PII entities found across all invocations
 * - auth_decisions_allowed (counter): category + literal checks that returned allowed
 * - auth_decisions_denied (counter): category + literal checks that returned denied
 * - auth_errors (counter): OpenFGA check() calls that threw
 * - fail_closed_events (counter): invocations where all categories were masked
 * - openfga_check_duration_ms (histogram): latency of each OpenFGA check call
 *
 * Metrics are pushed to an OTLP endpoint (via HTTP/OTLP protocol) or to a
 * Prometheus Pushgateway at a configurable interval.
 *
 * Metrics are also captured in memory for integration test inspection via
 * setCaptureCallback() / getCapture().
 */

import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const OTEL_ENDPOINT =
  process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ||
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
  process.env.PUSHGATEWAY_URL ||
  '';

const PUSH_INTERVAL_MS = parseInt(process.env.METRICS_PUSH_INTERVAL_MS || '30000', 10);
const PUSH_JOB = process.env.METRICS_JOB || 'pii-extension';
const METRICS_ENABLED = process.env.METRICS_ENABLED === 'true' && OTEL_ENDPOINT !== '';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MetricType = 'counter' | 'histogram';

export type CounterValue = {
  type: 'counter';
  name: string;
  value: number;
  attributes: Record<string, string>;
};

export type HistogramValue = {
  type: 'histogram';
  name: string;
  count: number;
  sum: number;
  min: number;
  max: number;
  explicitBounds: number[];
  attributes: Record<string, string>;
};

export type MetricSnapshot = CounterValue | HistogramValue;

export type CaptureCallback = (snapshot: MetricSnapshot[]) => void;

let captureCallback: CaptureCallback | null = null;

export function setCaptureCallback(fn: CaptureCallback | null): void {
  captureCallback = fn;
}

export function getCapture(): MetricSnapshot[] {
  return takeSnapshot();
}

// ---------------------------------------------------------------------------
// Metric state
// ---------------------------------------------------------------------------

type HistogramState = {
  count: number;
  sum: number;
  min: number;
  max: number;
};

const _counters = new Map<string, number>();
const _histograms = new Map<string, HistogramState>();

function counterKey(name: string, attributes: Record<string, string>): string {
  const attrStr = Object.keys(attributes)
    .sort()
    .map(k => `${k}=${attributes[k]}`)
    .join(',');
  return `${name}#${attrStr}`;
}

function recordCounter(name: string, attributes: Record<string, string>, increment = 1): void {
  const key = counterKey(name, attributes);
  _counters.set(key, (_counters.get(key) ?? 0) + increment);
  const snapshot = takeSnapshot();
  captureCallback?.(snapshot);
}

function recordHistogram(
  name: string,
  attributes: Record<string, string>,
  value: number,
): void {
  const key = counterKey(name, attributes);
  const existing = _histograms.get(key) ?? { count: 0, sum: 0, min: Infinity, max: -Infinity };
  existing.count++;
  existing.sum += value;
  existing.min = Math.min(existing.min, value);
  existing.max = Math.max(existing.max, value);
  _histograms.set(key, existing);
  const snapshot = takeSnapshot();
  captureCallback?.(snapshot);
}

function takeSnapshot(): MetricSnapshot[] {
  const snapshots: MetricSnapshot[] = [];
  for (const [key, value] of _counters) {
    const [name, ...attrParts] = key.split('#');
    const attr: Record<string, string> = {};
    for (const part of attrParts) {
      const [k, v] = part.split('=');
      attr[k] = v;
    }
    snapshots.push({ type: 'counter', name, value, attributes: attr });
  }
  for (const [key, state] of _histograms) {
    const [name, ...attrParts] = key.split('#');
    const attr: Record<string, string> = {};
    for (const part of attrParts) {
      const [k, v] = part.split('=');
      attr[k] = v;
    }
    snapshots.push({
      type: 'histogram',
      name,
      count: state.count,
      sum: state.sum,
      min: state.min === Infinity ? 0 : state.min,
      max: state.max === -Infinity ? 0 : state.max,
      explicitBounds: [5, 10, 25, 50, 100, 250, 500, 1000],
      attributes: attr,
    });
  }
  return snapshots;
}

// ---------------------------------------------------------------------------
// Public API — called by authorization logic
// ---------------------------------------------------------------------------

/** Record that PII entities were detected (call once per before_agent_start) */
export function recordPiiDetected(count: number): void {
  if (!METRICS_ENABLED && !captureCallback) return;
  recordCounter('pii_entities_detected', {}, count);
}

/** Record an auth_allowed outcome at the given level */
export function recordAuthAllowed(level: 'category' | 'literal', model: string, category: string): void {
  if (!METRICS_ENABLED && !captureCallback) return;
  recordCounter('auth_decisions_allowed', { level, model, category });
}

/** Record an auth_denied outcome at the given level */
export function recordAuthDenied(level: 'category' | 'literal', model: string, category: string): void {
  if (!METRICS_ENABLED && !captureCallback) return;
  recordCounter('auth_decisions_denied', { level, model, category });
}

/** Record an OpenFGA check() error */
export function recordAuthError(model: string, category: string): void {
  if (!METRICS_ENABLED && !captureCallback) return;
  recordCounter('auth_errors', { model, category });
}

/** Record a fail-closed event */
export function recordFailClosed(reason: string, model: string): void {
  if (!METRICS_ENABLED && !captureCallback) return;
  recordCounter('fail_closed_events', { reason, model });
}

/** Record the latency of a single OpenFGA check call in milliseconds */
export function recordCheckDuration(durationMs: number): void {
  if (!METRICS_ENABLED && !captureCallback) return;
  recordHistogram('openfga_check_duration_ms', {}, durationMs);
}

// ---------------------------------------------------------------------------
// OTLP HTTP push
// ---------------------------------------------------------------------------

let _pushTimer: ReturnType<typeof setInterval> | null = null;

function otlpPayload(snapshots: MetricSnapshot[]): string {
  // OTLP JSON metric format (simplified — compatible with otel-collector)
  const resourceMetrics = [
    {
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'pii-extension' } },
          { key: 'service.version', value: { stringValue: '1.0.0' } },
        ],
      },
      scopeMetrics: [
        {
          scope: { name: 'pii-extension', version: '1.0.0' },
          metrics: snapshots.map(s => metricToOtlp(s)),
        },
      ],
    },
  ];
  return JSON.stringify({ resourceMetrics });
}

function metricToOtlp(s: MetricSnapshot): Record<string, unknown> {
  if (s.type === 'counter') {
    return {
      name: s.name,
      sum: {
        dataPoints: [
          {
            asInt: s.value,
            timeUnixNano: Date.now() * 1_000_000,
            attributes: Object.entries(s.attributes).map(([k, v]) => ({ key: k, value: { stringValue: v } })),
          },
        ],
        isMonotonic: true,
        aggregationTemporality: 'AGGREGATION_TEMPORALITY_CUMULATIVE',
      },
    };
  } else {
    return {
      name: s.name,
      histogram: {
        dataPoints: [
          {
            count: s.count,
            sum: s.sum,
            min: { asDouble: s.min },
            max: { asDouble: s.max },
            timeUnixNano: Date.now() * 1_000_000,
            explicitBoundCount: s.explicitBounds.length,
            buckets: s.explicitBounds.map(b => ({ count: 0, boundary: b })),
            attributes: Object.entries(s.attributes).map(([k, v]) => ({ key: k, value: { stringValue: v } })),
          },
        ],
        aggregationTemporality: 'AGGREGATION_TEMPORALITY_CUMULATIVE',
      },
    };
  }
}

async function pushMetrics(): Promise<void> {
  if (!OTEL_ENDPOINT) return;
  const snapshots = takeSnapshot();
  if (snapshots.length === 0) return;

  // Determine endpoint type: if URL contains '/metrics', treat as Pushgateway
  const isPushgateway = OTEL_ENDPOINT.includes('/metrics');

  if (isPushgateway) {
    // Prometheus Pushgateway format
    const lines = snapshots.map(s => {
      if (s.type === 'counter') {
        const attrs = Object.entries(s.attributes)
          .map(([k, v]) => `${k}="${v}"`)
          .join(',');
        const labels = attrs ? `{${attrs}}` : '';
        return `# TYPE ${s.name} counter\n${s.name}${labels} ${s.value}`;
      } else {
        const attrs = Object.entries(s.attributes)
          .map(([k, v]) => `${k}="${v}"`)
          .join(',');
        const labels = attrs ? `{${attrs}}` : '';
        return `# TYPE ${s.name} histogram\n${s.name}${labels}_count ${s.count}\n${s.name}${labels}_sum ${s.sum}`;
      }
    }).join('\n');

    try {
      const url = `${OTEL_ENDPOINT.replace(/\/$/, '')}/metrics/job/${PUSH_JOB}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: lines,
      });
      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.error(`[privacy-metrics] pushgateway failed: ${res.status}`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[privacy-metrics] pushgateway error: ${(err as Error).message}`);
    }
  } else {
    // OTLP HTTP format
    try {
      const endpoint = OTEL_ENDPOINT.endsWith('/v1/metrics')
        ? OTEL_ENDPOINT
        : OTEL_ENDPOINT.replace(/\/$/, '') + '/v1/metrics';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: otlpPayload(snapshots),
      });
      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.error(`[privacy-metrics] push failed: ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[privacy-metrics] push error: ${(err as Error).message}`);
    }
  }
}

/** Start periodic OTLP push. Idempotent. */
export function startMetrics(): void {
  if (!METRICS_ENABLED || _pushTimer !== null) return;
  _pushTimer = setInterval(pushMetrics, PUSH_INTERVAL_MS);
  // Push immediately on start
  pushMetrics();
}

/** Stop periodic push and reset all counters. */
export function stopMetrics(): void {
  if (_pushTimer !== null) {
    clearInterval(_pushTimer);
    _pushTimer = null;
  }
  resetMetrics();
}

/** Reset all in-memory counters (does not affect OTEL backend). */
export function resetMetrics(): void {
  _counters.clear();
  _histograms.clear();
}