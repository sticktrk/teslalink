#!/usr/bin/env python3
"""Initial server environment. Preserves existing app credentials on repeat runs."""
import json, os, pathlib, shutil
root=pathlib.Path('/var/www/tesla')
source=root/'.env' if (root/'.env').exists() else root/'.dev.vars'
values={}
for line in source.read_text().splitlines():
    if '=' in line and not line.startswith('#'):
        key,value=line.split('=',1)
        values[key]=json.loads(value) if value.startswith('"') else value
values.update(APP_URL='https://tesla.dtconcepts.net',PORT='8788',DATABASE_PATH='/var/www/tesla/data/tesla.sqlite',TESLA_REGION='na',RETENTION_DAYS='30',SNAPSHOT_COOLDOWN_SECONDS='900',SNAPSHOT_DAILY_LIMIT='24',STORAGE_API_URL='https://teslalink-storage.ratebucket.workers.dev',STORAGE_API_TOKEN=(root/'.storage-token').read_text().strip(),TELEMETRY_HOST='ssh.dtconcepts.net',TELEMETRY_PORT='9443',TELEMETRY_PROXY_URL='https://tesla.dtconcepts.net',TELEMETRY_CA=pathlib.Path('/etc/ssl/certs/ISRG_Root_X1.pem').read_text())
(root/'.env').write_text(''.join(f'{k}={json.dumps(v)}\n' for k,v in values.items()))
os.chmod(root/'.env',0o640)
shutil.chown(root/'.env',user='root',group='tesla')
receiver={'APP_INGEST_URL':values['APP_URL']+'/api/ingest','INGEST_TOKEN':values['INGEST_TOKEN'],'TELEMETRY_PROXY_TOKEN':values['TELEMETRY_PROXY_TOKEN'],'ALLOWED_VINS':'','TELEMETRY_BIND':'0.0.0.0:9443','GATEWAY_BIND':'127.0.0.1:8443'}
(root/'receiver/.env').write_text(''.join(f'{k}={v}\n' for k,v in receiver.items()))
os.chmod(root/'receiver/.env',0o600)
for src,dest in [('fullchain.pem','fullchain.pem'),('privkey.pem','privkey.pem')]:
    shutil.copyfile(pathlib.Path('/etc/letsencrypt/live/tesla-link')/src,root/'receiver/certs'/dest)
os.chmod(root/'receiver/certs',0o750)
os.chown(root/'receiver/certs',0,65532)
os.chmod(root/'receiver/certs/privkey.pem',0o640)
os.chown(root/'receiver/certs/privkey.pem',0,65532)
os.chmod(root/'receiver/secrets',0o750)
os.chown(root/'receiver/secrets',0,65532)
for key in (root/'receiver/secrets').glob('*.pem'):
    os.chmod(key,0o640)
    os.chown(key,0,65532)
shutil.copyfile('/etc/ssl/certs/ISRG_Root_X1.pem',root/'receiver/certs/ca.pem')
(root/'deployment-access.txt').write_text('Tesla Link\nURL: '+values['APP_URL']+'\nApp password: '+values['APP_PASSWORD']+'\n\nSet TESLA_CLIENT_ID and TESLA_CLIENT_SECRET in /var/www/tesla/.env, then systemctl restart tesla-link.\nTesla callback: '+values['APP_URL']+'/auth/callback\n')
os.chmod(root/'deployment-access.txt',0o600)
print('Server and receiver environment configured. Credentials were not printed.')
