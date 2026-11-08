import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {sdkDir} from './paths.mjs';
import {Readable} from 'node:stream';
import {changeExistingMembersBatch,listExistingMembers,memberRevision,installMembersEndpoint,MEMBERS_PATH,MEMBERS_BATCH_PATH} from './existing-members.mjs';
const require=createRequire(join(sdkDir,'package.json'));
const {AgentModel,modelSelectionProjectionDefinition:projection}=await import(require.resolve('@deepseek-ai/dsh-agent'));
const {snapshotSubagentDescriptor}=await import(require.resolve('@deepseek-ai/dsh-subagent'));
// Reuse the original RAM/native-shaped storage fixture verbatim, without editing
// or importing its tests or executing the patch script. Real AgentModel retained.
const source=await readFile(new URL('./test-members.mjs',import.meta.url),'utf8');
const fixtureSource=source.slice(source.indexOf('const A = Object.freeze('),source.indexOf('\nfunction unchangedFields('));
assert.ok(fixtureSource.includes('function fixture('));
const {fixture,A,B,WORKSPACE}=new Function('assert','AgentModel','projection','snapshotSubagentDescriptor','listExistingMembers','memberRevision',`${fixtureSource}\nreturn {fixture,A,B,WORKSPACE};`)(assert,AgentModel,projection,snapshotSubagentDescriptor,listExistingMembers,memberRevision);
const clone=value=>structuredClone(value);
function batchFixture(options=[{}, {cold:true}, {idle:true}]) {
  const parts=options.map(option=>fixture(option));
  const ids=parts.map((_,i)=>`batch-child-${i+1}`),names=parts.map((_,i)=>`batch-worker-${i+1}`);
  for(const [i,f] of parts.entries()) {
    f.session.header.id=ids[i];f.agent.id=ids[i];
    f.events[f.session.inheritedEventCount].data=snapshotSubagentDescriptor({mode:'continuable',provider:'spawn',label:`agent-teams:t1:${names[i]}`,agentProvider:A.provider,agentModel:A.model,agentReasoningEffort:A.reasoningEffort});
  }
  let stored={...parts[0].team(),members:parts.map((f,i)=>({...f.member(),id:ids[i],name:names[i]})),
    tasks:parts.flatMap((f,i)=>f.team().tasks.map(task=>({...task,id:`batch-task-${i+1}`,assignee:names[i]})))};
  const counters={writes:0,locks:0,depth:0,providers:0,models:0,credentials:0,completions:0},controls={beforeLockedRead:undefined,onWrite:undefined};
  let inLock=false;
  const apply=()=>{};
  const mod={apply,EXISTING_MEMBER_MODEL_SWITCH_VERSION:1,
    collectTeamsActivity:async(_ctx,roots)=>{assert.equal(roots[0].workspacePath,undefined);return [{teamId:'t1',phase:stored.phase}];},
    readTeam:async(_root,id)=>{if(inLock&&controls.beforeLockedRead){const operation=controls.beforeLockedRead;controls.beforeLockedRead=undefined;operation(stored);}return id==='t1'?clone(stored):undefined;},
    writeTeam:async(_root,team)=>{assert.equal(inLock,true,'all writes under original lock');stored=clone(team);counters.writes++;await controls.onWrite?.();},
    withTeamLock:async(key,operation)=>{assert.equal(key,`team:${WORKSPACE}/.agent-teams:t1`);assert.equal(counters.depth,0,'never nest the team lock');counters.locks++;counters.depth++;inLock=true;try{return await operation();}finally{inLock=false;counters.depth--;}}
  };
  const entry={options:{id:'agent-teams'},moduleNamespace:mod,fiber:{state:2,runtime:{callback:apply},effectiveConfig:{stateDir:'.agent-teams'}}};
  const ctx={configEditor:{entries:()=>[entry]},workspaceRegistry:parts[0].ctx.workspaceRegistry,subagents:{},
    agents:{get:id=>{const i=ids.indexOf(id);return i<0?undefined:parts[i].ctx.agents.get('child-1');}},
    sessions:{get:id=>{const i=ids.indexOf(id);return i<0?undefined:parts[i].ctx.sessions.get('child-1');},flush:session=>{const f=parts.find(f=>f.session===session);assert.ok(f);return f.ctx.sessions.flush(session);}},
    sessionPersistence:{open:async(id,access)=>{const f=parts[ids.indexOf(id)];assert.ok(f);const handle=await f.ctx.sessionPersistence.open('child-1',access);handle.id=id;return handle;}},
    llm:{listProviders:()=>{counters.providers++;return [{id:A.provider},{id:B.provider}];},listModels:async provider=>{counters.models++;return [{id:provider===A.provider?A.model:B.model}];},resolveCallConfig:async selection=>{counters.credentials++;return clone(selection);},stream(){counters.completions++;throw Error('real model calls forbidden');}}
  };
  const payload=async()=>{const catalog=await listExistingMembers(ctx);assert.equal(catalog.available,true);return {teamKey:catalog.teams[0].key,...B,members:catalog.teams[0].members.map(member=>({memberId:member.id,revision:member.revision}))};};
  return {ctx,mod,parts,ids,names,counters,controls,payload,team:()=>clone(stored),edit:fn=>fn(stored)};
}
function preserved(team){const out=clone(team);for(const member of out.members)for(const key of ['activeProvider','activeModel','fallbackActive','manualModelSelection'])delete member[key];return out;}
const countAppends=f=>f.parts.reduce((n,p)=>n+p.counters.append,0);
async function run(f,payload){return changeExistingMembersBatch(f.ctx,arguments.length>1?payload:await f.payload());}

test('all-started exact-roster batch switches live/cold/idle sequentially in one original lock',async()=>{
  const f=batchFixture(),before=f.team(),captured=f.parts.map(p=>clone(p.agent.model.current())),inbox=f.parts.map(p=>clone(p.agent.inbox));
  const result=await run(f);assert.equal(result.applied,true);assert.equal(result.partial,false);assert.equal(result.requested,3);
  assert.deepEqual(result.summary,{succeeded:3,failed:0,partial:0,noChange:0});assert.equal(f.counters.locks,1);assert.equal(f.counters.writes,3);
  assert.deepEqual([f.counters.providers,f.counters.models,f.counters.credentials,f.counters.completions],[1,1,1,0]);
  assert.deepEqual(preserved(f.team()),preserved(before));
  for(const [i,row] of result.results.entries()){
    assert.equal(row.memberId,f.ids[i]);assert.equal(row.memberName,f.names[i]);assert.equal(row.member.id,f.ids[i]);assert.equal(row.member.name,f.names[i]);assert.deepEqual(row.member.selected,B);
    assert.deepEqual(f.parts[i].agent.model.current(),B);assert.deepEqual(captured[i],A);assert.deepEqual(f.parts[i].session.requestHeader().config,A);assert.deepEqual(f.parts[i].agent.inbox,inbox[i]);
    assert.equal(f.parts[i].counters.wake+f.parts[i].counters.create+f.parts[i].counters.resume,0);
  }
  assert.deepEqual(result.results.map(row=>row.effective),['futureSteps','nextActivation','futureSteps']);assert.equal(f.parts[2].counters.maintenance,1);
});
test('same-route batch noChange still executes every original flush/readback barrier',async()=>{
  const f=batchFixture();await run(f);const appends=countAppends(f),writes=f.counters.writes;const second=await run(f);
  assert.equal(second.applied,true);assert.deepEqual(second.summary,{succeeded:3,failed:0,partial:0,noChange:3});assert.equal(countAppends(f),appends);assert.equal(f.counters.writes,writes);
  for(const row of second.results){assert.equal(row.noChange,true);assert.ok(row.member?.id);assert.ok(row.member?.selected);assert.ok(row.effective);}
  assert.equal(f.parts[0].counters.liveFlushes,2);assert.equal(f.parts[1].counters.coldFlushes,2);assert.equal(f.parts[2].counters.liveFlushes,2);
});
test('per-member foreign ownership failure continues to later targets, returning mixed status',async()=>{
  const f=batchFixture();f.parts[1].controls.owned=true;const result=await run(f);
  assert.deepEqual(result.summary,{succeeded:2,failed:1,partial:0,noChange:0});assert.equal(result.applied,false);assert.equal(result.partial,true);
  assert.deepEqual(result.results.map(row=>row.applied),[true,false,true]);assert.equal(f.counters.writes,2);assert.equal(f.counters.locks,1);assert.deepEqual(f.parts[2].agent.model.current(),B);
});
test('per-member lineage failure continues without writing the foreign member',async()=>{
  const f=batchFixture();f.parts[1].session.header.parentSession='foreign-captain';const result=await run(f);
  assert.deepEqual(result.results.map(row=>row.applied),[true,false,true]);assert.equal(result.partial,true);assert.equal(f.parts[1].counters.append,0);assert.equal(f.counters.writes,2);
});
test('mixed success, accepted-then-throw partial, and confirmed noChange are honestly summarized',async()=>{
  const f=batchFixture([{}, {}, {}]);await run(f);const payload=await f.payload();
  f.edit(team=>{delete team.members[0].manualModelSelection;delete team.members[0].activeProvider;delete team.members[0].activeModel;delete team.members[0].fallbackActive;});
  f.parts[0].session.append('model/selection',A);f.parts[0].controls.liveAppendThrowsAfterCommit=true;
  payload.members[0].revision=memberRevision(f.team(),f.team().members[0]);const result=await run(f,payload);
  assert.equal(result.applied,false);assert.equal(result.partial,true);assert.deepEqual(result.summary,{succeeded:2,failed:1,partial:1,noChange:2});
  assert.equal(result.results[0].partial,true);assert.deepEqual(result.results[0].member.selected,B);assert.deepEqual(f.parts[0].agent.model.current(),B);
});
test('repeated live and cold flush failures never become falsely successful noChange',async()=>{
  const f=batchFixture([{}, {cold:true}]);f.parts[0].controls.liveFlushFails=true;f.parts[1].controls.coldFlushFails=true;
  const first=await run(f);assert.equal(first.applied,false);assert.equal(first.partial,true);assert.deepEqual(first.summary,{succeeded:0,failed:2,partial:2,noChange:0});
  const appends=countAppends(f),writes=f.counters.writes;const second=await run(f);assert.equal(second.applied,false);assert.equal(second.summary.failed,2);assert.equal(second.summary.noChange,0);
  assert.equal(countAppends(f),appends);assert.equal(f.counters.writes,writes);assert.equal(f.parts[0].counters.liveFlushes,2);assert.equal(f.parts[1].counters.coldFlushes,2);
});
test('all ordinary failures without any success or persistence are not falsely partial',async()=>{
  const f=batchFixture([{cold:true},{cold:true}]);for(const part of f.parts)part.controls.owned=true;const result=await run(f);
  assert.equal(result.applied,false);assert.equal(result.partial,false);assert.deepEqual(result.summary,{succeeded:0,failed:2,partial:0,noChange:0});assert.equal(f.counters.writes,0);
});
for(const [label,mutate] of [
  ['last target stale revision',(_f,p)=>{p.members.at(-1).revision='stale';}],
  ['new started roster member',(f)=>{f.controls.beforeLockedRead=team=>team.members.push({...clone(team.members[0]),id:'new-child',name:'new-worker'});}],
  ['new removed roster member',(f)=>{f.controls.beforeLockedRead=team=>{team.members.at(-1).status='removed';};}],
  ['replaced roster identity',(f)=>{f.controls.beforeLockedRead=team=>{team.members.at(-1).id='replacement';};}],
  ['team generation',(f)=>{f.controls.beforeLockedRead=team=>{team.createdAt++;};}],
  ['captain generation',(f)=>{f.controls.beforeLockedRead=team=>{team.captainSessionId='replacement';};}],
  ['stopping last member',(f)=>{f.controls.beforeLockedRead=team=>{team.members.at(-1).stopping=true;};}],
  ['reassigning last member task',(f)=>{f.controls.beforeLockedRead=team=>{team.tasks.at(-1).reassigning=true;};}],
  ['staged team',(f)=>{f.controls.beforeLockedRead=team=>{team.phase='staged';};}],
  ['omitted full-roster target',(_f,p)=>{p.members.pop();}],
])test(`whole-batch ${label} is deterministic 409 before every write`,async()=>{
  const f=batchFixture(),payload=await f.payload();mutate(f,payload);await assert.rejects(run(f,payload),error=>error.status===409);
  assert.equal(f.counters.writes,0);assert.equal(countAppends(f),0);assert.equal(f.parts.reduce((n,p)=>n+p.counters.opens.length,0),0);
});
test('unspawned and previously removed rows are excluded from the exact all-started roster',async()=>{
  const f=batchFixture();f.edit(team=>{team.members.push({...clone(team.members[0]),id:'',name:'unspawned'},{...clone(team.members[0]),id:'removed',name:'removed',status:'removed'});});
  const before=f.team();const result=await run(f);assert.equal(result.requested,3);assert.equal(result.applied,true);assert.deepEqual(f.team().members.slice(3),before.members.slice(3));
});
test('request roster order may differ, but exact IDs and versions are never substituted',async()=>{
  const f=batchFixture(),payload=await f.payload();payload.members.reverse();const result=await run(f,payload);assert.deepEqual(result.results.map(row=>row.memberId),f.ids.toReversed());assert.equal(result.applied,true);
});
const invalidCases=[
  ['null payload',()=>null],['array payload',()=>[]],['primitive payload',()=>42],['foreign object prototype',p=>Object.assign(Object.create({bad:true}),p)],
  ['unknown root key',p=>({...p,unexpected:true})],['prototype root key',p=>JSON.parse(JSON.stringify(p).replace('{','{"__proto__":{},'))],
  ['missing teamKey',p=>{delete p.teamKey;return p;}],['numeric teamKey',p=>({...p,teamKey:1})],['blank provider',p=>({...p,provider:' \t'})],['object model',p=>({...p,model:{}})],
  ['null effort',p=>({...p,reasoningEffort:null})],['blank effort',p=>({...p,reasoningEffort:''})],['long effort',p=>({...p,reasoningEffort:'x'.repeat(129)})],
  ['empty target array',p=>({...p,members:[]})],['target array object',p=>({...p,members:{}})],['129 targets',p=>({...p,members:Array.from({length:129},(_,i)=>({memberId:`id${i}`,revision:'v'}))})],
  ['duplicate ID',p=>({...p,members:[p.members[0],p.members[0]]})],['null target',p=>({...p,members:[null]})],['array target',p=>({...p,members:[[]]})],
  ['unknown target key',p=>({...p,members:[{...p.members[0],provider:B.provider}]})],['missing revision',p=>({...p,members:[{memberId:p.members[0].memberId}]})],
  ['numeric revision',p=>({...p,members:[{memberId:p.members[0].memberId,revision:1}]})],['blank ID',p=>({...p,members:[{memberId:' ',revision:'v'}]})],['long ID',p=>({...p,members:[{memberId:'x'.repeat(513),revision:'v'}]})],
];
for(const [label,invalid] of invalidCases)test(`strict batch ${label} is rejected before metadata/writes`,async()=>{
  const f=batchFixture(),payload=invalid(await f.payload());await assert.rejects(run(f,payload),error=>error.status===400);assert.equal(f.counters.writes,0);assert.equal(countAppends(f),0);assert.equal(f.counters.credentials,0);
});
for(const method of ['listProviders','listModels','resolveCallConfig'])test(`foreign ${method} metadata/credential exception is sanitized and sends no model calls`,async()=>{
  const f=batchFixture(),payload=await f.payload();f.ctx.llm[method]=()=>{throw Object.assign(Error('SECRET-API-KEY'),{status:401});};
  await assert.rejects(run(f,payload),error=>error.status===400&&!error.message.includes('SECRET'));assert.equal(f.counters.writes,0);assert.equal(f.counters.completions,0);
});

function httpFixture(options){
  const f=batchFixture();const routes=new Map(),dependencies=[];
  const services={...f.ctx};
  const scoped={get:key=>services[key],connection:{requestRejection:()=>undefined},webServer:{register:route=>{routes.set(route.path,route.handler);return ()=>{};}},effect:fn=>fn()};
  installMembersEndpoint({inject:(keys,fn)=>{dependencies.push(keys);fn(scoped);}}, {...f.mod,version:1,stateDir:'.agent-teams'},options);
  async function request(path=MEMBERS_BATCH_PATH,method='POST',payload,headers={}){
    const body=typeof payload==='string'?payload:JSON.stringify(payload??await f.payload());const req=Readable.from([body]);req.method=method;req.headers={host:'localhost:10980',origin:'http://localhost:10980','content-type':'application/json',...headers};
    const res={writeHead(status){this.status=status;},end(text){this.body=JSON.parse(text);}};assert.ok(routes.has(path));await routes.get(path)(req,res);return res;
  }
  return {...f,routes,dependencies,services,scoped,request};
}
test('default installer registers exact single and batch routes, with legacy single last',async()=>{
  const f=httpFixture();assert.deepEqual([...f.routes.keys()],[MEMBERS_BATCH_PATH,MEMBERS_PATH]);assert.deepEqual(f.dependencies,[['webServer','connection']]);
  assert.equal((await f.request(MEMBERS_PATH,'GET')).status,200);assert.equal((await f.request()).body.applied,true);
});
test('batchOnly installer adds only batch route; it does not duplicate or own single/future setup',async()=>{
  const f=httpFixture({batchOnly:true});assert.deepEqual([...f.routes.keys()],[MEMBERS_BATCH_PATH]);assert.equal((await f.request()).body.requested,3);assert.equal(f.counters.locks,1);
});
test('singleOnly future member plugin and batchOnly addon own distinct routes',async()=>{
  const single=httpFixture({singleOnly:true}),batch=httpFixture({batchOnly:true});
  assert.deepEqual([...single.routes.keys()],[MEMBERS_PATH]);assert.deepEqual([...batch.routes.keys()],[MEMBERS_BATCH_PATH]);
  const owned=[...single.routes.keys(),...batch.routes.keys()];assert.equal(new Set(owned).size,owned.length);
  assert.equal((await single.request(MEMBERS_PATH,'GET')).status,200);assert.equal((await batch.request()).body.applied,true);
  const pluginSource=await readFile(new URL('./members-plugin.mjs',import.meta.url),'utf8');assert.match(pluginSource,/installMembersEndpoint\(ctx,api,\{singleOnly:true\}\)/);
});
test('explicit false route restrictions retain default dual ownership',()=>{
  const f=httpFixture({singleOnly:false,batchOnly:false});assert.deepEqual([...f.routes.keys()],[MEMBERS_BATCH_PATH,MEMBERS_PATH]);
});
for(const value of [null,[],{unknown:true},{batchOnly:'yes'},{singleOnly:'yes'},{singleOnly:null},{batchOnly:true,singleOnly:true}])test(`invalid route-selection option ${JSON.stringify(value)} is rejected`,()=>{
  assert.throws(()=>httpFixture(value),error=>error.status===400);
});
test('batch HTTP authentication and Origin fences precede writes/optional service reads',async()=>{
  const f=httpFixture({batchOnly:true});f.scoped.connection.requestRejection=()=>401;delete f.services.llm;
  assert.equal((await f.request()).status,401);f.scoped.connection.requestRejection=()=>undefined;
  for(const headers of [{origin:''},{origin:'http://evil.invalid'},{origin:'http://localhost:10980','sec-fetch-site':'cross-site'},{origin:'http://localhost:10980/x'}])assert.equal((await f.request(MEMBERS_BATCH_PATH,'POST',undefined,headers)).status,403);
  assert.equal(f.counters.writes,0);assert.equal(countAppends(f),0);
});
test('batch method 405 and optional dependency 503 remain explicit',async()=>{
  const f=httpFixture({batchOnly:true});for(const method of ['GET','PUT','DELETE','OPTIONS'])assert.equal((await f.request(MEMBERS_BATCH_PATH,method)).status,405);
  delete f.services.sessionPersistence;const response=await f.request();assert.equal(response.status,503);assert.match(response.body.error,/sessionPersistence/);assert.equal(f.counters.writes,0);
});
test('batch accepts >8192-byte valid <=65536-byte body while singular limit stays 8192',async()=>{
  const f=httpFixture({batchOnly:true});const payload=await f.payload();const padded=JSON.stringify(payload)+' '.repeat(9000);assert.equal((await f.request(MEMBERS_BATCH_PATH,'POST',padded)).body.applied,true);
  const single=httpFixture();assert.equal((await single.request(MEMBERS_PATH,'POST','{}'+' '.repeat(9000))).status,413);
});
test('batch body limit counts actual UTF8 bytes and rejects >65536 before writes',async()=>{
  const f=httpFixture({batchOnly:true});for(const body of ['{}'+' '.repeat(65535),JSON.stringify({padding:'字'.repeat(22000)})]){const r=await f.request(MEMBERS_BATCH_PATH,'POST',body);assert.equal(r.status,413);}
  assert.equal(f.counters.writes,0);assert.equal(countAppends(f),0);
});
test('batch content type, JSON, strict keys and stale roster use original error fences',async()=>{
  const f=httpFixture({batchOnly:true});assert.equal((await f.request(MEMBERS_BATCH_PATH,'POST',undefined,{'content-type':'text/plain'})).status,415);
  for(const body of ['null','[]','false','{bad',JSON.stringify({...await f.payload(),unexpected:1})])assert.equal((await f.request(MEMBERS_BATCH_PATH,'POST',body)).status,400);
  const stale=await f.payload();stale.members.at(-1).revision='old';assert.equal((await f.request(MEMBERS_BATCH_PATH,'POST',stale)).status,409);assert.equal(f.counters.writes,0);
});
