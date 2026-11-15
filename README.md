# Ashcombe Junction – railway signalling simulator

A browser-based simulator of a fictional modern British signalling control area, built with React, TypeScript and Vite.

> **Educational game simulation. Not a certified or operationally safe railway signalling system.**

## Status

**Northbridge Station map: implemented, awaiting review** (see "Northbridge Station (second map)" below). Ashcombe Junction is unchanged.

**Phase 10 – Increased traffic and timetable complexity: done, awaiting review.** Phase 9 (Ashcombe Sidings, shunting signals, train reversal) and Phases 1–8.5 (zoom/pan, interface, platforms, signal names, speed limits, rolling stock) are kept. Phases 1–5 are kept: the topology, interlocking, two-click routes, approaches and override are unchanged in behaviour. The one deliberate change to the interlocking is *sectional route release* (below).

| Implemented | Not yet implemented |
| --- | --- |
| Logical topology, validated; four-aspect signals; route setting, locking, release | Passengers, ticketing, economics |
| Many trains at once through one movement engine (`stepTrain` / `stepFleet`), each with its own state | |
| **Phase 5:** seeded timetable generator (5–7 trains, Class 1/2/5), validator with safe fallback; shifts started only by *Start shift*, shift clock (08:00), live timetable with statuses and delays, shift-end summary and history | |
| Signal **U5 is now manual** (it guards PE1); a route must be set through it | |
| Trains enter already moving, from just outside the boundary (Class 1: 25, Class 2: 18, Class 5: 15 m/s) | |
| Platform stops: smooth braking to a logical stopping position, fit check, dwell timer (simulation time), ready-to-depart, departure under the signals | |
| Classes: 1 express (mainline, never stops), 2 regional (stops at its platform, branch, loops), 5 ECS (mains and loops) | |
| Sectional route release: a passed signal returns to Red; each section and point is freed only after the rear has cleared it | |

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # topology, interlocking, trains, UI simulation tests (node:test via tsx)
npm run typecheck
npm run build
```

## Using the screen

- **Set a route:** click a manual signal (the ringed ones), then click the signal you want to route to (candidates are marked; hovering one previews the path). The route is set at once if the interlocking allows it; otherwise the reason appears in the messages and nothing changes. *Esc* or a second click on the entrance cancels.
- **Force an automatic signal to Danger:** select it, press *Force to Danger* in the inspector. *Return to Automatic* resumes normal operation.
- **Cancel a route:** use *Cancel* in the Routes panel or the inspector. It is refused while the route is occupied or a train is approaching its entrance signal.
- **Create a train** (Trains panel): choose class, headcode, origin, destination, whether it makes a station stop (only platforms that are reachable on that journey, long enough, unoccupied and unassigned are offered), the dwell in seconds and one of the valid routes. *Signaller sets:* lists the routes you must set. Creating a train sets nothing: you set the routes. A new train waits just outside its boundary until you press *Start* (or *Start all waiting*); it is then admitted at its class entry speed if it could still stop short of whatever is ahead, otherwise it keeps waiting.
- **Passing scenario to try:** create `2A01` (Class 2, W-IN → N-OUT, Platform 1, dwell 150 s), set U2→U3, U3→U4, U4→P1E and start it. When it is dwelling create `1A02` (Class 1, W-IN → N-OUT), set U2→U3, U3→U4, U4→U5 and start it: the express passes on the UP main while 2A01 stands in the platform. When 2A01 shows *ready to depart*, set P1E→U6 once the express is clear.
- **Select a train** with its headcode in the list; its details (class, sections, speed, movement, status, platform, remaining dwell, destination) appear at the top of the Inspector. Trains never block clicks on the diagram.
- *Pause* stops every train and every dwell timer; *Reset scenario* removes all trains and frees everything they held. Routes you set that no train had passed are kept. *Reset* (top bar) returns everything to the start.
- Click any **section**, **point** or **signal** to inspect it. The inspector's test controls (mark a section occupied, move a point) remain; point moves go through the interlocking.

## Shifts (Phase 5)

A timetable is generated on load so it can be inspected; nothing runs until **Start shift**. Times are scheduled *boundary entry* times; station arrival/departure refer to Ashcombe. Trains become eligible at their entry time but still wait outside the boundary or at signals until the signaller makes it safe. Click a timetable row to see the service's route and the movements to set ("Signaller sets") in the inspector. The shift ends when every service has completed or been cancelled and the last train has fully left; a summary and history are then offered. Delays are actual minus scheduled; on time means under 60 s late. Seeds make timetables repeatable.

## Phase 6: operating the workstation

- **Operations strip** under the diagram: trains approaching, held/waiting, at a platform; routes set; locked points; forced Danger; occupied sections; and (in a shift) delayed services and the next service due. Click a headcode to select that train.
- **Event log** (right of the timetable): every entry has the simulation time and a category (Trains, Routes, Signals, Points, Timetable, Shift, Other). Filter with the category buttons; *Clear view* hides what is shown but never the shift record.
- **Timetable**: scheduled time with the actual time beneath it (amber when a minute or more late), a NEXT marker, delayed rows marked, *Hide finished*, and click a row to see its journey in the inspector. Clicking the body of a train on the diagram selects the train and its service.
- **Scenarios**: Random, Normal traffic, Busy station and Branch traffic. Each is a fixed seed for the unchanged generator (the seed box overrides it).
- **Shift history** is kept in the browser (last 8 shifts, including each shift's events) and can be reviewed (Summary / Service history / Events). *Forget saved shifts* deletes them. Unreadable saved data is ignored.
- Reset on the diagram is refused while a shift is running; abandon the shift first.

## Main menu and map selection

The app now opens on a main menu (`src/ui/menu/`), not directly on the workstation.

- **Main menu** → **Start** → **Map selection**: a horizontal railway line with three circular buttons (Clumberfield Freight Yard – Medium, Ashcombe Junction – Easy, Northbridge Station – Intermediate), laid out after the supplied reference. On narrow screens the line turns vertical.
- Clicking a circle opens that map's **information page** (name, difficulty, description, feature list, static preview, Start). Opening it does not start anything.
- **Ashcombe Junction** and **Northbridge Station** are playable; each Start opens that map's own workstation (separate shift history storage). Ashcombe's workstation is unchanged. The shift is still started separately with the workstation's own *Generate timetable* / *Start shift* controls.
- **Clumberfield Freight Yard** is marked "Coming soon" with a disabled Start; its preview is labelled *Conceptual preview — not a playable map*. Northbridge's preview is its real static track layout.
- There is deliberately no navigation back out of the workstation, so a running shift can never be discarded by accident (reload the page to return to the menu).
- Map text lives in `src/ui/menu/maps.ts`. To make a future map playable, register its workstation component in `defaultWorkstations` (`Shell.tsx`) and clear its `planned` flag.

## Northbridge Station (second map)

A six-platform terminus on the shared engine (`src/engine/topology/northbridge.ts`, `src/layout/northbridgeLayout.ts`, `src/ui/NorthbridgeApp.tsx`). Intermediate map difficulty; shifts use the Phase 10 profiles.

- **Two independent corridors:** AJ (Ashcombe Junction ↔ Northbridge, two tracks) and BR (Barchester ↔ Northbridge, four tracks: two central fast, two outer slow, merging as drawn). No route may use both corridors; they run at the same time.
- **Platforms:** Northbridge-West 1–2 AJ only, 3–4 BR only. Terminus platforms 1–2 AJ only, 3–4 AJ or BR, 5–6 BR only. Enforced by the interlocking (route validation and train-aware validation), not just the timetable.
- **Fast/slow:** chosen by the signaller (the timetable may only suggest a line).
- **Terminating trains:** approach → route → stop → dwell → change ends (standing only, 60 s) → new headcode → departure route → depart; the same physical train, rear clearance as normal. Shown in the timetable as the incoming/outgoing split rows used for ECS.
- Signals NB01–NB13 (manual), NB100–NB119 (automatic), NB31–NB36 terminus departure; there are no terminus entry signals, NB03 (AJ) and NB10 (BR) route straight into a platform.
- Differences from the supplied diagram, needed to make operation possible: crossovers X1/X2, connectors CAJ/CB*, and the departure signals NB31–NB36.
- The Trains test panel (manual through trains) is not offered here; it only has Pause and Speed. Services come from the shift timetable.
- Generating a Northbridge timetable measures every terminating cycle and takes about 2–8 s depending on difficulty.

## Phase 10.5: smooth signal aspect transitions

Signal lamps fade when an aspect changes: the lamp that goes out fades out (90 ms), then the newly lit lamp fades in (110 ms), about 200 ms in all, so two different aspects are never visible together and Double Yellow's two lamps move as one. It is drawing only: the logical aspect, interlocking, trains, event log and simulation clock are unchanged and never read the animation. With the operating system's reduced-motion preference the change is immediate. No setting was added.

## Phase 10: increased traffic and timetable complexity

- **Difficulty** (Timetable panel, before Start): Beginner 5–7 services, Standard 8–12, Advanced 13–18, Expert 19–25. These are generation *targets*; the profile (`engine/timetable/difficulty.ts`, plain data) also sets how deliberately trains overlap, the extra clearance kept, shift density and the minimum peak concurrency. The timetable can be inspected before Start; the same seed and difficulty always give the same timetable.
- **Planning.** Lone-train durations are measured with the real simulation; services are then placed over an occupancy index of section, point and siding windows. Independent routes overlap freely; shared resources keep real clearance (the validator's margin plus the difficulty margin); no artificial delay is added. If the railway cannot support the target safely, fewer services are generated and the reason is shown.
- **Testing information** (panel under the operations strip): count and target range, difficulty, peak concurrency, overlapping and independent-simultaneous pairs, junction interactions, close sequences, interaction kinds, and revised or reduced services with reasons.
- Scenarios now include Standard, Advanced and Expert seeds.

## Phase 9: Ashcombe Sidings, shunting signals and train reversal

- **Sidings.** *Ashcombe Siding 1* and *Ashcombe Siding 2* (north-east, "ECS access only") leave the DOWN main at SLP, cross the UP main on a diamond; a second lead leaves the UP main at SLU. Each siding is its own track section with its own occupancy; a siding holds one train and the whole train plus a clearance at the buffer stops must fit (capacity = section length − clearance, read from the topology).
- **Shunting signals** are triangles pointing the way they govern (red = Stop, green = Proceed), manual and interlocked, never self-clearing. **AJ1** (DOWN main) and **AJ4** (UP main, section UP11) are *main-line* shunting signals: they start the route into the sidings (click AJ1 or AJ4, then the buffer stops of the siding) and show green when it is set; trains running along the main line ignore them. **AJ5** and **AJ6** authorise a train leaving Siding 1 / Siding 2. There are no AJ2/AJ3 entry signals.
- **Reversal** is a physical state machine (approaching → braking → stopped/awaiting → reversing → ready, 60 s changing ends at zero speed). It happens in a reversal bay on the main lines (DN5, P2) or at the buffer stops of a siding, only when the train fits and the sections it will then occupy are available.
- **ECS cycle.** Only Class 5 ECS may enter a siding (refused by the interlocking checks). It can arrive from Northbridge, Westford or Merefield, stable for a varied time, then change headcode and class (model-compatible: 800/221/390 Class 1; 142/150/170/175 Class 2; 387/350 Class 1 or 2; any model Class 5) and leave to any exit a valid route reaches. It is the same physical train throughout.
- **Timetable.** The generator adds 0–2 ECS cycles per shift (modest traffic), checking siding capacity, length, routes, occupancy windows and the departure route; the validator checks them again.
- **Testing information** (Trains → Inspector) shows reversal state, direction, assigned siding, siding occupancy/capacity, stabling timer and incoming/outgoing headcodes and classes. The Event Log records the ECS milestones (not every tick).

## Phase 8.5: diagram navigation, interface, platforms and signal names

- **Zoom and pan.** Mouse wheel (centred on the pointer), the − / + buttons and *Reset view* in the bottom-right corner of the diagram (70 %–500 %), drag to pan, pinch on touch screens. A drag never selects or sets anything; a plain click still does. The whole drawing is one transformed group, so tracks, signals and trains cannot drift apart.
- **Trains keep one drawn size** whatever the length in metres of the section they are in (a longer train is a slightly longer symbol). Physical length, occupancy and braking are untouched.
- **Interface.** The compact train inspector (headcode, destination, speed, class) is fixed in the top-left of the diagram. **Enable testing information** shows the grouped diagnostics (operations strip, Trains, Inspector, Routes, About); **Enable the Event Log** shows the log. They are independent; events are recorded even while the log is hidden. Route feedback and *Cancel route* for the selected signal stay in the strip under the diagram.
- **Platforms.** The timetable platform is the plan; the route the signaller sets decides the platform used (`stop.scheduledPlatform` vs `stop.platform`, `actualPlatform` on the shift record). A route to a platform is refused when the train waiting for it does not fit (`validateRouteForTrains`), or by the interlocking when the platform is occupied or in conflict.
- **Signal names.** Manual signals are AJ01–AJ11, automatic signals AJ100–AJ116, shunting signals AJ1, AJ4, AJ5, AJ6 (fictional local convention; every name is unique). Internal ids (U2, P1E …) are unchanged; only `SignalDef.name` is shown. Behaviour comes from `type`, never from the name.

## Phase 8: speed limits, braking, distances and concurrent traffic

- **Longer railway.** Section lengths are simulated metres, independent of how they are drawn: the outer approaches are about 3.4 km (UP and DOWN), the branch 2.4 km, the departures 2.5–3 km. The diagram is unchanged.
- **Central speed limits** (`src/engine/speed/config.ts`): mainline 125 mph, branch 75, platform loop 45, diverging route 40 (crossovers and the branch-junction legs too). Edit the table there. A train's permitted speed is the most restrictive of its model's maximum and every section it occupies, front to rear, along the route actually set.
- **Braking.** Trains slow for upcoming restrictions along a service-rate braking curve (v² = u² + 2as, planned at 90 % of the model's service braking) so they reach the limit at the start of the restricted section, without abrupt braking. Signal behaviour is unchanged; the approach speed to a Danger signal comes from the braking distance and the signal sequence, not from fixed yellow-aspect speeds.
- **Overspeed is a warning only.** A train over its permitted speed is marked in the diagram, flagged in the inspector with speed, permitted speed and location, and logged once when it starts and once when it ends. It is never braked for it. For testing, the test-train form has an "Ignore speed limits (test)" box so the warning can be seen.
- **Concurrent traffic.** The generator keeps the same 5–7 services but places them to overlap wherever the infrastructure allows (UP with DOWN, platform loops beside the mainline, the branch beside the mainline), using the lone-train section windows, train length and the diamond crossing as one resource. The fallback timetable overlaps too.
- **Timetable and inspector.** A new "Held at signal" status; the inspector shows permitted speed, speed state, the next restriction with distance and braking distance, and a note when the signal ahead is restrictive.

## Phase 7: rolling stock and performance

- **Rolling-stock database** (`src/engine/rollingstock/models.ts`): nine models (Class 800, 221, 390, 142, 150, 170, 175, 387, 350), each with formations. Every formation has a real length, acceleration, service and emergency braking; every model has a maximum speed and an acceleration taper. Edit the data there; a consistency check (`validateRollingStock`) runs in the tests.
- **Operating class and model are separate.** Class 1 only: 800, 221, 390 (mainline, never stop, no branch). Class 2 only: 142, 150, 170, 175. Class 387 and 350 work as Class 1 or 2, may use the branch, and as Class 1 stop at Ashcombe when the timetable says so. Class 5 (ECS) may be any model. Invalid combinations are refused with a reason.
- **Length is physical.** A train occupies every section between its front and rear and releases each only once the rear has cleared it; it is not finished until its rear has left the exit boundary; platform fit uses the real length.
- **Acceleration and braking** are per model and formation, in simulation time, stable at every speed multiplier. Speed limits are **not** enforced yet (Phase 8): trains run up to the model's top speed on any line.
- **Timetables** choose a valid class, model and formation for each service (same size and class mix as before); older saved shifts without stock are given the default for their class.
- **Inspector**: select a train to see identification, physical characteristics and current state (speed, acceleration, stopping distance, section, destination, station, signal ahead), updating live.

## Project structure

```
src/
  engine/              Pure TypeScript. No React, DOM or coordinates.
    topology/            types, Ashcombe definition, validation, traversal, route derivation
    state/               point positions and occupancy, kept apart from topology
    signalling/          aspects, route setting, locks, points, release
    rollingstock/        Phase 7: model and formation database, class compatibility
    speed/               Phase 8: central speed limits, limit lookup, braking envelope
  layout/              Screen coordinates only, keyed by engine IDs. Pure TypeScript.
  engine/timetable/    Phase 5: services, generator, validator, delays, summary (pure, no UI)
  ui/                  React components (ui/sim/shift.ts is the shift controller)
docs/ARCHITECTURE.md   Topology, layout separation and design decisions
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Phase 9 correction: shunting associations and siding speed

- AJ01 and AJ04 are explicitly associated with ordinary manual signals (`associatedMain` in the signalling data: AJ01 ↔ DR1, P2E; AJ04 ↔ U5, P1E, DR1, P2E).
- To shunt into a siding, set the **access route** (e.g. DR1 → AJ01), then from the shunting signal route to the siding buffer stops. The main signal stays at Danger; the shunting Proceed authorises only that Class 5 ECS movement (it ends at the buffer). Ordinary mainline trains always obey the main signal.
- Ordinary routes can no longer run directly into the sidings; everything goes through the existing interlocking (`validateRoute`, locks, `validateRouteForTrains`).
- Siding interior speed is `sidingInteriorMph` (default **5 mph**) in `src/engine/speed/config.ts`; the siding lead/throat use `lineMph.SIDING` (15 mph) separately; the most restrictive limit wins.
