#!/bin/bash
set -euo pipefail
umask 077
release_sha=de4b0aace9343f304572e2873ceee690d656c71d
build_dir=/tmp/private-finances-de4b0aa-build
# First installation only. Fail closed if a previous app configuration exists.
test ! -e /etc/private-finances/app.env
test ! -e /opt/private-finances/current
test -f "$build_dir/dist/src/main.js"
useradd --system --home-dir /var/lib/private-finances --create-home --shell /usr/sbin/nologin private-finances
install -d -m 755 /opt/private-finances/releases
install -d -m 700 /etc/private-finances
install -d -m 700 /etc/private-finances/credentials
install -d -m 700 /var/lib/private-finances/predeploy
cp -a "$build_dir" "/opt/private-finances/releases/$release_sha"
chown -R root:root "/opt/private-finances/releases/$release_sha"
chmod -R go+rX "/opt/private-finances/releases/$release_sha"
sudo -u postgres createuser --no-superuser --no-createdb --no-createrole private-finances
sudo -u postgres createdb --owner=private-finances private_finances
sudo -u postgres pg_dump -Fc private_finances > /var/lib/private-finances/predeploy/initial-empty.dump
python3 - <<'PY'
import secrets,os
fd=os.open('/etc/private-finances/app.env',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as f:
 f.write('DATABASE_URL="postgresql:///private_finances?host=/var/run/postgresql&user=private-finances"\n')
 # Each owner signs in with their own address; the address is the identity and
 # the password below is the first one, set on every boot from this file.
 f.write('RODION_EMAIL=\nKATYA_EMAIL=\n')
 f.write('RODION_PASSWORD='+secrets.token_hex(24)+'\nKATYA_PASSWORD='+secrets.token_hex(24)+'\n')
 f.write('RELEASE_SHA=de4b0aace9343f304572e2873ceee690d656c71d\n')
PY
install -m 644 "$build_dir/deploy/private-finances.service" /etc/systemd/system/private-finances.service
ln -s "/opt/private-finances/releases/$release_sha" /opt/private-finances/current
systemctl daemon-reload
systemctl enable --now private-finances.service
