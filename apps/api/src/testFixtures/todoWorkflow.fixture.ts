import assert from "node:assert/strict";
import Fastify from "fastify";
import { config } from "../config.js";
import { createLocalBackup, db, migrate, restoreLocalBackup } from "../db.js";
import { todoWorkflowRoutes } from "../routes/todoWorkflow.js";
import { todoRoutes } from "../routes/todos.js";
import { runTodoNotificationTick } from "../todoNotifications.js";
import {
  createTodoWithWorkflow,
  defaultTodoSchedule,
  listTodoWorkflowViews,
  markTodoCompleted,
  notificationState,
  setNotificationState,
  updateTodoDelivery,
  updateTodoWorkflow
} from "../todoWorkflow.js";

migrate();

const context = { larkMessageId: 42, chatId: "oc_example", chatType: "group", senderId: "ou_requester" };
const first = createTodoWithWorkflow({
  title: "整理数据结论",
  priority: "high",
  tags: ["数据", "周会"]
}, context);
const second = createTodoWithWorkflow({ title: "不应重复创建" }, context);
assert.equal(first.created, true);
assert.equal(second.created, false);
assert.equal(second.todo.id, first.todo.id);
assert.equal(first.todo.priority, "high");
assert.deepEqual(first.todo.tags, ["数据", "周会"]);
assert.equal(first.todo.source_chat_id, "oc_example");
assert.ok(first.todo.due_at);
assert.equal(listTodoWorkflowViews().length, 1);

const schedule = defaultTodoSchedule("urgent", new Date("2026-01-01T00:00:00.000Z"));
assert.equal(schedule.dueAt, "2026-01-02T00:00:00.000Z");
assert.equal(schedule.reminderFrequency, "every_2_hours");
const updated = updateTodoWorkflow(first.todo.id, {
  priority: "urgent",
  reminderFrequency: "every_2_hours",
  completionResult: "数据已核对并发送",
  notifyOnCompletion: false
});
assert.equal(updated?.priority, "urgent");
assert.equal(updated?.notify_on_completion, 0);
const completed = markTodoCompleted(first.todo.id, "数据已核对并发送");
assert.equal(completed?.completion_result, "数据已核对并发送");
assert.ok(completed?.completed_at);
assert.equal(completed?.next_reminder_at, null);

const app = Fastify();
await app.register(todoWorkflowRoutes);
await app.register(todoRoutes);
const payload = {
  input: { title: "跟进产品建议", priority: "urgent", tags: ["产品"] },
  context: { larkMessageId: 43, chatId: "oc_product", chatType: "group", senderId: "ou_requester" }
};
const capabilityFirst = await app.inject({ method: "POST", url: "/api/lark-agent/capabilities/forge.todo.create", payload });
const capabilitySecond = await app.inject({ method: "POST", url: "/api/lark-agent/capabilities/forge.todo.create", payload });
assert.equal(capabilityFirst.statusCode, 201);
assert.equal(capabilitySecond.statusCode, 200);
assert.equal(capabilityFirst.json().id, capabilitySecond.json().id);
assert.equal(capabilityFirst.json().priority, "urgent");

const created = await app.inject({
  method: "POST",
  url: "/api/todos",
  payload: { title: "手动任务", priority: "low", tags: ["整理"] }
});
assert.equal(created.statusCode, 201);
const id = created.json().id as number;
const apiUpdated = await app.inject({
  method: "PATCH",
  url: `/api/todos/${id}`,
  payload: { status: "done", completionResult: "已整理", notifyOnCompletion: false }
});
assert.equal(apiUpdated.statusCode, 200);
assert.equal(apiUpdated.json().completion_result, "已整理");
assert.equal(apiUpdated.json().priority, "low");

const sentAt = "2026-01-01T08:00:00.000Z";
updateTodoDelivery(id, { notified_at: sentAt });
const completedAt = listTodoWorkflowViews().find((todo) => todo.id === id)?.completed_at;
const editedDone = await app.inject({
  method: "PATCH",
  url: `/api/todos/${id}`,
  payload: { title: "已完成任务的新标题", status: "done", completionResult: "补充说明", notifyOnCompletion: true }
});
assert.equal(editedDone.statusCode, 200);
assert.equal(editedDone.json().completed_at, completedAt);
assert.equal(editedDone.json().notified_at, sentAt);

const backup = createLocalBackup();
assert.equal(backup.todos.find((todo) => todo.id === first.todo.id)?.id, first.todo.id);
assert.equal((backup.todoWorkflowMetadata[String(first.todo.id)] as { priority?: string }).priority, "urgent");
restoreLocalBackup(backup);
const restored = listTodoWorkflowViews().find((todo) => todo.id === first.todo.id);
assert.equal(restored?.priority, "urgent");
assert.deepEqual(restored?.tags, ["数据", "周会"]);
assert.equal(restored?.source_lark_message_id, 42);

const capabilityId = capabilityFirst.json().id as number;
updateTodoDelivery(capabilityId, { owner_notified_at: sentAt });
setNotificationState("todo.digest.date", "");
setNotificationState("todo.digest.retryAt", "");
const previousApprover = config.larkExecutionApproverId;
config.larkExecutionApproverId = "ou_owner";
let outboundCalls = 0;
const digestTime = new Date("2026-01-02T02:00:00.000Z");
await runTodoNotificationTick(digestTime, async () => {
  outboundCalls += 1;
  throw new Error("runtime unavailable");
});
assert.equal(outboundCalls, 1);
assert.match(notificationState("todo.digest.error") ?? "", /runtime unavailable/);
assert.ok(Date.parse(notificationState("todo.digest.retryAt") ?? "") > digestTime.getTime());
await runTodoNotificationTick(new Date(digestTime.getTime() + 60_000), async () => { outboundCalls += 1; });
assert.equal(outboundCalls, 1);
await runTodoNotificationTick(new Date(digestTime.getTime() + 16 * 60_000), async () => { outboundCalls += 1; });
assert.equal(outboundCalls, 2);
assert.equal(notificationState("todo.digest.date"), "2026-01-02");
config.larkExecutionApproverId = previousApprover;

await app.close();
db.close();
