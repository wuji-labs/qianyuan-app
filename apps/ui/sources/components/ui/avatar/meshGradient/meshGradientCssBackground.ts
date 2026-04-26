import type { ViewStyle } from 'react-native';

import type { MeshGradientAvatarModel } from './meshGradientTypes';

type WebMeshGradientStyle = ViewStyle & Readonly<{
    backgroundBlendMode: string;
    backgroundColor: string;
    backgroundImage: string;
    backgroundSize: string;
}>;

const NOISE_TEXTURE_DATA_URL = 'url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2764%27 height=%2764%27 viewBox=%270 0 64 64%27%3E%3Cfilter id=%27n%27 x=%270%27 y=%270%27 width=%27100%25%27 height=%27100%25%27%3E%3CfeTurbulence type=%27fractalNoise%27 baseFrequency=%270.9%27 numOctaves=%272%27 stitchTiles=%27stitch%27/%3E%3CfeColorMatrix type=%27saturate%27 values=%270%27/%3E%3CfeComponentTransfer%3E%3CfeFuncA type=%27table%27 tableValues=%270 0.16%27/%3E%3C/feComponentTransfer%3E%3C/filter%3E%3Crect width=%2764%27 height=%2764%27 filter=%27url(%23n)%27/%3E%3C/svg%3E")';

function formatPercent(value: number, size: number): string {
    return `${Math.round((value / size) * 1000) / 10}%`;
}

function formatColorStopPercent(value: number): string {
    return `${Math.round(value)}%`;
}

function applyOpacity(color: string, opacity: number): string {
    const clampedOpacity = Math.max(0, Math.min(1, opacity));
    const rgbaMatch = color.match(/^rgba\((\d+), (\d+), (\d+), (0(?:\.\d+)?|1(?:\.0+)?)\)$/);
    if (rgbaMatch) {
        const [, r, g, b, alpha] = rgbaMatch;
        return `rgba(${r}, ${g}, ${b}, ${Number(alpha) * clampedOpacity})`;
    }

    const rgbMatch = color.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
    if (rgbMatch) {
        const [, r, g, b] = rgbMatch;
        return `rgba(${r}, ${g}, ${b}, ${clampedOpacity})`;
    }

    return color;
}

function createRadialLayer(field: MeshGradientAvatarModel['colorFields'][number], size: number): string {
    const centerX = formatPercent(field.cx, size);
    const centerY = formatPercent(field.cy, size);
    const visibleColor = applyOpacity(field.color, field.opacity);
    const midpoint = formatColorStopPercent(Math.max(18, Math.min(34, (field.radius / size) * 30)));
    const edge = formatColorStopPercent(Math.max(78, Math.min(106, (field.radius / size) * 98)));
    return `radial-gradient(circle at ${centerX} ${centerY}, ${visibleColor} 0%, ${visibleColor} ${midpoint}, ${field.transparentColor} ${edge})`;
}

function createDepthLayer(field: MeshGradientAvatarModel['depthField'], size: number): string {
    const centerX = formatPercent(field.cx, size);
    const centerY = formatPercent(field.cy, size);
    const midpoint = formatColorStopPercent(Math.max(24, Math.min(44, (field.radius / size) * 36)));
    const edge = formatColorStopPercent(Math.max(72, Math.min(96, (field.radius / size) * 88)));
    return `radial-gradient(circle at ${centerX} ${centerY}, ${field.color} 0%, ${field.color} ${midpoint}, ${field.transparentColor} ${edge})`;
}

function createWaveLayer(field: MeshGradientAvatarModel['waveFields'][number]): string {
    const angle = Math.round(90 + field.rotation);
    const visibleColor = applyOpacity(field.color, field.opacity);
    return `linear-gradient(${angle}deg, ${field.transparentColor} 0%, ${visibleColor} 48%, ${field.transparentColor} 100%)`;
}

export function createMeshGradientCssBackground(model: MeshGradientAvatarModel, size: number): WebMeshGradientStyle {
    const colorLayers = model.colorFields.map((field) => createRadialLayer(field, size));
    const waveLayers = model.waveFields.map(createWaveLayer);
    const depthLayer = createDepthLayer(model.depthField, size);
    const highlightLayer = createDepthLayer(model.highlightField, size);
    const baseLayer = `linear-gradient(135deg, ${model.baseGradient.startColor} 0%, ${model.baseGradient.endColor} 100%)`;
    const layers = [
        NOISE_TEXTURE_DATA_URL,
        depthLayer,
        highlightLayer,
        ...colorLayers,
        ...waveLayers,
        baseLayer,
    ];

    return {
        backgroundBlendMode: [
            'overlay',
            'multiply',
            'soft-light',
            ...colorLayers.map(() => 'normal'),
            ...waveLayers.map(() => 'soft-light'),
            'normal',
        ].join(', '),
        backgroundColor: model.baseGradient.startColor,
        backgroundImage: layers.join(', '),
        backgroundSize: [
            '72px 72px',
            '100% 100%',
            '100% 100%',
            ...colorLayers.map(() => '100% 100%'),
            ...waveLayers.map(() => '100% 100%'),
            '100% 100%',
        ].join(', '),
    };
}
