/**
 * Checking GitHub for a newer release, and applying one.
 *
 * Issue #19. The app had no idea it was out of date: APP_VERSION comes from the
 * newest changelog entry and nothing ever compared it to what is published.
 *
 * Three rules shape what follows.
 *
 * The check is server side. The browser would otherwise make a cross-origin call
 * per tab, and GitHub's unauthenticated rate limit is 60 an hour per address, so
 * a few open tabs on a slow poll would exhaust it. One process, one cache.
 *
 * Applying an update is opt in, and never a side effect of checking.
 *
 * It refuses rather than half-applying. A git checkout and a container are
 * updated by completely different means, and running the git recipe inside a
 * container leaves an image whose code no longer matches the tag it claims.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION, CHANGELOG } from './changelog.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Where releases are published. Not configurable: it identifies this project. */
export const RELEASE_REPO = 'robmarcer/ant-colony-rts';
const RELEASES_URL = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;

/** Long enough that a browser polling on an interval cannot exhaust the rate limit. */
export const CHECK_CACHE_SECONDS = 900;

export type InstallKind = 'git' | 'docker' | 'unknown';

export interface Install {
  kind: InstallKind;
  /** Why it was classified this way, so a refusal can explain itself. */
  reason: string;
  /** True when this kind of install can be updated in place by the server. */
  updatable: boolean;
}

export interface Release {
  version: string;
  tag: string;
  url: string;
  publishedAt: string | null;
  notes: string;
}

export type Standing = 'current' | 'behind' | 'ahead' | 'unknown';

export interface UpdateStatus {
  current: string;
  latest: string | null;
  standing: Standing;
  /** Versions between current and latest, newest first. Empty unless behind. */
  missedVersions: string[];
  install: Install;
  release: Release | null;
  checkedAt: string;
  /** Present when the check itself failed, rather than finding nothing. */
  error: string | null;
  warnings: Warning[];
}

export interface Warning {
  id: 'running_match' | 'stored_matches';
  message: string;
}

/*
 * Pure functions first. Everything below the divider touches the network, the
 * filesystem or a child process, and everything above it is decidable in a test.
 */

/**
 * Compare two dotted numeric versions. Returns negative when a is older.
 *
 * Missing components count as zero, so 0.30 and 0.30.0 are the same version.
 * Anything non-numeric sorts as zero rather than throwing, because a tag someone
 * typed by hand should not take the check down.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => value.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Where the running version stands against the published one.
 *
 * 'ahead' is a real state, not an error: a working copy sits ahead of the last
 * release for as long as it takes to cut one, and telling someone mid-development
 * that they are up to date would be wrong.
 */
export function standing(current: string, latest: string | null): Standing {
  if (latest === null) return 'unknown';
  const diff = compareVersions(current, latest);
  if (diff === 0) return 'current';
  return diff < 0 ? 'behind' : 'ahead';
}

/**
 * Versions the running build has not seen, newest first, taken from the local
 * changelog. Only ever a lower bound: the changelog of an old build cannot know
 * about versions published after it, which is exactly why the release carries its
 * own notes.
 */
export function missedVersions(current: string, latest: string | null): string[] {
  if (latest === null || compareVersions(current, latest) >= 0) return [];
  return CHANGELOG.filter(
    (entry) => compareVersions(entry.version, current) > 0 && compareVersions(entry.version, latest) <= 0,
  ).map((entry) => entry.version);
}

/**
 * What has to be acknowledged before an update is applied, and why. Both risks
 * are stated before the update runs rather than discovered after it.
 */
export function updateWarnings(context: { matchRunning: boolean; storedMatches: number }): Warning[] {
  const warnings: Warning[] = [];
  if (context.matchRunning) {
    warnings.push({
      id: 'running_match',
      message:
        'A match is running. Updating restarts the server, which throws away the simulation in progress. ' +
        'A match that has not been saved cannot be recovered afterwards.',
    });
  }
  if (context.storedMatches > 0) {
    warnings.push({
      id: 'stored_matches',
      message:
        `${context.storedMatches} stored matches are currently comparable. A new version can change the balance ` +
        'numbers or the simulation code, and either drops them out of the ladder. They stay on disk and stay ' +
        'readable; they stop being ranked, and cannot be replayed.',
    });
  }
  return warnings;
}

/** The shell steps for an install kind, in order. Empty when it cannot be updated in place. */
export function updatePlan(kind: InstallKind, tag: string): Array<{ command: string; args: string[] }> {
  if (kind !== 'git') return [];
  return [
    { command: 'git', args: ['fetch', '--tags', '--quiet'] },
    { command: 'git', args: ['checkout', '--quiet', tag] },
    { command: 'npm', args: ['ci', '--silent'] },
    { command: 'npm', args: ['run', 'build'] },
  ];
}

/** What to tell someone whose install the server cannot update for them. */
export function manualInstructions(kind: InstallKind, tag: string): string {
  if (kind === 'docker') {
    return (
      'This is running in a container, which cannot rebuild itself into a new image. On the host: ' +
      `\`docker pull ghcr.io/${RELEASE_REPO}:${tag}\`, stop the current container, and start one from the new ` +
      'image with the same volume mounts. Your definitions and matches live in mounted directories and survive.'
    );
  }
  return (
    `Update by hand: \`git fetch --tags && git checkout ${tag} && npm ci && npm run build\`, then restart the ` +
    'server. The server could not identify this install as a git checkout, so it will not guess.'
  );
}

/* ---- I/O below this line ---- */

/**
 * How this copy was installed.
 *
 * Docker is detected first and by two independent signals, because misreading a
 * container as a checkout is the failure that matters: containers built from this
 * repo do contain a .git directory, so the git check alone would claim a
 * container is updatable and then leave an image lying about its own version.
 */
export function detectInstall(): Install {
  if (existsSync('/.dockerenv')) {
    return { kind: 'docker', reason: '/.dockerenv exists', updatable: false };
  }
  if (process.env.ANT_IN_CONTAINER === '1') {
    return { kind: 'docker', reason: 'ANT_IN_CONTAINER is set', updatable: false };
  }
  try {
    const cgroup = readFileSync('/proc/1/cgroup', 'utf8');
    if (cgroup.includes('docker') || cgroup.includes('containerd')) {
      return { kind: 'docker', reason: 'pid 1 is in a container cgroup', updatable: false };
    }
  } catch {
    // No /proc, which is normal on macOS. Not evidence either way.
  }
  if (existsSync(join(ROOT, '.git'))) {
    return { kind: 'git', reason: 'a .git directory sits at the project root', updatable: true };
  }
  return { kind: 'unknown', reason: 'no .git directory and no container markers', updatable: false };
}

let cached: { at: number; status: UpdateStatus } | null = null;

/** Drop the cache. Exists for tests and for an explicit user-requested recheck. */
export function clearCheckCache(): void {
  cached = null;
}

async function fetchLatest(): Promise<{ release: Release | null; error: string | null }> {
  try {
    const response = await fetch(RELEASES_URL, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `ant-colony-rts/${APP_VERSION}`,
      },
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 404) {
      // No releases published yet. Not a failure, and not "up to date" either.
      return { release: null, error: null };
    }
    if (response.status === 403 || response.status === 429) {
      return { release: null, error: 'GitHub rate limit reached. The next check is after the cache expires.' };
    }
    if (!response.ok) {
      return { release: null, error: `GitHub returned ${response.status}` };
    }
    const body = (await response.json()) as {
      tag_name?: string;
      html_url?: string;
      published_at?: string | null;
      body?: string | null;
    };
    if (!body.tag_name) return { release: null, error: 'GitHub returned a release with no tag' };
    return {
      release: {
        version: body.tag_name.replace(/^v/, ''),
        tag: body.tag_name,
        url: body.html_url ?? `https://github.com/${RELEASE_REPO}/releases`,
        publishedAt: body.published_at ?? null,
        notes: body.body ?? '',
      },
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { release: null, error: `could not reach GitHub: ${message}` };
  }
}

/**
 * Current against latest, cached. `force` skips the cache for an explicit
 * recheck; an interval poll must not, or the cache buys nothing.
 */
export async function checkForUpdate(
  context: { matchRunning: boolean; storedMatches: number },
  options: { force?: boolean; now?: number } = {},
): Promise<UpdateStatus> {
  const now = options.now ?? Date.now();
  if (!options.force && cached && now - cached.at < CHECK_CACHE_SECONDS * 1000) {
    // Warnings are about local state, which moves faster than the cache does.
    return { ...cached.status, warnings: updateWarnings(context) };
  }

  const { release, error } = await fetchLatest();
  const latest = release?.version ?? null;
  const status: UpdateStatus = {
    current: APP_VERSION,
    latest,
    standing: standing(APP_VERSION, latest),
    missedVersions: missedVersions(APP_VERSION, latest),
    install: detectInstall(),
    release,
    checkedAt: new Date(now).toISOString(),
    error,
    warnings: updateWarnings(context),
  };
  // A failed check is not cached, so a network blip does not blind the app for
  // the whole cache window.
  if (error === null) cached = { at: now, status };
  return status;
}

export interface AppliedUpdate {
  applied: boolean;
  from: string;
  to: string;
  steps: Array<{ command: string; ok: boolean; output: string }>;
  restartRequired: boolean;
  message: string;
}

/**
 * Apply an update. Stops at the first failing step rather than pressing on, so a
 * failure leaves a checkout that is behind rather than one that is half moved.
 *
 * It does not restart the process. Exiting from inside a request means the
 * response describing what happened may never arrive, and a server that vanishes
 * without saying why is worse than one that asks to be restarted.
 */
export function applyUpdate(release: Release, install: Install): AppliedUpdate {
  const base = { from: APP_VERSION, to: release.version, restartRequired: false };
  if (!install.updatable) {
    return {
      ...base,
      applied: false,
      steps: [],
      message: manualInstructions(install.kind, release.tag),
    };
  }

  const steps: AppliedUpdate['steps'] = [];
  for (const step of updatePlan(install.kind, release.tag)) {
    const label = `${step.command} ${step.args.join(' ')}`;
    try {
      const output = execFileSync(step.command, step.args, {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 600_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      steps.push({ command: label, ok: true, output: output.trim().slice(-2000) });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      steps.push({ command: label, ok: false, output: detail.slice(-2000) });
      return {
        ...base,
        applied: false,
        steps,
        message:
          `\`${label}\` failed, so the update stopped there rather than continuing. The checkout may be on the ` +
          `new tag with old dependencies. Run \`git status\` and finish by hand, or \`git checkout v${APP_VERSION}\` ` +
          'to go back.',
      };
    }
  }
  return {
    ...base,
    applied: true,
    steps,
    restartRequired: true,
    message: `Updated to ${release.version}. Restart the server to run it.`,
  };
}
