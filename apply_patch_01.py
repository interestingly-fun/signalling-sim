#!/usr/bin/env python3
"""Patch 01: dwell and platform rules. Run from the repository root AFTER unzipping this bundle over it.
Every edit is an exact, single-occurrence replacement; nothing is written unless ALL edits match."""
import sys, pathlib

E = []
def edit(path, old, new):
    E.append((path, old, new))

# ---------------- step.ts ----------------
edit('src/engine/trains/step.ts', r"""import { permissionsFor } from './classes';""", r"""import { mayDwellAt } from './classes';""")
edit('src/engine/trains/step.ts',
 r"""    if (!permissionsFor(spec.trainClass, spec.stock?.model).canStop) return { ok: false, reason: `Class ${spec.trainClass} trains do not stop here.` };""",
 r"""    // A stop with no dwell (an ECS train changing ends at a terminus platform) is not a dwell: any train may make one.
    if (spec.stop.dwellS > 0 && !mayDwellAt(net, platform.id, spec.trainClass, spec.stock?.model)) return { ok: false, reason: `Class ${spec.trainClass} trains do not dwell at ${platform.name}.` };""")

# ---------------- planner.ts ----------------
edit('src/engine/trains/planner.ts', r"""import { classAllowsLine, permissionsFor } from './classes';""", r"""import { classAllowsLine, mayDwellAt } from './classes';
import { isFlexibleClass1 } from '../rollingstock';""")
edit('src/engine/trains/planner.ts', r"""${permissionsFor(q.trainClass, q.model).canStop}""", r"""${isFlexibleClass1(q.model)}""")
edit('src/engine/trains/planner.ts',
 r"""  const perms = permissionsFor(q.trainClass, q.model);
  const platformSection = q.platform ? net.platforms.get(q.platform)?.section : undefined;
  if (q.platform) {
    if (!perms.canStop || !platformSection) return [];""",
 r"""  const platformSection = q.platform ? net.platforms.get(q.platform)?.section : undefined;
  if (q.platform) {
    if (!platformSection || !mayDwellAt(net, q.platform, q.trainClass, q.model)) return [];""")

# ---------------- fleet.ts ----------------
edit('src/engine/trains/fleet.ts', r"""import { classProfile, permissionsFor, specForStock, TRAIN_CLASSES, type TrainClassId } from './classes';""", r"""import { classAllowsLine, classProfile, mayDwellAt, specForStock, TRAIN_CLASSES, type TrainClassId } from './classes';""")
edit('src/engine/trains/fleet.ts',
 r"""  if (!permissionsFor(q.trainClass, q.model).canStop) return [];
  const out: { id: string; name: string }[] = [];""",
 r"""  const out: { id: string; name: string }[] = [];""")
edit('src/engine/trains/fleet.ts',
 r"""    if (platformUnavailable(ctx, sig, trains, p.id) !== null) continue;""",
 r"""    if (!mayDwellAt(ctx.net, p.id, q.trainClass, q.model)) continue;
    if (platformUnavailable(ctx, sig, trains, p.id) !== null) continue;""")
edit('src/engine/trains/fleet.ts', r"""  const perms = permissionsFor(cls, stock.model);
""", "")
edit('src/engine/trains/fleet.ts',
 r"""  if (wantsStop && !perms.canStop) return { ok: false, reason: `Class ${cls} (${profile.name}) trains never stop at a platform.` };""",
 r"""  if (wantsStop && !mayDwellAt(ctx.net, req.platform as string, cls, stock.model)) return { ok: false, reason: `Class ${cls} (${profile.name}) trains do not dwell at that platform.` };""")
edit('src/engine/trains/fleet.ts', r"""        cls === 1 && branch && !perms.canStop""", r"""        cls === 1 && branch && !classAllowsLine(cls, 'BRANCH', stock.model)""")

# ---------------- timetable/generate.ts ----------------
G = 'src/engine/timetable/generate.ts'
edit(G, r"""import { getModel, isFlexibleClass1, modelsForClass, stockPerformance, type FormationDef, type ModelDef, type StockRef } from '../rollingstock';""", r"""import { getModel, modelsForClass, stockPerformance, type FormationDef, type ModelDef, type StockRef } from '../rollingstock';""")
edit(G, r"""import { permissionsFor, planEcsCycles, planServices, sidingFit,""", r"""import { mayDwellAt, planEcsCycles, planServices, sidingFit,""")
edit(G, r"""  const perms = permissionsFor(trainClass, stock.model);
""", "")
edit(G,
 r"""      for (const plan of sensiblePlans(ctx, planServices(ctx, base), null)) out.push({ trainClass, stock, origin, destination, platform: null, plan });
      if (perms.canStop) {
        for (const platform of ctx.net.platforms.values()) {
          for (const plan of sensiblePlans(ctx, planServices(ctx, { ...base, platform: platform.id }), platform.id)) out.push({ trainClass, stock, origin, destination, platform: platform.id, plan });
        }
      }""",
 r"""      for (const plan of sensiblePlans(ctx, planServices(ctx, base), null)) out.push({ trainClass, stock, origin, destination, platform: null, plan });
      if (trainClass === 1) {
        // Phase 11: an express may be routed through a platform track (held at signals as usual) but never dwells there.
        const loops = planServices(ctx, base).filter((p) => p.platforms.length > 0);
        for (const plan of sensiblePlans(ctx, loops, '')) out.push({ trainClass, stock, origin, destination, platform: null, plan });
      }
      for (const platform of ctx.net.platforms.values()) {
        if (!mayDwellAt(ctx.net, platform.id, trainClass, stock.model)) continue;
        for (const plan of sensiblePlans(ctx, planServices(ctx, { ...base, platform: platform.id }), platform.id)) out.push({ trainClass, stock, origin, destination, platform: platform.id, plan });
      }""")
edit(G,
 r"""  const wantStop = (c: number, stock: StockRef): boolean => (c === 2 ? rng.next() < p.stopBias : c === 5 ? rng.next() < 0.35 : isFlexibleClass1(stock.model) ? rng.next() < 0.5 : false);""",
 r"""  // Phase 11: only Class 2 calls at a platform here. Class 1 never dwells at Ashcombe and ECS only dwell in sidings.
  const wantStop = (c: number): boolean => (c === 2 ? rng.next() < p.stopBias : false);""")
edit(G, r"""  const stopFor = classes.map((c, i) => wantStop(c, stocks[i] as StockRef));""", r"""  const stopFor = classes.map((c) => wantStop(c));""")

# ---------------- timetable/validate.ts ----------------
V = 'src/engine/timetable/validate.ts'
edit(V, r"""import { isFlexibleClass1, stockPerformance, stockProblem } from '../rollingstock';""", r"""import { stockPerformance, stockProblem } from '../rollingstock';""")
edit(V, r"""import { boundaryCorridor, classAllowsLine, permissionsFor, planEcsCycles,""", r"""import { boundaryCorridor, classAllowsLine, mayDwellAt, planEcsCycles,""")
edit(V,
 r"""  for (const c of [e.terminal.inboundCall, e.terminal.outboundCall]) {
    if (!c) continue;
    if (!permissionsFor(s.trainClass, s.model).canStop) issues.push(`${tag}: Class ${s.trainClass} cannot stop.`);""",
 r"""  for (const [dir, c] of [['inbound', e.terminal.inboundCall], ['outbound', e.terminal.outboundCall]] as const) {
    if (!c) continue;
    const callClass = dir === 'inbound' ? s.trainClass : on.trainClass;
    if (!mayDwellAt(net, c.platform, callClass, s.model)) issues.push(`${tag}: a Class ${callClass} train may not dwell at ${c.platform}.`);""")
edit(V,
 r"""  if (e.terminal.dwellS < 30) issues.push(`${tag}: terminal dwell ${e.terminal.dwellS} s is too short.`);""",
 r"""  if (s.trainClass === 5) {
    // ECS never dwell at a platform: an ECS train arriving at a terminus only changes ends, and always leaves as a passenger service.
    if (e.terminal.dwellS !== 0) issues.push(`${tag}: an ECS train does not dwell at a platform (terminal dwell ${e.terminal.dwellS} s).`);
    if (on.trainClass === 5) issues.push(`${tag}: an ECS train arriving at a terminus must leave as a passenger service.`);
  } else if (e.terminal.dwellS < 30) issues.push(`${tag}: terminal dwell ${e.terminal.dwellS} s is too short.`);""")
edit(V, r"""  const perms = permissionsFor(s.trainClass, s.model);
""", "")
edit(V,
 r"""    if (!perms.canStop) issues.push(`${tag}: Class ${s.trainClass} cannot stop.`);
    const plat = s.platform ? net.platforms.get(s.platform) : undefined;
    if (!plat) issues.push""",
 r"""    const plat = s.platform ? net.platforms.get(s.platform) : undefined;
    if (plat && !mayDwellAt(net, plat.id, s.trainClass, s.model)) issues.push(`${tag}: Class ${s.trainClass} may not dwell at ${plat.name}.`);
    if (!plat) issues.push""")
edit(V,
 r"""  if (s.trainClass === 1 && !isFlexibleClass1(s.model) && (s.stops || s.platform !== null || plan.platforms.length > 0 || plan.usesBranch)) issues.push(`${tag}: a Class 1 train must run the mainline without stopping, without platforms or the branch.`);""",
 r"""  // Phase 11: a Class 1 train may be routed through platforms; its dwells are checked above and the branch by the section check.""")

# ---------------- timetable/generateTerminus.ts ----------------
T = 'src/engine/timetable/generateTerminus.ts'
edit(T, r"""import { getModel, isFlexibleClass1, modelsForClass, stockPerformance, type StockRef } from '../rollingstock';""", r"""import { getModel, modelsForClass, stockPerformance, type StockRef } from '../rollingstock';""")
edit(T, r"""import { boundaryCorridor, permissionsFor, planTerminalCycles,""", r"""import { boundaryCorridor, mayDwellAt, planTerminalCycles,""")
edit(T, r"""/** Flexible Class 1 stock: the models that may work an express and still terminate. */""", r"""/** Class 1 stock: any model that may work an express (Phase 11: every Class 1 may terminate at Northbridge). */""")
edit(T, r"""  const models = modelsForClass(1).filter((m) => isFlexibleClass1(m.id));""", r"""  const models = modelsForClass(1);""")
edit(T, r"""    const realCls: Cls = cls === 1 && !isFlexibleClass1(stock.model) ? 2 : cls;""", r"""    const realCls: Cls = cls;""")
edit(T,
 r"""  const onwards: Cls[] = trainClass === 5 ? ([...(m?.classes.filter((c) => c === 1 || c === 2) ?? []), 5] as Cls[]) : [trainClass];""",
 r"""  // Phase 11: an ECS train arriving at a terminus always leaves as a passenger service; a Class 1 or 2 train may leave as itself or as ECS.
  const onwards: Cls[] = trainClass === 5 ? ((m?.classes.filter((c) => c === 1 || c === 2) ?? []) as Cls[]) : [trainClass, 5];""")
edit(T,
 r"""            const canCall = permissionsFor(trainClass, stock.model).canStop && trainClass === 2;""",
 r"""            // Calls at Northbridge-West: only a train that may dwell there (Class 2, flexible Class 1), never ECS, before or after the terminus.
            const inCall = trainClass !== 5 && mayDwellAt(ctx.net, NBW_IN[corridor] as string, trainClass, stock.model);
            const outCall = onwardClass !== 5 && mayDwellAt(ctx.net, NBW_OUT[corridor] as string, onwardClass, stock.model);""")
edit(T,
 r"""              dwellS: rng.pick(trainClass === 5 ? [120, 180, 240] : trainClass === 1 ? [90, 120] : [90, 120, 150]),""",
 r"""              dwellS: trainClass === 5 ? 0 : rng.pick(trainClass === 1 ? [90, 120] : [90, 120, 150]),""")
edit(T, r"""              inboundCall: canCall && rng.next() < 0.6,""", r"""              inboundCall: inCall && rng.next() < 0.6,""")
edit(T, r"""              outboundCall: canCall && rng.next() < 0.4,""", r"""              outboundCall: outCall && rng.next() < 0.4,""")

# ---------------- ui/panels/TrainPanel.tsx ----------------
P = 'src/ui/panels/TrainPanel.tsx'
edit(P, r"""  getModel,
  modelsForClass,
  permissionsFor,""", r"""  classAllowsLine,
  getModel,
  mayDwellAt,
  modelsForClass,""")
edit(P,
 r"""  const perms = permissionsFor(cls, model.id);
  const lengthM = stockPerformance(stock).lengthM;
  const wantsStop = stops && perms.canStop;""",
 r"""  const canStopAnywhere = [...ctx.net.platforms.keys()].some((id) => mayDwellAt(ctx.net, id, cls, model.id));
  const lengthM = stockPerformance(stock).lengthM;
  const wantsStop = stops && canStopAnywhere;""")
edit(P, r"""    if (cls === 1 && !perms.canStop && (origin === 'M-IO' || destination === 'M-IO'))""", r"""    if (cls === 1 && !classAllowsLine(1, 'BRANCH', model.id) && (origin === 'M-IO' || destination === 'M-IO'))""")
edit(P, r"""checked={wantsStop} disabled={!perms.canStop}""", r"""checked={wantsStop} disabled={!canStopAnywhere}""")
edit(P,
 r"""        {!perms.canStop ? <p className="note">A {model.name} working as Class 1 never stops, never uses platform loops and never uses the branch. Class 387 and 350 can work as Class 1 with stops and the branch.</p> : null}""",
 r"""        {!canStopAnywhere ? <p className="note">{cls === 5 ? 'ECS trains never dwell at a platform: they only stand in sidings.' : `A ${model.name} working as Class 1 never dwells at a platform here. It may be routed through platforms${classAllowsLine(1, 'BRANCH', model.id) ? '' : ' but never uses the branch'}.`}</p> : null}""")

APPEND = {
 'README.md': '\n\n## Phase 11: dwell and platform rules\n\nExpress (Class 1) trains may be routed through platforms on every map and are held at signals like any train. They never dwell at Ashcombe; at Northbridge they dwell at the terminus platforms, and at Northbridge-West only with flexible stock (387, 350). ECS only dwell in sidings: they never dwell at a platform. An ECS train arriving at a Northbridge terminus always leaves as a passenger service; a Class 1 or 2 train may leave as ECS (with no call at Northbridge-West). See docs/DWELL-RULES.md.\n',
 'docs/ARCHITECTURE.md': '\n\n## 20. Phase 11: dwell and platform rules\n\n`classAllowsLine` decides where a class may be ROUTED (Class 1 now includes PLATFORM tracks); the new `mayDwellAt(net, platform, class, model)` in `trains/classes.ts` decides where it may DWELL (Class 5 never; Class 1 only at Northbridge terminus platforms, and at Northbridge-West only with flexible stock; Class 2 everywhere). `spawnTrain`, `createTrain`, `platformOptions`, `planServices`, both timetable generators and `validateService` / `validateTerminalService` use it. A terminus stop with a dwell of 0 (ECS changing ends) is not a dwell. See docs/DWELL-RULES.md.\n',
}

def main():
    root = pathlib.Path('.')
    texts, errors = {}, []
    for path, old, new in E:
        p = root / path
        if not p.exists():
            errors.append(f'missing file: {path}'); continue
        t = texts.get(path) or p.read_bytes().decode('utf-8')
        crlf = '\r\n' in t
        o, n = (old.replace('\n', '\r\n'), new.replace('\n', '\r\n')) if crlf else (old, new)
        c = t.count(o)
        if c != 1:
            errors.append(f'{path}: expected 1 match, found {c} for: {old[:90]!r}'); continue
        texts[path] = t.replace(o, n)
    for path, add in APPEND.items():
        p = root / path
        if not p.exists():
            errors.append(f'missing file: {path}'); continue
        t = texts.get(path) or p.read_bytes().decode('utf-8')
        if 'Phase 11: dwell and platform rules' in t:
            continue
        texts[path] = t.rstrip('\n') + (add.replace('\n', '\r\n') if '\r\n' in t else add)
    if errors:
        print('NOTHING WRITTEN. Problems:'); [print(' -', e) for e in errors]; sys.exit(1)
    for path, t in texts.items():
        (root / path).write_bytes(t.encode('utf-8'))
        print('patched', path)
    print('Done. Now run: npm run typecheck && npm test')

main()
