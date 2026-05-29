export type ClaudeAgentSdkProviderActivitySource =
    | 'assistant-auto-backgrounded-tool-result'
    | 'system-task-progress'
    | 'system-task-started';

export type ClaudeAgentSdkProviderTaskBlocker = {
    taskId: string;
    sources: ClaudeAgentSdkProviderActivitySource[];
};

type ProviderTaskEntry = {
    taskId: string;
    sources: Set<ClaudeAgentSdkProviderActivitySource>;
};

export function normalizeClaudeAgentSdkProviderTaskId(taskId: unknown): string | null {
    if (typeof taskId !== 'string') return null;
    const normalized = taskId.trim();
    return normalized.length > 0 ? normalized : null;
}

export function createClaudeAgentSdkProviderActivityLedger() {
    const activeProviderTasks = new Map<string, ProviderTaskEntry>();

    const noteProviderTask = (
        taskId: unknown,
        source: ClaudeAgentSdkProviderActivitySource,
    ): string | null => {
        const normalizedTaskId = normalizeClaudeAgentSdkProviderTaskId(taskId);
        if (!normalizedTaskId) return null;

        const existing = activeProviderTasks.get(normalizedTaskId);
        if (existing) {
            existing.sources.add(source);
            return normalizedTaskId;
        }

        activeProviderTasks.set(normalizedTaskId, {
            taskId: normalizedTaskId,
            sources: new Set([source]),
        });
        return normalizedTaskId;
    };

    return {
        getActiveProviderTaskBlockers: (): ClaudeAgentSdkProviderTaskBlocker[] => Array.from(activeProviderTasks.values())
            .map((entry) => ({
                taskId: entry.taskId,
                sources: Array.from(entry.sources),
            })),
        getActiveProviderTaskCount: (): number => activeProviderTasks.size,
        hasActiveProviderTasks: (): boolean => activeProviderTasks.size > 0,
        noteBackgroundProviderTask: (taskId: unknown): string | null => noteProviderTask(
            taskId,
            'assistant-auto-backgrounded-tool-result',
        ),
        noteProviderTaskFinished: (taskId: unknown): string | null => {
            const normalizedTaskId = normalizeClaudeAgentSdkProviderTaskId(taskId);
            if (!normalizedTaskId) return null;
            activeProviderTasks.delete(normalizedTaskId);
            return normalizedTaskId;
        },
        noteProviderTaskProgress: (taskId: unknown): string | null => noteProviderTask(
            taskId,
            'system-task-progress',
        ),
        noteProviderTaskStarted: (taskId: unknown): string | null => noteProviderTask(
            taskId,
            'system-task-started',
        ),
    };
}
