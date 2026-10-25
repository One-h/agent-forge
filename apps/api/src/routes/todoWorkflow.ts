import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notifyTodoOwner } from "../todoNotifications.js";
import {
  createTodoWithWorkflow,
  todoPriorities,
  todoReminderFrequencies,
  type LarkTodoContext
} from "../todoWorkflow.js";

const todoCapabilitySchema = z.object({
  input: z.object({
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().max(4_000).optional().nullable(),
    priority: z.enum(todoPriorities).optional(),
    tags: z.array(z.string().trim().min(1).max(32)).max(8).optional(),
    dueAt: z.string().datetime().optional().nullable(),
    reminderFrequency: z.enum(todoReminderFrequencies).optional(),
    notifyOnCompletion: z.boolean().optional()
  }),
  context: z.object({
    larkMessageId: z.coerce.number().int().positive(),
    chatId: z.string().optional().nullable(),
    chatType: z.string().optional().nullable(),
    senderId: z.string().optional().nullable()
  }).optional()
});

export async function todoWorkflowRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/lark-agent/capabilities/forge.todo.create", async (request, reply) => {
    const parsed = todoCapabilitySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid todo input" });
    const context: LarkTodoContext | undefined = parsed.data.context ? {
      larkMessageId: parsed.data.context.larkMessageId,
      chatId: parsed.data.context.chatId ?? null,
      chatType: parsed.data.context.chatType ?? null,
      senderId: parsed.data.context.senderId ?? null
    } : undefined;
    try {
      const result = createTodoWithWorkflow(parsed.data.input, context);
      const ownerNotified = context ? await notifyTodoOwner(result.todo.id) : false;
      return reply.code(result.created ? 201 : 200).send({
        ...result.todo,
        created: result.created,
        ownerNotified,
        _receipt: {
          status: "verified",
          summary: result.created ? `已创建待办：${result.todo.title}` : `待办已存在：${result.todo.title}`,
          evidence: [`todo_id: ${result.todo.id}`]
        }
      });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
