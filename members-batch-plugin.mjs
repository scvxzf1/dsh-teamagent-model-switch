// Batch-only HTTP surface. This fresh entry does not reload the running Team
// or the original member-selection/future-activation guards.
import {teamsModule} from './paths.mjs';
const {readTeam, writeTeam, withTeamLock} = await import(teamsModule('state.js'));
const {collectTeamsActivity} = await import(teamsModule('snapshot.js'));
import {stateDirFor} from './members-plugin.mjs';
import {installMembersEndpoint} from './existing-members.mjs?batch-controls-v1';
export const name='web-member-model-switch-batch';
export const inject=['agents','subagents'];
export function apply(ctx) {
  installMembersEndpoint(ctx,{version:1,readTeam,writeTeam,withTeamLock,collectTeamsActivity,get stateDir(){return stateDirFor(ctx);}},{batchOnly:true});
}
