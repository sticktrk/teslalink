#!/usr/bin/env python3
import pathlib, sqlite3, datetime, os
root=pathlib.Path('/var/www/tesla')
backup=root/'backups';backup.mkdir(mode=0o700,exist_ok=True)
path=backup/(datetime.datetime.now(datetime.timezone.utc).strftime('state-%Y%m%d-%H%M%S')+'.sqlite')
with sqlite3.connect('file:'+str(root/'data/tesla.sqlite')+'?mode=ro',uri=True) as source, sqlite3.connect(path) as dest: source.backup(dest)
os.chmod(path,0o600)
for old in sorted(backup.glob('state-*.sqlite'),reverse=True)[7:]:old.unlink()
