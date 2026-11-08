// Maintenance patches source fields/helpers only. Keep normal bundle/profile
// names (@nanmicoder/dsh-agent-teams and @local/dsh-model-switch) unchanged.
// The separate web-member-model-switch entry owns the HTTP endpoint; never
// re-install an endpoint import/call or an old file-URI wrapper into AgentTeams.
import {readFile,writeFile,copyFile,mkdir,lstat,symlink,stat} from 'node:fs/promises';
import {teamsLibDir,sdkPackages} from './paths.mjs';
const base=teamsLibDir.replace(/\/?$/,'/');
const manualGetter=`export function manualModelSelectionOf(member) {
    const record = member?.manualModelSelection;
    if (record === undefined) return undefined;
    if (record?.version !== 1 || !Number.isSafeInteger(record.selectedAt) || record.selectedAt < 0 || !record.selection || typeof record.selection.provider !== 'string' || record.selection.provider.trim() === '' || typeof record.selection.model !== 'string' || record.selection.model.trim() === '' || (record.selection.reasoningEffort !== undefined && (typeof record.selection.reasoningEffort !== 'string' || record.selection.reasoningEffort.trim() === ''))) throw new Error('agent-teams: invalid manual model selection');
    return { provider: record.selection.provider, model: record.selection.model, ...record.selection.reasoningEffort === undefined ? {} : { reasoningEffort: record.selection.reasoningEffort } };
}
`;
const plans=[
 ['members.js',[
  ['function selectionFromMember(member) {', manualGetter+'function selectionFromMember(member) {\n    const manual = manualModelSelectionOf(member);\n    if (manual !== undefined) return manual;'],
  ['        if (member === undefined)\n            return;\n        member.activeProvider = fallback.provider;', '        if (member === undefined || member.manualModelSelection !== undefined)\n            return;\n        member.activeProvider = fallback.provider; // LOCAL_DSH_EXISTING_MEMBER_SWITCH'],
  ['            const transition = selectFallbackRoute(selectionRef.current ?? { provider: selection.provider, model: selection.model }, fallback, payload.failure.code, switched);', "            const latestManualTeam = readTeamSync(stateRoot, teamId);\n            const latestManualMember = latestManualTeam?.captainSessionId === parentSessionId ? latestManualTeam.members.find(item => item.id === child.id && item.name === memberName && item.status !== 'removed') : undefined;\n            if (latestManualMember?.manualModelSelection !== undefined) return next();\n            const transition = selectFallbackRoute(selectionRef.current ?? { provider: selection.provider, model: selection.model }, fallback, payload.failure.code, switched);"],
  ['        let lastFailedTurn;', `        const manualRoute = manualModelSelectionOf(savedMember);
        if (manualRoute !== undefined && (child.model.current()?.provider !== manualRoute.provider || child.model.current()?.model !== manualRoute.model || (child.model.current()?.reasoningEffort ?? '') !== (manualRoute.reasoningEffort ?? ''))) {
            // The valid, exact-member persisted user intent recovers a partial team/log commit.
            // Never silently replace a newer explicit session selection from another writer.
            const lastSelection = sessionOwnEvents(child.session).filter(event => event.type === 'model/selection').at(-1);
            if (lastSelection !== undefined && lastSelection.time > savedMember.manualModelSelection.selectedAt && (lastSelection.data.provider !== manualRoute.provider || lastSelection.data.model !== manualRoute.model || (lastSelection.data.reasoningEffort ?? '') !== (manualRoute.reasoningEffort ?? ''))) throw new Error('agent-teams: manual route conflicts with a newer session selection');
            child.model.select(modelSelection(manualRoute));
        }
        let lastFailedTurn;`],
 ]],
 ['snapshot.js',[
  ['import { memberActivity } from "./members.js";', 'import { memberActivity, manualModelSelectionOf } from "./members.js?dsh-model-switch-v1";'],
  ["    const provider = member.provider?.trim() ?? '';\n    const model = member.model?.trim() ?? '';", "    const manual = manualModelSelectionOf(member);\n    const provider = (manual?.provider ?? member.provider)?.trim() ?? '';\n    const model = (manual?.model ?? member.model)?.trim() ?? '';"],
  ["    const members = roster.map((member) => {\n        const owned", "    const members = roster.map((member) => {\n        const manual = manualModelSelectionOf(member);\n        const owned"],
  ["            provider: member.provider?.trim() ?? '',\n            model: member.model?.trim() ?? '',\n            reasoningEffort: member.reasoningEffort?.trim() ?? '',", "            provider: (manual?.provider ?? member.provider)?.trim() ?? '',\n            model: (manual?.model ?? member.model)?.trim() ?? '',\n            reasoningEffort: manual !== undefined ? (manual.reasoningEffort ?? '') : (member.reasoningEffort?.trim() ?? ''),"],
 ]],
 ['tools.js',[
  ['import { deliverToMember, installRetiredMemberGuard, installMemberSelectionRuntime, installMemberDelegationGuard, memberActivity, resolveMemberLlmSelection, spawnMember, steerCaptainReport, validateMemberLlmSelections, } from "./members.js";', 'import { deliverToMember, installRetiredMemberGuard, installMemberSelectionRuntime, installMemberDelegationGuard, memberActivity, resolveMemberLlmSelection, spawnMember, steerCaptainReport, validateMemberLlmSelections, } from "./members.js?dsh-model-switch-v1";'],
  ['export { steerCaptainReport } from "./members.js";', 'export { steerCaptainReport } from "./members.js?dsh-model-switch-v1";'],
 ]],
 ['index.js',[
  ['import { haltTeamWork, stagedPlanApprovedContext, registerAgentTeamsTools, } from "./tools.js";', 'import { haltTeamWork, stagedPlanApprovedContext, registerAgentTeamsTools, } from "./tools.js?dsh-model-switch-v1";'],
  ['import { collectArchivedTeamsActivity, collectTeamsActivity } from "./snapshot.js";', 'import { collectArchivedTeamsActivity, collectTeamsActivity } from "./snapshot.js?dsh-model-switch-v1";'],  ['import { findTeamByCaptain } from "./state.js";', 'import { findTeamByCaptain, readTeam, writeTeam, withTeamLock } from "./state.js";'],
  ['export function apply(ctx, config) {\n    const resolved = {', "export function apply(ctx, config) {\n    ctx.reflect.provide('agentTeamsExistingModelAPI', { version: 1, ownerFiberUid: ctx.fiber.uid, active: () => ctx.fiber.state === 2, readTeam, writeTeam, withTeamLock, collectTeamsActivity });\n    const resolved = {"],  ['    memberModel: z.string(),', '    memberModel: z.string().volatile(), // LOCAL_DSH_MODEL_SWITCH'],
  ['    memberLlmProvider: z.string(),', '    memberLlmProvider: z.string().volatile(),'],
  ['        memberModel: config.memberModel,', '        get memberModel() { return typeof config.memberModel?.get === "function" ? config.memberModel.get() : config.memberModel; },'],
  ['        memberLlmProvider: config.memberLlmProvider,', '        get memberLlmProvider() { return typeof config.memberLlmProvider?.get === "function" ? config.memberLlmProvider.get() : config.memberLlmProvider; },'],
  ['export function apply(ctx, config) {', 'export const EXISTING_MEMBER_MODEL_SWITCH_VERSION = 1;\nexport { readTeam, writeTeam, withTeamLock } from "./state.js";\nexport { collectTeamsActivity } from "./snapshot.js?dsh-model-switch-v1";\nexport function apply(ctx, config) {'],
 ]],
];
try {
 const sdk=sdkPackages;
 const peers=base+'../node_modules/@deepseek-ai';await mkdir(peers,{recursive:true});
 for(const name of ['cordis','schemastery','dsh-agent','dsh-commands','dsh-llm','dsh-session','dsh-session-projection','dsh-subagent','dsh-system-prompt','dsh-tools','dsh-util-values']){await stat(sdk+'/'+name);try{await lstat(peers+'/'+name);}catch(error){if(error.code!=='ENOENT')throw error;await symlink(sdk+'/'+name,peers+'/'+name,'dir');}}
 const edits=[];
 for(const [filename,changes] of plans){
  const path=base+filename;const before=await readFile(path,'utf8');let after=before;
  for(const [old,next] of changes){if(after.includes(next))continue;if(after.split(old).length!==2)throw Error(`${filename}: unsupported source version; refusing broad replacement`);after=after.replace(old,next);}
  edits.push({path,before,after});
 }
 // Validate EVERY file before writing any. Loaded index capability marker is written last.
 for(const {path,before,after} of edits){if(before===after)continue;await copyFile(path,`${path}.model-switch-backup-${Date.now()}`);await writeFile(path,after,'utf8');}
 console.log('AgentTeams model switching adapter ready: hot defaults, manual effective routes, fallback precedence, and partial-intent recovery. No team/task state changed.');
}catch(error){console.error(`model-switch: adapter unavailable (${error.message}); unsupported writes remain disabled.`);if(process.argv.includes('--strict'))process.exitCode=1;}
