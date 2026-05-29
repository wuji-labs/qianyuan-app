import {
  isActionDirectToolExposedOn,
  listActionSpecs,
  type ActionId,
  type ActionsSettingsV1,
} from '@happier-dev/protocol';

import type { HappierBuiltInToolDefinition } from './types';

type ActionEnabledPredicate = (id: ActionId) => boolean;
export type HappierBuiltInToolSurface = 'mcp' | 'cli' | 'session_agent';

const ACTION_TOOL_ENTRIES = Object.freeze(
  listActionSpecs()
    .map((spec) => ({
      id: spec.id as ActionId,
      spec,
      toolName: String(spec.bindings?.mcpToolName ?? '').trim(),
    }))
    .filter((entry) => entry.toolName.length > 0),
);

const ACTION_TOOL_NAME_TO_ID = new Map(
  ACTION_TOOL_ENTRIES.map((entry) => [entry.toolName, entry.id] as const),
);
const ACTION_SURFACES_BY_ID = new Map(
  listActionSpecs().map((spec) => [spec.id as ActionId, spec.surfaces] as const),
);
const ACTION_SPECS_BY_ID = new Map(
  listActionSpecs().map((spec) => [spec.id as ActionId, spec] as const),
);
const MANUAL_TOOL_EQUIVALENT_ACTION_IDS = new Map<string, ActionId>([
  ['change_title', 'session.title.set'],
  ['action_spec_search', 'action.spec.search'],
  ['action_spec_get', 'action.spec.get'],
  ['action_options_resolve', 'action.options.resolve'],
]);
const DIRECT_MANUAL_TOOL_NAMES = new Set(['change_title']);

export function getEquivalentActionIdForBuiltInTool(toolName: string): ActionId | null {
  return MANUAL_TOOL_EQUIVALENT_ACTION_IDS.get(toolName) ?? ACTION_TOOL_NAME_TO_ID.get(toolName) ?? null;
}

export function isActionAvailableOnToolSurface(params: Readonly<{
  actionId: ActionId;
  surface?: HappierBuiltInToolSurface;
  isActionEnabled?: ActionEnabledPredicate;
}>): boolean {
  const surface = params.surface ?? 'session_agent';
  const isActionEnabled = params.isActionEnabled ?? (() => true);
  const surfaces = ACTION_SURFACES_BY_ID.get(params.actionId);
  if (!surfaces) {
    return false;
  }
  return surfaces[surface] === true && isActionEnabled(params.actionId);
}

export function isActionDirectToolAvailableOnToolSurface(params: Readonly<{
  actionId: ActionId;
  surface?: HappierBuiltInToolSurface;
  isActionEnabled?: ActionEnabledPredicate;
  actionsSettings?: ActionsSettingsV1 | null;
}>): boolean {
  const surface = params.surface ?? 'session_agent';
  const spec = ACTION_SPECS_BY_ID.get(params.actionId);
  if (!spec) {
    return false;
  }

  return isActionDirectToolExposedOn(spec, surface, {
    settings: params.actionsSettings ?? null,
    isActionEnabled: params.isActionEnabled ?? null,
  });
}

export function createActionToolNameToIdMap(params?: Readonly<{
  surface?: HappierBuiltInToolSurface;
  isActionEnabled?: ActionEnabledPredicate;
  actionsSettings?: ActionsSettingsV1 | null;
}>): ReadonlyMap<string, ActionId> {
  const surface = params?.surface ?? 'session_agent';

  return new Map(
    ACTION_TOOL_ENTRIES
      .filter((entry) => isActionDirectToolAvailableOnToolSurface({
        actionId: entry.id,
        surface,
        isActionEnabled: params?.isActionEnabled,
        actionsSettings: params?.actionsSettings ?? null,
      }))
      .map((entry) => [entry.toolName, entry.id] as const),
  );
}

function isDirectManualToolAvailable(params: Readonly<{
  toolName: string;
  actionId: ActionId;
  surface?: HappierBuiltInToolSurface;
  isActionEnabled?: ActionEnabledPredicate;
}>): boolean {
  if (!DIRECT_MANUAL_TOOL_NAMES.has(params.toolName)) {
    return false;
  }

  return isActionAvailableOnToolSurface({
    actionId: params.actionId,
    surface: params.surface,
    isActionEnabled: params.isActionEnabled,
  });
}

export function filterBuiltInToolsForSurface(
  tools: readonly HappierBuiltInToolDefinition[],
  params?: Readonly<{
    surface?: HappierBuiltInToolSurface;
    isActionEnabled?: ActionEnabledPredicate;
    actionsSettings?: ActionsSettingsV1 | null;
  }>,
): readonly HappierBuiltInToolDefinition[] {
  return tools.filter((tool) => {
    const actionId = getEquivalentActionIdForBuiltInTool(tool.name);
    if (!actionId) return true;
    if (isDirectManualToolAvailable({
      toolName: tool.name,
      actionId,
      surface: params?.surface,
      isActionEnabled: params?.isActionEnabled,
    })) {
      return true;
    }
    return isActionDirectToolAvailableOnToolSurface({
      actionId,
      surface: params?.surface,
      isActionEnabled: params?.isActionEnabled,
      actionsSettings: params?.actionsSettings ?? null,
    });
  });
}
