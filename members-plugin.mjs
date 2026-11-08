// A NEW Loader entry owns only the existing-member endpoint and future setup.
// Never reload AgentTeams just to install this HTTP surface. The canonical state
// URL deliberately has NO query: it is the running team's original shared lock.
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {teamsModule, sdkDir} from './paths.mjs';
const {readTeam, readTeamSync, writeTeam, withTeamLock, sanitizeKey} = await import(teamsModule('state.js'));
const {collectTeamsActivity} = await import(teamsModule('snapshot.js'));
const {installContinuableMemberSetup, sessionOwnEvents} = await import(teamsModule('harness-compat.js'));
import {installMembersEndpoint, selectedRoute, verifyLineage} from './existing-members.mjs?fresh-endpoint-v1';
const require=createRequire(join(sdkDir,'package.json'));
const {foldSubagentDescriptor}=await import(require.resolve('@deepseek-ai/dsh-subagent'));
export const name='web-member-model-switch';
export const inject=['agents','subagents'];
const same=(a,b)=>a?.provider===b?.provider&&a?.model===b?.model&&(a?.reasoningEffort??'')===(b?.reasoningEffort??'');

export function stateDirFor(ctx) {
  const entry=ctx.get('configEditor')?.entries().find(row=>row.options.id==='agent-teams');
  const stateDir=entry?.fiber?.effectiveConfig?.stateDir??'.agent-teams';
  if(typeof stateDir!=='string'||!stateDir.trim())throw Error('member-switch: invalid team state directory');
  return stateDir;
}

// Synchronous unpublished-child setup only. Existing resident objects are skipped
// at installation, including the compatibility hook's initial hydration pass.
export function recoverFutureManualSelection(child, stateDir, readSaved=readTeamSync) {
  const ownEvents=sessionOwnEvents(child.session);
  const descriptor=foldSubagentDescriptor(ownEvents);
  if(descriptor?.mode!=='continuable'||!descriptor.label.startsWith('agent-teams:'))return false;
  const identity=descriptor.label.slice('agent-teams:'.length), separator=identity.indexOf(':');
  if(separator<1||separator===identity.length-1)return false;
  const teamId=identity.slice(0,separator), memberName=identity.slice(separator+1);
  if(sanitizeKey(teamId)!==teamId)throw Error('member-switch: invalid team descriptor key');
  const header=child.session.header;
  if(!header.cwd||!header.parentSession)return false;
  const team=readSaved(join(header.cwd,stateDir),teamId);
  if(!team||team.captainSessionId!==header.parentSession)return false;
  const member=team.members.find(row=>row.id===child.id&&row.name===memberName&&row.status!=='removed');
  if(!member||member.manualModelSelection===undefined)return false;
  verifyLineage(header,ownEvents,0,team,member,header.cwd);
  if((descriptor.agentReasoningEffort??'')!==(member.reasoningEffort??''))throw Error('member-switch: immutable creation effort mismatch');
  const wanted=selectedRoute(member); // validates full versioned manual intent
  if(!child.model||typeof child.model.current!=='function'||typeof child.model.select!=='function')throw Error('member-switch: durable child model selection is unavailable');
  if(same(child.model.current(),wanted))return false;
  const latest=ownEvents.filter(event=>event.type==='model/selection').at(-1);
  // Equal millisecond timestamps have no trustworthy order. Refuse rather than
  // silently overwrite a possibly newer genuine choice from another writer.
  if(latest&&latest.time>=member.manualModelSelection.selectedAt&&!same(latest.data,wanted))throw Error('member-switch: manual route conflicts with a newer or unordered session selection');
  child.model.select(wanted);
  return true;
}

export function installFutureManualSetup(ctx, install=installContinuableMemberSetup, recover=recoverFutureManualSelection) {
  const initial=new WeakSet(ctx.agents.list());
  let installing=true;
  install(ctx,(_childCtx,child)=>{
    if(!installing&&!initial.has(child))recover(child,stateDirFor(ctx));
    return ()=>{};
  });
  installing=false;
}

export function apply(ctx) {
  const api={version:1,readTeam,writeTeam,withTeamLock,collectTeamsActivity,
    get stateDir(){return stateDirFor(ctx);}};
  installMembersEndpoint(ctx,api,{singleOnly:true});
  installFutureManualSetup(ctx);
}
