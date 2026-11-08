window.__ModuleLoader__.load({id:"@local/dsh-model-switch",factory:(require)=>{
const module={exports:{}}; const exports=module.exports;
// Browser source; build.mjs wraps it for the DSH module loader. React is supplied by the Host.
const React = require('react');
const h = React.createElement;
const {useEffect, useRef, useState} = React;
const PANEL = 'local-model-switch';
const PATH = '/plugins/local-model-switch';
const CSS = `
.dsh-ms{box-sizing:border-box;width:100%;height:100%;overflow:auto;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-base,transparent);padding:40px max(24px,calc((100% - 820px)/2));font:14px/1.6 system-ui,sans-serif}
.dsh-ms h1{font-size:26px;margin:0 0 6px}.dsh-ms h2{font-size:16px;margin:0 0 12px}.dsh-ms p{margin:6px 0 16px}.dsh-ms .muted{color:var(--dsw-alias-label-secondary,inherit)}
.dsh-ms .card{border:1px solid var(--dsw-alias-border-l2,currentColor);border-radius:14px;padding:20px;margin:20px 0;background:var(--dsw-alias-bg-l1,transparent)}
.dsh-ms .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.dsh-ms label{display:block}.dsh-ms input[type=search],.dsh-ms select{box-sizing:border-box;width:100%;background:var(--dsw-alias-bg-base,transparent);color:inherit;border:1px solid var(--dsw-alias-border-l2,currentColor);border-radius:8px;padding:10px;font:inherit;margin:6px 0 12px}
.dsh-ms .check{display:flex;align-items:flex-start;gap:9px;margin:12px 0}.dsh-ms .check input{margin-top:5px;accent-color:#4169e1}.dsh-ms button{font:inherit;border:1px solid var(--dsw-alias-border-l2,currentColor);border-radius:9px;padding:9px 16px;background:transparent;color:inherit;cursor:pointer}.dsh-ms button:disabled{opacity:.65;cursor:not-allowed}
.dsh-ms .primary{background:#4169e1;color:#fff;border-color:#4169e1}.dsh-ms .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.dsh-ms code{overflow-wrap:anywhere;word-break:break-word;font-size:12px}.dsh-ms .facts{display:flex;flex-wrap:wrap;gap:12px;font-size:12px}
.dsh-ms .dsh-ms-message{padding:12px 16px;border:1px solid var(--dsw-alias-border-l2,currentColor);border-radius:9px;background:transparent;color:inherit;overflow-wrap:anywhere;margin:12px 0}.dsh-ms .dsh-ms-message--error{border-color:currentColor;border-style:dashed}.dsh-ms .dsh-ms-message--success{border-color:currentColor}.dsh-ms .dsh-ms-message-body{white-space:pre-wrap;margin-top:8px}.dsh-ms details{margin-top:8px}.dsh-ms summary{cursor:pointer;font-weight:600}.dsh-ms .dsh-ms-warning{background:transparent;color:inherit;border:1px solid var(--dsw-alias-border-l2,currentColor);border-radius:9px;padding:10px 14px;margin:12px 0}.dsh-ms .dsh-ms-warning p{margin:8px 0}.dsh-ms .dsh-ms-batch-row{border-top:1px solid var(--dsw-alias-border-l2,currentColor);padding:10px 0}.dsh-ms .dsh-ms-batch-row:first-child{border-top:0}.dsh-ms .dsh-ms-status--good,.dsh-ms .dsh-ms-status--bad{color:inherit;font-weight:600}.dsh-ms ::selection{background:#365cc7;color:#fff;text-shadow:none}
@media(max-width:640px){.dsh-ms{padding:28px 16px}.dsh-ms .grid{grid-template-columns:1fr}.dsh-ms .card{padding:14px}}
`;
function Icon({size = 18}) {
  return h('svg', {width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true},
    h('path', {d: 'M4 7h16M4 17h16'}), h('circle', {cx: 9, cy: 7, r: 3, fill: 'var(--dsw-alias-bg-base,transparent)'}),
    h('circle', {cx: 16, cy: 17, r: 3, fill: 'var(--dsw-alias-bg-base,transparent)'}));
}
async function api(payload) {
  const response = await fetch(PATH, {method: payload ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
    ...(payload ? {headers: {'content-type': 'application/json'}, body: JSON.stringify(payload)} : {})});
  let value;
  try {value = await response.json();}
  catch {throw Object.assign(new Error(`接口返回非 JSON（HTTP ${response.status}）；请刷新核对。`), {status: response.status, unknown: true});}
  if (!response.ok) throw Object.assign(new Error(value.error || `请求失败：${response.status}`), {status: response.status, value, knownRejected: !value.partial});
  return value;
}
function routeText(route) {return route?.provider && route?.model ? `${route.provider} / ${route.model}` : '跟随队长（未钉住）';}
function equalRoute(a, b) {
  return a?.provider === b?.provider && a?.model === b?.model
    && (a?.reasoningEffort ?? '') === (b?.reasoningEffort ?? '');
}
async function applyDefaults(selection, targets, latest, allowOwnRetry, request = api) {
  try {return await request({...selection, targets, revision: latest.revision});}
  catch (error) {
    if (!allowOwnRetry || error.status !== 409) throw error;
    // Native current-session selection saves the default asynchronously. That own save
    // can commit between our GET and POST. Retry ONCE only if it saved our exact choice
    // and the member route/activation is still unchanged. Never mask unrelated edits.
    const fresh = await request();
    if (!equalRoute(fresh.newSession, selection) || !equalRoute(fresh.members, latest.members)
      || fresh.members.instance !== latest.members.instance) throw error;
    return request({...selection, targets, revision: fresh.revision});
  }
}
exports.applyDefaults = applyDefaults;
async function membersApi(payload, batch = false) {
  const response = await fetch(`${PATH}/members${batch ? '/batch' : ''}`, {method: payload ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
    ...(payload ? {headers: {'content-type': 'application/json'}, body: JSON.stringify(payload)} : {})});
  let value;
  try {value = await response.json();}
  catch {throw Object.assign(new Error(`成员接口返回非 JSON 响应（HTTP ${response.status}）；无法确认是否已应用，请刷新核对。`), {status: response.status, unknown: true});}
  if (!response.ok) throw Object.assign(new Error(value?.error || `请求失败：HTTP ${response.status}`), {status: response.status, value});
  if (!value || typeof value !== 'object') throw Object.assign(new Error('成员接口返回无效结果；无法确认是否已应用，请刷新核对。'), {unknown: true});
  return value;
}
function memberRouteText(route) {
  return route?.provider && route?.model
    ? `${route.provider} / ${route.model} · 推理：${route.reasoningEffort || '模型默认'}` : '未提供（不能据此推断路由）';
}
function selectionOf(provider, model, effort) {return {provider, model, ...(effort ? {reasoningEffort: effort} : {})};}
function mainRetryKey(selection, scopes, sessionId) {return JSON.stringify([sessionId, !!scopes.current, !!scopes.newSession, !!scopes.members, selection.provider, selection.model, selection.reasoningEffort ?? '']);}
function mainApplyState(selection, scopes, values, retry = false) {
  const changes = [];
  if (scopes.current && !equalRoute(values.current, selection)) changes.push('current');
  if ((scopes.newSession || scopes.current) && !equalRoute(values.newSession, selection)) changes.push('newSession');
  // The future-member DEFAULT endpoint changes provider/model only, not effort.
  if (scopes.members && (values.members?.provider !== selection.provider || values.members?.model !== selection.model)) changes.push('members');
  const selected = !!(scopes.current || scopes.newSession || scopes.members);
  return {selected, changes, retry: selected && retry, needed: selected && (retry || changes.length > 0), unchanged: selected && !retry && changes.length === 0};
}
function memberRetryKey(teamKey, memberId, selection) {return JSON.stringify([teamKey, memberId, selection.provider, selection.model, selection.reasoningEffort ?? '']);}
function memberTargets(team, mode, memberId) {
  if (!team || !Array.isArray(team.members)) return [];
  // Deliberately do NOT filter unsafe/removed records; never silently shrink a batch.
  return mode === 'all' ? team.members.slice() : team.members.filter(member => member.id === memberId);
}
function memberApplyState(teamKey, targets, selection, retries = {}) {
  const changed = targets.filter(member => !equalRoute(member.selected, selection)).length;
  const retry = targets.some(member => retries[memberRetryKey(teamKey, member.id, selection)] === true);
  return {count: targets.length, changed, retry, needed: targets.length > 0 && (changed > 0 || retry), unchanged: targets.length > 0 && !changed && !retry};
}
function captureMemberRequest(team, mode, memberId, selection) {
  const targets = memberTargets(team, mode, memberId);
  if (!team?.key || !targets.length) throw new Error('请明确选择团队和已启动成员。');
  const ids = new Set();
  const members = targets.map(member => {
    if (typeof member.id !== 'string' || !member.id || ids.has(member.id) || typeof member.revision !== 'string' || !member.revision) throw new Error('成员 ID / 版本无效或重复，请刷新核对；不会替换目标。');
    ids.add(member.id);
    return Object.freeze({memberId: member.id, memberName: member.name, revision: member.revision});
  });
  return Object.freeze({teamKey: team.key, teamName: team.name, mode, ...selection, members: Object.freeze(members), requested: members.length});
}
function memberOutcome(result, requested, httpError) {
  const exact = result?.member?.id === requested.memberId;
  const effective = result?.effective === 'futureSteps' || result?.effective === 'nextActivation';
  const complete = !httpError && result?.applied === true && !result.partial && !result.error && exact && effective && equalRoute(result.member.selected, requested);
  const partial = result?.partial === true;
  const rejected = result?.applied === false && !!result.error || httpError?.status >= 400 && httpError.status < 500 && !httpError.unknown && result?.applied !== true;
  const unknown = !complete && !partial && (!rejected || httpError?.unknown || (!httpError?.status && httpError));
  return {complete, exact, status: complete ? (result.noChange ? 'noChange' : 'succeeded') : partial ? 'partial' : unknown ? 'unknown' : 'failed', retry: !!(partial || unknown)};
}
function memberApplyNotice(result, requested, httpError) {
  const outcome = memberOutcome(result, requested, httpError);
  const notes = [`目标：${requested.teamName} / ${requested.memberName}（${requested.memberId}）`, `本次请求：${memberRouteText(requested)}`];
  if (httpError) notes.push(`请求失败（HTTP ${httpError.status ?? '未知'}）：${httpError.message}`);
  if (result?.partial) notes.push('仅部分应用，不能视为全部成功；请核对下方返回的已保存路由，并刷新成员列表。');
  else if (outcome.complete) notes.push('已保存所选既有成员的手动模型路由。');
  else if (result?.applied === true) notes.push('服务端报告已应用，但返回状态不完整或同时有错误；不能确认完整成功，请刷新核对。');
  else notes.push('未确认应用成功；请刷新核对该成员，勿将失败视为完全未保存。');
  if (result?.error && result.error !== httpError?.message) notes.push(`服务端说明：${result.error}`);
  if (outcome.exact) notes.push(`返回的实际选择 / 已保存路由：${memberRouteText(result.member.selected)}`);
  else if (result?.member) notes.push('返回成员与请求目标不一致；未把返回结果写入其他成员。');
  if (outcome.complete && result.effective === 'futureSteps') notes.push('后续尚未开始准备的模型步骤使用新模型。');
  if (outcome.complete && result.effective === 'nextActivation') notes.push('下次激活时使用，未唤醒成员。');
  if (result?.applied || result?.partial) notes.push('当前步骤已捕获的路由及其重试仍可能使用旧模型；不更改全局默认或队长，不中断、唤醒或重试成员。');
  return {error: !outcome.complete, text: notes.join('\n')};
}
function batchApplyNotice(result, requested, httpError) {
  const ids = new Set(requested.members.map(member => member.memberId));
  const raw = Array.isArray(result?.results) ? result.results : [];
  const returned = new Map(), duplicateIds = new Set();
  let envelope = !httpError && result?.teamKey === requested.teamKey && result?.requested === requested.requested && raw.length === requested.requested;
  for (const row of raw) {
    if (!row || !ids.has(row.memberId)) {envelope = false; continue;}
    if (returned.has(row.memberId)) {duplicateIds.add(row.memberId);envelope = false;continue;}
    returned.set(row.memberId, row);
  }
  const rows = requested.members.map(target => {
    const row = returned.get(target.memberId);
    const exactTarget = !duplicateIds.has(target.memberId) && result?.teamKey === requested.teamKey && row?.memberId === target.memberId && row?.memberName === target.memberName;
    const request = {...requested, ...target};
    const outcome = exactTarget ? memberOutcome(row, request, httpError) : {complete: false, exact: false, status: 'unknown', retry: true};
    const notice = exactTarget ? memberApplyNotice(row, request, httpError) : {error: true, text: `目标：${target.memberName}（${target.memberId}）\n结果缺失、重复或目标不一致；不能确认成功，不会替换为其他成员。`};
    return {...target, ...outcome, text: notice.text, member: exactTarget && outcome.exact ? row.member : undefined};
  });
  const summary = {succeeded: rows.filter(row => row.complete).length, failed: rows.filter(row => row.status === 'failed').length,
    partial: rows.filter(row => row.status === 'partial').length, noChange: rows.filter(row => row.status === 'noChange').length, unknown: rows.filter(row => row.status === 'unknown').length};
  const reported = result?.summary;
  const summaryValid = reported && ['succeeded','failed','partial','noChange'].every(key => Number.isInteger(reported[key]) && reported[key] === summary[key]);
  const complete = envelope && summaryValid && result?.applied === true && !result.partial && !result.error && rows.every(row => row.complete);
  const malformed = !envelope || !summaryValid || (rows.every(row => row.complete) && !complete);
  if (malformed) rows.forEach(row => {row.retry = true;});
  const heading = complete ? `已确认 ${requested.requested} 名成员的模型选择（未变化 ${summary.noChange} 名）。`
    : `整批未全部确认：成功 ${summary.succeeded}、失败 ${summary.failed}、部分 ${summary.partial}、未知 ${summary.unknown}；请逐成员核对。`;
  const notes = [`目标：${requested.teamName} · ${requested.requested} 名已启动成员`, `本次请求：${memberRouteText(requested)}`];
  if (httpError) notes.push(`请求失败：${httpError.message}`);
  if (malformed) notes.push('整批返回的团队、成员集合、数量或统计不完整 / 不一致；不能确认完整成功。');
  if (result?.error) notes.push(`服务端说明：${result.error}`);
  return {error: !complete, summary: heading, text: notes.join('\n'), rows, counts: summary, complete};
}
Object.assign(exports, {membersApi, mainApplyState, mainRetryKey, memberApplyState, memberRetryKey, memberTargets, captureMemberRequest, memberOutcome, memberApplyNotice, batchApplyNotice, CSS});
function Message({notice}) {
  if (!notice) return null;
  const summary = notice.summary || notice.text?.split('\n')[0] || '请核对操作结果。';
  return h('div', {className: `dsh-ms-message ${notice.error ? 'dsh-ms-message--error' : 'dsh-ms-message--success'}`, role: notice.error ? 'alert' : 'status'},
    h('div', null, summary), notice.text && h('details', null, h('summary', null, '查看详细结果'), h('div', {className: 'dsh-ms-message-body'}, notice.text)),
    notice.rows && h('div', null, ...notice.rows.map(row => h('div', {key: row.memberId, className: 'dsh-ms-batch-row'},
      h('div', {className: row.complete ? 'dsh-ms-status--good' : 'dsh-ms-status--bad'}, `${row.memberName} · ${row.memberId}：${({succeeded:'已确认',noChange:'未变化（已确认）',partial:'部分应用',unknown:'未确认',failed:'失败'})[row.status]}`),
      h('details', null, h('summary', null, '成员结果与路由'), h('div', {className: 'dsh-ms-message-body'}, row.text))))));
}
const EMPTY_SESSIONS = select => select({byId: {}});
function makePanel(ctx) {
  return function ModelSwitch({useSessions = EMPTY_SESSIONS}) {
    const selectedSession = useSessions(state => Object.values(state.byId).find(s => (s.retainedBy?.mainView ?? 0) > 0)?.id ?? null);
    const sessionId = selectedSession;
    const sessionTitle = useSessions(state => state.byId[sessionId]?.title ?? '未选择普通会话');
    const [data, setData] = useState(null);
    const [provider, setProvider] = useState('');
    const [model, setModel] = useState('');
    const [effort, setEffort] = useState('');
    const [query, setQuery] = useState('');
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState(null);
    const [current, setCurrent] = useState(null);
    const [targetCurrent, setTargetCurrent] = useState(false);
    const [targetDefault, setTargetDefault] = useState(false);
    const [targetMembers, setTargetMembers] = useState(true);
    const [memberData, setMemberData] = useState(null);
    const [teamKey, setTeamKey] = useState('');
    const [memberId, setMemberId] = useState('');
    const [membersLoading, setMembersLoading] = useState(true);
    const [memberBusy, setMemberBusy] = useState(false);
    const [memberNotice, setMemberNotice] = useState(null);
    const [memberMode, setMemberMode] = useState('single');
    const [defaultRetry, setDefaultRetry] = useState('');
    const [memberRetries, setMemberRetries] = useState({});
    const memberGeneration = useRef(0);
    const memberRefreshing = useRef(false);
    const memberApplying = useRef(false);
    const mainApplying = useRef(false);
    const alive = useRef(true);
    const generation = useRef(0);
    useEffect(() => {alive.current = true; return () => {alive.current = false; generation.current++; memberGeneration.current++;};}, []);
    const refresh = async initial => {
      const gen = ++generation.current;
      setLoading(true);
      try {
        const next = await api();
        if (!alive.current || gen !== generation.current) return;
        setData(next);
        if (initial) {const route = next.members.available ? next.members : next.newSession;setProvider(route.provider || next.groups[0]?.id || '');setModel(route.model || next.groups[0]?.models[0]?.id || '');}
      } catch (error) {if (alive.current && gen === generation.current) setNotice({error: true, summary: '模型目录加载失败，请刷新。', text: error.message});}
      finally {if (alive.current && gen === generation.current) setLoading(false);}
    };
    const refreshMembers = async () => {
      if (memberApplying.current) return;
      const gen = ++memberGeneration.current;
      memberRefreshing.current = true;
      setMembersLoading(true);
      try {
        const next = await membersApi();
        if (!alive.current || gen !== memberGeneration.current) return;
        if (typeof next.available !== 'boolean' || !Array.isArray(next.teams)) throw new Error('成员列表格式无效；请刷新重试。');
        setMemberData(next); // No target substitution; retry state survives a read-only refresh.
      } catch (error) {if (alive.current && gen === memberGeneration.current) {setMemberData(null);setMemberNotice({error: true, summary: '既有成员加载失败，请刷新。', text: error.message});}}
      finally {if (gen === memberGeneration.current) {memberRefreshing.current = false;if (alive.current) setMembersLoading(false);}}
    };
    useEffect(() => {refresh(true); refreshMembers();}, []);
    useEffect(() => {
      setCurrent(null);
      if (!sessionId || ctx.sessions.subagentAddress(sessionId) !== undefined) return;
      try {const directory = ctx.modelDirectories.directoryFor(sessionId);const update = () => setCurrent(directory.store.getSnapshot().current);update();const off = directory.store.subscribe(update);directory.load().catch(() => {});return off;}
      catch {return undefined;}
    }, [sessionId]);
    const groups = data?.groups ?? [];
    const group = groups.find(g => g.id === provider);
    const candidate = group?.models.find(m => m.id === model);
    const filtered = group?.models.filter(m => `${m.id} ${m.name}`.toLowerCase().includes(query.toLowerCase())) ?? [];
    const canCurrent = !!sessionId && ctx.sessions.subagentAddress(sessionId) === undefined;
    const selection = selectionOf(provider, model, effort);
    const scopes = {current: targetCurrent, newSession: targetDefault, members: targetMembers};
    const defaultKey = mainRetryKey(selection, scopes, sessionId);
    const mainState = mainApplyState(selection, scopes, {current, newSession: data?.newSession, members: data?.members}, defaultRetry === defaultKey);
    const mainDisabled = busy || memberBusy || loading || !candidate || !mainState.needed || (targetCurrent && !canCurrent) || (targetMembers && !data?.members.hot);
    const teams = memberData?.teams ?? [];
    const selectedTeam = teams.find(team => team.key === teamKey);
    const teamMembers = selectedTeam?.members ?? [];
    const selectedMember = teamMembers.find(member => member.id === memberId);
    const targets = memberTargets(selectedTeam, memberMode, memberId);
    const memberState = memberApplyState(teamKey, targets, selection, memberRetries);
    const memberUnavailable = memberMode === 'single' && (selectedMember?.unsafe || ['archived','removed','unspawned'].includes(selectedMember?.status));
    const memberDisabled = busy || memberBusy || loading || membersLoading || !candidate || !memberData?.available || !selectedTeam || !memberState.needed || memberUnavailable;
    const storeMemberResult = (requested, target, member) => {
      if (!member || member.id !== target.memberId) return;
      setMemberData(previous => previous && ({...previous, teams: previous.teams.map(team => team.key === requested.teamKey
        ? {...team, members: team.members.map(item => item.id === target.memberId ? member : item)} : team)}));
    };
    const rememberMemberOutcome = (requested, rows) => setMemberRetries(previous => {
      const next = {...previous};
      for (const row of rows) {const key = memberRetryKey(requested.teamKey, row.memberId, requested);if (row.retry) next[key] = true;else delete next[key];}
      return next;
    });
    const applyMemberSelection = async () => {
      if (memberApplying.current || memberRefreshing.current || mainApplying.current || memberDisabled) return;
      let requested;
      try {requested = captureMemberRequest(selectedTeam, memberMode, memberId, selection);}
      catch (error) {setMemberNotice({error: true, summary: '目标无效；请刷新并重新选择。', text: error.message});return;}
      // ALL ids/revisions/model/scope are immutable snapshots before the first await.
      const batch = requested.mode === 'all';
      const payload = batch ? {teamKey: requested.teamKey, provider: requested.provider, model: requested.model,
        ...(requested.reasoningEffort ? {reasoningEffort: requested.reasoningEffort} : {}), members: requested.members.map(({memberId, revision}) => ({memberId, revision}))}
        : {teamKey: requested.teamKey, memberId: requested.members[0].memberId, revision: requested.members[0].revision, provider: requested.provider, model: requested.model,
          ...(requested.reasoningEffort ? {reasoningEffort: requested.reasoningEffort} : {})};
      memberApplying.current = true;setMemberBusy(true);setMemberNotice(null);
      const finish = (result, error) => {
        if (!alive.current) return;
        if (batch) {
          const notice = batchApplyNotice(result, requested, error);
          for (const row of notice.rows) storeMemberResult(requested, row, row.member);
          rememberMemberOutcome(requested, notice.rows);setMemberNotice(notice);
        } else {
          const target = requested.members[0], single = {...requested, ...target};
          const outcome = memberOutcome(result, single, error);
          if (outcome.exact) storeMemberResult(requested, target, result.member);
          rememberMemberOutcome(requested, [{...target, ...outcome}]);
          setMemberNotice({...memberApplyNotice(result, single, error), summary: outcome.complete ? '所选成员模型已确认保存。' : outcome.retry ? '未全部确认；核对后可显式重新确认持久化。' : '所选成员切换失败，请核对。'});
        }
      };
      try {finish(await membersApi(payload, batch));}
      catch (error) {finish(error.value, error);}
      finally {memberApplying.current = false;if (alive.current) setMemberBusy(false);}
    };
    const applySelection = async () => {
      if (mainApplying.current || memberApplying.current || mainDisabled) return;
      // Capture scope/session/model before any asynchronous native/default save.
      const requested = {selection: {...selection}, scopes: {...scopes}, sessionId, retry: mainState.retry, key: defaultKey, current: current && {...current}, canCurrent};
      mainApplying.current = true;setBusy(true);setNotice(null);
      const notes = [];let ownSave = false;
      try {
        if (requested.scopes.current && (!equalRoute(requested.current, requested.selection) || requested.retry)) {
          if (!requested.canCurrent) throw Object.assign(new Error('请先打开普通会话；已运行子代理不能从这里切换'), {knownRejected: true});
          const result = await ctx.modelDirectories.directoryFor(requested.sessionId).select(requested.selection);
          if (!result.ok) throw Object.assign(new Error(result.error.code === 'session/writer-held' ? '该会话被另一写入端占用；此处没有强行接管。' : result.error.message), {knownRejected: !/transport|cancel|unknown/.test(result.error.code ?? '')});
          ownSave = true;notes.push('当前会话选择已提交；后续尚未开始准备的步骤使用新模型。');
        }
        const defaults = [];
        if (requested.scopes.newSession || requested.scopes.current) defaults.push('newSession');
        if (requested.scopes.members) defaults.push('members');
        if (defaults.length) {
          const latest = await api();
          const result = await applyDefaults(requested.selection, defaults, latest, ownSave);
          if (!Array.isArray(result?.applied)) throw Object.assign(new Error('应用返回不完整；请刷新核对。'), {unknown: true});
          if (alive.current) setData({...latest, ...result});
          if (result.applied.includes('members')) notes.push('新团队成员默认渠道 / 模型已保存；推理档位未修改该默认。');
          if (result.applied.includes('newSession')) notes.push('新会话默认已保存。');
          if (result.partial || result.error || defaults.some(target => !result.applied.includes(target))) throw Object.assign(new Error(result.error || '部分范围未确认保存。'), {partial: true});
        }
        if (alive.current) {setDefaultRetry('');setNotice({error: false, summary: '所选范围已应用，无需重启。', text: notes.join('\n')});}
      } catch (error) {
        if (alive.current) {
          const retry = !!(error.partial || error.unknown || notes.length || !error.knownRejected);
          setDefaultRetry(retry ? requested.key : '');setNotice({error: true, summary: retry ? '未全部确认；核对后可显式重新确认应用。' : '应用失败，请核对。', text: [...notes, error.message, '请刷新核对已应用范围；不会自动重试成员。'].join('\n')});
          refresh(false);
        }
      } finally {mainApplying.current = false;if (alive.current) setBusy(false);}
    };
    const pickProvider = event => {const id = event.target.value;setProvider(id);setModel(groups.find(g => g.id === id)?.models[0]?.id ?? '');setEffort('');setQuery('');};
    const check = (label, checked, change, disabled, help) => h('label', {className: 'check'},
      h('input', {type: 'checkbox', checked, disabled: busy || memberBusy || disabled, onChange: event => change(event.target.checked)}),
      h('span', null, label, help && h('span', {className: 'muted', style: {display: 'block', fontSize: 12}}, help)));
    const mainLabel = busy ? '正在应用…' : !mainState.selected ? '请选择应用范围' : mainState.unchanged ? '当前选择已生效' : mainState.retry ? '重新确认应用 · 无需重启' : '应用 · 无需重启';
    const memberLabel = memberBusy ? `正在应用 ${memberState.count} 名成员…` : memberState.retry ? `重新确认持久化 · ${memberState.count} 名成员`
      : memberState.unchanged ? memberMode === 'all' ? `全部 ${memberState.count} 名成员已是此模型` : '所选成员已是此模型'
      : memberMode === 'all' ? `应用到全部 ${memberState.count} 名已启动成员` : '应用到所选既有成员';
    return h('section', {className: 'dsh-ms', 'data-model-switch': true},
      h('div', {className: 'row', style: {justifyContent: 'space-between'}}, h('h1', null, '模型切换'), h('button', {type: 'button', onClick: () => ctx.layout.selectPanel(null)}, '返回对话')),
      h('p', {className: 'muted'}, '选择渠道、模型和推理档位，再明确选择应用目标。已生效的相同选择不会重复提交。'),
      h('div', {className: 'card'}, h('h2', null, '当前设置'),
        h('div', {className: 'muted'}, `目标会话：${sessionTitle}${sessionId ? ' · ' + sessionId : ''}`),
        h('div', null, '当前会话：', h('code', null, current ? memberRouteText(current) : '请打开普通会话')),
        h('div', null, '新会话默认：', h('code', null, data ? memberRouteText(data.newSession) : '加载中…')),
        h('div', null, '新团队成员默认：', h('code', null, data?.members.available ? routeText(data.members) : '加载中 / 插件未加载')),
        data && !data.members.hot && h('p', {className: 'dsh-ms-message dsh-ms-message--error'}, '团队默认热切换尚未加载，不允许重挂运行中的团队插件。')),
      h('div', {className: 'card'}, h('h2', null, '选择模型'),
        h('div', {className: 'grid'},
          h('label', null, '渠道', h('select', {value: provider, disabled: busy || memberBusy || loading, onChange: pickProvider, 'aria-label': '渠道'},
            !group && provider && h('option', {value: provider}, `${provider}（目录中未找到）`), ...groups.map(item => h('option', {value: item.id, key: item.id}, `${item.name} · ${item.id} (${item.models.length})`)))),
          h('label', null, '模型', h('select', {value: model, disabled: busy || memberBusy || loading, 'aria-label': '模型', onChange: event => {setModel(event.target.value);setEffort('');}},
            !filtered.some(item => item.id === model) && model && h('option', {value: model}, `${model}（当前选中）`), ...filtered.map(item => h('option', {value: item.id, key: item.id}, item.name === item.id ? item.id : `${item.name} · ${item.id}`))))),
        h('label', null, '筛选当前渠道模型', h('input', {type: 'search', placeholder: '例如 deepseek / glm / gpt', value: query, onChange: event => setQuery(event.target.value), disabled: busy || memberBusy})),
        h('label', null, '当前 / 新会话 / 既有成员推理档位', h('select', {value: effort, disabled: busy || memberBusy || !candidate?.efforts.length, onChange: event => setEffort(event.target.value), 'aria-label': '推理档位'},
          h('option', {value: ''}, '模型默认'), ...(candidate?.efforts ?? []).map(item => h('option', {key: item.id, value: item.id}, item.name)))),
        candidate && h('div', {className: 'facts muted'}, h('span', null, `输入：${candidate.input.includes('image') ? '文本 + 图片（配置声明）' : '文本'}`), h('span', null, `上下文：${candidate.contextWindow?.toLocaleString() ?? '渠道默认'}`), h('span', null, `输出上限：${candidate.maxTokens?.toLocaleString() ?? '渠道默认'}`)),
        !candidate && !loading && h('p', {className: 'dsh-ms-message dsh-ms-message--error'}, '请选择已加载目录中的有效渠道 / 模型。'),
        data?.failures?.length > 0 && h('details', {className: 'dsh-ms-warning'}, h('summary', null, '部分渠道目录不可用；其余渠道仍可选。'), h('p', null, data.failures.map(failure => failure.name).join('、'))),
        h('button', {type: 'button', disabled: busy || memberBusy || loading, onClick: () => refresh(false), style: {marginTop: 14}}, loading ? '加载模型目录…' : '刷新全部渠道 / 模型')),
      h('div', {className: 'card'}, h('h2', null, '应用范围'),
        check('当前会话', targetCurrent, setTargetCurrent, !canCurrent, '原生选择会同步保存新会话默认，不强行换掉当前步骤。'),
        check('新会话默认', targetDefault || targetCurrent, setTargetDefault, targetCurrent, '只影响随后创建的普通会话。'),
        check('新团队成员默认（AgentTeams）', targetMembers, setTargetMembers, !data?.members.hot, '仅保存默认渠道 / 模型；推理档位不修改此默认，已有成员不变。'),
        h('details', {className: 'dsh-ms-warning'}, h('summary', null, '路由保存不等于渠道健康检查。'), h('p', null, '不会修改 API Key、渠道 URL 或重试策略，也不会发送付费验证请求。')),
        h('button', {className: !mainDisabled ? 'primary' : '', type: 'button', disabled: mainDisabled, onClick: applySelection}, mainLabel)),
      h(Message, {notice}),
      h('div', {className: 'card', 'data-existing-member-switch': true}, h('h2', null, '已启动的团队成员（AgentTeams）'),
        h('p', {className: 'muted'}, '共用上方所选模型。此处只改明确选择的成员，不改全局默认或队长。'),
        h('div', {className: 'row', style: {justifyContent: 'space-between'}}, h('span', {className: 'muted'}, '仅加载或手动刷新读取，不自动轮询。'), h('button', {type: 'button', disabled: memberBusy || membersLoading, onClick: refreshMembers}, membersLoading ? '加载既有成员…' : '刷新既有成员列表')),
        memberData && !memberData.available && h('p', {className: 'dsh-ms-message dsh-ms-message--error'}, memberData.reason || '既有成员切换暂不可用。'),
        !membersLoading && memberData?.available && !teams.length && h('p', {className: 'muted'}, '没有可列出的已启动团队成员。'),
        h('label', null, '团队', h('select', {value: teamKey, disabled: memberBusy || membersLoading || !memberData?.available, 'aria-label': '既有成员所属团队', onChange: event => {setTeamKey(event.target.value);setMemberId('');}},
          h('option', {value: ''}, '请选择团队'), teamKey && !selectedTeam && h('option', {value: teamKey}, `${teamKey}（列表中已不可用）`), ...teams.map(team => h('option', {key: team.key, value: team.key}, `${team.name} · ${team.workspace} · ${team.teamId}`)))),
        h('div', {className: 'row', role: 'group', 'aria-label': '既有成员应用范围'},
          h('label', {className: 'check'}, h('input', {type: 'radio', name: 'dsh-ms-member-scope', value: 'single', checked: memberMode === 'single', disabled: busy || memberBusy, onChange: () => setMemberMode('single')}), '仅所选成员'),
          h('label', {className: 'check'}, h('input', {type: 'radio', name: 'dsh-ms-member-scope', value: 'all', checked: memberMode === 'all', disabled: busy || memberBusy, onChange: () => setMemberMode('all')}), `所选团队全部已启动成员（${teamMembers.length} 名）`)),
        h('label', null, '已启动成员', h('select', {value: memberId, disabled: memberBusy || membersLoading || !memberData?.available || !selectedTeam || memberMode === 'all', 'aria-label': '既有团队成员', onChange: event => setMemberId(event.target.value)},
          h('option', {value: ''}, '请选择成员'), memberId && !selectedMember && h('option', {value: memberId}, `${memberId}（列表中已不可用）`), ...teamMembers.map(member => h('option', {key: member.id, value: member.id}, `${member.name} · ${member.role} · ${member.status} / ${typeof member.activity === 'object' ? JSON.stringify(member.activity) : (member.activity ?? '活动未知')}${member.cold ? ' · 未驻留' : ''}`)))),
        selectedTeam && h('div', {className: 'muted'}, `团队：${selectedTeam.name} · 工作区：${selectedTeam.workspace}`),
        h('div', {className: 'facts'}, h('strong', null, `本次目标：${memberState.count} 名成员`), h('span', null, memberMode === 'all' ? '整批逐成员处理；不自动跳过或重试。' : '仅当前明确选择的成员。')),
        memberMode === 'all' && targets.length > 0 && h('details', {className: 'dsh-ms-warning'}, h('summary', null, `查看全部 ${targets.length} 名目标（同模型目标也包含在整批中）`), ...targets.map(member => h('div', {key: member.id}, `${member.name} · ${member.id}${member.unsafe ? ' · 身份核对异常，服务端将拒绝' : ''} · ${memberRouteText(member.selected)}`))),
        memberMode === 'single' && selectedMember && h('div', null,
          h('div', {className: 'facts muted'}, h('span', null, `成员：${selectedMember.name} · ${selectedMember.role} · ${selectedMember.id}`), h('span', null, `状态：${selectedMember.status}`), h('span', null, `活动：${typeof selectedMember.activity === 'object' ? JSON.stringify(selectedMember.activity) : (selectedMember.activity ?? '未提供')}`), h('span', null, selectedMember.cold ? '当前服务未驻留；保存时核对写入权，不额外唤醒' : '运行会话：当前步骤不强行改换'), h('span', null, `版本：${selectedMember.revision}`)),
          h('div', null, '实际选择 / 已保存路由：', h('code', null, memberRouteText(selectedMember.selected))),
          h('div', null, 'liveNext（运行会话后续步骤路由，不代表当前步骤）：', h('code', null, memberRouteText(selectedMember.liveNext))),
          h('div', null, 'lastUsed（最近已用路由，不代表已保存选择）：', h('code', null, memberRouteText(selectedMember.lastUsed))),
          h('div', null, '创建时路由：', h('code', null, memberRouteText(selectedMember.creationRoute)))),
        (teamKey && !selectedTeam || memberMode === 'single' && memberId && !selectedMember) && !membersLoading && h('p', {className: 'dsh-ms-message dsh-ms-message--error'}, '所选团队 / 成员已不在列表；不会自动替换，请明确重新选择。'),
        memberUnavailable && h('p', {className: 'dsh-ms-message dsh-ms-message--error'}, '该成员身份不安全、已归档、移除或尚未启动，不能从这里切换。'),
        h('details', {className: 'dsh-ms-warning'}, h('summary', null, '切换只影响后续步骤，不中断、不唤醒、不重试任务。'), h('p', null, '手动选择优先于旧 fallback；原配置保留。当前已准备的步骤及其重试可能继续旧模型，未驻留会话下次激活生效。部分 / 未知结果须逐项核对，可显式重新确认持久化；批量不是一个事务，失败成员不会被自动跳过或重试。')),
        h('div', {className: 'muted'}, '即将应用的共享选择：', h('code', null, memberRouteText(selection))),
        h('button', {className: !memberDisabled ? 'primary' : '', type: 'button', style: {marginTop: 14}, disabled: memberDisabled, onClick: applyMemberSelection}, memberLabel),
        h(Message, {notice: memberNotice})));
  };
}
exports.makePanel = makePanel;
exports.inject = ['slots', 'layout', 'modelDirectories', 'sessions'];
exports.apply = ctx => {
  const Panel = makePanel(ctx);
  ctx.effect(() => {const style = document.createElement('style');style.dataset.pluginCss = '@local/dsh-model-switch';style.textContent = CSS;document.head.appendChild(style);return () => style.remove();});
  ctx.slots.inject('main', () => ctx.slots.register({name: 'main', key: PANEL}, Panel));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({name: 'sidebar.panellist', id: PANEL, order: -2, label: '模型切换'}, Icon));
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({name: 'conversation.session.header.actions', id: 'model-switch-entry', order: 45, inject: () => ({open: () => ctx.layout.selectPanel(PANEL)})}, ({open}) => h('button', {type: 'button', onClick: open, title: '模型切换：当前 / 默认 / 团队成员', 'aria-label': '打开模型切换', style: {border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 6}}, h(Icon, {}))));
};

return module.exports;
}});
