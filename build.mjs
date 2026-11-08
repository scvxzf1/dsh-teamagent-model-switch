import { readFile, writeFile } from 'node:fs/promises';
const source = await readFile(new URL('./client.cjs', import.meta.url), 'utf8');
// No bundled copy of React, SDK or credentials. Use the existing DSH browser module table.
const bundle = `window.__ModuleLoader__.load({id:"@local/dsh-model-switch",factory:(require)=>{\nconst module={exports:{}}; const exports=module.exports;\n${source}\nreturn module.exports;\n}});\n`;
await writeFile(new URL('./client.js', import.meta.url), bundle, 'utf8');
console.log('Built @local/dsh-model-switch/client.js');
