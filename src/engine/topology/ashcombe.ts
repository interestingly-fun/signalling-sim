/**
 * Ashcombe Junction – logical network definition (fictional).
 *
 * This file is PURE TOPOLOGY. There are no coordinates here. To see how it is
 * drawn, look at src/layout/ashcombeLayout.ts, which refers to the same IDs.
 *
 * GEOMETRY IN WORDS (west on the left, north at the top)
 * ------------------------------------------------------
 *   Westford (DOWN boundary) ........ west end of the main lines
 *   Northbridge (UP boundary) ....... east end of the main lines
 *   Merefield (BRANCH boundary) ..... south-west, via the branch junction
 *
 *   UP MAIN   : north track, runs west -> east (towards Northbridge).
 *   DOWN MAIN : south track, runs east -> west (towards Westford).
 *   (British left-hand running: an eastbound train keeps to the north track.)
 *
 *   Section end convention: end A is the west / south-west end, end B is the
 *   east / north-east end. For the diagonal sections the notes say which is which.
 *
 *   West -> East
 *   ------------
 *   Branch junction (south-west of the station):
 *     BJ  : branch splits into leg A (to the DOWN main) and leg B (to the UP main)
 *     DJ  : leg A joins the DOWN main        (facing for westbound trains)
 *     UJ  : leg B joins the UP main          (trailing for eastbound trains)
 *     DX/LBX : leg B crosses the DOWN main on a diamond (flat crossing)
 *   West crossover XW (UP -> DOWN, eastbound): points WXU + WXD
 *   Platform 1 loop (off the UP main, north):    points PW1 + PE1
 *   Platform 2 loop (off the DOWN main, south):  points PW2 + PE2
 *   East crossover XE (DOWN -> UP, eastbound): points EXD + EXU
 *
 *   The DOWN main between the two crossovers (DN4..DN7) is bi-directionally
 *   signalled so that eastbound trains can run "wrong line" through Platform 2
 *   and return to the UP main.
 *
 * WHAT CAN HAPPEN
 * ---------------
 *   Express through movements:     Westford -> Northbridge (UP main)
 *                                  Northbridge -> Westford (DOWN main)
 *   Platform 1 (eastbound only):   from Westford or Merefield
 *   Platform 2:                    westbound from Northbridge (direct), or
 *                                  eastbound from Westford/Merefield via the
 *                                  west crossover
 *   Branch:                        Merefield -> Northbridge (crosses DOWN main)
 *                                  Northbridge/Platform 2 -> Merefield
 *   Westford -> Merefield is deliberately NOT possible (both are west of the
 *   junction: it would need a reversal).
 */

import type { EndId, NetworkDef, SectionEnd, SectionDef, TravelDir, LineKind } from './types';

const end = (section: string, e: EndId): SectionEnd => ({ section, end: e });
const A = (section: string) => end(section, 'A');
const B = (section: string) => end(section, 'B');

function sec(
  id: string,
  line: LineKind,
  lengthM: number,
  traffic: TravelDir,
  extra: Partial<Pick<SectionDef, 'platform' | 'crosses'>> = {},
): SectionDef {
  return { id, name: id, line, lengthM, traffic, ...extra };
}

export const ashcombeDefinition: NetworkDef = {
  name: 'Ashcombe Junction',

  // -------------------------------------------------------------------------
  // TRACK SECTIONS (track circuits)
  // -------------------------------------------------------------------------
  sections: [
    // UP main, eastbound only. A = west end, B = east end.
    sec('UP1', 'UP', 260, 'AB'), //  Westford boundary -> U1
    sec('UP2', 'UP', 300, 'AB'), //  U1 -> U2
    sec('UP3', 'UP', 100, 'AB'), //  U2 -> UJ (normal leg of UJ)
    sec('UP4', 'UP', 120, 'AB'), //  toe section of UJ, up to U3
    sec('UP5', 'UP', 100, 'AB'), //  toe section of WXU
    sec('UP6', 'UP', 110, 'AB'), //  normal leg of WXU, up to U4
    sec('UP7', 'UP', 100, 'AB'), //  toe section of PW1
    sec('UP8', 'UP', 250, 'AB'), //  through line past Platform 1, up to U5
    sec('UP9', 'UP', 250, 'AB'), //  U5 -> PE1 (normal leg of PE1)
    sec('UP10', 'UP', 220, 'AB'), // toe of PE1 and normal leg of EXU
    sec('UP11', 'UP', 170, 'AB'), // toe of EXU, up to U6
    sec('UP12', 'UP', 190, 'AB'), // U6 -> UE1
    // Phase 3.5 boundary approaches: automatic block sections outside the original area edge.
    sec('UPW2', 'UP', 200, 'AB'), //  Westford boundary -> UW2 (outer entry block)
    sec('UPW1', 'UP', 200, 'AB'), //  UW2 -> UW1
    sec('UPE1', 'UP', 200, 'AB'), //  UE1 -> Northbridge boundary (exit block)

    // DOWN main, westbound normally. A = west end, B = east end.
    sec('DN1', 'DOWN', 170, 'BA'), //  Northbridge boundary -> D1
    sec('DN2', 'DOWN', 120, 'BA'), //  D1 -> D2
    sec('DN3', 'DOWN', 170, 'BA'), //  D2 -> EXD (normal leg of EXD)
    // DN4..DN7: bi-directional so eastbound trains can run through Platform 2.
    sec('DN4', 'DOWN', 120, 'both'), // shared toe section of EXD and PE2
    sec('DN5', 'DOWN', 250, 'both'), // PE2 normal leg, up to D3 / DR1
    sec('DN6', 'DOWN', 250, 'both'), // through line past Platform 2 (PW2 normal leg)
    sec('DN7', 'DOWN', 110, 'both'), // shared toe section of PW2 and WXD
    sec('DN8', 'DOWN', 240, 'BA'), //  WXD normal leg / toe section of DJ
    sec('DN9', 'DOWN', 130, 'BA'), //  DJ normal leg, up to the diamond
    sec('DX', 'DOWN', 60, 'BA', { crosses: ['LBX'] }), // diamond: DOWN main side
    sec('DN10', 'DOWN', 220, 'BA'), // diamond -> D4
    sec('DN11', 'DOWN', 290, 'BA'), // D4 -> DW1
    sec('DNW1', 'DOWN', 200, 'BA'), // DW1 -> DW2
    sec('DNW2', 'DOWN', 200, 'BA'), // DW2 -> Westford boundary (exit block)
    sec('DNE2', 'DOWN', 200, 'BA'), // Northbridge boundary -> DE2 (outer entry block)
    sec('DNE1', 'DOWN', 200, 'BA'), // DE2 -> DE1

    // Platform loops. A = west end, B = east end.
    sec('P1W', 'PLATFORM', 110, 'AB'), //  PW1 reverse leg (west throat of Platform 1)
    sec('P1', 'PLATFORM', 310, 'AB', { platform: 'PLAT1' }),
    sec('P1E', 'PLATFORM', 110, 'AB'), //  east throat of Platform 1 -> PE1 reverse leg
    sec('P2W', 'PLATFORM', 110, 'both'), // PW2 reverse leg (west throat of Platform 2)
    sec('P2', 'PLATFORM', 310, 'both', { platform: 'PLAT2' }),
    sec('P2E', 'PLATFORM', 110, 'both'), // east throat of Platform 2 -> PE2 reverse leg

    // Crossovers. For both, A = the UP/DOWN end that eastbound trains LEAVE
    // and B = the end they ARRIVE at, i.e. traffic 'AB' = eastbound.
    sec('XW', 'CROSSOVER', 110, 'AB'), // A on UP main (WXU) -> B on DOWN main (WXD)
    sec('XE', 'CROSSOVER', 110, 'AB'), // A on DOWN main (EXD) -> B on UP main (EXU)

    // Branch. A = Merefield (south-west) end.
    sec('BRM3', 'BRANCH', 200, 'both'), // Merefield boundary -> MW3 (outer block, single track)
    sec('BRM2', 'BRANCH', 200, 'both'), // MW3 / MX2 -> MW2
    sec('BRM1', 'BRANCH', 200, 'both'), // MW2 / MX1 -> MW1
    sec('BR1', 'BRANCH', 90, 'both'), //  MW1 / MX1 -> M1 / M2
    sec('BR2', 'BRANCH', 110, 'both'), // toe section of BJ
    // Leg A: BJ -> DJ (for trains leaving the main line towards Merefield).
    // A = BJ end, B = DJ end.
    sec('LA1', 'BRANCH', 170, 'BA'),
    sec('LA2', 'BRANCH', 210, 'BA'),
    sec('LA3', 'BRANCH', 210, 'BA'),
    // Leg B: BJ -> UJ, crossing the DOWN main on the diamond (for trains from
    // Merefield to the UP main). A = BJ end, B = UJ end.
    sec('LB1', 'BRANCH', 370, 'AB'),
    sec('LBX', 'BRANCH', 100, 'AB', { crosses: ['DX'] }), // diamond: branch side
    sec('LB2', 'BRANCH', 65, 'AB'),
  ],

  // -------------------------------------------------------------------------
  // PLAIN LINKS (joints between exactly two section ends; signals may stand here)
  // -------------------------------------------------------------------------
  links: [
    // UP main
    { a: B('UP1'), b: A('UP2') },
    { a: B('UP2'), b: A('UP3') },
    { a: B('UP4'), b: A('UP5') },
    { a: B('UP6'), b: A('UP7') },
    { a: B('UP8'), b: A('UP9') },
    { a: B('UP11'), b: A('UP12') },
    { a: B('UPW2'), b: A('UPW1') },
    { a: B('UPW1'), b: A('UP1') },
    { a: B('UP12'), b: A('UPE1') },
    // DOWN main
    { a: A('DN1'), b: B('DN2') },
    { a: A('DN2'), b: B('DN3') },
    { a: A('DN9'), b: B('DX') },
    { a: A('DX'), b: B('DN10') },
    { a: A('DN10'), b: B('DN11') },
    { a: A('DN11'), b: B('DNW1') },
    { a: A('DNW1'), b: B('DNW2') },
    { a: B('DN1'), b: A('DNE1') },
    { a: B('DNE1'), b: A('DNE2') },
    { a: A('DN5'), b: B('DN6') }, // D3 (westbound) / DR1 (eastbound) stand here
    // Platform tracks
    { a: B('P1W'), b: A('P1') },
    { a: B('P1'), b: A('P1E') },
    { a: B('P2W'), b: A('P2') },
    { a: B('P2'), b: A('P2E') },
    // Branch
    { a: B('BRM3'), b: A('BRM2') },
    { a: B('BRM2'), b: A('BRM1') },
    { a: B('BRM1'), b: A('BR1') },
    { a: B('BR1'), b: A('BR2') },
    { a: B('LA1'), b: A('LA2') },
    { a: B('LA2'), b: A('LA3') },
    { a: B('LB1'), b: A('LBX') },
    { a: B('LBX'), b: A('LB2') },
  ],

  // -------------------------------------------------------------------------
  // POINTS
  // -------------------------------------------------------------------------
  points: [
    // Branch junction -------------------------------------------------------
    {
      id: 'BJ',
      name: 'Branch junction points',
      toe: B('BR2'),
      normal: A('LA1'), // leg A: towards the DOWN main
      reverse: A('LB1'), // leg B: towards the UP main
    },
    {
      id: 'DJ',
      name: 'DOWN main / leg A points',
      toe: A('DN8'), // toe is EAST of the points (facing for westbound trains)
      normal: B('DN9'),
      reverse: B('LA3'),
    },
    {
      id: 'UJ',
      name: 'UP main / leg B points',
      toe: A('UP4'), // toe is EAST of the points (trailing for eastbound trains)
      normal: B('UP3'),
      reverse: B('LB2'),
    },
    // West crossover ("\" : UP at the west, DOWN at the east) ----------------
    {
      id: 'WXU',
      name: 'West crossover (UP main)',
      toe: B('UP5'), // toe WEST of the points
      normal: A('UP6'),
      reverse: A('XW'),
    },
    {
      id: 'WXD',
      name: 'West crossover (DOWN main)',
      toe: A('DN7'), // toe EAST of the points
      normal: B('DN8'),
      reverse: B('XW'),
    },
    // Platform 1 loop -------------------------------------------------------
    {
      id: 'PW1',
      name: 'Platform 1 west points',
      toe: B('UP7'), // toe WEST
      normal: A('UP8'),
      reverse: A('P1W'),
    },
    {
      id: 'PE1',
      name: 'Platform 1 east points',
      toe: A('UP10'), // toe EAST
      normal: B('UP9'),
      reverse: B('P1E'),
    },
    // Platform 2 loop -------------------------------------------------------
    {
      id: 'PW2',
      name: 'Platform 2 west points',
      toe: B('DN7'), // toe WEST
      normal: A('DN6'),
      reverse: A('P2W'),
    },
    {
      id: 'PE2',
      name: 'Platform 2 east points',
      toe: A('DN4'), // toe EAST
      normal: B('DN5'),
      reverse: B('P2E'),
    },
    // East crossover ("/" : DOWN at the west, UP at the east) -----------------
    {
      id: 'EXD',
      name: 'East crossover (DOWN main)',
      toe: B('DN4'), // toe WEST
      normal: A('DN3'),
      reverse: A('XE'),
    },
    {
      id: 'EXU',
      name: 'East crossover (UP main)',
      toe: A('UP11'), // toe EAST
      normal: B('UP10'),
      reverse: B('XE'),
    },
  ],

  junctions: [
    {
      id: 'BRANCH-JN',
      name: 'Ashcombe branch junction',
      points: ['BJ', 'DJ', 'UJ'],
      crossings: [['DX', 'LBX']],
    },
    { id: 'WEST-XOVER', name: 'West crossover', points: ['WXU', 'WXD'], sections: ['XW'] },
    { id: 'EAST-XOVER', name: 'East crossover', points: ['EXD', 'EXU'], sections: ['XE'] },
    { id: 'PLAT1-LOOP', name: 'Platform 1 loop', points: ['PW1', 'PE1'], sections: ['P1W', 'P1E'] },
    { id: 'PLAT2-LOOP', name: 'Platform 2 loop', points: ['PW2', 'PE2'], sections: ['P2W', 'P2E'] },
  ],

  // -------------------------------------------------------------------------
  // SIGNALS. A signal at (section, end) governs trains leaving that section
  // through that end. Automatic signals stand only on plain stretches where no
  // route has to be chosen; everything in front of points is manual.
  // -------------------------------------------------------------------------
  signals: [
    // Eastbound, UP main
    { id: 'UW2', name: 'UW2', type: 'automatic', at: B('UPW2') },
    { id: 'UW1', name: 'UW1', type: 'automatic', at: B('UPW1') },
    { id: 'U1', name: 'U1', type: 'automatic', at: B('UP1') },
    { id: 'U2', name: 'U2', type: 'manual', at: B('UP2') }, // protects UJ merge
    { id: 'U3', name: 'U3', type: 'manual', at: B('UP4') }, // crossover / platforms
    { id: 'U4', name: 'U4', type: 'manual', at: B('UP6') }, // Platform 1 / through
    { id: 'U5', name: 'U5', type: 'manual', at: B('UP8') }, // guards PE1 (Platform 1 east points): a route must be set through it
    { id: 'U6', name: 'U6', type: 'automatic', at: B('UP11') },
    { id: 'UE1', name: 'UE1', type: 'automatic', at: B('UP12') },
    // Platform starting signals
    { id: 'P1E', name: 'P1 east starter', type: 'manual', at: B('P1') },
    { id: 'P2E', name: 'P2 east starter', type: 'manual', at: B('P2') },
    { id: 'P2W', name: 'P2 west starter', type: 'manual', at: A('P2') },
    // Westbound, DOWN main
    { id: 'DE2', name: 'DE2', type: 'automatic', at: A('DNE2') },
    { id: 'DE1', name: 'DE1', type: 'automatic', at: A('DNE1') },
    { id: 'D1', name: 'D1', type: 'automatic', at: A('DN1') },
    { id: 'D2', name: 'D2', type: 'manual', at: A('DN2') }, // Platform 2 / through
    { id: 'D3', name: 'D3', type: 'manual', at: A('DN5') }, // junction complex ahead
    { id: 'D4', name: 'D4', type: 'automatic', at: A('DN10') },
    { id: 'DW1', name: 'DW1', type: 'automatic', at: A('DN11') },
    { id: 'DW2', name: 'DW2', type: 'automatic', at: A('DNW1') },
    // Eastbound on the DOWN main (wrong-line running between the crossovers)
    { id: 'DR1', name: 'DR1', type: 'manual', at: B('DN6') },
    // Branch
    { id: 'MW3', name: 'MW3', type: 'automatic', at: B('BRM3') },
    { id: 'MW2', name: 'MW2', type: 'automatic', at: B('BRM2') },
    { id: 'MW1', name: 'MW1', type: 'automatic', at: B('BRM1') },
    { id: 'M1', name: 'M1 Merefield entry', type: 'manual', at: B('BR1') },
    { id: 'M2', name: 'M2 Merefield exit', type: 'automatic', at: A('BR2') },
    { id: 'MX1', name: 'MX1', type: 'automatic', at: A('BR1') },
    { id: 'MX2', name: 'MX2', type: 'automatic', at: A('BRM1') },
  ],

  platforms: [
    { id: 'PLAT1', name: 'Platform 1', section: 'P1' },
    { id: 'PLAT2', name: 'Platform 2', section: 'P2' },
  ],

  boundaries: [
    // UP boundary: Northbridge. Trains arrive on the DOWN main, leave on the UP main.
    { id: 'N-IN', name: 'Northbridge (in)', location: 'Northbridge', at: B('DNE2'), entry: true, exit: false },
    { id: 'N-OUT', name: 'Northbridge (out)', location: 'Northbridge', at: B('UPE1'), entry: false, exit: true },
    // DOWN boundary: Westford. Trains arrive on the UP main, leave on the DOWN main.
    { id: 'W-IN', name: 'Westford (in)', location: 'Westford', at: A('UPW2'), entry: true, exit: false },
    { id: 'W-OUT', name: 'Westford (out)', location: 'Westford', at: A('DNW2'), entry: false, exit: true },
    // BRANCH boundary: Merefield, single bi-directional line.
    { id: 'M-IO', name: 'Merefield', location: 'Merefield', at: A('BRM3'), entry: true, exit: true },
  ],
};
