import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { listCodexSessions } from "../codexSessions.js";
import { deleteCodexTodo, updateCodexTodo } from "../codexTodos.js";
import { codexTodoStatuses } from "../codexTodos.js";
import { markTodoCompleted, createTodoWithWorkflow, deleteTodoWorkflow, listTodoWorkflowViews, todoPriorities, todoReminderFrequencies, updateTodoWorkflow } from "../todoWorkflow.js";
import { notifyTodoCompletion } from "../todoNotifications.js";

const todoStatusSchema = z.enum(codexTodoStatuses as [typeof codexTodoStatuses[number], ...typeof codexTodoStatuses]);

const createTodoSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  status: todoStatusSchema.optional(),
  codexSessionId: z.string().optional().nullable(),
  codexTaskDir: z.string().optional().nullable(),
  priority: z.enum(todoPriorities).optional(),
  tags: z.array(z.string()).max(8).optional(),
  dueAt: z.string().datetime().optional().nullable(),
  reminderFrequency: z.enum(todoReminderFrequencies).optional(),
  notifyOnCompletion: z.boolean().optional()
});

const patchTodoSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  status: todoStatusSchema.optional(),
  codexSessionId: z.string().optional().nullable(),
  codexTaskDir: z.string().optional().nullable(),
  priority: z.enum(todoPriorities).optional(),
  tags: z.array(z.string()).max(8).optional(),
  dueAt: z.string().datetime().optional().nullable(),
  reminderFrequency: z.enum(todoReminderFrequencies).optional(),
  completionResult: z.string().max(4_000).optional().nullable(),
  notifyOnCompletion: z.boolean().optional()
});

export async function todoRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/todos", async () => listTodoWorkflowViews());

  app.get("/api/codex/sessions", async (request) => {
    const query = z.object({
      q: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(2000).optional()
    }).parse(request.query ?? {});
    return listCodexSessions({ query: query.q, limit: query.limit });
  });

  app.post("/api/todos", async (request, reply) => {
    const body = createTodoSchema.parse(request.body ?? {});
    try {
      return reply.code(201).send(createTodoWithWorkflow(body).todo);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes("already has a todo") ? 409 : 400).send({ error: message });
    }
  });

  app.patch("/api/todos/:id", async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const body = patchTodoSchema.parse(request.body ?? {});
    try {
      const previous = listTodoWorkflowViews().find((entry) => entry.id === id);
      const todo = updateCodexTodo(id, body);
      if (!todo) {
        return reply.code(404).send({ error: "Todo not found" });
      }
      const workflow = updateTodoWorkflow(id, body);
      if (body.status === "done" && previous?.status !== "done") {
        markTodoCompleted(id, body.completionResult ?? workflow?.completion_result ?? null);
        if ((body.notifyOnCompletion ?? workflow?.notify_on_completion !== 0) && (body.completionResult ?? workflow?.completion_result)) {
          await notifyTodoCompletion(id);
        }
      }
      return listTodoWorkflowViews().find((entry) => entry.id === id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes("already has a todo") ? 409 : 400).send({ error: message });
    }
  });

  app.delete("/api/todos/:id", async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    if (!deleteCodexTodo(id)) {
      return reply.code(404).send({ error: "Todo not found" });
    }
    deleteTodoWorkflow(id);
    return reply.code(204).send();
  });
}
