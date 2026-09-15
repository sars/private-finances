"""One-time, bounded server continuation for the September annual import."""
import json, os, pathlib, re, subprocess, sys, time
os.umask(0o077)
if len(sys.argv)!=2 or not re.fullmatch('[a-f0-9]{40}',sys.argv[1]):
    raise SystemExit('expected_verified_release_sha')
SHA=sys.argv[1]
ROOT=pathlib.Path('/opt/private-finances/releases')/SHA
OWNERS=('rodion','katya')
assert os.geteuid()==0

def run(*args):
    return subprocess.run(args,check=True,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True).stdout

def emit(event, **fields):
    print(json.dumps(dict(event=event,**fields)),flush=True)

def sql(query):
    return run('sudo','-u','postgres','psql','-v','ON_ERROR_STOP=1','-d','private_finances','-At','-c',query)

def main():
    emit('waiting_for_monobank_history')
    deadline=time.monotonic()+3*3600
    try:
        while True:
            states=[dict(line.split('=',1) for line in run('systemctl','show',f'pf-backfill-monobank-{owner}.service','-p','ActiveState','-p','Result','-p','ExecMainStatus').splitlines()) for owner in OWNERS]
            if any(s.get('ActiveState')=='failed' or s.get('Result') not in ('success',) for s in states):
                raise RuntimeError('historical_import_failed')
            if all(s.get('ActiveState')=='inactive' and s.get('ExecMainStatus')=='0' for s in states):
                break
            if time.monotonic()>deadline:
                raise RuntimeError('historical_import_wait_timeout')
            time.sleep(30)
        emit('verifying_current_accounts')
        time.sleep(61) # Respect token spacing before fresh account discovery.
        run('systemd-run','--unit=pf-verify-annual-coverage','--wait','--pipe','--property=User=private-finances','--property=Group=private-finances','--property=EnvironmentFile=/etc/private-finances/app.env','--property=EnvironmentFile=/etc/private-finances/sync.env','--property=RuntimeMaxSec=180','/usr/bin/node',str(ROOT/'deploy/verify-annual-coverage.mjs'))
        if pathlib.Path('/opt/private-finances/current').resolve()!=ROOT:
            raise RuntimeError('release_changed_recheck_required')
        run('systemctl','stop','private-finances-telegram.service')
        try:
            emit('checking_local_recovery')
            run('python3','/tmp/pf-restore-check.py')
            pathlib.Path('/etc/private-finances/local-restore-verified').chmod(0o644)
            # Retain proposals and archive each stale triage decision in the audit trail.
            sql("""BEGIN; SELECT pg_advisory_xact_lock(7482410);
            INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
            SELECT gen_random_uuid(),t.id,'operator','triage_requeued',to_jsonb(q),jsonb_build_object('promptVersion','triage:v2'),'Requeue Playtomic after adding Sport category; reuse current v2 proposal when available'
            FROM transactions t JOIN transaction_triage q ON q.transaction_id=t.id AND q.revision=t.revision
            WHERE lower(t.description) LIKE '%playtomic%' AND t.kind='unresolved' AND t.amount_minor<0 AND q.state<>'processing'
              AND NOT EXISTS(SELECT 1 FROM audit_events h WHERE h.transaction_id=t.id AND h.event='classified');
            DELETE FROM transaction_triage q USING transactions t WHERE q.transaction_id=t.id AND q.revision=t.revision
              AND lower(t.description) LIKE '%playtomic%' AND t.kind='unresolved' AND t.amount_minor<0 AND q.state<>'processing'
              AND NOT EXISTS(SELECT 1 FROM audit_events h WHERE h.transaction_id=t.id AND h.event='classified');
            COMMIT;""")
            path=pathlib.Path('/etc/private-finances/app.env')
            lines=path.read_text().splitlines()
            updates={'AUTO_CATEGORIZE_CLEAR_EXPENSES':'true','OPENAI_MAX_REQUESTS_PER_DAY':'1000'}
            lines=[line for line in lines if line.split('=',1)[0] not in updates]
            stage=path.with_suffix('.history-next')
            stage.write_text('\n'.join(lines+[f'{k}={v}' for k,v in updates.items()])+'\n')
            stage.chmod(0o600);stage.replace(path)
            run('systemctl','restart','private-finances.service')
        finally:
            run('systemctl','start','private-finances-telegram.service')
        emit('historical_coverage_verified')
        run('systemd-run','--unit=pf-categorize-year','--property=User=private-finances','--property=Group=private-finances',f'--property=WorkingDirectory={ROOT}','--property=EnvironmentFile=/etc/private-finances/app.env','--property=RuntimeMaxSec=10800','/usr/bin/node','dist/src/categorize-cli.js')
        emit('annual_categorization_started',monthlyBudgetUsd=10,dailyRequestLimit=1000)
    finally:
        failures=[]
        for owner in OWNERS:
            try: run('systemctl','start',f'private-finances-sync@monobank-{owner}.timer')
            except Exception: failures.append(owner)
        emit('regular_monobank_timers_restored',failedOwners=failures)
        if failures: raise RuntimeError('timer_restoration_failed')
try:
    main()
except Exception as error:
    emit('historical_continuation_failed',error=str(error) if isinstance(error,RuntimeError) else type(error).__name__)
    raise SystemExit(1)
