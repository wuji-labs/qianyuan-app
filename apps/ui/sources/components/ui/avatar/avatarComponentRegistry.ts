import type * as React from 'react';

import type { AvatarStyleId } from '@/sync/domains/settings/registry/account/avatarStyleSetting';

import { AvatarBrutalist } from './AvatarBrutalist';
import { AvatarGradient } from './AvatarGradient';
import { AvatarSkia } from './AvatarSkia';
import { AvatarMeshGradient } from './meshGradient/AvatarMeshGradient';

export type GeneratedAvatarProps = Readonly<{
    id: string;
    title?: boolean;
    square?: boolean;
    size?: number;
    monochrome?: boolean;
}>;

const GENERATED_AVATAR_COMPONENTS = {
    pixelated: AvatarSkia,
    gradient: AvatarGradient,
    brutalist: AvatarBrutalist,
    meshGradient: AvatarMeshGradient,
} satisfies Record<AvatarStyleId, React.ComponentType<GeneratedAvatarProps>>;

export function getGeneratedAvatarComponentForStyle(
    styleId: AvatarStyleId,
): React.ComponentType<GeneratedAvatarProps> {
    return GENERATED_AVATAR_COMPONENTS[styleId];
}
