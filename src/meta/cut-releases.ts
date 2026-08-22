/**
 * Publishes a GitHub release for each version tag, with notes generated from the
 * changelog.
 *
 * The precondition of issue #19: the update check has nothing to compare against
 * until releases exist. Tags alone are not enough, because a tag carries no notes
 * and the update prompt has to say what changed.
 *
 * Dry run by default. Publishing is public and not quietly undoable, so the
 * default has to be the harmless one. Run with --publish to actually create them.
 *
 *   npx tsx src/meta/cut-releases.ts              # print what would be published
 *   npx tsx src/meta/cut-releases.ts --publish    # create them
 *   npx tsx src/meta/cut-releases.ts --only 0.30.0
 */
import { execFileSync } from 'node:child_process';
import { CHANGELOG } from './changelog.js';
import { RELEASE_REPO, compareVersions } from './update.js';
import { releaseNotes } from './release-notes.js';

const args = process.argv.slice(2);
const publish = args.includes('--publish');
const onlyIndex = args.indexOf('--only');
const only = onlyIndex === -1 ? null : args[onlyIndex + 1];

function gh(params: string[]): string {
  return execFileSync('gh', params, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const tags = new Set(
  execFileSync('git', ['tag'], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean),
);

const existing = new Set(
  gh(['release', 'list', '--repo', RELEASE_REPO, '--limit', '200', '--json', 'tagName'])
    .trim()
    .replace(/^$/, '[]')
    .split('\n')
    .flatMap((line) => {
      try {
        return (JSON.parse(line) as Array<{ tagName: string }>).map((row) => row.tagName);
      } catch {
        return [];
      }
    }),
);

// Oldest first, so the newest release ends up newest on GitHub and 'latest'
// points at the right one. Cutting them newest first would leave the API's
// /releases/latest pointing at whichever was created last.
const candidates = [...CHANGELOG]
  .sort((a, b) => compareVersions(a.version, b.version))
  .filter((entry) => (only === null ? true : entry.version === only));

let published = 0;
const skipped: string[] = [];

for (const entry of candidates) {
  const tag = `v${entry.version}`;
  if (!tags.has(tag)) {
    skipped.push(`${entry.version} (no ${tag} tag)`);
    continue;
  }
  if (existing.has(tag)) {
    skipped.push(`${entry.version} (already released)`);
    continue;
  }

  const notes = releaseNotes(entry.version);
  const title = `${entry.version} — ${entry.title}`;
  if (!publish) {
    console.log(`would publish ${tag}: ${title} (${notes.split('\n').length} lines of notes)`);
    published++;
    continue;
  }
  gh(['release', 'create', tag, '--repo', RELEASE_REPO, '--title', title, '--notes', notes]);
  console.log(`published ${tag}: ${title}`);
  published++;
}

console.log('');
console.log(`${publish ? 'published' : 'would publish'} ${published} releases`);
if (skipped.length) console.log(`skipped ${skipped.length}: ${skipped.join(', ')}`);
if (!publish && published > 0) console.log('nothing was created. Re-run with --publish to create them.');
