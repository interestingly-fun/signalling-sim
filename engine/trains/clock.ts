/**
 * Fixed-step clock. The simulation advances in equal logical steps no matter
 * how often the screen is redrawn: a slow frame runs several steps, a fast one
 * runs none. What is left over is carried to the next frame and exposed as
 * `alpha` so the renderer can interpolate between the last two steps.
 */
export class FixedStepClock {
  private carry = 0;
  constructor(
    readonly stepSeconds: number,
    /** A frame longer than this (tab was hidden, debugger stop) is cut short instead of replayed. */
    readonly maxFrameSeconds = 0.25,
  ) {
    if (!(stepSeconds > 0)) throw new Error('stepSeconds must be positive');
  }

  /** Adds elapsed time and returns how many fixed steps to run now. */
  advance(elapsedSeconds: number): number {
    if (!(elapsedSeconds > 0)) return 0;
    this.carry += Math.min(elapsedSeconds, this.maxFrameSeconds);
    const steps = Math.floor(this.carry / this.stepSeconds + 1e-9);
    this.carry = Math.max(0, this.carry - steps * this.stepSeconds);
    return steps;
  }

  /** Fraction (0..1) of the next step that has already elapsed. */
  get alpha(): number {
    return Math.min(1, this.carry / this.stepSeconds);
  }

  reset(): void {
    this.carry = 0;
  }
}
