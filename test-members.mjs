import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {sdkDir, teamsLibDir} from './paths.mjs';
import vm from 'node:vm';
import {
  changeExistingMember, listExistingMembers, memberRevision,
  recordedRoute, selectedRoute, verifyLineage,
} from './existing-members.mjs';

// Import real kernel definitions, but never construct a runtime/service, boot a
// team, use a provider, or touch a team-state artifact. All storage below is RAM.
const coreRequire = createRequire(join(sdkDir,'package.json'));
const {AgentModel, modelSelectionProjectionDefinition: projection} = await import(coreRequire.resolve('@deepseek-ai/dsh-agent'));
const {snapshotSubagentDescriptor} = await import(coreRequire.resolve('@deepseek-ai/dsh-subagent'));
const A = Object.freeze({provider: 'route-a', model: 'model-a', reasoningEffort: 'high'});
const B = Object.freeze({provider: 'route-b', model: 'model-b', reasoningEffort: 'low'});
const FALLBACK = Object.freeze({provider: 'backup', model: 'backup-model'});
const WORKSPACE = '/virtual/model-switch-regression';
const clone = value => structuredClone(value);
const error = (message, code) => Object.assign(new Error(message), {code});

function fixture({cold = false, idle = false, inherited = 0} = {}) {
  const counters = {teamWrites: 0, liveFlushes: 0, coldFlushes: 0, append: 0,
    opens: [], closes: 0, maintenance: 0, wake: 0, create: 0, resume: 0, lockKeys: []};
  const controls = {liveFlushFails: false, coldFlushFails: false, appendThrowsAfterCommit: false,
    liveAppendThrowsAfterCommit: false, owned: false, afterTeamWrite: undefined, afterLiveFlush: undefined};
  let storedTeam = {
    id: 't1', name: 'Regression team', captainSessionId: 'captain-1', createdAt: 100,
    phase: 'running', halted: false,
    members: [{id: 'child-1', name: 'worker', role: 'researcher', status: idle ? 'idle' : 'working', joinedAt: 101,
      ...A, fallback: clone(FALLBACK), executionPrompt: 'Do not change this prompt',
      runtimeSetup: {persona: 'Original persona', toolFilter: {allow: ['read'], deny: ['bash']}},
      toolPolicy: 'read-only', toolFilter: {allow: ['read'], deny: ['bash']}}],
    tasks: [{id: 'task-1', assignee: 'worker', status: 'in_progress', attempt: 3,
      attemptId: 'attempt-fixed', dependencies: [], updatedAt: 103, reassigning: false}],
  };
  const descriptor = snapshotSubagentDescriptor({mode: 'continuable', provider: 'spawn',
    label: 'agent-teams:t1:worker', agentProvider: A.provider, agentModel: A.model,
    agentReasoningEffort: A.reasoningEffort});
  const foreignDescriptor = snapshotSubagentDescriptor({mode: 'continuable', provider: 'spawn',
    label: 'foreign-parent:child', agentProvider: 'foreign', agentModel: 'foreign'});
  const event = (type, data, seq, time = 110 + seq) => ({type, data: clone(data), seq, time});
  const events = [...Array.from({length: inherited}, (_, i) => event('subagent/descriptor', foreignDescriptor, i)),
    event('subagent/descriptor', descriptor, inherited),
    event('request/header', {header: {config: clone(A)}}, inherited + 1)];
  let durableEvents = clone(events);
  let state = projection.init();
  for (const item of events) state = projection.apply(state, item);
  const session = {
    header: {id: 'child-1', parentSession: 'captain-1', cwd: WORKSPACE, createdAt: 102, version: 4},
    inheritedEventCount: inherited,
    snapshotEvents: () => clone(events),
    ownEvents: () => clone(events.slice(inherited)),
    requestHeader: () => events.filter(e => e.type === 'request/header').at(-1)?.data.header,
    append(type, data) {
      const entry = event(type, data, events.length, Date.now());
      events.push(entry); state = projection.apply(state, entry); counters.append++;
      if (controls.liveAppendThrowsAfterCommit) throw error('append observer failed after commit', 'SIMULATED');
      return entry;
    },
  };
  const model = new AgentModel(() => state, session, clone(A));
  const originalAgent = {
    id: 'child-1', session, model, status: idle ? 'idle' : 'running', options: clone(A),
    inbox: {nextStep: [{id: 'steer-fixed'}], nextTurn: [{id: 'turn-fixed'}]},
    async runMaintenance(operation) {counters.maintenance++; return operation(new AbortController().signal);},
    send() {counters.wake++; throw Error('unexpected wake');},
    cancel() {throw Error('unexpected cancellation');},
  };
  let residentAgent = cold ? undefined : originalAgent;
  let residentSession = cold ? undefined : session;
  const apply = () => {};
  const tails = new Map();
  const mod = {
    apply, EXISTING_MEMBER_MODEL_SWITCH_VERSION: 1,
    async collectTeamsActivity(_ctx, roots) {assert.equal(roots[0].workspacePath, undefined); return [{teamId: 't1', phase: storedTeam.phase}];},
    async readTeam(_root, id) {return id === storedTeam.id ? clone(storedTeam) : undefined;},
    async writeTeam(_root, team) {storedTeam = clone(team); counters.teamWrites++; await controls.afterTeamWrite?.();},
    async withTeamLock(key, operation) {
      counters.lockKeys.push(key);
      const previous = tails.get(key) ?? Promise.resolve();
      const result = previous.then(operation); tails.set(key, result.catch(() => {}));
      return result;
    },
  };
  const entry = {options: {id: 'agent-teams'}, moduleNamespace: mod,
    fiber: {state: 2, runtime: {callback: apply, Config: {}}, effectiveConfig: {stateDir: '.agent-teams'}}};
  const ctx = {
    configEditor: {entries: () => [entry]},
    workspaceRegistry: {list: () => [{title: 'Virtual workspace', path: WORKSPACE}]},
    agents: {get: id => id === 'child-1' ? residentAgent : undefined,
      create() {counters.create++; throw Error('unexpected create');},
      resume() {counters.resume++; throw Error('unexpected resume');}},
    sessions: {get: id => id === 'child-1' ? residentSession : undefined,
      async flush(target) {
        assert.equal(target, session); counters.liveFlushes++;
        if (controls.liveFlushFails) return false;
        durableEvents = clone(events); await controls.afterLiveFlush?.(); return true;
      }},
    llm: {
      listProviders: () => [{id: A.provider}, {id: B.provider}],
      listModels: async provider => [{id: provider === A.provider ? A.model : B.model}],
      resolveCallConfig: async selection => clone(selection),
      stream() {throw Error('provider completions forbidden');},
    },
    sessionPersistence: {
      async open(id, access) {
        assert.equal(id, 'child-1'); counters.opens.push(access);
        if (access === 'write' && (controls.owned || residentSession)) throw error('owned', 'SESSION_ALREADY_OWNED');
        let closed = false;
        const handle = {
          id, access, header: clone(session.header), inheritedEventCount: inherited,
          async read(offset = 0, length) {
            assert.equal(closed, false);
            const source = access === 'write' ? events : durableEvents;
            return {eventState: 'detached', events: clone(source.slice(offset, length === undefined ? undefined : offset + length))};
          },
          async append(batch) {
            assert.equal(access, 'write'); assert.equal(closed, false);
            for (const item of batch) {assert.equal(item.seq, events.length); events.push(clone(item)); state = projection.apply(state, item); counters.append++;}
            if (controls.appendThrowsAfterCommit) throw error('append accepted then transport failed', 'SIMULATED');
          },
          async flush() {
            assert.equal(access, 'write'); counters.coldFlushes++;
            if (controls.coldFlushFails) throw error('flush failed', 'SIMULATED');
            durableEvents = clone(events);
          },
          async close() {if (!closed) {closed = true; counters.closes++;}},
        };
        return handle;
      },
    },
  };
  return {ctx, mod, entry, session, agent: originalAgent, descriptor, events, counters, controls,
    team: () => clone(storedTeam), member: () => clone(storedTeam.members[0]), durable: () => clone(durableEvents),
    editTeam(change) {change(storedTeam);},
    replaceAgent(next) {residentAgent = next; residentSession = next?.session;},
    unpublished() {residentAgent = undefined; residentSession = session;},
    async payload(selection = B) {
      const listing = await listExistingMembers(ctx); assert.equal(listing.available, true);
      const row = listing.teams[0]; assert.ok(row);
      return {teamKey: row.key, memberId: 'child-1', revision: memberRevision(storedTeam, storedTeam.members[0]), ...selection};
    },
  };
}

function unchangedFields(team) {
  const result = clone(team);
  for (const member of result.members) for (const field of ['activeProvider', 'activeModel', 'fallbackActive', 'manualModelSelection']) delete member[field];
  return result;
}
async function switchFixture(f, selection = B) {return changeExistingMember(f.ctx, await f.payload(selection));}

// Extract executable snippets from the proposed source patch, in memory only.
// Do not execute its imports, fs-writing try block, or mount the real plugin.
const patchText = await readFile(new URL('./patch-teams.mjs', import.meta.url), 'utf8');
const declarations = patchText.slice(patchText.indexOf('const manualGetter='), patchText.indexOf('\ntry {'));
const {manualGetter, plans} = vm.runInNewContext(`${declarations}\n({manualGetter,plans})`, {});
const replacements = name => plans.find(([filename]) => filename === name)[1];
function applyTextPlan(source, name) {
  for (const [oldText, nextText] of replacements(name)) {
    if (source.includes(nextText)) continue;
    assert.equal(source.split(oldText).length, 2, `source patch prerequisite missing: ${name}`);
    source = source.replace(oldText, nextText);
  }
  return source;
}
const sourceBase = teamsLibDir.replace(/\/?$/,'/');
const patchedMembers = applyTextPlan(await readFile(sourceBase + 'members.js', 'utf8'), 'members.js');
const patchedSnapshot = applyTextPlan(await readFile(sourceBase + 'snapshot.js', 'utf8'), 'snapshot.js');
const selectionCode = patchedMembers.slice(patchedMembers.indexOf('function selectionFromMember('), patchedMembers.indexOf('\nfunction modelSelection('));
const fallbackCode = patchedMembers.slice(patchedMembers.indexOf('async function updateFallbackState('), patchedMembers.indexOf('\nfunction pendingSelectionKey('));
const priority = vm.runInNewContext(`${manualGetter.replace('export ', '')}\n${selectionCode}\n({manualModelSelectionOf,selectionFromMember})`, {});
const hydrationReplacement = replacements('members.js').find(([old]) => old === '        let lastFailedTurn;')[1];
const hydrate = new Function('savedMember', 'child', 'manualModelSelectionOf', 'modelSelection', 'sessionOwnEvents',
  hydrationReplacement.replace(/\n\s*let lastFailedTurn;\s*$/, ''));
const runHydration = (member, agent) => hydrate(member, agent, priority.manualModelSelectionOf, clone, session => session.ownEvents());
const fallbackPrefix = replacements('members.js').find(([old]) => old.includes('const transition = selectFallbackRoute'))[1].split('            const transition =')[0];
const errorFallbackGuard = new Function('readTeamSync', 'stateRoot', 'teamId', 'parentSessionId', 'child', 'memberName', 'next', `${fallbackPrefix}\nreturn 'fallback-eligible';`);
const routeSnapshotCode = patchedSnapshot.slice(patchedSnapshot.indexOf('export function memberModelRoute('), patchedSnapshot.indexOf('\n/**', patchedSnapshot.indexOf('export function memberModelRoute(')));
const snapshotRoute = vm.runInNewContext(`${manualGetter.replace('export ', '')}\n${routeSnapshotCode.replace('export ', '')}\nmemberModelRoute`, {});
const clientSource = await readFile(new URL('./client.cjs', import.meta.url), 'utf8');
const clientExports = {};
vm.runInNewContext(clientSource, {exports: clientExports, require(name) {assert.equal(name, 'react'); return {createElement() {}, useEffect() {}, useRef() {}, useState() {}};}});

// Kernel-backed live/cold behavior.
test('live running switch records B while already captured step A and immutable team context remain untouched', async () => {
  const f = fixture(); const original = f.team(); const inbox = clone(f.agent.inbox);
  const capturedStep = clone(f.agent.model.current());
  const result = await switchFixture(f);
  assert.equal(result.applied, true); assert.equal(result.effective, 'futureSteps');
  assert.deepEqual(f.agent.model.current(), B); assert.deepEqual(capturedStep, A);
  assert.deepEqual(f.session.requestHeader().config, A);
  assert.deepEqual(unchangedFields(f.team()), unchangedFields(original));
  assert.deepEqual(f.agent.inbox, inbox); assert.deepEqual(f.events[0].data, f.descriptor);
  assert.deepEqual(f.member().manualModelSelection.selection, B);
  assert.equal(f.member().provider, A.provider); assert.equal(f.member().model, A.model); assert.equal(f.member().reasoningEffort, A.reasoningEffort);
  assert.deepEqual(f.durable().at(-1).data, B);
  assert.equal(f.counters.maintenance, 0); assert.equal(f.counters.wake + f.counters.create + f.counters.resume, 0);
  assert.deepEqual(f.counters.lockKeys, [`team:${WORKSPACE}/.agent-teams:t1`]);
});
test('idle resident uses non-turn maintenance without waking or changing inbox/attempt', async () => {
  const f = fixture({idle: true}); const before = f.team(); const inbox = clone(f.agent.inbox);
  const result = await switchFixture(f);
  assert.equal(result.applied, true); assert.equal(f.counters.maintenance, 1); assert.equal(f.counters.wake, 0);
  assert.equal(f.agent.status, 'idle'); assert.deepEqual(f.agent.inbox, inbox);
  assert.deepEqual(f.team().tasks, before.tasks);
});
test('cold switch uses single-writer append/flush/close and never creates or resumes an Agent', async () => {
  const f = fixture({cold: true}); const original = f.team();
  const result = await switchFixture(f);
  assert.equal(result.applied, true); assert.equal(result.effective, 'nextActivation');
  assert.deepEqual(f.counters.opens, ['write']); assert.equal(f.counters.closes, 1); assert.equal(f.counters.coldFlushes, 1);
  assert.deepEqual(recordedRoute(f.durable(), f.descriptor), B);
  assert.deepEqual(unchangedFields(f.team()), unchangedFields(original));
  assert.equal(f.counters.wake + f.counters.create + f.counters.resume, 0);
});
test('native cold ownership refusal does not write team or steal the existing writer', async () => {
  const f = fixture({cold: true}); f.controls.owned = true;
  await assert.rejects(switchFixture(f), e => e.status === 409);
  assert.equal(f.counters.teamWrites, 0); assert.equal(f.counters.append, 0); assert.equal(f.counters.closes, 0);
});
test('unpublished live Session without resident Agent is rejected without appending', async () => {
  const f = fixture(); f.unpublished();
  await assert.rejects(switchFixture(f), e => e.status === 409);
  assert.equal(f.counters.teamWrites, 0); assert.equal(f.counters.append, 0);
});
test('real projection preserves pending B when an old captured A request/header arrives later', async () => {
  const f = fixture(); await switchFixture(f);
  f.session.append('request/header', {header: {config: A}});
  assert.deepEqual(f.agent.model.current(), B);
  assert.deepEqual(recordedRoute(f.session.snapshotEvents(), f.descriptor), B);
  f.session.append('request/header', {header: {config: B}});
  assert.deepEqual(f.agent.model.current(), B);
});
test('recordedRoute matches kernel projection and omits adapter-defaulted reasoning effort', () => {
  const f = fixture(); const headers = [{type: 'request/header', seq: 0, time: 1,
    data: {header: {config: A, adapterDefaults: {reasoningEffort: true}}}}];
  let state = projection.init(); for (const e of headers) state = projection.apply(state, e);
  assert.deepEqual(recordedRoute(headers, f.descriptor), state.pending ?? state.lastUsed);
  assert.deepEqual(recordedRoute([], f.descriptor), A);
});

// Trust boundaries and exact revision/identity checks.
test('loaded capability must come from exact moduleNamespace, not runtime exports', async () => {
  const f = fixture(); assert.equal((await listExistingMembers(f.ctx)).available, true);
  f.entry.moduleNamespace = {...f.mod, apply: () => {}};
  assert.equal((await listExistingMembers(f.ctx)).available, false);
  f.entry.moduleNamespace = undefined; Object.assign(f.entry.fiber.runtime, f.mod);
  assert.equal((await listExistingMembers(f.ctx)).available, false);
});
test('stale member revision is refused before persistence', async () => {
  const f = fixture(); const payload = await f.payload(); f.editTeam(t => t.members[0].activeModel = 'other');
  await assert.rejects(changeExistingMember(f.ctx, payload), e => e.status === 409);
  assert.equal(f.counters.teamWrites, 0); assert.equal(f.counters.append, 0);
});
for (const [label, mutate] of [
  ['removed member', t => {t.members[0].status = 'removed';}],
  ['stopping member', t => {t.members[0].stopping = true;}],
  ['reassigning task', t => {t.tasks[0].reassigning = true;}],
  ['unspawned member', t => {t.members[0].id = '';}],
  ['staged team', t => {t.phase = 'staged';}],
  ['replaced team generation', t => {t.createdAt++;}],
]) test(`${label} is rejected without task/model mutation`, async () => {
  const f = fixture(); const payload = await f.payload(); f.editTeam(mutate); const before = f.team();
  await assert.rejects(changeExistingMember(f.ctx, payload), e => e.status === 409);
  assert.deepEqual(f.team(), before); assert.equal(f.counters.teamWrites, 0); assert.equal(f.counters.append, 0);
});
for (const [label, mutate] of [
  ['foreign parent', f => {f.session.header.parentSession = 'other-parent';}],
  ['wrong cwd', f => {f.session.header.cwd = '/virtual/elsewhere';}],
  ['wrong child id', f => {f.session.header.id = 'other-child';}],
  ['wrong own descriptor', f => {f.events[0].data = snapshotSubagentDescriptor({mode: 'continuable', provider: 'spawn', label: 'agent-teams:t1:other', agentProvider: A.provider, agentModel: A.model});}],
]) test(`${label} listing withholds foreign live routes and POST refuses identity`, async () => {
  const f = fixture(); const payload = await f.payload(); mutate(f);
  const listing = await listExistingMembers(f.ctx); const member = listing.teams[0].members[0];
  assert.equal(member.unsafe, true); assert.equal(member.activity, 'identity-conflict');
  assert.equal(member.liveNext, undefined); assert.equal(member.lastUsed, undefined);
  await assert.rejects(changeExistingMember(f.ctx, payload), e => e.status === 409);
  assert.equal(f.counters.teamWrites, 0); assert.equal(f.counters.append, 0);
});
test('descriptor verification excludes inherited descriptors and first own descriptor remains immutable', () => {
  const f = fixture({inherited: 1});
  assert.deepEqual(verifyLineage(f.session.header, f.events, 1, f.team(), f.member(), WORKSPACE), f.descriptor);
  assert.throws(() => verifyLineage(f.session.header, f.events, 0, f.team(), f.member(), WORKSPACE));
  for (const boundary of [-1, 0.5, f.events.length + 1, NaN]) assert.throws(() => verifyLineage(f.session.header, f.events, boundary, f.team(), f.member(), WORKSPACE));
  const foreign = clone(f.events[0]);
  assert.throws(() => verifyLineage(f.session.header, [foreign, ...f.events.slice(1)], 0, f.team(), f.member(), WORKSPACE));
});

// Cross-owner durability and late races.
for (const cold of [false, true]) test(`${cold ? 'cold' : 'live'} flush failure is partial and identical retry still fails durability`, async () => {
  const f = fixture({cold}); if (cold) f.controls.coldFlushFails = true; else f.controls.liveFlushFails = true;
  const result = await switchFixture(f); assert.equal(result.applied, false); assert.equal(result.partial, true);
  assert.deepEqual(selectedRoute(f.member()), B); const writes = f.counters.teamWrites;
  await assert.rejects(switchFixture(f));
  assert.equal(f.counters.teamWrites, writes); assert.deepEqual(selectedRoute(f.member()), B);
  assert.equal(cold ? f.counters.coldFlushes : f.counters.liveFlushes, 2);
});
for (const cold of [false, true]) test(`${cold ? 'cold' : 'live'} noChange performs real durability barrier without duplicate selection`, async () => {
  const f = fixture({cold}); await switchFixture(f); const writes = f.counters.teamWrites; const appends = f.counters.append;
  const result = await switchFixture(f);
  assert.equal(result.applied, true); assert.equal(result.noChange, true);
  assert.equal(f.counters.teamWrites, writes); assert.equal(f.counters.append, appends);
  assert.equal(cold ? f.counters.coldFlushes : f.counters.liveFlushes, 2);
});
test('same original route Apply installs manual intent, rather than preserving automatic fallback silently', async () => {
  const f = fixture(); const result = await switchFixture(f, A);
  assert.equal(result.noChange, false); assert.deepEqual(f.member().manualModelSelection.selection, A);
});
for (const cold of [false, true]) test(`${cold ? 'cold' : 'live'} append that commits then throws retains selected intent and reports partial`, async () => {
  const f = fixture({cold}); if (cold) f.controls.appendThrowsAfterCommit = true; else f.controls.liveAppendThrowsAfterCommit = true;
  const result = await switchFixture(f);
  assert.equal(result.applied, false); assert.equal(result.partial, true); assert.equal(result.sessionSelectionRecorded, true);
  assert.deepEqual(selectedRoute(f.member()), B); assert.deepEqual(recordedRoute(f.events, f.descriptor), B);
  assert.equal(f.counters.teamWrites, 1); assert.deepEqual(f.team().tasks[0].attemptId, 'attempt-fixed');
});
test('replacement during team write is detected before append; saved route is restored when possible', async () => {
  const f = fixture(); const before = f.team();
  f.controls.afterTeamWrite = () => {f.replaceAgent({...f.agent, model: {current: () => A}});};
  await assert.rejects(switchFixture(f), e => e.status === 409);
  assert.equal(f.counters.append, 0); assert.deepEqual(f.team(), before);
});
test('replacement after flush yields partial, never complete success for a stale Agent', async () => {
  const f = fixture(); f.controls.afterLiveFlush = () => {f.replaceAgent({...f.agent, model: {current: () => A}});};
  const result = await switchFixture(f);
  assert.equal(result.applied, false); assert.equal(result.partial, true); assert.equal(result.sessionSelectionRecorded, true);
});

// Valid manual intent wins over original fallback, with exact source patch code.
test('source manual route priority keeps base route/effort/fallback immutable and snapshot effective', () => {
  const f = fixture(); const member = f.member(); member.manualModelSelection = {version: 1, selection: B, selectedAt: 150};
  member.activeProvider = FALLBACK.provider; member.activeModel = FALLBACK.model; member.fallbackActive = true;
  assert.deepEqual(clone(priority.selectionFromMember(member)), B);
  assert.equal(snapshotRoute(member), `${B.provider}/${B.model}`);
  assert.deepEqual(member.fallback, FALLBACK); assert.equal(member.reasoningEffort, A.reasoningEffort);
});
test('fallback state guard rechecks manual override inside the shared team lock', async () => {
  const f = fixture(); const team = f.team(); let callback;
  const update = vm.runInNewContext(`${fallbackCode}\nupdateFallbackState`, {
    withTeamLock: async (key, fn) => {assert.equal(key, 'team:/virtual:t1'); callback = fn;},
    readTeam: async () => team,
    writeTeam: async () => {throw Error('manual fallback must not write');},
  });
  await update('/virtual', 't1', 'worker', FALLBACK, {});
  team.members[0].manualModelSelection = {version: 1, selection: B, selectedAt: 150};
  await callback(); assert.equal(team.members[0].activeProvider, undefined);
});
test('request-error fallback guard skips original policy for an exact manually selected child', () => {
  const f = fixture(); const team = f.team(); team.members[0].manualModelSelection = {version: 1, selection: B, selectedAt: 150};
  let next = 0;
  assert.equal(errorFallbackGuard(() => team, '/virtual', 't1', 'captain-1', f.agent, 'worker', () => {next++; return 'skipped';}), 'skipped');
  assert.equal(next, 1); delete team.members[0].manualModelSelection;
  assert.equal(errorFallbackGuard(() => team, '/virtual', 't1', 'captain-1', f.agent, 'worker', () => 'skipped'), 'fallback-eligible');
});
test('source hydration recovers genuine partial manual intent using real kernel model.select', () => {
  const f = fixture(); const member = f.member(); member.manualModelSelection = {version: 1, selection: B, selectedAt: 200};
  const before = clone(member); runHydration(member, f.agent);
  assert.deepEqual(f.agent.model.current(), B); assert.equal(f.events.at(-1).type, 'model/selection');
  assert.deepEqual(member, before); assert.equal(f.counters.wake, 0); assert.deepEqual(f.events[0].data, f.descriptor);
  const count = f.events.length; runHydration(member, f.agent); assert.equal(f.events.length, count);
});
test('source hydration refuses newer conflicting explicit session selection', () => {
  const f = fixture(); f.session.append('model/selection', A);
  const member = f.member(); member.manualModelSelection = {version: 1, selection: B, selectedAt: 1};
  const count = f.events.length;
  assert.throws(() => runHydration(member, f.agent), /newer session selection/);
  assert.equal(f.events.length, count); assert.deepEqual(f.agent.model.current(), A);
});
for (const [name, record] of [
  ['wrong version', {version: 2, selection: B, selectedAt: 10}],
  ['missing timestamp', {version: 1, selection: B}],
  ['fractional timestamp', {version: 1, selection: B, selectedAt: 0.5}],
  ['negative timestamp', {version: 1, selection: B, selectedAt: -1}],
  ['invalid provider', {version: 1, selection: {...B, provider: 12}, selectedAt: 10}],
  ['invalid effort', {version: 1, selection: {...B, reasoningEffort: 12}, selectedAt: 10}],
  ['blank effort', {version: 1, selection: {...B, reasoningEffort: ''}, selectedAt: 10}],
  ['whitespace provider', {version: 1, selection: {...B, provider: '   '}, selectedAt: 10}],
  ['whitespace model', {version: 1, selection: {...B, model: '\t'}, selectedAt: 10}],
  ['whitespace effort', {version: 1, selection: {...B, reasoningEffort: ' '}, selectedAt: 10}],
]) test(`malformed manual record: ${name} is rejected by backend and source getter`, () => {
  const member = {...fixture().member(), manualModelSelection: record};
  assert.throws(() => priority.manualModelSelectionOf(member), undefined, 'source getter must reject invalid manual intent');
  assert.throws(() => selectedRoute(member), undefined, 'backend getter must reject invalid manual intent');
});
for (const effort of [null, false, 0, '', 12, {}, 'x'.repeat(129)]) test(`malformed payload effort ${JSON.stringify(effort)} is refused before writes`, async () => {
  const f = fixture(); const payload = await f.payload(); payload.reasoningEffort = effort;
  await assert.rejects(changeExistingMember(f.ctx, payload)); assert.equal(f.counters.teamWrites, 0); assert.equal(f.counters.append, 0);
});

// Pure UI result interpretation, isolated from DOM, hooks, fetch and services.
test('memberApplyNotice accepts only exact target/route and complete confirmed outcome', () => {
  const requested = {...B, memberId: 'child-1', teamName: 'Team', memberName: 'worker'};
  const result = {applied: true, partial: false, member: {id: 'child-1', selected: B}, effective: 'futureSteps'};
  const notice = clientExports.memberApplyNotice(result, requested);
  assert.equal(notice.error, false); assert.match(notice.text, /后续尚未开始准备/); assert.match(notice.text, /重试仍可能使用旧模型/);
  assert.equal(clientExports.memberApplyNotice({...result, effective: 'nextActivation'}, requested).error, false);
  for (const invalid of [{...result, partial: true}, {...result, error: 'disk failure'}, {...result, effective: 'now'},
    {...result, member: {id: 'other-child', selected: B}}, {...result, member: {id: 'child-1', selected: A}}, {}, undefined]) {
    assert.equal(clientExports.memberApplyNotice(invalid, requested).error, true);
  }
  const partial = clientExports.memberApplyNotice({...result, applied: false, partial: true}, requested, {status: 503, message: 'flush failed'});
  assert.equal(partial.error, true); assert.match(partial.text, /HTTP 503/); assert.match(partial.text, /仅部分应用/);
});
