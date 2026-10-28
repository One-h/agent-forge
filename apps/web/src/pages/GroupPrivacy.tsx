import { useEffect,useState } from "react";
import { ShieldCheck,RefreshCw } from "lucide-react";
import "./personalInbox.css";
type Message={id:number;chatId:string;content:string;identity:string;category:string;status:string;draft:string;reason:string;error:string|null;version:number;operationJson:string|null;operationOutput:string|null};
type Snapshot={policy:{enabled?:boolean;companyRoots:string[];autoPublishGenerated:boolean;autoExecute:boolean;personalAccess:boolean};messages:Message[]};
const labels:Record<string,string>={pending:"等待隔离分析",reviewing:"隔离分析中",researching:"公司资料研究中",needs_owner:"等待你确认",executing:"单次操作执行中",operation_unknown:"请先核对操作结果",sending:"发送中",sent:"已确认发群",send_unknown:"请核对群消息",forwarded:"已批准转交来源 Agent",dismissed:"已手动关闭",ignored:"模型判断无需处理，已静默忽略"};
async function request<T>(route="",method="GET",body?:unknown):Promise<T>{const r=await fetch(`/api/group-privacy${route}`,{method,headers:{"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});const d=await r.json();if(!r.ok)throw new Error(d.error??"请求失败");return d;}
function Review({row,roots,busy,enabled,act}:{row:Message;roots:string[];busy:boolean;enabled:boolean;act:(id:number,body:Record<string,unknown>)=>void}){
 const [draft,setDraft]=useState(row.draft),[root,setRoot]=useState(0),[argv,setArgv]=useState('[]'),[query,setQuery]=useState('');
 useEffect(()=>setDraft(row.draft),[row.draft]);
 const editable=row.status==="needs_owner";
 return <article className="personalInboxMessage"><div className="personalInboxMessageHeader"><strong>群请求 #{row.id}</strong><span className="inboxState">{labels[row.status]??row.status}</span></div><p className="subtle">{row.chatId} · {row.identity==="user"?"以你本人身份回复":"以龙小祝身份回复"} · {row.category}</p>
  <p className="personalInboxContent">{row.content}</p><p>{row.reason}</p>{row.error&&<p className="inboxWarning">{row.error}</p>}
  {row.operationJson&&<p className="personalInboxContent">批准的操作：{row.operationJson}</p>}{row.operationOutput&&<pre className="personalInboxContent">{row.operationOutput}</pre>}
  {editable&&enabled&&<><label className="inboxDraftLabel">审核后的群回复<textarea rows={4} value={draft} onChange={event=>setDraft(event.target.value)} maxLength={4000}/></label>
   <label className="inboxDraftLabel">公司资料检索词（可选）<input value={query} maxLength={120} onChange={event=>setQuery(event.target.value)} placeholder="例如：接口鉴权、订单流程"/></label>
   <div className="actionGroup"><button disabled={busy||!draft.trim()} onClick={()=>act(row.id,{action:"publish",text:draft,version:row.version})}>确认这段文本并发回原群</button><button className="ghostButton" disabled={busy||!roots.length||row.category==="personal"} onClick={()=>act(row.id,{action:"research",query,version:row.version})}>仅研究公司资料</button><button className="ghostButton" disabled={busy||row.category==="personal"} onClick={()=>act(row.id,{action:"forward",version:row.version})}>批准将原消息转交来源 Agent</button></div>
   <p className="subtle">转交将使用来源 Agent 已有的会话上下文与权限；不代表批准新的个人事项，后续发群仍需单独审核。</p>
   {row.category!=="personal"&&<details><summary>批准单次公司操作</summary><p className="subtle">仅允许下列公司目录，个人文件、凭据、其他会话和网络均不可访问。结果只在这里展示，不自动发群。</p><label>公司目录 <select value={root} onChange={event=>setRoot(Number(event.target.value))}>{roots.map((path,index)=><option key={path} value={index}>{path}</option>)}</select></label><label className="inboxDraftLabel">准确的命令参数 JSON 数组<textarea rows={2} value={argv} onChange={event=>setArgv(event.target.value)} placeholder={'["git","status"]'}/></label><button disabled={busy||!roots.length} onClick={()=>{try{act(row.id,{action:"execute",root,argv:JSON.parse(argv),version:row.version});}catch{window.alert("请填写有效的 JSON 命令参数数组。");}}}>批准并执行上述单次操作</button></details>}</>}
  {["needs_owner","operation_unknown"].includes(row.status)&&<button className="ghostButton" disabled={busy} onClick={()=>act(row.id,{action:"dismiss",version:row.version})}>关闭此请求</button>}
 </article>;
}
export function GroupPrivacyPage(){
 const [data,setData]=useState<Snapshot|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false),[roots,setRoots]=useState(""),[all,setAll]=useState(false);
 const load=async()=>{const d=await request<Snapshot>();setData(d);return d;};
 useEffect(()=>{void load().then(d=>setRoots(d.policy.companyRoots.join("\n"))).catch(e=>setError(String(e)));const timer=setInterval(()=>{if(!document.hidden)void load().catch(e=>setError(String(e)));},5000);return()=>clearInterval(timer);},[]);
 const perform=async(action:()=>Promise<unknown>)=>{if(busy)return;setBusy(true);setError("");try{await action();await load();}catch(e){setError(String(e));}finally{setBusy(false);}};
 const visible=(data?.messages??[]).filter(row=>all||!["sent","dismissed","forwarded","ignored"].includes(row.status));
 return <section className="pageStack"><div className="heroBand"><div><p className="eyebrow">公司与个人资料隔离</p><h2><ShieldCheck size={23}/>群聊隐私审批</h2><p className="subtle">隐私保护默认关闭。开启后，群消息使用独立无个人工具的分析环境，群回复和操作先由你审核。关闭后恢复普通助手链路，工具执行审批不变。</p></div><button disabled={busy} onClick={()=>void perform(load)}><RefreshCw size={16}/>刷新</button></div>
  {error&&<p role="alert" className="inboxWarning">{error}</p>}
  <label><input type="checkbox" role="switch" checked={data?.policy.enabled===true} disabled={busy||typeof data?.policy.enabled!=="boolean"} onChange={event=>{const enabled=event.target.checked;void perform(async()=>{const saved=await request<Snapshot>("","PATCH",{enabled});if(saved.policy.enabled!==enabled)throw new Error("Lark Agent 未确认开关状态，请先更新服务。");});}}/>启用群聊隐私保护</label>
  {data&&typeof data.policy.enabled!=="boolean"&&<p role="alert">当前 Lark Agent 不支持隐私保护开关，请先更新服务。</p>}
  {data?.policy.enabled===true?<div className="personalInboxStatus"><span>个人文件与其他会话：禁止读取</span><span>群回复与操作：人工审核</span></div>:data?.policy.enabled===false?<p className="subtle">保护未开启。以下历史审核记录保留，不会自动执行或发送。</p>:<p className="subtle">隐私保护状态尚未确认。</p>}
  <details><summary>允许研究的公司目录</summary><label className="inboxDraftLabel">每行一个明确的公司目录<textarea rows={3} value={roots} onChange={event=>setRoots(event.target.value)}/></label><p className="subtle">目录必须真实存在，不能是个人目录或符号链接。查询排除凭据、会话、数据库和二进制资料；公司研究结果也不会自动发群。</p><button disabled={busy} onClick={()=>void perform(()=>request("","PATCH",{companyRoots:roots.split("\n").map(x=>x.trim()).filter(Boolean)}))}>保存公司范围</button></details>
  <label><input type="checkbox" checked={all} onChange={event=>setAll(event.target.checked)}/>显示已处理请求</label>
  {visible.map(row=><Review key={row.id} row={row} roots={data?.policy.companyRoots??[]} enabled={data?.policy.enabled===true} busy={busy} act={(id,body)=>void perform(()=>request(`/${id}/decision`,"POST",body))}/>)}
  {!visible.length&&<div className="emptyState">暂无待处理的隐私审核请求。</div>}
 </section>;
}
