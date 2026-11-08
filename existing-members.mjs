import {createHash} from 'node:crypto';
import {resolve, join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {createRequire} from 'node:module';
import {sdkDir} from './paths.mjs';
const require = createRequire(join(sdkDir, 'package.json'));
const {foldSubagentDescriptor} = await import(require.resolve('@deepseek-ai/dsh-subagent'));
export const MEMBERS_PATH = '/plugins/local-model-switch/members';
export const MEMBERS_BATCH_PATH = `${MEMBERS_PATH}/batch`;
class MemberFault extends Error {constructor(message,status=400){super(message);this.status=status;}}
const fault=(text,status)=>new MemberFault(text,status);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same=(a,b)=>a?.provider===b?.provider&&a?.model===b?.model&&(a?.reasoningEffort??'')===(b?.reasoningEffort??'');
const copyRoute=r=>({provider:r.provider,model:r.model,...r.reasoningEffort?{reasoningEffort:r.reasoningEffort}:{}});
export function selectedRoute(member) {
  const manual=member.manualModelSelection;
  if(manual!==undefined){
    if(manual.version!==1||!Number.isSafeInteger(manual.selectedAt)||manual.selectedAt<0||!manual.selection||typeof manual.selection.provider!=='string'||!manual.selection.provider.trim()||typeof manual.selection.model!=='string'||!manual.selection.model.trim()||(manual.selection.reasoningEffort!==undefined&&(typeof manual.selection.reasoningEffort!=='string'||!manual.selection.reasoningEffort.trim())))throw fault('成员保存的手动模型记录无效',409);
    return copyRoute(manual.selection);
  }
  const r={provider:member.activeProvider??member.provider,model:member.activeModel??member.model};
  if(member.fallbackActive!==true&&member.reasoningEffort)r.reasoningEffort=member.reasoningEffort;
  return r;
}
export function memberRevision(team,member) {
  return hash({team:team.id,captain:team.captainSessionId,createdAt:team.createdAt,id:member.id,name:member.name,joinedAt:member.joinedAt,
    base:[member.provider,member.model,member.reasoningEffort],active:[member.activeProvider,member.activeModel,member.fallbackActive],manual:member.manualModelSelection});
}
const providedApis = new WeakMap();
function moduleAPI(ctx) {
  const provided=providedApis.get(ctx);
  if(provided?.version===1)return {mod:provided,stateDir:provided.stateDir};
  const entry=ctx.configEditor.entries().find(e=>e.options.id==='agent-teams');
  const service=ctx.get?.('agentTeamsExistingModelAPI');
  if(service?.version===1&&service.ownerFiberUid===entry?.fiber?.uid&&service.active())return {mod:service,stateDir:entry.fiber.effectiveConfig.stateDir??'.agent-teams'};
  const mod=entry?.moduleNamespace;
  if(entry?.fiber?.state!==2)throw fault('当前团队插件未启动',409);
  if(!mod)throw fault('团队模块命名空间不可用',409);
  if(mod.EXISTING_MEMBER_MODEL_SWITCH_VERSION!==1)throw fault('已有成员切换适配版本尚未加载；本次未修改成员',409);
  if(mod.apply!==entry.fiber.runtime.callback)throw fault('团队模块加载代次不一致；本次未修改成员',409);
  if(!mod.readTeam||!mod.writeTeam||!mod.withTeamLock||!mod.collectTeamsActivity)throw fault('团队适配器共享状态接口未就绪',409);
  return {mod,stateDir:entry.fiber.effectiveConfig.stateDir??'.agent-teams'};
}
export function memberView(ctx,team,member,workspace) {
  let agent=ctx.agents.get(member.id);
  let unsafe=false;
  if(agent){try{verifyLineage(agent.session.header,agent.session.snapshotEvents(),agent.session.inheritedEventCount,team,member,workspace??agent.session.header.cwd);}catch{agent=undefined;unsafe=true;}}
  const next=agent?.model?.current();
  const used=agent?.session.requestHeader()?.config;
  return {id:member.id,name:member.name,role:member.role??'',status:member.status,
    activity:unsafe?'identity-conflict':(agent?.status??'cold'),unsafe,revision:memberRevision(team,member),selected:selectedRoute(member),
    ...(next?{liveNext:copyRoute(next)}:{}),...(used?{lastUsed:copyRoute(used)}:{}),
    creationRoute:{provider:member.provider,model:member.model},cold:agent===undefined};
}
async function locations(ctx) {
  const {mod,stateDir}=moduleAPI(ctx);
  const entries=[];
  for(const w of ctx.workspaceRegistry.list()) {
    const root=join(w.path,stateDir);
    // Official collector; omit workspacePath so selecting routes does not audit repository bytes.
    for(const snapshot of await mod.collectTeamsActivity(ctx,[{workspace:w.title,stateRoot:root}])) {
      if(snapshot.phase==='staged')continue;
      const team=await mod.readTeam(root,snapshot.teamId);
      if(!team||team.phase==='staged')continue;
      entries.push({key:hash([w.path,team.id,team.captainSessionId,team.createdAt]),workspace:w.title,path:w.path,root,team,mod});
    }
  }
  return entries;
}
export async function listExistingMembers(ctx) {
  try {
    const teams=(await locations(ctx)).map(loc=>({key:loc.key,name:loc.team.name,workspace:loc.workspace,captainSessionId:loc.team.captainSessionId,teamId:loc.team.id,
      members:loc.team.members.filter(m=>m.id&&m.status!=='removed').map(m=>memberView(ctx,loc.team,m,loc.path))})).filter(t=>t.members.length);
    return {available:true,teams};
  }catch(error){return {available:false,teams:[],reason:error instanceof MemberFault?error.message:'无法加载已有成员，请刷新或检查插件'};}
}
export function verifyLineage(header,events,inherited,team,member,workspace,fold=foldSubagentDescriptor) {
  if(header.id!==member.id||header.parentSession!==team.captainSessionId||!header.cwd||resolve(header.cwd)!==resolve(workspace))throw fault('成员会话身份 / 工作区不匹配',409);
  if(!Number.isSafeInteger(inherited)||inherited<0||inherited>events.length)throw fault('成员继承历史边界不明确',409);
  const d=fold(events.slice(inherited));
  if(d?.mode!=='continuable'||d.label!==`agent-teams:${team.id}:${member.name}`||d.agentProvider!==member.provider||d.agentModel!==member.model)throw fault('成员创建描述与团队记录不匹配，拒绝接管',409);
  return d;
}
export function recordedRoute(events,descriptor) {
  let pending,last;
  for(const e of events) {
    if(e.type==='model/selection')pending=copyRoute(e.data);
    else if(e.type==='request/header'){
      const header=e.data?.header;
      if(!header?.config?.provider||!header.config.model)continue;
      last=copyRoute({...header.config,...header.adapterDefaults?.reasoningEffort===true?{reasoningEffort:undefined}:{}});
      if(pending&&same(pending,last))pending=undefined;
    }
  }
  return pending??last??{provider:descriptor.agentProvider,model:descriptor.agentModel,...descriptor.agentReasoningEffort?{reasoningEffort:descriptor.agentReasoningEffort}:{}};
}
const ROUTE_FIELDS=['activeProvider','activeModel','fallbackActive','manualModelSelection'];
function savedFields(member){return Object.fromEntries(ROUTE_FIELDS.filter(k=>Object.hasOwn(member,k)).map(k=>[k,structuredClone(member[k])]));}
function restoreFields(member,old){for(const key of ROUTE_FIELDS)delete member[key];Object.assign(member,old);}
function installSavedRoute(member,selection){
  member.activeProvider=selection.provider;member.activeModel=selection.model;member.fallbackActive=false;
  // Keep immutable creation route, original effort, fallback and runtime tool/persona context untouched.
  member.manualModelSelection={version:1,selection:copyRoute(selection),selectedAt:Date.now()};
}
function writable(team,member) {
  if(team.phase==='staged'||member.status==='removed'||!member.id||member.stopping===true||team.tasks.some(t=>t.reassigning===true&&t.assignee===member.name))throw fault('成员未启动、已移除或正在移交；请刷新后再试',409);
}
export async function commitExistingSelection(ctx,loc,team,member,selection) {
  const agent=ctx.agents.get(member.id);
  const live=agent?.session??ctx.sessions.get(member.id);
  const old=savedFields(member);
  if(live&&!agent)throw fault('成员会话正在初始化或转移写入所有权，请稍后刷新',409);
  const assertResident=()=>{if(live&&(ctx.agents.get(member.id)!==agent||ctx.sessions.get(member.id)!==live||agent.session!==live))throw fault('成员运行实例 / 会话所有权已变化，请刷新',409);};
  let teamWritten=false,sessionWritten=false,seq;
  const mutate=async (session,handle,events,inherited,descriptor) => {
    const before=agent?.model.current()??recordedRoute(events,descriptor);
    const noChange=member.manualModelSelection!==undefined&&same(selectedRoute(member),selection)&&same(before,selection);
    if(!noChange) {
      installSavedRoute(member,selection);
      await loc.mod.writeTeam(loc.root,team);teamWritten=true;
    }
    if(session) {
      assertResident();
      if(!noChange) {
        try {if(agent)agent.model.select(selection);else session.append('model/selection',selection);sessionWritten=true;}
        catch(error) {sessionWritten=same(agent?.model.current()??recordedRoute(session.snapshotEvents(),descriptor),selection);throw error;}
      }
      const tail=session.snapshotEvents().at(-1);seq=tail?.seq;
      if(!await ctx.sessions.flush(session))throw fault('成员会话的模型选择未确认落盘',503);
      const check=await ctx.sessionPersistence.open(member.id,'read');
      try {
        const stored=await check.read(tail?.seq??0,1);
        if(check.header.id!==session.header.id||check.header.createdAt!==session.header.createdAt||!isDeepStrictEqual(stored.events[0],tail))throw fault('成员模型日志持久化核验失败',503);
      } finally {await check.close();}
      assertResident();
      if(agent&&!same(agent.model.current(),selection))throw fault('成员执行端模型选择已被其它入口改变',409);
    } else {
      if(!noChange) {
        seq=events.length;
        try {await handle.append([{type:'model/selection',seq,time:Date.now(),data:copyRoute(selection)}]);sessionWritten=true;}
        catch(error) {try{const tail=await handle.read(seq,1);sessionWritten=tail.events[0]?.type==='model/selection'&&same(tail.events[0].data,selection);}catch{}throw error;}
      }
      await handle.flush();
      const fresh=await handle.read();
      if(!same(recordedRoute(fresh.events,descriptor),selection))throw fault('冷成员模型日志核验失败',503);
    }
    return {applied:true,noChange,member:memberView(ctx,team,member,loc.path),effective:agent?'futureSteps':'nextActivation',selectionSeq:seq};
  };
  try {
    if(live) {
      if(agent&&agent.session!==live)throw fault('成员运行会话已变化',409);
      const run=async ()=>{
        const events=live.snapshotEvents();const descriptor=verifyLineage(live.header,events,live.inheritedEventCount,team,member,loc.path);
        return mutate(live,undefined,events,live.inheritedEventCount,descriptor);
      };
      if(agent?.status==='idle'&&typeof agent.runMaintenance==='function')return await agent.runMaintenance(run);
      return await run();
    }
    // Acquire the native single writer; never call resume/followup/sendMessage or steal ownership.
    const handle=await ctx.sessionPersistence.open(member.id,'write');
    try {
      const {events}=await handle.read();const descriptor=verifyLineage(handle.header,events,handle.inheritedEventCount,team,member,loc.path);
      return await mutate(undefined,handle,events,handle.inheritedEventCount,descriptor);
    } finally {await handle.close();}
  } catch(error) {
    if(teamWritten&&!sessionWritten) {
      restoreFields(member,old);
      try {await loc.mod.writeTeam(loc.root,team);teamWritten=false;}catch{}
    }
    if(teamWritten||sessionWritten) {
      // Two different durable owners are not a transaction; never pretend rollback of a
      // captured step or failed disk barrier is complete. Keep selected route for recovery.
      return {applied:false,partial:true,error:'模型同步 / 持久化未全部确认；请刷新核对，不会自动重试任务',teamRouteSaved:teamWritten,sessionSelectionRecorded:sessionWritten,member:memberView(ctx,team,member,loc.path),effective:agent?'futureSteps':'nextActivation'};
    }
    if(error instanceof MemberFault)throw error;
    throw fault('会话由其它写入端占用，或目前无法安全写入；本次未切换',409);
  }
}
export async function changeExistingMember(ctx,payload) {
  const known=new Set(['teamKey','memberId','provider','model','reasoningEffort','revision']);
  if(Object.keys(payload).some(k=>!known.has(k)))throw fault('不支持的成员切换参数');
  for(const k of ['teamKey','memberId','provider','model','revision'])if(typeof payload[k]!=='string'||!payload[k]||payload[k].length>512)throw fault('请选择完整的团队、成员和模型');
  const selection={provider:payload.provider,model:payload.model};
  if(payload.reasoningEffort!==undefined){if(typeof payload.reasoningEffort!=='string'||!payload.reasoningEffort||payload.reasoningEffort.length>128)throw fault('推理档位无效');selection.reasoningEffort=payload.reasoningEffort;}
  if(!ctx.llm.listProviders().some(p=>p.id===selection.provider))throw fault('所选渠道未加载');
  if(!(await ctx.llm.listModels(selection.provider)).some(m=>m.id===selection.model))throw fault('所选模型不在渠道目录中');
  try{await ctx.llm.resolveCallConfig(selection);}catch{throw fault('模型路由或凭据不可用；未发送真实模型请求');}
  const loc=(await locations(ctx)).find(l=>l.key===payload.teamKey);
  if(!loc)throw fault('团队已归档或身份已变化，请刷新',409);
  return loc.mod.withTeamLock(`team:${loc.root}:${loc.team.id}`,async ()=>{
    const team=await loc.mod.readTeam(loc.root,loc.team.id);
    if(!team||team.captainSessionId!==loc.team.captainSessionId||team.createdAt!==loc.team.createdAt)throw fault('团队代次已变化',409);
    const member=team.members.find(m=>m.id===payload.memberId);
    if(!member)throw fault('该成员已不属于这个团队',409);
    writable(team,member);
    if(memberRevision(team,member)!==payload.revision)throw fault('成员模型已在其它入口改变，请刷新后再试',409);
    return commitExistingSelection(ctx,loc,team,member,selection);
  });
}
const plainObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
function batchObject(value,keys,message) {
  if(!plainObject(value)||Reflect.ownKeys(value).some(key=>typeof key!=='string'||!keys.includes(key)))throw fault(message);
}
function batchText(value,message,max=512) {if(typeof value!=='string'||!value.trim()||value.length>max)throw fault(message);}
export async function changeExistingMembersBatch(ctx,payload) {
  batchObject(payload,['teamKey','provider','model','reasoningEffort','members'],'不支持的批量成员切换参数');
  for(const key of ['teamKey','provider','model']){if(!Object.hasOwn(payload,key))throw fault('请选择完整的团队和模型');batchText(payload[key],'请选择完整的团队和模型');}
  if(!Array.isArray(payload.members)||payload.members.length<1||payload.members.length>128)throw fault('批量成员数量必须为 1–128');
  const ids=new Set();
  const targets=payload.members.map(target=>{
    batchObject(target,['memberId','revision'],'批量成员目标格式无效');
    for(const key of ['memberId','revision']){if(!Object.hasOwn(target,key))throw fault('批量成员目标缺少身份或版本');batchText(target[key],'批量成员目标缺少身份或版本');}
    if(ids.has(target.memberId))throw fault('批量目标包含重复成员');ids.add(target.memberId);
    return {memberId:target.memberId,revision:target.revision};
  });
  const teamKey=payload.teamKey;
  const selection={provider:payload.provider,model:payload.model};
  if(Object.hasOwn(payload,'reasoningEffort')){batchText(payload.reasoningEffort,'推理档位无效',128);selection.reasoningEffort=payload.reasoningEffort;}
  // Metadata and credential resolution only, exactly once for the entire batch.
  try {
    if(!ctx.llm.listProviders().some(provider=>provider.id===selection.provider))throw fault('所选渠道未加载');
    if(!(await ctx.llm.listModels(selection.provider)).some(model=>model.id===selection.model))throw fault('所选模型不在渠道目录中');
    await ctx.llm.resolveCallConfig(selection);
  }catch(error){if(error instanceof MemberFault)throw error;throw fault('模型路由或凭据不可用；未发送真实模型请求');}
  const loc=(await locations(ctx)).find(location=>location.key===teamKey);
  if(!loc)throw fault('团队已归档或身份已变化，请刷新',409);
  return loc.mod.withTeamLock(`team:${loc.root}:${loc.team.id}`,async()=>{
    const team=await loc.mod.readTeam(loc.root,loc.team.id);
    if(!team||team.id!==loc.team.id||team.captainSessionId!==loc.team.captainSessionId||team.createdAt!==loc.team.createdAt)throw fault('团队代次已变化',409);
    const roster=team.members.filter(member=>member.id&&member.status!=='removed');
    const byId=new Map(roster.map(member=>[member.id,member]));
    if(roster.length!==targets.length||byId.size!==roster.length||targets.some(target=>!byId.has(target.memberId)))throw fault('已启动成员完整名单已变化，请刷新后重新选择全部成员',409);
    // Every deterministic state/revision fence completes before the first write.
    const members=targets.map(target=>{
      const member=byId.get(target.memberId);writable(team,member);
      if(memberRevision(team,member)!==target.revision)throw fault('成员模型版本已变化，请刷新后重新选择全部成员',409);
      return member;
    });
    const results=[];
    for(const member of members){
      try {
        const result=await commitExistingSelection(ctx,loc,team,member,selection);
        const row={memberId:member.id,memberName:member.name,applied:result.applied===true};
        for(const key of ['noChange','partial','error','member','effective'])if(Object.hasOwn(result,key))row[key]=result[key];
        results.push(row);
      }catch(error){results.push({memberId:member.id,memberName:member.name,applied:false,error:error instanceof MemberFault?error.message:'成员切换失败，请刷新核对（未回显渠道凭据）'});}
    }
    const summary={succeeded:results.filter(result=>result.applied).length,failed:results.filter(result=>!result.applied).length,
      partial:results.filter(result=>result.partial===true).length,noChange:results.filter(result=>result.applied&&result.noChange===true).length};
    return {teamKey,applied:summary.succeeded===targets.length,
      partial:summary.partial>0||(summary.succeeded>0&&summary.failed>0),requested:targets.length,results,summary};
  });
}
export function installMembersEndpoint(ctx, providedApi, options={}) {
  batchObject(options,['batchOnly','singleOnly'],'成员接口注册选项无效');
  for(const key of ['batchOnly','singleOnly'])if(Object.hasOwn(options,key)&&typeof options[key]!=='boolean')throw fault('成员接口注册选项无效');
  if(options.batchOnly&&options.singleOnly)throw fault('成员接口不能同时仅注册单成员和批量路由');
  // Only the HTTP owner and authentication service gate registration. Optional
  // work services are resolved per request, with explicit 503 rather than 404.
  ctx.inject(['webServer','connection'],scoped=>{
    const resolveContext=method=>{
      const lookup=(...keys)=>{for(const key of keys){const value=scoped.get(key);if(value!==undefined)return value;}};
      const requestCtx={get:scoped.get.bind(scoped)};
      const services={agents:lookup('agents'),sessions:lookup('sessions','session'),
        sessionPersistence:lookup('sessionPersistence'),workspaceRegistry:lookup('workspaceRegistry','workspace'),
        subagents:lookup('subagents'),llm:lookup('llm'),configEditor:lookup('configEditor')};
      const required=method==='POST'?['agents','sessions','sessionPersistence','workspaceRegistry','subagents','llm']:['agents','workspaceRegistry','subagents'];
      const methods={agents:['get'],workspaceRegistry:['list'],sessions:['get','flush'],sessionPersistence:['open'],llm:['listProviders','listModels','resolveCallConfig']};
      const missing=required.filter(key=>services[key]===undefined||methods[key]?.some(method=>typeof services[key][method]!=='function'));
      if(missing.length)throw fault(`成员接口依赖尚未就绪：${missing.join(', ')}`,503);
      Object.assign(requestCtx,services);
      if(providedApi)providedApis.set(requestCtx,providedApi);
      else if(!requestCtx.configEditor)throw fault('成员配置接口尚未就绪',503);
      return requestCtx;
    };
    const register=(path,batch)=>scoped.effect(()=>scoped.webServer.register({kind:'exact',path,async handler(req,res){
      const reply=(status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));};
      try {
        const denied=scoped.connection.requestRejection(req);if(denied!==undefined)return reply(denied,{error:'访问未授权'});
        if(!batch&&req.method==='GET')return reply(200,await listExistingMembers(resolveContext('GET')));
        if(req.method!=='POST')return reply(405,{error:batch?'只支持 POST':'只支持 GET / POST'});
        let origin;try{origin=new URL(req.headers.origin??'');}catch{throw fault('拒绝无 Origin 的写请求',403);}
        if(!['http:','https:'].includes(origin.protocol)||origin.host!==req.headers.host||origin.pathname!=='/'||origin.search||origin.hash||req.headers['sec-fetch-site']==='cross-site')throw fault('拒绝跨站写请求',403);
        if(!String(req.headers['content-type']??'').startsWith('application/json'))throw fault('需要 application/json',415);
        const requestCtx=resolveContext('POST');
        let size=0;const chunks=[];for await(const part of req){size+=Buffer.byteLength(part);if(size>(batch?65536:8192))throw fault('请求过大',413);chunks.push(Buffer.from(part));}
        let payload;try{payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!payload||typeof payload!=='object'||Array.isArray(payload))throw 0;}catch{throw fault('请求 JSON 无效');}
        return reply(200,await (batch?changeExistingMembersBatch:changeExistingMember)(requestCtx,payload));
      }catch(error){const status=error instanceof MemberFault?error.status:500;reply(status,{error:status===500?'成员切换失败，请刷新核对（未回显渠道凭据）':error.message});}
    }}),batch?'web-model-switch: existing member batch route':'web-model-switch: existing member route');
    // Register single last to preserve legacy fixtures/callers that retain the
    // singular handler; runtime routes are exact and have separate ownership.
    if(!options.singleOnly)register(MEMBERS_BATCH_PATH,true);
    if(!options.batchOnly)register(MEMBERS_PATH,false);
  });
}
