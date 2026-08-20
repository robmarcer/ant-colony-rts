# Agents

Two different jobs happen in this repo. Pick the one you are here for.

## Writing strategies for the game

Read **[docs/agent-brief.md](docs/agent-brief.md)** first. It is written for you:
the loop, the eight knobs, the rule format, the six traps that have each cost a
real strategy real win rate, and how to read a match log.

With the server running, the same brief is at `GET /api/brief`, so an agent with
only HTTP access can bootstrap from the base URL alone.

You write JSON behaviour definitions. You do not change the simulation. If a knob
seems mis-specified, say so in the definition's `notes` rather than working around
it silently.

## Changing the codebase

- `npm run selftest` must pass before anything is committed. It is not a unit test
  suite, it is a set of assertions that the simulation is deterministic and not
  obviously broken. If a check fails, work out whether the code or the assertion
  is wrong before changing either. On this project the assertion has been wrong
  more often than the code.
- Add a `src/meta/changelog.ts` entry in the same change, never as a follow up,
  then run `npm run changelog`. Entries marked `commit` take their timestamp from
  `git log`, not from the clock.
- Any change to `src/sim/config.ts` alters the balance hash, which invalidates
  every stored match record. That is intended. Re-measure with
  `npm run match -- --round-robin --seeds 1,2 --time 900` and update the numbers
  quoted in `README.md` and `docs/behaviour.md`, which are measurements rather
  than claims.
- Balance changes need a measurement, not an argument. There are worked examples
  throughout the changelog of a change that looked obviously right and did nothing
  until it was measured.
- `src/sim` must stay free of I/O and DOM references. The browser and the server
  run the same simulation, and a stored match replaying identically in both is the
  determinism guarantee.
- Branch off `main`, and keep `main` fast-forward only.
