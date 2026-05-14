import type { CodexAppServerClient } from './client/createCodexAppServerClient';
import { isCodexAppServerMethodNotFoundError } from './appServerCompatibility';

type MetadataRecord = Record<string, unknown>;

export type CodexVendorPluginCatalogEntry = Readonly<{
    id: string;
    name: string;
    displayName: string;
    description?: string;
    vendorPluginRef: string;
    installed: boolean;
    enabled: boolean;
    mentionable: boolean;
}>;

export type CodexSkillCatalogEntry = Readonly<{
    name: string;
    displayName: string;
    description?: string;
    path: string;
    enabled: boolean;
    origin: 'codex_native';
}>;

function asRecord(value: unknown): MetadataRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as MetadataRecord : null;
}

function asArray(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    const record = asRecord(value);
    const data = record?.data ?? record?.plugins ?? record?.skills;
    return Array.isArray(data) ? data : [];
}

function readString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function readMarketplaceName(record: MetadataRecord): string | null {
    const direct = readString(record.marketplaceName ?? record.marketplace);
    if (direct) return direct;
    const source = asRecord(record.source);
    return readString(source?.marketplace ?? source?.marketplaceName ?? source?.name);
}

function normalizePlugin(record: MetadataRecord): CodexVendorPluginCatalogEntry | null {
    const name = readString(record.name);
    if (!name) return null;
    const marketplaceName = readMarketplaceName(record);
    const vendorPluginRef = readString(record.vendorPluginRef ?? record.mentionPath)
        ?? (marketplaceName ? `plugin://${name}@${marketplaceName}` : readString(record.path));
    if (!vendorPluginRef) return null;
    const installed = readBoolean(record.installed, false);
    const enabled = readBoolean(record.enabled, false);
    return {
        id: readString(record.id) ?? vendorPluginRef,
        name,
        displayName: readString(record.displayName ?? record.title) ?? name,
        ...(readString(record.description ?? record.shortDescription) ? { description: readString(record.description ?? record.shortDescription)! } : {}),
        vendorPluginRef,
        installed,
        enabled,
        mentionable: installed && enabled,
    };
}

function normalizeSkill(record: MetadataRecord): CodexSkillCatalogEntry | null {
    const name = readString(record.name);
    const path = readString(record.path ?? record.location);
    if (!name || !path) return null;
    return {
        name,
        displayName: readString(record.displayName ?? record.title) ?? name,
        ...(readString(record.description ?? record.shortDescription) ? { description: readString(record.description ?? record.shortDescription)! } : {}),
        path,
        enabled: readBoolean(record.enabled, true),
        origin: 'codex_native',
    };
}

export async function listCodexVendorPlugins(params: Readonly<{
    client: Pick<CodexAppServerClient, 'request'>;
    cwd: string;
}>): Promise<Readonly<{
    supported: boolean;
    vendorPlugins: CodexVendorPluginCatalogEntry[];
    diagnostic?: string;
}>> {
    try {
        const response = await params.client.request('plugin/list', { cwds: [params.cwd] });
        const byVendorPluginRef = new Map<string, CodexVendorPluginCatalogEntry>();
        for (const entry of asArray(response)) {
            const plugin = normalizePlugin(asRecord(entry) ?? {});
            if (!plugin || byVendorPluginRef.has(plugin.vendorPluginRef)) continue;
            byVendorPluginRef.set(plugin.vendorPluginRef, plugin);
        }
        return { supported: true, vendorPlugins: [...byVendorPluginRef.values()] };
    } catch (error) {
        if (isCodexAppServerMethodNotFoundError(error)) {
            return {
                supported: false,
                vendorPlugins: [],
                diagnostic: error instanceof Error ? error.message : String(error),
            };
        }
        throw error;
    }
}

export async function listCodexAppServerSkills(params: Readonly<{
    client: Pick<CodexAppServerClient, 'request'>;
    cwd: string;
}>): Promise<Readonly<{
    supported: boolean;
    skills: CodexSkillCatalogEntry[];
    diagnostic?: string;
}>> {
    try {
        const response = await params.client.request('skills/list', { cwds: [params.cwd] });
        const byName = new Map<string, CodexSkillCatalogEntry>();
        for (const entry of asArray(response)) {
            const skill = normalizeSkill(asRecord(entry) ?? {});
            if (!skill) continue;
            const key = skill.name.toLowerCase();
            const existing = byName.get(key);
            if (!existing || (!existing.enabled && skill.enabled)) {
                byName.set(key, skill);
            }
        }
        return { supported: true, skills: [...byName.values()] };
    } catch (error) {
        if (isCodexAppServerMethodNotFoundError(error)) {
            return {
                supported: false,
                skills: [],
                diagnostic: error instanceof Error ? error.message : String(error),
            };
        }
        throw error;
    }
}
