import type { ParticipantRecipientV1 } from '@happier-dev/protocol';
import { ParticipantRecipientV1Schema } from '@happier-dev/protocol';
import { z } from 'zod';

export const SessionComposerExecutionRunDeliveryModeSchema = z.enum([
    'prompt',
    'steer_if_supported',
    'interrupt',
]);

export type SessionComposerExecutionRunDeliveryMode = z.infer<typeof SessionComposerExecutionRunDeliveryModeSchema>;

export const ComposerVendorPluginMentionSchema = z.object({
    kind: z.literal('vendorPlugin'),
    tokenText: z.string().min(1),
    start: z.number().int().min(0),
    end: z.number().int().min(0),
    vendorPluginRef: z.string().min(1),
    label: z.string().min(1).optional(),
    backendId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
}).refine((mention) => mention.end >= mention.start, {
    path: ['end'],
});

export type ComposerVendorPluginMention = z.infer<typeof ComposerVendorPluginMentionSchema>;

export const ComposerSkillMentionSchema = z.object({
    kind: z.literal('skill'),
    tokenText: z.string().min(1),
    start: z.number().int().min(0),
    end: z.number().int().min(0),
    name: z.string().min(1),
    path: z.string().min(1).optional(),
    displayName: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    origin: z.string().min(1).optional(),
    projectionKind: z.string().min(1).optional(),
}).refine((mention) => mention.end >= mention.start, {
    path: ['end'],
});

export type ComposerSkillMention = z.infer<typeof ComposerSkillMentionSchema>;

export const ComposerStructuredInputMentionSchema = z.discriminatedUnion('kind', [
    ComposerVendorPluginMentionSchema,
    ComposerSkillMentionSchema,
]);

export type ComposerStructuredInputMention = z.infer<typeof ComposerStructuredInputMentionSchema>;

export const ComposerStructuredInputMentionsSchema = z.array(ComposerStructuredInputMentionSchema).readonly();

export type SessionDraftValueByFieldId = Readonly<{
    'routing.recipient': ParticipantRecipientV1 | null;
    'routing.executionRunDelivery': SessionComposerExecutionRunDeliveryMode;
    'structuredInput.mentions': readonly ComposerStructuredInputMention[];
}>;

export type SessionDraftValueFieldId = keyof SessionDraftValueByFieldId;

export const SessionDraftValueFieldSchemas = {
    'routing.recipient': ParticipantRecipientV1Schema.nullable(),
    'routing.executionRunDelivery': SessionComposerExecutionRunDeliveryModeSchema,
    'structuredInput.mentions': ComposerStructuredInputMentionsSchema,
} satisfies {
    readonly [TFieldId in SessionDraftValueFieldId]: z.ZodType<SessionDraftValueByFieldId[TFieldId]>;
};

export type SessionDraftValueClearLifecycle = Readonly<{
    send?: 'outboundHandoff';
    composerClear?: boolean;
    sessionDelete?: boolean;
    abort?: boolean;
    ttlDays?: number;
}>;

export type SessionDraftValueLifecycle = 'outboundHandoff' | 'composerCleared' | 'sessionDeleted' | 'abort';
