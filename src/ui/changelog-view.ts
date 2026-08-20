/**
 * Changelog rendering, shared by the standalone page. Reads the same
 * src/meta/changelog.ts that feeds GET /api/changelog and CHANGELOG.md, so there
 * is one source of truth and no copy to keep in step.
 */
import { APP_VERSION, CHANGELOG, totalChanges, type ChangeArea } from '../meta/changelog.js';

const AREA_LABELS: Record<ChangeArea, string> = {
  sim: 'sim',
  ai: 'unit ai',
  balance: 'balance',
  perf: 'perf',
  api: 'api',
  ui: 'viewer',
  tests: 'tests',
  docs: 'docs',
  tooling: 'tooling',
};

export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * Rendered in the timestamp's own offset rather than the reader's, so an entry
 * always shows the moment it was recorded.
 */
export function formatWhen(iso: string): string {
  const offset = iso.slice(-6);
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  const minutes = match ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
  const shifted = new Date(new Date(iso).getTime() + minutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return (
    `${days[shifted.getUTCDay()]} ${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    ` ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())} (UTC${offset})`
  );
}

export function changelogHtml(): string {
  const entries = CHANGELOG.map((entry) => {
    const provenance = entry.commit
      ? `commit ${escapeHtml(entry.commit)}`
      : entry.precision === 'commit'
        ? 'committed'
        : 'reconstructed, no commit';
    const items = entry.changes
      .map(
        (change) =>
          `<li><span class="tag ${change.fix ? 'fix' : ''}">${escapeHtml(change.fix ? 'fix' : AREA_LABELS[change.area])}</span>` +
          `<span class="text">${escapeHtml(change.detail)}</span></li>`,
      )
      .join('');
    return `
      <div class="entry">
        <h3>${escapeHtml(entry.version)} — ${escapeHtml(entry.title)}</h3>
        <p class="when">${escapeHtml(formatWhen(entry.timestamp))} · ${provenance} · ${entry.changes.length} changes</p>
        <ul>${items}</ul>
      </div>`;
  }).join('');

  return `
    <h1>Changelog</h1>
    <p class="provenance">
      Version ${escapeHtml(APP_VERSION)} · ${CHANGELOG.length} releases · ${totalChanges()} recorded changes.
      Entries marked "reconstructed" predate version control on this project: their times come from file
      modification times and saved match records, so they are accurate to the hour and have no commits behind
      them. Later entries take their timestamp from the git commit the change landed in.
    </p>
    ${entries}`;
}
