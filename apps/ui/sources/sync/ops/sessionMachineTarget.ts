import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError, type RpcErrorCarrier } from '@happier-dev/protocol/rpcErrors';
import { resolveSessionMachineRpcTarget } from '@/sync/domains/session/resolveSessionReachableMachineId';
import { resolveSessionDisplayTarget } from '@/sync/domains/machines/identity/resolveSessionMachineTargets';
import { storage } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { resolveSessionMachineId } from '@/sync/domains/session/directSessions/resolveSessionMachineId';

type SessionTargetMetadataLike = Readonly<{
  machineId?: string | null;
  path?: string | null;
  host?: string | null;
  homeDir?: string | null;
  directSessionV1?: Readonly<{
    v?: number;
    providerId?: string | null;
    machineId?: string | null;
    remoteSessionId?: string | null;
  }> | null;
}> | null | undefined;

type MachineTargetLikeState = Readonly<{
  sessions?: Record<string, {
    active?: boolean;
    updatedAt?: number;
    metadata?: SessionTargetMetadataLike;
  }>;
  machines?: Record<string, Machine>;
  getProjectForSession?: (sessionId: string) => { key?: { machineId?: string; path?: string } } | null;
}>;

export type SessionMachineTargetState = MachineTargetLikeState;

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveMachineTargetForSessionFromState(
  state: SessionMachineTargetState,
  sessionId: string,
): { machineId: string; basePath: string } | null {
  const session = state.sessions?.[sessionId];
  const metadata = session?.metadata ?? null;
  const project = typeof state.getProjectForSession === 'function' ? state.getProjectForSession(sessionId) : null;

  const machines = Object.values(state.machines ?? {}) as Machine[];
  return resolveSessionMachineRpcTarget({
    sessionId,
    sessionActive: session?.active === true,
    sessionMachineId: resolveSessionMachineId(metadata),
    sessionPath: normalizeNonEmptyString(metadata?.path),
    projectMachineId: project?.key?.machineId ?? null,
    projectPath: normalizeNonEmptyString(project?.key?.path),
    machines,
  });
}

export function readMachineTargetForSession(
  sessionId: string,
): { machineId: string; basePath: string } | null {
  return resolveMachineTargetForSessionFromState(storage.getState() as SessionMachineTargetState, sessionId);
}

export function resolveDisplayMachineTargetForSessionFromState(input: Readonly<{
  state: SessionMachineTargetState;
  sessionId?: string | null;
  metadata?: SessionTargetMetadataLike;
}>): { machineId: string; basePath: string } | null {
  const sessionId = normalizeNonEmptyString(input.sessionId);
  if (sessionId) {
    const session = input.state.sessions?.[sessionId];
    const metadata = session?.metadata ?? input.metadata ?? null;
    const project = typeof input.state.getProjectForSession === 'function'
      ? input.state.getProjectForSession(sessionId)
      : null;
    return resolveSessionDisplayTarget({
      sessionActive: session?.active === true,
      sessionMachineId: resolveSessionMachineId(metadata),
      sessionPath: normalizeNonEmptyString(metadata?.path),
      projectMachineId: project?.key?.machineId ?? null,
      projectPath: normalizeNonEmptyString(project?.key?.path),
      machines: Object.values(input.state.machines ?? {}) as Machine[],
    });
  }

  const metadata = input.metadata ?? null;
  return resolveSessionDisplayTarget({
    sessionActive: false,
    sessionMachineId: resolveSessionMachineId(metadata),
    sessionPath: normalizeNonEmptyString(metadata?.path),
    projectMachineId: null,
    projectPath: null,
    machines: Object.values(input.state.machines ?? {}) as Machine[],
  });
}

export function readDisplayMachineTargetForSession(input: Readonly<{
  sessionId?: string | null;
  metadata?: SessionTargetMetadataLike;
}>): { machineId: string; basePath: string } | null {
  return resolveDisplayMachineTargetForSessionFromState({
    state: storage.getState() as SessionMachineTargetState,
    sessionId: input.sessionId,
    metadata: input.metadata,
  });
}

export function resolveDisplayMachineIdForSessionFromState(input: Readonly<{
  state: SessionMachineTargetState;
  sessionId?: string | null;
  metadata?: SessionTargetMetadataLike;
}>): string {
  const sessionId = normalizeNonEmptyString(input.sessionId);
  const target = resolveDisplayMachineTargetForSessionFromState({
    state: input.state,
    sessionId,
    metadata: input.metadata,
  });
  if (target?.machineId) return target.machineId;
  return (
    resolveSessionMachineId(input.metadata)
    ?? ''
  );
}

export function resolveDisplayPathForSessionFromState(input: Readonly<{
  state: SessionMachineTargetState;
  sessionId?: string | null;
  metadata?: SessionTargetMetadataLike;
}>): string {
  const sessionId = normalizeNonEmptyString(input.sessionId);
  const target = resolveDisplayMachineTargetForSessionFromState({
    state: input.state,
    sessionId,
    metadata: input.metadata,
  });
  if (target?.basePath) return target.basePath;
  return normalizeNonEmptyString(input.metadata?.path) ?? '';
}

export function readDisplayMachineIdForSession(input: Readonly<{
  sessionId?: string | null;
  metadata?: SessionTargetMetadataLike;
}>): string {
  return resolveDisplayMachineIdForSessionFromState({
    state: storage.getState() as SessionMachineTargetState,
    sessionId: input.sessionId,
    metadata: input.metadata,
  });
}

export function readDisplayPathForSession(input: Readonly<{
  sessionId?: string | null;
  metadata?: SessionTargetMetadataLike;
}>): string {
  return resolveDisplayPathForSessionFromState({
    state: storage.getState() as SessionMachineTargetState,
    sessionId: input.sessionId,
    metadata: input.metadata,
  });
}

export function resolveMachinePathFromSessionBase(input: { basePath: string; requestPath?: string }): string {
  const requestPath = input.requestPath;
  if (!requestPath || requestPath === '.') return input.basePath;
  if (requestPath.startsWith('~')) return requestPath;

  const isAbsolutePosix = requestPath.startsWith('/');
  const isAbsoluteWindows = /^[a-zA-Z]:[\\/]/.test(requestPath) || requestPath.startsWith('\\\\');
  if (isAbsolutePosix || isAbsoluteWindows) return requestPath;

  const separator = input.basePath.includes('\\') ? '\\' : '/';
  const base = input.basePath.endsWith(separator) ? input.basePath.slice(0, -1) : input.basePath;
  const rel = requestPath.startsWith(separator) ? requestPath.slice(1) : requestPath;
  return `${base}${separator}${rel}`;
}

export function shouldFallbackFromMachineRpc(error: unknown): boolean {
  if (error instanceof Error && typeof error.message === 'string') {
    if (error.message.includes('Machine encryption not found')) return true;
    if (error.message.includes('Socket not connected')) return true;
    if (error.message.includes('Scoped RPC socket connection timeout')) return true;
    if (error.message.includes('Scoped RPC socket connection failed')) return true;
  }

  if (error && typeof error === 'object') {
    const rpcError: RpcErrorCarrier = {
      rpcErrorCode:
        typeof (error as { rpcErrorCode?: unknown }).rpcErrorCode === 'string'
          ? (error as { rpcErrorCode: string }).rpcErrorCode
          : undefined,
      message:
        typeof (error as { message?: unknown }).message === 'string'
          ? (error as { message: string }).message
          : undefined,
    };
    return isRpcMethodNotAvailableError(rpcError) || isRpcMethodNotFoundError(rpcError);
  }

  return false;
}

export function shouldFallbackToSessionRpc(sessionId: string, error: unknown): boolean {
  if (!shouldFallbackFromMachineRpc(error)) return false;
  return canUseSessionRpc(sessionId);
}

export function canUseSessionRpc(sessionId: string): boolean {
  const state = storage.getState();
  const session = state.sessions?.[sessionId];
  if (!session) return true;
  return session.active !== false;
}
