import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { LarkAgentResponseError, larkAgentProxyFetch } from "../larkAgentIntegration.js";
export async function agentMessagingRoutes(app: FastifyInstance) {
  for (const route of [
    { method: "GET" as const, url: "/api/agent-messaging", target: "/v1/agent-messaging" },
    { method: "POST" as const, url: "/api/agent-messaging/:id/decision", target: "/v1/agent-messaging/:id/decision" },
    { method: "POST" as const, url: "/api/agent-messaging/outreach/:id/close", target: "/v1/agent-messaging/outreach/:id/close" }
  ]) app.route({method:route.method,url:route.url,handler:async(request,reply)=>{
    if (!config.larkAgentUrl) return reply.code(503).send({error:"请先连接 Lark Agent。"});
    if(request.method!=="GET" && request.headers.origin && ![`http://127.0.0.1:${config.webPort}`,`http://localhost:${config.webPort}`,"http://127.0.0.1:4734"].includes(request.headers.origin))return reply.code(403).send({error:"untrusted origin"});
    const id=(request.params as {id?:string}).id;
    if(id && !/^[a-zA-Z0-9-]+$/.test(id))return reply.code(400).send({error:"invalid id"});
    try{return await larkAgentProxyFetch(id?route.target.replace(":id",id):route.target,{method:request.method,...(request.method!=="GET"?{headers:{"content-type":"application/json"},body:JSON.stringify(request.body??{})}:{})});}
    catch(error){if(error instanceof LarkAgentResponseError)return reply.code(error.statusCode).send(error.responseBody);return reply.code(502).send({error:"消息路由服务暂时无法连接。"});}
  }});
}
