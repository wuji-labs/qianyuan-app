import { z } from "zod";

import { applySessionEnd } from "@/app/session/applySessionEnd";
import { type Fastify } from "../../types";

export function registerSessionEndRoute(app: Fastify) {
    app.post("/v1/sessions/:sessionId/end", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ sessionId: z.string() }),
            body: z.object({
                time: z.number().int().nonnegative().optional(),
            }).optional(),
            response: {
                200: z.object({ success: z.literal(true), applied: z.boolean() }),
                400: z.object({ error: z.literal("Invalid parameters") }),
                404: z.object({ error: z.literal("Session not found") }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const result = await applySessionEnd({
            actorUserId: userId,
            sessionId,
            time: request.body?.time,
        });

        if (!result.ok) {
            return reply.code(404).send({ error: "Session not found" });
        }

        return reply.send({ success: true as const, applied: result.applied });
    });
}
