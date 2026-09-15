import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

test('demo startup ignores live AI and Telegram credential files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pf-demo-isolation-'));
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../src/main.js', import.meta.url))],
    {
      cwd: directory,
      stdio: 'ignore',
      env: {
        ...process.env,
        APP_MODE: 'demo',
        PORT: String(port),
        OPENAI_API_KEY_FILE: join(directory, 'must-not-read'),
        OPENAI_MODEL: 'test',
        TELEGRAM_BOT_TOKEN_FILE: join(directory, 'must-not-read'),
        TELEGRAM_CHAT_ID: '-1',
        TELEGRAM_RODION_USER_ID: '1',
        TELEGRAM_KATYA_USER_ID: '2',
      },
    },
  );
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    let ready = false;
    for (let n = 0; n < 300; n++) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {}
      await pause(100);
    }
    assert.equal(
      ready,
      true,
      'demo must start without opening production credential paths',
    );
  } finally {
    child.kill('SIGTERM');
    await exited;
    await rm(directory, { recursive: true, force: true });
  }
});
