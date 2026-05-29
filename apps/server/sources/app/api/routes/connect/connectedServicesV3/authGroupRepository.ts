import { z } from "zod";

import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import {
    parseConnectedServiceAuthGroupPolicyJson,
    stringifyConnectedServiceAuthGroupPolicy,
    type ConnectedServiceAuthGroupPolicyV1,
} from "./authGroupPolicy";
import {
    AuthGroupResponseSchema,
    ConnectedServiceAuthGroupMemberStateSchema,
    ConnectedServiceAuthGroupStateSchema,
} from "./authGroupSchemas";

type AuthGroupState = z.infer<typeof ConnectedServiceAuthGroupStateSchema>;
type AuthGroupMemberState = z.infer<typeof ConnectedServiceAuthGroupMemberStateSchema>;
type AuthGroupResponse = z.infer<typeof AuthGroupResponseSchema>;
export type DeleteConnectedServiceCredentialResult = "deleted" | "not_found" | "referenced";
export type CreateAuthGroupMemberResult = "created" | "group_not_found" | "profile_not_found";
export type UpdateAuthGroupMemberResult = "updated" | "unchanged" | "not_found";
export type DeleteAuthGroupMemberResult = "deleted" | "not_found";

type AuthGroupMemberRow = Readonly<{
    profileId: string;
    priority: number;
    enabled: boolean;
    stateJson: string | null;
    createdAt: Date;
    updatedAt: Date;
}>;

type AuthGroupRow = Readonly<{
    id: string;
    vendor: string;
    groupId: string;
    displayName: string | null;
    policyJson: string;
    activeProfileId: string | null;
    generation: number;
    stateJson: string | null;
    createdAt: Date;
    updatedAt: Date;
    members: readonly AuthGroupMemberRow[];
}>;

const memberOrderBy = [
    { priority: "asc" as const },
    { profileId: "asc" as const },
];

export function stringifyAuthGroupState(state: AuthGroupState | null | undefined): string | null {
    if (state == null) return null;
    return JSON.stringify(ConnectedServiceAuthGroupStateSchema.parse(state));
}

export function stringifyAuthGroupMemberState(state: AuthGroupMemberState | null | undefined): string | null {
    if (state == null) return null;
    return JSON.stringify(ConnectedServiceAuthGroupMemberStateSchema.parse(state));
}

function parseAuthGroupStateJson(stateJson: string | null): AuthGroupState {
    if (!stateJson) return ConnectedServiceAuthGroupStateSchema.parse({});
    try {
        const parsed = ConnectedServiceAuthGroupStateSchema.safeParse(JSON.parse(stateJson));
        return parsed.success ? parsed.data : ConnectedServiceAuthGroupStateSchema.parse({});
    } catch {
        return ConnectedServiceAuthGroupStateSchema.parse({});
    }
}

function parseAuthGroupMemberStateJson(stateJson: string | null): AuthGroupMemberState {
    if (!stateJson) return ConnectedServiceAuthGroupMemberStateSchema.parse({});
    try {
        const parsed = ConnectedServiceAuthGroupMemberStateSchema.safeParse(JSON.parse(stateJson));
        return parsed.success ? parsed.data : ConnectedServiceAuthGroupMemberStateSchema.parse({});
    } catch {
        return ConnectedServiceAuthGroupMemberStateSchema.parse({});
    }
}

export function toAuthGroupResponse(row: AuthGroupRow): AuthGroupResponse {
    const response = {
        v: 1,
        serviceId: row.vendor,
        groupId: row.groupId,
        displayName: row.displayName,
        policy: parseConnectedServiceAuthGroupPolicyJson(row.policyJson),
        activeProfileId: row.activeProfileId,
        generation: row.generation,
        state: parseAuthGroupStateJson(row.stateJson),
        members: row.members.map((member) => ({
            v: 1,
            serviceId: row.vendor,
            groupId: row.groupId,
            profileId: member.profileId,
            priority: member.priority,
            enabled: member.enabled,
            state: parseAuthGroupMemberStateJson(member.stateJson),
            createdAt: member.createdAt.getTime(),
            updatedAt: member.updatedAt.getTime(),
        })),
        createdAt: row.createdAt.getTime(),
        updatedAt: row.updatedAt.getTime(),
    };
    return AuthGroupResponseSchema.parse(response);
}

export async function listAuthGroupsForAccount(params: {
    accountId: string;
    serviceId: string;
}): Promise<AuthGroupResponse[]> {
    const rows = await db.connectedServiceAuthGroup.findMany({
        where: { accountId: params.accountId, vendor: params.serviceId },
        include: { members: { orderBy: memberOrderBy } },
        orderBy: [{ groupId: "asc" }],
    });
    return rows.map(toAuthGroupResponse);
}

export async function findAuthGroupForAccount(params: {
    accountId: string;
    serviceId: string;
    groupId: string;
}): Promise<AuthGroupResponse | null> {
    const row = await db.connectedServiceAuthGroup.findUnique({
        where: {
            accountId_vendor_groupId: {
                accountId: params.accountId,
                vendor: params.serviceId,
                groupId: params.groupId,
            },
        },
        include: { members: { orderBy: memberOrderBy } },
    });
    return row ? toAuthGroupResponse(row) : null;
}

export async function hasConnectedServiceProfile(params: {
    accountId: string;
    serviceId: string;
    profileId: string;
}): Promise<boolean> {
    const row = await db.serviceAccountToken.findUnique({
        where: {
            accountId_vendor_profileId: {
                accountId: params.accountId,
                vendor: params.serviceId,
                profileId: params.profileId,
            },
        },
        select: { id: true },
    });
    return row !== null;
}

export async function findAuthGroupMemberReference(params: {
    accountId: string;
    serviceId: string;
    profileId: string;
}): Promise<{ groupId: string } | null> {
    return db.connectedServiceAuthGroupMember.findFirst({
        where: {
            accountId: params.accountId,
            vendor: params.serviceId,
            profileId: params.profileId,
        },
        select: { groupId: true },
    });
}

export async function isCredentialReferencedByAuthGroup(params: {
    accountId: string;
    serviceId: string;
    profileId: string;
}): Promise<boolean> {
    return (await findAuthGroupMemberReference(params)) !== null;
}

export async function deleteConnectedServiceCredentialInTx(tx: Tx, params: {
    accountId: string;
    serviceId: string;
    profileId: string;
    allowReferencedGroupCleanup: boolean;
}): Promise<DeleteConnectedServiceCredentialResult> {
    const existing = await tx.serviceAccountToken.findUnique({
        where: {
            accountId_vendor_profileId: {
                accountId: params.accountId,
                vendor: params.serviceId,
                profileId: params.profileId,
            },
        },
        select: { id: true },
    });
    if (!existing) return "not_found";

    if (!params.allowReferencedGroupCleanup) {
        const reference = await tx.connectedServiceAuthGroupMember.findFirst({
            where: {
                accountId: params.accountId,
                vendor: params.serviceId,
                profileId: params.profileId,
            },
            select: { id: true },
        });
        if (reference) return "referenced";
    } else {
        const affectedMembers = await tx.connectedServiceAuthGroupMember.findMany({
            where: {
                accountId: params.accountId,
                vendor: params.serviceId,
                profileId: params.profileId,
            },
            select: { groupDbId: true },
        });
        const activeGroups = await tx.connectedServiceAuthGroup.findMany({
            where: {
                accountId: params.accountId,
                vendor: params.serviceId,
                activeProfileId: params.profileId,
            },
            select: { id: true },
        });
        const affectedGroupDbIds = [
            ...new Set([
                ...affectedMembers.map((member) => member.groupDbId),
                ...activeGroups.map((group) => group.id),
            ]),
        ];
        if (affectedGroupDbIds.length > 0) {
            await tx.connectedServiceAuthGroup.updateMany({
                where: {
                    id: { in: affectedGroupDbIds },
                    accountId: params.accountId,
                    vendor: params.serviceId,
                },
                data: { generation: { increment: 1 } },
            });
        }
        await tx.connectedServiceAuthGroup.updateMany({
            where: {
                accountId: params.accountId,
                vendor: params.serviceId,
                activeProfileId: params.profileId,
            },
            data: { activeProfileId: null },
        });
    }

    await tx.serviceAccountToken.delete({ where: { id: existing.id } });
    return "deleted";
}

export async function deleteConnectedServiceCredential(params: {
    accountId: string;
    serviceId: string;
    profileId: string;
    allowReferencedGroupCleanup: boolean;
}): Promise<DeleteConnectedServiceCredentialResult> {
    return inTx(async (tx) => deleteConnectedServiceCredentialInTx(tx, params));
}

export function encodePolicyForStorage(policy: ConnectedServiceAuthGroupPolicyV1): string {
    return stringifyConnectedServiceAuthGroupPolicy(policy);
}

export async function createAuthGroupMemberAndBumpGenerationInTx(tx: Tx, params: {
    accountId: string;
    serviceId: string;
    groupId: string;
    profileId: string;
    priority: number;
    enabled: boolean;
}): Promise<CreateAuthGroupMemberResult> {
    const group = await tx.connectedServiceAuthGroup.findUnique({
        where: {
            accountId_vendor_groupId: {
                accountId: params.accountId,
                vendor: params.serviceId,
                groupId: params.groupId,
            },
        },
        select: { id: true },
    });
    if (!group) return "group_not_found";

    const profile = await tx.serviceAccountToken.findUnique({
        where: {
            accountId_vendor_profileId: {
                accountId: params.accountId,
                vendor: params.serviceId,
                profileId: params.profileId,
            },
        },
        select: { id: true },
    });
    if (!profile) return "profile_not_found";

    await tx.connectedServiceAuthGroupMember.create({
        data: {
            groupDbId: group.id,
            accountId: params.accountId,
            vendor: params.serviceId,
            groupId: params.groupId,
            profileId: params.profileId,
            priority: params.priority,
            enabled: params.enabled,
            stateJson: null,
        },
    });
    await tx.connectedServiceAuthGroup.update({
        where: { id: group.id },
        data: { generation: { increment: 1 } },
    });
    return "created";
}

export async function updateAuthGroupMemberAndBumpGenerationInTx(tx: Tx, params: {
    accountId: string;
    serviceId: string;
    groupId: string;
    profileId: string;
    priority?: number;
    enabled?: boolean;
}): Promise<UpdateAuthGroupMemberResult> {
    const member = await tx.connectedServiceAuthGroupMember.findUnique({
        where: {
            accountId_vendor_groupId_profileId: {
                accountId: params.accountId,
                vendor: params.serviceId,
                groupId: params.groupId,
                profileId: params.profileId,
            },
        },
        select: { id: true, groupDbId: true, priority: true, enabled: true },
    });
    if (!member) return "not_found";

    const changesCandidate = (params.priority !== undefined && params.priority !== member.priority)
        || (params.enabled !== undefined && params.enabled !== member.enabled);
    if (!changesCandidate) return "unchanged";

    await tx.connectedServiceAuthGroupMember.update({
        where: { id: member.id },
        data: {
            ...(params.priority !== undefined ? { priority: params.priority } : {}),
            ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
        },
    });
    const clearedActiveProfile = params.enabled === false
        ? await tx.connectedServiceAuthGroup.updateMany({
            where: { id: member.groupDbId, activeProfileId: params.profileId },
            data: {
                activeProfileId: null,
                generation: { increment: 1 },
            },
        })
        : null;
    if (!clearedActiveProfile || clearedActiveProfile.count === 0) {
        await tx.connectedServiceAuthGroup.update({
            where: { id: member.groupDbId },
            data: { generation: { increment: 1 } },
        });
    }
    return "updated";
}

export async function deleteAuthGroupMemberAndBumpGenerationInTx(tx: Tx, params: {
    accountId: string;
    serviceId: string;
    groupId: string;
    profileId: string;
}): Promise<DeleteAuthGroupMemberResult> {
    const member = await tx.connectedServiceAuthGroupMember.findUnique({
        where: {
            accountId_vendor_groupId_profileId: {
                accountId: params.accountId,
                vendor: params.serviceId,
                groupId: params.groupId,
                profileId: params.profileId,
            },
        },
        select: { id: true, groupDbId: true },
    });
    if (!member) return "not_found";

    await tx.connectedServiceAuthGroupMember.delete({ where: { id: member.id } });
    await tx.connectedServiceAuthGroup.update({
        where: { id: member.groupDbId },
        data: { generation: { increment: 1 } },
    });
    await tx.connectedServiceAuthGroup.updateMany({
        where: { id: member.groupDbId, activeProfileId: params.profileId },
        data: { activeProfileId: null },
    });
    return "deleted";
}
