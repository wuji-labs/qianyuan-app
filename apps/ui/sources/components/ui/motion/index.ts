export { motionTokens } from './motionTokens';
export { stepTransitionTokens, type StepTransitionTokens } from './stepTransitionTokens';
export {
    resolveStepTransitionDirection,
    type StepTransitionDirection,
    type ResolveStepTransitionDirectionParams,
} from './resolveStepTransitionDirection';
export {
    StepTransitionFrame,
    type StepTransitionFrameProps,
} from './StepTransitionFrame';

// Unified slide transition primitives (Phase 1A — Lane L; Lane R3 motion finish)
export { SlideTransitionFrame } from './SlideTransitionFrame';
export { SlideTransitionSwitch } from './SlideTransitionSwitch';
export {
    StoryDeckSlideTransition,
    type StoryDeckSlideTransitionHandle,
} from './StoryDeckSlideTransition';
export { slideTransitionTokens } from './slideTransitionTokens';
export type {
    SlideTransitionDirection,
    SlideTransitionFrameProps,
    SlideTransitionSwitchProps,
    StoryDeckSlideTransitionProps,
    StoryDeckSlideTransitionRole,
    SlideTransitionPreset,
    SlideLayerRole,
} from './_types';
