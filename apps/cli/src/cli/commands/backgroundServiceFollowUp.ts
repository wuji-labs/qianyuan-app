import axios from 'axios';
import type { DaemonServiceListEntry } from '@/daemon/service/cli';
import { isAuthenticationError } from '@/api/client/httpStatusError';
import { resolveLoopbackHttpUrl } from '@/api/client/loopbackUrl';
import { configuration } from '@/configuration';
import type { Credentials } from '@/persistence';

type BackgroundServiceFollowUpMode = 'user' | 'system';
type ServerChangeCredentialState = 'authenticated' | 'authentication-required' | 'unknown';

function isDefaultFollowingService(entry: DaemonServiceListEntry): boolean {
    return entry.targetMode === 'default-following';
}

function countInstalledDefaultFollowingServices(
    services: readonly DaemonServiceListEntry[],
): number {
    let count = 0;
    for (const service of services) {
        if (isDefaultFollowingService(service)) {
            count += 1;
        }
    }
    return count;
}

function resolveBackgroundServiceMode(entry: DaemonServiceListEntry): BackgroundServiceFollowUpMode {
    if (entry.mode != null) {
        return entry.mode === 'system' ? 'system' : 'user';
    }
    return String(entry.path ?? '').includes('/etc/systemd/system/') ? 'system' : 'user';
}

export function resolveInstalledDefaultFollowingDaemonServiceModes(
    services: readonly DaemonServiceListEntry[],
): readonly BackgroundServiceFollowUpMode[] {
    const modes = new Set<BackgroundServiceFollowUpMode>();

    for (const service of services) {
        if (!isDefaultFollowingService(service)) {
            continue;
        }
        modes.add(resolveBackgroundServiceMode(service));
    }

    return [...modes].sort((left, right) => {
        if (left === right) {
            return 0;
        }
        return left === 'system' ? -1 : 1;
    });
}

function resolveRestartModes(
    modes: readonly BackgroundServiceFollowUpMode[] | undefined,
): readonly BackgroundServiceFollowUpMode[] {
    return modes != null && modes.length > 0 ? modes : ['user'];
}

function resolveRestartArgs(mode: BackgroundServiceFollowUpMode): string[] {
    return mode === 'system'
        ? ['service', 'restart', '--mode', 'system']
        : ['service', 'restart'];
}

function renderRestartCommand(mode: BackgroundServiceFollowUpMode): string {
    return mode === 'system'
        ? '  happier service restart --mode system'
        : '  happier service restart';
}

function hasDuplicateDefaultFollowingModes(
    modes: readonly BackgroundServiceFollowUpMode[] | undefined,
): boolean {
    return (modes?.length ?? 0) > 1;
}

function hasMissingHomeMetadataDefaultFollowingService(services: readonly DaemonServiceListEntry[]): boolean {
    return services.some((service) =>
        service.targetMode === 'default-following'
        && String(service.happierHomeDir ?? '').trim().length === 0
        && String(service.releaseChannel ?? '').trim() !== String(configuration.publicReleaseRing ?? '').trim(),
    );
}

function renderRepairGuidance(params: Readonly<{ modes?: readonly BackgroundServiceFollowUpMode[] }>): readonly string[] {
    const requiresSudo = params.modes?.includes('system') ?? false;
    return [
        'Multiple default-following background services are installed. Repair automatic startup before restarting a background service for this change:',
        requiresSudo ? '  sudo happier doctor repair --yes' : '  happier doctor repair --yes',
    ];
}

function renderMissingHomeRepairGuidance(params: Readonly<{ modes?: readonly BackgroundServiceFollowUpMode[] }>): readonly string[] {
    const requiresSudo = params.modes?.includes('system') ?? false;
    return [
        'Detected default-following background services with missing Happier home metadata. Automatic restart guidance will not replace or remove them; remove the legacy service(s) from the owning installation first:',
        requiresSudo ? '  sudo happier doctor repair --yes' : '  happier doctor repair --yes',
    ];
}

async function restartDefaultFollowingBackgroundServices(params: Readonly<{
    modes?: readonly BackgroundServiceFollowUpMode[];
    runCliAction: (args: string[]) => Promise<void>;
}>): Promise<void> {
    for (const mode of resolveRestartModes(params.modes)) {
        await params.runCliAction(resolveRestartArgs(mode));
    }
}

export async function promptForDefaultFollowingBackgroundServiceRestart(params: Readonly<{
    interactive: boolean;
    promptInput: (prompt: string) => Promise<string>;
    runCliAction: (args: string[]) => Promise<void>;
    subject: string;
    modes?: readonly BackgroundServiceFollowUpMode[];
}>): Promise<boolean> {
    if (!params.interactive) {
        return false;
    }

    const answer = String(
        await params.promptInput(`Restart the background service so it now follows ${params.subject}? [Y/n]: `),
    ).trim().toLowerCase();
    const shouldRestart = answer === '' || answer === 'y' || answer === 'yes';
    if (!shouldRestart) {
        return false;
    }

    await restartDefaultFollowingBackgroundServices({
        modes: params.modes,
        runCliAction: params.runCliAction,
    });
    return true;
}

async function readServerChangeCredentialState(
    serverUrl: string,
    credentials: Credentials | null,
): Promise<ServerChangeCredentialState> {
    if (!credentials) {
        return 'authentication-required';
    }

    try {
        const response = await axios.get(`${resolveLoopbackHttpUrl(serverUrl).replace(/\/+$/, '')}/v1/account/profile`, {
            headers: {
                Authorization: `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
            },
            timeout: 5_000,
        });
        const accountId = (response.data as { id?: unknown })?.id;
        return typeof accountId === 'string' && String(accountId).trim().length > 0
            ? 'authenticated'
            : 'unknown';
    } catch (error) {
        return isAuthenticationError(error) ? 'authentication-required' : 'unknown';
    }
}

export async function promptToAuthenticateForServerChange(params: Readonly<{
    interactive: boolean;
    promptInput: (prompt: string) => Promise<string>;
    runCliAction: (args: string[]) => Promise<void>;
    targetServerUrl: string;
    needsAuthentication: boolean;
}>): Promise<'not-needed' | 'authenticated' | 'declined'> {
    if (!params.needsAuthentication) {
        return 'not-needed';
    }
    if (!params.interactive) {
        return 'declined';
    }

    const answer = String(
        await params.promptInput(`Authenticate Happier against ${params.targetServerUrl} now? [Y/n]: `),
    ).trim().toLowerCase();
    const shouldAuthenticate = answer === '' || answer === 'y' || answer === 'yes';
    if (!shouldAuthenticate) {
        return 'declined';
    }

    await params.runCliAction(['auth', 'login']);
    return 'authenticated';
}

function renderManualRestartFollowUp(params: Readonly<{
    subject: string;
    modes?: readonly BackgroundServiceFollowUpMode[];
}>): readonly string[] {
    return [
        `Restart the background service so it now follows ${params.subject}:`,
        ...resolveRestartModes(params.modes).map(renderRestartCommand),
    ];
}

function renderManualServerChangeFollowUp(params: Readonly<{
    targetServerUrl: string;
    credentialState: ServerChangeCredentialState;
    modes?: readonly BackgroundServiceFollowUpMode[];
}>): readonly string[] {
    if (params.credentialState !== 'authentication-required') {
        return renderManualRestartFollowUp({
            subject: params.targetServerUrl,
            modes: params.modes,
        });
    }

    return [
        `Authenticate Happier against ${params.targetServerUrl} and then restart the background service so it follows that server:`,
        '  happier auth login',
        ...resolveRestartModes(params.modes).map(renderRestartCommand),
    ];
}

export async function runDefaultFollowingBackgroundServiceRestartFollowUp(params: Readonly<{
    interactive: boolean;
    promptInput: (prompt: string) => Promise<string>;
    runCliAction: (args: string[]) => Promise<void>;
    subject: string;
    log: (message: string) => void;
    modes?: readonly BackgroundServiceFollowUpMode[];
}>): Promise<boolean> {
    if (hasDuplicateDefaultFollowingModes(params.modes)) {
        for (const line of renderRepairGuidance({ modes: params.modes })) {
            params.log(line);
        }
        return false;
    }

    if (!params.interactive) {
        for (const line of renderManualRestartFollowUp({
            subject: params.subject,
            modes: params.modes,
        })) {
            params.log(line);
        }
        return false;
    }

    try {
        return await promptForDefaultFollowingBackgroundServiceRestart(params);
    } catch {
        params.log('Background service follow-up failed after the primary change was already applied.');
        for (const line of renderManualRestartFollowUp({
            subject: params.subject,
            modes: params.modes,
        })) {
            params.log(line);
        }
        return false;
    }
}

export async function runDefaultFollowingBackgroundServiceServerChangeFollowUp(params: Readonly<{
    interactive: boolean;
    promptInput: (prompt: string) => Promise<string>;
    runCliAction: (args: string[]) => Promise<void>;
    targetServerUrl: string;
    credentials: Credentials | null;
    log: (message: string) => void;
    services: readonly DaemonServiceListEntry[];
}>): Promise<void> {
    const modes = resolveInstalledDefaultFollowingDaemonServiceModes(params.services);
    if (modes.length === 0) {
        return;
    }

    if (hasMissingHomeMetadataDefaultFollowingService(params.services)) {
        for (const line of renderMissingHomeRepairGuidance({ modes })) {
            params.log(line);
        }
        return;
    }

    if (countInstalledDefaultFollowingServices(params.services) > 1) {
        for (const line of renderRepairGuidance({ modes })) {
            params.log(line);
        }
        return;
    }
    let credentialState: ServerChangeCredentialState = params.credentials ? 'unknown' : 'authentication-required';

    try {
        credentialState = await readServerChangeCredentialState(params.targetServerUrl, params.credentials);

        if (!params.interactive) {
            for (const line of renderManualServerChangeFollowUp({
                targetServerUrl: params.targetServerUrl,
                credentialState,
                modes,
            })) {
                params.log(line);
            }
            return;
        }

        const authOutcome = await promptToAuthenticateForServerChange({
            ...params,
            needsAuthentication: credentialState === 'authentication-required',
        });
        if (authOutcome === 'declined') {
            params.log(`Background service was not restarted because ${params.targetServerUrl} is not authenticated yet.`);
            for (const line of renderManualServerChangeFollowUp({
                targetServerUrl: params.targetServerUrl,
                credentialState: 'authentication-required',
                modes,
            })) {
                params.log(line);
            }
            return;
        }

        if (authOutcome === 'authenticated') {
            credentialState = 'authenticated';
        }

        await promptForDefaultFollowingBackgroundServiceRestart({
            interactive: params.interactive,
            promptInput: params.promptInput,
            runCliAction: params.runCliAction,
            subject: params.targetServerUrl,
            modes,
        });
    } catch {
        params.log('Background service follow-up failed after the primary change was already applied.');
        for (const line of renderManualServerChangeFollowUp({
            targetServerUrl: params.targetServerUrl,
            credentialState,
            modes,
        })) {
            params.log(line);
        }
    }
}
