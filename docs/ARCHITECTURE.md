# Architecture

> Educational game simulation. Not a certified or operationally safe railway signalling system.

## 1. Layers and dependency direction

```
ui  ──►  layout  ──►  engine
 └──────────────────►  engine
```

- `src/engine` knows nothing about screens, React or the DOM. It must keep building and testing on its own.
- `src/layout` knows the engine's IDs and nothing else. It holds coordinates.
- `src/ui` renders engine + layout and owns presentation state (selection, highlight).

The engine never imports from `layout` or `ui`. This is the rule that keeps the simulation independent of the UI.

## 2. Logical network model (`src/engine/topology`)

The network is a graph of **track sections** (track circuits). Each section has two ends, `A` and `B`. Every end is attached to exactly one of:

| Attachment | Meaning |
| --- | --- |
| **link** | plain joint to one other section end |
| **point** | a switch: one **toe** end, a **normal** leg and a **reverse** leg |
| **boundary** | edge of the controlled area (entry, exit or both) |

A movement is a graph walk: leave a section through an end, look at what that end is attached to, enter the next section. Points decide which of the two legs a facing move can enter; a trailing move through a leg is only possible if the point is set to that leg.

- **Traffic direction** (`AB`, `BA`, `both`) is a property of each section.
- **Signals** stand at a section end and govern trains leaving through it. Automatic signals appear only where no route has to be chosen.
- **Diamond crossing** (`DX` / `LBX`): two sections that cross on the flat. It connects nothing. It is declared with `crosses` so interlocking treats the two as a shared resource in Phase 2.
- **Junctions** group the points and crossover sections that belong together.

### Validation (`validateNetworkDef`)

A network that fails validation does not load. It rejects: unknown or duplicate IDs, a section end attached twice or not at all (dangling track), a signal facing a direction its section forbids, a boundary its section cannot serve, asymmetric crossings, points not in a junction, and any section not connected to the rest. "Tracks that are only visually connected" cannot exist, because a section can only exist in the graph, and every end has to be attached.

### Derived route table (`deriveRoutes`)

Signal-to-signal movements are **found by walking the graph**, not typed in. Each movement lists its sections, required point positions and feature tags. The test suite holds a golden list so any layout change is reviewed. Phase 2 route setting builds on this table.

## 3. Separating the logical network from its drawing

| | Logical network | Layout |
| --- | --- | --- |
| Location | `src/engine/topology/ashcombe.ts` | `src/layout/ashcombeLayout.ts` |
| Contains | sections, links, points, signals, platforms, boundaries | one polyline per section (A→B), platform rectangles, text labels |
| Coordinates | none | yes |
| Used by simulation | yes | no |

The drawing is **derived** from the network:

- Section tracks come from the polylines.
- Signal positions are computed from the section end, its direction of travel and left-hand running. The layout never places a signal.
- Point positions, joints, boundary arrows and the gap that shows a point's set position are computed from the network and state.

`validateLayout` (run in tests and on every page load) proves the drawing agrees with the network:

1. every section is drawn once, nothing extra is drawn;
2. both ends of every link share one vertex;
3. all three ends of every point share one vertex, with the legs on the side opposite the toe;
4. drawn sections only touch at ends that are logically joined, and only cross where the network declares a crossing (and a declared crossing must be drawn crossing);
5. platforms and label offsets refer to real entities.

Consequently, moving a track in the layout can make the diagram *wrong* (and the validator will say so) but can never change which sections connect. Trains in Phase 3 will move along the **network**; the layout is consulted only to turn a position along a section into a screen position (`pointAlong` in `geometry.ts`).

## 4. Ashcombe Junction topology

West is left, north is up. UP main runs eastbound (north track), DOWN main westbound (south track), as British left-hand running.

The drawn diagram is `docs/phase1-layout.png` (and the running app). The table below is the authoritative description.

| Feature | Sections / points |
| --- | --- |
| UP main (eastbound) | UP1 – UP12 |
| DOWN main (westbound; DN4 – DN7 bi-directional) | DN1 – DN11, DX |
| Branch from Merefield | BR1, BR2, then legs LA1–LA3 and LB1, LBX, LB2 |
| Branch junction (south-west of the station) | points BJ, DJ, UJ and the diamond DX / LBX |
| Crossovers | west: WXU + XW + WXD (eastbound); east: EXD + XE + EXU (eastbound) |
| Platform 1 | P1W, **P1**, P1E on points PW1 / PE1, off the UP main |
| Platform 2 | P2W, **P2**, P2E on points PW2 / PE2, off the DOWN main |
| Boundaries | Westford: W-IN (UP1), W-OUT (DN11); Northbridge: N-IN (DN1), N-OUT (UP12); Merefield: M-IO (BR1) |
| Signals | 16: 6 automatic (U1 U5 U6 D1 D4 M2), 10 manual (U2 U3 U4 D2 D3 DR1 P1E P2E P2W M1) |

Both branch legs start at BJ: leg A (LA) rejoins the DOWN main at DJ, so westbound trains can leave for Merefield; leg B (LB) crosses the DOWN main on the diamond and joins the UP main at UJ, so Merefield trains can reach the UP main. Eastbound trains may also run "wrong line" along the bi-directional DOWN main through Platform 2 and cross back to the UP main at the east crossover.

### Movements the layout supports (derived and tested)

| From | Can reach |
| --- | --- |
| Westford (UP main entry) | Northbridge only; Platform 1 and Platform 2 |
| Northbridge (DOWN main entry) | Westford or Merefield; Platform 2 only |
| Merefield | Northbridge only; Platform 1 and Platform 2 |

### Design consequences to review

- **Platform 1 is eastbound-only.** Trains arriving from Northbridge can only stop at Platform 2. A Class 2 from Northbridge therefore never uses Platform 1. Making Platform 1 bi-directional would need more signals and points on the UP main.
- **Westford ↔ Merefield through running is impossible.** Both are west of the junction; it would require a reversal. Timetable generation (Phase 5) must respect this.
- **Merefield trains reach Northbridge only**, and cross the DOWN main on the diamond to do so. A Merefield train and a westbound DOWN-main train conflict at the diamond, which is where the interesting route conflicts come from.

## 5. Signalling and route setting (Phase 2)

All of this lives in `src/engine/signalling` and has no React or coordinates.

| Module | Responsibility |
| --- | --- |
| `context.ts` | Read-only index of the Phase 1 route table (`deriveRoutes`). Not a second graph: it adds only the direction each route runs through each section, so opposing movements can be recognised on bi-directional track. |
| `routeSetting.ts` | `validateRoute` (pure check, also drives the preview), `establishRoute`, `requestRoute` (entrance + exit signal IDs). |
| `points.ts` | `pointBlock` and `movePoint`: a point moves only if it is not locked and its toe section is clear. |
| `locks.ts` | The **only** place routes and locks are added or removed (`lockRoute`, `unlockRoute`), plus `checkLockInvariants`. |
| `release.ts` | `validateCancel`, `cancelRoute`, `cancelRouteFrom`. |
| `aspects.ts` | `computeAspects`: the **only** place an aspect is decided. |
| `explain.ts` | `explainAspect`: read-only plain-English reason for an aspect (feedback only). |

### State

`SignallingState` is immutable: `network` (Phase 1 point positions and occupancy), `routes` (entrance signal to route ID), `sectionLocks` and `pointLocks` (to the owning route ID). An operation returns a new state; a **refused operation returns the identical state object**, so a failed request provably changes nothing.

### Route setting

`validateRoute` checks, in order, and stops at the first failure: movement exists; entrance signal is manual; signal has no route already; no section occupied; no section reserved by another route; no diamond partner reserved; no opposing movement (including over the section the entrance signal stands in); no point locked by another route; every point that must move is free to move. Only if everything passes does `establishRoute` build the new point positions and locks **in one step**. There is no intermediate state, so there is nothing to roll back.

### Aspects

An aspect is a pure function of the state (`computeAspects`). A signal protects one movement: a manual signal the route established from it, an automatic signal its single derived movement. The movement lets the signal clear only if it is proven:

- **manual**: the route is recorded, holds every section and point lock, every point is in position, and no section is occupied;
- **automatic**: every section is clear and unreserved, no diamond partner is reserved, every point is in position and unlocked, and no established route opposes it.

The colour then comes from the next signal: Red ahead gives Single Yellow, Single Yellow ahead gives Double Yellow, Double Yellow or Green ahead gives Green. A movement ending at an exit boundary sees a clear line. There is no way to set an aspect from outside: it can only change by changing the state. An established manual route whose track becomes occupied shows Red but stays established.

### Release

Phase 2 uses **whole-route release**. Cancellation is refused while any section of the route is occupied. Only the cancelled route's locks are removed. Locks are recorded per section and per point, so sectional release only needs a finer `unlockRoute` once trains exist.

### Interface

`src/ui/routeUi.ts` is the selection state machine (pure functions, tested): click a manual signal (entrance), click a reachable signal (proposal and preview), press *Set route*. It never decides safety; every verdict is the engine's. The occupancy and point controls in the inspector are **test controls**, kept separate and labelled as such. There are no trains.

### Phase 2 limitations

- No approach locking, release delays or sectional release (they need trains).
- Moving a point is blocked by occupancy of its toe section only.
- Automatic signals do not lock what they protect: they turn Red if a point is moved or a route reserves their track.
- Routes run signal to next signal. A longer journey is several routes.
- Occupancy exists only as a test marker, not from trains.

## 6. State

`NetworkState` (point positions, section occupancy) is separate from the immutable network and is updated by returning new objects. In Phase 1 the `review*` functions change it directly for layout inspection. In Phase 2 point movement goes through route setting and locking and these functions are removed or guarded.

## 7. Planned structure for later phases

| Phase | Adds |
| --- | --- |
| 2 | **done** – `engine/signalling` (aspects, route setting, locks, points, release) |
| 3 | **done** – `engine/trains` (fixed-step movement along the network), `layout/trackPath`, train layer and panel |
| 4 | `engine/station` |
| 5 | `engine/timetable`, `engine/shift` |
| 6 | polish |

Route locking in Phase 2 starts as whole-route release with the data structure (per-section locks) arranged so sectional release can follow.

## 8. Train movement (Phase 3)

One test train. Nothing in `engine/trains` knows about coordinates.

| Module | Responsibility |
| --- | --- |
| `engine/trains/types.ts` | `TrainSpec` (headcode, class, length, max speed, acceleration, service and emergency braking, stop margin, origin, destination), `Train`, events |
| `engine/trains/step.ts` | `spawnTrain`, `stepTrain` (one fixed step), `removeTrain` |
| `engine/trains/lookahead.ts` | First thing ahead the train must not pass: a Red signal, points not set, a section occupied by something else |
| `engine/trains/geometry.ts` | Front, rear, occupied path steps, direction |
| `engine/trains/protection.ts` | Approach locking: a route cannot be cancelled while the train is in its entrance section |
| `engine/trains/clock.ts` | `FixedStepClock`: 20 Hz steps whatever the frame rate; leftover time becomes `alpha` for interpolation |
| `layout/trackPath.ts` | Maps metres along a train's path to screen position and heading, and gives the drawn polyline between rear and front |
| `ui/sim/simulation.ts` | Owns the signalling state and the train; driven by `advance(seconds)` (animation frames in the browser, invented frame times in tests) |
| `ui/diagram/TrainLayer.tsx`, `ui/panels/TrainPanel.tsx` | Presentation only |

**Movement.** A train has a path (sections entered, each with the end it came in through), a front position in metres from the start of the path, and a rear at front minus length. Front and rear are independent. Crossing a section end asks `nextWithPositions` for the next section using the CURRENT point positions, so the train only follows points as set and only follows what the signaller routed.

**Signals.** Each step the Phase 2 `computeAspects` gives every aspect (the train never decides one). `lookAhead` walks forward through every signal that shows proceed to the first Red, wrong point or foreign occupancy. Speed is held under the service braking curve to a stop `stopMarginM` short of it. A hard clamp then guarantees the front can never reach that limit whatever the step size. If a signal turns Red too close for a smooth stop, braking rises to the emergency rate and, if that is still not enough, the train is stopped at the limit and a `protection-stop` event is logged.

**Occupancy.** A section is occupied while the front has reached its start and the rear has not yet passed its end, so a train straddling a joint holds both sections. The train writes only its own ID; test markers and other occupants are left alone.

**Points and routes.** A manual signal's route is already locked. When the front passes an automatic signal, the single movement it protects is locked as a route (through the existing `lockRoute`), so its points and sections stay protected. A route is released (existing `unlockRoute`) only when the REAR has cleared its last section. Phase 2 modules are untouched.

**Drawing.** Each section is mapped linearly from its length in metres to its drawn polyline, in the direction the train enters it, so the body (rear to front) bends round corners and cannot jump at a joint. Before the start and after the end the path continues in a straight line, so the train enters and leaves the screen smoothly.

### Phase 3 limitations
- Whole-route release only: sections behind the rear are not freed until the rear clears the route's last section (conservative).
- Approach locking covers a train in the entrance section only; a signal that goes Red further back is handled by braking.
- The test train starts from rest at the entry boundary. No station stops, timetable or multiple trains.
- The UP main is eastbound only in this topology, so Northbridge → Westford runs westbound on the DOWN main.

## 9. Phase 3.5

- **Boundary approaches.** Every external approach has at least three consecutive automatic signals. Added: Westford UP `UPW2, UPW1` (signals `UW2, UW1`); Northbridge DOWN `DNE2, DNE1` (`DE2, DE1`); Westford DOWN `DNW1, DNW2` (`DW1, DW2`); Northbridge UP `UPE1` (`UE1`); Merefield branch `BRM3, BRM2, BRM1` (inbound `MW3, MW2, MW1`, outbound `MX1, MX2`), bi-directional single track. Boundaries now sit on the outer new sections; the layout's drawing area is widened (`marginLeft`/`marginRight`) so nothing existing moved.
- **Override.** `SignallingState.signalOverrides` holds automatic signals forced to Danger. `computeAspects` returns the effective aspect (Red for a forced signal, so the signals behind see a Red ahead); `computeUnderlyingAspects` ignores overrides and is used for display only. Trains read the effective aspects, so they stop short of a forced signal. The override touches nothing else.
- **Route UI.** `clickSignal` establishes the route on the exit click through the unchanged interlocking; `establishMovement` does the same for the Routes panel.

## 10. Phase 4: station operations and multiple trains

**One engine, many trains.** `stepTrain` is the only movement code. `stepFleet` (`engine/trains/fleet.ts`) steps every started train in turn against the same `SignallingState`, so each sees the occupancy, locks and aspects the previous one left. A `Train` carries its own ID, headcode, class, path, front/rear, speed, kinematic `state` and operating `status` (waiting to enter, approaching, running, braking, stopped at signal, approaching platform, stopped at platform, dwelling, ready to depart, departing, exiting, completed), stop configuration and a plan (informational list of movements). `Simulation` (UI, no React) holds the fleet, the selection and the single fixed-step clock.

**Entry at speed.** A train with `spec.entrySpeedMs > 0` is created with its front `WAIT_OUTSIDE_M` (2 m) outside the boundary: it occupies nothing. When started it is *admitted* only if, at its entry speed, it could still stop short of the first limit ahead (`curveSpeed(service brake, gap − margin) >= entry speed`); an occupied entry section is a limit at 0. Otherwise it waits, with a reason. Position is continuous; only the speed at the boundary is set (it represents the train arriving from the neighbouring location). `entrySpeedMs` absent or 0 keeps the Phase 3 behaviour (standing at the boundary), which the Phase 3 tests use.

**Platform stopping position.** `platforms.ts`. A platform is its track section. The logical stopping position is measured in the direction of travel: the front stops `PLATFORM_END_MARGIN_M` (10 m) short of the section's far end, i.e. at `endOf(platform step) − 10`. `lookAhead` returns a `platform` limit (with `marginM`) for a train whose stop is not yet finished, so the existing braking curve brakes the train to rest exactly there; a Red signal earlier on the way still wins because it is met first. Platform 2 (both directions) has a stopping position per direction with no special case. Fit: `length <= platform length − margin`; a train that does not fit is refused at creation.

**Dwell and departure.** Stop phases: `pending → dwelling → done → departed`. The dwell counts down by the fixed step `dt` only while the fleet is stepped, so pause freezes it and the speed multiplier scales it consistently. When it reaches 0 the platform limit is dropped; the train then follows the ordinary signal limit, so it shows *ready to depart* while the starter is at Danger and never passes it. `departed` is recorded when the rear has cleared the platform section.

**Sectional release (the one interlocking change).** Whole-route release would keep the arrival route's entrance signal and points locked while a train stands in the platform, so nothing could pass on the main line. Now, when the front passes a route's entrance signal, `detachRoute` removes the route from `routes` (the signal returns to Red behind the train) and records it in `SignallingState.residual`. The locks stay, owned by the route ID. As the rear clears each section, `releaseCleared` frees that section, and a point once every section of the route touching it is free; a residual route with nothing left locked disappears. Only locks owned by that route are touched. `checkLockInvariants` accepts a residual route's locks as a subset of its route. Route setting, aspects and the validity checks are unchanged: a section or point still locked by a residual route refuses any new route over it.

**Classes** (`classes.ts`). Class 1: UP, DOWN, crossover, link; never PLATFORM or BRANCH; cannot stop. Class 2: all line kinds; may stop. Class 5: UP, DOWN, platform, crossover, link; may stop. A section a class may not use is a `restricted` limit in `lookAhead` and acts like a Red signal: a Class 1 express whose signaller routes it into a loop stops at the foot of the loop.

**Service planner** (`planner.ts`). Depth-first search of the logical network (ignoring current point positions) from the origin boundary to the destination boundary, filtered by class and by the requested platform, giving for each path a label and the movements to set (the manual ones listed separately). It never sets a route or moves a point. Results are cached per context.

**Passing scenario and topology.** A Class 2 train stopping in Platform 1 (eastbound only) and a Class 1 express both entering at Westford: the express passes on the UP main (UP7–UP10, points PW1/PE1 normal) while the stopper stands in P1. PW1 is free for the express once the stopper's rear has cleared UP7 and P1W; P1 stays locked until it leaves; the departure route P1E→U6 conflicts with the express over PE1/UP10, so the signaller sets it after the express is past. In the other direction, Platform 2 works for both directions. No topology restriction had to be changed; Platform 1 remains unreachable from Northbridge.

### Phase 4 limitations
- No automatic route setting: the signaller sets every manual route (by design; Phase 5 is for timetables).
- Trains run only over what the signaller sets; a train held at a Red signal that is never cleared waits indefinitely.
- Entry speed is applied at the boundary when admitted (no neighbouring-area simulation).
- Approach locking still covers a train in the entrance section only.
- Class 5 is not allowed on the branch (spec: "mains and loops").

## 11. Phase 5: timetables, traffic and shifts

**U5 is manual.** Signal U5 (UP main, guards PE1) changed from automatic to manual; topology and position are unchanged. Routes through PE1 now need the signaller to set them; it stays Danger without a route and cancels back to Danger.

**Time.** All timetable times are simulated seconds since shift start (`sim.clockS`, shown as 08:00 onward). Nothing uses wall-clock time; pause, resume and speed scale the same clock.

**Services** (`engine/timetable/types.ts`): headcode (first digit = class), class, origin/destination boundary, entry and exit line, scheduled boundary entry, whether it stops, platform, scheduled station arrival/departure (or pass time), expected exit, route label and the manual movements. Actual times (entry, arrival, departure, pass, exit) are recorded separately; delay = actual − scheduled and is never reset.

**Generation** (`generate.ts`, seeded RNG in `rng.ts`). Picks 5–7 services with a class mix, from the planner's valid journeys; journey durations come from running the real train engine with a lone train (`profile.ts`, cached). Class 1 never stops or uses the branch.

**Validation** (`validate.ts`). Per-section and per-point occupancy windows with 45 s separation, 150 s entry headway, platform and route conflicts, opposing movements and impossible timings. Conflicting timetables are regenerated; after the attempt limit a deterministic known-safe fallback is used, and it is validated too. An invalid timetable is never silently accepted.

**Shift lifecycle** (`ui/sim/shift.ts`). Not started → running → completed/abandoned. Start clears trains, locks and occupancy and resets the clock. A step hook spawns eligible trains only when the entry section is free; a late train is kept, not discarded. Departure is held to the scheduled time, with the minimum dwell never shortened. The shift ends when all services have entered or been cancelled, all entered trains have fully exited, and none are waiting.

**Summary** (`summary.ts`): counts, class mix, stopped-at-station, average entry/arrival/departure/exit delay (n/a excluded), on-time vs delayed, most delayed, total delay; cancelled and failed are not counted as completed. Previous summaries are kept.

### Phase 5 limitations
- Timetable times are rounded to 10 s, so delays of a few seconds appear even when the signaller is perfect.
- Traffic is generated per shift only; there is no continuous or random in-shift traffic.
- Class 5 uses the mains and loops (no branch), as in Phase 4.
- The signaller still sets every manual route; trains wait indefinitely otherwise.

## 12. Phase 6: integration and quality of life

**Event log** (`ui/sim/eventLog.ts`). Plain TypeScript. Entries have simulation time, category, level and the shift id. The visible view is filtered and starts after the last Clear; the underlying record (bounded at 3000) and each shift's `events` are never cleared by it. Sources, wired once by `ShiftController.attach()` (called from an effect, returned function detaches): train-engine events; `diffSignalling(prev, next)` (`engine/signalling/changes.ts`, pure) run on every signalling-state change, which reports routes established/cancelled, points moved, locked/unlocked, forced Danger and restored, and manual-signal aspect changes (a route whose signal a train passed is not a cancellation; automatic aspects are not logged). State replacement (shift start, abandon, reset) is wrapped in `log.silent`. UI actions only add *refusals* and notes, so nothing is logged twice.

**Shift history** (`ui/sim/storage.ts`). Finished and abandoned shifts are saved at once to localStorage (versioned, last 8, events capped). Loading validates every field; a damaged shift is dropped alone, unusable data gives an empty history and is removed, storage failures are swallowed. Restored shifts show rows from their stored actuals only (never matched to live trains).

**Reliability.** `Simulation.advance` catches a failure inside a step, pauses, and reports through `onError` (plain message in the log, detail in the console), so the animation loop survives. An error boundary shows a plain message if rendering fails. Text panels re-render through `useSlowFrame` (4 Hz); only the train drawing uses every frame. Measured: the signalling state reference changes about 250 times in a 40 000-step shift, so the diff and the render work happen rarely.

**Scenarios** (`ui/sim/scenarios.ts`) are seeds for the unchanged generator. A scenario with injected delays needs a new shift feature (late release of a service) and was deferred.

### Phase 6 limitations
- No scenario with injected delays.
- The log shows the last 200 matching entries; older ones remain in the record and shift events.
- Saved history is per browser and per origin.

## 13. Phase 7: rolling stock, train models and performance

**Data.** `engine/rollingstock` holds the database (`ROLLING_STOCK`: `ModelDef` with `FormationDef`s) and queries (`stockProblem`, `permittedClasses`, `isFlexibleClass1`, `defaultStock`, `stockPerformance`). A train has an operating class (1/2/5) *and* a `StockRef {model, formation}` on its `TrainSpec`; class is never used as a model. Generic test trains with no stock keep the Phase 3 defaults.

**Compatibility.** `permissionsFor(trainClass, model)` gives what a train may do. Class 1 expresses never stop or use the branch, except the flexible models (387, 350), which get the Class 2 line permissions and `canStop`. The planner, look-ahead, `createTrain`, the generator and the validator all go through it.

**Performance.** `accelerationAt(spec, v) = a0 · (1 − (1 − taper) · v / vmax)`; braking is a constant service rate on the same braking curve as before, with the emergency rate only when a curve is violated. Longer formations have lower `a0`. Entry speed is the lower of the class entry speed and 75 % of the model's top speed. All movement is in fixed 0.05 s steps.

**Length.** Occupancy, sectional release, the exit boundary and platform fit already worked from the front and rear positions; Phase 7 gives them real lengths. Journey profiles (the generator's lone-train runs) are cached per model and formation, so the timetable's section windows reflect the actual stock.

**Generator.** Stock is chosen on its own RNG stream with database weights, after the class mix, so the shift size and class distribution are unchanged. Flexible Class 1 services stop with probability 0.5.

**Inspector.** `ui/panels/TrainPerformance.tsx` (4 Hz) reads the train and `signalAhead` (next signal, aspect, distance).

### Phase 7 limitations
- No speed limits are enforced (Phase 8): a 125 mph train can reach high speed in the ~2.8 km area and stops only for signals.
- Acceleration is a linear taper, not a tractive-effort curve; braking is a single constant rate.
- Generic test trains created without stock use the legacy defaults.
- Saved shifts from before Phase 7 get the default stock for their class, not the stock they actually ran.

## 14. Phase 8: speed restrictions, braking, distances, concurrent traffic

**Distances.** `lengthM` on a section is simulated metres. The drawing is separate (`layout/`), and `trackPath` maps metres to drawn positions per section, so a 1,300 m approach can be a short line. Nothing in the movement engine reads the drawing.

**Limits.** `engine/speed/config.ts` is the only place speeds are set. `sectionLimit(net, id)` combines the line kind, "reverse leg of a set of points" (diverging) and per-section entries; the most restrictive wins. `lookAhead` returns the limited segments of the sections it walks (the route as the points lie); `stepTrain` adds the sections already entered.

**Braking.** `speedEnvelope` gives the fastest allowed speed at the front position: model maximum, every restricted stretch the train is inside until its rear leaves, and for each restriction ahead the curve √(L² + 2·a_plan·d). `stepTrain` takes the lower of its existing stop logic (signals, platform) and this envelope, never braking harder than the service rate for a restriction. A train follows the envelope, so there is no abrupt braking and no accelerate/brake chatter.

**Overspeed.** `permittedAt` gives the permitted speed; `SpeedInfo` on the train carries it, the next restriction, and the overspeed flag (with a small tolerance and hysteresis). Events `overspeed` / `overspeed-ended` are raised on change only. Nothing brakes for it. `TrainSpec.ignoreRestrictions` is test-only.

**Signals.** Unchanged. The look-ahead sees the actual chain of aspects; a train is stopped by the first signal at Danger on a service-rate curve, so the approach speed follows from braking capability and block lengths. The blocks on the outer approaches (≈1.2 km) allow a 125 mph train to stop within two blocks.

**Timetable.** `generate.ts` picks a pattern (busy / normal / quiet) that sets the gap between entries, places each service at the earliest time that does not conflict with those already placed (10 s steps), and aims for a target number present at once, relaxing it after many attempts rather than inventing an unsafe overlap. `validate.ts` treats the two sections of the diamond crossing as one resource. `concurrency.ts` measures overlap. The fallback set overlaps.

**Test signaller.** `shiftBot.ts` (tests only) sets each route when the train is near enough to need it (braking distance plus a margin) and the departure route as the dwell runs out, and treats another train's residual route as "wait", not "done".

### Phase 8 limitations
- Acceleration is still a linear taper, braking constant; no gradient or adhesion.
- Speed restrictions are by section and by diverging leg, not by train type or time of day.
- A human signaller can still create a head-on deadlock on the single-track branch by setting conflicting routes early; the timetable avoids it but the interlocking does not forbid it.
- Concurrency depends on the lone-train windows; a late train can delay the next one.
