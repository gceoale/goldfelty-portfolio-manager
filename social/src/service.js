// Runs `run --live --auto` in the background, starts it at login, and
// restarts it if it stops: launchd on macOS, systemd on Linux, Task
// Scheduler on Windows.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dataDir } from './store.js';

export const LABEL = 'com.goldfelty.social';
const BIN = fileURLToPath(new URL('../bin/goldfelty-social.js', import.meta.url));

export function command() {
  return [process.execPath, BIN, 'run', '--live', '--auto', '--no-ui'];
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function launchdPlist({ args = command(), home = dataDir(), env = {} } = {}) {
  const envEntries = Object.entries({ GOLDFELTY_SOCIAL_HOME: home, ...env })
    .map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>${xml(path.join(home, 'service.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(home, 'service.log'))}</string>
</dict>
</plist>
`;
}

const q = (s) => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;

export function systemdUnit({ args = command(), home = dataDir() } = {}) {
  return `[Unit]
Description=Goldfelty social autopilot
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${args.map(q).join(' ')}
Environment=${q(`GOLDFELTY_SOCIAL_HOME=${home}`)}
Restart=always
RestartSec=60

[Install]
WantedBy=default.target
`;
}

function run(cmd, args) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

export function install(log) {
  if (process.platform === 'darwin') {
    const file = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const uid = process.getuid();
    try {
      run('launchctl', ['bootout', `gui/${uid}/${LABEL}`]);
    } catch {
      /* wasn't loaded */
    }
    fs.writeFileSync(file, launchdPlist());
    run('launchctl', ['bootstrap', `gui/${uid}`, file]);
    log(`Installed ${file}. It starts at login and restarts if it stops.`);
  } else if (process.platform === 'linux') {
    const file = path.join(os.homedir(), '.config', 'systemd', 'user', 'goldfelty-social.service');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, systemdUnit());
    try {
      run('systemctl', ['--user', 'daemon-reload']);
      run('systemctl', ['--user', 'enable', '--now', 'goldfelty-social.service']);
    } catch (err) {
      fs.rmSync(file, { force: true });
      throw new Error(
        `systemd couldn't start it (${String(err.stderr || err.message).trim()}). ` +
          'Run "goldfelty-social run --live --auto --no-ui" in tmux or screen instead.',
      );
    }
    log(`Installed ${file}. To keep it running while you're logged out: loginctl enable-linger $USER`);
  } else if (process.platform === 'win32') {
    const [node, ...rest] = command();
    const tr = [node, ...rest].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
    run('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', 'GoldfeltySocial', '/TR', tr]);
    run('schtasks', ['/Run', '/TN', 'GoldfeltySocial']);
    log('Installed the GoldfeltySocial task. It starts when you log in.');
  } else {
    throw new Error(`No background service support for ${process.platform}; run "goldfelty-social run --live --auto" yourself.`);
  }
  log(`Log: ${path.join(dataDir(), 'activity.log')}`);
}

export function uninstall(log) {
  if (process.platform === 'darwin') {
    const file = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    try {
      run('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`]);
    } catch {
      /* not loaded */
    }
    fs.rmSync(file, { force: true });
  } else if (process.platform === 'linux') {
    try {
      run('systemctl', ['--user', 'disable', '--now', 'goldfelty-social.service']);
    } catch {
      /* not installed */
    }
    fs.rmSync(path.join(os.homedir(), '.config', 'systemd', 'user', 'goldfelty-social.service'), { force: true });
  } else if (process.platform === 'win32') {
    try {
      run('schtasks', ['/End', '/TN', 'GoldfeltySocial']);
    } catch {
      /* not running */
    }
    run('schtasks', ['/Delete', '/F', '/TN', 'GoldfeltySocial']);
  }
  log('Removed the background service.');
}
