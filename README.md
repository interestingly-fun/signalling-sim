# Ashcombe Junction – railway signalling simulator

A browser-based simulator of a fictional modern British signalling control area, built with React, TypeScript and Vite.

> **Educational game simulation. Not a certified or operationally safe railway signalling system.**

## Status

**Phase 6 – final integration, interface polish and operational quality of life: done, awaiting review.** Phases 1–5 are kept: the topology, interlocking, two-click routes, approaches and override are unchanged in behaviour. The one deliberate change to the interlocking is *sectional route release* (below).

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

## Project structure

```
src/
  engine/              Pure TypeScript. No React, DOM or coordinates.
    topology/            types, Ashcombe definition, validation, traversal, route derivation
    state/               point positions and occupancy, kept apart from topology
    signalling/          aspects, route setting, locks, points, release
  layout/              Screen coordinates only, keyed by engine IDs. Pure TypeScript.
  engine/timetable/    Phase 5: services, generator, validator, delays, summary (pure, no UI)
  ui/                  React components (ui/sim/shift.ts is the shift controller)
docs/ARCHITECTURE.md   Topology, layout separation and design decisions
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
