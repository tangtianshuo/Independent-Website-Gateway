import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

rmSync('.next-test', { recursive: true, force: true });
process.env.NEXT_TEST_BUILD = '1';

for (const args of [['next', 'build'], ['vitest', 'run']]) {
  const executable = process.platform === 'win32' ? `${args[0]}.cmd` : args[0];
  const result = spawnSync(executable, args.slice(1), { stdio: 'inherit', env: process.env, shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
