/**
 * Disposable tmp directory + isolated $HOME pair. Most e2e tests need both:
 * a project cwd that the CLI's gitBranch / project-config / skills loader
 * looks at, and a $HOME so global config + session logs don't leak.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

export interface TmpEnv {
  /** Project cwd (mkdtemp'd, optionally git-init'd). */
  cwd: string;
  /** Isolated HOME for the spawned CLI. config.json + sessions land here. */
  home: string;
  /** Convenience: `$home/.config/factory/config.json`. */
  globalConfigPath: string;
  /** Convenience: `$cwd/.factory/config.json`. */
  projectConfigPath: string;
  cleanup(): void;
}

export function tmpEnv(opts: { gitInit?: boolean } = {}): TmpEnv {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-cwd-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-home-'));
  fs.mkdirSync(path.join(home, '.config', 'factory'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.factory'), { recursive: true });
  if (opts.gitInit) {
    execSync('git init -q -b main', { cwd });
    // Need at least one commit for gitBranch detection on some setups.
    fs.writeFileSync(path.join(cwd, 'README.md'), '# test\n');
    execSync('git add README.md', { cwd });
    execSync('git -c user.email=t@t -c user.name=test commit -qm init', { cwd });
  }
  return {
    cwd,
    home,
    globalConfigPath: path.join(home, '.config', 'factory', 'config.json'),
    projectConfigPath: path.join(cwd, '.factory', 'config.json'),
    cleanup(): void {
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}
