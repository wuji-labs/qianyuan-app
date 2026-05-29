import { z } from "zod";

import {
    ConnectedServiceAuthGroupActiveProfileRequestV1Schema,
    ConnectedServiceAuthGroupCreateRequestV1Schema,
    ConnectedServiceAuthGroupIdSchema,
    ConnectedServiceAuthGroupListResponseV1Schema,
    ConnectedServiceAuthGroupMemberCreateRequestV1Schema,
    ConnectedServiceAuthGroupMemberPatchRequestV1Schema,
    ConnectedServiceAuthGroupMemberStateV1Schema,
    ConnectedServiceAuthGroupPatchRequestV1Schema,
    ConnectedServiceAuthGroupResponseV1Schema,
    ConnectedServiceAuthGroupRuntimeStatePatchRequestV1Schema,
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

export const AuthGroupMemberInputSchema = ConnectedServiceAuthGroupMemberCreateRequestV1Schema;

export const CreateAuthGroupBodySchema = ConnectedServiceAuthGroupCreateRequestV1Schema
    .omit({ policy: true })
    .extend({ policy: z.unknown().optional() })
    .strict();

export const UpdateAuthGroupBodySchema = ConnectedServiceAuthGroupPatchRequestV1Schema
    .omit({ policy: true })
    .extend({ policy: z.unknown().optional() })
    .strict();

export const UpdateAuthGroupMemberBodySchema = ConnectedServiceAuthGroupMemberPatchRequestV1Schema;

export const ActiveProfileBodySchema = ConnectedServiceAuthGroupActiveProfileRequestV1Schema;

export const RuntimeStatePatchBodySchema = ConnectedServiceAuthGroupRuntimeStatePatchRequestV1Schema;

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
        "connect_group_fallback_disabled",
        "connect_credential_referenced_by_group",
    ]),
    generation: z.number().int().min(0).optional(),
    resetAtMs: z.number().int().nonnegative().optional(),
});
