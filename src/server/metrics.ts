// Spec 17 D2 — Cloudflare Analytics Engine metrics. `writeMetric` is the one
// call site every emitter goes through: it must NEVER throw into a game path
// or block it, and must be a silent no-op when `env.METRICS` is absent (the
// binding doesn't exist in the pool-workers test environment or anywhere the
// dataset isn't configured).
export interface MetricsEnv {
  METRICS?: AnalyticsEngineDataset;
}

export interface MetricPoint {
  doubles?: number[];
  blobs?: string[];
  indexes?: string[];
}

/** Fire-and-forget: writes one Analytics Engine data point, wrapped so a
 * throw (missing binding methods, malformed args, an AE-side error) can
 * never propagate into the caller. No `await` — callers never block on this.
 * Builds the data point conditionally (rather than passing `undefined`
 * through) because `exactOptionalPropertyTypes` treats an explicit
 * `undefined` value as distinct from an omitted key. */
export function writeMetric(env: MetricsEnv, point: MetricPoint): void {
  try {
    const dataPoint: AnalyticsEngineDataPoint = {};
    if (point.doubles) dataPoint.doubles = point.doubles;
    if (point.blobs) dataPoint.blobs = point.blobs;
    if (point.indexes) dataPoint.indexes = point.indexes;
    env.METRICS?.writeDataPoint(dataPoint);
  } catch {
    // Metrics must never break a game path — silent by contract.
  }
}
