/**
 * Common interface for a flow-hold actuator controller.
 *
 * Both the fixed-gain PIController and the adaptive plant-inversion
 * AdaptiveController implement this so the FlowHoldDriver can hold one of them
 * behind a single field and swap by config. The driver only needs the commanded
 * output; setSetpoint lets a staged profile retarget the flow between steps
 * without discarding the controller's learned state (integral / conductance).
 */
export interface FlowControllerStep {
  /** Clamped controller output (%) — the value to command the pump with. */
  output: number;
}

export interface FlowController {
  /** Bumpless seed from the open-loop ramp hand-off power (%). */
  seed(output: number): void;
  /** Advance one control step. `measured` = flow g/s, `dtMs` = ms since last update. */
  update(measured: number, dtMs: number): FlowControllerStep;
  /** Retarget the flow setpoint (g/s) mid-shot, preserving internal state. */
  setSetpoint(setpoint: number): void;
}
