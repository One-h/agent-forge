import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import { z } from "zod";
import { addLocalAuditEvent } from "../db.js";
import { config } from "../config.js";
import { larkAgentFetch, larkAgentRequest } from "../larkAgentIntegration.js";
import { larkStickerImage, listLarkStickers, softDeleteLarkSticker, updateLarkSticker, uploadLarkStickers } from "../larkStickers.js";

const stickerIdSchema = z.string().regex(/^stk_[a-f0-9]{16}$/);
const tagsSchema = z.array(z.string().trim().min(1).max(30)).max(12);
const uploadSchema = z.object({
  files: z.array(z.object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(300).optional(),
    tags: tagsSchema.optional(),
    fileName: z.string().trim().min(1).max(255),
    mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]),
    dataBase64: z.string().min(1).max(2_800_000),
    sourceUrl: z.string().trim().url().max(2_000).optional(),
    sourceSite: z.string().trim().max(200).optional()
  })).min(1).max(20)
});
const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(300).optional(),
  tags: tagsSchema.optional(),
  enabled: z.boolean().optional()
}).refine((value) => Object.keys(value).length > 0, "至少修改一个字段");

export async function stickerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/lark/stickers", async () => {
    if (!config.larkAgentUrl) return listLarkStickers();
    const stickers = await larkAgentFetch("/v1/stickers") as Array<Record<string, unknown>>;
    return stickers.map((sticker) => ({ ...sticker, imageUrl: `/api/lark/stickers/${encodeURIComponent(String(sticker.id))}/image` }));
  });

  app.post("/api/lark/stickers/batch", { bodyLimit: 60 * 1024 * 1024 }, async (request, reply) => {
    try {
      const body = uploadSchema.parse(request.body ?? {});
      if (config.larkAgentUrl) return reply.code(201).send(await larkAgentRequest("/v1/stickers/batch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
      const stickers = uploadLarkStickers(body.files);
      addLocalAuditEvent("lark-stickers.uploaded", `批量上传 ${stickers.length} 个表情包`, { stickerIds: stickers.map((sticker) => sticker.id) });
      return reply.code(201).send(stickers);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.patch("/api/lark/stickers/:id", async (request, reply) => {
    try {
      const id = stickerIdSchema.parse((request.params as { id?: unknown }).id);
      const patch = updateSchema.parse(request.body ?? {});
      if (config.larkAgentUrl) return await larkAgentRequest(`/v1/stickers/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
      const sticker = updateLarkSticker(id, patch);
      if (!sticker) return reply.code(404).send({ error: "表情包不存在" });
      addLocalAuditEvent("lark-stickers.updated", `更新表情包 ${sticker.name}`, { stickerId: sticker.id, changedFields: Object.keys(patch) });
      return sticker;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/lark/stickers/:id", async (request, reply) => {
    try {
      const id = stickerIdSchema.parse((request.params as { id?: unknown }).id);
      if (config.larkAgentUrl) { await larkAgentRequest(`/v1/stickers/${encodeURIComponent(id)}`, { method: "DELETE" }); return reply.code(204).send(); }
      if (!softDeleteLarkSticker(id)) return reply.code(404).send({ error: "表情包不存在" });
      addLocalAuditEvent("lark-stickers.removed", "移除表情包", { stickerId: id, recoverable: true });
      return reply.code(204).send();
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/lark/stickers/:id/image", async (request, reply) => {
    try {
      const id = stickerIdSchema.parse((request.params as { id?: unknown }).id);
      if (config.larkAgentUrl) {
        const response = await fetch(`${config.larkAgentUrl}/v1/stickers/${encodeURIComponent(id)}/image`, { headers: config.larkAgentToken ? { authorization: `Bearer ${config.larkAgentToken}` } : {} });
        if (!response.ok) return reply.code(404).send({ error: "表情包图片不存在" });
        reply.header("Cache-Control", "private, max-age=300").type(response.headers.get("content-type") ?? "application/octet-stream");
        return reply.send(Buffer.from(await response.arrayBuffer()));
      }
      const image = larkStickerImage(id);
      if (!image) return reply.code(404).send({ error: "表情包图片不存在" });
      reply.header("Cache-Control", "private, max-age=300");
      return reply.type(image.mimeType).send(fs.createReadStream(image.path));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
