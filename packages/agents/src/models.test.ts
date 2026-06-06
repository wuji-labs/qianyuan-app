import { describe, expect, it } from 'vitest';

import { AGENT_IDS } from './types.js';
import type { AgentId } from './types.js';
import { AGENT_MODEL_CONFIG, getAgentModelConfig, getAgentStaticModels } from './models.js';

const cursorAgentId = 'cursor' as AgentId;

describe('agent model config', () => {
  it('covers every canonical agent', () => {
    expect(Object.keys(AGENT_MODEL_CONFIG).sort()).toEqual([...AGENT_IDS].sort());
    for (const agentId of AGENT_IDS) {
      expect(getAgentModelConfig(agentId)).toBeDefined();
    }
  });

  it('uses the same name and description contract for static models as dynamic models', () => {
    const claude = getAgentModelConfig('claude');
    const gemini = getAgentModelConfig('gemini');
    const claudeModels = getAgentStaticModels('claude');
    const geminiModels = getAgentStaticModels('gemini');

    expect(claude.staticModels?.find((model) => model.id === 'claude-opus-4-8')).toMatchObject({
      id: 'claude-opus-4-8',
      name: 'Opus 4.8',
      description: expect.any(String),
      contextWindowTokens: 1_000_000,
      modelOptions: expect.arrayContaining([
        expect.objectContaining({
          id: 'reasoning_effort',
          currentValue: 'high',
          options: expect.arrayContaining([
            expect.objectContaining({ value: 'xhigh' }),
          ]),
        }),
      ]),
    });
    expect(claude.staticModels?.find((model) => model.id === 'claude-opus-4-7')).toMatchObject({
      id: 'claude-opus-4-7',
      name: 'Opus 4.7',
      description: expect.any(String),
      contextWindowTokens: 1_000_000,
      modelOptions: expect.arrayContaining([
        expect.objectContaining({
          id: 'reasoning_effort',
          currentValue: 'xhigh',
        }),
      ]),
    });
    expect(gemini.staticModels?.find((model) => model.id === 'gemini-3.1-pro-preview')).toMatchObject({
      id: 'gemini-3.1-pro-preview',
      name: 'Gemini 3.1 Pro Preview',
      description: expect.any(String),
    });
    expect(gemini.staticModels?.find((model) => model.id === 'auto')).toMatchObject({
      id: 'auto',
      name: 'Auto',
      description: expect.any(String),
    });
    expect(claude.staticModels?.map((model) => model.id)).toEqual(claude.allowedModes);
    expect(gemini.staticModels?.map((model) => model.id)).toEqual(gemini.allowedModes);
    expect(claudeModels[0]).toMatchObject({
      id: 'claude-opus-4-8',
      name: 'Opus 4.8',
      description: expect.any(String),
      contextWindowTokens: 1_000_000,
    });
    expect(geminiModels[0]?.name).toBe('Auto');
  });

  it('ships a non-empty static model list for Codex as a robust fallback when dynamic probing fails', () => {
    const codex = getAgentModelConfig('codex');
    const codexModels = getAgentStaticModels('codex');

    // Codex dynamic probing can fail transiently (missing CLI, auth not ready). The UI should still
    // have a usable model picker without requiring a refresh.
    expect(codex.supportsSelection).toBe(true);
    expect(codexModels.length).toBeGreaterThan(1);
    expect(codexModels.map((model) => model.id)).toContain('gpt-5.4');
  });

  it('treats Cursor models as dynamic ACP/CLI controls without freeform fallback', () => {
    expect(getAgentModelConfig(cursorAgentId)).toMatchObject({
      supportsSelection: true,
      supportsFreeform: false,
      nonAcpApplyScope: 'next_prompt',
      acpModelConfigOptionId: 'model',
      acpModelSetMethod: 'config_option',
      dynamicProbe: 'auto',
      defaultMode: 'default',
      allowedModes: ['default'],
    });
  });

  it('treats Kimi models as dynamically probed ACP controls', () => {
    const kimi = getAgentModelConfig('kimi');
    expect(kimi).toMatchObject({
      supportsSelection: true,
      nonAcpApplyScope: 'next_prompt',
      acpModelConfigOptionId: 'model',
      dynamicProbe: 'auto',
      defaultMode: 'default',
      allowedModes: ['default'],
    });
    expect(kimi.supportsFreeform).not.toBe(true);
  });
});
