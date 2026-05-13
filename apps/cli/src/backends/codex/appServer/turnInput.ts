type MetadataRecord = Record<string, unknown>;

export type CodexAppServerTurnInputItem =
    | Readonly<{ type: 'text'; text: string }>
    | Readonly<{ type: 'mention'; name: string; path: string }>
    | Readonly<{ type: 'skill'; name: string; path: string }>
    | Readonly<{ type: 'image'; url: string }>
    | Readonly<{ type: 'localImage'; path: string }>;

function asRecord(value: unknown): MetadataRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as MetadataRecord : null;
}

function asRecordArray(value: unknown): MetadataRecord[] {
    return Array.isArray(value) ? value.map(asRecord).filter((entry): entry is MetadataRecord => Boolean(entry)) : [];
}

function readString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readStructuredEnvelope(metadata: MetadataRecord | null): MetadataRecord | null {
    return asRecord(metadata?.happierStructuredInputV1);
}

function readVendorPluginMentions(metadata: MetadataRecord | null): MetadataRecord[] {
    const envelope = readStructuredEnvelope(metadata);
    return asRecordArray(envelope?.vendorPluginMentions).concat(asRecordArray(metadata?.happierVendorPluginMentions));
}

function readSkillMentions(metadata: MetadataRecord | null): MetadataRecord[] {
    const envelope = readStructuredEnvelope(metadata);
    return asRecordArray(envelope?.skillMentions).concat(asRecordArray(metadata?.happierSkillMentions));
}

function readAttachmentInputs(metadata: MetadataRecord | null): CodexAppServerTurnInputItem[] {
    const envelope = readStructuredEnvelope(metadata);
    const attachments = asRecordArray(envelope?.attachments);
    const items: CodexAppServerTurnInputItem[] = [];
    for (const attachment of attachments) {
        const mimeType = readString(attachment.mimeType);
        const kind = readString(attachment.kind);
        if (kind !== 'image' && !mimeType?.toLowerCase().startsWith('image/')) {
            continue;
        }
        const localPath = readString(attachment.localPath ?? attachment.path);
        if (localPath) {
            items.push({ type: 'localImage', path: localPath });
            continue;
        }
        const url = readString(attachment.url);
        if (url) {
            items.push({ type: 'image', url });
        }
    }
    return items;
}

export function buildCodexAppServerTurnInput(params: Readonly<{
    text: string;
    metadata?: unknown;
}>): CodexAppServerTurnInputItem[] {
    const metadata = asRecord(params.metadata);
    const input: CodexAppServerTurnInputItem[] = [{ type: 'text', text: params.text }];

    for (const mention of readVendorPluginMentions(metadata)) {
        const path = readString(mention.vendorPluginRef ?? mention.mentionPath ?? mention.path);
        if (!path) continue;
        input.push({
            type: 'mention',
            name: readString(mention.label ?? mention.displayName ?? mention.name) ?? path,
            path,
        });
    }

    for (const skill of readSkillMentions(metadata)) {
        const path = readString(skill.path);
        const name = readString(skill.name ?? skill.displayName);
        if (!path || !name) continue;
        input.push({ type: 'skill', name, path });
    }

    input.push(...readAttachmentInputs(metadata));
    return input;
}
