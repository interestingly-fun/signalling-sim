/**
 * Rolling-stock queries and checks (Phase 7). Reads the database in models.ts; nothing here moves a train.
 */

import { mphToMs, ROLLING_STOCK } from './models';
import type { FormationDef, ModelDef, OperatingClass, StockRef } from './types';

export { MPH_TO_MS, mphToMs, msToMph, ROLLING_STOCK } from './models';
export type { Class1Variant, FormationDef, ModelDef, OperatingClass, StockRef, Traction } from './types';

export const OPERATING_CLASSES: readonly OperatingClass[] = [1, 2, 5];

export const getModel = (id: string): ModelDef | undefined => ROLLING_STOCK.find((m) => m.id === id);

export const getFormation = (model: string, formation: string): FormationDef | undefined => getModel(model)?.formations.find((f) => f.id === formation);

export const isValidStock = (s: StockRef): boolean => getFormation(s.model, s.formation) !== undefined;

/** Operating classes a model may work as: its own, and Class 5 (ECS), which every model may work. */
export const permittedClasses = (m: ModelDef): OperatingClass[] => [...m.classes, 5];

export const modelAllowsClass = (model: string, trainClass: number): boolean => {
  const m = getModel(model);
  return m !== undefined && permittedClasses(m).includes(trainClass as OperatingClass);
};

/** Models that may work as this operating class. */
export const modelsForClass = (trainClass: number): ModelDef[] => ROLLING_STOCK.filter((m) => permittedClasses(m).includes(trainClass as OperatingClass));

/** Is this a model that, working as Class 1, may use the branch and call at Ashcombe? */
export const isFlexibleClass1 = (model: string | undefined): boolean => model !== undefined && getModel(model)?.class1Variant === 'flexible';

/** Why this model/formation cannot work as this class, or null when it can. */
export function stockProblem(trainClass: number, s: StockRef): string | null {
  const m = getModel(s.model);
  if (!m) return `Unknown train model "${s.model}".`;
  if (!m.formations.some((f) => f.id === s.formation)) return `${m.name} has no ${s.formation} formation (available: ${m.formations.map((f) => f.id).join(', ')}).`;
  if (!permittedClasses(m).includes(trainClass as OperatingClass)) return `${m.name} cannot work as Class ${trainClass} (it may work as Class ${permittedClasses(m).join(', ')}).`;
  return null;
}

/** The first model and formation for a class: the default when none is chosen. */
export function defaultStock(trainClass: number): StockRef {
  const preferred: Record<number, StockRef> = { 1: { model: '800', formation: '5-car' }, 2: { model: '170', formation: '2-car' }, 5: { model: '150', formation: '2-car' } };
  const p = preferred[trainClass];
  if (p && stockProblem(trainClass, p) === null) return p;
  const m = modelsForClass(trainClass)[0] as ModelDef;
  return { model: m.id, formation: (m.formations[0] as FormationDef).id };
}

/** Everything the movement engine needs from the database for one train. */
export interface StockPerformance {
  readonly lengthM: number;
  readonly maxSpeedMs: number;
  readonly accelerationMs2: number;
  readonly accelTaper: number;
  readonly serviceBrakeMs2: number;
  readonly emergencyBrakeMs2: number;
}

export function stockPerformance(s: StockRef): StockPerformance {
  const m = getModel(s.model);
  const f = getFormation(s.model, s.formation);
  if (!m || !f) throw new Error(`Unknown rolling stock ${s.model} ${s.formation}`);
  return { lengthM: f.lengthM, maxSpeedMs: mphToMs(m.maxSpeedMph), accelerationMs2: f.accelerationMs2, accelTaper: m.accelTaper, serviceBrakeMs2: f.serviceBrakeMs2, emergencyBrakeMs2: f.emergencyBrakeMs2 };
}

/** "Class 800 5-car". */
export function stockLabel(s: StockRef | undefined): string {
  if (!s) return 'generic test train';
  const m = getModel(s.model);
  return m ? `${m.name} ${s.formation}` : `${s.model} ${s.formation}`;
}

/** Every model/formation pair. */
export const allStock = (): StockRef[] => ROLLING_STOCK.flatMap((m) => m.formations.map((f) => ({ model: m.id, formation: f.id })));

/** Checks the database itself. An empty list means it is consistent. */
export function validateRollingStock(models: readonly ModelDef[] = ROLLING_STOCK): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const m of models) {
    if (ids.has(m.id)) out.push(`duplicate model ${m.id}`);
    ids.add(m.id);
    if (m.formations.length === 0) out.push(`${m.name}: no formations`);
    if (!(m.maxSpeedMph >= 40 && m.maxSpeedMph <= 140)) out.push(`${m.name}: implausible maximum speed ${m.maxSpeedMph} mph`);
    if (!(m.accelTaper > 0 && m.accelTaper <= 1)) out.push(`${m.name}: accelTaper must be in (0, 1]`);
    if (m.classes.length === 0) out.push(`${m.name}: no permitted operating class`);
    if (m.class1Variant === 'flexible' && !m.classes.includes(1)) out.push(`${m.name}: flexible Class 1 variant but not permitted as Class 1`);
    if (!(m.weight > 0)) out.push(`${m.name}: weight must be positive`);
    const fids = new Set<string>();
    let prev: FormationDef | undefined;
    for (const f of [...m.formations].sort((a, b) => a.cars - b.cars)) {
      if (fids.has(f.id)) out.push(`${m.name}: duplicate formation ${f.id}`);
      fids.add(f.id);
      if (f.id !== `${f.cars}-car`) out.push(`${m.name} ${f.id}: id does not match car count ${f.cars}`);
      if (!(f.lengthM > 0) || f.lengthM / f.cars < 12 || f.lengthM / f.cars > 28) out.push(`${m.name} ${f.id}: implausible length ${f.lengthM} m for ${f.cars} cars`);
      if (!(f.accelerationMs2 >= 0.3 && f.accelerationMs2 <= 1.2)) out.push(`${m.name} ${f.id}: implausible acceleration ${f.accelerationMs2}`);
      if (!(f.serviceBrakeMs2 >= 0.5 && f.serviceBrakeMs2 <= 1.2)) out.push(`${m.name} ${f.id}: implausible service braking ${f.serviceBrakeMs2}`);
      if (!(f.emergencyBrakeMs2 > f.serviceBrakeMs2)) out.push(`${m.name} ${f.id}: emergency braking must exceed service braking`);
      if (!(f.weight > 0)) out.push(`${m.name} ${f.id}: weight must be positive`);
      if (prev) {
        if (!(f.lengthM > prev.lengthM)) out.push(`${m.name}: a longer formation must be longer`);
        if (f.accelerationMs2 > prev.accelerationMs2) out.push(`${m.name}: ${f.id} accelerates faster than shorter ${prev.id}`);
        if (f.serviceBrakeMs2 > prev.serviceBrakeMs2) out.push(`${m.name}: ${f.id} brakes harder than shorter ${prev.id}`);
      }
      prev = f;
    }
  }
  return out;
}
