import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

const { emitUpdate } = vi.hoisted(() => ({
    emitUpdate: vi.fn(),
}));

vi.mock("@/app/events/eventRouter", async () => {
    const actual = await vi.importActual<typeof import("@/app/events/eventRouter")>("@/app/events/eventRouter");
    return {
        ...actual,
        eventRouter: { emitUpdate },
    };
});

import { db } from "@/storage/db";
import { ConnectedServiceAuthGroupResponseV1Schema } from "@happier-dev/protocol";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { connectRoutes } from "./connectRoutes";
import { createAppCloseTracker } from "../../testkit/appLifecycle";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

function createTestApp() {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
        const userId = request.headers["x-test-user-id"];
        if (typeof userId !== "string" || !userId) {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        (request as FastifyRequest & { userId: string }).userId = userId;
        return undefined;
    });

    return trackApp(typed);
}

async function createAccount(publicKey: string) {
    return db.account.create({ data: { publicKey }, select: { id: true } });
}

async function createConnectedProfile(accountId: string, serviceId: string, profileId: string) {
    await db.serviceAccountToken.create({
        data: {
            accountId,
            vendor: serviceId,
            profileId,
            token: Buffer.from(`sealed:${serviceId}:${profileId}`, "utf8"),
            metadata: { kind: "oauth" },
        },
    });
}

async function createReadyApp() {
    const app = createTestApp();
    connectRoutes(app);
    await app.ready();
    return app;
}

function authHeaders(userId: string) {
    return { "content-type": "application/json", "x-test-user-id": userId };
}

async function readAccountChangeCursor(accountId: string): Promise<number | null> {
    return (await db.accountChange.findUnique({
        where: { accountId_kind_entityId: { accountId, kind: "account", entityId: "self" } },
        select: { cursor: true },
    }))?.cursor ?? null;
}

function expectLastProjectedGroup(params: {
    accountId: string;
    group: {
        groupId: string;
        displayName: string | null;
        activeProfileId: string | null;
        generation: number;
        memberProfileIds: readonly string[];
    } | null;
}) {
    const lastCall = emitUpdate.mock.lastCall?.[0];
    expect(lastCall).toEqual(expect.objectContaining({
        userId: params.accountId,
        recipientFilter: { type: "user-scoped-only" },
        payload: expect.objectContaining({
            body: expect.objectContaining({
                t: "update-account",
                connectedServicesV2: expect.any(Array),
            }),
        }),
    }));

    const projectedService = (lastCall?.payload?.body?.connectedServicesV2 as Array<{
        serviceId: string;
        groups?: unknown[];
    }> | undefined)?.find((entry) => entry.serviceId === "openai-codex");

    if (params.group === null) {
        expect(projectedService).toEqual(expect.objectContaining({
            serviceId: "openai-codex",
            groups: [],
        }));
        return;
    }

    expect(projectedService).toEqual(expect.objectContaining({
        serviceId: "openai-codex",
        groups: [
            expect.objectContaining({
                groupId: params.group.groupId,
                displayName: params.group.displayName,
                activeProfileId: params.group.activeProfileId,
                generation: params.group.generation,
                memberProfileIds: params.group.memberProfileIds,
            }),
        ],
    }));
}

describe("connectRoutes connected service auth groups (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-connected-service-auth-groups-",
            initAuth: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        vi.unstubAllGlobals();
        vi.clearAllMocks();
        await db.accountChange.deleteMany().catch(() => {});
        await db.serviceAccountToken.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    it("creates and lists an account-owned group with existing connected profiles", async () => {
        const user = await createAccount("pk-groups-create");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        const app = await createReadyApp();

        const create = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                displayName: "Codex Main",
                members: [
                    { profileId: "work", priority: 10 },
                    { profileId: "backup", priority: 20 },
                ],
                activeProfileId: "work",
            },
        });

        expect(create.statusCode).toBe(200);
        expect(ConnectedServiceAuthGroupResponseV1Schema.safeParse(create.json()).success).toBe(true);
        expect(create.json()).toEqual({
            group: expect.objectContaining({
                v: 1,
                serviceId: "openai-codex",
                groupId: "codex-main",
                displayName: "Codex Main",
                activeProfileId: "work",
                generation: 0,
                policy: expect.objectContaining({ v: 1, strategy: "priority", autoSwitch: false }),
                members: [
                    expect.objectContaining({ v: 1, serviceId: "openai-codex", profileId: "work", priority: 10, enabled: true }),
                    expect.objectContaining({ v: 1, serviceId: "openai-codex", profileId: "backup", priority: 20, enabled: true }),
                ],
            }),
        });

        const list = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups",
            headers: { "x-test-user-id": user.id },
        });

        expect(list.statusCode).toBe(200);
        expect(list.json()).toEqual({
            groups: [
                expect.objectContaining({
                    serviceId: "openai-codex",
                    groupId: "codex-main",
                    members: expect.arrayContaining([
                        expect.objectContaining({ profileId: "work" }),
                        expect.objectContaining({ profileId: "backup" }),
                    ]),
                }),
            ],
        });
    });

    it("fails closed when the account-groups feature gate is disabled", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_GROUPS__ENABLED: "0" });
        const user = await createAccount("pk-groups-disabled");
        const app = await createReadyApp();

        const res = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups",
            headers: { "x-test-user-id": user.id },
        });

        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: "not_found" });
    });

    it("enforces account ownership and member profile existence", async () => {
        const owner = await createAccount("pk-groups-owner");
        const other = await createAccount("pk-groups-other");
        await createConnectedProfile(owner.id, "openai-codex", "work");
        const app = await createReadyApp();

        const create = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(owner.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }],
                activeProfileId: "work",
            },
        });
        expect(create.statusCode).toBe(200);

        const otherRead = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: { "x-test-user-id": other.id },
        });
        expect(otherRead.statusCode).toBe(404);
        expect(otherRead.json()).toEqual({ error: "connect_group_not_found" });

        const missingMember = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/members",
            headers: authHeaders(owner.id),
            payload: { profileId: "missing" },
        });
        expect(missingMember.statusCode).toBe(400);
        expect(missingMember.json()).toEqual({ error: "connect_group_member_profile_not_found" });
    });

    it("rejects duplicate group ids and duplicate member profile ids", async () => {
        const user = await createAccount("pk-groups-duplicates");
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();

        const payload = {
            groupId: "codex-main",
            members: [{ profileId: "work" }],
            activeProfileId: "work",
        };
        expect((await app.inject({ method: "POST", url: "/v3/connect/openai-codex/groups", headers: authHeaders(user.id), payload })).statusCode).toBe(200);

        const duplicateGroup = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload,
        });
        expect(duplicateGroup.statusCode).toBe(409);
        expect(duplicateGroup.json()).toEqual({ error: "connect_group_already_exists" });

        const duplicateMember = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/members",
            headers: authHeaders(user.id),
            payload: { profileId: "work" },
        });
        expect(duplicateMember.statusCode).toBe(409);
        expect(duplicateMember.json()).toEqual({ error: "connect_group_member_already_exists" });
    });

    it("bumps generation on active profile switch and rejects stale generation updates", async () => {
        const user = await createAccount("pk-groups-generation");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }, { profileId: "backup" }],
                activeProfileId: "work",
            },
        })).statusCode).toBe(200);

        const switched = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/active-profile",
            headers: authHeaders(user.id),
            payload: { profileId: "backup", expectedGeneration: 0 },
        });
        expect(switched.statusCode).toBe(200);
        expect(switched.json()).toEqual({
            group: expect.objectContaining({ activeProfileId: "backup", generation: 1 }),
        });

        const stale = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/active-profile",
            headers: authHeaders(user.id),
            payload: { profileId: "work", expectedGeneration: 0 },
        });
        expect(stale.statusCode).toBe(409);
        expect(stale.json()).toEqual({ error: "connect_group_generation_conflict", generation: 1 });
    });

    it("publishes account projection updates for create, patch, member, active-profile, and delete mutations", async () => {
        const user = await createAccount("pk-groups-projection-updates");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        const app = await createReadyApp();

        const created = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                displayName: "Codex Main",
                members: [{ profileId: "work" }],
                activeProfileId: "work",
            },
        });
        expect(created.statusCode).toBe(200);
        const createCursor = await readAccountChangeCursor(user.id);
        expect(createCursor).toEqual(expect.any(Number));
        expectLastProjectedGroup({
            accountId: user.id,
            group: {
                groupId: "codex-main",
                displayName: "Codex Main",
                activeProfileId: "work",
                generation: 0,
                memberProfileIds: ["work"],
            },
        });

        const patched = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: authHeaders(user.id),
            payload: { displayName: "Codex Primary" },
        });
        expect(patched.statusCode).toBe(200);
        const patchCursor = await readAccountChangeCursor(user.id);
        expect(patchCursor).toBeGreaterThan(createCursor ?? -1);
        expectLastProjectedGroup({
            accountId: user.id,
            group: {
                groupId: "codex-main",
                displayName: "Codex Primary",
                activeProfileId: "work",
                generation: 0,
                memberProfileIds: ["work"],
            },
        });

        const added = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/members",
            headers: authHeaders(user.id),
            payload: { profileId: "backup", priority: 200 },
        });
        expect(added.statusCode).toBe(200);
        const addCursor = await readAccountChangeCursor(user.id);
        expect(addCursor).toBeGreaterThan(patchCursor ?? -1);
        expectLastProjectedGroup({
            accountId: user.id,
            group: {
                groupId: "codex-main",
                displayName: "Codex Primary",
                activeProfileId: "work",
                generation: 1,
                memberProfileIds: ["work", "backup"],
            },
        });

        const switched = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/active-profile",
            headers: authHeaders(user.id),
            payload: { profileId: "backup", expectedGeneration: 1 },
        });
        expect(switched.statusCode).toBe(200);
        const switchCursor = await readAccountChangeCursor(user.id);
        expect(switchCursor).toBeGreaterThan(addCursor ?? -1);
        expectLastProjectedGroup({
            accountId: user.id,
            group: {
                groupId: "codex-main",
                displayName: "Codex Primary",
                activeProfileId: "backup",
                generation: 2,
                memberProfileIds: ["work", "backup"],
            },
        });

        const disabled = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/members/backup",
            headers: authHeaders(user.id),
            payload: { enabled: false },
        });
        expect(disabled.statusCode).toBe(200);
        const disableCursor = await readAccountChangeCursor(user.id);
        expect(disableCursor).toBeGreaterThan(switchCursor ?? -1);
        expectLastProjectedGroup({
            accountId: user.id,
            group: {
                groupId: "codex-main",
                displayName: "Codex Primary",
                activeProfileId: null,
                generation: 3,
                memberProfileIds: ["work"],
            },
        });

        const deleted = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: { "x-test-user-id": user.id },
        });
        expect(deleted.statusCode).toBe(200);
        expect(deleted.json()).toEqual({ success: true });
        const deleteCursor = await readAccountChangeCursor(user.id);
        expect(deleteCursor).toBeGreaterThan(disableCursor ?? -1);
        expectLastProjectedGroup({
            accountId: user.id,
            group: null,
        });
    });

    it("rejects active profile switches to persisted runtime-cooldown members", async () => {
        const user = await createAccount("pk-groups-active-profile-runtime-cooldown");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        const app = await createReadyApp();
        const resetAtMs = Date.now() + 60_000;

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }, { profileId: "backup" }],
                activeProfileId: "backup",
            },
        })).statusCode).toBe(200);
        expect((await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/runtime-state",
            headers: authHeaders(user.id),
            payload: {
                expectedGeneration: 0,
                memberStates: [
                    {
                        profileId: "work",
                        state: { quotaExhaustedUntilMs: resetAtMs },
                    },
                ],
            },
        })).statusCode).toBe(200);

        const blocked = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/active-profile",
            headers: authHeaders(user.id),
            payload: { profileId: "work", expectedGeneration: 0 },
        });

        expect(blocked.statusCode).toBe(409);
        expect(blocked.json()).toEqual({ error: "connect_group_profile_runtime_cooldown", resetAtMs });

        const authInvalidUntilMs = resetAtMs + 30_000;
        expect((await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/runtime-state",
            headers: authHeaders(user.id),
            payload: {
                expectedGeneration: 0,
                memberStates: [
                    {
                        profileId: "work",
                        state: { authInvalidUntilMs },
                    },
                ],
            },
        })).statusCode).toBe(200);

        const authBlocked = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/active-profile",
            headers: authHeaders(user.id),
            payload: { profileId: "work", expectedGeneration: 0 },
        });

        expect(authBlocked.statusCode).toBe(409);
        expect(authBlocked.json()).toEqual({ error: "connect_group_profile_runtime_cooldown", resetAtMs: authInvalidUntilMs });

        const patchBlocked = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: authHeaders(user.id),
            payload: { activeProfileId: "work" },
        });

        expect(patchBlocked.statusCode).toBe(409);
        expect(patchBlocked.json()).toEqual({ error: "connect_group_profile_runtime_cooldown", resetAtMs: authInvalidUntilMs });
    });

    it("applies the group patch active profile contract", async () => {
        const user = await createAccount("pk-groups-patch-active");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }, { profileId: "backup" }],
                activeProfileId: "work",
            },
        })).statusCode).toBe(200);

        const patched = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: authHeaders(user.id),
            payload: { activeProfileId: "backup" },
        });

        expect(patched.statusCode).toBe(200);
        expect(patched.json()).toEqual({
            group: expect.objectContaining({ activeProfileId: "backup", generation: 1 }),
        });
    });

    it("defaults create activeProfileId to the first enabled member and rejects explicit disabled active members", async () => {
        const user = await createAccount("pk-groups-disabled-active-create");
        await createConnectedProfile(user.id, "openai-codex", "disabled-backup");
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();

        const defaulted = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-default",
                members: [
                    { profileId: "disabled-backup", enabled: false, priority: 10 },
                    { profileId: "work", priority: 20 },
                ],
            },
        });

        expect(defaulted.statusCode).toBe(200);
        expect(defaulted.json()).toEqual({
            group: expect.objectContaining({
                activeProfileId: "work",
                members: expect.arrayContaining([
                    expect.objectContaining({ profileId: "disabled-backup", enabled: false }),
                    expect.objectContaining({ profileId: "work", enabled: true }),
                ]),
            }),
        });

        const rejected = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-explicit-disabled",
                members: [
                    { profileId: "disabled-backup", enabled: false },
                    { profileId: "work" },
                ],
                activeProfileId: "disabled-backup",
            },
        });

        expect(rejected.statusCode).toBe(400);
        expect(rejected.json()).toEqual({ error: "connect_group_active_profile_not_member" });
    });

    it("bumps generation for member additions, updates, and non-active removals", async () => {
        const user = await createAccount("pk-groups-members");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        const app = await createReadyApp();

        const created = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }],
                activeProfileId: "work",
            },
        });
        expect(created.statusCode).toBe(200);
        expect(created.json()).toEqual({
            group: expect.objectContaining({ generation: 0 }),
        });

        const added = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/members",
            headers: authHeaders(user.id),
            payload: { profileId: "backup", priority: 75 },
        });
        expect(added.statusCode).toBe(200);
        expect(added.json()).toEqual({
            group: expect.objectContaining({
                generation: 1,
                members: expect.arrayContaining([
                    expect.objectContaining({ profileId: "backup", priority: 75, enabled: true }),
                ]),
            }),
        });

        const disabled = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/members/backup",
            headers: authHeaders(user.id),
            payload: { enabled: false, priority: 50 },
        });
        expect(disabled.statusCode).toBe(200);
        expect(disabled.json()).toEqual({
            group: expect.objectContaining({
                generation: 2,
                members: expect.arrayContaining([
                    expect.objectContaining({ profileId: "backup", enabled: false, priority: 50 }),
                ]),
            }),
        });

        const removed = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/groups/codex-main/members/backup",
            headers: { "x-test-user-id": user.id },
        });
        expect(removed.statusCode).toBe(200);
        expect(removed.json()).toEqual({
            group: expect.objectContaining({
                activeProfileId: "work",
                generation: 3,
                members: [
                    expect.objectContaining({ profileId: "work" }),
                ],
            }),
        });

        const credential = await db.serviceAccountToken.findUnique({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "openai-codex", profileId: "backup" } },
            select: { id: true },
        });
        expect(credential).not.toBeNull();
    });

    it("clears disabled active profiles and blocks patch or switch routes from reselecting them", async () => {
        const user = await createAccount("pk-groups-disabled-active-retain");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }, { profileId: "backup" }],
                activeProfileId: "backup",
            },
        })).statusCode).toBe(200);

        const disabled = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/members/backup",
            headers: authHeaders(user.id),
            payload: { enabled: false },
        });

        expect(disabled.statusCode).toBe(200);
        expect(disabled.json()).toEqual({
            group: expect.objectContaining({
                activeProfileId: null,
                generation: 1,
                members: expect.arrayContaining([
                    expect.objectContaining({ profileId: "backup", enabled: false }),
                ]),
            }),
        });

        const patchRes = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: authHeaders(user.id),
            payload: { activeProfileId: "backup" },
        });
        expect(patchRes.statusCode).toBe(400);
        expect(patchRes.json()).toEqual({ error: "connect_group_active_profile_not_member" });

        const switchRes = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/active-profile",
            headers: authHeaders(user.id),
            payload: { profileId: "backup", expectedGeneration: 1 },
        });
        expect(switchRes.statusCode).toBe(400);
        expect(switchRes.json()).toEqual({ error: "connect_group_active_profile_not_member" });
    });

    it("prevents deleting a credential while it is referenced by any group member", async () => {
        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: { groupId: "codex-main", members: [{ profileId: "work" }], activeProfileId: "work" },
        })).statusCode).toBe(200);

        expect((await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/members/work",
            headers: authHeaders(user.id),
            payload: { enabled: false },
        })).statusCode).toBe(200);

        const res = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/profiles/work/credential",
            headers: { "x-test-user-id": user.id },
        });

        expect(res.statusCode).toBe(409);
        expect(res.json()).toEqual({ error: "connect_credential_referenced_by_group" });

        const v2Res = await app.inject({
            method: "DELETE",
            url: "/v2/connect/openai-codex/profiles/work/credential",
            headers: { "x-test-user-id": user.id },
        });
        expect(v2Res.statusCode).toBe(409);
        expect(v2Res.json()).toEqual({ error: "connect_credential_referenced_by_group" });
    });

    it("gates active profile switching on the account-fallback feature", async () => {
        const user = await createAccount("pk-groups-active-profile-fallback-gate");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }, { profileId: "backup" }],
                activeProfileId: "work",
            },
        })).statusCode).toBe(200);

        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_FALLBACK__ENABLED: "0" });
        const res = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/active-profile",
            headers: authHeaders(user.id),
            payload: { profileId: "backup", expectedGeneration: 0 },
        });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "connect_group_fallback_disabled" });

        const patchRes = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: authHeaders(user.id),
            payload: { activeProfileId: "backup" },
        });

        expect(patchRes.statusCode).toBe(400);
        expect(patchRes.json()).toEqual({ error: "connect_group_fallback_disabled" });
    });

    it("preserves stored groups when the feature gate is rolled back", async () => {
        const user = await createAccount("pk-groups-forward-only");
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: { groupId: "codex-main", members: [{ profileId: "work" }], activeProfileId: "work" },
        })).statusCode).toBe(200);

        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_GROUPS__ENABLED: "0" });
        const disabled = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: { "x-test-user-id": user.id },
        });
        expect(disabled.statusCode).toBe(404);
        expect(disabled.json()).toEqual({ error: "not_found" });

        harness.resetEnv();
        const restored = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: { "x-test-user-id": user.id },
        });
        expect(restored.statusCode).toBe(200);
        expect(restored.json()).toEqual({
            group: expect.objectContaining({ groupId: "codex-main", activeProfileId: "work" }),
        });
    });

    it("allows stable credential delete APIs to clean hidden group references after account-groups rollback", async () => {
        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }, { profileId: "backup" }],
                activeProfileId: "work",
            },
        })).statusCode).toBe(200);
        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-secondary",
                members: [{ profileId: "backup" }, { profileId: "work" }],
                activeProfileId: "backup",
            },
        })).statusCode).toBe(200);

        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_GROUPS__ENABLED: "0" });

        const v3Delete = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/profiles/work/credential",
            headers: { "x-test-user-id": user.id },
        });

        expect(v3Delete.statusCode).toBe(200);
        expect(v3Delete.json()).toEqual({ success: true });

        expect(await db.connectedServiceAuthGroup.findUnique({
            where: {
                accountId_vendor_groupId: {
                    accountId: user.id,
                    vendor: "openai-codex",
                    groupId: "codex-main",
                },
            },
            select: { activeProfileId: true, generation: true },
        })).toEqual({ activeProfileId: null, generation: 1 });
        expect(await db.connectedServiceAuthGroup.findUnique({
            where: {
                accountId_vendor_groupId: {
                    accountId: user.id,
                    vendor: "openai-codex",
                    groupId: "codex-secondary",
                },
            },
            select: { activeProfileId: true, generation: true },
        })).toEqual({ activeProfileId: "backup", generation: 1 });

        const v2Delete = await app.inject({
            method: "DELETE",
            url: "/v2/connect/openai-codex/profiles/backup/credential",
            headers: { "x-test-user-id": user.id },
        });

        expect(v2Delete.statusCode).toBe(200);
        expect(v2Delete.json()).toEqual({ success: true });

        expect(await db.serviceAccountToken.findMany({
            where: { accountId: user.id, vendor: "openai-codex" },
            select: { profileId: true },
            orderBy: { profileId: "asc" },
        })).toEqual([]);

        expect(await db.connectedServiceAuthGroup.findUnique({
            where: {
                accountId_vendor_groupId: {
                    accountId: user.id,
                    vendor: "openai-codex",
                    groupId: "codex-main",
                },
            },
            select: { activeProfileId: true, generation: true },
        })).toEqual({ activeProfileId: null, generation: 2 });
        expect(await db.connectedServiceAuthGroup.findUnique({
            where: {
                accountId_vendor_groupId: {
                    accountId: user.id,
                    vendor: "openai-codex",
                    groupId: "codex-secondary",
                },
            },
            select: { activeProfileId: true, generation: true },
        })).toEqual({ activeProfileId: null, generation: 2 });

        expect(await db.connectedServiceAuthGroupMember.findMany({
            where: { accountId: user.id, vendor: "openai-codex", groupId: "codex-main" },
            select: { profileId: true },
        })).toEqual([]);
        expect(await db.connectedServiceAuthGroupMember.findMany({
            where: { accountId: user.id, vendor: "openai-codex", groupId: "codex-secondary" },
            select: { profileId: true },
        })).toEqual([]);
    });

    it("cascades auth-group members when a referenced credential row is deleted directly", async () => {
        const user = await createAccount("pk-groups-db-cascade");
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }],
                activeProfileId: "work",
            },
        })).statusCode).toBe(200);

        await db.serviceAccountToken.delete({
            where: {
                accountId_vendor_profileId: {
                    accountId: user.id,
                    vendor: "openai-codex",
                    profileId: "work",
                },
            },
        });

        expect(await db.connectedServiceAuthGroupMember.findMany({
            where: { accountId: user.id, vendor: "openai-codex", groupId: "codex-main" },
            select: { profileId: true },
        })).toEqual([]);
    });

    it("gates automatic fallback policy fields on the account-fallback feature", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_FALLBACK__ENABLED: "0" });
        const user = await createAccount("pk-groups-fallback-gate");
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();

        const res = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }],
                activeProfileId: "work",
                policy: { autoSwitch: true },
            },
        });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "connect_group_fallback_disabled" });
    });

    it("accepts automatic fallback policy when account fallback dependencies are enabled", async () => {
        const user = await createAccount("pk-groups-fallback-enabled");
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();

        const res = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }],
                activeProfileId: "work",
                policy: { autoSwitch: true },
            },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
            group: expect.objectContaining({
                policy: expect.objectContaining({ autoSwitch: true }),
            }),
        });
    });

    it("roundtrips quota-aware auth-group policy fields through PATCH", async () => {
        const user = await createAccount("pk-groups-policy-roundtrip");
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }],
                activeProfileId: "work",
            },
        })).statusCode).toBe(200);

        const patched = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: authHeaders(user.id),
            payload: {
                policy: {
                    softSwitchRemainingPercent: 9,
                    probeIfSnapshotOlderThanMs: 120_000,
                    preTurnProbeMode: "always_for_group",
                    preTurnProbeOrder: "candidates_first_then_current",
                    recoveryMode: "wait_until_reset",
                    recoveryPromptMode: "standard",
                    resumePromptMode: "standard",
                    effectiveMeterStrategy: "weekly",
                    memberRuntimeStatePersistence: "server_state_json",
                },
            },
        });

        expect(patched.statusCode).toBe(200);
        expect(patched.json()).toEqual({
            group: expect.objectContaining({
                policy: expect.objectContaining({
                    softSwitchRemainingPercent: 9,
                    probeIfSnapshotOlderThanMs: 120_000,
                    preTurnProbeMode: "always_for_group",
                    preTurnProbeOrder: "candidates_first_then_current",
                    recoveryMode: "wait_until_reset",
                    recoveryPromptMode: "standard",
                    resumePromptMode: "standard",
                    effectiveMeterStrategy: "weekly",
                    memberRuntimeStatePersistence: "server_state_json",
                }),
            }),
        });

        const fetched = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: { "x-test-user-id": user.id },
        });

        expect(fetched.statusCode).toBe(200);
        expect(fetched.json().group.policy.effectiveMeterStrategy).toBe("weekly");
    });

    it("rejects malformed request policy", async () => {
        const user = await createAccount("pk-groups-policy-reject");
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();

        const res = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }],
                policy: { strategy: "round_robin" },
            },
        });

        expect(res.statusCode).toBe(400);
    });

    it("falls back to the fail-closed default when stored policy is malformed", async () => {
        const user = await createAccount("pk-groups-policy-fallback");
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();

        const created = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: { groupId: "codex-main", members: [{ profileId: "work" }], activeProfileId: "work" },
        });
        expect(created.statusCode).toBe(200);

        await db.connectedServiceAuthGroup.update({
            where: { accountId_vendor_groupId: { accountId: user.id, vendor: "openai-codex", groupId: "codex-main" } },
            data: { policyJson: "{malformed" },
        });

        const res = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: { "x-test-user-id": user.id },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
            group: expect.objectContaining({
                policy: expect.objectContaining({
                    v: 1,
                    strategy: "priority",
                    autoSwitch: false,
                    recoveryMode: "switch_or_wait",
                    effectiveMeterStrategy: "most_constrained",
                }),
            }),
        });
    });

    it("roundtrips persisted auth-group runtime state from stateJson", async () => {
        const user = await createAccount("pk-groups-state-json");
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: { groupId: "codex-main", members: [{ profileId: "work" }], activeProfileId: "work" },
        })).statusCode).toBe(200);

        await db.connectedServiceAuthGroup.update({
            where: { accountId_vendor_groupId: { accountId: user.id, vendor: "openai-codex", groupId: "codex-main" } },
            data: { stateJson: JSON.stringify({ status: "exhausted", lastSwitchReason: "usage_limit" }) },
        });
        await db.connectedServiceAuthGroupMember.update({
            where: {
                accountId_vendor_groupId_profileId: {
                    accountId: user.id,
                    vendor: "openai-codex",
                    groupId: "codex-main",
                    profileId: "work",
                },
            },
            data: {
                stateJson: JSON.stringify({
                    quotaExhaustedUntilMs: 10,
                    rateLimitedUntilMs: 20,
                    capacityLimitedUntilMs: 30,
                    authInvalidUntilMs: 40,
                    lastFailureKind: "usage_limit",
                    lastFailureCode: "usage_limit_reached",
                    lastObservedPlanType: "team",
                    lastObservedAtMs: 50,
                }),
            },
        });

        const res = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: { "x-test-user-id": user.id },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
            group: expect.objectContaining({
                state: expect.objectContaining({ status: "exhausted", lastSwitchReason: "usage_limit" }),
                members: [
                    expect.objectContaining({
                        profileId: "work",
                        state: {
                            quotaExhaustedUntilMs: 10,
                            rateLimitedUntilMs: 20,
                            capacityLimitedUntilMs: 30,
                            authInvalidUntilMs: 40,
                            lastFailureKind: "usage_limit",
                            lastFailureCode: "usage_limit_reached",
                            lastObservedPlanType: "team",
                            lastObservedAtMs: 50,
                        },
                    }),
                ],
            }),
        });
    });

    it("updates group and member runtime state with generation guard", async () => {
        const user = await createAccount("pk-groups-runtime-state-update");
        await createConnectedProfile(user.id, "openai-codex", "work");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: { groupId: "codex-main", members: [{ profileId: "work" }], activeProfileId: "work" },
        })).statusCode).toBe(200);

        const updated = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/runtime-state",
            headers: authHeaders(user.id),
            payload: {
                expectedGeneration: 0,
                state: {
                    status: "exhausted",
                    lastSwitchReason: "usage_limit",
                },
                memberStates: [
                    {
                        profileId: "work",
                        state: {
                            quotaExhaustedUntilMs: 10,
                            rateLimitedUntilMs: 20,
                            capacityLimitedUntilMs: 30,
                            authInvalidUntilMs: 40,
                            lastFailureKind: "usage_limit",
                            lastFailureCode: "usage_limit_reached",
                            lastObservedPlanType: "team",
                            lastObservedAtMs: 50,
                        },
                    },
                ],
            },
        });

        expect(updated.statusCode).toBe(200);
        expect(updated.json()).toEqual({
            group: expect.objectContaining({
                generation: 0,
                state: expect.objectContaining({ status: "exhausted", lastSwitchReason: "usage_limit" }),
                members: [
                    expect.objectContaining({
                        profileId: "work",
                        state: {
                            quotaExhaustedUntilMs: 10,
                            rateLimitedUntilMs: 20,
                            capacityLimitedUntilMs: 30,
                            authInvalidUntilMs: 40,
                            lastFailureKind: "usage_limit",
                            lastFailureCode: "usage_limit_reached",
                            lastObservedPlanType: "team",
                            lastObservedAtMs: 50,
                        },
                    }),
                ],
            }),
        });
    });

    it("rejects stale runtime state updates without overwriting group or member state", async () => {
        const user = await createAccount("pk-groups-runtime-state-conflict");
        await createConnectedProfile(user.id, "openai-codex", "work");
        await createConnectedProfile(user.id, "openai-codex", "backup");
        const app = await createReadyApp();

        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(user.id),
            payload: {
                groupId: "codex-main",
                members: [{ profileId: "work" }, { profileId: "backup" }],
                activeProfileId: "work",
            },
        })).statusCode).toBe(200);
        expect((await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/codex-main/active-profile",
            headers: authHeaders(user.id),
            payload: { profileId: "backup", expectedGeneration: 0 },
        })).statusCode).toBe(200);

        const stale = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/codex-main/runtime-state",
            headers: authHeaders(user.id),
            payload: {
                expectedGeneration: 0,
                state: {
                    status: "exhausted",
                    lastSwitchReason: "usage_limit",
                },
                memberStates: [
                    {
                        profileId: "work",
                        state: { quotaExhaustedUntilMs: 10 },
                    },
                ],
            },
        });

        expect(stale.statusCode).toBe(409);
        expect(stale.json()).toEqual({ error: "connect_group_generation_conflict", generation: 1 });

        const fetched = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups/codex-main",
            headers: { "x-test-user-id": user.id },
        });
        expect(fetched.statusCode).toBe(200);
        expect(fetched.json().group.state).toEqual({});
        expect(fetched.json().group.members).toEqual(expect.arrayContaining([
            expect.objectContaining({ profileId: "work", state: {} }),
        ]));
    });
});
