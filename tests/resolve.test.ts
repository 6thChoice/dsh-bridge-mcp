import assert from 'node:assert/strict';
import test from 'node:test';
import { AmbiguousTargetError, ResolutionError } from '../src/errors.js';
import { filterSessions, normalizeCwd, resolveTarget } from '../src/resolve.js';
import type { SessionRow } from '../src/client.js';

const CWD = process.cwd();

function row(
  sessionId: string,
  updatedAt: number,
  title: string,
  cwd = CWD,
): SessionRow {
  return { sessionId, updatedAt, cwd, projections: { values: { title } } };
}

const rows: SessionRow[] = [
  row('session-aaaa-1111', 100, 'Alpha Task'),
  row('bbbb-2222', 300, 'Beta Task', '/tmp/does-not-exist-bridge'),
  row('session-aaaa-3333', 200, 'alpha again'),
  row('cccc-4444', 50, 'Gamma'),
];

test('exact id matches with or without the session- prefix', () => {
  assert.equal(resolveTarget(rows, { session: 'session-aaaa-1111' }).sessionId, 'session-aaaa-1111');
  assert.equal(resolveTarget(rows, { session: 'aaaa-1111' }).sessionId, 'session-aaaa-1111');
  assert.equal(resolveTarget(rows, { session: 'bbbb-2222' }).sessionId, 'bbbb-2222');
  assert.equal(resolveTarget(rows, { session: 'session-bbbb-2222' }).sessionId, 'bbbb-2222');
});

test('unique prefix matches, ambiguity lists candidates', () => {
  assert.equal(resolveTarget(rows, { session: 'cccc' }).sessionId, 'cccc-4444');
  assert.throws(
    () => resolveTarget(rows, { session: 'aaaa' }),
    (error: unknown) =>
      error instanceof AmbiguousTargetError &&
      error.candidates.length === 2 &&
      error.message.includes('session-aaaa-1111') &&
      error.message.includes('session-aaaa-3333'),
  );
});

test('title substring is case-insensitive', () => {
  assert.equal(resolveTarget(rows, { title: 'ALPHA AGAIN' }).sessionId, 'session-aaaa-3333');
  assert.throws(
    () => resolveTarget(rows, { title: 'task' }),
    (error: unknown) =>
      error instanceof AmbiguousTargetError && error.message.includes('2 sessions'),
  );
});

test('cwd matches after realpath-style normalization', () => {
  const wanted = `${CWD}${CWD.endsWith('/') ? '' : '/'}`;
  assert.equal(
    resolveTarget(rows, { cwd: wanted, title: 'again' }).sessionId,
    'session-aaaa-3333',
  );
  assert.equal(normalizeCwd(wanted), normalizeCwd(CWD));
  assert.throws(() => resolveTarget(rows, { cwd: wanted }), AmbiguousTargetError);
});

test('--latest takes the newest updatedAt among filtered rows', () => {
  assert.equal(resolveTarget(rows, { latest: true }).sessionId, 'bbbb-2222');
  assert.equal(resolveTarget(rows, { title: 'alpha', latest: true }).sessionId, 'session-aaaa-3333');
});

test('filters AND together', () => {
  assert.equal(
    resolveTarget(rows, { session: 'aaaa', title: 'again' }).sessionId,
    'session-aaaa-3333',
  );
  assert.throws(
    () => resolveTarget(rows, { session: 'aaaa', title: 'Gamma' }),
    (error: unknown) => error instanceof ResolutionError && error.message.includes('matched no sessions'),
  );
});

test('no selector is an error, never a guess', () => {
  assert.throws(
    () => resolveTarget(rows, {}),
    (error: unknown) =>
      error instanceof ResolutionError && error.message.includes('no target selector'),
  );
});

test('empty or bare-session selector is rejected', () => {
  assert.throws(() => resolveTarget(rows, { session: '' }), /must not be empty/);
  assert.throws(() => resolveTarget(rows, { session: 'session-' }), /must not be empty/);
});

test('ambiguity lists at most ten candidates', () => {
  const many: SessionRow[] = [];
  for (let index = 0; index < 15; index++) many.push(row(`z-${String(index)}`, index, `Z ${String(index)}`));
  assert.throws(
    () => resolveTarget(many, { session: 'z' }),
    (error: unknown) =>
      error instanceof AmbiguousTargetError &&
      error.candidates.length === 10 &&
      error.message.includes('15 sessions') &&
      error.message.includes('5 more'),
  );
});

test('filterSessions returns every match and no selector means all rows', () => {
  assert.equal(filterSessions(rows, {}).length, rows.length);
  assert.equal(filterSessions(rows, { title: 'task' }).length, 2);
});
