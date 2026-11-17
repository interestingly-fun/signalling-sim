# Dwell and platform rules (Phase 11)

These rules apply to every map.

## Routing is not dwelling
- **Routing**: which track a class may enter (`classAllowsLine`). Class 1 (express) may now be routed through PLATFORM tracks on every map. It is held at signals like any other train. It still never uses the branch (unless the stock is a flexible 387/350).
- **Dwelling**: whether a train may stand at a platform for a timetabled stop (`mayDwellAt(net, platformId, class, model)` in `src/engine/trains/classes.ts`).

| Class | Ashcombe Junction | Northbridge terminus platforms (T1-T6) | Northbridge-West (NBW1-4) |
| --- | --- | --- | --- |
| 1 Express | never dwells | dwells (any Class 1 stock) | only flexible stock (387, 350) |
| 2 Regional | dwells | dwells | dwells |
| 5 ECS | never dwells | no dwell (terminus stop only to change ends) | never dwells |

## ECS
- ECS only dwell at sidings/depots, whatever the platform they are routed to.
- An ECS train arriving at a Northbridge terminus always leaves as a passenger service (Class 1 or 2): its terminal dwell is 0 and it only changes ends (60 s).
- A Class 1 or 2 train arriving at a Northbridge terminus may leave as ECS. The outgoing ECS makes no call at Northbridge-West.

## Where it is enforced
- `classes.ts`: `CLASS_PROFILES`, `mayDwellAt`.
- `step.ts` `spawnTrain`, `fleet.ts` `createTrain` / `platformOptions`, `planner.ts`: a dwell is refused for a platform the class may not dwell at.
- `timetable/generate.ts` and `generateTerminus.ts` never create such a call; `timetable/validate.ts` rejects one.
