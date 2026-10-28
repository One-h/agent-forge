import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { config } from "./config.js";
import { agentMessagingRoutes } from "./routes/agentMessaging.js";
import { groupPrivacyRoutes } from "./routes/groupPrivacy.js";
import { personalInboxRoutes } from "./routes/personalInbox.js";

test("Forge proxies inbox and routing with runtime auth, and rejects foreign-origin writes and invalid IDs",async()=>{
 const app=Fastify(),previousFetch=globalThis.fetch,previousUrl=config.larkAgentUrl,previousToken=config.larkAgentToken;
 const seen:{url:string;init?:RequestInit}[]=[];
 config.larkAgentUrl="http://127.0.0.1:4780";config.larkAgentToken="fixture-runtime-token";
 globalThis.fetch=(async(url:unknown,init?:RequestInit)=>{seen.push({url:String(url),init});return new Response(JSON.stringify({outreaches:[],replies:[]}),{status:200,headers:{"content-type":"application/json"}});}) as typeof fetch;
 try{
  await app.register(agentMessagingRoutes);await app.register(personalInboxRoutes);await app.register(groupPrivacyRoutes);
  assert.equal((await app.inject({method:"GET",url:"/api/agent-messaging"})).statusCode,200);
  assert.equal(seen[0].url,"http://127.0.0.1:4780/v1/agent-messaging");assert.equal((seen[0].init?.headers as Record<string,string>).authorization,"Bearer fixture-runtime-token");
  assert.equal((await app.inject({method:"GET",url:"/api/group-privacy"})).statusCode,200);
  assert.equal(seen.at(-1)?.url,"http://127.0.0.1:4780/v1/group-privacy");
  assert.equal((await app.inject({method:"PATCH",url:"/api/group-privacy",payload:{enabled:false}})).statusCode,200);
  assert.equal(seen.at(-1)?.init?.method,"PATCH");
  assert.deepEqual(JSON.parse(String(seen.at(-1)?.init?.body)),{enabled:false});
  assert.equal((seen.at(-1)?.init?.headers as Record<string,string>).authorization,"Bearer fixture-runtime-token");
  const count=seen.length;
  assert.equal((await app.inject({method:"POST",url:"/api/agent-messaging/1/decision",headers:{origin:"https://untrusted.example"},payload:{}})).statusCode,403);
  assert.equal((await app.inject({method:"PATCH",url:"/api/personal-inbox",headers:{origin:"https://untrusted.example"},payload:{enabled:true}})).statusCode,403);
  assert.equal((await app.inject({method:"POST",url:"/api/agent-messaging/..%2Fsecrets/decision",payload:{}})).statusCode,400);
  assert.equal((await app.inject({method:"POST",url:"/api/group-privacy/1/decision",headers:{origin:"https://untrusted.example"},payload:{action:"execute"}})).statusCode,403);
  assert.equal((await app.inject({method:"POST",url:"/api/group-privacy/..%2Fsettings/decision",payload:{}})).statusCode,400);
  assert.equal(seen.length,count);
  assert.equal((await app.inject({method:"POST",url:"/api/agent-messaging/1/decision",payload:{action:"assign",version:1,outreachId:"fixture"}})).statusCode,200);
  assert.equal(JSON.parse(String(seen.at(-1)?.init?.body)).action,"assign");
 }finally{globalThis.fetch=previousFetch;config.larkAgentUrl=previousUrl;config.larkAgentToken=previousToken;await app.close();}
});
