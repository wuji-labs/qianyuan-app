import { ApprovalRequestV1Schema, type ApprovalRequestV1 } from '@happier-dev/protocol';

import type { DecryptedArtifact } from './artifactTypes';

export type OpenApprovalArtifactForSession = Readonly<{
    artifact: DecryptedArtifact;
    approval: ApprovalRequestV1;
}>;

const CREATED_BY_SURFACES = new Set<ApprovalRequestV1['createdBy']['surface']>([
    'voice',
    'session_agent',
    'mcp',
    'cli',
    'system',
]);

function readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function readTimestampMs(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.trunc(value)
        : 0;
}

function parseApprovalRequestBody(body: unknown): ApprovalRequestV1 | null {
    if (typeof body !== 'string') return null;

    try {
        const parsed = JSON.parse(body);
        const result = ApprovalRequestV1Schema.safeParse(parsed);
        return result.success ? result.data : null;
    } catch {
        return null;
    }
}

function isApprovalLinkedToSession(artifact: DecryptedArtifact, sessionId: string): boolean {
    const headerSessionId = readString(artifact.header?.sessionId);
    if (headerSessionId === sessionId) return true;

    if (artifact.sessions?.includes(sessionId) === true) return true;

    const headerSessions = Array.isArray(artifact.header?.sessions) ? artifact.header?.sessions : [];
    return headerSessions.some((entry) => entry === sessionId);
}

function readCreatedBySurface(value: unknown): ApprovalRequestV1['createdBy']['surface'] | null {
    const surface = readString(value);
    return CREATED_BY_SURFACES.has(surface as ApprovalRequestV1['createdBy']['surface'])
        ? surface as ApprovalRequestV1['createdBy']['surface']
        : null;
}

function createHeaderBackedApprovalRequest(
    artifact: DecryptedArtifact,
    sessionId: string,
): ApprovalRequestV1 | null {
    const actionId = readString(artifact.header?.actionId);
    const summary =
        readString(artifact.header?.approvalSummary)
        || readString(artifact.header?.summary)
        || readString(artifact.title)
        || readString(artifact.header?.title)
        || actionId;
    if (!actionId || !summary) return null;

    const headerCreatedBy = artifact.header?.createdBy;
    const headerCreatedBySurface = headerCreatedBy && typeof headerCreatedBy === 'object'
        ? readCreatedBySurface((headerCreatedBy as { surface?: unknown }).surface)
        : null;
    const surface = headerCreatedBySurface
        ?? readCreatedBySurface(artifact.header?.requestedSurface)
        ?? 'session_agent';
    const headerCreatedBySessionId = headerCreatedBy && typeof headerCreatedBy === 'object'
        ? readString((headerCreatedBy as { sessionId?: unknown }).sessionId)
        : '';
    const createdBy = {
        surface,
        ...(headerCreatedBySessionId || sessionId ? { sessionId: headerCreatedBySessionId || sessionId } : {}),
    };
    const requestedSurface = readString(artifact.header?.requestedSurface);
    const candidate = {
        v: 1,
        status: 'open',
        createdAtMs: readTimestampMs(artifact.createdAt),
        updatedAtMs: readTimestampMs(artifact.updatedAt),
        createdBy,
        ...(requestedSurface ? { requestedSurface } : {}),
        actionId,
        actionArgs: artifact.header?.actionArgs ?? {},
        summary,
        ...(typeof artifact.header?.approvalPreview !== 'undefined' ? { preview: artifact.header.approvalPreview } : {}),
    } as const;
    const result = ApprovalRequestV1Schema.safeParse(candidate);
    return result.success ? result.data : null;
}

export function listOpenApprovalArtifactsForSession(
    artifacts: readonly DecryptedArtifact[],
    sessionId: string,
): readonly OpenApprovalArtifactForSession[] {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) return [];

    return artifacts.flatMap((artifact): OpenApprovalArtifactForSession[] => {
        if (artifact.header?.kind !== 'approval_request.v1') return [];
        if (artifact.header?.approvalStatus !== 'open') return [];
        if (!isApprovalLinkedToSession(artifact, normalizedSessionId)) return [];

        const approval = artifact.body == null
            ? createHeaderBackedApprovalRequest(artifact, normalizedSessionId)
            : parseApprovalRequestBody(artifact.body);
        if (!approval || approval.status !== 'open') return [];

        return [{ artifact, approval }];
    });
}
