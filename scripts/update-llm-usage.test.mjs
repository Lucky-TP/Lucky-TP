import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const README = '# Profile\n\nKeep intro.\n<!-- llm-usage:start -->\nExisting chart.\n<!-- llm-usage:end -->\nKeep footer.\n';
const contribution = (date, tokens) => ({ date, totals: { tokens, cost: 0 } });

function fixture(t, contributions = [contribution('2026-10-19', 200)]) {
  const dir = mkdtempSync(join(tmpdir(), 'llm-usage-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(fileURLToPath(new URL('./update-llm-usage.mjs', import.meta.url)), join(dir, 'scripts/update-llm-usage.mjs'));
  cpSync(fileURLToPath(new URL('../assets/llm-usage', import.meta.url)), join(dir, 'assets/llm-usage'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), README);
  const data = {
    meta: { version: '4.20.0', generatedAt: '2026-10-19T00:00:00Z', dateRange: { start: '2025-10-01', end: '2026-10-19' } },
    contributions,
  };
  return {
    dir, data,
    readme: () => readFileSync(join(dir, 'README.md'), 'utf8'),
    run(...args) {
      const input = join(dir, 'usage.json');
      writeFileSync(input, JSON.stringify(data));
      const result = spawnSync(process.execPath, [join(dir, 'scripts/update-llm-usage.mjs'), '--input', input, ...args], {
        cwd: dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, HOME: dir },
      });
      if (result.error) throw result.error;
      return result;
    },
    git(...args) {
      return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    },
  };
}
function succeeds(result) { assert.equal(result.status, 0, result.stderr + result.stdout); }

test('rolling year includes both boundaries and excludes older and future contributions', t => {
  const f = fixture(t, [
    contribution('2025-10-19', 99_999), contribution('2025-10-20', 100),
    contribution('2026-10-19', 200), contribution('2026-10-20', 88_888),
  ]);
  succeeds(f.run());
  const chart = f.readme();
  assert.match(chart, /300 tokens in the last year/);
  assert.match(chart, /2 active days/);
  assert.match(chart, /2025-10-20: 100 tokens/);
  assert.match(chart, /2026-10-19: 200 tokens/);
  assert.doesNotMatch(chart, /2025-10-19:|2026-10-20:/);
  assert.equal([...chart.matchAll(/<a href=/g)].length, 365);
});

test('only generated README block changes', t => {
  const f = fixture(t);
  succeeds(f.run());
  assert.equal(f.readme().split('<!-- llm-usage:start -->')[0], README.split('<!-- llm-usage:start -->')[0]);
  assert.equal(f.readme().split('<!-- llm-usage:end -->')[1], README.split('<!-- llm-usage:end -->')[1]);
});

test('generation timestamps and cost changes do not alter the chart', t => {
  const f = fixture(t);
  succeeds(f.run());
  const before = f.readme();
  const months = readFileSync(join(f.dir, 'assets/llm-usage/months.svg'), 'utf8');
  f.data.meta.generatedAt = '2099-01-01T00:00:00Z';
  f.data.contributions[0].totals.cost = 999;
  succeeds(f.run());
  assert.equal(f.readme(), before);
  assert.equal(readFileSync(join(f.dir, 'assets/llm-usage/months.svg'), 'utf8'), months);
});

test('empty exports preserve the existing chart', t => {
  const f = fixture(t, []);
  succeeds(f.run());
  assert.equal(f.readme(), README);
});

test('zero and missing days do not imply recorded token usage', t => {
  const f = fixture(t, [contribution('2026-10-19', 0)]);
  succeeds(f.run());
  assert.match(f.readme(), /2026-10-19: No recorded usage/);
  assert.match(f.readme(), /2026-10-18: No recorded usage/);
  assert.match(f.readme(), /0 tokens in the last year/);
});

test('invalid dates, counts, and duplicate days fail without overwriting README', t => {
  for (const contributions of [
    [contribution('2026-02-30', 1)], [contribution('2026-10-19', -1)],
    [contribution('2026-10-19', 1.5)], [contribution('2026-10-19', Number.MAX_SAFE_INTEGER + 1)],
    [contribution('2026-10-19', 1), contribution('2026-10-19', 2)],
  ]) {
    const f = fixture(t, contributions);
    assert.notEqual(f.run().status, 0);
    assert.equal(f.readme(), README);
  }
});

test('daily publication creates new commits; failed pushes can resume without publishing user work', t => {
  const f = fixture(t);
  const origin = join(f.dir, 'origin.git');
  f.git('init', '--bare', '--initial-branch=main', origin);
  f.git('init', '-b', 'main');
  f.git('config', 'user.name', 'LLM usage test');
  f.git('config', 'user.email', 'test@example.invalid');
  f.git('add', 'README.md', 'scripts/update-llm-usage.mjs', 'assets/llm-usage');
  f.git('commit', '-m', 'Initial profile');
  f.git('remote', 'add', 'origin', origin);
  f.git('push', '-u', 'origin', 'main');
  succeeds(f.run('--push'));
  const first = f.git('rev-parse', 'HEAD');
  succeeds(f.run('--push'));
  assert.equal(f.git('rev-parse', 'HEAD'), first);

  writeFileSync(join(f.dir, 'private-draft.txt'), 'Private draft.\n');
  f.data.contributions[0].totals.tokens++;
  succeeds(f.run('--push'));
  assert.equal(f.git('rev-parse', 'HEAD^'), first);
  assert.equal(f.git('rev-parse', 'HEAD'), f.git('rev-parse', 'origin/main'));
  assert.equal(f.git('ls-files', 'private-draft.txt'), '');
  assert.equal(readFileSync(join(f.dir, 'private-draft.txt'), 'utf8'), 'Private draft.\n');

  const hook = join(origin, 'hooks/pre-receive');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  f.data.contributions[0].totals.tokens++;
  assert.notEqual(f.run('--push').status, 0);
  const pending = f.git('rev-parse', 'HEAD');
  assert.notEqual(pending, f.git('rev-parse', 'origin/main'));
  rmSync(hook);
  succeeds(f.run('--push'));
  assert.equal(f.git('rev-parse', 'HEAD'), pending);
  assert.equal(f.git('rev-parse', 'origin/main'), pending);

  f.git('add', 'private-draft.txt');
  f.data.contributions[0].totals.tokens++;
  const before = f.readme();
  assert.notEqual(f.run('--push').status, 0);
  assert.equal(f.readme(), before);
  assert.equal(f.git('diff', '--cached', '--name-only'), 'private-draft.txt');
  f.git('commit', '-m', 'Private unrelated work');
  assert.notEqual(f.run('--push').status, 0);
  assert.equal(f.git('rev-parse', 'origin/main'), pending);
});
