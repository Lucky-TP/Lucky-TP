#!/usr/bin/env node
// Install a daily (19:00 local) macOS launchd job that runs
// scripts/update-llm-usage.mjs --push, or unregister it with --uninstall.
//
// No dependencies; uses only Node stdlib + launchctl/plutil from /bin, /usr/bin.
// No login, no submission, no network. No KeepAlive / RunAtLoad / watchers.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, realpathSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const SELF = fileURLToPath(import.meta.url);

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const UPDATER = path.join(REPO_ROOT, 'scripts', 'update-llm-usage.mjs');
const APP_SUPPORT = path.join(os.homedir(), 'Library', 'Application Support', 'llm-usage');
const CLI_LAUNCHER = path.join(APP_SUPPORT, 'node_modules', '@tokscale', 'cli', 'bin.js');
const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'llm-usage');
const UID = Number(typeof process.getuid === 'function' ? process.getuid() : -1);

const LABEL = 'com.lucky-tp.llm-usage';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG_FILE = path.join(LOG_DIR, 'daily.log');

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function run(cmd, args, label) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.error) fail(`${label}: ${r.error.message}`);
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || '').trim();
    fail(`${label}${detail ? `:\n${detail}` : ''}`);
  }
  return (r.stdout || '').trim();
}

function xmlEscape(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function ensureUpdater() {
  if (!existsSync(UPDATER)) fail(`updater not found at ${UPDATER}`);
}

function ensureCliLauncher() {
  if (!existsSync(CLI_LAUNCHER)) {
    fail(
      `Tokscale CLI launcher not found at ${CLI_LAUNCHER}.\n` +
      `Install the pinned CLI first:\n` +
      `  npm install --prefix "${APP_SUPPORT}" --save-exact --ignore-scripts --no-audit --no-fund tokscale@4.20.0`
    );
  }
}

function loadedState() {
  const r = spawnSync('/bin/launchctl', ['print', `gui/${UID}/${LABEL}`], { encoding: 'utf8' });
  if (r.error) fail(`launchctl print: ${r.error.message}`);
  return r.status === 0;
}

function buildPlist(node, launcher) {
  const env = {
    PATH: `${path.dirname(node)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: os.homedir(),
    TOKSCALE_CLI_PATH: launcher,
    TOKSCALE_PRICING_CACHE_ONLY: '1',
  };
  const envXml = Object.entries(env)
    .map(([k, v]) => `        <key>${k}</key>\n        <string>${xmlEscape(v)}</string>`)
    .join('\n');

  const arg = (s) => `        <string>${xmlEscape(s)}</string>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xmlEscape(LABEL)}</string>
    <key>ProgramArguments</key>
    <array>
${arg(node)}
${arg(UPDATER)}
        <string>--push</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(REPO_ROOT)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>19</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>KeepAlive</key>
    <false/>
    <key>RunAtLoad</key>
    <false/>
    <key>Nice</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${xmlEscape(LOG_FILE)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(LOG_FILE)}</string>
</dict>
</plist>
`;
}

function install() {
  ensureUpdater();
  ensureCliLauncher();

  const node = { path: realpathSync(process.execPath), version: process.version };
  mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(LOG_FILE, '', { flag: 'a', mode: 0o600 });
  chmodSync(LOG_FILE, 0o600);
  mkdirSync(path.dirname(PLIST), { recursive: true });

  const launcher = CLI_LAUNCHER;
  const plist = buildPlist(node.path, launcher);
  writeFileSync(PLIST, plist, { mode: 0o600 });

  // Validate the plist before registering.
  run('/usr/bin/plutil', ['-lint', PLIST], 'plutil -lint');

  // Prevent duplicate jobs: if our own label is already loaded, unload it first.
  if (loadedState()) {
    run('/bin/launchctl', ['bootout', `gui/${UID}/${LABEL}`], 'launchctl bootout (prior job)');
  }

  run('/bin/launchctl', ['enable', `gui/${UID}/${LABEL}`], 'launchctl enable');
  run('/bin/launchctl', ['bootstrap', `gui/${UID}`, PLIST], 'launchctl bootstrap');

  console.log(`Installed launchd job: ${LABEL}`);
  console.log(`  plist:        ${PLIST}`);
  console.log(`  schedule:     daily at 19:00 (local time)`);
  console.log(`  node:         ${node.path} (${node.version})`);
  console.log(`  cli:          ${launcher}`);
  console.log(`  updater:      ${UPDATER}`);
  console.log(`  log:          ${LOG_FILE} (0600)`);
  console.log('');
  console.log('Manual run now:');
  console.log(`  launchctl kickstart gui/${UID}/${LABEL}`);
  console.log('Disable (keep plist, stop schedule):');
  console.log(`  launchctl disable gui/${UID}/${LABEL}`);
  console.log('Re-enable:');
  console.log(`  launchctl enable gui/${UID}/${LABEL}`);
  console.log('Check status:');
  console.log(`  launchctl print gui/${UID}/${LABEL}`);
  console.log('Uninstall:');
  console.log(`  node "${SELF}" --uninstall`);
}

function uninstall() {
  // Unregister only our own job; absent job is harmless.
  if (loadedState()) {
    run('/bin/launchctl', ['bootout', `gui/${UID}/${LABEL}`], 'launchctl bootout');
    console.log(`Unregistered ${LABEL}.`);
  } else {
    console.log(`${LABEL} was not loaded; nothing to unregister.`);
  }
  // Delete only our own plist.
  if (existsSync(PLIST)) {
    rmSync(PLIST);
    console.log(`Removed ${PLIST}.`);
  } else {
    console.log(`No plist at ${PLIST}; nothing to remove.`);
  }
  // Keep user dependencies (app support) and logs untouched.
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--uninstall') return uninstall();
  if (args.length) fail(`unknown arguments: ${args.join(' ')}`);
  return install();
}

main();
