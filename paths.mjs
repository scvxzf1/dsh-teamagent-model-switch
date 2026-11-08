// Machine-independent locations. Every value can be overridden for a custom
// install; the defaults match a standard `dsh` profile named "web".
import {homedir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

export const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
export const profileName = process.env.DSH_PROFILE ?? 'web';
export const profileDir = join(dshHome, 'profiles', profileName);
// Installed @nanmicoder/dsh-agent-teams library (patched in place by patch-teams.mjs).
export const teamsLibDir = process.env.DSH_TEAMS_LIB
  ?? join(profileDir, 'node_modules', '@nanmicoder', 'dsh-agent-teams', 'lib');
// The global dsh package that owns the host SDK packages.
export const sdkDir = process.env.DSH_SDK ?? '/usr/lib/node_modules/@deepseek-ai/dsh';
export const sdkPackages = join(sdkDir, 'node_modules', '@deepseek-ai');
export const teamsModule = name => pathToFileURL(join(teamsLibDir, name)).href;
