/** Timing knobs. Production uses the defaults; tests shorten them. */
export interface Tuning {
  readonly backoffInitialMs: number;
  readonly backoffMaxMs: number;
  readonly closeGraceMs: number;
  readonly commandTimeoutMs: number;
  /** A child connected at least this long resets restart backoff. */
  readonly healthyResetMs: number;
  readonly liveSweepIntervalMs: number;
  readonly negativeOwnerCacheMs: number;
  readonly presenceTimeoutMs: number;
  readonly readinessPollMs: number;
  readonly readinessTimeoutMs: number;
  readonly sendTimeoutMs: number;
}

export const DEFAULT_TUNING: Tuning = {
  backoffInitialMs: 250,
  backoffMaxMs: 30_000,
  closeGraceMs: 5_000,
  commandTimeoutMs: 30_000,
  healthyResetMs: 60_000,
  liveSweepIntervalMs: 5 * 60_000,
  negativeOwnerCacheMs: 30_000,
  presenceTimeoutMs: 10_000,
  readinessPollMs: 100,
  readinessTimeoutMs: 30_000,
  sendTimeoutMs: 60_000,
};
