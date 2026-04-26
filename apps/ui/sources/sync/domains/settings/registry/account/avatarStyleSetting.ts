import { z } from 'zod';

export const AVATAR_STYLE_IDS = ['pixelated', 'gradient', 'brutalist', 'meshGradient'] as const;

export type AvatarStyleId = (typeof AVATAR_STYLE_IDS)[number];

export const AvatarStyleIdSchema = z.enum(AVATAR_STYLE_IDS);

export const DEFAULT_AVATAR_STYLE_ID = 'brutalist' satisfies AvatarStyleId;
