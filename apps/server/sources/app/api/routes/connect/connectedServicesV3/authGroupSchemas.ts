import { z } from "zod";

import {
    ConnectedServiceAuthGroupCreateRequestV1Schema,
    ConnectedServiceAuthGroupIdSchema,
    ConnectedServiceAuthGroupListResponseV1Schema,
    ConnectedServiceAuthGroupMemberStateV1Schema,
    ConnectedServiceAuthGroupResponseV1Schema,
    ConnectedServiceAuthGroupStateV1Schema,
    ConnectedServiceAuthGroupV1Schema,
    ConnectedServiceIdSchema,
    ConnectedServiceProfileIdSchema,
} from "@happier-dev/protocol";

export const AuthGroupParamsSchema = z.object({
    serviceId: ConnectedServiceIdSchema,
    groupId: ConnectedServiceAuthGroupIdSchema,
});

export const AuthGroupServiceParamsSchema = z.object({
    serviceId: ConnectedServiceIdSchema,
});

export const AuthGroupMemberParamsSchema = AuthGroupParamsSchema.extend({
    profileId: ConnectedServiceProfileIdSchema,
});

export const ConnectedServiceAuthGroupStateSchema = ConnectedServiceAuthGroupStateV1Schema;
export const ConnectedServiceAuthGroupMemberStateSchema = ConnectedServiceAuthGroupMemberStateV1Schema;

export const AuthGroupMemberInputSchema = z
    .object({
        profileId: ConnectedServiceProfileIdSchema,
        priority: z.number().int().optional(),
        enabled: z.boolean().optional(),
        expectedGeneration: z.number().int().nonnegative().optional(),
    })
    .strict();

export const CreateAuthGroupBodySchema = ConnectedServiceAuthGroupCreateRequestV1Schema
    .omit({ policy: true })
    .extend({ policy: z.unknown().optional() })
    .strict();

export const UpdateAuthGroupBodySchema = z
    .object({
        displayName: z.string().trim().min(1).nullable().optional(),
        policy: z.unknown().optional(),
        activeProfileId: ConnectedServiceProfileIdSchema.nullable().optional(),
        expectedGeneration: z.number().int().nonnegative().optional(),
    })
    .strict();

export const UpdateAuthGroupMemberBodySchema = z
    .object({
        priority: z.number().int().optional(),
        enabled: z.boolean().optional(),
        expectedGeneration: z.number().int().nonnegative().optional(),
    })
    .strict();

export const DeleteAuthGroupMemberQuerySchema = z
    .object({
        expectedGeneration: z.preprocess((value) => {
            if (typeof value !== "string") return value;
            const trimmed = value.trim();
            return trimmed.length > 0 ? Number(trimmed) : value;
        }, z.number().int().nonnegative().optional()),
    })
    .strict();

export const ActiveProfileBodySchema = z
    .object({
        profileId: ConnectedServiceProfileIdSchema,
        expectedGeneration: z.number().int().nonnegative().optional(),
    })
    .strict();

const RuntimeStateMemberPatchBodySchema = z
    .object({
        profileId: ConnectedServiceProfileIdSchema,
        state: ConnectedServiceAuthGroupMemberStateV1Schema,
    })
    .strict();

export const RuntimeStatePatchBodySchema = z
    .object({
        expectedGeneration: z.number().int().nonnegative().optional(),
        state: ConnectedServiceAuthGroupStateV1Schema.optional(),
        memberStates: z.array(RuntimeStateMemberPatchBodySchema).default([]),
    })
    .strict();

export const AuthGroupResponseSchema = ConnectedServiceAuthGroupV1Schema;

export const AuthGroupEnvelopeResponseSchema = ConnectedServiceAuthGroupResponseV1Schema;
export const AuthGroupListResponseSchema = ConnectedServiceAuthGroupListResponseV1Schema;
export const AuthGroupSuccessResponseSchema = z.object({ success: z.literal(true) });

export const AuthGroupErrorResponseSchema = z.object({
    error: z.enum([
        "connect_group_not_found",
        "connect_group_invalid",
        "connect_group_already_exists",
        "connect_group_member_profile_not_found",
        "connect_group_member_already_exists",
        "connect_group_member_not_found",
        "connect_group_duplicate_member",
        "connect_group_active_profile_not_member",
        "connect_group_profile_runtime_cooldown",
        "connect_group_generation_conflict",
        "connect_group_generation_required",
        "connect_group_fallback_disabled",
        "connect_credential_referenced_by_group",
    ]),
    generation: z.number().int().min(0).optional(),
    resetAtMs: z.number().int().nonnegative().optional(),
});
