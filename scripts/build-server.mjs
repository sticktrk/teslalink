import { build } from 'esbuild';
import { resolve } from 'node:path';
await build({entryPoints:['server/main.mjs'],outfile:'dist-node/server.mjs',bundle:true,platform:'node',format:'esm',target:'node24',alias:{'cloudflare:workers':resolve('server/cloudflare-shim.mjs')}});
console.log('Built native server: dist-node/server.mjs');
