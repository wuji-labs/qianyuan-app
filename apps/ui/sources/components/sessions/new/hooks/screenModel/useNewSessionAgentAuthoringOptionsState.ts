import * as React from 'react';

import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { resolveInitialNewSessionModelMode } from '@/components/sessions/new/hooks/newSessionModelModePolicy';
import type { ModelMode } from '@/sync/domains/permissions/permissionTypes';
import {
    SessionMcpSelectionV1Schema,
    type SessionMcpSelectionV1,
    type AcpConfigOptionOverridesV1,
} from '@happier-dev/protocol';
import type { RememberedEngineSelectionV1 } from '@/sync/domains/sessionAuthoring/rememberedEngineSelections';

type PersistedAuthoringDraftLike = Readonly<{
    modelId?: string | null;
    acpSessionModeId?: string | null;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    mcpSelection?: unknown;
    codexBackendMode?: string | null;
}> | null | undefined;

type TempAuthoringDraftLike = Readonly<{
    modelId?: string | null;
    acpSessionModeId?: string | null;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    mcpSelection?: unknown;
    codexBackendMode?: string | null;
}> | null | undefined;

function areSessionConfigOptionOverridesEqual(
    current: AcpConfigOptionOverridesV1 | null,
    next: AcpConfigOptionOverridesV1 | null,
): boolean {
    if (current === next) return true;
    if (!current || !next) return current === next;
    if (current.v !== next.v) return false;
    if (current.updatedAt !== next.updatedAt) return false;

    const currentOverrides = current.overrides ?? {};
    const nextOverrides = next.overrides ?? {};
    const currentKeys = Object.keys(currentOverrides);
    const nextKeys = Object.keys(nextOverrides);

    if (currentKeys.length !== nextKeys.length) return false;

    for (const key of currentKeys) {
        const currentValue = currentOverrides[key];
        const nextValue = nextOverrides[key];
        if (!nextValue) return false;
        if (currentValue.updatedAt !== nextValue.updatedAt) return false;
        if (currentValue.value !== nextValue.value) return false;
    }

    return true;
}

export function useNewSessionAgentAuthoringOptionsState(params: Readonly<{
    agentType: AgentId;
    hydratedTempAuthoringDraft: TempAuthoringDraftLike;
    hydratedPersistedAuthoringDraft: PersistedAuthoringDraftLike;
    rememberedEngineSelection?: RememberedEngineSelectionV1 | null;
}>): Readonly<{
    modelMode: ModelMode;
    setModelMode: React.Dispatch<React.SetStateAction<ModelMode>>;
    acpSessionModeId: string | null;
    setAcpSessionModeId: React.Dispatch<React.SetStateAction<string | null>>;
    sessionConfigOptionOverrides: AcpConfigOptionOverridesV1 | null;
    setSessionConfigOptionOverrides: React.Dispatch<React.SetStateAction<AcpConfigOptionOverridesV1 | null>>;
    setAcpConfigOptionOverride: (configId: string, value: string) => void;
    mcpSelection: SessionMcpSelectionV1;
    setMcpSelection: React.Dispatch<React.SetStateAction<SessionMcpSelectionV1>>;
}> {
    const [modelMode, setModelMode] = React.useState<ModelMode>(() => {
        const core = getAgentCore(params.agentType);
        const tempMode = typeof params.hydratedTempAuthoringDraft?.modelId === 'string' ? params.hydratedTempAuthoringDraft.modelId : null;
        const draftMode = typeof params.hydratedPersistedAuthoringDraft?.modelId === 'string' ? params.hydratedPersistedAuthoringDraft.modelId : null;
        const rememberedMode = typeof params.rememberedEngineSelection?.modelId === 'string' ? params.rememberedEngineSelection.modelId : null;
        return resolveInitialNewSessionModelMode({
            draftModelMode: tempMode ?? draftMode ?? rememberedMode,
            modelConfig: {
                defaultMode: core.model.defaultMode,
                allowedModes: core.model.allowedModes,
                supportsFreeform: core.model.supportsFreeform,
                dynamicProbe: core.model.dynamicProbe ?? 'auto',
            },
        }) as ModelMode;
    });

    const [acpSessionModeId, setAcpSessionModeId] = React.useState<string | null>(() => {
        if (typeof params.hydratedTempAuthoringDraft?.acpSessionModeId === 'string') {
            const trimmed = params.hydratedTempAuthoringDraft.acpSessionModeId.trim();
            return trimmed.length > 0 ? trimmed : null;
        }
        const raw = params.hydratedPersistedAuthoringDraft?.acpSessionModeId;
        if (raw === null) return null;
        if (typeof raw === 'string') {
            const trimmed = raw.trim();
            return trimmed.length > 0 ? trimmed : null;
        }
        const remembered = params.rememberedEngineSelection?.acpSessionModeId;
        if (typeof remembered === 'string') {
            const trimmed = remembered.trim();
            return trimmed.length > 0 ? trimmed : null;
        }
        return null;
    });

    const initialSessionConfigOptionOverrides = React.useMemo(() => {
        if (params.hydratedTempAuthoringDraft && 'sessionConfigOptionOverrides' in params.hydratedTempAuthoringDraft) {
            return params.hydratedTempAuthoringDraft.sessionConfigOptionOverrides ?? null;
        }
        if (params.hydratedPersistedAuthoringDraft && 'sessionConfigOptionOverrides' in params.hydratedPersistedAuthoringDraft) {
            return params.hydratedPersistedAuthoringDraft.sessionConfigOptionOverrides ?? null;
        }
        return params.rememberedEngineSelection?.sessionConfigOptionOverrides ?? null;
    }, [
        params.hydratedPersistedAuthoringDraft,
        params.hydratedPersistedAuthoringDraft?.sessionConfigOptionOverrides,
        params.hydratedTempAuthoringDraft,
        params.hydratedTempAuthoringDraft?.sessionConfigOptionOverrides,
        params.rememberedEngineSelection?.sessionConfigOptionOverrides,
    ]);

    const [sessionConfigOptionOverrides, setSessionConfigOptionOverrides] = React.useState<AcpConfigOptionOverridesV1 | null>(
        () => initialSessionConfigOptionOverrides,
    );

    React.useEffect(() => {
        setSessionConfigOptionOverrides((current) => {
            return areSessionConfigOptionOverridesEqual(current, initialSessionConfigOptionOverrides)
                ? current
                : initialSessionConfigOptionOverrides;
        });
    }, [initialSessionConfigOptionOverrides]);

    const [mcpSelection, setMcpSelection] = React.useState<SessionMcpSelectionV1>(() => {
        return SessionMcpSelectionV1Schema.parse(
            params.hydratedTempAuthoringDraft?.mcpSelection ?? params.hydratedPersistedAuthoringDraft?.mcpSelection ?? {},
        );
    });

    const setAcpConfigOptionOverride = React.useCallback((configId: string, value: string) => {
        const normalizedConfigId = typeof configId === 'string' ? configId.trim() : '';
        const normalizedValue = typeof value === 'string' ? value.trim() : '';
        if (!normalizedConfigId || !normalizedValue) return;
        setSessionConfigOptionOverrides((current) => {
            const currentRawValue = current?.overrides?.[normalizedConfigId]?.value;
            const currentValue = typeof currentRawValue === 'string' ? currentRawValue.trim() : '';
            if (currentValue === normalizedValue) {
                return current;
            }

            const updatedAt = Date.now();
            return {
                v: 1,
                updatedAt,
                overrides: {
                    ...(current?.overrides ?? {}),
                    [normalizedConfigId]: {
                        updatedAt,
                        value: normalizedValue,
                    },
                },
            };
        });
    }, []);

    return {
        modelMode,
        setModelMode,
        acpSessionModeId,
        setAcpSessionModeId,
        sessionConfigOptionOverrides,
        setSessionConfigOptionOverrides,
        setAcpConfigOptionOverride,
        mcpSelection,
        setMcpSelection,
    };
}
