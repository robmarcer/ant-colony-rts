/**
 * Rendering for a single changelog entry, shared by CHANGELOG.md and by the
 * GitHub release notes.
 *
 * It lives on its own because two things now render the same data. A release
 * whose notes were written by hand would drift from the changelog the app serves
 * for the same version, and then the update prompt in the header and the release
 * page would disagree about what changed.
 */
import { CHANGELOG, type ChangeArea, type ChangelogEntry } from './changelog.js';

export const AREA_LABELS: Record<ChangeArea, string> = {
  sim: 'Simulation',
  ai: 'Unit AI',
  balance: 'Balance',
  perf: 'Performance',
  api: 'API',
  ui: 'Viewer',
  tests: 'Tests',
  docs: 'Docs',
  tooling: 'Tooling',
};

export const AREA_ORDER: ChangeArea[] = ['sim', 'ai', 'balance', 'perf', 'api', 'ui', 'tests', 'docs', 'tooling'];

function offsetMinutes(offset: string): number {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

/**
 * Rendered in the entry's own offset rather than the reader's local time, so the
 * recorded moment does not shift depending on who is reading.
 */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  const offset = iso.slice(-6);
  const pad = (n: number) => String(n).padStart(2, '0');
  const shifted = new Date(date.getTime() + offsetMinutes(offset) * 60_000);
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())} (UTC${offset})`
  );
}

/** The change list of one entry, grouped by area. No heading: callers differ on that. */
export function renderChanges(entry: ChangelogEntry): string[] {
  const lines: string[] = [];
  for (const area of AREA_ORDER) {
    const changes = entry.changes.filter((change) => change.area === area);
    if (changes.length === 0) continue;
    lines.push(`**${AREA_LABELS[area]}**`);
    lines.push('');
    for (const change of changes) lines.push(`- ${change.fix ? 'Fix: ' : ''}${change.detail}`);
    lines.push('');
  }
  return lines;
}

/** How exactly this entry's timestamp is known. */
export function provenance(entry: ChangelogEntry): string {
  if (entry.commit) return `commit \`${entry.commit}\``;
  return entry.precision === 'commit' ? 'committed' : 'reconstructed';
}

/**
 * Release notes for one version. Says out loud when the timestamp is
 * reconstructed, because a release page that looks precise about a moment it
 * only knows to the hour is quietly lying.
 */
export function releaseNotes(version: string): string {
  const entry = CHANGELOG.find((candidate) => candidate.version === version);
  if (!entry) throw new Error(`no changelog entry for version ${version}`);

  const lines: string[] = [`### ${entry.title}`, '', `${formatTimestamp(entry.timestamp)} · ${provenance(entry)}`, ''];
  if (entry.precision === 'reconstructed') {
    lines.push(
      '_This version predates version control on the project. Its timestamp comes from file modification ' +
        'times, so it is accurate to the hour rather than the minute, and there is no commit behind it._',
    );
    lines.push('');
  }
  lines.push(...renderChanges(entry));
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}
