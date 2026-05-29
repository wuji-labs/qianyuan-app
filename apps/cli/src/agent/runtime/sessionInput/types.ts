import type { MaterializeNextPendingResult } from '@/api/session/sessionClientPort';

export type MessageBatch<Mode, Message> = {
  message: Message;
  mode: Mode;
  isolate: boolean;
  hash: string;
};

export type PendingMaterializationReconcileWhenEmpty = 'force' | 'throttled' | 'skip';

export type PendingMaterializationResult = MaterializeNextPendingResult;

export type DrainPendingStoppedReason =
  | 'aborted'
  | 'auth_failure'
  | 'deferred'
  | 'drain_disallowed'
  | 'error'
  | 'materialization_blocked'
  | 'max_pop_per_wake'
  | 'no_pending';

export type DrainPendingOptions = {
  maxPopPerWake?: number | undefined;
  reason?: string | undefined;
  abortSignal?: AbortSignal | undefined;
  shouldContinue?: (() => boolean) | undefined;
  logPrefix?: string | undefined;
};

export type DrainPendingResult = {
  materialized: number;
  stoppedReason: DrainPendingStoppedReason;
};

export interface SessionProviderInputConsumer<Mode, Message> {
  waitForNextInput(opts: { abortSignal: AbortSignal }): Promise<MessageBatch<Mode, Message> | null>;
  drainPending(opts?: DrainPendingOptions): Promise<DrainPendingResult>;
}
