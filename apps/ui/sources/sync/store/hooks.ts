import React from 'react';
import { useShallow } from 'zustand/react/shallow';

import type {
  Automation,
  AutomationRun,
} from '../domains/automations/automationTypes';
import type {
  DiscardedPendingMessage,
  ScmStatus,
  ScmWorkingSnapshot,
  ScmCommitSelectionPatch,
  Machine,
  PendingMessage,
  Session,
} from '../domains/state/storageTypes';
import type { DecryptedArtifact } from '../domains/artifacts/artifactTypes';
import type { LocalSettings } from '../domains/settings/localSettings';
import type { AgentTextMessage, Message } from '../domains/messages/messageTypes';
import type { Settings } from '../domains/settings/settings';
import { settingsDefaults } from '../domains/settings/settings';
import type { SessionListViewItem } from '../domains/session/listing/sessionListViewData';
import type { SessionListRenderableSession } from '../domains/session/listing/sessionListRenderable';
import {
  deriveSessionListAttentionState,
  deriveSessionListMeaningfulActivityAt,
  type SessionListAttentionState,
} from '../domains/session/listing/deriveSessionListActivity';
import { computeHasUnreadActivity } from '../domains/messages/unread';
import { resolveLastViewedSessionSeq } from '../domains/session/readCursor/resolveLastViewedSessionSeq';
import type { SessionState } from '@/utils/sessions/sessionUtils';
import type { ReviewCommentDraft } from '../domains/input/reviewComments/reviewCommentTypes';
import type { SessionActionDraft } from '../domains/sessionActions/sessionActionDraftTypes';
import { buildSessionMessageRouteId, resolveSessionMessageRouteId } from '../domains/messages/messageRouteIds';
import { useApplyLocalSettings, useApplySettings } from './settingsWriters';
import type { PrimaryTurnStatusV1, SessionRuntimeIssueV1 } from '@happier-dev/protocol';

import { getStorage } from '../domains/state/storageStore';
import type { KnownEntitlements } from '../domains/state/storageStore';
import type { ForkedTranscriptSnapshot } from '../domains/sessionFork/forkedTranscriptSnapshot';
import { getForkedTranscriptSnapshotCached } from '../domains/sessionFork/forkedTranscriptSnapshot';
import { resolveVisibleMachinesForActiveServerFromState } from './domains/machines/resolveMachinesForActiveServerFromState';
import { isMachineVisibleForLaunchSelection } from '../domains/machines/identity/filterVisibleMachines';
import { resolveServerIdForSessionIdFromLocalState } from '../runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { buildWorkspaceCacheKey, type WorkspaceScopeBase } from '../domains/workspaces/workspaceScope';
import { buildSessionFolderAssignmentKey } from '../domains/session/folders';
import { readDisplayMachineIdForSession, readDisplayPathForSession } from '../ops/sessionMachineTarget';
import { encodeSessionRecentPathEntry, type SessionRecentPathEntry } from '@/utils/sessions/recentPathEntries';

export function useSessions() {
  const snapshot = getStorage()(
    useShallow((state) => ({
      isDataReady: state.isDataReady,
      sessions: state.sessions,
    }))
  );

  return React.useMemo(() => {
    if (!snapshot.isDataReady) return null;
    return Object.values(snapshot.sessions);
  }, [snapshot.isDataReady, snapshot.sessions]);
}

export function useSessionRecentPathEntries(): SessionRecentPathEntry[] | null {
  return getStorage()(
    useShallow((state) => {
      if (!state.isDataReady) return null;

      const entries: Array<{ key: SessionRecentPathEntry; createdAt: number }> = [];
      for (const session of Object.values(state.sessions)) {
        const machineId = readDisplayMachineIdForSession({
          sessionId: session.id,
          metadata: session.metadata ?? null,
        });
        const path = readDisplayPathForSession({
          sessionId: session.id,
          metadata: session.metadata ?? null,
        });
        if (!machineId || !path) continue;

        const createdAt = session.createdAt || 0;
        entries.push({
          key: encodeSessionRecentPathEntry({
            sessionId: session.id,
            machineId,
            path,
            createdAt,
          }),
          createdAt,
        });
      }

      return entries
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((entry) => entry.key);
    }),
  );
}

export function useSession(id: string): Session | null {
  return getStorage()(useShallow((state) => state.sessions[id] ?? null));
}

export function useSessionListRenderable(id: string): SessionListRenderableSession | null {
  return getStorage()(useShallow((state) => state.sessionListRenderables[id] ?? null));
}

type SessionListRowRenderableSnapshot = Readonly<{
  id: string;
  createdAt: number;
  active: boolean;
  activeAt: number;
  archivedAt: number | null;
  pendingVersion: number | null;
  pendingCount: number | null;
  metadataVersion: number;
  agentStateVersion: number;
  metadataPresent: boolean;
  metadataName: string | null;
  metadataSummaryText: string | null;
  metadataPath: string;
  metadataHomeDir: string | null;
  metadataHost: string | null;
  metadataMachineId: string | null;
  metadataFlavor: string | null;
  metadataDirectProviderId: string | null;
  metadataReadStateSessionSeq: number | null;
  metadataReadStatePendingActivityAt: number | null;
  metadataHiddenSystemSession: boolean;
  thinking: boolean;
  presence: 'online' | number;
  latestTurnStatus: PrimaryTurnStatusV1 | null;
  lastRuntimeIssue: SessionRuntimeIssueV1 | null;
  optimisticThinkingAt: number | null;
  thinkingGraceUntil: number | null;
  owner: string | null;
  accessLevel: 'view' | 'edit' | 'admin' | null;
  canApprovePermissions: boolean | null;
  hasPendingPermissionRequests: boolean | null;
  hasPendingUserActionRequests: boolean | null;
  hasUnreadMessages: boolean;
  keepVisibleWhenInactive: boolean;
  metadataUnavailable: boolean;
}>;

export function useSessionListRowRenderable(id: string): SessionListRenderableSession | null {
  const snapshot = getStorage()(
    useShallow((state): SessionListRowRenderableSnapshot | null => {
      const renderable = state.sessionListRenderables[id];
      if (!renderable) return null;
      const metadata = renderable.metadata;
      return {
        id: renderable.id,
        createdAt: renderable.createdAt,
        active: renderable.active,
        activeAt: renderable.activeAt,
        archivedAt: renderable.archivedAt ?? null,
        pendingVersion: renderable.pendingVersion ?? null,
        pendingCount: renderable.pendingCount ?? null,
        metadataVersion: renderable.metadataVersion,
        agentStateVersion: renderable.agentStateVersion,
        metadataPresent: metadata != null,
        metadataName: metadata?.name ?? null,
        metadataSummaryText: metadata?.summaryText ?? null,
        metadataPath: metadata?.path ?? '',
        metadataHomeDir: metadata?.homeDir ?? null,
        metadataHost: metadata?.host ?? null,
        metadataMachineId: metadata?.machineId ?? null,
        metadataFlavor: metadata?.flavor ?? null,
        metadataDirectProviderId: metadata?.directSessionV1?.providerId ?? null,
        metadataReadStateSessionSeq: metadata?.readStateV1?.sessionSeq ?? null,
        metadataReadStatePendingActivityAt: metadata?.readStateV1?.pendingActivityAt ?? null,
        metadataHiddenSystemSession: metadata?.hiddenSystemSession === true,
        thinking: renderable.thinking,
        presence: renderable.presence,
        latestTurnStatus: renderable.latestTurnStatus ?? null,
        lastRuntimeIssue: renderable.lastRuntimeIssue ?? null,
        optimisticThinkingAt: renderable.optimisticThinkingAt ?? null,
        thinkingGraceUntil: renderable.thinkingGraceUntil ?? null,
        owner: renderable.owner ?? null,
        accessLevel: renderable.accessLevel ?? null,
        canApprovePermissions: renderable.canApprovePermissions ?? null,
        hasPendingPermissionRequests: renderable.hasPendingPermissionRequests ?? null,
        hasPendingUserActionRequests: renderable.hasPendingUserActionRequests ?? null,
        hasUnreadMessages: renderable.hasUnreadMessages === true,
        keepVisibleWhenInactive: renderable.keepVisibleWhenInactive === true,
        metadataUnavailable: renderable.metadataUnavailable === true,
      };
    }),
  );

  return React.useMemo((): SessionListRenderableSession | null => {
    if (!snapshot) return null;
    return {
      id: snapshot.id,
      seq: 0,
      createdAt: snapshot.createdAt,
      updatedAt: 0,
      active: snapshot.active,
      activeAt: snapshot.activeAt,
      archivedAt: snapshot.archivedAt,
      pendingVersion: snapshot.pendingVersion ?? undefined,
      pendingCount: snapshot.pendingCount ?? undefined,
      metadataVersion: snapshot.metadataVersion,
      agentStateVersion: snapshot.agentStateVersion,
      metadata: snapshot.metadataPresent
        ? {
            name: snapshot.metadataName ?? undefined,
            summaryText: snapshot.metadataSummaryText,
            path: snapshot.metadataPath,
            homeDir: snapshot.metadataHomeDir,
            host: snapshot.metadataHost,
            machineId: snapshot.metadataMachineId,
            flavor: snapshot.metadataFlavor,
            directSessionV1: snapshot.metadataDirectProviderId == null
              ? null
              : { v: 1, providerId: snapshot.metadataDirectProviderId },
            readStateV1: snapshot.metadataReadStateSessionSeq == null
              || snapshot.metadataReadStatePendingActivityAt == null
              ? null
              : {
                  v: 1,
                  sessionSeq: snapshot.metadataReadStateSessionSeq,
                  pendingActivityAt: snapshot.metadataReadStatePendingActivityAt,
                  updatedAt: 0,
                },
            hiddenSystemSession: snapshot.metadataHiddenSystemSession,
          }
        : null,
      thinking: snapshot.thinking,
      thinkingAt: 0,
      presence: snapshot.presence,
      latestTurnStatus: snapshot.latestTurnStatus,
      lastRuntimeIssue: snapshot.lastRuntimeIssue,
      optimisticThinkingAt: snapshot.optimisticThinkingAt,
      thinkingGraceUntil: snapshot.thinkingGraceUntil,
      owner: snapshot.owner ?? undefined,
      accessLevel: snapshot.accessLevel ?? undefined,
      canApprovePermissions: snapshot.canApprovePermissions ?? undefined,
      hasPendingPermissionRequests: snapshot.hasPendingPermissionRequests ?? undefined,
      hasPendingUserActionRequests: snapshot.hasPendingUserActionRequests ?? undefined,
      hasUnreadMessages: snapshot.hasUnreadMessages,
      keepVisibleWhenInactive: snapshot.keepVisibleWhenInactive,
      metadataUnavailable: snapshot.metadataUnavailable,
    };
  }, [snapshot]);
}

export function useSessionFolderAssignment(serverId: string | null | undefined, sessionId: string): string | null {
  return getStorage()(useShallow((state) => (
    state.sessionFolderAssignmentsBySessionKey[buildSessionFolderAssignmentKey(serverId, sessionId)] ?? null
  )));
}

export function useSessionFolderAssignmentsBySessionKey(): Record<string, string | null> {
  return getStorage()(useShallow((state) => state.sessionFolderAssignmentsBySessionKey));
}

export function useSessionServerId(sessionId: string): string | null {
  return getStorage()((state) => resolveServerIdForSessionIdFromLocalState({
    sessions: state.sessions as Record<string, { serverId?: unknown } | null>,
    sessionListViewDataByServerId: state.sessionListViewDataByServerId,
  }, sessionId));
}

const emptyArray: unknown[] = [];
const emptyRecord: Record<string, any> = {};
const emptyReviewCommentDrafts: ReviewCommentDraft[] = [];
const emptyActionDrafts: SessionActionDraft[] = [];

function normalizeMessageSeq(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.trunc(value);
}

function compareMessagesOldestFirst(a: Message, b: Message): number {
  const aSeq = normalizeMessageSeq(a.seq);
  const bSeq = normalizeMessageSeq(b.seq);
  if (aSeq !== null && bSeq !== null && aSeq !== bSeq) {
    return aSeq - bSeq;
  }

  if (a.createdAt !== b.createdAt) {
    return a.createdAt - b.createdAt;
  }

  return String(a.id).localeCompare(String(b.id));
}

type SessionMessagesArrayCacheEntry = Readonly<{
  idsRef: readonly string[];
  messagesByIdRef: Record<string, Message>;
  messagesVersion: number;
  messages: readonly Message[];
}>;

const SESSION_MESSAGES_ARRAY_CACHE_MAX = 16;
const sessionMessagesArrayCache = new Map<string, SessionMessagesArrayCacheEntry>();

type UseSessionMessagesOptions = Readonly<{
  enabled?: boolean;
}>;

type SessionSubagentSourceMessagesCacheEntry = Readonly<{
  signature: string;
  messages: readonly Message[];
}>;

const sessionSubagentSourceMessagesCache = new Map<string, SessionSubagentSourceMessagesCacheEntry>();

function stringifySignatureValue(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? 'null';
  } catch {
    return String(value);
  }
}

function agentTextLooksLikeExecutionRunSignal(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return (
    (
      normalized.includes('execution run')
      || normalized.includes('run has been started')
      || normalized.includes('run started')
      || /\brun_[0-9a-z-]{8,}\b/i.test(text)
    )
    && (
      normalized.includes('started')
      || normalized.includes('running')
      || normalized.includes('delegate')
      || normalized.includes('execution run')
    )
  );
}

function shouldIncludeSubagentSourceMessage(message: Message): boolean {
  if (message.kind === 'tool-call') return true;
  if (message.kind !== 'agent-text') return false;
  const text = typeof (message as any).text === 'string' ? String((message as any).text) : '';
  return agentTextLooksLikeExecutionRunSignal(text);
}

function appendSubagentSourceMessageSignature(parts: string[], message: Message): void {
  const seq = typeof (message as any).seq === 'number' && Number.isFinite((message as any).seq)
    ? Math.trunc((message as any).seq)
    : '';
  parts.push(`${message.id}:${message.kind}:${seq}:${message.createdAt ?? ''}`);
  if (message.kind === 'agent-text') {
    parts.push(typeof (message as any).text === 'string' ? String((message as any).text) : '');
    return;
  }
  if (message.kind !== 'tool-call') return;
  const tool = (message as any).tool;
  parts.push(stringifySignatureValue({
    id: tool?.id ?? null,
    name: tool?.name ?? null,
    state: tool?.state ?? null,
    createdAt: tool?.createdAt ?? null,
    startedAt: tool?.startedAt ?? null,
    completedAt: tool?.completedAt ?? null,
    description: tool?.description ?? null,
    permissionStatus: tool?.permission?.status ?? null,
    input: tool?.input ?? null,
    result: tool?.result ?? null,
  }));
}

function trimSessionSubagentSourceMessagesCache(): void {
  while (sessionSubagentSourceMessagesCache.size > SESSION_MESSAGES_ARRAY_CACHE_MAX) {
    const oldestKey = sessionSubagentSourceMessagesCache.keys().next().value;
    if (typeof oldestKey !== 'string') break;
    sessionSubagentSourceMessagesCache.delete(oldestKey);
  }
}

export function useSessionSubagentSourceMessages(sessionId: string): readonly Message[] {
  return getStorage()((state) => {
    const session = state.sessionMessages[sessionId];
    if (!session) return emptyArray as any as readonly Message[];

    const sourceMessages: Message[] = [];
    const signatureParts: string[] = [];
    const ids = session.messageIdsOldestFirst;
    const orderedMessages = Array.isArray(ids) && ids.length > 0
      ? ids.map((id) => session.messagesById[id]).filter((message): message is Message => message != null)
      : Object.values(session.messagesById ?? {}).sort(compareMessagesOldestFirst);

    for (const message of orderedMessages) {
      if (!shouldIncludeSubagentSourceMessage(message)) continue;
      sourceMessages.push(message);
      appendSubagentSourceMessageSignature(signatureParts, message);
    }

    const signature = signatureParts.join('\u0000');
    const cached = sessionSubagentSourceMessagesCache.get(sessionId);
    if (cached && cached.signature === signature) {
      sessionSubagentSourceMessagesCache.delete(sessionId);
      sessionSubagentSourceMessagesCache.set(sessionId, cached);
      return cached.messages;
    }

    const next = {
      signature,
      messages: sourceMessages.length > 0 ? sourceMessages : (emptyArray as any as readonly Message[]),
    } satisfies SessionSubagentSourceMessagesCacheEntry;
    sessionSubagentSourceMessagesCache.delete(sessionId);
    sessionSubagentSourceMessagesCache.set(sessionId, next);
    trimSessionSubagentSourceMessagesCache();
    return next.messages;
  });
}

export function useSessionMessages(
  sessionId: string,
  options?: UseSessionMessagesOptions,
): { messages: Message[]; isLoaded: boolean } {
  const enabled = options?.enabled !== false;

  // IMPORTANT:
  // Do not derive new arrays inside the Zustand selector. React 18 can call getSnapshot twice, and if the
  // selector allocates new references for unchanged store state it can trigger:
  // - "The result of getSnapshot should be cached…"
  // - "Maximum update depth exceeded"
  //
  // Subscribe to stable primitives instead (ids + version), then derive via useMemo.
  const { ids, isLoaded } = useSessionTranscriptIds(sessionId, enabled);
  const messagesById = useSessionMessagesById(sessionId, enabled);
  const version = useSessionMessagesVersion(sessionId, enabled);

  const messages = React.useMemo(() => {
    if (!enabled) {
      return emptyArray as any as Message[];
    }

    if (!Array.isArray(ids) || ids.length === 0) {
      if (messagesById && Object.keys(messagesById).length > 0) {
        const cached = sessionMessagesArrayCache.get(sessionId);
        if (
          cached &&
          cached.messagesVersion === version &&
          cached.idsRef === ids &&
          cached.messagesByIdRef === messagesById
        ) {
          sessionMessagesArrayCache.delete(sessionId);
          sessionMessagesArrayCache.set(sessionId, cached);
          return cached.messages as Message[];
        }

        const out = Object.values(messagesById).slice().sort(compareMessagesOldestFirst);
        sessionMessagesArrayCache.delete(sessionId);
        sessionMessagesArrayCache.set(sessionId, {
          idsRef: ids,
          messagesByIdRef: messagesById,
          messagesVersion: version,
          messages: out,
        });
        while (sessionMessagesArrayCache.size > SESSION_MESSAGES_ARRAY_CACHE_MAX) {
          const oldestKey = sessionMessagesArrayCache.keys().next().value;
          if (typeof oldestKey !== 'string') break;
          sessionMessagesArrayCache.delete(oldestKey);
        }
        return out;
      }

      const cached = sessionMessagesArrayCache.get(sessionId);
      if (cached && !isLoaded) {
        sessionMessagesArrayCache.delete(sessionId);
        sessionMessagesArrayCache.set(sessionId, cached);
        return cached.messages as Message[];
      }

      if (cached && isLoaded) {
        sessionMessagesArrayCache.delete(sessionId);
      }

      return emptyArray as any as Message[];
    }

    const cached = sessionMessagesArrayCache.get(sessionId);
    if (
      cached &&
      cached.messagesVersion === version &&
      cached.idsRef === ids &&
      cached.messagesByIdRef === messagesById
    ) {
      sessionMessagesArrayCache.delete(sessionId);
      sessionMessagesArrayCache.set(sessionId, cached);
      return cached.messages as Message[];
    }

    const out: Message[] = [];
    for (const id of ids) {
      const m = messagesById[id];
      if (m) out.push(m);
    }

    sessionMessagesArrayCache.delete(sessionId);
    sessionMessagesArrayCache.set(sessionId, {
      idsRef: ids,
      messagesByIdRef: messagesById,
      messagesVersion: version,
      messages: out,
    });
    while (sessionMessagesArrayCache.size > SESSION_MESSAGES_ARRAY_CACHE_MAX) {
      const oldestKey = sessionMessagesArrayCache.keys().next().value;
      if (typeof oldestKey !== 'string') break;
      sessionMessagesArrayCache.delete(oldestKey);
    }

    return out;
  }, [enabled, ids, isLoaded, messagesById, sessionId, version]);

  return React.useMemo(() => ({ messages, isLoaded }), [isLoaded, messages]);
}

export function useSessionTranscriptIds(sessionId: string, enabled: boolean = true): { ids: string[]; isLoaded: boolean } {
  const snapshot = getStorage()(
    useShallow((state) => {
      if (!enabled) {
        return {
          committedIds: emptyArray as any as string[],
          messagesVersion: 0,
          isLoaded: false,
        };
      }
      const session = state.sessionMessages[sessionId];
      return {
        committedIds: session?.messageIdsOldestFirst ?? (emptyArray as any as string[]),
        messagesVersion: session?.messagesVersion ?? 0,
        isLoaded: session?.isLoaded ?? false,
      };
    })
  );
  return React.useMemo(
    () => ({ ids: snapshot.committedIds as string[], isLoaded: snapshot.isLoaded }),
    [snapshot.committedIds, snapshot.isLoaded, snapshot.messagesVersion],
  );
}

export function useForkedTranscriptSnapshot(sessionId: string): ForkedTranscriptSnapshot | null {
  return getStorage()(
    useShallow((state) => getForkedTranscriptSnapshotCached(state, sessionId))
  );
}

export function useSessionMessagesById(sessionId: string, enabled: boolean = true): Record<string, Message> {
  const snapshot = getStorage()(
    useShallow((state) => {
      if (!enabled) {
        return {
          committedIds: emptyArray as any as string[],
          committedMessagesById: emptyRecord as Record<string, Message>,
          messagesVersion: 0,
        };
      }
      const session = state.sessionMessages[sessionId];
      return {
        committedIds: session?.messageIdsOldestFirst ?? (emptyArray as any as string[]),
        committedMessagesById: session?.messagesById ?? (emptyRecord as Record<string, Message>),
        messagesVersion: session?.messagesVersion ?? 0,
      };
    })
  );
  return React.useMemo(() => snapshot.committedMessagesById, [snapshot.committedMessagesById, snapshot.messagesVersion]);
}

export function useSessionMessagesVersion(sessionId: string, enabled: boolean = true): number {
  return getStorage()(
    useShallow((state) => {
      if (!enabled) return 0;
      const session = state.sessionMessages[sessionId];
      return session?.messagesVersion ?? 0;
    })
  );
}

export function useSessionMetadata(sessionId: string): Session['metadata'] | null {
  return getStorage()((state) => state.sessions[sessionId]?.metadata ?? null);
}

export function useSessionMessagesReducerState(sessionId: string) {
  const snapshot = getStorage()(
    useShallow((state) => {
      const session = state.sessionMessages[sessionId];
      return {
        reducerState: session?.reducerState ?? null,
        reducerVersion: (session as any)?.reducerVersion ?? 0,
      };
    })
  );

  return snapshot.reducerState;
}

export function useSessionLatestThinkingMessageId(sessionId: string): string | null {
  return getStorage()(
    useShallow((state) => {
      const session = state.sessionMessages[sessionId];
      return session?.latestThinkingMessageId ?? null;
    })
  );
}

export function useSessionLatestThinkingMessageActivityAtMs(sessionId: string): number | null {
  return getStorage()(
    useShallow((state) => {
      const session = state.sessionMessages[sessionId];
      return session?.latestThinkingMessageActivityAtMs ?? null;
    })
  );
}

export function useHasUnreadMessages(sessionId: string): boolean {
  return getStorage()((state) => {
    const session = state.sessions[sessionId];
    if (!session) {
      return state.sessionListRenderables[sessionId]?.hasUnreadMessages === true;
    }
    return computeHasUnreadActivity({
      sessionSeq: session.seq ?? 0,
      pendingActivityAt: 0,
      lastViewedSessionSeq: resolveLastViewedSessionSeq(session),
      lastViewedPendingActivityAt: session.metadata?.readStateV1?.pendingActivityAt,
    });
  });
}

export function useSessionReadyActivity(sessionId: string): {
  latestReadyEventSeq: number | null;
  latestReadyEventAt: number | null;
} {
  return getStorage()(
    useShallow((state) => {
      const sessionMessages = state.sessionMessages[sessionId];
      const renderable = state.sessionListRenderables[sessionId];
      return {
        latestReadyEventSeq: sessionMessages?.latestReadyEventSeq ?? renderable?.latestReadyEventSeq ?? null,
        latestReadyEventAt: sessionMessages?.latestReadyEventAt ?? renderable?.latestReadyEventAt ?? null,
      };
    })
  );
}

export function useSessionListAttentionState(
  sessionId: string,
  sessionState: SessionState,
): SessionListAttentionState {
  return getStorage()(
    useShallow((state) => {
      const session = state.sessions[sessionId];
      const renderable = state.sessionListRenderables[sessionId];
      const sessionMessages = state.sessionMessages[sessionId];
      const pending = state.sessionPending[sessionId];

      const sessionSeq = normalizeHookSeq(session?.seq);
      const lastViewedSessionSeq = session
        ? resolveLastViewedSessionSeq(session)
        : normalizeHookSeq(renderable?.lastViewedSessionSeq ?? renderable?.metadata?.readStateV1?.sessionSeq);
      const hasUnreadMessages = session
        ? computeHasUnreadActivity({
          sessionSeq: sessionSeq ?? 0,
          pendingActivityAt: 0,
          lastViewedSessionSeq: lastViewedSessionSeq ?? undefined,
          lastViewedPendingActivityAt: session.metadata?.readStateV1?.pendingActivityAt,
        })
        : renderable?.hasUnreadMessages === true;
      const pendingCount =
        pending?.messages?.length
        ?? normalizeHookSeq(renderable?.pendingCount)
        ?? normalizeHookSeq(readUnknownField(session, 'pendingCount'))
        ?? 0;

      return deriveSessionListAttentionState({
        hasUnreadMessages,
        pendingCount,
        sessionState,
        latestTurnStatus: readPrimaryTurnStatusField(session, 'latestTurnStatus')
          ?? readPrimaryTurnStatusField(renderable, 'latestTurnStatus'),
        lastRuntimeIssue: readRuntimeIssueField(session, 'lastRuntimeIssue')
          ?? readRuntimeIssueField(renderable, 'lastRuntimeIssue'),
        latestReadyEventSeq: sessionMessages?.latestReadyEventSeq ?? renderable?.latestReadyEventSeq ?? null,
        latestReadyEventAt: sessionMessages?.latestReadyEventAt ?? renderable?.latestReadyEventAt ?? null,
        lastViewedSessionSeq,
      });
    })
  );
}

function normalizeHookSeq(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : null;
}

function readUnknownField(value: unknown, key: string): unknown {
  if (value == null || typeof value !== 'object') return null;
  return (value as Record<string, unknown>)[key] ?? null;
}

function readPrimaryTurnStatusField(value: unknown, key: string): PrimaryTurnStatusV1 | null {
  const field = readUnknownField(value, key);
  return field === 'in_progress' || field === 'completed' || field === 'cancelled' || field === 'failed'
    ? field
    : null;
}

function readRuntimeIssueField(value: unknown, key: string): SessionRuntimeIssueV1 | null {
  const field = readUnknownField(value, key);
  if (field == null || typeof field !== 'object') return null;
  const issue = field as Partial<SessionRuntimeIssueV1>;
  return issue.v === 1
    && issue.scope === 'primary_session'
    && issue.status === 'failed'
    && typeof issue.code === 'string'
    && typeof issue.source === 'string'
    && typeof issue.occurredAt === 'number'
    ? issue as SessionRuntimeIssueV1
    : null;
}

export function useSessionPendingMessages(
  sessionId: string
): { messages: PendingMessage[]; discarded: DiscardedPendingMessage[]; isLoaded: boolean } {
  return getStorage()(
    useShallow((state) => {
      const pending = state.sessionPending[sessionId];
      return {
        messages: pending?.messages ?? emptyArray,
        discarded: pending?.discarded ?? emptyArray,
        isLoaded: pending?.isLoaded ?? false,
      };
    })
  );
}

export function useSessionListMeaningfulActivityAt(sessionId: string): number | null {
  return getStorage()(
    useShallow((state) => {
      const session = state.sessions[sessionId];
      const transcript = state.sessionMessages[sessionId];
      const pending = state.sessionPending[sessionId];

      const latestCommittedMessageId =
        transcript?.messageIdsOldestFirst?.length
          ? transcript.messageIdsOldestFirst[transcript.messageIdsOldestFirst.length - 1] ?? null
          : null;
      const latestCommittedMessageCreatedAt =
        latestCommittedMessageId != null
          ? transcript?.messagesById?.[latestCommittedMessageId]?.createdAt ?? null
          : null;

      let latestPendingMessageCreatedAt: number | null = null;
      const pendingMessages = pending?.messages ?? emptyArray;
      for (const pendingMessage of pendingMessages as PendingMessage[]) {
        const createdAt = pendingMessage?.createdAt;
        if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) continue;
        latestPendingMessageCreatedAt =
          latestPendingMessageCreatedAt == null ? createdAt : Math.max(latestPendingMessageCreatedAt, createdAt);
      }

      return deriveSessionListMeaningfulActivityAt({
        sessionCreatedAt: session?.createdAt ?? null,
        latestCommittedMessageCreatedAt,
        latestThinkingActivityAt: transcript?.latestThinkingMessageActivityAtMs ?? null,
        latestPendingMessageCreatedAt,
      });
    })
  );
}

function buildMessageLegacySignature(message: Message | null): string {
  if (!message) return 'null';
  try {
    return JSON.stringify(message) ?? 'null';
  } catch {
    return `${message.id}:${message.kind}:${message.createdAt}`;
  }
}

export function useSessionReviewCommentsDrafts(sessionId: string): ReviewCommentDraft[] {
  return getStorage()(
    useShallow((state) => state.reviewCommentsDraftsBySessionId[sessionId] ?? emptyReviewCommentDrafts)
  );
}

export function useWorkspaceReviewCommentsDrafts(scope: WorkspaceScopeBase | null): ReviewCommentDraft[] {
  const cacheKey = React.useMemo(() => {
    if (!scope) return null;
    try {
      return buildWorkspaceCacheKey(scope);
    } catch {
      return null;
    }
  }, [scope]);

  return getStorage()(
    useShallow((state) => (cacheKey ? (state.reviewCommentsDraftsByWorkspaceCacheKey?.[cacheKey] ?? emptyReviewCommentDrafts) : emptyReviewCommentDrafts))
  );
}

export function useSessionActionDrafts(sessionId: string): SessionActionDraft[] {
  return getStorage()(
    useShallow((state) => (state.actionDraftsBySessionId ? (state.actionDraftsBySessionId[sessionId] ?? emptyActionDrafts) : emptyActionDrafts))
  );
}

export function useMessage(sessionId: string, messageId: string): Message | null {
  return getStorage()(
    useShallow((state) => {
      const session = state.sessionMessages[sessionId];
      const message = session?.messagesById?.[messageId] ?? null;
      const revision = session?.messageRevisionsById?.[messageId] ?? null;
      return {
        message,
        revision,
        legacySignature: revision === null ? buildMessageLegacySignature(message) : null,
      };
    })
  ).message;
}

export function useResolvedSessionMessageRouteId(sessionId: string, routeMessageId: string): string | null {
  const messagesById = useSessionMessagesById(sessionId);
  const version = useSessionMessagesVersion(sessionId, true);
  const reducerState = useSessionMessagesReducerState(sessionId);

  return React.useMemo(() => {
    return resolveSessionMessageRouteId({
      routeMessageId,
      messagesById,
      reducerState,
    });
  }, [messagesById, reducerState, routeMessageId, version]);
}

export function useSessionMessageRouteId(sessionId: string, messageId: string): string | null {
  const messagesById = useSessionMessagesById(sessionId);
  const version = useSessionMessagesVersion(sessionId, true);
  const reducerState = useSessionMessagesReducerState(sessionId);

  return React.useMemo(() => {
    return buildSessionMessageRouteId({
      messageId,
      messagesById,
      reducerState,
    });
  }, [messageId, messagesById, reducerState, version]);
}

export function useMessagesByIds(sessionId: string, messageIds: readonly string[]): Message[] {
  // IMPORTANT:
  // Avoid allocating arrays inside the Zustand selector. React 18 can call getSnapshot twice, and if the
  // selector allocates new references for unchanged store state it can trigger:
  // - "The result of getSnapshot should be cached…"
  // - "Maximum update depth exceeded"
  const messagesById = useSessionMessagesById(sessionId);
  const version = useSessionMessagesVersion(sessionId, true);

  return React.useMemo(() => {
    if (!Array.isArray(messageIds) || messageIds.length === 0) return emptyArray as any as Message[];
    const out: Message[] = [];
    for (const id of messageIds) {
      const m = messagesById[id];
      if (m) out.push(m);
    }
    return out;
  }, [messageIds, messagesById, version]);
}

export function useSessionUsage(sessionId: string) {
  return getStorage()(
    useShallow((state) => {
      const session = state.sessionMessages[sessionId];
      return session?.reducerState?.latestUsage ?? null;
    })
  );
}

export function useSettings(): Settings {
  return getStorage()(useShallow((state) => state.settings ?? settingsDefaults));
}

export function useSettingMutable<K extends keyof Settings>(
  name: K
): [Settings[K], (value: Settings[K]) => void] {
  const applySettings = useApplySettings();
  const setValue = React.useCallback(
    (value: Settings[K]) => {
      applySettings({ [name]: value } as Partial<Settings>);
    },
    [applySettings, name]
  );
  const value = useSetting(name);
  return [value, setValue];
}

export function useSetting<K extends keyof Settings>(name: K): Settings[K] {
  return getStorage()(useShallow((state) => state.settings?.[name] ?? settingsDefaults[name]));
}

export function useLocalSettings(): LocalSettings {
  return getStorage()(useShallow((state) => state.localSettings));
}

export function useAllMachines(): Machine[] {
  return getStorage()(
    useShallow((state) => {
      const machines = resolveVisibleMachinesForActiveServerFromState(
        state.isDataReady
          ? state
          : {
              ...state,
              machineListByServerId: {},
            }
      );
      if (machines.length > 0) {
        return machines;
      }
      return state.isDataReady ? machines : [];
    })
  );
}

export function useMachineRecordValues(): Machine[] {
  return getStorage()(
    useShallow((state) => {
      if (!state.isDataReady) return [];
      return Object.values(state.machines);
    })
  );
}

const EMPTY_MACHINE_LIST_BY_SERVER_ID: Record<string, Machine[] | null> = {};

export function useMachineListByServerId(): Record<string, Machine[] | null> {
  const machineListByServerIdRaw = getStorage()(useShallow((state) => state.machineListByServerId));
  const machineListByServerId = machineListByServerIdRaw ?? EMPTY_MACHINE_LIST_BY_SERVER_ID;
  return React.useMemo(() => {
    let hasChanges = false;
    const nextByServerId: Record<string, Machine[] | null> = {};

    for (const [serverId, machines] of Object.entries(machineListByServerId)) {
      if (!Array.isArray(machines)) {
        nextByServerId[serverId] = machines;
        continue;
      }

      const visibleMachines = machines.filter(isMachineVisibleForLaunchSelection);
      if (visibleMachines.length !== machines.length) {
        hasChanges = true;
        nextByServerId[serverId] = visibleMachines;
        continue;
      }

      nextByServerId[serverId] = machines;
    }

    return hasChanges ? nextByServerId : machineListByServerId;
  }, [machineListByServerId]);
}

export function useMachineListStatusByServerId(): Record<string, 'idle' | 'loading' | 'signedOut' | 'error'> {
  return getStorage()(useShallow((state) => state.machineListStatusByServerId));
}

export function useMachine(machineId: string): Machine | null {
  return getStorage()(useShallow((state) => state.machines[machineId] ?? null));
}

export function useSessionListViewData(): SessionListViewItem[] | null {
  return getStorage()(
    useShallow((state) => state.sessionListViewData)
  );
}

export function useSessionListViewDataByServerId(): Record<string, SessionListViewItem[] | null> {
  return getStorage()(useShallow((state) => state.sessionListViewDataByServerId));
}

function sortValuesByUpdatedAtDescending<T extends { updatedAt: number }>(values: Record<string, T>): T[] {
  return Object.values(values).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function useAllSessions(): Session[] {
  return getStorage()(
    useShallow((state) => {
      if (!state.isDataReady) return [];
      return sortValuesByUpdatedAtDescending(state.sessions);
    })
  );
}

export function useAllSessionsForAttention(): Session[] {
  return getStorage()(
    useShallow((state) => sortValuesByUpdatedAtDescending(state.sessions))
  );
}

export function useAllSessionListRenderables(): SessionListRenderableSession[] {
  return getStorage()(
    useShallow((state) => {
      if (!state.isDataReady) return [];
      return sortValuesByUpdatedAtDescending(state.sessionListRenderables);
    })
  );
}

export function useAllSessionListRenderablesForAttention(): SessionListRenderableSession[] {
  return getStorage()(
    useShallow((state) => sortValuesByUpdatedAtDescending(state.sessionListRenderables))
  );
}

export function useLocalSettingMutable<K extends keyof LocalSettings>(
  name: K
): [LocalSettings[K], (value: LocalSettings[K]) => void] {
  const applyLocalSettings = useApplyLocalSettings();
  const setValue = React.useCallback(
    (value: LocalSettings[K]) => {
      applyLocalSettings({ [name]: value } as Partial<LocalSettings>);
    },
    [applyLocalSettings, name]
  );
  const value = useLocalSetting(name);
  return [value, setValue];
}

// Project management hooks
export function useProjects() {
  return getStorage()(useShallow((state) => state.getProjects()));
}

export function useProject(projectId: string | null) {
  return getStorage()(useShallow((state) => (projectId ? state.getProject(projectId) : null)));
}

export function useProjectForSession(sessionId: string | null) {
  return getStorage()(
    useShallow((state) => (sessionId ? state.getProjectForSession(sessionId) : null))
  );
}

export function useProjectSessions(projectId: string | null) {
  return getStorage()(useShallow((state) => (projectId ? state.getProjectSessions(projectId) : [])));
}

export function useProjectScmStatus(projectId: string | null) {
  return getStorage()(useShallow((state) => (projectId ? state.getProjectScmStatus(projectId) : null)));
}

export function useSessionProjectScmStatus(sessionId: string | null) {
  return getStorage()(
    useShallow((state) => (sessionId ? state.getSessionProjectScmStatus(sessionId) : null))
  );
}

export function useProjectScmSnapshot(projectId: string | null): ScmWorkingSnapshot | null {
  return getStorage()(
    useShallow((state) => (projectId ? state.getProjectScmSnapshot(projectId) : null))
  );
}

export function useSessionProjectScmSnapshot(sessionId: string | null): ScmWorkingSnapshot | null {
  return getStorage()(
    useShallow((state) => (sessionId ? state.getSessionProjectScmSnapshot(sessionId) : null))
  );
}

export function useSessionProjectScmSnapshotError(
  sessionId: string | null
): import('../runtime/orchestration/projectManager').ProjectScmSnapshotError | null {
  return getStorage()(
    useShallow((state) => (sessionId ? state.getSessionProjectScmSnapshotError(sessionId) : null))
  );
}

export function useSessionProjectScmTouchedPaths(sessionId: string | null): string[] {
  return getStorage()(
    useShallow((state) => (sessionId ? state.getSessionProjectScmTouchedPaths(sessionId) : []))
  );
}

export function useSessionProjectScmCommitSelectionPaths(sessionId: string | null): string[] {
  return getStorage()(
    useShallow((state) => (sessionId ? state.getSessionProjectScmCommitSelectionPaths(sessionId) : []))
  );
}

export function useSessionProjectScmCommitSelectionPatches(sessionId: string | null): ScmCommitSelectionPatch[] {
  return getStorage()(
    useShallow((state) => (sessionId ? state.getSessionProjectScmCommitSelectionPatches(sessionId) : []))
  );
}

export function useSessionProjectScmOperationLog(sessionId: string | null) {
  return getStorage()(
    useShallow((state) => (sessionId ? state.getSessionProjectScmOperationLog(sessionId) : []))
  );
}

export function useSessionProjectScmInFlightOperation(sessionId: string | null) {
  return getStorage()(
    useShallow((state) => (sessionId ? state.getSessionProjectScmInFlightOperation(sessionId) : null))
  );
}

export function useSessionRepositoryTreeExpandedPaths(sessionId: string | null): string[] {
  return getStorage()(
    useShallow((state) => (sessionId ? state.getSessionRepositoryTreeExpandedPaths(sessionId) : []))
  );
}

export function useLocalSetting<K extends keyof LocalSettings>(name: K): LocalSettings[K] {
  return getStorage()(useShallow((state) => state.localSettings[name]));
}

// Artifact hooks
export function useArtifacts(): DecryptedArtifact[] {
  return getStorage()(
    useShallow((state) => {
      if (!state.isDataReady) return [];
      // Filter out draft artifacts from the main list
      return Object.values(state.artifacts)
        .filter((artifact) => !artifact.draft)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    })
  );
}

export function useAllArtifacts(): DecryptedArtifact[] {
  return getStorage()(
    useShallow((state) => {
      if (!state.isDataReady) return [];
      // Return all artifacts including drafts
      return Object.values(state.artifacts).sort((a, b) => b.updatedAt - a.updatedAt);
    })
  );
}

export function useAutomations(): Automation[] {
  return getStorage()(
    useShallow((state) => {
      if (!state.isDataReady) return [];
      return Object.values(state.automations).sort((a, b) => b.updatedAt - a.updatedAt);
    })
  );
}

export function useAutomation(automationId: string): Automation | null {
  return getStorage()(useShallow((state) => state.automations[automationId] ?? null));
}

export function useAutomationRuns(automationId: string): AutomationRun[] {
  return getStorage()(
    useShallow((state) => state.automationRunsByAutomationId[automationId] ?? emptyArray)
  ) as AutomationRun[];
}

export function useDraftArtifacts(): DecryptedArtifact[] {
  return getStorage()(
    useShallow((state) => {
      if (!state.isDataReady) return [];
      // Return only draft artifacts
      return Object.values(state.artifacts)
        .filter((artifact) => artifact.draft === true)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    })
  );
}

export function useArtifact(artifactId: string): DecryptedArtifact | null {
  return getStorage()(useShallow((state) => state.artifacts[artifactId] ?? null));
}

export function useArtifactsCount(): number {
  return getStorage()(
    useShallow((state) => {
      // Count only non-draft artifacts
      return Object.values(state.artifacts).filter((a) => !a.draft).length;
    })
  );
}

export function useEntitlement(id: KnownEntitlements): boolean {
  return getStorage()(useShallow((state) => state.purchases.entitlements[id] ?? false));
}

export function useRealtimeStatus(): 'disconnected' | 'connecting' | 'connected' | 'error' {
  return getStorage()(useShallow((state) => state.realtimeStatus));
}

export function useRealtimeMode(): 'idle' | 'speaking' {
  return getStorage()(useShallow((state) => state.realtimeMode));
}

export function useSocketStatus() {
  return getStorage()(
    useShallow((state) => ({
      status: state.socketStatus,
      lastConnectedAt: state.socketLastConnectedAt,
      lastDisconnectedAt: state.socketLastDisconnectedAt,
      lastError: state.socketLastError,
      lastErrorAt: state.socketLastErrorAt,
    }))
  );
}

export function useEndpointConnectivity() {
  return getStorage()(
    useShallow((state) => ({
      status: state.endpointStatus,
      reason: state.endpointReason,
      attempt: state.endpointAttempt,
      nextRetryAt: state.endpointNextRetryAt,
      lastConnectedAt: state.endpointLastConnectedAt,
      lastDisconnectedAt: state.endpointLastDisconnectedAt,
      lastErrorMessage: state.endpointLastErrorMessage,
    }))
  );
}

export function useSyncError() {
  return getStorage()(useShallow((state) => state.syncError));
}

export function useLastSyncAt() {
  return getStorage()(useShallow((state) => state.lastSyncAt));
}

export function useSessionScmStatus(sessionId: string): ScmStatus | null {
  return getStorage()(useShallow((state) => state.sessionScmStatus[sessionId] ?? null));
}

export function useIsDataReady(): boolean {
  return getStorage()(useShallow((state) => state.isDataReady));
}

export function useProfile() {
  return getStorage()(useShallow((state) => state.profile));
}

export function useActiveServerAccountScope() {
  return getStorage()(useShallow((state) => state.profileScope ?? null));
}

export function useFriends() {
  return getStorage()(useShallow((state) => state.friends));
}

export function useFriendRequests() {
  return getStorage()(
    useShallow((state) => {
      // Filter friends to get pending requests (where status is 'pending')
      return Object.values(state.friends).filter((friend) => friend.status === 'pending');
    })
  );
}

export function useAcceptedFriends() {
  return getStorage()(
    useShallow((state) => {
      return Object.values(state.friends).filter((friend) => friend.status === 'friend');
    })
  );
}

export function useFeedItems() {
  return getStorage()(useShallow((state) => state.feedItems));
}
export function useFeedLoaded() {
  return getStorage()((state) => state.feedLoaded);
}
export function useFriendsLoaded() {
  return getStorage()((state) => state.friendsLoaded);
}

export function useFriend(userId: string | undefined) {
  return getStorage()(useShallow((state) => (userId ? state.friends[userId] : undefined)));
}

export function useUser(userId: string | undefined) {
  return getStorage()(useShallow((state) => (userId ? state.users[userId] : undefined)));
}

export function useRequestedFriends() {
  return getStorage()(
    useShallow((state) => {
      // Filter friends to get sent requests (where status is 'requested')
      return Object.values(state.friends).filter((friend) => friend.status === 'requested');
    })
  );
}
