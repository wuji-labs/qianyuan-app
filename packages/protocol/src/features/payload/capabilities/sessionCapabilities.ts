import { z } from 'zod';

export const DEFAULT_SESSION_MESSAGES_CAPABILITIES = Object.freeze({
  role: false,
});

export const SessionMessagesCapabilitiesSchema = z
  .object({
    role: z.boolean().optional().default(DEFAULT_SESSION_MESSAGES_CAPABILITIES.role),
  })
  .optional()
  .default(DEFAULT_SESSION_MESSAGES_CAPABILITIES);

export const DEFAULT_SESSION_CAPABILITIES = Object.freeze({
  messages: DEFAULT_SESSION_MESSAGES_CAPABILITIES,
});

export const SessionCapabilitiesSchema = z
  .object({
    messages: SessionMessagesCapabilitiesSchema,
  })
  .optional()
  .default(DEFAULT_SESSION_CAPABILITIES);
