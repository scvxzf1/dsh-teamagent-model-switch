import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {sdkDir} from './paths.mjs';
import {Readable} from 'node:stream';
import {installMembersEndpoint} from './existing-members.mjs';
import {recoverFutureManualSelection, installFutureManualSetup, stateDirFor} from './members-plugin.mjs';
const require=createRequire(join(sdkDir,'package.json'));
const {AgentModel,modelSelectionProjectionDefinition:projection}=await import(require.resolve('@deepseek-ai/dsh-agent'));
const {snapshotSubagentDescriptor}=await import(require.resolve('@deepseek-ai/dsh-subagent'));
const A={provider:'a',model:'old',reasoningEffort:'high'},B={provider:'b',model:'new'};

function endpointFixture() {
  let handler;const dependencies=[];const services={agents:{get(){}},workspace:{list:()=>[]},subagents:{}};
  const api={version:1,stateDir:'.agent-teams',collectTeamsActivity:async()=>[],readTeam:async()=>{},writeTeam:async()=>{throw Error('must not mutate');},withTeamLock:async()=>{throw Error('must not mutate');}};
  const scoped={get:key=>services[key],webServer:{register:route=>{handler=route.handler;return ()=>{};}},connection:{requestRejection:()=>undefined},effect:fn=>fn()};
  const ctx={inject:(keys,fn)=>{dependencies.push(keys);fn(scoped);}};
  installMembersEndpoint(ctx,api);
  async function request(method='GET',headers={}) {
    const req=Readable.from(['{}']);req.method=method;req.headers={host:'localhost:10980',origin:'http://localhost:10980','content-type':'application/json',...headers};
    const res={writeHead(status){this.status=status;},end(body){this.body=JSON.parse(body);}};
    await handler(req,res);return res;
  }
  return {services,scoped,dependencies,request};
}
test('fresh HTTP registration gates only on webServer+connection; GET works without configEditor/LLM/persistence',async()=>{
  const f=endpointFixture();assert.deepEqual(f.dependencies,[['webServer','connection']]);
  const result=await f.request();assert.equal(result.status,200);assert.deepEqual(result.body,{available:true,teams:[]});
});
test('request-time alias resolution and missing dependencies produce explicit 503, never absent route',async()=>{
  const f=endpointFixture();delete f.services.workspace;
  let result=await f.request();assert.equal(result.status,503);assert.match(result.body.error,/workspaceRegistry/);
  f.services.workspaceRegistry={list:()=>[]};assert.equal((await f.request()).status,200);
  result=await f.request('POST');assert.equal(result.status,503);assert.match(result.body.error,/sessionPersistence/);
});
test('authentication and Origin fences precede optional service checks',async()=>{
  const f=endpointFixture();f.scoped.connection.requestRejection=()=>401;
  assert.equal((await f.request('POST')).status,401);
  f.scoped.connection.requestRejection=()=>undefined;
  assert.equal((await f.request('POST',{origin:''})).status,403);
  assert.equal((await f.request('POST',{origin:'http://evil.invalid'})).status,403);
});

function childFixture() {
  const member={id:'child',name:'worker',status:'idle',...A,joinedAt:1,runtimeSetup:{persona:'preserved'},manualModelSelection:{version:1,selection:B,selectedAt:100}};
  const team={id:'t1',captainSessionId:'captain',members:[member],tasks:[{id:'task',attemptId:'keep',status:'in_progress'}]};
  const descriptor=snapshotSubagentDescriptor({mode:'continuable',provider:'spawn',label:'agent-teams:t1:worker',agentProvider:A.provider,agentModel:A.model,agentReasoningEffort:A.reasoningEffort});
  const events=[{type:'subagent/descriptor',seq:0,time:10,data:descriptor},{type:'request/header',seq:1,time:11,data:{header:{config:A}}}];
  let state=projection.init();for(const event of events)state=projection.apply(state,event);
  const session={header:{id:'child',parentSession:'captain',cwd:'/virtual'},ownEvents:()=>structuredClone(events),append(type,data){const event={type,seq:events.length,time:101,data:structuredClone(data)};events.push(event);state=projection.apply(state,event);}};
  const child={id:'child',session,model:new AgentModel(()=>state,session,A)};
  const saved=()=>team;
  return {child,team,member,events,saved};
}
test('future unpublished-child setup recovers manual intent via real kernel without changing base/tasks/setup',()=>{
  const f=childFixture(),before=structuredClone(f.team);
  assert.equal(recoverFutureManualSelection(f.child,'.agent-teams',f.saved),true);
  assert.deepEqual(f.child.model.current(),B);assert.deepEqual(f.team,before);
  assert.equal(recoverFutureManualSelection(f.child,'.agent-teams',f.saved),false);
});
test('future setup preserves newer or same-timestamp conflicting genuine selection',()=>{
  for(const time of [100,101]){
    const f=childFixture();f.child.session.append('model/selection',A);f.events.at(-1).time=time;const count=f.events.length;
    assert.throws(()=>recoverFutureManualSelection(f.child,'.agent-teams',f.saved),/conflicts/);
    assert.equal(f.events.length,count);assert.deepEqual(f.child.model.current(),A);
  }
});
test('future setup validates exact descriptor/base/parent/id and blocks path traversal before state reads',()=>{
  const f=childFixture();f.events[0].data.label='agent-teams:../../private:worker';let reads=0;
  assert.throws(()=>recoverFutureManualSelection(f.child,'.agent-teams',()=>{reads++;return f.team;}),/descriptor key/);assert.equal(reads,0);
  const wrong=childFixture();wrong.team.members[0].provider='wrong';assert.throws(()=>recoverFutureManualSelection(wrong.child,'.agent-teams',wrong.saved));
  const effort=childFixture();effort.member.reasoningEffort='different';assert.throws(()=>recoverFutureManualSelection(effort.child,'.agent-teams',effort.saved),/effort mismatch/);
  const id=childFixture();id.child.session.header.id='other';assert.throws(()=>recoverFutureManualSelection(id.child,'.agent-teams',id.saved));
  const parent=childFixture();parent.child.session.header.parentSession='other';assert.equal(recoverFutureManualSelection(parent.child,'.agent-teams',parent.saved),false);
});
test('addon registration never touches existing residents; subsequent new object may recover same durable child id',()=>{
  const old=childFixture().child;let setup;const recovered=[];
  const ctx={agents:{list:()=>[old]},get:()=>undefined};
  installFutureManualSetup(ctx,(_ctx,fn)=>{setup=fn;fn({},old);fn({},{...old});},child=>recovered.push(child));
  assert.deepEqual(recovered,[]);setup({},old);assert.deepEqual(recovered,[]);
  const resumed={...old};setup({},resumed);assert.deepEqual(recovered,[resumed]);
});
test('state directory follows existing owner config with safe explicit fallback',()=>{
  assert.equal(stateDirFor({get:()=>undefined}),'.agent-teams');
  assert.equal(stateDirFor({get:()=>({entries:()=>[{options:{id:'agent-teams'},fiber:{effectiveConfig:{stateDir:'custom'}}}]})}),'custom');
});
