import {
  normalizeClaudeTaskEventToWorkStateItem,
  normalizeClaudeTodoWriteTodosToWorkStateItems,
  type SessionWorkStateItemV1,
  type SessionWorkStateV1,
} from '@happier-dev/protocol';

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function choosePrimary(items: readonly SessionWorkStateItemV1[]): string | null {
  return (
    items.find((item) => item.status === 'active')?.id
    ?? items.find((item) => item.status === 'pending')?.id
    ?? items[0]?.id
    ?? null
  );
}

export function buildClaudeTaskLifecycleWorkState(params: Readonly<{
  backendId: string;
  agentId?: string;
  updatedAt: number;
  messages: readonly unknown[];
}>): SessionWorkStateV1 {
  const byTaskId = new Map<string, SessionWorkStateItemV1>();
  for (const raw of params.messages) {
    const message = readRecord(raw);
    if (!message || message.type !== 'system') continue;
    const subtype = readString(message.subtype);
    if (!subtype.startsWith('task_')) continue;
    const taskId = readString(message.task_id);
    if (!taskId) continue;
    const previous = byTaskId.get(taskId);
    const item = normalizeClaudeTaskEventToWorkStateItem({
      backendId: params.backendId,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      updatedAt: params.updatedAt,
      event: { ...message, type: subtype },
    });
    if (!item) continue;
    byTaskId.set(taskId, {
      ...(previous ?? {}),
      ...item,
      title: item.title === taskId && previous?.title ? previous.title : item.title,
    });
  }

  const items = [...byTaskId.values()];
  return {
    v: 1,
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    updatedAt: params.updatedAt,
    items,
    primaryItemId: choosePrimary(items),
  };
}

export function buildClaudeTodoWriteWorkState(params: Readonly<{
  backendId: string;
  agentId?: string;
  updatedAt: number;
  input: unknown;
}>): SessionWorkStateV1 {
  const input = readRecord(params.input);
  const items = normalizeClaudeTodoWriteTodosToWorkStateItems({
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    updatedAt: params.updatedAt,
    todos: input?.todos,
  });

  return {
    v: 1,
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    updatedAt: params.updatedAt,
    items,
    primaryItemId: choosePrimary(items),
  };
}
