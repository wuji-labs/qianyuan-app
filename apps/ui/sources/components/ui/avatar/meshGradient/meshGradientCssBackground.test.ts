import { describe, expect, it } from 'vitest';

import { createMeshGradientCssBackground } from './meshGradientCssBackground';
import type { MeshGradientAvatarModel } from './meshGradientTypes';

const model = {
    baseGradient: {
        startX: 0,
        startY: 0,
        endX: 48,
        endY: 48,
        startColor: 'rgb(240, 238, 226)',
        endColor: 'rgb(150, 188, 172)',
    },
    depthField: {
        cx: 12,
        cy: 38,
        radius: 52,
        color: 'rgba(70, 64, 52, 0.36)',
        transparentColor: 'rgba(70, 64, 52, 0)',
    },
    highlightField: {
        cx: 36,
        cy: 12,
        radius: 34,
        color: 'rgba(255, 255, 255, 0.18)',
        transparentColor: 'rgba(255, 255, 255, 0)',
    },
    colorFields: [
        {
            cx: 10,
            cy: 9,
            radius: 34,
            color: 'rgb(10, 20, 30)',
            transparentColor: 'rgba(10, 20, 30, 0)',
            opacity: 0.42,
        },
    ],
    waveFields: [
        {
            x: 0,
            y: 8,
            width: 48,
            height: 12,
            rotation: 12,
            color: 'rgb(90, 110, 130)',
            transparentColor: 'rgba(90, 110, 130, 0)',
            opacity: 0.24,
        },
    ],
} satisfies MeshGradientAvatarModel;

describe('createMeshGradientCssBackground', () => {
    it('applies color field opacity to web radial layers', () => {
        const style = createMeshGradientCssBackground(model, 48);

        expect(style.backgroundImage).toContain('rgba(10, 20, 30, 0.42)');
    });

    it('applies wave field opacity to web linear layers', () => {
        const style = createMeshGradientCssBackground(model, 48);

        expect(style.backgroundImage).toContain('rgba(90, 110, 130, 0.24)');
    });

    it('uses normal blending for color layers so their alpha controls visible color', () => {
        const style = createMeshGradientCssBackground(model, 48);
        const blendModes = style.backgroundBlendMode.split(', ');

        expect(blendModes[3]).toBe('normal');
    });

    it('keeps grain subtle so color contrast stays visible', () => {
        const style = createMeshGradientCssBackground(model, 48);

        expect(style.backgroundImage).toContain('tableValues=%270 0.16%27');
    });
});
