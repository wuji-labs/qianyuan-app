import { z } from 'zod';

import { SessionWorkStateStatusV1Schema, SessionWorkStateV1Schema } from './sessionWorkStateV1.js';

export const SessionWorkStateGetRequestV1Schema = z.object({}).passthrough();
export type SessionWorkStateGetRequestV1 = z.infer<typeof SessionWorkStateGetRequestV1Schema>;

export const SessionWorkStateGetResponseV1Schema = z
  .object({
    workState: SessionWorkStateV1Schema.nullable(),
  })
  .passthrough();
export type SessionWorkStateGetResponseV1 = z.infer<typeof SessionWorkStateGetResponseV1Schema>;

export const SessionGoalGetRequestV1Schema = z.object({}).passthrough();
export type SessionGoalGetRequestV1 = z.infer<typeof SessionGoalGetRequestV1Schema>;

export const SessionGoalSetRequestV1Schema = z
  .object({
    objective: z.string().trim().min(1).max(4000).optional(),
    status: SessionWorkStateStatusV1Schema.optional(),
    tokenBudget: z.number().finite().positive().nullable().optional(),
  })
  .passthrough()
  .refine((value) => (
    typeof value.objective === 'string'
    || typeof value.status === 'string'
    || Object.prototype.hasOwnProperty.call(value, 'tokenBudget')
  ), { message: 'At least one goal mutation field is required' });
export type SessionGoalSetRequestV1 = z.infer<typeof SessionGoalSetRequestV1Schema>;

export const SessionGoalClearRequestV1Schema = z.object({}).passthrough();
export type SessionGoalClearRequestV1 = z.infer<typeof SessionGoalClearRequestV1Schema>;

export const SessionVendorPluginSummaryV1Schema = z
  .object({
    vendorPluginRef: z.string().min(1),
    name: z.string().min(1),
    displayName: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    installed: z.boolean().optional(),
    enabled: z.boolean().optional(),
    mentionable: z.boolean().optional(),
  })
  .passthrough();
export type SessionVendorPluginSummaryV1 = z.infer<typeof SessionVendorPluginSummaryV1Schema>;

export const SessionVendorPluginCatalogListRequestV1Schema = z
  .object({
    cwd: z.string().min(1).optional(),
  })
  .passthrough();
export type SessionVendorPluginCatalogListRequestV1 = z.infer<typeof SessionVendorPluginCatalogListRequestV1Schema>;

export const SessionVendorPluginCatalogListResponseV1Schema = z
  .object({
    vendorPlugins: z.array(SessionVendorPluginSummaryV1Schema).default([]),
    unsupported: z.boolean().optional(),
  })
  .passthrough();
export type SessionVendorPluginCatalogListResponseV1 = z.infer<typeof SessionVendorPluginCatalogListResponseV1Schema>;

export const SessionSkillCatalogItemV1Schema = z
  .object({
    name: z.string().min(1),
    displayName: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    origin: z.enum([
      'codex_native',
      'opencode_native',
      'claude_native',
      'pi_native',
      'happier_projected',
      'text_fallback_only',
    ]),
    enabled: z.boolean().optional(),
  })
  .passthrough();
export type SessionSkillCatalogItemV1 = z.infer<typeof SessionSkillCatalogItemV1Schema>;

export const SessionSkillCatalogListRequestV1Schema = SessionVendorPluginCatalogListRequestV1Schema;
export type SessionSkillCatalogListRequestV1 = z.infer<typeof SessionSkillCatalogListRequestV1Schema>;

export const SessionSkillCatalogListResponseV1Schema = z
  .object({
    skills: z.array(SessionSkillCatalogItemV1Schema).default([]),
    unsupported: z.boolean().optional(),
  })
  .passthrough();
export type SessionSkillCatalogListResponseV1 = z.infer<typeof SessionSkillCatalogListResponseV1Schema>;
