import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

if (
  process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === '1' ||
  process.env.DEEPSPROXY_SKIP_BROWSER_INSTALL === '1'
) {
  console.log('[postinstall] Playwright Chromium install skipped by env.');
  process.exit(0);
}

const cli = path.join(process.cwd(), 'node_modules', 'playwright', 'cli.js');
if (!existsSync(cli)) {
  console.warn('[postinstall] Playwright CLI was not found; skipping Chromium install.');
  process.exit(0);
}

console.log('[postinstall] Installing Playwright Chromium only...');
const result = spawnSync(process.execPath, [cli, 'install', 'chromium'], {
  stdio: 'inherit',
  env: process.env,
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
