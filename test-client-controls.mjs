import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('./client.cjs',import.meta.url),'utf8');
function load(fetch=()=>{throw Error('Unexpected fetch');}) {
  const exports={};
  vm.runInNewContext(source,{exports,require(name){assert.equal(name,'react');return {createElement:(tag,props,...children)=>({tag,props,children}),useState:()=>{},useEffect:()=>{},useRef:()=>{}};},fetch,console});
  return exports;
}
const ui=load(),clean=value=>JSON.parse(JSON.stringify(value));
const route={provider:'channel',model:'model',reasoningEffort:'high'};
const values={current:{...route},newSession:{...route},members:{provider:'channel',model:'model',reasoningEffort:'low'}};
const member=(id,overrides={})=>({id,name:'name-'+id,revision:'rev-'+id,selected:{...route},...overrides});
const team=()=>({key:'opaque-team-key',name:'Team',members:[member('a'),member('b')]});
const request=()=>ui.captureMemberRequest(team(),'all','',route);
const result=(wanted,overrides={})=>({teamKey:wanted.teamKey,requested:wanted.requested,applied:true,partial:false,
  results:wanted.members.map(target=>({memberId:target.memberId,memberName:target.memberName,applied:true,member:{id:target.memberId,selected:{...route}},effective:'futureSteps'})),
  summary:{succeeded:wanted.requested,failed:0,partial:0,noChange:0},...overrides});

test('main Apply is neutral when all selected scopes match; future default ignores effort',()=>{
  const state=ui.mainApplyState(route,{current:true,newSession:true,members:true},values);
  assert.equal(state.needed,false);assert.equal(state.unchanged,true);assert.deepEqual(clean(state.changes),[]);
});
test('current and ordinary default compare provider, model AND effort',()=>{
  for(const key of ['current','newSession']){
    const state=ui.mainApplyState(route,{[key]:true},{...values,[key]:{...route,reasoningEffort:'low'}});
    assert.equal(state.needed,true);assert.ok(state.changes.includes(key));
  }
});
test('future-member DEFAULT effort-only edit does not enable main Apply',()=>{
  assert.equal(ui.mainApplyState({...route,reasoningEffort:'max'},{members:true},values).needed,false);
  assert.equal(ui.mainApplyState({...route,model:'another'},{members:true},values).needed,true);
});
test('unselected scopes do not enable main Apply, and no selected target stays disabled',()=>{
  assert.equal(ui.mainApplyState(route,{members:true},{...values,current:null,newSession:null}).needed,false);
  const empty=ui.mainApplyState(route,{},values,true);assert.equal(empty.selected,false);assert.equal(empty.needed,false);
});
test('explicit partial/unknown main retry survives matching routes and is target/selection bound',()=>{
  assert.equal(ui.mainApplyState(route,{members:true},values,true).needed,true);
  const key=ui.mainRetryKey(route,{current:true},'sid');
  assert.notEqual(key,ui.mainRetryKey(route,{current:true},'other'));
  assert.notEqual(key,ui.mainRetryKey({...route,model:'different'},{current:true},'sid'));
});
test('individual same-route member is neutral except explicit uncertain durability retry',()=>{
  const target=member('a'),key=ui.memberRetryKey('team','a',route);
  assert.equal(ui.memberApplyState('team',[target],route).needed,false);
  assert.equal(ui.memberApplyState('team',[target],route,{[key]:true}).retry,true);
  assert.equal(ui.memberApplyState('other',[target],route,{[key]:true}).needed,false);
  assert.equal(ui.memberApplyState('team',[target],{...route,reasoningEffort:'low'}).changed,1);
});
test('all-started scope includes unsafe and same-route targets; never shrinks silently',()=>{
  const owner=team();owner.members[1].unsafe=true;
  const all=ui.memberTargets(owner,'all','a');assert.equal(all.length,2);assert.equal(all[1].unsafe,true);
  assert.equal(ui.memberTargets(owner,'single','absent').length,0);
});
test('capture freezes ids, revisions, names and chosen model before async work',()=>{
  const owner=team(),choice={...route},snapshot=ui.captureMemberRequest(owner,'all','a',choice);
  owner.key='replacement';owner.members[0].id='replacement';owner.members[1].revision='new-revision';choice.model='different';owner.members.push(member('c'));
  assert.equal(snapshot.teamKey,'opaque-team-key');assert.equal(snapshot.members[0].memberId,'a');assert.equal(snapshot.members[1].revision,'rev-b');assert.equal(snapshot.model,'model');assert.equal(snapshot.requested,2);
  assert.ok(Object.isFrozen(snapshot)&&Object.isFrozen(snapshot.members)&&Object.isFrozen(snapshot.members[0]));
});
test('capture rejects missing/duplicate/revisionless targets without substitutions',()=>{
  assert.throws(()=>ui.captureMemberRequest(team(),'single','missing',route));
  const duplicate=team();duplicate.members[1].id='a';assert.throws(()=>ui.captureMemberRequest(duplicate,'all','',route));
  const invalid=team();invalid.members[0].revision='';assert.throws(()=>ui.captureMemberRequest(invalid,'all','',route));
});
test('single success needs exact id, exact route, valid effective, and no partial/error',()=>{
  const wanted={...route,memberId:'a'};
  const good={applied:true,member:{id:'a',selected:{...route}},effective:'futureSteps'};
  assert.equal(ui.memberOutcome(good,wanted).complete,true);
  for(const bad of [{...good,member:{id:'b',selected:route}},{...good,member:{id:'a',selected:{...route,model:'wrong'}}},{...good,effective:'now'},{...good,partial:true},{...good,error:'not durable'}])assert.equal(ui.memberOutcome(bad,wanted).complete,false);
});
test('explicit failed result differs from partial, unknown transport and malformed success',()=>{
  const wanted={...route,memberId:'a'};
  assert.equal(ui.memberOutcome({applied:false,error:'rejected'},wanted).retry,false);
  assert.equal(ui.memberOutcome({applied:false,partial:true,error:'flush failed'},wanted).retry,true);
  assert.equal(ui.memberOutcome(undefined,wanted,new Error('transport')).retry,true);
  assert.equal(ui.memberOutcome({applied:true},wanted).retry,true);
  assert.equal(ui.memberOutcome({error:'stale'},wanted,{status:409}).retry,false);
});
test('full batch success requires exactly captured set and consistent summary',()=>{
  const wanted=request(),reply=result(wanted),notice=ui.batchApplyNotice(reply,wanted);
  assert.equal(notice.complete,true);assert.equal(notice.error,false);assert.equal(notice.rows.length,2);
  assert.deepEqual(clean(notice.counts),{succeeded:2,failed:0,partial:0,noChange:0,unknown:0});
});
test('batch noChange counts are a subset of confirmed successes',()=>{
  const wanted=request(),reply=result(wanted);reply.results[0].noChange=true;reply.summary.noChange=1;
  const notice=ui.batchApplyNotice(reply,wanted);assert.equal(notice.complete,true);assert.equal(notice.rows[0].status,'noChange');
});
test('batch missing, extra, duplicate and substituted identities never confirm full success',()=>{
  const wanted=request();
  for(const modify of [reply=>reply.results.pop(),reply=>reply.results.push({...reply.results[0],memberId:'other'}),reply=>{reply.results[1]={...reply.results[0]};},reply=>{reply.results[0].memberName='other-name';},reply=>{reply.teamKey='other-team';},reply=>{reply.requested=3;}]){
    const reply=result(wanted);modify(reply);const notice=ui.batchApplyNotice(reply,wanted);assert.equal(notice.complete,false);assert.equal(notice.error,true);assert.equal(notice.rows.length,2);assert.equal(notice.rows[0].memberId,'a');assert.equal(notice.rows[1].memberId,'b');
  }
  const duplicate=result(wanted);duplicate.results[1]={...duplicate.results[0]};assert.equal(ui.batchApplyNotice(duplicate,wanted).rows[0].status,'unknown');
});
test('wrong returned route and inconsistent summary do not produce a full success',()=>{
  const wanted=request(),wrong=result(wanted);wrong.results[0].member.selected.model='wrong';
  assert.equal(ui.batchApplyNotice(wrong,wanted).rows[0].status,'unknown');assert.equal(ui.batchApplyNotice(wrong,wanted).complete,false);
  const counts=result(wanted);counts.summary.succeeded=1;const notice=ui.batchApplyNotice(counts,wanted);assert.equal(notice.complete,false);assert.ok(notice.rows.every(row=>row.retry));
});
test('partial batch renders each captured member and permits only explicit retry',()=>{
  const wanted=request(),reply=result(wanted);reply.applied=false;reply.partial=true;reply.results[1]={memberId:'b',memberName:'name-b',applied:false,partial:true,error:'flush failed',member:{id:'b',selected:route},effective:'nextActivation'};reply.summary={succeeded:1,failed:0,partial:1,noChange:0};
  const notice=ui.batchApplyNotice(reply,wanted);assert.equal(notice.complete,false);assert.equal(notice.rows[0].complete,true);assert.equal(notice.rows[1].status,'partial');assert.equal(notice.rows[1].retry,true);
});
test('batch transport failure cannot promote otherwise successful-looking rows',()=>{
  const wanted=request(),notice=ui.batchApplyNotice(result(wanted),wanted,Object.assign(new Error('HTTP failure'),{status:500}));
  assert.equal(notice.complete,false);assert.ok(notice.rows.every(row=>!row.complete));
});
test('batch request path and payload preserve the backend contract',async()=>{
  let seen;
  const browser=load(async(url,options)=>{seen={url,options};return {ok:true,status:200,json:async()=>({teamKey:'team',applied:true})};});
  const payload={teamKey:'team',...route,members:[{memberId:'a',revision:'r-a'}]};await browser.membersApi(payload,true);
  assert.equal(seen.url,'/plugins/local-model-switch/members/batch');assert.equal(seen.options.method,'POST');assert.equal(seen.options.credentials,'same-origin');assert.deepEqual(JSON.parse(seen.options.body),payload);
});
test('notices use unique classes; warnings and results are collapsed; light/dark selection has contrast',()=>{
  assert.ok(ui.CSS.includes('.dsh-ms-message'));assert.ok(!ui.CSS.includes('.notice'));assert.ok(!/\.dsh-ms \.(error|success)\b/.test(ui.CSS));
  assert.ok(!ui.CSS.includes('prefers-color-scheme'));assert.ok(!ui.CSS.includes('--dsh-ms-fg'));assert.ok(!ui.CSS.includes('--dsh-ms-bg'));assert.ok(!ui.CSS.includes('color-scheme:'));
  assert.ok(ui.CSS.includes('color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-base,transparent)'));
  assert.ok(ui.CSS.includes('background:var(--dsw-alias-bg-base,transparent);color:inherit'));
  assert.ok(ui.CSS.includes('var(--dsw-alias-bg-l1,transparent)'));assert.ok(ui.CSS.includes('var(--dsw-alias-label-secondary,inherit)'));
  assert.ok(ui.CSS.includes('.dsh-ms-status--bad{color:inherit'));assert.ok(ui.CSS.includes('::selection{background:#365cc7;color:#fff'));
  assert.ok(source.includes("h('details'"));assert.ok(!source.includes('open: true'));
  for(const label of ['渠道','模型','推理档位','既有成员所属团队','既有团队成员'])assert.ok(source.includes(`'aria-label': '${label}'`),label);
  assert.ok(source.includes('type: \'search\''));
});
test('default409 helper remains bounded and only retries exact native-own-save conflict',async()=>{
  const latest={revision:'old',newSession:{...route},members:{provider:'p',model:'m',instance:'same'}};
  const fresh={...latest,revision:'fresh'};let calls=0;
  const reply=await ui.applyDefaults(route,['newSession'],latest,true,async payload=>{calls++;if(calls===1)throw Object.assign(new Error('conflict'),{status:409});if(!payload)return fresh;assert.equal(payload.revision,'fresh');return {applied:['newSession']};});
  assert.equal(calls,3);assert.equal(reply.applied[0],'newSession');
  calls=0;await assert.rejects(ui.applyDefaults(route,['members'],latest,false,async()=>{calls++;throw Object.assign(new Error('conflict'),{status:409});}));assert.equal(calls,1);
});
