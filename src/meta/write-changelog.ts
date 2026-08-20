/**
 * Regenerates CHANGELOG.md from src/meta/changelog.ts so the markdown can never
 * drift from the data the app itself serves. Run with: npm run changelog
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION, CHANGELOG, totalChanges, type ChangeArea } from './changelog.js';

const AREA_LABELS: Record<ChangeArea, string> = {
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

const AREA_ORDER: ChangeArea[] = ['sim', 'ai', 'balance', 'perf', 'api', 'ui', 'tests', 'docs', 'tooling'];

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  const offset = iso.slice(-6);
  const pad = (n: number) => String(n).padStart(2, '0');
  // Rendered in the entry's own offset rather than the reader's local time, so
  // the recorded moment does not shift depending on who is reading.
  const shifted = new Date(date.getTime() + offsetMinutes(offset) * 60_000);
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())} (UTC${offset})`
  );
}

function offsetMinutes(offset: string): number {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

const lines: string[] = [];
lines.push('# Changelog');
lines.push('');
lines.push(`Current version: **${APP_VERSION}**. ${CHANGELOG.length} releases, ${totalChanges()} recorded changes.`);
lines.push('');
lines.push('Generated from `src/meta/changelog.ts` by `npm run changelog`. Edit the data, not this file.');
lines.push('');
lines.push(
  'Entries marked *reconstructed* predate version control on this project. Their timestamps were derived from ' +
    'file modification times and the timestamps inside saved match records, so they are accurate to the hour ' +
    'rather than the minute, and there are no commits behind them. Entries marked with a commit hash have exact ' +
    'provenance in git.',
);
lines.push('');

for (const entry of CHANGELOG) {
  lines.push(`## ${entry.version} — ${entry.title}`);
  lines.push('');
  const provenance = entry.commit ? `commit \`${entry.commit}\`` : entry.precision === 'commit' ? 'committed' : 'reconstructed';
  lines.push(`${formatTimestamp(entry.timestamp)} · ${provenance} · ${entry.changes.length} changes`);
  lines.push('');

  for (const area of AREA_ORDER) {
    const changes = entry.changes.filter((change) => change.area === area);
    if (changes.length === 0) continue;
    lines.push(`**${AREA_LABELS[area]}**`);
    lines.push('');
    for (const change of changes) {
      lines.push(`- ${change.fix ? 'Fix: ' : ''}${change.detail}`);
    }
    lines.push('');
  }
}

const target = join(dirname(fileURLToPath(import.meta.url)), '../../CHANGELOG.md');
writeFileSync(target, `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`);
console.log(`wrote CHANGELOG.md: version ${APP_VERSION}, ${CHANGELOG.length} releases, ${totalChanges()} changes`);
