// Hermetic service environment for tests that start a supervisor daemon
// (issue https://github.com/jwulf/c8ctl-plugin-nano/issues/325).
//
// Import this FIRST (side-effect import) in every test file that may start a
// supervisor/workforce daemon. At import time it:
//   - clears SSH_CONNECTION / SSH_CLIENT / SSH_TTY, so an inherited SSH session
//     can never trigger the macOS launchd re-parent path;
//   - sets C8CTL_NANO_NO_LAUNCHD=1 as a second belt;
//   - points C8CTL_NANO_SERVICE_DIR at a temp dir, so even an explicit
//     install/uninstall writes its plist / systemd unit there, never into the
//     real ~/Library/LaunchAgents or ~/.config/systemd/user.
// It also registers a file-level leak guard (node:test `after`) that FAILS when
// the run left a new supervisor plist / systemd unit in the real user dirs, or
// a live `supervisor __daemon` whose temp state home is gone.
import { after } from 'node:test';
import { mkdtempSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { homedir, tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const k of ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY']) delete process.env[k];
process.env.C8CTL_NANO_NO_LAUNCHD = '1';
const serviceDir = mkdtempSync(join(tmpdir(), 'c8ctl-nano-svc-'));
process.env.C8CTL_NANO_SERVICE_DIR = serviceDir;

export const HERMETIC_SERVICE_DIR = serviceDir;

/** Real per-user service dirs that a leaky test would pollute. */
export function realServiceDirs() {
  return [
    join(homedir(), 'Library', 'LaunchAgents'),
    join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user'),
  ];
}

/** Supervisor service files currently present in the real user dirs. */
export function listRealServiceFiles() {
  const out = [];
  for (const d of realServiceDirs()) {
    let names = [];
    try { names = readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (/^io\.nanobpm\.c8ctl-nano\.supervisor\..+\.plist$/.test(n) || /^c8ctl-nano-supervisor-.+\.service$/.test(n)) {
        out.push(join(d, n));
      }
    }
  }
  return out.sort();
}

/**
 * Live `supervisor __daemon` processes whose C8CTL_NANO_HOME is under the temp
 * dir but no longer exists — the "launchd respawns a torn-down test daemon"
 * signature. Best-effort: returns [] where `ps` cannot show environments.
 */
export function listOrphanTempDaemons() {
  if (platform() === 'win32') return [];
  const r = spawnSync('ps', ['-axeww', '-o', 'pid=,command='], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return [];
  const tmp = tmpdir();
  const hits = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.includes('supervisor __daemon')) continue;
    const m = line.match(/C8CTL_NANO_HOME=(\S+)/);
    if (!m) continue;
    const home = m[1];
    if ((home.startsWith(tmp) || home.startsWith('/tmp') || home.startsWith('/private/var/folders')) && !existsSync(home)) {
      hits.push(line.trim());
    }
  }
  return hits;
}

const baselineFiles = new Set(listRealServiceFiles());
const baselineDaemons = new Set(listOrphanTempDaemons().map((l) => l.split(/\s+/)[0]));

after(() => {
  try { rmSync(serviceDir, { recursive: true, force: true }); } catch {}
  const leakedFiles = listRealServiceFiles().filter((f) => !baselineFiles.has(f));
  const leakedDaemons = listOrphanTempDaemons().filter((l) => !baselineDaemons.has(l.split(/\s+/)[0]));
  if (leakedFiles.length || leakedDaemons.length) {
    throw new Error(
      `Test run leaked supervisor services (issue #325):\n` +
      leakedFiles.map((f) => `  service file: ${f}`).join('\n') +
      (leakedFiles.length && leakedDaemons.length ? '\n' : '') +
      leakedDaemons.map((l) => `  daemon: ${l}`).join('\n'),
    );
  }
});
