import {
    type ConnectedServiceBindingSelectionV1,
} from '@happier-dev/protocol';

import {
    findConnectedServiceBindingSelectionFromSessionMetadata,
    resolveConnectedServiceRuntimeAuthContextFromEnv,
    resolveConnectedServiceRuntimeAuthContextFromSessionMetadata,
    type ConnectedServiceRuntimeAuthContext,
    type ConnectedServiceRuntimeAuthMetadataSession,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';

const serviceId = 'openai-codex' as const;

function emptyContext(): ConnectedServiceRuntimeAuthContext {
    return { serviceId, profileId: null, groupId: null };
}

function hasBoundContext(context: ConnectedServiceRuntimeAuthContext): boolean {
    return Boolean(context.profileId || context.groupId);
}

export function resolveCodexConnectedServiceBindingFromSessionMetadata(
    session: ConnectedServiceRuntimeAuthMetadataSession,
): ConnectedServiceBindingSelectionV1 | null {
    return findConnectedServiceBindingSelectionFromSessionMetadata(session, serviceId);
}

export function resolveCodexRuntimeAuthClassificationContext(params: Readonly<{
    runtimeEnv: Pick<NodeJS.ProcessEnv, string>;
    session: ConnectedServiceRuntimeAuthMetadataSession;
}>): ConnectedServiceRuntimeAuthContext {
    const metadataContext = resolveConnectedServiceRuntimeAuthContextFromSessionMetadata(params.session, serviceId);
    if (hasBoundContext(metadataContext)) return metadataContext;

    const envContext = resolveConnectedServiceRuntimeAuthContextFromEnv(params.runtimeEnv, serviceId);
    if (hasBoundContext(envContext)) return envContext;
    return emptyContext();
}
