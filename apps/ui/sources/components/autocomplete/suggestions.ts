import {
    COMMAND_SUGGESTION_ROW_HEIGHT,
    FileMentionSuggestion,
    SkillMentionSuggestion,
    VendorPluginMentionSuggestion,
} from '@/components/sessions/agentInput/components/AgentInputSuggestionView';
import * as React from 'react';
import type { FileItem } from '@/sync/domains/input/suggestionFile';
import { searchCommands, CommandItem } from '@/sync/domains/input/suggestionCommands';
import { storage } from '@/sync/domains/state/storage';
import { ensureSessionSuggestionCatalogs } from '@/sync/ops/sessionCatalogs';
import type { AutocompleteSuggestion } from './autocompleteTypes';

type VendorPluginCatalogItem = Readonly<{
    name: string;
    displayName?: string;
    description?: string;
    vendorPluginRef: string;
    marketplace?: string;
    source?: string;
    installed?: boolean;
    enabled?: boolean;
    backendId?: string;
    agentId?: string;
}>;

type SkillCatalogItem = Readonly<{
    name: string;
    displayName?: string;
    description?: string;
    path?: string;
    enabled?: boolean;
    origin?: string;
    source?: string;
    projectionKind?: string;
}>;

type SuggestionCatalogOverrides = Readonly<{
    files?: readonly FileItem[];
    vendorPlugins?: readonly VendorPluginCatalogItem[];
    skills?: readonly SkillCatalogItem[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readArray(value: unknown, keys: readonly string[]): readonly unknown[] {
    if (Array.isArray(value)) return value;
    if (!isRecord(value)) return [];
    for (const key of keys) {
        const child = value[key];
        if (Array.isArray(child)) return child;
    }
    return [];
}

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeVendorPlugin(value: unknown): VendorPluginCatalogItem | null {
    if (!isRecord(value)) return null;
    const vendorPluginRef = readString(value.vendorPluginRef)
        ?? readString(value.mentionPath)
        ?? readString(value.path)
        ?? readString(value.ref);
    if (!vendorPluginRef) return null;
    const name = readString(value.name) ?? vendorPluginRef.replace(/^plugin:\/\//, '');
    const displayName = readString(value.displayName);
    const description = readString(value.description);
    const marketplace = readString(value.marketplace);
    const source = readString(value.source);
    const backendId = readString(value.backendId);
    const agentId = readString(value.agentId);
    return {
        name,
        vendorPluginRef,
        ...(displayName ? { displayName } : {}),
        ...(description ? { description } : {}),
        ...(marketplace ? { marketplace } : {}),
        ...(source ? { source } : {}),
        ...(value.installed === false ? { installed: false } : {}),
        ...(value.enabled === false ? { enabled: false } : {}),
        ...(backendId ? { backendId } : {}),
        ...(agentId ? { agentId } : {}),
    };
}

function normalizeSkill(value: unknown): SkillCatalogItem | null {
    if (!isRecord(value)) return null;
    const name = readString(value.name);
    if (!name) return null;
    const displayName = readString(value.displayName);
    const description = readString(value.description);
    const path = readString(value.path);
    const origin = readString(value.origin);
    const source = readString(value.source);
    const projectionKind = readString(value.projectionKind);
    return {
        name,
        ...(displayName ? { displayName } : {}),
        ...(description ? { description } : {}),
        ...(path ? { path } : {}),
        ...(value.enabled === false ? { enabled: false } : {}),
        ...(origin ? { origin } : {}),
        ...(source ? { source } : {}),
        ...(projectionKind ? { projectionKind } : {}),
    };
}

function readCatalogsFromSession(sessionId: string): SuggestionCatalogOverrides {
    const metadata = storage.getState().sessions[sessionId]?.metadata;
    if (!metadata || typeof metadata !== 'object') return {};
    const record = metadata as Record<string, unknown>;
    const vendorPluginRaw = record.sessionVendorPluginCatalogV1 ?? record.vendorPluginCatalogV1 ?? record.vendorPlugins;
    const skillsRaw = record.sessionSkillCatalogV1 ?? record.skillCatalogV1 ?? record.skills;
    return {
        vendorPlugins: readArray(vendorPluginRaw, ['vendorPlugins', 'plugins', 'items'])
            .map(normalizeVendorPlugin)
            .filter((item): item is VendorPluginCatalogItem => item !== null),
        skills: readArray(skillsRaw, ['skills', 'items'])
            .map(normalizeSkill)
            .filter((item): item is SkillCatalogItem => item !== null),
    };
}

function matchesQuery(value: string, query: string): boolean {
    const haystack = value.trim().toLowerCase();
    const needle = query.trim().toLowerCase();
    return needle.length === 0 || haystack.includes(needle);
}

function isPathLikeAtQuery(queryWithoutPrefix: string): boolean {
    return (
        queryWithoutPrefix.startsWith('/')
        || queryWithoutPrefix.startsWith('\\')
        || queryWithoutPrefix.startsWith('.')
        || queryWithoutPrefix.startsWith('~')
        || queryWithoutPrefix.includes('/')
        || queryWithoutPrefix.includes('\\')
    );
}

function getPluginQuery(query: string): { pluginOnly: boolean; searchTerm: string } {
    const withoutAt = query.startsWith('@') ? query.slice(1) : query;
    if (withoutAt.startsWith('plugin:')) {
        return { pluginOnly: true, searchTerm: withoutAt.slice('plugin:'.length) };
    }
    if (withoutAt.startsWith('plugins:')) {
        return { pluginOnly: true, searchTerm: withoutAt.slice('plugins:'.length) };
    }
    return { pluginOnly: false, searchTerm: withoutAt };
}

function buildFileSuggestion(file: FileItem): AutocompleteSuggestion {
    return {
        key: `file-${file.fullPath}`,
        text: `@${file.fullPath}`,
        component: () => React.createElement(FileMentionSuggestion, {
            fileName: file.fileName,
            filePath: file.filePath,
            fileType: file.fileType,
        }),
    };
}

function resolveCatalogRequestForQuery(query: string): { vendorPlugins?: boolean; skills?: boolean } | null {
    if (query.startsWith('@')) {
        const pluginQuery = getPluginQuery(query);
        const queryWithoutAt = query.slice(1);
        if (pluginQuery.pluginOnly || !isPathLikeAtQuery(queryWithoutAt)) {
            return { vendorPlugins: true };
        }
    }

    if (query.startsWith('$')) {
        return { skills: true };
    }

    return null;
}

export async function getCommandSuggestions(sessionId: string, query: string): Promise<{
    key: string;
    text: string;
    label: string;
    description?: string;
    rowHeight?: number;
}[]> {
    // Remove the "/" prefix for searching
    const searchTerm = query.slice(1);
    
    try {
        // Use the command search cache with fuzzy matching
        const commands = await searchCommands(sessionId, searchTerm, { limit: 8 });

        // Convert CommandItem to suggestion format
        return commands.map((cmd: CommandItem) => ({
            key: `cmd-${cmd.command}`,
            text: `/${cmd.command}`,
            label: `/${cmd.command}`,
            description: cmd.description,
            rowHeight: COMMAND_SUGGESTION_ROW_HEIGHT,
            ...(cmd.promptInvocation ? { promptInvocation: cmd.promptInvocation } : {}),
        }));
    } catch {
        return [];
    }
}

async function searchSuggestionFiles(sessionId: string, searchTerm: string): Promise<readonly FileItem[]> {
    const { searchFiles } = await import('@/sync/domains/input/suggestionFile');
    return searchFiles(sessionId, searchTerm, { limit: 12 });
}

export async function getFileMentionSuggestions(sessionId: string, query: string): Promise<AutocompleteSuggestion[]> {
    // Remove the "@" prefix for searching
    const searchTerm = query.slice(1);
    
    try {
        // Use the file search cache with fuzzy matching
        const files = await searchSuggestionFiles(sessionId, searchTerm);

        // Convert FileItem to suggestion format
        return files.map(buildFileSuggestion);
    } catch {
        return [];
    }
}

function getVendorPluginMentionSuggestions(
    query: string,
    catalogs: SuggestionCatalogOverrides,
): AutocompleteSuggestion[] {
    const { searchTerm } = getPluginQuery(query);
    const seen = new Set<string>();
    const out: AutocompleteSuggestion[] = [];
    for (const plugin of catalogs.vendorPlugins ?? []) {
        if (plugin.installed === false || plugin.enabled === false) continue;
        if (seen.has(plugin.vendorPluginRef)) continue;
        const label = plugin.displayName ?? plugin.name;
        if (!matchesQuery(plugin.name, searchTerm) && !matchesQuery(label, searchTerm)) continue;
        seen.add(plugin.vendorPluginRef);
        out.push({
            key: `vendor-plugin-${plugin.vendorPluginRef}`,
            text: `@${plugin.name}`,
            structuredInput: {
                kind: 'vendorPlugin',
                vendorPluginRef: plugin.vendorPluginRef,
                label,
                ...(plugin.backendId ? { backendId: plugin.backendId } : {}),
                ...(plugin.agentId ? { agentId: plugin.agentId } : {}),
            },
            component: () => React.createElement(VendorPluginMentionSuggestion, {
                name: plugin.name,
                displayName: label,
                description: plugin.description,
                source: plugin.marketplace ?? plugin.source,
            }),
        });
    }
    return out;
}

function getSkillMentionSuggestions(query: string, catalogs: SuggestionCatalogOverrides): AutocompleteSuggestion[] {
    const searchTerm = query.startsWith('$') ? query.slice(1) : query;
    const seen = new Set<string>();
    const out: AutocompleteSuggestion[] = [];
    for (const skill of catalogs.skills ?? []) {
        if (skill.enabled === false) continue;
        const key = skill.name.trim().toLowerCase();
        if (seen.has(key)) continue;
        const label = skill.displayName ?? skill.name;
        if (!matchesQuery(skill.name, searchTerm) && !matchesQuery(label, searchTerm)) continue;
        seen.add(key);
        out.push({
            key: `skill-${skill.name}`,
            text: `$${skill.name}`,
            structuredInput: {
                kind: 'skill',
                name: skill.name,
                ...(skill.path ? { path: skill.path } : {}),
                ...(skill.displayName ? { displayName: skill.displayName } : {}),
                ...(skill.description ? { description: skill.description } : {}),
                ...(skill.origin ?? skill.source ? { origin: skill.origin ?? skill.source } : {}),
                ...(skill.projectionKind ? { projectionKind: skill.projectionKind } : {}),
            },
            component: () => React.createElement(SkillMentionSuggestion, {
                name: skill.name,
                displayName: label,
                description: skill.description,
                source: skill.origin ?? skill.source ?? skill.projectionKind,
            }),
        });
    }
    return out;
}

async function getAtMentionSuggestions(
    sessionId: string,
    query: string,
    catalogs: SuggestionCatalogOverrides,
): Promise<AutocompleteSuggestion[]> {
    const pluginQuery = getPluginQuery(query);
    const queryWithoutAt = query.startsWith('@') ? query.slice(1) : query;
    const isPathLikeQuery = isPathLikeAtQuery(queryWithoutAt);
    const vendorPluginSuggestions = getVendorPluginMentionSuggestions(query, catalogs);

    if (pluginQuery.pluginOnly) {
        return vendorPluginSuggestions;
    }

    if (!isPathLikeQuery && !catalogs.files) {
        return vendorPluginSuggestions;
    }

    const fileSuggestions = catalogs.files
        ? catalogs.files.map(buildFileSuggestion)
        : await getFileMentionSuggestions(sessionId, query);
    if (isPathLikeQuery) {
        return fileSuggestions;
    }
    return [
        ...fileSuggestions,
        ...vendorPluginSuggestions,
    ];
}

export async function getSuggestions(
    sessionId: string,
    query: string,
    catalogOverrides?: SuggestionCatalogOverrides,
): Promise<AutocompleteSuggestion[]> {
    if (!query || query.length === 0) {
        return [];
    }
    if (!catalogOverrides) {
        const catalogRequest = resolveCatalogRequestForQuery(query);
        if (catalogRequest) {
            await ensureSessionSuggestionCatalogs(sessionId, catalogRequest);
        }
    }
    const catalogs = catalogOverrides ?? readCatalogsFromSession(sessionId);
    
    // Check if it's a command (starts with /)
    if (query.startsWith('/')) {
        return await getCommandSuggestions(sessionId, query);
    }
    
    // Check if it's a file mention (starts with @)
    if (query.startsWith('@')) {
        return await getAtMentionSuggestions(sessionId, query, catalogs);
    }

    if (query.startsWith('$')) {
        return getSkillMentionSuggestions(query, catalogs);
    }
    
    // No suggestions for other queries
    return [];
}
