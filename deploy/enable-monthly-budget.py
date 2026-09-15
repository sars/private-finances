"""Run as root on the authorized server after exact-head CI and staged tests pass."""
from pathlib import Path
import os, re, subprocess, sys
os.umask(0o077)
sha=sys.argv[1]
if os.geteuid()!=0 or not re.fullmatch('[a-f0-9]{40}',sha): raise SystemExit('invalid_deployment')
def run(*args): subprocess.run(args,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
env=Path('/etc/private-finances/app.env')
original=env.read_text()
model=[line for line in original.splitlines() if line.startswith('OPENAI_MODEL=')]
if len(model)!=1: raise SystemExit('model_configuration_required')
run('systemctl','stop','private-finances-telegram.service')
# The previous version does not enforce a monthly cost cap. A failed switch must
# leave that version unable to send AI requests, while manual features stay usable.
staged=env.with_suffix('.budget-next')
staged.write_text(re.sub(r'^OPENAI_MODEL=.*$', 'OPENAI_MODEL=',original,flags=re.M));staged.chmod(0o600);staged.replace(env)
run('systemctl','restart','private-finances.service')
marker=Path('/etc/private-finances/local-restore-verified')
marker.unlink(missing_ok=True)
subprocess.run(['python3',f'/opt/private-finances/releases/{sha}/deploy/switch-release.py',sha,'--schema-compatible'],check=True)
subprocess.run(['python3','/tmp/pf-restore-check.py'],check=True)
marker.chmod(0o644)
# Preserve RELEASE_SHA written by the guarded switch; restore only model metadata.
current=env.read_text()
staged.write_text(re.sub(r'^OPENAI_MODEL=.*$',model[0],current,flags=re.M));staged.chmod(0o600);staged.replace(env)
run('systemctl','restart','private-finances.service')
run('systemctl','start','private-finances-telegram.service')
print('{"deployment":"completed","monthly_budget_usd":10,"ai_reenabled_after_restore":true}')
