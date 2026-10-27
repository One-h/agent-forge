import { groupPrivacyRoutes } from "./routes/groupPrivacy.js";
import { agentMessagingRoutes } from "./routes/agentMessaging.js";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { config } from "./config.js";
import { hydrateRuntimeConfig, migrate } from "./db.js";
import { giteaSyncConfigStatus } from "./gitea.js";
import { issueRoutes } from "./routes/issues.js";
import { jobRoutes } from "./routes/jobs.js";
import { stickerRoutes } from "./routes/stickers.js";
import { todoRoutes } from "./routes/todos.js";
import { startBackgroundWorkers, stopBackgroundWorkers } from "./worker.js";
import { registerForgeLarkAgentCapabilities } from "./larkAgentIntegration.js";
import { todoWorkflowRoutes } from "./routes/todoWorkflow.js";
import { personalInboxRoutes } from "./routes/personalInbox.js";

migrate();
hydrateRuntimeConfig();

const app = Fastify({ logger: true });
await app.register(cors, {
  origin: [`http://127.0.0.1:${config.webPort}`, `http://localhost:${config.webPort}`]
});
await app.register(todoWorkflowRoutes);
await app.register(issueRoutes);
await app.register(jobRoutes);
await app.register(stickerRoutes);
await app.register(todoRoutes);
await app.register(personalInboxRoutes);
await app.register(agentMessagingRoutes);
await app.register(groupPrivacyRoutes);

app.get("/api/health", async () => ({
  ok: true,
  bindHost: config.host,
  workspaceRoot: config.workspaceRoot,
  maxConcurrentCodexJobs: config.maxConcurrentCodexJobs,
  giteaSync: giteaSyncConfigStatus()
}));

const shutdown = async () => {
  stopBackgroundWorkers();
  await app.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await app.listen({ port: config.port, host: config.host });
startBackgroundWorkers();
if (config.larkAgentUrl) {
  void registerForgeLarkAgentCapabilities().catch((error) => app.log.warn({ err: error }, "Unable to register Forge capabilities with Lark Agent"));
}
