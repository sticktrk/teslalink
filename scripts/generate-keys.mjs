import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Never print credentials or replace existing keys. Rotation requires an explicit migration.
const dir = resolve('receiver/secrets');
if (existsSync('.dev.vars') || existsSync(`${dir}/private-key.pem`) || existsSync('receiver/.env')) {
  console.error('Key files already exist. Keep them safe; this script will not overwrite them.');
  process.exit(1);
}
mkdirSync(dir, { recursive: true, mode: 0o700 });
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'sec1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const ingest = randomBytes(32).toString('base64url'), proxy = randomBytes(32).toString('base64url');
writeFileSync(`${dir}/private-key.pem`, privateKey, { mode: 0o600, flag: 'wx' });
writeFileSync(`${dir}/public-key.pem`, publicKey, { mode: 0o644, flag: 'wx' });
const vars = {
  APP_PASSWORD: randomBytes(32).toString('base64url'),
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  TESLA_CLIENT_ID: '', TESLA_CLIENT_SECRET: '', TESLA_PUBLIC_KEY: publicKey.trim(),
  INGEST_TOKEN: ingest, TELEMETRY_HOST: '', TELEMETRY_PORT: '443', TELEMETRY_CA: '',
  TELEMETRY_PROXY_URL: '', TELEMETRY_PROXY_TOKEN: proxy,
};
writeFileSync('.dev.vars', Object.entries(vars).map(([k,v])=>`${k}=${JSON.stringify(v)}`).join('\n')+'\n', { mode: 0o600, flag: 'wx' });
writeFileSync('receiver/.env', `APP_INGEST_URL=https://your-app.example.com/api/ingest\nINGEST_TOKEN=${ingest}\nTELEMETRY_PROXY_TOKEN=${proxy}\nALLOWED_VINS=YOUR_17_CHARACTER_VIN\n`, { mode: 0o600, flag: 'wx' });
console.log('Created .dev.vars, receiver/.env, and receiver/secrets/*.pem. Secrets were not printed. Fill in Tesla credentials and public hostnames, then follow README.md.');
