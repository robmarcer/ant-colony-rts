/**
 * The header badge for issue #19: is a newer release published, and applying one.
 *
 * All of the version arithmetic and every refusal live on the server. This file
 * decides what to say and when to say nothing, which is most of the time: a badge
 * that is always visible stops being read.
 */

export interface UpdateWarning {
  id: string;
  message: string;
}

export interface UpdateStatusResponse {
  current: string;
  latest: string | null;
  standing: 'current' | 'behind' | 'ahead' | 'unknown';
  missedVersions: string[];
  install: { kind: string; reason: string; updatable: boolean };
  release: { version: string; tag: string; url: string; notes: string } | null;
  error: string | null;
  warnings: UpdateWarning[];
  note?: string;
}

/** Long enough to be polite to GitHub even with the server cache in front of it. */
export const POLL_MINUTES = 30;

/**
 * What the badge says, or null to show nothing.
 *
 * Being up to date, ahead of the newest release, or unable to reach GitHub are
 * all silent. None of them is news, and a badge reporting "no update available"
 * teaches people to stop looking at the spot where a real one would appear.
 */
export function badgeLabel(status: UpdateStatusResponse): string | null {
  if (status.standing !== 'behind' || status.latest === null) return null;
  const behind = status.missedVersions.length;
  if (behind > 1) return `${status.latest} available (${behind} versions behind)`;
  return `${status.latest} available`;
}

/** The panel body. Says what changed, what it risks, and how it will be applied. */
export function updatePanelHtml(status: UpdateStatusResponse, escape: (input: string) => string): string {
  const parts: string[] = [];
  parts.push(
    `<p>Running <strong>${escape(status.current)}</strong>. Published <strong>${escape(status.latest ?? 'none')}</strong>.</p>`,
  );

  if (status.missedVersions.length > 0) {
    parts.push(
      `<p>${status.missedVersions.length} version${status.missedVersions.length === 1 ? '' : 's'} behind: ` +
        `${status.missedVersions.map(escape).join(', ')}. The changelog for each is in this build already, ` +
        'under the changelog link.</p>',
    );
  }

  if (status.warnings.length > 0) {
    parts.push('<h3>Before you update</h3>');
    parts.push(`<ul>${status.warnings.map((w) => `<li>${escape(w.message)}</li>`).join('')}</ul>`);
  }

  if (status.install.updatable) {
    parts.push(
      '<p>This is a git checkout, so the server can update it in place: fetch, check out the tag, ' +
        '<code>npm ci</code>, rebuild. It will not restart itself; it will tell you to.</p>',
    );
    parts.push('<p><button id="updateApply" class="update-badge">Update now</button></p>');
  } else {
    parts.push(`<p>${escape(status.install.reason)}, so this copy cannot be updated from here.</p>`);
  }

  if (status.release) {
    parts.push(`<p><a class="version" href="${escape(status.release.url)}" target="_blank" rel="noreferrer">Release notes on GitHub</a></p>`);
  }
  parts.push('<p id="updateOutcome"></p>');
  return parts.join('\n');
}

/**
 * Every warning id the panel showed. The server refuses an update unless each is
 * acknowledged by id, so a client that never rendered a warning cannot wave it
 * through by sending one blanket flag.
 */
export function acknowledgements(status: UpdateStatusResponse): string[] {
  return status.warnings.map((warning) => warning.id);
}
