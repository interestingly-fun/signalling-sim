/**
 * Rolling-stock types (Phase 7). Pure data: no movement, no UI.
 *
 * A train has two separate properties:
 *   - its OPERATING CLASS (1 express, 2 regional, 5 ECS) decides what it may do;
 *   - its PHYSICAL MODEL and FORMATION decide how long it is and how it performs.
 * A model says which operating classes it may work as; a formation is one of the model's fixed makeups.
 */

export type OperatingClass = 1 | 2 | 5;

export type Traction = 'electric' | 'diesel' | 'bi-mode';

/**
 * What a model may do when it works as Class 1.
 *   'express'  : the classic Class 1 rules: mainline only, never calls at Ashcombe, never uses the branch.
 *   'flexible' : an EMU that can also serve regional duties. As Class 1 it may use the branch and
 *                calls at Ashcombe when the timetable says so.
 * Class 2 and Class 5 rules do not depend on the model.
 */
export type Class1Variant = 'express' | 'flexible';

/** One fixed makeup of a model. All numbers are simulator values (metres, metres per second squared). */
export interface FormationDef {
  readonly id: string;
  readonly cars: number;
  readonly lengthM: number;
  /** Acceleration from a standing start, m/s². It falls with speed (see `accelTaper`). */
  readonly accelerationMs2: number;
  /** Normal braking rate used for every planned stop, m/s². */
  readonly serviceBrakeMs2: number;
  /** Strongest rate, used only if a signal turns to Danger too close to stop smoothly. */
  readonly emergencyBrakeMs2: number;
  /** Relative chance of this formation when the timetable generator picks one for the model. */
  readonly weight: number;
}

export interface ModelDef {
  readonly id: string;
  /** Display name, e.g. "Class 800". */
  readonly name: string;
  readonly description: string;
  readonly traction: Traction;
  readonly maxSpeedMph: number;
  /**
   * Fraction of the standing-start acceleration still available at maximum speed (0 to 1).
   * 1 gives a constant rate; lower values give the stronger low-speed pull of real traction.
   */
  readonly accelTaper: number;
  /** Operating classes (other than 5, which every model may work) this model may be given. */
  readonly classes: readonly (1 | 2)[];
  readonly class1Variant: Class1Variant;
  /** Relative chance of this model when the generator picks a model for a class. */
  readonly weight: number;
  readonly formations: readonly FormationDef[];
}

/** A reference to a model and one of its formations. This is what a train carries. */
export interface StockRef {
  readonly model: string;
  readonly formation: string;
}
