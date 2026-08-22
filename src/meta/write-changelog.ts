/**
 * Regenerates CHANGELOG.md from src/meta/changelog.ts so the markdown can never
 * drift from the data the app itself serves. Run with: npm run changelog
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION, CHANGELOG, totalChanges } from './changelog.js';
import { formatTimestamp, provenance, renderChanges } from './release-notes.js';

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
  lines.push(`${formatTimestamp(entry.timestamp)} · ${provenance(entry)} · ${entry.changes.length} changes`);
  lines.push('');
  lines.push(...renderChanges(entry));
}

const target = join(dirname(fileURLToPath(import.meta.url)), '../../CHANGELOG.md');
writeFileSync(target, `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`);
console.log(`wrote CHANGELOG.md: version ${APP_VERSION}, ${CHANGELOG.length} releases, ${totalChanges()} changes`);
