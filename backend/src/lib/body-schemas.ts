/**
 * Request-body schemas for the two start routes (H-4).
 *
 * Both `/api/scripts/execute` and `/api/drive/consistent-flow/start` destructured
 * an arbitrary body and carried ids, notes and measurements straight into the
 * shot record — a TypeScript cast validates nothing at runtime. AJV coerces the
 * unambiguous cases and answers 400 otherwise (api-error-handler keeps the
 * ApiResponse shape); unknown keys are dropped rather than passed on.
 *
 * The numeric bounds are deliberately far outside anything a real shot produces —
 * they exist to keep NaN/Infinity and type confusion out of the DB and off the
 * machine, not to enforce plausibility.
 */

/** Pre-shot fields both start routes accept. */
const preShotProps = {
  profileId: { type: "integer", minimum: 1 },
  shotSize: { type: "string", enum: ["single", "double"] },
  beanId: { type: ["integer", "null"] },
  // Freitext-Bohne: kurz halten, das Feld steht in Listenzeilen.
  beanLabel: { type: ["string", "null"], maxLength: 120 },
  grinderId: { type: ["integer", "null"] },
  grindSetting: { type: ["number", "null"], minimum: 0, maximum: 1000 },
  grinderRpm: { type: ["number", "null"], minimum: 0, maximum: 10000 },
  doseG: { type: ["number", "null"], minimum: 0, maximum: 1000 },
  notes: { type: ["string", "null"], maxLength: 2000 },
  yieldTargetOverrideG: { type: ["number", "null"], minimum: 0, maximum: 1000 },
} as const;

export const executeBody = {
  type: "object",
  required: ["profileId", "shotSize"],
  properties: preShotProps,
  additionalProperties: false,
} as const;

/**
 * Live-tuning overrides go into the safety-relevant driver config, so every
 * knob is bounded here. `steps` is only typed as a container: the driver's
 * resolveSteps() validates the step kinds and their targets, and it is the one
 * place that knows them.
 */
const flowHoldOverrides = {
  type: "object",
  properties: {
    targetFlowGs: { type: "number", exclusiveMinimum: 0, maximum: 10 },
    powerFloor: { type: "number", minimum: 0, maximum: 100 },
    rampStartPower: { type: "number", minimum: 0, maximum: 100 },
    kp: { type: "number", minimum: 0, maximum: 100 },
    ki: { type: "number", minimum: 0, maximum: 100 },
    emaAlpha: { type: "number", exclusiveMinimum: 0, maximum: 1 },
    slewUpPerS: { type: "number", exclusiveMinimum: 0, maximum: 1000 },
    slewDownPerS: { type: "number", exclusiveMinimum: 0, maximum: 1000 },
    maxBrewMs: { type: "integer", minimum: 1000, maximum: 600000 },
    controller: { type: "string", enum: ["adaptive", "pi"] },
    steps: { type: "array", maxItems: 20 },
  },
  additionalProperties: false,
} as const;

export const driveStartBody = {
  type: "object",
  required: ["profileId", "shotSize"],
  properties: { ...preShotProps, overrides: flowHoldOverrides },
  additionalProperties: false,
} as const;
