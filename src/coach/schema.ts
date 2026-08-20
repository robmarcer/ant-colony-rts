import { z } from 'zod';
import { EXPANSION_PRIORITIES, SOLDIER_POSTURES } from '../sim/strategy.js';
import { RULE_METRICS, RULE_OPS } from '../sim/definition.js';

/**
 * Zod mirror of the behaviour definition, used to constrain the model's output.
 * The simulation still runs its own parser over whatever comes back, so this is
 * a first line of defence rather than the only one.
 */
const ratio = z.object({ worker: z.number().min(0).max(1), soldier: z.number().min(0).max(1) });

export const KnobsSchema = z.object({
  unit_production_ratio: ratio,
  aggression: z.number().min(0).max(1),
  expansion_priority: z.enum(EXPANSION_PRIORITIES),
  min_worker_reserve: z.number().int().min(0).max(60),
  soldier_posture: z.enum(SOLDIER_POSTURES),
  risk_tolerance: z.number().min(0).max(1),
});

export const PartialKnobsSchema = z.object({
  unit_production_ratio: ratio.optional(),
  aggression: z.number().min(0).max(1).optional(),
  expansion_priority: z.enum(EXPANSION_PRIORITIES).optional(),
  min_worker_reserve: z.number().int().min(0).max(60).optional(),
  soldier_posture: z.enum(SOLDIER_POSTURES).optional(),
  risk_tolerance: z.number().min(0).max(1).optional(),
});

export const RevisionSchema = z.object({
  /**
   * Why this revision looks the way it does. Written into the definition file
   * and carried into every future match record, so the reasoning survives.
   */
  reasoning: z.string(),
  notes: z.string(),
  base: KnobsSchema,
  rules: z.array(
    z.object({
      id: z.string(),
      note: z.string(),
      when: z.array(
        z.union([
          // Compare a metric against a constant.
          z.object({ metric: z.enum(RULE_METRICS), op: z.enum(RULE_OPS), value: z.number() }),
          // Or against another metric, for "fewer soldiers than they have".
          z.object({ metric: z.enum(RULE_METRICS), op: z.enum(RULE_OPS), metric2: z.enum(RULE_METRICS) }),
          // Or a group where one holding is enough.
          z.object({
            any_of: z.array(
              z.union([
                z.object({ metric: z.enum(RULE_METRICS), op: z.enum(RULE_OPS), value: z.number() }),
                z.object({ metric: z.enum(RULE_METRICS), op: z.enum(RULE_OPS), metric2: z.enum(RULE_METRICS) }),
              ]),
            ),
          }),
        ]),
      ),
      set: PartialKnobsSchema,
    }),
  ),
});

export type Revision = z.infer<typeof RevisionSchema>;
