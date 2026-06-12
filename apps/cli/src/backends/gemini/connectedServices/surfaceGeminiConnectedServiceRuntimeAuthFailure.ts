import { updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import type { Metadata } from '@/api/types';
import type { SessionEventMessage } from '@/api/session/sessionMessageTypes';
import { findConnectedServiceChildSelection } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import {
  reportConnectedServiceRuntimeAuthFailureToDaemon,
  type ConnectedServiceRuntimeAuthFailureDaemonReport,
} from '@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';
import { projectConnectedServiceRuntimeAuthRecoveryReport } from '@/daemon/connectedServices/runtimeAuth/projection/connectedServiceRuntimeAuthRecoverySessionEvent';
import type { ConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/types';
import { logger } from '@/ui/logger';

import { createGeminiConnectedServiceRuntimeAuthAdapter } from './createGeminiConnectedServiceRuntimeAuthAdapter';

/**
 * Gemini producer for the connected-services reactive recovery contract (RD-OPI-2).
 *
 * Mirrors the Claude/Codex/Pi/OpenCode suppression contract: raw provider errors are never
 * rendered from here; only the STRUCTURED classification is reported to the daemon
 * (`reportConnectedServiceRuntimeAuthFailureToDaemon`) and only the daemon's typed recovery
 * projection (transcript event / status message) is committed back to the session.
 */
export type GeminiRuntimeAuthFailureSessionClient = Readonly<{
  sessionId: string;
  sendSessionEvent: (event: SessionEventMessage) => void;
  updateMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
}>;

type ReportNotify = NonNullable<Parameters<typeof reportConnectedServiceRuntimeAuthFailureToDaemon>[0]['notify']>;

const geminiRuntimeAuthAdapter = createGeminiConnectedServiceRuntimeAuthAdapter();

const GEMINI_RUNTIME_AUTH_RECOVERY_PROJECTION_DEDUPE_WINDOW_MS = 15_000;

type RecentRecoveryProjectionState = Readonly<{
  key: string;
  surfacedAtMs: number;
}>;

const recentRecoveryProjectionBySession = new WeakMap<
  GeminiRuntimeAuthFailureSessionClient,
  RecentRecoveryProjectionState
>();

/**
 * Classify a Gemini runtime failure against the session's gemini connected-service selection.
 *
 * Reactive recovery reporting is a connected-services contract: a native (non-connected) Gemini
 * session has no selection to refresh/switch, so it classifies to `null` and keeps its existing
 * error surfaces untouched.
 */
export function classifyGeminiConnectedServiceRuntimeAuthFailure(params: Readonly<{
  error: unknown;
  env?: NodeJS.ProcessEnv;
  targetId?: string | null;
}>): ConnectedServiceRuntimeFailureClassification | null {
  const env = params.env ?? process.env;
  const selection = findConnectedServiceChildSelection(env, 'gemini');
  if (!selection) return null;
  return geminiRuntimeAuthAdapter.classifyRuntimeAuthFailure({
    target: { agentId: 'gemini', targetId: params.targetId ?? null },
    error: params.error,
    selection,
  });
}

function buildRecoveryProjectionDedupeKey(input: Readonly<{
  classification: ConnectedServiceRuntimeFailureClassification;
  report: ConnectedServiceRuntimeAuthFailureDaemonReport;
}>): string {
  const transcriptEvent = input.report.projection?.transcriptEvent as
    | Readonly<Record<string, unknown>>
    | undefined;
  return JSON.stringify({
    statusCode: input.report.statusCode ?? null,
    statusMessage: input.report.statusMessage ?? null,
    serviceId: input.classification.serviceId,
    profileId: input.classification.profileId,
    groupId: input.classification.groupId,
    kind: input.classification.kind,
    limitCategory: input.classification.limitCategory ?? null,
    resetsAtMs: input.classification.resetsAtMs,
    retryAfterMs: input.classification.retryAfterMs ?? null,
    transcriptStatus: typeof transcriptEvent?.status === 'string' ? transcriptEvent.status : null,
    nextRetryAtMs: typeof transcriptEvent?.nextRetryAtMs === 'number' ? transcriptEvent.nextRetryAtMs : null,
  });
}

function shouldSuppressDuplicateRecoveryProjection(input: Readonly<{
  session: GeminiRuntimeAuthFailureSessionClient;
  key: string;
  nowMs: number;
}>): boolean {
  const current = recentRecoveryProjectionBySession.get(input.session);
  if (!current) return false;
  if (current.key !== input.key) return false;
  return input.nowMs - current.surfacedAtMs <= GEMINI_RUNTIME_AUTH_RECOVERY_PROJECTION_DEDUPE_WINDOW_MS;
}

/**
 * Report a classified Gemini connected-service runtime failure to the daemon and commit the
 * daemon's typed recovery projection to the session (transcript event preferred, generic status
 * message fallback, usage-limit recovery metadata when applicable). Duplicate projections from
 * adjacent producer paths (transport stderr event, ACP status error, turn-end error) are
 * suppressed within a short window; the daemon report itself is always sent (intent intake is
 * idempotent per `{sessionId, serviceId}`).
 */
export async function surfaceGeminiConnectedServiceRuntimeAuthFailure(params: Readonly<{
  session: GeminiRuntimeAuthFailureSessionClient;
  classification: ConnectedServiceRuntimeFailureClassification;
  logPrefix?: string;
  /** Boundary injection for tests: daemon local-control notify + outbox dir. */
  notify?: ReportNotify;
  reportOutboxDir?: string;
}>): Promise<ConnectedServiceRuntimeAuthFailureDaemonReport> {
  const logPrefix = params.logPrefix ?? '[gemini]';
  const report = await reportConnectedServiceRuntimeAuthFailureToDaemon({
    sessionId: params.session.sessionId,
    switchesThisTurn: 0,
    classification: params.classification,
    logPrefix,
    ...(params.notify ? { notify: params.notify } : {}),
    ...(params.reportOutboxDir ? { reportOutboxDir: params.reportOutboxDir } : {}),
  });

  const dedupeKey = buildRecoveryProjectionDedupeKey({ classification: params.classification, report });
  const nowMs = Date.now();
  if (shouldSuppressDuplicateRecoveryProjection({ session: params.session, key: dedupeKey, nowMs })) {
    return report;
  }

  const result = projectConnectedServiceRuntimeAuthRecoveryReport({
    report,
    classification: params.classification,
    sendGenericStatusMessage: (message) => {
      params.session.sendSessionEvent({ type: 'message', message });
      return true;
    },
    commitTypedProjection: (projection) => {
      if (!projection.transcriptEvent) return false;
      params.session.sendSessionEvent(projection.transcriptEvent);
      return true;
    },
    commitUsageLimitRecoveryMetadata: (updater) => {
      updateMetadataBestEffort(
        params.session,
        updater,
        logPrefix,
        'runtime_auth_usage_limit_recovery',
      );
      return true;
    },
  });
  if (result.emitted) {
    recentRecoveryProjectionBySession.set(params.session, { key: dedupeKey, surfacedAtMs: nowMs });
  }
  return report;
}

/**
 * Fire-and-forget producer entry point for Gemini runtime paths. Returns the classification
 * synchronously (or null when the failure is not a connected-service runtime-auth failure) so
 * callers can attach `runtimeAuthClassification` to the error they surface through
 * `surfacePrimarySessionRuntimeIssue`.
 */
export function reportGeminiConnectedServiceRuntimeAuthFailureBestEffort(params: Readonly<{
  session: GeminiRuntimeAuthFailureSessionClient;
  error: unknown;
  env?: NodeJS.ProcessEnv;
  logPrefix?: string;
}>): ConnectedServiceRuntimeFailureClassification | null {
  const classification = classifyGeminiConnectedServiceRuntimeAuthFailure({
    error: params.error,
    ...(params.env ? { env: params.env } : {}),
  });
  if (!classification) return null;
  void surfaceGeminiConnectedServiceRuntimeAuthFailure({
    session: params.session,
    classification,
    ...(params.logPrefix ? { logPrefix: params.logPrefix } : {}),
  }).catch((error) => {
    logger.debug(`${params.logPrefix ?? '[gemini]'} Failed to surface connected-service runtime auth failure (non-fatal)`, error);
  });
  return classification;
}
