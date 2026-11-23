/**
 * Target resolution over `session/list` rows (spec §4).
 *
 * `send`/`result` demand exactly one match; `sessions` deliberately returns
 * every match so a caller can inspect before choosing.
 */

import { realpathSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  AmbiguousTargetError,
  ResolutionError,
  SessionCandidate,
} from './errors.js';
import {
  type SessionRow,
  sessionCwd,
  sessionTitle,
  sessionUpdatedAt,
  stripSessionPrefix,
} from './client.js';

export interface Target {
  session?: string;
  title?: string;
  cwd?: string;
  latest?: boolean;
}

export function hasSelector(target: Target): boolean {
  return (
    target.session !== undefined ||
    target.title !== undefined ||
    target.cwd !== undefined ||
    target.latest === true
  );
}

/** realpath-style cwd normalization; falls back to `path.resolve` if missing. */
export function normalizeCwd(input: string): string {
  const absolute = resolvePath(input);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

export function describeTarget(target: Target): string {
  const parts: string[] = [];
  if (target.session !== undefined) parts.push(`--session ${target.session}`);
  if (target.title !== undefined) parts.push(`--title ${JSON.stringify(target.title)}`);
  if (target.cwd !== undefined) parts.push(`--cwd ${target.cwd}`);
  if (target.latest === true) parts.push('--latest');
  return parts.length === 0 ? '(no selector)' : parts.join(' ');
}

function matchesSession(row: SessionRow, selector: string): boolean {
  const given = stripSessionPrefix(selector.trim());
  if (given === '') return false;
  return stripSessionPrefix(row.sessionId) === given;
}

function matchesSessionPrefix(row: SessionRow, selector: string): boolean {
  const given = stripSessionPrefix(selector.trim());
  if (given === '') return false;
  return stripSessionPrefix(row.sessionId).startsWith(given);
}

/** Filter rows by every supplied selector; `--latest` is applied last. */
export function filterSessions(rows: SessionRow[], target: Target): SessionRow[] {
  let filtered = rows;
  if (target.session !== undefined) {
    const exact = filtered.filter((row) => matchesSession(row, target.session ?? ''));
    filtered =
      exact.length > 0
        ? exact
        : filtered.filter((row) => matchesSessionPrefix(row, target.session ?? ''));
  }
  if (target.title !== undefined) {
    const needle = target.title.toLowerCase();
    filtered = filtered.filter((row) => sessionTitle(row).toLowerCase().includes(needle));
  }
  if (target.cwd !== undefined) {
    const wanted = normalizeCwd(target.cwd);
    filtered = filtered.filter((row) => {
      const cwd = sessionCwd(row);
      return cwd !== undefined && normalizeCwd(cwd) === wanted;
    });
  }
  if (target.latest === true) {
    filtered = [...filtered].sort((left, right) => sessionUpdatedAt(right) - sessionUpdatedAt(left));
    filtered = filtered.slice(0, 1);
  }
  return filtered;
}

/** Resolve exactly one row or fail with a candidate list (spec §4). */
export function resolveTarget(rows: SessionRow[], target: Target): SessionRow {
  if (!hasSelector(target)) {
    throw new ResolutionError(
      'no target selector given; pass one of --session <id|prefix>, --title <substr>, ' +
        '--cwd <path>, or --latest',
    );
  }
  if (target.session !== undefined && stripSessionPrefix(target.session.trim()) === '') {
    throw new ResolutionError('--session must not be empty or just "session-"');
  }

  const matches = filterSessions(rows, target);
  if (matches.length === 1) {
    const row = matches[0];
    if (row === undefined) throw new ResolutionError('internal error: one match but no row');
    return row;
  }
  if (matches.length > 1) {
    const candidates = matches.slice(0, 10).map(
      (row) =>
        new SessionCandidate(
          row.sessionId,
          sessionTitle(row),
          sessionCwd(row),
          typeof row.updatedAt === 'number' ? row.updatedAt : undefined,
        ),
    );
    const lines = candidates.map((candidate) => {
      const updated =
        candidate.updatedAt === undefined ? '?' : new Date(candidate.updatedAt).toISOString();
      return (
        `  ${candidate.sessionId}\t${candidate.title ?? ''}\t${candidate.cwd ?? ''}\t${updated}`
      );
    });
    const more = matches.length > candidates.length ? `\n  … ${String(matches.length - candidates.length)} more` : '';
    throw new AmbiguousTargetError(
      `target ${describeTarget(target)} matches ${String(matches.length)} sessions; ` +
        `narrow it:\n${lines.join('\n')}${more}`,
      candidates,
    );
  }
  throw new ResolutionError(
    `target ${describeTarget(target)} matched no sessions; run \`dsh-bridge sessions\` to list them`,
  );
}
