import type { AgentId } from '@/agents/catalog/catalog';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import {
    LEGACY_ACP_CONFIG_OPTIONS_STATE_KEY,
    LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY,
    LEGACY_ACP_SESSION_MODELS_STATE_KEY,
    LEGACY_ACP_SESSION_MODES_STATE_KEY,
    readMetadataAliasValue,
    SESSION_CONFIG_OPTIONS_STATE_KEY,
    SESSION_CONFIG_OPTION_OVERRIDES_KEY,
    SESSION_MODELS_STATE_KEY,
    SESSION_MODES_STATE_KEY,
} from '@happier-dev/agents';

import {
    parseSessionConfigOptionsState,
    parseSessionConfigOptionOverridesState,
    parseSessionModelsState,
    parseSessionModesState,
} from './schema';

export type SessionConfigOptionValueId = string;

function normalizeValueId(raw: unknown): SessionConfigOptionValueId | null {
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    if (typeof raw === 'boolean') return raw ? 'true' : 'false';
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
    return null;
}

function normalizeConfigOptionChoiceDisplayName(params: Readonly<{
    optionId: string;
    value: SessionConfigOptionValueId;
    name: string;
}>): string {
    const normalizedName = params.name.trim().toLowerCase().replace(/[\s_-]+/g, '-');
    if (normalizedName === 'extra-high') return 'XHigh';
    const normalizedId = params.optionId.trim().toLowerCase().replace(/[\s_-]+/g, '-');
    if (normalizedId === 'fast' && params.value === 'true' && (normalizedName === 'on' || normalizedName === 'true')) {
        return 'Fast';
    }
    return params.name;
}

export type SessionConfigOptionSelectOption = Readonly<{
    value: SessionConfigOptionValueId;
    name: string;
    description?: string;
}>;

export type SessionConfigOption = Readonly<{
    id: string;
    name: string;
    description?: string;
    category?: string;
    type: string;
    currentValue: SessionConfigOptionValueId;
    options?: readonly SessionConfigOptionSelectOption[];
}>;

export type SessionConfigOptionControl = Readonly<{
    option: SessionConfigOption;
    requestedValue?: SessionConfigOptionValueId;
    effectiveValue: SessionConfigOptionValueId;
    isPending: boolean;
    /** True when another option overrides this one (e.g. ultracode pins effort to xhigh). */
    disabled?: boolean;
    /** Display name of the overriding option, for "overridden by X" copy. */
    disabledByOptionName?: string;
}>;

/**
 * Boolean options that, while ON, override another option's value (renderers dim/disable
 * the overridden control). Keyed by generic config option id — e.g. Claude's session-only
 * `ultracode` setting forces xhigh reasoning, overriding the `reasoning_effort` select.
 */
const OVERRIDING_BOOLEAN_OPTION_TARGETS: ReadonlyMap<string, string> = new Map([
    ['ultracode', 'reasoning_effort'],
]);

function applyBooleanOverrideRules(controls: SessionConfigOptionControl[]): SessionConfigOptionControl[] {
    for (const [sourceId, targetId] of OVERRIDING_BOOLEAN_OPTION_TARGETS) {
        const source = controls.find((control) => control.option.id === sourceId);
        if (!source || !isBooleanConfigOptionType(source.option.type)) continue;
        if (!resolveBooleanConfigOptionValue(source.option, source.effectiveValue)) continue;
        const targetIndex = controls.findIndex((control) => control.option.id === targetId);
        if (targetIndex < 0) continue;
        controls[targetIndex] = {
            ...controls[targetIndex],
            disabled: true,
            disabledByOptionName: source.option.name,
        };
    }
    return controls;
}

function resolveRequestedValue(
    option: SessionConfigOption,
    rawValue: unknown,
): SessionConfigOptionValueId | undefined {
    const requestedValue = normalizeValueId(rawValue);
    if (!requestedValue) return undefined;
    if (option.options?.length) {
        return option.options.some((entry) => entry.value === requestedValue)
            ? requestedValue
            : undefined;
    }
    return requestedValue;
}

export function isBooleanConfigOptionType(type: string): boolean {
    return type === 'boolean' || type === 'bool' || type === 'toggle';
}

export function shouldRenderConfigOptionAsBooleanSwitch(option: Readonly<{
    id: string;
    type: string;
    options?: readonly unknown[];
}>): boolean {
    if (!isBooleanConfigOptionType(option.type)) return false;
    const normalizedId = option.id.trim().toLowerCase().replace(/[\s_-]+/g, '-');
    return !(normalizedId === 'fast' && (option.options?.length ?? 0) >= 2);
}

export function resolveBooleanConfigOptionToggleValues(option: SessionConfigOption): Readonly<{
    offValue: SessionConfigOptionValueId;
    onValue: SessionConfigOptionValueId;
}> {
    const optionValues = Array.isArray(option.options)
        ? option.options
            .map((entry) => normalizeValueId(entry.value))
            .filter((value): value is SessionConfigOptionValueId => value !== null)
        : [];

    if (optionValues.length >= 2) {
        return {
            offValue: optionValues[0],
            onValue: optionValues[1],
        };
    }

    return {
        offValue: 'false',
        onValue: 'true',
    };
}

export function resolveBooleanConfigOptionValue(option: SessionConfigOption, value: SessionConfigOptionValueId): boolean {
    const { onValue } = resolveBooleanConfigOptionToggleValues(option);
    return value === onValue;
}

export function resolveBooleanConfigOptionNextValue(option: SessionConfigOption, enabled: boolean): SessionConfigOptionValueId {
    const { offValue, onValue } = resolveBooleanConfigOptionToggleValues(option);
    return enabled ? onValue : offValue;
}

function buildSessionConfigOptionControls(params: Readonly<{
    providerId: string;
    provider: string | null;
    configOptions: ReadonlyArray<{
        id: string;
        name: string;
        description?: string;
        category?: string;
        type: string;
        currentValue: unknown;
        options?: ReadonlyArray<{
            value: unknown;
            name: string;
            description?: string;
        }>;
    }>;
    overrides?: Readonly<Record<string, Readonly<{ value: unknown }>>> | null;
    hideModeOption: boolean;
    hideModelOption: boolean;
}>): SessionConfigOptionControl[] | null {
    if (params.provider !== params.providerId) return null;

    const controls: SessionConfigOptionControl[] = [];

    for (const entry of params.configOptions) {
        const id = entry.id.trim();
        const name = entry.name.trim();
        const type = entry.type.trim();
        if (!id || !name || !type) continue;

        if (params.hideModeOption && id === 'mode') continue;
        if (params.hideModelOption && (id === 'models' || id === 'model')) continue;
        const category = typeof entry.category === 'string' ? entry.category.trim() : '';
        const normalizedCategory = category.toLowerCase().replace(/[\s_-]+/g, '-');
        if (params.hideModelOption && normalizedCategory === 'model-config') continue;

        const currentValue = normalizeValueId(entry.currentValue);
        if (!currentValue) continue;

        const optionsRaw = Array.isArray(entry.options) ? entry.options : [];
        const options = optionsRaw
            .map((opt) => {
                const value = normalizeValueId(opt.value);
                const optName = opt.name.trim();
                if (!value || !optName) return null;
                const optDescription = typeof opt.description === 'string' ? opt.description.trim() : '';
                return { value, name: normalizeConfigOptionChoiceDisplayName({ optionId: id, value, name: optName }), ...(optDescription ? { description: optDescription } : {}) };
            })
            .filter((value): value is SessionConfigOptionSelectOption => value !== null);

        const description = typeof entry.description === 'string' ? entry.description.trim() : '';
        const option: SessionConfigOption = {
            id,
            name,
            type,
            currentValue,
            ...(description ? { description } : {}),
            ...(category ? { category } : {}),
            ...(options.length > 0 ? { options } : {}),
        };

        const requestedValue = resolveRequestedValue(option, params.overrides?.[id]?.value);
        const effectiveValue = requestedValue ?? currentValue;
        const isPending = requestedValue !== undefined && requestedValue !== currentValue;

        controls.push({
            option,
            ...(requestedValue !== undefined ? { requestedValue } : {}),
            effectiveValue,
            isPending,
        });
    }

    return controls.length > 0 ? applyBooleanOverrideRules(controls) : null;
}

export function computeSessionConfigOptionControls(params: {
    agentId: AgentId;
    metadata: Metadata | null | undefined;
}): SessionConfigOptionControl[] | null {
    const state = parseSessionConfigOptionsState(
        readMetadataAliasValue((params.metadata as any) ?? {}, SESSION_CONFIG_OPTIONS_STATE_KEY, LEGACY_ACP_CONFIG_OPTIONS_STATE_KEY),
    );
    if (!state) return null;
    if (state.provider !== params.agentId) return null;
    if (state.configOptions.length === 0) return null;

    const sessionModes = parseSessionModesState(
        readMetadataAliasValue((params.metadata as any) ?? {}, SESSION_MODES_STATE_KEY, LEGACY_ACP_SESSION_MODES_STATE_KEY),
    );
    const hasDedicatedModeControl = sessionModes?.provider === params.agentId && sessionModes.availableModes.length > 0;

    const sessionModels = parseSessionModelsState(
        readMetadataAliasValue((params.metadata as any) ?? {}, SESSION_MODELS_STATE_KEY, LEGACY_ACP_SESSION_MODELS_STATE_KEY),
    );
    const hasDedicatedModelControl =
        sessionModels?.provider === params.agentId && sessionModels.availableModels.length > 0;

    const overrides = parseSessionConfigOptionOverridesState(
        readMetadataAliasValue((params.metadata as any) ?? {}, SESSION_CONFIG_OPTION_OVERRIDES_KEY, LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY),
    );
    return buildSessionConfigOptionControls({
        providerId: params.agentId,
        provider: state.provider,
        configOptions: state.configOptions,
        overrides: overrides?.overrides ?? null,
        hideModeOption: hasDedicatedModeControl,
        hideModelOption: hasDedicatedModelControl,
    });
}

export function computeSessionConfigOptionControlsForProvider(params: Readonly<{
    providerId: string;
    configOptions: ReadonlyArray<SessionConfigOption> | null | undefined;
    overrides?: Readonly<Record<string, Readonly<{ value: unknown }>>> | null;
    hideModeOption?: boolean;
    hideModelOption?: boolean;
}>): SessionConfigOptionControl[] | null {
    if (!Array.isArray(params.configOptions) || params.configOptions.length === 0) return null;
    return buildSessionConfigOptionControls({
        providerId: params.providerId,
        provider: params.providerId,
        configOptions: params.configOptions,
        overrides: params.overrides ?? null,
        hideModeOption: params.hideModeOption ?? false,
        hideModelOption: params.hideModelOption ?? false,
    });
}

export function computeSessionConfigOptionControlsFromOverride(params: Readonly<{
    agentId: AgentId;
    configOptions: ReadonlyArray<SessionConfigOption> | null | undefined;
    overrides?: Readonly<Record<string, Readonly<{ value: unknown }>>> | null;
}>): SessionConfigOptionControl[] | null {
    return computeSessionConfigOptionControlsForProvider({
        providerId: params.agentId,
        configOptions: params.configOptions,
        overrides: params.overrides ?? null,
    });
}
