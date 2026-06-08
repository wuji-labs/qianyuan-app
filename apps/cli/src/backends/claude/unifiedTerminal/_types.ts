import type { DrainPendingOptions, DrainPendingResult, MessageBatch } from '@/agent/runtime/sessionInput/types';
import type {
  TerminalHostLiveness,
  TerminalInputInjectionResult,
  TerminalLifecycleObservation,
  TerminalPromptInput,
  TerminalTurnState,
} from '@/agent/runtime/terminal/_types';

export type ClaudeUnifiedPromptOrigin = Readonly<{
  kind: 'ui_pending' | 'ui_immediate' | 'rpc';
  clientId?: string | undefined;
  nonce?: string | undefined;
}>;

export type ClaudeUnifiedPromptBatch<Mode = unknown> = Readonly<{
  message: string;
  mode?: Mode | undefined;
  origin: ClaudeUnifiedPromptOrigin;
}>;

export type ClaudeUnifiedPromptAcceptance = Readonly<{
  acceptedAs: 'new_turn' | 'in_flight_steer';
  turnStateAtInjection: TerminalTurnState;
}>;

export type ClaudeUnifiedPromptAcceptedHandler<Mode = unknown> = (
  batch: ClaudeUnifiedPromptBatch<Mode>,
  acceptance: ClaudeUnifiedPromptAcceptance,
) => void | Promise<void>;

export type ClaudeUnifiedPromptInjectedHandler<Mode = unknown> = (
  batch: ClaudeUnifiedPromptBatch<Mode>,
  acceptance: ClaudeUnifiedPromptAcceptance,
  result: Extract<TerminalInputInjectionResult, { status: 'injected' }>,
) => void | Promise<void>;

export type ClaudeUnifiedPromptInjectionFailure<Mode = unknown> = Readonly<{
  batch: ClaudeUnifiedPromptBatch<Mode>;
  result: Extract<TerminalInputInjectionResult, { status: 'failed' }>;
  failureState: 'failed_ambiguous' | 'failed_terminal';
}>;

export type ClaudeUnifiedPromptInjectionFailureHandler<Mode = unknown> = (
  failure: ClaudeUnifiedPromptInjectionFailure<Mode>,
) => void;

export type ClaudeUnifiedPromptInjector<Mode = unknown> = Readonly<{
  injectPrompt(batch: ClaudeUnifiedPromptBatch<Mode>): Promise<TerminalInputInjectionResult>;
}>;

export type ClaudeUnifiedInputArbiter<Mode = unknown> = Readonly<{
  enqueueUiMessage(batch: ClaudeUnifiedPromptBatch<Mode>): Promise<void>;
  observeLifecycle(observation: TerminalLifecycleObservation): void;
  observeUserTypingState(state: Readonly<{ userTyping: boolean; observedAtMs?: number | undefined }>): void;
  confirmPromptAcceptedByProvider(): Promise<boolean>;
  confirmPromptAcceptedByProviderIf(matcher: (batch: ClaudeUnifiedPromptBatch<Mode>) => boolean): Promise<boolean>;
  drainWhenSafe(): Promise<void>;
  snapshot(): ClaudeUnifiedInputArbiterSnapshot;
  dispose(): Promise<void> | void;
}>;

export type ClaudeUnifiedInputArbiterSnapshot = Readonly<{
  queuedCount: number;
  disposed: boolean;
  turnState: TerminalTurnState;
  permissionBlocked: boolean;
  userTyping: boolean;
  lastDeferredReason: string | null;
  lastFailureReason: string | null;
  headInputState:
    | 'queued'
    | 'waiting_for_readiness'
    | 'injecting'
    | 'awaiting_provider_acceptance'
    | 'submitted'
    | 'failed_retryable'
    | 'failed_ambiguous'
    | 'failed_terminal'
    | null;
}>;

export type ClaudeUnifiedPendingQueuePump<Mode = unknown> = Readonly<{
  pumpOnce(opts: { abortSignal: AbortSignal }): Promise<boolean>;
  drainPending(opts?: DrainPendingOptions): Promise<DrainPendingResult | null>;
  start(opts: { abortSignal: AbortSignal }): Promise<void>;
  dispose(): Promise<void> | void;
}>;

export type ClaudeUnifiedInputConsumer<Mode> = Readonly<{
  waitForNextInput(opts: { abortSignal: AbortSignal }): Promise<MessageBatch<Mode, string> | null>;
  drainPending?: ((opts?: DrainPendingOptions) => Promise<DrainPendingResult>) | undefined;
}>;

export type ClaudeUnifiedTerminalHost = Readonly<{
  evaluateLiveness(): Promise<TerminalHostLiveness>;
  dispose(): Promise<void> | void;
}>;

export type ClaudeUnifiedDisposable = Readonly<{
  dispose(): Promise<void> | void;
}>;

export type ClaudeUnifiedStartableDisposable = ClaudeUnifiedDisposable & Readonly<{
  start(opts: { abortSignal: AbortSignal }): void | Promise<void>;
}>;

export type { TerminalPromptInput };
