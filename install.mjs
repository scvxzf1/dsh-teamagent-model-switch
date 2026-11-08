#!/usr/bin/env node
// Generates this checkout's cordis.patch.yml (absolute file URLs) and reports
// whether the prerequisites for the existing-member switch are installed.
import {existsSync, readFileSync} from 'node:fs';
import {readFile, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dshHome, profileDir, teamsLibDir} from './paths.mjs';

const pluginDir = dirname(fileURLToPath(import.meta.url));
const pluginUrl = pathToFileURL(pluginDir).href.replace(/\/$/, '');
const template = await readFile(join(pluginDir, 'cordis.patch.template.yml'), 'utf8');
await writeFile(join(pluginDir, 'cordis.patch.yml'), template.replaceAll('__PLUGIN_URL__', pluginUrl), 'utf8');

const read = path => (existsSync(path) ? readFileSync(path, 'utf8') : '');
const stateFile = join(teamsLibDir, 'state.js');
const membersFile = join(teamsLibDir, 'members.js');

console.log(`plugin directory : ${pluginDir}`);
console.log(`bundle patch     : ${join(pluginDir, 'cordis.patch.yml')}`);
console.log(`DSH home         : ${dshHome}`);
console.log(`profile          : ${profileDir}`);
console.log(`AgentTeams lib   : ${teamsLibDir}`);

let ok = true;
if (!read(stateFile)) {
  ok = false;
  console.error('\n[missing] @nanmicoder/dsh-agent-teams is not installed in this profile.');
  console.error('  Install it first (dsh plugin --profile <name> add @nanmicoder/dsh-agent-teams)');
  console.error('  or point DSH_TEAMS_LIB at its lib/ directory.');
} else if (!read(membersFile).includes('manualModelSelectionOf')) {
  console.error('\n[pending] AgentTeams is installed but not patched yet. Run: node patch-teams.mjs');
} else {
  console.log('[ok] AgentTeams patch already applied.');
}

console.log(`
Next steps
  1. Register this directory in the profile package.json:
       "dependencies": { "@local/dsh-model-switch": "link:${pluginDir}" }
  2. Add "@local/dsh-model-switch" to dsh.profile.bundles (last entry is fine).
  3. Install the profile dependencies, then run: node patch-teams.mjs
  4. Restart the DSH Web service once (new Loader entries cannot hot-import),
     then reload the browser page. Later Apply actions never restart DSH.
`);
if (!ok) process.exitCode = 1;
