import type { RpcHandlerManagerLike } from '@/api/rpc/types';
import type { RawJSONLines } from '@/backends/claude/types';
import type { ACPMessageData, ACPProvider, SessionEventMessage } from './sessionMessageTypes';
import type { AgentState, Metadata } from '../types';
import type { TurnAssistantTextSnapshot } from './turnAssistantTextSnapshot';
import type { CommittedUserMessageSeqWaitOptions } from './committedUserMessageSeqTracker';
import type { SessionTurnLifecycleController } from '@/agent/runtime/session/turn/types';

export type MaterializeNextPendingResult =
  | { type: 'materialized'; localId: string; seq: number; content: unknown | null; createdAt?: number; updatedAt?: number }
  | { type: 'no_pending' }
  | { type: 'deferred'; reason: 'supervisor_offline' | 'supervisor_auth_failed' };

export interface SessionClientPort {
  sessionId: string;
  rpcHandlerManager: RpcHandlerManagerLike;

  sendSessionEvent(event: SessionEventMessage, id?: string): void;
  sendClaudeSessionMessage(message: RawJSONLines, meta?: Record<string, unknown>): void;
  sendAgentMessage(provider: ACPProvider, body: ACPMessageData, opts?: { localId?: string; meta?: Record<string, unknown> }): void;
  sendAgentMessageCommitted(provider: ACPProvider, body: ACPMessageData, opts: { localId: string; meta?: Record<string, unknown> }): Promise<void>;
  sendAgentMessageEphemeral?(
    provider: ACPProvider,
    body: ACPMessageData,
    opts: { localId: string; createdAt: number; updatedAt?: number; meta?: Record<string, unknown> },
  ): void;

  updateMetadata(updater: (metadata: Metadata) => Metadata): void | Promise<void>;
  updateAgentState(updater: (state: AgentState) => AgentState): void | Promise<void>;
  sessionTurnLifecycle?: SessionTurnLifecycleController;

  keepAlive(thinking: boolean, mode: 'local' | 'remote'): void;

  getMetadataSnapshot(): Metadata | null;
  getLastObservedMessageSeq?(): number;
  getCommittedUserMessageSeq?(localId: string): number | null;
  waitForCommittedUserMessageSeq?(
    localId: string,
    options?: CommittedUserMessageSeqWaitOptions,
  ): Promise<number | null>;
  beginTurnAssistantTextSnapshot?(params?: { turnToken?: string; startSeqExclusive?: number | null }): string;
  getTurnAssistantTextSnapshot?(params: {
    turnToken?: string | null;
    startSeqExclusive?: number | null;
  }): TurnAssistantTextSnapshot | null;
  waitForMetadataUpdate(abortSignal?: AbortSignal): Promise<boolean>;
  shouldAttemptPendingMaterialization?(): boolean;
  reconcilePendingQueueState?(opts?: { force?: boolean }): Promise<boolean>;
  materializeNextPendingMessageSafely?(opts?: {
    reconcileWhenEmpty?: 'force' | 'throttled' | 'skip';
  }): Promise<MaterializeNextPendingResult>;
  popPendingMessage(): Promise<boolean>;

  peekPendingMessageQueueV2Count(): Promise<number>;
  discardPendingMessageQueueV2All(opts: { reason: 'switch_to_local' | 'manual' }): Promise<number>;
  discardCommittedMessageLocalIds(opts: { localIds: string[]; reason: 'switch_to_local' | 'manual' }): Promise<number>;

  sendSessionDeath(): void;
  flush(): Promise<void>;
  close(): Promise<void>;

  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
}
