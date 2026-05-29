import { z } from "zod";

import type { Fastify } from "../../../types";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/prisma";
import { isServerFeatureEnabledForRequest } from "@/app/features/catalog/serverFeatureGate";
import { recordConnectedServiceAccountProfileChange } from "../connectedServicesAccountProfileChange";
import {
    DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
    ConnectedServiceAuthGroupPolicyPatchSchema,
    mergeConnectedServiceAuthGroupPolicyPatch,
    type ConnectedServiceAuthGroupPolicyPatch,
} from "./authGroupPolicy";
import {
    ActiveProfileBodySchema,
    AuthGroupEnvelopeResponseSchema,
    AuthGroupErrorResponseSchema,
    ConnectedServiceAuthGroupMemberStateSchema,
    AuthGroupListResponseSchema,
    AuthGroupMemberInputSchema,
    AuthGroupMemberParamsSchema,
    AuthGroupParamsSchema,
    AuthGroupServiceParamsSchema,
    AuthGroupSuccessResponseSchema,
    CreateAuthGroupBodySchema,
    RuntimeStatePatchBodySchema,
    UpdateAuthGroupBodySchema,
    UpdateAuthGroupMemberBodySchema,
} from "./authGroupSchemas";
import {
    createAuthGroupMemberAndBumpGenerationInTx,
    deleteAuthGroupMemberAndBumpGenerationInTx,
    encodePolicyForStorage,
    findAuthGroupForAccount,
    hasConnectedServiceProfile,
    listAuthGroupsForAccount,
    stringifyAuthGroupMemberState,
    stringifyAuthGroupState,
    updateAuthGroupMemberAndBumpGenerationInTx,
} from "./authGroupRepository";

const NotFoundResponseSchema = z.object({ error: z.literal("not_found") });
type AuthGroupEnvelopeResponse = z.infer<typeof AuthGroupEnvelopeResponseSchema>;
type ConnectedServiceAuthGroupMemberState = z.infer<typeof ConnectedServiceAuthGroupMemberStateSchema>;

function isUniqueConflict(error: unknown): boolean {
    return isPrismaErrorCode(error, "P2002");
}

function isForeignKeyConflict(error: unknown): boolean {
    return isPrismaErrorCode(error, "P2003");
}

function fallbackEnabled(): boolean {
    return isServerFeatureEnabledForRequest("connectedServices.accountFallback", process.env);
}

function requiresFallbackFeature(policy: { autoSwitch?: boolean } | undefined): boolean {
    return policy?.autoSwitch === true;
}

function parsePolicyPatchForRequest(policy: unknown): ConnectedServiceAuthGroupPolicyPatch | null | undefined {
    if (policy === undefined) return undefined;
    const parsed = ConnectedServiceAuthGroupPolicyPatchSchema.safeParse(policy);
    return parsed.success ? parsed.data : null;
}

function parseMemberRuntimeStateJson(stateJson: string | null): ConnectedServiceAuthGroupMemberState {
    if (!stateJson) return ConnectedServiceAuthGroupMemberStateSchema.parse({});
    try {
        const parsed = ConnectedServiceAuthGroupMemberStateSchema.safeParse(JSON.parse(stateJson));
        return parsed.success ? parsed.data : ConnectedServiceAuthGroupMemberStateSchema.parse({});
    } catch {
        return ConnectedServiceAuthGroupMemberStateSchema.parse({});
    }
}

function readRuntimeCooldownResetAtMsFromState(
    state: ConnectedServiceAuthGroupMemberState,
    nowMs: number,
): number | null {
    const resetAtValues = [
        state.cooldownUntilMs,
        state.exhaustedUntilMs,
        state.quotaExhaustedUntilMs,
        state.rateLimitedUntilMs,
        state.capacityLimitedUntilMs,
        state.authInvalidUntilMs,
    ].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > nowMs);
    return resetAtValues.length > 0 ? Math.max(...resetAtValues) : null;
}

function readRuntimeCooldownResetAtMs(stateJson: string | null, nowMs: number): number | null {
    return readRuntimeCooldownResetAtMsFromState(parseMemberRuntimeStateJson(stateJson), nowMs);
}

async function allProfilesExist(params: {
    accountId: string;
    serviceId: string;
    profileIds: readonly string[];
}): Promise<boolean> {
    for (const profileId of params.profileIds) {
        const exists = await hasConnectedServiceProfile({ ...params, profileId });
        if (!exists) return false;
    }
    return true;
}

function hasDuplicateProfileIds(members: readonly { profileId: string }[]): boolean {
    return new Set(members.map((member) => member.profileId)).size !== members.length;
}

function resolveCreateActiveProfileId(params: {
    members: readonly { profileId: string; enabled?: boolean }[];
    requestedActiveProfileId: string | null | undefined;
}): string | null | "invalid" {
    if (params.requestedActiveProfileId !== undefined) {
        if (params.requestedActiveProfileId === null) return null;
        const requestedMember = params.members.find((member) => member.profileId === params.requestedActiveProfileId);
        return requestedMember?.enabled !== false ? params.requestedActiveProfileId : "invalid";
    }
    return params.members.find((member) => member.enabled !== false)?.profileId ?? null;
}

async function loadGroupEnvelope(params: {
    accountId: string;
    serviceId: string;
    groupId: string;
}): Promise<AuthGroupEnvelopeResponse | null> {
    const group = await findAuthGroupForAccount(params);
    return group ? { group } : null;
}

export function registerConnectedServiceAuthGroupRoutesV3(app: Fastify): void {
    app.get("/v3/connect/:serviceId/groups", {
        preHandler: app.authenticate,
        schema: {
            params: AuthGroupServiceParamsSchema,
            response: { 200: AuthGroupListResponseSchema, 404: NotFoundResponseSchema },
        },
    }, async (request, reply) => {
        const groups = await listAuthGroupsForAccount({
            accountId: request.userId,
            serviceId: request.params.serviceId,
        });
        return reply.send({ groups });
    });

    app.post("/v3/connect/:serviceId/groups", {
        preHandler: app.authenticate,
        schema: {
            params: AuthGroupServiceParamsSchema,
            body: CreateAuthGroupBodySchema,
            response: { 200: AuthGroupEnvelopeResponseSchema, 400: AuthGroupErrorResponseSchema, 404: z.union([NotFoundResponseSchema, AuthGroupErrorResponseSchema]), 409: AuthGroupErrorResponseSchema },
        },
    }, async (request, reply) => {
        const accountId = request.userId;
        const serviceId = request.params.serviceId;
        const body = request.body;
        const members = body.members;
        const policyPatch = parsePolicyPatchForRequest(body.policy);

        if (policyPatch === null) {
            return reply.code(400).send({ error: "connect_group_invalid" });
        }

        if (hasDuplicateProfileIds(members)) {
            return reply.code(400).send({ error: "connect_group_duplicate_member" });
        }
        if (requiresFallbackFeature(policyPatch) && !fallbackEnabled()) {
            return reply.code(400).send({ error: "connect_group_fallback_disabled" });
        }

        const memberProfileIds = members.map((member) => member.profileId);
        const activeProfileId = resolveCreateActiveProfileId({
            members,
            requestedActiveProfileId: body.activeProfileId,
        });
        if (activeProfileId === "invalid") {
            return reply.code(400).send({ error: "connect_group_active_profile_not_member" });
        }
        if (!(await allProfilesExist({ accountId, serviceId, profileIds: memberProfileIds }))) {
            return reply.code(400).send({ error: "connect_group_member_profile_not_found" });
        }

        const policy = mergeConnectedServiceAuthGroupPolicyPatch(DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, policyPatch);
        try {
            await inTx(async (tx) => {
                await tx.connectedServiceAuthGroup.create({
                    data: {
                        accountId,
                        vendor: serviceId,
                        groupId: body.groupId,
                        displayName: body.displayName ?? null,
                        policyJson: encodePolicyForStorage(policy),
                        activeProfileId,
                        stateJson: null,
                        members: {
                            create: members.map((member) => ({
                                accountId,
                                vendor: serviceId,
                                groupId: body.groupId,
                                profileId: member.profileId,
                                priority: member.priority ?? 100,
                                enabled: member.enabled ?? true,
                                stateJson: null,
                            })),
                        },
                    },
                });
                await recordConnectedServiceAccountProfileChange(tx, { accountId });
            });
        } catch (error) {
            if (isUniqueConflict(error)) return reply.code(409).send({ error: "connect_group_already_exists" });
            if (isForeignKeyConflict(error)) {
                return reply.code(400).send({ error: "connect_group_member_profile_not_found" });
            }
            throw error;
        }

        const envelope = await loadGroupEnvelope({ accountId, serviceId, groupId: body.groupId });
        if (!envelope) return reply.code(404).send({ error: "connect_group_not_found" });
        return reply.send(envelope);
    });

    app.get("/v3/connect/:serviceId/groups/:groupId", {
        preHandler: app.authenticate,
        schema: {
            params: AuthGroupParamsSchema,
            response: { 200: AuthGroupEnvelopeResponseSchema, 404: z.union([NotFoundResponseSchema, AuthGroupErrorResponseSchema]) },
        },
    }, async (request, reply) => {
        const envelope = await loadGroupEnvelope({
            accountId: request.userId,
            serviceId: request.params.serviceId,
            groupId: request.params.groupId,
        });
        if (!envelope) return reply.code(404).send({ error: "connect_group_not_found" });
        return reply.send(envelope);
    });

    app.patch("/v3/connect/:serviceId/groups/:groupId", {
        preHandler: app.authenticate,
        schema: {
            params: AuthGroupParamsSchema,
            body: UpdateAuthGroupBodySchema,
            response: { 200: AuthGroupEnvelopeResponseSchema, 400: AuthGroupErrorResponseSchema, 404: z.union([NotFoundResponseSchema, AuthGroupErrorResponseSchema]), 409: AuthGroupErrorResponseSchema },
        },
    }, async (request, reply) => {
        const { serviceId, groupId } = request.params;
        const existing = await findAuthGroupForAccount({ accountId: request.userId, serviceId, groupId });
        if (!existing) return reply.code(404).send({ error: "connect_group_not_found" });
        const policyPatch = parsePolicyPatchForRequest(request.body.policy);
        if (policyPatch === null) {
            return reply.code(400).send({ error: "connect_group_invalid" });
        }
        const policy = mergeConnectedServiceAuthGroupPolicyPatch(existing.policy, policyPatch);
        if (requiresFallbackFeature(policyPatch) && !fallbackEnabled()) {
            return reply.code(400).send({ error: "connect_group_fallback_disabled" });
        }
        if (request.body.activeProfileId !== undefined && !fallbackEnabled()) {
            return reply.code(400).send({ error: "connect_group_fallback_disabled" });
        }
        if (request.body.activeProfileId !== undefined && request.body.activeProfileId !== null) {
            const activeProfileMember = existing.members.find(
                (member) => member.profileId === request.body.activeProfileId && member.enabled,
            );
            if (!activeProfileMember) {
                return reply.code(400).send({ error: "connect_group_active_profile_not_member" });
            }
            const resetAtMs = readRuntimeCooldownResetAtMsFromState(activeProfileMember.state, Date.now());
            if (resetAtMs !== null) {
                return reply.code(409).send({ error: "connect_group_profile_runtime_cooldown", resetAtMs });
            }
        }
        const changesDisplayName = request.body.displayName !== undefined
            && existing.displayName !== request.body.displayName;
        const changesActiveProfile = request.body.activeProfileId !== undefined
            && existing.activeProfileId !== request.body.activeProfileId;
        await inTx(async (tx) => {
            await tx.connectedServiceAuthGroup.update({
                where: { accountId_vendor_groupId: { accountId: request.userId, vendor: serviceId, groupId } },
                data: {
                    ...(request.body.displayName !== undefined ? { displayName: request.body.displayName } : {}),
                    ...(request.body.policy !== undefined ? { policyJson: encodePolicyForStorage(policy) } : {}),
                    ...(request.body.activeProfileId !== undefined ? { activeProfileId: request.body.activeProfileId } : {}),
                    ...(changesActiveProfile ? { generation: { increment: 1 } } : {}),
                },
            });
            if (changesDisplayName || changesActiveProfile) {
                await recordConnectedServiceAccountProfileChange(tx, { accountId: request.userId });
            }
        });
        const envelope = await loadGroupEnvelope({ accountId: request.userId, serviceId, groupId });
        if (!envelope) return reply.code(404).send({ error: "connect_group_not_found" });
        return reply.send(envelope);
    });

    app.delete("/v3/connect/:serviceId/groups/:groupId", {
        preHandler: app.authenticate,
        schema: {
            params: AuthGroupParamsSchema,
            response: { 200: AuthGroupSuccessResponseSchema, 404: z.union([NotFoundResponseSchema, AuthGroupErrorResponseSchema]) },
        },
    }, async (request, reply) => {
        const { serviceId, groupId } = request.params;
        const existing = await findAuthGroupForAccount({ accountId: request.userId, serviceId, groupId });
        if (!existing) return reply.code(404).send({ error: "connect_group_not_found" });
        await inTx(async (tx) => {
            await tx.connectedServiceAuthGroup.delete({
                where: { accountId_vendor_groupId: { accountId: request.userId, vendor: serviceId, groupId } },
            });
            await recordConnectedServiceAccountProfileChange(tx, { accountId: request.userId });
        });
        return reply.send({ success: true });
    });

    app.patch("/v3/connect/:serviceId/groups/:groupId/runtime-state", {
        preHandler: app.authenticate,
        schema: {
            params: AuthGroupParamsSchema,
            body: RuntimeStatePatchBodySchema,
            response: { 200: AuthGroupEnvelopeResponseSchema, 400: AuthGroupErrorResponseSchema, 404: z.union([NotFoundResponseSchema, AuthGroupErrorResponseSchema]), 409: AuthGroupErrorResponseSchema },
        },
    }, async (request, reply) => {
        const { serviceId, groupId } = request.params;
        const result = await inTx(async (tx) => {
            const group = await tx.connectedServiceAuthGroup.findUnique({
                where: { accountId_vendor_groupId: { accountId: request.userId, vendor: serviceId, groupId } },
                select: { id: true, generation: true },
            });
            if (!group) return { type: "not-found" as const };
            if (
                request.body.expectedGeneration !== undefined
                && request.body.expectedGeneration !== group.generation
            ) {
                return { type: "generation-conflict" as const, generation: group.generation };
            }

            const memberStates = request.body.memberStates;
            if (memberStates.length > 0) {
                const requestedProfileIds = memberStates.map((member) => member.profileId);
                const members = await tx.connectedServiceAuthGroupMember.findMany({
                    where: {
                        accountId: request.userId,
                        vendor: serviceId,
                        groupId,
                        profileId: { in: requestedProfileIds },
                    },
                    select: { profileId: true },
                });
                if (members.length !== new Set(requestedProfileIds).size) {
                    return { type: "member-not-found" as const };
                }
            }

            if (request.body.expectedGeneration !== undefined) {
                const update = await tx.connectedServiceAuthGroup.updateMany({
                    where: { id: group.id, generation: request.body.expectedGeneration },
                    data: {
                        updatedAt: new Date(),
                        ...(request.body.state !== undefined
                            ? { stateJson: stringifyAuthGroupState(request.body.state) }
                            : {}),
                    },
                });
                if (update.count !== 1) {
                    const current = await tx.connectedServiceAuthGroup.findUnique({
                        where: { id: group.id },
                        select: { generation: true },
                    });
                    return {
                        type: "generation-conflict" as const,
                        generation: current?.generation ?? group.generation,
                    };
                }
            } else if (request.body.state !== undefined) {
                await tx.connectedServiceAuthGroup.update({
                    where: { id: group.id },
                    data: { stateJson: stringifyAuthGroupState(request.body.state) },
                });
            }

            for (const member of memberStates) {
                await tx.connectedServiceAuthGroupMember.update({
                    where: {
                        accountId_vendor_groupId_profileId: {
                            accountId: request.userId,
                            vendor: serviceId,
                            groupId,
                            profileId: member.profileId,
                        },
                    },
                    data: { stateJson: stringifyAuthGroupMemberState(member.state) },
                });
            }

            return { type: "success" as const };
        });

        if (result.type === "not-found") return reply.code(404).send({ error: "connect_group_not_found" });
        if (result.type === "member-not-found") return reply.code(400).send({ error: "connect_group_member_not_found" });
        if (result.type === "generation-conflict") {
            return reply.code(409).send({
                error: "connect_group_generation_conflict",
                generation: result.generation,
            });
        }

        const envelope = await loadGroupEnvelope({ accountId: request.userId, serviceId, groupId });
        if (!envelope) return reply.code(404).send({ error: "connect_group_not_found" });
        return reply.send(envelope);
    });

    app.post("/v3/connect/:serviceId/groups/:groupId/members", {
        preHandler: app.authenticate,
        schema: {
            params: AuthGroupParamsSchema,
            body: AuthGroupMemberInputSchema,
            response: { 200: AuthGroupEnvelopeResponseSchema, 400: AuthGroupErrorResponseSchema, 404: z.union([NotFoundResponseSchema, AuthGroupErrorResponseSchema]), 409: AuthGroupErrorResponseSchema },
        },
    }, async (request, reply) => {
        const { serviceId, groupId } = request.params;
        try {
            const result = await inTx(async (tx) => {
                const mutationResult = await createAuthGroupMemberAndBumpGenerationInTx(tx, {
                    accountId: request.userId,
                    serviceId,
                    groupId,
                    profileId: request.body.profileId,
                    priority: request.body.priority ?? 100,
                    enabled: request.body.enabled ?? true,
                });
                if (mutationResult === "created") {
                    await recordConnectedServiceAccountProfileChange(tx, { accountId: request.userId });
                }
                return mutationResult;
            });
            if (result === "group_not_found") return reply.code(404).send({ error: "connect_group_not_found" });
            if (result === "profile_not_found") {
                return reply.code(400).send({ error: "connect_group_member_profile_not_found" });
            }
        } catch (error) {
            if (isUniqueConflict(error)) return reply.code(409).send({ error: "connect_group_member_already_exists" });
            if (isForeignKeyConflict(error)) {
                const groupStillExists = await db.connectedServiceAuthGroup.findUnique({
                    where: { accountId_vendor_groupId: { accountId: request.userId, vendor: serviceId, groupId } },
                    select: { id: true },
                });
                if (!groupStillExists) return reply.code(404).send({ error: "connect_group_not_found" });
                return reply.code(400).send({ error: "connect_group_member_profile_not_found" });
            }
            throw error;
        }
        const envelope = await loadGroupEnvelope({ accountId: request.userId, serviceId, groupId });
        if (!envelope) return reply.code(404).send({ error: "connect_group_not_found" });
        return reply.send(envelope);
    });

    app.patch("/v3/connect/:serviceId/groups/:groupId/members/:profileId", {
        preHandler: app.authenticate,
        schema: {
            params: AuthGroupMemberParamsSchema,
            body: UpdateAuthGroupMemberBodySchema,
            response: { 200: AuthGroupEnvelopeResponseSchema, 404: z.union([NotFoundResponseSchema, AuthGroupErrorResponseSchema]) },
        },
    }, async (request, reply) => {
        const { serviceId, groupId, profileId } = request.params;
        const result = await inTx(async (tx) => {
            const mutationResult = await updateAuthGroupMemberAndBumpGenerationInTx(tx, {
                accountId: request.userId,
                serviceId,
                groupId,
                profileId,
                priority: request.body.priority,
                enabled: request.body.enabled,
            });
            if (mutationResult === "updated") {
                await recordConnectedServiceAccountProfileChange(tx, { accountId: request.userId });
            }
            return mutationResult;
        });
        if (result === "not_found") return reply.code(404).send({ error: "connect_group_member_not_found" });
        const envelope = await loadGroupEnvelope({ accountId: request.userId, serviceId, groupId });
        if (!envelope) return reply.code(404).send({ error: "connect_group_not_found" });
        return reply.send(envelope);
    });

    app.delete("/v3/connect/:serviceId/groups/:groupId/members/:profileId", {
        preHandler: app.authenticate,
        schema: {
            params: AuthGroupMemberParamsSchema,
            response: { 200: AuthGroupEnvelopeResponseSchema, 404: z.union([NotFoundResponseSchema, AuthGroupErrorResponseSchema]) },
        },
    }, async (request, reply) => {
        const { serviceId, groupId, profileId } = request.params;
        const result = await inTx(async (tx) => {
            const mutationResult = await deleteAuthGroupMemberAndBumpGenerationInTx(tx, {
                accountId: request.userId,
                serviceId,
                groupId,
                profileId,
            });
            if (mutationResult === "deleted") {
                await recordConnectedServiceAccountProfileChange(tx, { accountId: request.userId });
            }
            return mutationResult;
        });
        if (result === "not_found") return reply.code(404).send({ error: "connect_group_member_not_found" });
        const envelope = await loadGroupEnvelope({ accountId: request.userId, serviceId, groupId });
        if (!envelope) return reply.code(404).send({ error: "connect_group_not_found" });
        return reply.send(envelope);
    });

    app.post("/v3/connect/:serviceId/groups/:groupId/active-profile", {
        preHandler: app.authenticate,
        schema: {
            params: AuthGroupParamsSchema,
            body: ActiveProfileBodySchema,
            response: { 200: AuthGroupEnvelopeResponseSchema, 400: AuthGroupErrorResponseSchema, 404: z.union([NotFoundResponseSchema, AuthGroupErrorResponseSchema]), 409: AuthGroupErrorResponseSchema },
        },
    }, async (request, reply) => {
        const { serviceId, groupId } = request.params;
        if (!fallbackEnabled()) {
            return reply.code(400).send({ error: "connect_group_fallback_disabled" });
        }
        const result = await inTx(async (tx) => {
            const group = await tx.connectedServiceAuthGroup.findUnique({
                where: { accountId_vendor_groupId: { accountId: request.userId, vendor: serviceId, groupId } },
                select: { id: true, activeProfileId: true, generation: true },
            });
            if (!group) return { type: "not-found" as const };
            const member = await tx.connectedServiceAuthGroupMember.findUnique({
                where: { accountId_vendor_groupId_profileId: { accountId: request.userId, vendor: serviceId, groupId, profileId: request.body.profileId } },
                select: { enabled: true, stateJson: true },
            });
            if (!member?.enabled) return { type: "invalid-active-member" as const };
            const resetAtMs = readRuntimeCooldownResetAtMs(member.stateJson, Date.now());
            if (resetAtMs !== null) {
                return { type: "runtime-cooldown" as const, resetAtMs };
            }
            if (request.body.expectedGeneration !== undefined && request.body.expectedGeneration !== group.generation) {
                return { type: "generation-conflict" as const, generation: group.generation };
            }

            const changesActiveProfile = group.activeProfileId !== request.body.profileId;
            if (!changesActiveProfile) {
                return { type: "success" as const };
            }

            const update = request.body.expectedGeneration === undefined
                ? await tx.connectedServiceAuthGroup.updateMany({
                    where: { id: group.id },
                    data: { activeProfileId: request.body.profileId, generation: { increment: 1 } },
                })
                : await tx.connectedServiceAuthGroup.updateMany({
                    where: { id: group.id, generation: request.body.expectedGeneration },
                    data: { activeProfileId: request.body.profileId, generation: { increment: 1 } },
                });
            if (update.count !== 1) {
                const current = await tx.connectedServiceAuthGroup.findUnique({
                    where: { id: group.id },
                    select: { generation: true },
                });
                return {
                    type: "generation-conflict" as const,
                    generation: current?.generation ?? group.generation,
                };
            }
            await recordConnectedServiceAccountProfileChange(tx, { accountId: request.userId });
            return { type: "success" as const };
        });

        if (result.type === "not-found") return reply.code(404).send({ error: "connect_group_not_found" });
        if (result.type === "invalid-active-member") {
            return reply.code(400).send({ error: "connect_group_active_profile_not_member" });
        }
        if (result.type === "runtime-cooldown") {
            return reply.code(409).send({ error: "connect_group_profile_runtime_cooldown", resetAtMs: result.resetAtMs });
        }
        if (result.type === "generation-conflict") {
            return reply.code(409).send({ error: "connect_group_generation_conflict", generation: result.generation });
        }

        const envelope = await loadGroupEnvelope({ accountId: request.userId, serviceId, groupId });
        if (!envelope) return reply.code(404).send({ error: "connect_group_not_found" });
        return reply.send(envelope);
    });

}
