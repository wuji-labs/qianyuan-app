import { describe, expect, it, vi } from 'vitest';

import { createClaudeUnifiedPromptInjector } from './createClaudeUnifiedPromptInjector';

describe('createClaudeUnifiedPromptInjector', () => {
  it('injects Claude multiline prompts without bracketed paste markers', async () => {
    const injectUserPrompt = vi.fn().mockResolvedValue({
      status: 'injected',
      at: 123,
      bytesWritten: 17,
    });
    const injector = createClaudeUnifiedPromptInjector({
      inputInjection: {
        hostKind: 'tmux',
        injectUserPrompt,
      },
      createNonce: () => 'nonce-1',
    });

    await expect(
      injector.injectPrompt({
        message: 'alpha\nbeta',
        origin: { kind: 'ui_pending', clientId: 'client-1' },
      }),
    ).resolves.toMatchObject({ status: 'injected' });

    expect(injectUserPrompt).toHaveBeenCalledWith({
      text: 'alpha\nbeta',
      multiline: true,
      origin: {
        kind: 'ui_pending',
        clientId: 'client-1',
        nonce: 'nonce-1',
      },
      scheduling: {
        deferredUntilQuietMs: 800,
        timeoutMs: 15_000,
      },
    });
  });

  it('skips quiet-screen deferral for in-flight steer injections', async () => {
    const injectUserPrompt = vi.fn().mockResolvedValue({
      status: 'injected',
      at: 123,
      bytesWritten: 8,
    });
    const telemetry = { emit: vi.fn() };
    const injector = createClaudeUnifiedPromptInjector({
      inputInjection: {
        hostKind: 'tmux',
        injectUserPrompt,
      },
      createNonce: () => 'nonce-1',
      telemetry,
    });

    await expect(
      injector.injectPrompt(
        {
          message: 'steer me',
          origin: { kind: 'ui_pending', clientId: 'client-1' },
        },
        { inFlightSteer: true },
      ),
    ).resolves.toMatchObject({ status: 'injected' });

    // A generating screen is never "quiet"; the steer-safety screen evaluation
    // already vetoed visible user drafts, so the adapter quiet-screen deferral
    // must be skipped or the steer can never be written.
    expect(injectUserPrompt).toHaveBeenCalledWith({
      text: 'steer me',
      multiline: false,
      origin: {
        kind: 'ui_pending',
        clientId: 'client-1',
        nonce: 'nonce-1',
      },
      scheduling: {
        timeoutMs: 15_000,
      },
    });
    expect(telemetry.emit).toHaveBeenCalledWith({
      name: 'unified.injection.outcome',
      properties: expect.objectContaining({
        status: 'injected',
        originKind: 'ui_pending',
        inFlightSteer: true,
      }),
    });
  });

  it('emits safe injection outcome telemetry without prompt text', async () => {
    const telemetry = { emit: vi.fn() };
    const injector = createClaudeUnifiedPromptInjector({
      inputInjection: {
        hostKind: 'zellij',
        injectUserPrompt: vi.fn().mockResolvedValue({
          status: 'failed',
          reason: 'pane_dead',
          phase: 'liveness',
          duplicateRisk: 'none',
          recoverable: false,
        }),
      },
      createNonce: () => 'nonce-1',
      telemetry,
    });

    await expect(
      injector.injectPrompt({
        message: 'secret prompt\nsecond line',
        origin: { kind: 'ui_pending', clientId: 'client-1' },
      }),
    ).resolves.toMatchObject({ status: 'failed', reason: 'pane_dead' });

    expect(telemetry.emit).toHaveBeenCalledWith({
      name: 'unified.injection.outcome',
      properties: {
        status: 'failed',
        reason: 'pane_dead',
        phase: 'liveness',
        duplicateRisk: 'none',
        recoverable: false,
        hostKind: 'zellij',
        multiline: true,
        originKind: 'ui_pending',
      },
    });
    expect(JSON.stringify(telemetry.emit.mock.calls)).not.toContain('secret prompt');
  });

  // C11 (live-proven, runner pid 83791): idle injection typed the new prompt AFTER a leftover
  // composer draft and submitted the concatenation. The injector must run the composer guard
  // before writing: own leftovers are cleared, genuine drafts defer the injection untouched.
  describe('composer draft guard (C11)', () => {
    it('runs the guard before writing and proceeds when the own leftover was cleared', async () => {
      const order: string[] = [];
      const injectUserPrompt = vi.fn().mockImplementation(async () => {
        order.push('inject');
        return { status: 'injected', at: 1, bytesWritten: 5 };
      });
      const telemetry = { emit: vi.fn() };
      const injector = createClaudeUnifiedPromptInjector({
        inputInjection: { hostKind: 'zellij', injectUserPrompt },
        composerDraftGuard: async () => {
          order.push('guard');
          return { status: 'cleared', attempts: 1, draftLength: 35 };
        },
        createNonce: () => 'nonce-1',
        telemetry,
      });

      await expect(
        injector.injectPrompt({ message: 'next prompt', origin: { kind: 'ui_pending', clientId: 'c1' } }),
      ).resolves.toMatchObject({ status: 'injected' });
      expect(order).toEqual(['guard', 'inject']);
      expect(telemetry.emit).toHaveBeenCalledWith({
        name: 'unified.injection.draft_guard',
        properties: { status: 'cleared', attempts: 1, draftLength: 35, originKind: 'ui_pending' },
      });
    });

    it('defers the injection without writing when the composer holds a genuine user draft', async () => {
      const injectUserPrompt = vi.fn();
      const telemetry = { emit: vi.fn() };
      const injector = createClaudeUnifiedPromptInjector({
        inputInjection: { hostKind: 'zellij', injectUserPrompt },
        composerDraftGuard: async () => ({ status: 'foreign_draft', draftLength: 12 }),
        createNonce: () => 'nonce-1',
        telemetry,
      });

      await expect(
        injector.injectPrompt({ message: 'next prompt', origin: { kind: 'ui_pending', clientId: 'c1' } }),
      ).resolves.toMatchObject({ status: 'deferred', reason: 'user_typing' });
      expect(injectUserPrompt).not.toHaveBeenCalled();
      expect(telemetry.emit).toHaveBeenCalledWith({
        name: 'unified.injection.draft_guard',
        properties: { status: 'foreign_draft', draftLength: 12, originKind: 'ui_pending' },
      });
    });

    // Live-proven starvation (runner pid 20327, 11:28): an idle session has no turn-end or
    // readiness wake, so a guard deferral WITHOUT retryAfterMs left the head prompt queued
    // forever (arbiter scheduleRetryDrain(undefined) arms no timer).
    it('guard deferrals carry retryAfterMs so an idle session re-attempts the injection', async () => {
      for (const guard of [
        { status: 'foreign_draft' as const, draftLength: 12 },
        { status: 'clear_failed' as const, draftLength: 35 },
      ]) {
        const injector = createClaudeUnifiedPromptInjector({
          inputInjection: { hostKind: 'zellij', injectUserPrompt: vi.fn() },
          composerDraftGuard: async () => guard,
          createNonce: () => 'nonce-1',
        });
        const result = await injector.injectPrompt({
          message: 'next prompt',
          origin: { kind: 'ui_pending', clientId: 'c1' },
        });
        expect(result.status).toBe('deferred');
        if (result.status === 'deferred') {
          expect(result.retryAfterMs).toBeGreaterThan(0);
        }
      }
    });

    it('defers without writing when the own leftover could not be cleared (never concatenates)', async () => {
      const injectUserPrompt = vi.fn();
      const injector = createClaudeUnifiedPromptInjector({
        inputInjection: { hostKind: 'zellij', injectUserPrompt },
        composerDraftGuard: async () => ({ status: 'clear_failed', draftLength: 35 }),
        createNonce: () => 'nonce-1',
      });

      await expect(
        injector.injectPrompt({ message: 'next prompt', origin: { kind: 'ui_pending', clientId: 'c1' } }),
      ).resolves.toMatchObject({ status: 'deferred', reason: 'user_typing' });
      expect(injectUserPrompt).not.toHaveBeenCalled();
    });

    it('proceeds unchanged on no_draft, generating, and capture_failed guard outcomes', async () => {
      for (const guard of [
        { status: 'no_draft' as const },
        { status: 'generating' as const },
        { status: 'capture_failed' as const },
      ]) {
        const injectUserPrompt = vi.fn().mockResolvedValue({ status: 'injected', at: 1, bytesWritten: 5 });
        const injector = createClaudeUnifiedPromptInjector({
          inputInjection: { hostKind: 'zellij', injectUserPrompt },
          composerDraftGuard: async () => guard,
          createNonce: () => 'nonce-1',
        });
        await expect(
          injector.injectPrompt({ message: 'next prompt', origin: { kind: 'ui_pending', clientId: 'c1' } }),
        ).resolves.toMatchObject({ status: 'injected' });
        expect(injectUserPrompt).toHaveBeenCalledTimes(1);
      }
    });

    it('skips the guard entirely for in-flight steer injections (steer evaluator owns that screen)', async () => {
      const injectUserPrompt = vi.fn().mockResolvedValue({ status: 'injected', at: 1, bytesWritten: 5 });
      const composerDraftGuard = vi.fn();
      const injector = createClaudeUnifiedPromptInjector({
        inputInjection: { hostKind: 'zellij', injectUserPrompt },
        composerDraftGuard,
        createNonce: () => 'nonce-1',
      });

      await expect(
        injector.injectPrompt(
          { message: 'steer text', origin: { kind: 'ui_pending', clientId: 'c1' } },
          { inFlightSteer: true },
        ),
      ).resolves.toMatchObject({ status: 'injected' });
      expect(composerDraftGuard).not.toHaveBeenCalled();
    });
  });
});
