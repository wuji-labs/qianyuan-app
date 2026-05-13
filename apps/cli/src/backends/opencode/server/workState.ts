import {
  normalizeOpenCodeSessionTodosToWorkStateItems,
  type SessionWorkStateItemV1,
  type SessionWorkStateV1,
} from '@happier-dev/protocol';

export const OPEN_CODE_TODO_WORK_STATE_OWNED_SOURCE_FAMILIES = ['todo:opencode'] as const;

function choosePrimaryTodoItem(items: readonly SessionWorkStateItemV1[]): string | null {
  return (
    items.find((item) => item.status === 'active')?.id
    ?? items.find((item) => item.status === 'pending' && item.priority === 'high')?.id
    ?? items.find((item) => item.status === 'pending')?.id
    ?? null
  );
}

export function buildOpenCodeTodoWorkState(params: Readonly<{
  backendId: string;
  agentId?: string;
  updatedAt: number;
  todos: unknown;
}>): SessionWorkStateV1 {
  const items = normalizeOpenCodeSessionTodosToWorkStateItems({
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    updatedAt: params.updatedAt,
    todos: params.todos,
  });

  return {
    v: 1,
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    updatedAt: params.updatedAt,
    items,
    primaryItemId: choosePrimaryTodoItem(items),
  };
}
