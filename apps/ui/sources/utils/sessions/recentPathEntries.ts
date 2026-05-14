export type SessionRecentPathEntry = string;

const SESSION_RECENT_PATH_ENTRY_PREFIX = 'happier:session-recent-path:v1:';

type DecodedSessionRecentPathEntry = Readonly<{
    sessionId: string;
    machineId: string;
    path: string;
    createdAt: number;
}>;

export function encodeSessionRecentPathEntry(input: DecodedSessionRecentPathEntry): SessionRecentPathEntry {
    return `${SESSION_RECENT_PATH_ENTRY_PREFIX}${JSON.stringify([
        input.sessionId,
        input.machineId,
        input.path,
        input.createdAt,
    ])}`;
}

export function decodeSessionRecentPathEntry(raw: string): DecodedSessionRecentPathEntry | null {
    if (!raw.startsWith(SESSION_RECENT_PATH_ENTRY_PREFIX)) {
        return null;
    }

    try {
        const decoded = JSON.parse(raw.slice(SESSION_RECENT_PATH_ENTRY_PREFIX.length));
        if (!Array.isArray(decoded) || decoded.length !== 4) {
            return null;
        }

        const [sessionId, machineId, path, createdAt] = decoded;
        if (
            typeof sessionId !== 'string' ||
            typeof machineId !== 'string' ||
            typeof path !== 'string' ||
            typeof createdAt !== 'number' ||
            !Number.isFinite(createdAt)
        ) {
            return null;
        }

        return { sessionId, machineId, path, createdAt };
    } catch {
        return null;
    }
}
