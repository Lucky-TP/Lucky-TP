#!/usr/bin/env node
// Update the LLM token usage heatmap in README.md from a Tokscale graph export.
//
// Usage:
//   node scripts/update-llm-usage.mjs [--push] [--input FILE]
//
//   --push    After regenerating, commit and push managed paths to origin/main.
//   --input   Read the Tokscale graph JSON from FILE instead of invoking the CLI.
//
// Locking: uses /usr/bin/lockf to serialize concurrent runs. The lock is held
// for the entire duration of the update (scan + generation + push). If the
// lock is already held, the run exits 0 without scanning.
//
// The lock is implemented by spawning a child process under lockf that runs
// the actual work. The parent waits for the child and propagates its exit code.

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const START_MARKER = '<!-- llm-usage:start -->';
const END_MARKER = '<!-- llm-usage:end -->';
const HREF = '#llm-token-usage';
const ASSET = './assets/llm-usage';
const CELL = 13;
const WEEKS = 53;
const SVG_W = WEEKS * CELL;
const SVG_H = 18;

const MANAGED_SUBJECT = 'Update LLM token usage';
const MANAGED_README = 'README.md';
const MANAGED_ASSET_PREFIX = 'assets/llm-usage/';

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const WEEKDAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { push: false, input: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--push') opts.push = true;
    else if (a === '--input') {
      if (++i >= argv.length) throw new Error('--input requires a file path');
      opts.input = argv[i];
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

function lockFile() {
  const dir = join(homedir(), 'Library', 'Application Support', 'llm-usage');
  mkdirSync(dir, { recursive: true });
  const slug = createHash('sha256').update(REPO_ROOT).digest('hex').slice(0, 16);
  return join(dir, `lock-${slug}`);
}

function runUnderLock(argv) {
  const lf = lockFile();
  // Keep the lock inode; skip immediately and silently if another run owns it.
  const r = spawnSync('/usr/bin/lockf', [
    '-k', '-s', '-t', '0', lf,
    process.execPath, __filename, ...argv,
  ], {
    stdio: 'inherit',
    env: { ...process.env, LLM_USAGE_LOCK_HELD: '1' },
  });
  if (r.error) {
    console.error(`Error: lockf failed: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status === 75) {
    // Lock is held by another instance; skip silently
    process.exit(0);
  }
  process.exit(r.status ?? 1);
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

function gitOk(args) {
  const r = spawnSync('git', args, {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (r.error) throw new Error(`git ${args.join(' ')}: ${r.error.message}`);
  if (r.status !== 0)
    throw new Error(`git ${args.join(' ')} failed (${r.status}): ${(r.stderr || r.stdout || '').trim()}`);
  return r.stdout.trim();
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateGraphJson(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data))
    throw new Error('Malformed JSON: root is not an object');
  if (!Array.isArray(data.contributions))
    throw new Error('Malformed JSON: missing "contributions" array');
  if (data.meta === null || typeof data.meta !== 'object')
    throw new Error('Malformed JSON: missing "meta" object');

  const seen = new Set();
  for (const c of data.contributions) {
    if (c === null || typeof c !== 'object')
      throw new Error('Malformed JSON: contribution is not an object');
    parseDate(c.date);
    if (seen.has(c.date))
      throw new Error(`Malformed JSON: duplicate date ${c.date}`);
    seen.add(c.date);
    if (c.totals === null || typeof c.totals !== 'object')
      throw new Error(`Malformed JSON: missing totals for ${c.date}`);
    const tokens = c.totals.tokens;
    if (!Number.isSafeInteger(tokens) || tokens < 0)
      throw new Error(`Malformed JSON: invalid token count for ${c.date}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Dates (UTC)
// ---------------------------------------------------------------------------

function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) throw new Error(`Invalid date: ${JSON.stringify(s)}`);
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (fmtDate(date) !== s) throw new Error(`Invalid date: ${s}`);
  return date;
}
function fmtDate(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function addDays(d, n) {
  const o = new Date(d.getTime());
  o.setUTCDate(o.getUTCDate() + n);
  return o;
}
function monthYear(d) {
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function fullDate(d) {
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function intensityOf(tokens, maxTokens) {
  return tokens > 0 ? Math.max(1, Math.ceil(tokens / maxTokens * 4)) : 0;
}

// ---------------------------------------------------------------------------
// Months SVG
// ---------------------------------------------------------------------------

function buildMonthsSvg(firstSun, lastDate) {
  const labels = [];
  const seen = new Set();
  for (let i = 0; i <= WEEKS * 7; i++) {
    const d = addDays(firstSun, i);
    if (d > lastDate) break;
    const key = d.getUTCFullYear() * 12 + d.getUTCMonth();
    if (d.getUTCDate() === 1 && !seen.has(key)) {
      seen.add(key);
      const idx = Math.floor((d.getTime() - firstSun.getTime()) / 86400000 / 7);
      labels.push({ x: Math.min(idx * CELL, SVG_W - 24), text: MONTH_SHORT[d.getUTCMonth()] });
    }
  }
  if (labels.length === 0)
    labels.push({ x: 0, text: MONTH_SHORT[firstSun.getUTCMonth()] });
  const inner = labels.map(l => `<text x="${l.x}" y="12">${l.text}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_W}" height="${SVG_H}" viewBox="0 0 ${SVG_W} ${SVG_H}"><g fill="#8b949e" font-family="Arial, sans-serif" font-size="10">${inner}</g></svg>`;
}

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------

function buildChart(contributions, snapshotDate) {
  const dayMap = new Map(contributions.map(c => [c.date, c.totals.tokens]));
  const last = snapshotDate;
  const winStart = addDays(last, -364);
  const firstSun = addDays(winStart, -winStart.getUTCDay());
  const ws = fmtDate(winStart);
  const we = fmtDate(last);

  let totalTokens = 0, activeDays = 0, maxTokens = 0;
  for (const [date, tokens] of dayMap) {
    if (date >= ws && date <= we) {
      totalTokens += tokens;
      if (!Number.isSafeInteger(totalTokens)) throw new Error('Token total exceeds safe integer range');
      maxTokens = Math.max(maxTokens, tokens);
      if (tokens > 0) activeDays++;
    }
  }

  const rows = [];
  for (let w = 0; w < 7; w++) {
    const cells = [];
    for (let wk = 0; wk < WEEKS; wk++) {
      const d = addDays(firstSun, wk * 7 + w);
      const ds = fmtDate(d);
      if (ds > we) continue;
      if (ds < ws) {
        cells.push(`<img src="${ASSET}/level-0.svg" width="13" height="13" alt="">`);
        continue;
      }
      const tokens = dayMap.get(ds) ?? 0;
      const lvl = intensityOf(tokens, maxTokens);
      const title = tokens > 0
        ? `${ds}: ${tokens.toLocaleString('en-US')} tokens`
        : `${ds}: No recorded usage`;
      cells.push(`<a href="${HREF}" title="${title}"><img src="${ASSET}/level-${lvl}.svg" width="13" height="13" alt="${title}"></a>`);
    }
    rows.push(`${WEEKDAYS[w]} ${cells.join('')}`);
  }

  let earliest = null;
  for (const [date, tokens] of dayMap) {
    if (date >= ws && date <= we && tokens > 0 && (earliest === null || date < earliest)) earliest = date;
  }
  const since = earliest ? fullDate(parseDate(earliest)) : fullDate(last);

  const body = [
    `**${totalTokens.toLocaleString('en-US')} tokens in the last year** · ${activeDays} active days`,
    '',
    `<pre>    <img src="${ASSET}/months.svg" width="${SVG_W}" height="${SVG_H}" alt="Months from ${monthYear(firstSun)} to ${monthYear(last)}">`,
    ...rows,
    '</pre>',
    '',
    'Hover over a square to see the date and token total. Missing days mean no recorded usage.',
    '',
    `Snapshot: ${fullDate(last)}. Based on available local logs since ${since}; totals include input, output, and cache tokens. Generated locally without submitting usage to Tokscale. Updates daily at 19:00 local time on my Mac.`,
  ].join('\n');

  return { body, monthsSvg: buildMonthsSvg(firstSun, last), firstSun, last };
}

// ---------------------------------------------------------------------------
// README
// ---------------------------------------------------------------------------

function replaceBlock(content, body) {
  const s = content.indexOf(START_MARKER);
  const e = content.indexOf(END_MARKER);
  if (s === -1 || e === -1 || e <= s)
    throw new Error('README.md: missing or malformed llm-usage markers');
  return content.slice(0, s + START_MARKER.length) + '\n\n' + body + '\n' + content.slice(e);
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

function isManagedPath(p) {
  const n = p.replace(/\\/g, '/');
  if (n === MANAGED_README) return true;
  if (n.startsWith(MANAGED_ASSET_PREFIX)) {
    const name = n.slice(MANAGED_ASSET_PREFIX.length);
    return name === 'months.svg' || /^level-[0-4]\.svg$/.test(name);
  }
  return false;
}

function pushPrechecks() {
  const branch = gitOk(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main')
    throw new Error(`Refusing to push: on "${branch}", expected "main"`);

  const remotes = gitOk(['remote']);
  if (!remotes.split('\n').includes('origin'))
    throw new Error('Refusing to push: no "origin" remote');

  // Managed paths clean BEFORE generation
  const ms = gitOk(['status', '--porcelain', '--', 'README.md', 'assets/llm-usage/']);
  if (ms !== '')
    throw new Error(`Refusing to push: managed paths dirty:\n${ms}`);

  // Clean index (no user-staged changes)
  const staged = gitOk(['diff', '--cached', '--name-only']);
  if (staged !== '')
    throw new Error(`Refusing to push: staged changes:\n${staged}`);

  gitOk(['fetch', 'origin', 'main', '--quiet']);
  const local = gitOk(['rev-parse', 'HEAD']);
  const remote = gitOk(['rev-parse', 'refs/remotes/origin/main']);
  if (local === remote) return local;

  const ahead = parseInt(gitOk(['rev-list', '--count', `${remote}..${local}`]), 10);
  const behind = parseInt(gitOk(['rev-list', '--count', `${local}..${remote}`]), 10);
  if (behind > 0)
    throw new Error(`Refusing to push: ${behind} behind origin/main`);
  if (ahead === 0) return local;

  const shas = gitOk(['rev-list', `${remote}..${local}`]).split('\n').filter(Boolean);
  for (const sha of shas) {
    const subj = gitOk(['log', '-1', '--format=%s', sha]);
    if (subj !== MANAGED_SUBJECT)
      throw new Error(`Refusing to push: unmanaged commit "${subj}"`);
    const files = gitOk(['log', '-1', '--name-only', '--format=', sha]).split('\n').filter(Boolean);
    for (const f of files)
      if (!isManagedPath(f))
        throw new Error(`Refusing to push: commit ${sha.slice(0, 8)} has unmanaged file ${f}`);
  }
  return local;
}

function doPush() {
  const staged = gitOk(['diff', '--cached', '--name-only']);
  if (staged !== '') throw new Error(`Refusing to push: staged changes:\n${staged}`);
  const changed = gitOk(['diff', '--name-only', 'HEAD', '--', 'README.md', 'assets/llm-usage/months.svg']);
  if (changed !== '') {
    gitOk(['commit', '--only', '-m', MANAGED_SUBJECT, '--', 'README.md', 'assets/llm-usage/months.svg']);
  }
  const publication = pushPrechecks();
  if (publication !== gitOk(['rev-parse', 'refs/remotes/origin/main'])) {
    gitOk(['push', 'origin', `${publication}:refs/heads/main`]);
    console.log('Pushed to origin/main.');
  } else {
    console.log('No changes to commit.');
  }
}

// ---------------------------------------------------------------------------
// Tokscale
// ---------------------------------------------------------------------------

function runTokscale() {
  const cli = process.env.TOKSCALE_CLI_PATH ??
    join(homedir(), 'Library', 'Application Support', 'llm-usage', 'node_modules', '@tokscale', 'cli', 'bin.js');
  if (!existsSync(cli))
    throw new Error(`Tokscale CLI not found: ${cli}`);

  const dir = mkdtempSync(join(tmpdir(), 'llm-usage-'));
  const tmp = join(dir, 'graph.json');
  try {
    const r = spawnSync(process.execPath, [
      cli, 'graph', '--home', homedir(), '--output', tmp, '--no-spinner',
    ], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, TOKSCALE_PRICING_CACHE_ONLY: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.error) throw new Error(`Tokscale spawn failed: ${r.error.message}`);
    if (r.status !== 0)
      throw new Error(`Tokscale exited ${r.status}: ${(r.stderr || r.stdout || '').trim()}`);
    return readFileSync(tmp, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);

  // Locking: re-exec under lockf
  if (!process.env.LLM_USAGE_LOCK_HELD) {
    runUnderLock(argv);
    return;
  }
  if (opts.push) pushPrechecks();

  // 1. Obtain JSON
  let jsonStr;
  if (opts.input !== null) {
    if (!existsSync(opts.input)) throw new Error(`--input not found: ${opts.input}`);
    jsonStr = readFileSync(opts.input, 'utf8');
  } else {
    jsonStr = runTokscale();
  }

  let data;
  try { data = JSON.parse(jsonStr); }
  catch (e) { throw new Error(`Invalid JSON: ${e.message}`); }

  const graph = validateGraphJson(data);

  // 2. Empty data → no overwrite
  if (graph.contributions.length === 0) {
    console.log('No usage data. README.md unchanged.');
    if (opts.push) doPush();
    return;
  }

  // 4. Snapshot endpoint = latest recorded end date
  const snapStr = graph.meta.dateRange?.end;
  if (typeof snapStr !== 'string') throw new Error('Malformed JSON: missing meta.dateRange.end');
  const snap = parseDate(snapStr);

  // 5. Generate
  const { body, monthsSvg } = buildChart(graph.contributions, snap);
  const readmePath = join(REPO_ROOT, 'README.md');
  const monthsPath = join(REPO_ROOT, 'assets', 'llm-usage', 'months.svg');
  const curReadme = readFileSync(readmePath, 'utf8');
  const curMonths = readFileSync(monthsPath, 'utf8');
  const nextReadme = replaceBlock(curReadme, body);
  const changed = nextReadme !== curReadme || monthsSvg !== curMonths;

  // 6. No-op
  if (!changed) {
    console.log('Already up to date.');
    if (opts.push) doPush();
    return;
  }

  // 7. Atomic writes
  if (nextReadme !== curReadme) {
    const t = join(REPO_ROOT, `.README.md.tmp-${process.pid}`);
    writeFileSync(t, nextReadme, 'utf8');
    renameSync(t, readmePath);
  }
  if (monthsSvg !== curMonths) {
    const t = join(REPO_ROOT, 'assets', 'llm-usage', `.months.svg.tmp-${process.pid}`);
    writeFileSync(t, monthsSvg, 'utf8');
    renameSync(t, monthsPath);
  }
  console.log(`Snapshot: ${snapStr} (${monthYear(snap)})`);

  // 8. Push
  if (opts.push) doPush();
}

try { main(); } catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
