import { SessionMessageRoleSchema, type SessionMessageRole } from "@happier-dev/protocol";

type SessionMessageRoleContent = PrismaJson.SessionMessageContent | PrismaJson.SessionPendingMessageContent;

export type ResolveSessionMessageRoleResult = Readonly<{
    messageRole: SessionMessageRole | null;
    mismatch: boolean;
}>;

export function parseSessionMessageRole(value: unknown): SessionMessageRole | null {
    const parsed = SessionMessageRoleSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

function derivePlainMessageRole(content: SessionMessageRoleContent): SessionMessageRole | null {
    if (content.t !== "plain" || !content.v || typeof content.v !== "object" || Array.isArray(content.v)) {
        return null;
    }

    const record = content.v as Record<string, unknown>;
    return parseSessionMessageRole(record.role) ?? parseSessionMessageRole(record.type);
}

export function resolveSessionMessageRole(input: Readonly<{
    content: SessionMessageRoleContent;
    suppliedRole?: unknown;
}>): ResolveSessionMessageRoleResult {
    const suppliedRole = parseSessionMessageRole(input.suppliedRole);
    const derivedRole = derivePlainMessageRole(input.content);

    if (derivedRole) {
        return {
            messageRole: derivedRole,
            mismatch: suppliedRole !== null && suppliedRole !== derivedRole,
        };
    }

    return {
        messageRole: suppliedRole,
        mismatch: false,
    };
}
