import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    env: process.env,
  });
  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    throw new Error(stderr || `${command} ${args.join(' ')} failed`);
  }
  return result.stdout?.trim() || '';
}

function git(args, options = {}) {
  return run('git', args, options);
}

try {
  git(['rev-parse', '--is-inside-work-tree'], { capture: true });

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { capture: true });
  const remote = git(['config', `branch.${branch}.remote`], { capture: true }) || 'origin';
  const mergeRef = git(['config', `branch.${branch}.merge`], { capture: true }) || `refs/heads/${branch}`;
  const remoteBranch = mergeRef.replace('refs/heads/', '');

  console.log(`[update] Checking ${remote}/${remoteBranch}...`);
  git(['fetch', remote, remoteBranch]);

  const local = git(['rev-parse', 'HEAD'], { capture: true });
  const upstream = git(['rev-parse', `${remote}/${remoteBranch}`], { capture: true });

  const dirty = git(['status', '--porcelain', '--untracked-files=no'], { capture: true });
  if (dirty) {
    console.error('[update] Local tracked files have changes. Commit or restore them before updating.');
    console.error('[update] Sessions are preserved in .deepsproxy/ and deepseek_profile/.');
    process.exit(1);
  }

  if (local === upstream) {
    console.log('[update] Already up to date.');
  } else {
    console.log(`[update] Updating ${local.slice(0, 7)} -> ${upstream.slice(0, 7)}...`);
    git(['merge', '--ff-only', `${remote}/${remoteBranch}`]);
  }

  if (!existsSync('node_modules')) {
    console.log('[update] node_modules missing; installing dependencies...');
  } else {
    console.log('[update] Refreshing dependencies...');
  }
  run('npm', ['install']);

  console.log('[update] Building project...');
  run('npm', ['run', 'build']);

  console.log('[update] Done. Login sessions were not touched.');
} catch (error) {
  console.error(`[update] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
