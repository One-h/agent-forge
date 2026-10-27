import { useEffect, useState } from "react";
import { MessageSquare, RefreshCw } from "lucide-react";
import "./personalInbox.css";
type Outreach = {id:string;sourceThreadId:string;sourceLabel:string;recipientId:string;identity:string;chatId:string;status:string;text:string;error:string|null};
type Reply = {id:number;payload:string;candidates:string;outreachId:string|null;status:string;error:string|null;version:number};
type Snapshot = {outreaches:Outreach[];replies:Reply[]};
const labels:Record<string,string>={open:"等待同事回复",closed:"任务已关闭",sending:"发送中",send_unknown:"请核对发送结果",queued:"等待投递",waiting_source:"等待原 Agent 领取",claimed:"原 Agent 已领取，待确认",delivering:"投递中",delivered:"已送回原会话",needs_owner:"请确认所属任务",delivery_unknown:"请核对原会话",dismissed:"已忽略"};
async function request<T>(route="",body?:unknown):Promise<T>{const response=await fetch(`/api/agent-messaging${route}`,{method:body===undefined?"GET":"POST",headers:{"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();if(!response.ok)throw new Error(value.error??"请求失败");return value;}
function ReplyCard({reply,outreaches,perform}:{reply:Reply;outreaches:Outreach[];perform:(action:()=>Promise<unknown>)=>void}){
  const [selected,setSelected]=useState(reply.outreachId??"");
  const message=JSON.parse(reply.payload) as {senderName:string;content:string;chatName:string};
  const ids=JSON.parse(reply.candidates) as string[];
  const candidates=outreaches.filter(row=>ids.includes(row.id));
  const editable=["needs_owner","waiting_source","delivery_unknown"].includes(reply.status);
  const target=outreaches.find(row=>row.id===reply.outreachId);
  return <article className="personalInboxMessage"><div className="personalInboxMessageHeader"><strong>{message.senderName}</strong><span className={`inboxState ${reply.status}`}>{labels[reply.status]??reply.status}</span></div>
    <p className="personalInboxContent">{message.content}</p>{message.chatName&&<p className="subtle">{message.chatName}</p>}
    {target&&<p>所属任务：{target.sourceLabel} · <a href={`codex://threads/${target.sourceThreadId}`}>打开来源会话</a></p>}
    {reply.error&&<p className="inboxWarning">{reply.error}</p>}
    {editable&&<div className="actionGroup"><label>交给哪个 Agent？ <select value={selected} onChange={event=>setSelected(event.target.value)}><option value="">请选择任务</option>{candidates.filter(row=>row.status==="open").map(row=><option key={row.id} value={row.id}>{row.sourceLabel} · {row.sourceThreadId.slice(0,8)} · {row.text.slice(0,50)}</option>)}</select></label>
      <button disabled={!selected} onClick={()=>perform(()=>request(`/${reply.id}/decision`,{action:"assign",outreachId:selected,version:reply.version}))}>{reply.status==="delivery_unknown"?"确认需要重新投递":"确认归属并投递"}</button>
      <button className="ghostButton" onClick={()=>perform(()=>request(`/${reply.id}/decision`,{action:"dismiss",version:reply.version}))}>忽略</button></div>}
  </article>;
}
export function AgentMessagingPage(){
  const [data,setData]=useState<Snapshot>({outreaches:[],replies:[]}),[error,setError]=useState(""),[busy,setBusy]=useState(false),[all,setAll]=useState(false);
  const load=async()=>setData(await request<Snapshot>());
  useEffect(()=>{void load().catch(error=>setError(String(error)));const timer=setInterval(()=>{if(!document.hidden)void load().catch(error=>setError(String(error)));},5000);return()=>clearInterval(timer);},[]);
  const perform=async(action:()=>Promise<unknown>)=>{if(busy)return;setBusy(true);setError("");try{await action();await load();}catch(error){setError(String(error));}finally{setBusy(false);}};
  return <section className="pageStack"><div className="heroBand"><div><p className="eyebrow">龙小祝 · 跨会话协作</p><h2><MessageSquare size={23}/>Agent 消息路由</h2><p className="subtle">引用回复按原消息归属；私聊只有一个有效来源会话时自动交回，多个来源或归属冲突时由你分配。</p></div><button disabled={busy} onClick={()=>void perform(load)}><RefreshCw size={16}/>刷新</button></div>
    {error&&<p role="alert" className="inboxWarning">{error}</p>}
    <div className="personalInboxStatus"><span>{data.outreaches.filter(row=>row.status==="open").length} 个协作请求进行中</span><span>{data.replies.filter(row=>row.status==="needs_owner").length} 条回复需要确认归属</span><label><input type="checkbox" checked={all} onChange={event=>setAll(event.target.checked)}/>显示已投递记录</label></div>
    <p className="subtle">同一 Codex 服务管理的会话可自动接收；其他会话通过 lark-agent-messaging skill 的等待工具领取。外部回复只作为消息数据传入。</p>
    {data.replies.filter(row=>all||!["delivered","dismissed"].includes(row.status)).map(reply=><ReplyCard key={reply.id} reply={reply} outreaches={data.outreaches} perform={action=>void perform(action)}/>)}
    {!data.replies.length&&<div className="emptyState">尚无同事回复。让 Agent 使用 lark-agent-messaging skill 发起第一条协作消息。</div>}
    <h3>发出的协作请求</h3>{data.outreaches.map(row=><article className="personalInboxMessage" key={row.id}><div className="personalInboxMessageHeader"><strong>{row.sourceLabel}</strong><span className="inboxState">{labels[row.status]??row.status}</span></div><p className="personalInboxContent">{row.text}</p><p className="subtle">{row.identity==="user"?"本人身份":"龙小祝机器人"} · {row.recipientId} · 来源 {row.sourceThreadId}</p>{row.error&&<p className="inboxWarning">{row.error}</p>}{row.status==="open"&&<button className="ghostButton" disabled={busy} onClick={()=>void perform(()=>request(`/outreach/${row.id}/close`,{}))}>关闭协作请求</button>}</article>)}
  </section>;
}
