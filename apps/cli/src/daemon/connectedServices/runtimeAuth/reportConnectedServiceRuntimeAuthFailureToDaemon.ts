import { notifyDaemonConnectedServiceRuntimeAuthFailure } from '@/daemon/controlClient';
import { logger as defaultLogger } from '@/ui/logger';
import { resolveConnectedServiceRuntimeAuthFailureStatusMessage } from './resolveConnectedServiceRuntimeAuthFailureStatusMessage';
import {
  normalizeConnectedServiceRuntimeAuthRecoveryProjection,
  type ConnectedServiceRuntimeAuthRecoveryProjection,
} from './projection/connectedServiceRuntimeAuthRecoveryProjection';
import {
  enqueueRuntimeAuthFailureReportOutboxItem,
  removeRuntimeAuthFailureReportOutboxItem,
  resolveRuntimeAuthFailureReportOutboxKey,
} from './reportOutbox/runtimeAuthFailureReportOutbox';

type RuntimeAuthFailureNotifyBody = Readonly<{
  sessionId: string;
  switchesThisTurn?: number;
  classification: unknown;
}>;

type RuntimeAuthFailureNotifyOptions = Readonly<{
  timeoutMs?: number;
}>;

type RuntimeAuthFailureNotify = (
  body: RuntimeAuthFailureNotifyBody,
  options?: RuntimeAuthFailureNotifyOptions,
) => Promise<unknown>;

type RuntimeAuthFailureLogger = Readonly<{
  debug: (message: string, error?: unknown) => void;
}>;

export type ConnectedServiceRuntimeAuthFailureDaemonReport = Readonly<{
  handled: boolean;
  report: unknown | null;
  statusCode: string | null;
  statusMessage: string | null;
  uxDiagnostic?: ConnectedServiceRuntimeAuthRecoveryProjection['uxDiagnostic'];
  projection?: ConnectedServiceRuntimeAuthRecoveryProjection;
}>;

export const CONNECTED_SERVICE_RUNTIME_AUTH_FAILURE_REPORT_TIMEOUT_MS = 120_000;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function isUnhandledLocalControlErrorReport(report: unknown): boolean {
  const record = readRecord(report);
  if (!record) return false;
  if (record.ok === false || record.success === false) return true;
  if (typeof record.error === 'string' && record.error.trim().length > 0) return true;
  return typeof record.errorCode === 'string' && record.errorCode.trim().length > 0 && record.ok !== true;
}

export async function reportConnectedServiceRuntimeAuthFailureToDaemon(input: Readonly<{
  sessionId: string;
  switchesThisTurn?: number;
  classification: unknown;
  notify?: RuntimeAuthFailureNotify;
  logger?: RuntimeAuthFailureLogger;
  logPrefix?: string;
  reportOutboxDir?: string;
  nowMs?: () => number;
}>): Promise<ConnectedServiceRuntimeAuthFailureDaemonReport> {
  const notify = input.notify ?? notifyDaemonConnectedServiceRuntimeAuthFailure;
  const logger = input.logger ?? defaultLogger;
  const logPrefix = input.logPrefix ?? '[connected-services]';
  const reportBody = {
    sessionId: input.sessionId,
    switchesThisTurn: input.switchesThisTurn ?? 0,
    classification: input.classification,
  };

  async function enqueueOutboxBestEffort(): Promise<void> {
    try {
      await enqueueRuntimeAuthFailureReportOutboxItem({
        ...(input.reportOutboxDir ? { outboxDir: input.reportOutboxDir } : {}),
        report: reportBody,
        ...(input.nowMs ? { nowMs: input.nowMs } : {}),
      });
    } catch (error) {
      logger.debug(`${logPrefix} Failed to enqueue connected-service runtime auth failure report outbox item (non-fatal)`, error);
    }
  }

  async function removeOutboxBestEffort(): Promise<void> {
    const reportKey = resolveRuntimeAuthFailureReportOutboxKey(reportBody);
    if (!reportKey) return;
    try {
      await removeRuntimeAuthFailureReportOutboxItem({
        ...(input.reportOutboxDir ? { outboxDir: input.reportOutboxDir } : {}),
        reportKey,
      });
    } catch (error) {
      logger.debug(`${logPrefix} Failed to remove connected-service runtime auth failure report outbox item (non-fatal)`, error);
    }
  }

  try {
    const report = await notify(reportBody, {
      timeoutMs: CONNECTED_SERVICE_RUNTIME_AUTH_FAILURE_REPORT_TIMEOUT_MS,
    });
    const statusNote = resolveConnectedServiceRuntimeAuthFailureStatusMessage(report);
    const projection = normalizeConnectedServiceRuntimeAuthRecoveryProjection({
      report,
      statusNote,
    });
    if (projection.handled) {
      await removeOutboxBestEffort();
    } else if (isUnhandledLocalControlErrorReport(report)) {
      await enqueueOutboxBestEffort();
    }
    return {
      handled: projection.handled,
      report,
      statusCode: projection.statusCode,
      statusMessage: projection.statusMessage,
      ...(projection.uxDiagnostic ? { uxDiagnostic: projection.uxDiagnostic } : {}),
      projection,
    };
  } catch (error) {
    await enqueueOutboxBestEffort();
    logger.debug(`${logPrefix} Failed to report connected-service runtime auth failure to daemon (non-fatal)`, error);
    return {
      handled: false,
      report: null,
      statusCode: null,
      statusMessage: null,
    };
  }
}
