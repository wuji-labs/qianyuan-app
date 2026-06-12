import { randomUUID } from 'node:crypto';

import type { TerminalInputInjectionV1 } from '@/agent/runtime/terminal/TerminalInputInjectionV1';
import { hasMultilinePayload } from '@/agent/runtime/terminal/injection/bracketedPaste';
import {
  TERMINAL_INPUT_MAX_WAIT_MS,
  TERMINAL_INPUT_QUIET_PERIOD_MS,
} from '@/agent/runtime/terminal/injection/arbiter';

import type {
  ClaudeUnifiedPromptBatch,
  ClaudeUnifiedPromptInjectionOptions,
  ClaudeUnifiedPromptInjector,
} from './_types';
import type { ClaudeUnifiedTelemetrySink } from './telemetry';
import { emitClaudeUnifiedInjectionDraftGuard, emitClaudeUnifiedInjectionOutcome } from './telemetry';

// Guard-deferral retry delay: an idle session has no turn-end/readiness wake, so deferrals must
// arm their own retry timer (live-proven starvation, runner pid 20327).
const DRAFT_GUARD_RETRY_MS = 2_000;

/**
 * Outcome of the pre-injection composer guard (C11): screen-lite projection of
 * `OwnComposerDraftGuardResult` so the injector does not depend on parsed screen state.
 */
export type ClaudeUnifiedComposerDraftGuardOutcome = Readonly<{
  status: 'no_draft' | 'cleared' | 'foreign_draft' | 'generating' | 'capture_failed' | 'clear_failed';
  attempts?: number | undefined;
  draftLength?: number | undefined;
}>;

export function createClaudeUnifiedPromptInjector<Mode = unknown>(opts: Readonly<{
  inputInjection: TerminalInputInjectionV1;
  createNonce?: (() => string) | undefined;
  telemetry?: ClaudeUnifiedTelemetrySink | undefined;
  /**
   * C11 (live-proven, runner pid 83791): idle injection typed the new prompt AFTER a leftover
   * composer draft and submitted the concatenation as one corrupted prompt. When provided, the
   * guard runs before every non-steer write: own leftovers are cleared (bounded), a genuine user
   * draft or an uncleared leftover defers the injection untouched. In-flight steers skip the
   * guard — the steer evaluator already owns that screen's draft policy.
   */
  composerDraftGuard?: (() => Promise<ClaudeUnifiedComposerDraftGuardOutcome>) | undefined;
  onInjected?: ((batch: ClaudeUnifiedPromptBatch<Mode>) => void | Promise<void>) | undefined;
}>): ClaudeUnifiedPromptInjector<Mode> {
  const createNonce = opts.createNonce ?? randomUUID;

  return {
    async injectPrompt(
      batch: ClaudeUnifiedPromptBatch<Mode>,
      options?: ClaudeUnifiedPromptInjectionOptions | undefined,
    ) {
      const multiline = hasMultilinePayload(batch.message);
      const text = batch.message;
      const inFlightSteer = options?.inFlightSteer === true;

      if (opts.composerDraftGuard && !inFlightSteer) {
        const guard = await opts.composerDraftGuard();
        if (opts.telemetry && guard.status !== 'no_draft') {
          emitClaudeUnifiedInjectionDraftGuard(opts.telemetry, {
            status: guard.status,
            ...(guard.attempts !== undefined ? { attempts: guard.attempts } : {}),
            ...(guard.draftLength !== undefined ? { draftLength: guard.draftLength } : {}),
            originKind: batch.origin.kind,
          });
        }
        if (guard.status === 'foreign_draft' || guard.status === 'clear_failed') {
          // Never write next to a draft we may not own: defer WITH a retry delay — an idle
          // session has no turn-end/readiness wake, so a bare deferral would starve the head
          // prompt forever (live-proven, runner pid 20327).
          return { status: 'deferred', reason: 'user_typing', retryAfterMs: DRAFT_GUARD_RETRY_MS };
        }
      }

      const input = {
        text,
        multiline,
        origin: {
          kind: batch.origin.kind,
          clientId: batch.origin.clientId,
          nonce: batch.origin.nonce ?? createNonce(),
        },
        // In-flight steers write into an actively-generating screen, which is never "quiet";
        // the steer-safety screen evaluation already vetoed visible user drafts, so the
        // adapter-level quiet-screen deferral must be skipped for them.
        scheduling: {
          ...(inFlightSteer ? {} : { deferredUntilQuietMs: TERMINAL_INPUT_QUIET_PERIOD_MS }),
          timeoutMs: TERMINAL_INPUT_MAX_WAIT_MS,
        },
      } as const;
      const result = await opts.inputInjection.injectUserPrompt(input);
      if (opts.telemetry) {
        emitClaudeUnifiedInjectionOutcome(opts.telemetry, {
          result,
          hostKind: opts.inputInjection.hostKind,
          multiline,
          originKind: batch.origin.kind,
          ...(inFlightSteer ? { inFlightSteer: true } : {}),
        });
      }
      if (result.status === 'injected') {
        await opts.onInjected?.(batch);
      }
      return result;
    },
  };
}
