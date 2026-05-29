import { describe, expect, it } from "vitest";

import type { SessionRuntimeIssueV1, SessionTurnV1 } from "@happier-dev/protocol";

import { applySessionTurnMutationToTurns } from "./applySessionTurnMutation";

const usageLimitIssue: SessionRuntimeIssueV1 = {
    v: 1,
    scope: "primary_session",
    status: "failed",
    code: "usage_limit",
    source: "usage_limit",
    occurredAt: 200,
    provider: "codex",
    providerTurnId: "provider-turn-1",
    sanitizedPreview: "Limit reached",
    usageLimit: {
        v: 1,
        resetAtMs: null,
        retryAfterMs: null,
        quotaScope: "account",
        recoverability: "switch_account",
        connectedService: {
            serviceId: "openai-codex",
            profileId: "old-profile",
            groupId: "codex-group",
        },
    },
};

function failedUsageLimitTurn(overrides: Partial<SessionTurnV1> = {}): SessionTurnV1 {
    return {
        turnId: "turn-1",
        provider: "codex",
        providerTurnId: "provider-turn-1",
        status: "failed",
        startedAt: 100,
        updatedAt: 200,
        terminalAt: 200,
        lastRuntimeIssue: usageLimitIssue,
        lastMutationId: "mutation-failed",
        ...overrides,
    };
}

describe("applySessionTurnMutationToTurns", () => {
    it("lets newer matching task-started evidence supersede a stale failed runtime issue", () => {
        const decision = applySessionTurnMutationToTurns({
            currentLatestTurnId: "turn-1",
            turns: [failedUsageLimitTurn()],
            appliedAt: 301,
            mutation: {
                v: 1,
                sessionId: "s1",
                mutationId: "mutation-recovered-start",
                action: "begin",
                turnId: "turn-1",
                provider: "codex",
                providerTurnId: "provider-turn-1",
                observedAt: 300,
            },
        });

        expect(decision.apply).toBe(true);
        expect(decision.materialized).toEqual({
            latestTurnId: "turn-1",
            latestTurnStatus: "in_progress",
            latestTurnStatusObservedAt: 300,
            lastRuntimeIssue: null,
        });
        if (decision.apply) {
            expect(decision.changedTurn).toEqual(expect.objectContaining({
                status: "in_progress",
                startedAt: 300,
                updatedAt: 300,
                lastRuntimeIssue: null,
            }));
            expect(decision.changedTurn).not.toHaveProperty("terminalAt");
        }
    });

    it("lets newer matching task-complete evidence supersede a stale failed runtime issue", () => {
        const decision = applySessionTurnMutationToTurns({
            currentLatestTurnId: "turn-1",
            turns: [failedUsageLimitTurn()],
            appliedAt: 301,
            mutation: {
                v: 1,
                sessionId: "s1",
                mutationId: "mutation-recovered-complete",
                action: "complete",
                turnId: "turn-1",
                provider: "codex",
                providerTurnId: "provider-turn-1",
                observedAt: 300,
            },
        });

        expect(decision.apply).toBe(true);
        expect(decision.materialized).toEqual({
            latestTurnId: "turn-1",
            latestTurnStatus: "completed",
            latestTurnStatusObservedAt: 300,
            lastRuntimeIssue: null,
        });
    });

    it("keeps a stale failed runtime issue when matching lifecycle evidence is older", () => {
        const decision = applySessionTurnMutationToTurns({
            currentLatestTurnId: "turn-1",
            turns: [failedUsageLimitTurn()],
            appliedAt: 201,
            mutation: {
                v: 1,
                sessionId: "s1",
                mutationId: "mutation-old-start",
                action: "begin",
                turnId: "turn-1",
                provider: "codex",
                providerTurnId: "provider-turn-1",
                observedAt: 150,
            },
        });

        expect(decision.apply).toBe(false);
        expect(decision.materialized.latestTurnStatus).toBe("failed");
        expect(decision.materialized.lastRuntimeIssue).toEqual(usageLimitIssue);
    });

    it("keeps a stale failed runtime issue when lifecycle evidence is unrelated", () => {
        const decision = applySessionTurnMutationToTurns({
            currentLatestTurnId: "turn-1",
            turns: [failedUsageLimitTurn()],
            appliedAt: 301,
            mutation: {
                v: 1,
                sessionId: "s1",
                mutationId: "mutation-unrelated-start",
                action: "begin",
                turnId: "turn-1",
                provider: "codex",
                providerTurnId: "provider-turn-2",
                observedAt: 300,
            },
        });

        expect(decision.apply).toBe(false);
        expect(decision.materialized.latestTurnStatus).toBe("failed");
        expect(decision.materialized.lastRuntimeIssue).toEqual(usageLimitIssue);
    });
});
