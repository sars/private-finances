import test from 'node:test';
import { execFileSync } from 'node:child_process';
test('deployment retains bounded original frontend assets safely across switches and rollback', () => {
  execFileSync('python3', ['scripts/test_frontend_assets.py'], {
    stdio: 'pipe',
  });
});
