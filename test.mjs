import test from 'node:test';
import assert from 'node:assert/strict';
import {apply, applySwitch, catalog, switchStatus, jsonBody} from './index.mjs';
import {Readable} from 'node:stream';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const clientExports = {};
runInNewContext(readFileSync(new URL('./client.cjs', import.meta.url), 'utf8'), {exports: clientExports, require: () => ({createElement() {}})});

function fixture() {
  let def = {provider: 'first', model: 'm1'};
  let raw = {stateDir: '.agent-teams', memberProvider: 'spawn', memberLlmProvider: 'first', memberModel: 'm1', maxMembers: 8, profiles: {p: {members: [{name: 'fixed', model: 'm1'}]}}};
  let changes = 0;
  const fiber = {state: 2, uid: 'same-instance', runtime: {Config: {dict: {memberModel: {meta: {volatile: true}}, memberLlmProvider: {meta: {volatile: true}}}}}};
  fiber.effectiveConfig = {memberModel: {get: () => raw.memberModel}, memberLlmProvider: {get: () => raw.memberLlmProvider}};
  const entry = {options: {id: 'agent-teams'}, fiber};
  const ctx = {
    configEditor: {entries: () => [entry], edit: async (_entry, callback) => {raw = callback(structuredClone(raw)); changes++;}},
    agentDefaultModel: {currentSelection: () => ({...def}), saveSelection: async next => {def = {...next};}},
    llm: {listProviders: () => [{id: 'first', name: 'First'}, {id: 'test', name: 'Krisphyn Test'}],
      listModels: async () => [{id: 'm1', name: 'M1'}, {id: 'm2', name: 'M2'}],
      resolveModelInfo: async () => ({inputModalities: ['text', 'image'], context: {contextWindow: 500000}, defaultMaxTokens: 128000}),
      resolveCallConfig: async () => ({})},
  };
  return {ctx, entry, raw: () => raw, changes: () => changes};
}
const request = (ctx, targets = ['members']) => ({provider: 'test', model: 'm2', targets, revision: switchStatus(ctx).revision});
test('member apply preserves raw other fields and same instance, leaves default unchanged', async () => {
  const f = fixture(); const before = structuredClone(f.raw());
  const result = await applySwitch(f.ctx, request(f.ctx));
  assert.equal(result.members.provider, 'test'); assert.equal(result.members.model, 'm2');
  assert.equal(result.memberInstanceRetained, true); assert.equal(f.entry.fiber.uid, 'same-instance');
  const {memberLlmProvider, memberModel, ...other} = f.raw();
  const {memberLlmProvider: _p, memberModel: _m, ...oldOther} = before;
  assert.deepEqual(other, oldOther); assert.deepEqual(result.newSession, {provider: 'first', model: 'm1'});
});
test('default-only clears omitted reasoning and does not change team', async () => {
  const f = fixture(); await f.ctx.agentDefaultModel.saveSelection({provider: 'first', model: 'm1', reasoningEffort: 'high'});
  const result = await applySwitch(f.ctx, request(f.ctx, ['newSession']));
  assert.deepEqual(result.newSession, {provider: 'test', model: 'm2'});
  assert.equal(result.members.provider, 'first'); assert.equal(f.changes(), 0);
});
test('invalid or stale writes are rejected before mutation', async () => {
  for (const bad of [{revision: 'stale'}, {provider: 'unknown'}, {model: 'absent'}, {targets: ['current']}, {apiKey: 'secret'}, {targets: ['members', 'members']}]) {
    const f = fixture(); await assert.rejects(applySwitch(f.ctx, {...request(f.ctx), ...bad})); assert.equal(f.changes(), 0);
  }
});
test('nonvolatile team refuses remount', async () => {
  const f = fixture(); f.entry.fiber.runtime.Config.dict.memberModel.meta.volatile = false;
  await assert.rejects(applySwitch(f.ctx, request(f.ctx)), /热切换补丁/); assert.equal(f.changes(), 0);
});
test('route/credential validation errors cannot echo secrets', async () => {
  const f = fixture(); f.ctx.llm.resolveCallConfig = async () => {throw new Error('Authorization: sk-secret');};
  await assert.rejects(applySwitch(f.ctx, request(f.ctx)), error => !error.message.includes('sk-secret'));
});
test('reports partial application instead of claiming all success', async () => {
  const f = fixture(); f.ctx.agentDefaultModel.saveSelection = async () => {throw new Error('disk full');};
  const result = await applySwitch(f.ctx, request(f.ctx, ['members', 'newSession']));
  assert.equal(result.partial, true); assert.deepEqual(result.applied, ['members']); assert.equal(result.newSession.provider, 'first');
});
test('catalog isolates provider failure and exports no raw config or keys', async () => {
  const f = fixture(); f.ctx.llm.listModels = async p => {if (p === 'first') throw new Error('sk-private'); return [{id: 'm2'}];};
  const result = await catalog(f.ctx);
  assert.equal(result.groups.length, 1); assert.equal(result.failures.length, 1);
  assert.equal(JSON.stringify(result).includes('sk-private'), false); assert.equal(JSON.stringify(result).includes('profiles'), false);
});
test('bounded request parsing validates objects', async () => {
  assert.deepEqual(await jsonBody(Readable.from(['{"provider":"test"}'])), {provider: 'test'});
  await assert.rejects(jsonBody(Readable.from(['[]'])));
  await assert.rejects(jsonBody(Readable.from(['x'.repeat(8200)])), error => error.status === 413);
});
test('detects same-UID remount through new effective config identity', async () => {
  const f = fixture(); const edit = f.ctx.configEditor.edit;
  f.ctx.configEditor.edit = async (...args) => {
    await edit(...args);
    f.entry.fiber.effectiveConfig = {memberModel: {get: () => f.raw().memberModel}, memberLlmProvider: {get: () => f.raw().memberLlmProvider}};
  };
  await assert.rejects(applySwitch(f.ctx, request(f.ctx)), /热更新未通过核验/);
});
test('catalog uses actual input/context/output metadata', async () => {
  const f = fixture(); const result = await catalog(f.ctx);
  const model = result.groups[0].models[0];
  assert.deepEqual(model.input, ['text', 'image']); assert.equal(model.contextWindow, 500000); assert.equal(model.maxTokens, 128000);
});
test('HTTP sanitizes arbitrary SDK errors even when they carry a status', async () => {
  const f = fixture(); let handler;
  f.ctx.llm.listModels = async () => {throw Object.assign(new Error('Authorization sk-secret'), {status: 401});};
  const scoped = {webServer: {register: route => {handler = route.handler; return () => {};}}, connection: {requestRejection: () => undefined}, effect: cb => cb()};
  f.ctx.inject = (_, cb) => cb(scoped); f.ctx.logger = {warn() {}}; apply(f.ctx);
  const req = Readable.from([JSON.stringify(request(f.ctx))]);
  req.method = 'POST'; req.headers = {host: 'localhost:10980', origin: 'http://localhost:10980', 'content-type': 'application/json'};
  const res = {writeHead(status) {this.status = status;}, end(body) {this.body = body;}};
  await handler(req, res);
  assert.equal(res.status, 500); assert.equal(res.body.includes('sk-secret'), false);
});
test('native own default-save conflict retries once with a fresh revision', async () => {
  const selection={provider:'test',model:'m2'};
  const latest={revision:'old',members:{provider:'first',model:'m1',instance:'same'}};
  const fresh={revision:'new',newSession:selection,members:latest.members};
  const calls=[];
  const answer=await clientExports.applyDefaults(selection,['newSession'],latest,true,async body=>{
    calls.push(body);
    if(calls.length===1)throw Object.assign(new Error('changed'),{status:409});
    if(body===undefined)return fresh;
    return {applied:['newSession']};
  });
  assert.equal(calls.length,3);assert.equal(calls[2].revision,'new');assert.deepEqual(answer.applied,['newSession']);
});
test('client does not retry external default or member-route changes', async () => {
  for(const change of [{newSession:{provider:'other',model:'m3'}},{members:{provider:'other',model:'m1',instance:'same'}},{members:{provider:'first',model:'m1',instance:'restarted'}}]){
    const selection={provider:'test',model:'m2'};const members={provider:'first',model:'m1',instance:'same'};let calls=0;
    await assert.rejects(clientExports.applyDefaults(selection,['newSession'],{revision:'old',members},true,async body=>{
      calls++;if(body)throw Object.assign(new Error('changed'),{status:409});return {revision:'new',newSession:selection,members,...change};
    }),/changed/);
    assert.equal(calls,2);
  }
});
test('client conflict recovery is bounded and only allowed after current selection', async () => {
  const selection={provider:'test',model:'m2'};const members={provider:'first',model:'m1',instance:'same'};
  for(const own of [false,true]){
    let calls=0;await assert.rejects(clientExports.applyDefaults(selection,['newSession'],{revision:'old',members},own,async body=>{
      calls++;if(body)throw Object.assign(new Error('changed'),{status:409});return {revision:'new',newSession:selection,members};
    }),/changed/);assert.equal(calls,own?3:1);
  }
});
test('HTTP auth and same-origin fence run before writes', async () => {
  const f = fixture(); let handler; let rejection;
  const scoped = {webServer: {register: route => {handler = route.handler; return () => {};}},
    connection: {requestRejection: () => rejection}, effect: callback => callback()};
  f.ctx.inject = (_, callback) => callback(scoped); f.ctx.logger = {warn() {}};
  apply(f.ctx);
  async function invoke({method = 'POST', origin = 'http://localhost:10980', host = 'localhost:10980', type = 'application/json', site} = {}) {
    const req = Readable.from([JSON.stringify(request(f.ctx))]);
    req.method = method; req.headers = {host, 'content-type': type, ...(origin ? {origin} : {}), ...(site ? {'sec-fetch-site': site} : {})};
    const res = {setHeader() {}, writeHead(status) {this.status = status;}, end(body) {this.body = JSON.parse(body);}};
    await handler(req, res); return res;
  }
  rejection = 401; assert.equal((await invoke()).status, 401); assert.equal(f.changes(), 0);
  rejection = undefined;
  for (const params of [{origin: ''}, {origin: 'http://evil.test'}, {site: 'cross-site'}]) assert.equal((await invoke(params)).status, 403);
  assert.equal((await invoke({method: 'DELETE'})).status, 405);
  assert.equal((await invoke({type: 'text/plain'})).status, 415);
  assert.equal(f.changes(), 0); assert.equal((await invoke()).status, 200); assert.equal(f.changes(), 1);
});
