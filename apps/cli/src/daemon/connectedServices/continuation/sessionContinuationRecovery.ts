import { createHash } from 'node:crypto';

import {
  SESSION_CONTINUATION_RECOVERY_METADATA_KEY,
  SessionContinuationRecoveryV1Schema,
  type SessionContinuationRecoveryAttemptV1,
  type SessionContinuationRecoveryV1,
  type SessionContinuationResumePromptModeV1,
} from '@happier-dev/protocol';

type ContinuationStore = Readonly<{
  read: (sessionId: string) => Promise<unknown | null> | unknown | null;
  write: (sessionId: string, state: unknown) => Promise<void> | void;
}>;

type SessionContinuationRecoveryControllerDeps = Readonly<{
  nowMs: () => number;
  store: ContinuationStore;
}>;

type BeginContinuationAttemptInput = Readonly<{
  sessionId: string;
  attemptId: string;
  failureAtMs: number;
  resumePromptMode: SessionContinuationResumePromptModeV1;
}>;

type ResolveContinuationAttemptInput = BeginContinuationAttemptInput & Readonly<{
  exactProviderContextAvailable: boolean;
  hasUserMessageAfterFailure: () => Promise<boolean> | boolean;
  sendContinuationPrompt: (input: { prompt: string; localId: string }) => Promise<void> | void;
}>;

type ResolveContinuationAttemptResult = Readonly<{
  status:
    | 'sent'
    | 'already_sent'
    | 'suppressed_newer_user_input'
    | 'retry_required'
    | 'continuity_failed';
}>;

const terminalStatuses = new Set<SessionContinuationRecoveryAttemptV1['status']>([
  'sent',
  'suppressed_newer_user_input',
  'retry_required',
  'continuity_failed',
]);

function createEmptyRecovery(): SessionContinuationRecoveryV1 {
  return {
    v: 1,
    attemptsById: {},
  };
}

async function readRecovery(store: ContinuationStore, sessionId: string): Promise<SessionContinuationRecoveryV1> {
  const stored = await store.read(sessionId);
  const direct = SessionContinuationRecoveryV1Schema.safeParse(stored);
  if (direct.success) return direct.data;
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    const nested = (stored as Record<string, unknown>)[SESSION_CONTINUATION_RECOVERY_METADATA_KEY];
    const parsedNested = SessionContinuationRecoveryV1Schema.safeParse(nested);
    if (parsedNested.success) return parsedNested.data;
  }
  return createEmptyRecovery();
}

async function writeRecovery(
  store: ContinuationStore,
  sessionId: string,
  recovery: SessionContinuationRecoveryV1,
): Promise<void> {
  await store.write(sessionId, recovery);
}

function buildAttempt(
  input: BeginContinuationAttemptInput,
  status: SessionContinuationRecoveryAttemptV1['status'],
  updatedAtMs: number,
  extra?: Readonly<Pick<SessionContinuationRecoveryAttemptV1, 'sentAtMs' | 'errorCode'>>,
): SessionContinuationRecoveryAttemptV1 {
  return {
    v: 1,
    attemptId: input.attemptId,
    status,
    failureAtMs: input.failureAtMs,
    updatedAtMs,
    resumePromptMode: input.resumePromptMode,
    ...(extra?.sentAtMs === undefined ? {} : { sentAtMs: extra.sentAtMs }),
    ...(extra?.errorCode === undefined ? {} : { errorCode: extra.errorCode }),
  };
}

function resolveTerminalStatus(
  status: SessionContinuationRecoveryAttemptV1['status'],
): ResolveContinuationAttemptResult | null {
  if (status === 'sent') return { status: 'already_sent' };
  if (status === 'suppressed_newer_user_input') return { status };
  if (status === 'retry_required') return { status };
  if (status === 'continuity_failed') return { status };
  return null;
}

function buildContinuationPromptLocalId(input: Readonly<{
  sessionId: string;
  attemptId: string;
}>): string {
  const digest = createHash('sha256')
    .update(input.sessionId)
    .update('\0')
    .update(input.attemptId)
    .digest('hex')
    .slice(0, 32);
  return `connected-service-continuation:${digest}`;
}

export function createSessionContinuationRecoveryController(
  deps: SessionContinuationRecoveryControllerDeps,
) {
  async function setAttempt(
    input: BeginContinuationAttemptInput,
    status: SessionContinuationRecoveryAttemptV1['status'],
    extra?: Readonly<Pick<SessionContinuationRecoveryAttemptV1, 'sentAtMs' | 'errorCode'>>,
  ): Promise<SessionContinuationRecoveryV1> {
    const recovery = await readRecovery(deps.store, input.sessionId);
    recovery.attemptsById[input.attemptId] = buildAttempt(input, status, deps.nowMs(), extra);
    await writeRecovery(deps.store, input.sessionId, recovery);
    return recovery;
  }

  async function resolveAttempt(input: ResolveContinuationAttemptInput): Promise<ResolveContinuationAttemptResult> {
    const recovery = await readRecovery(deps.store, input.sessionId);
    const existing = recovery.attemptsById[input.attemptId];
    const terminalResult = existing ? resolveTerminalStatus(existing.status) : null;
    if (terminalResult) return terminalResult;
    if (existing?.status === 'sending') {
      if (existing.sentAtMs !== undefined) {
        await setAttempt(input, 'sent', { sentAtMs: existing.sentAtMs });
        return { status: 'already_sent' };
      }
    }

    if (input.resumePromptMode === 'off') {
      await setAttempt(input, 'retry_required', { errorCode: 'resume_prompt_disabled' });
      return { status: 'retry_required' };
    }
    if (!input.exactProviderContextAvailable) {
      await setAttempt(input, 'retry_required', { errorCode: 'provider_context_unavailable' });
      return { status: 'retry_required' };
    }
    if (await input.hasUserMessageAfterFailure()) {
      await setAttempt(input, 'suppressed_newer_user_input');
      return { status: 'suppressed_newer_user_input' };
    }

    await setAttempt(input, 'sending');
    try {
      await input.sendContinuationPrompt({
        prompt: 'Please continue the interrupted work from the recovered provider context. Do not restart or repeat completed work.',
        localId: buildContinuationPromptLocalId(input),
      });
    } catch {
      await setAttempt(input, 'retry_required', { errorCode: 'continuation_prompt_failed' });
      return { status: 'retry_required' };
    }
    const sentAtMs = deps.nowMs();
    await setAttempt(input, 'sending', { sentAtMs });
    await setAttempt(input, 'sent', { sentAtMs });
    return { status: 'sent' };
  }

  return {
    async beginAttempt(input: BeginContinuationAttemptInput): Promise<SessionContinuationRecoveryV1> {
      const recovery = await readRecovery(deps.store, input.sessionId);
      const existing = recovery.attemptsById[input.attemptId];
      if (existing && terminalStatuses.has(existing.status)) return recovery;
      recovery.attemptsById[input.attemptId] = buildAttempt(
        input,
        'pending_provider_context',
        deps.nowMs(),
      );
      await writeRecovery(deps.store, input.sessionId, recovery);
      return recovery;
    },

    resolveAttempt,

    async resolvePendingAttempts(input: Readonly<{
      sessionId: string;
      exactProviderContextAvailable: boolean;
      hasUserMessageAfterFailure: (input: { failureAtMs: number }) => Promise<boolean> | boolean;
      sendContinuationPrompt: (input: { prompt: string; localId: string }) => Promise<void> | void;
    }>): Promise<{ resolved: Array<{ attemptId: string; status: ResolveContinuationAttemptResult['status'] }> }> {
      const recovery = await readRecovery(deps.store, input.sessionId);
      const unresolvedAttempts = Object.values(recovery.attemptsById)
        .filter((attempt) => !terminalStatuses.has(attempt.status));
      const resolved: Array<{ attemptId: string; status: ResolveContinuationAttemptResult['status'] }> = [];
      for (const attempt of unresolvedAttempts) {
        const result = await resolveAttempt({
          sessionId: input.sessionId,
          attemptId: attempt.attemptId,
          failureAtMs: attempt.failureAtMs,
          resumePromptMode: attempt.resumePromptMode,
          exactProviderContextAvailable: input.exactProviderContextAvailable,
          hasUserMessageAfterFailure: () =>
            input.hasUserMessageAfterFailure({ failureAtMs: attempt.failureAtMs }),
          sendContinuationPrompt: input.sendContinuationPrompt,
        });
        resolved.push({ attemptId: attempt.attemptId, status: result.status });
      }
      return { resolved };
    },
  };
}
