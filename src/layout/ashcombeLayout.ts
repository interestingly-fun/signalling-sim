/**
 * Ashcombe Junction – SCREEN LAYOUT (presentation only).
 *
 * Every polyline is keyed by a section ID from src/engine/topology/ashcombe.ts
 * and runs from that section's end A to its end B. Nothing in here decides what
 * is connected to what. src/layout/validate.ts proves that this drawing agrees
 * with the logical network (shared vertices at every link and point, no
 * crossing or touching that the topology does not declare).
 *
 * The drawing is schematic, not to scale. West is left, north is up.
 *
 *   y = 130   Platform 1 loop (north of the UP main)
 *   y = 190   UP main   (eastbound, left to right)
 *   y = 290   DOWN main (westbound, right to left)
 *   y = 350   Platform 2 loop (south of the DOWN main)
 *   y = 440   Merefield branch (south-west)
 *
 * Diagonals run at 45 degrees. The branch leg that reaches the UP main crosses
 * the DOWN main on a diamond at (370, 290).
 */

import type { LayoutDef, Pt } from './types';

const P = (x: number, y: number): Pt => [x, y];

const sections: Record<string, readonly Pt[]> = {
  // UP main ------------------------------------------------------------------
  UP1: [P(40, 190), P(170, 190)],
  UP2: [P(170, 190), P(390, 190)],
  UP3: [P(390, 190), P(470, 190)],
  UP4: [P(470, 190), P(540, 190)],
  UP5: [P(540, 190), P(610, 190)],
  UP6: [P(610, 190), P(710, 190)],
  UP7: [P(710, 190), P(800, 190)],
  UP8: [P(800, 190), P(980, 190)],
  UP9: [P(980, 190), P(1150, 190)],
  UP10: [P(1150, 190), P(1330, 190)],
  UP11: [P(1330, 190), P(1410, 190)],
  UP12: [P(1410, 190), P(1540, 190)],
  UPW2: [P(-120, 190), P(-40, 190)],
  UPW1: [P(-40, 190), P(40, 190)],
  UPE1: [P(1540, 190), P(1620, 190)],

  // DOWN main ----------------------------------------------------------------
  DN1: [P(1450, 290), P(1540, 290)],
  DN2: [P(1370, 290), P(1450, 290)],
  DN3: [P(1230, 290), P(1370, 290)],
  DN4: [P(1150, 290), P(1230, 290)],
  DN5: [P(980, 290), P(1150, 290)],
  DN6: [P(800, 290), P(980, 290)],
  DN7: [P(710, 290), P(800, 290)],
  DN8: [P(520, 290), P(710, 290)],
  DN9: [P(395, 290), P(520, 290)],
  DX: [P(345, 290), P(395, 290)], // diamond, DOWN main side
  DN10: [P(260, 290), P(345, 290)],
  DN11: [P(40, 290), P(260, 290)],
  DNW1: [P(-40, 290), P(40, 290)],
  DNW2: [P(-120, 290), P(-40, 290)],
  DNE1: [P(1540, 290), P(1620, 290)],
  DNE2: [P(1620, 290), P(1700, 290)],

  // Platform loops -----------------------------------------------------------
  P1W: [P(800, 190), P(860, 130)],
  P1: [P(860, 130), P(1090, 130)],
  P1E: [P(1090, 130), P(1150, 190)],
  P2W: [P(800, 290), P(860, 350)],
  P2: [P(860, 350), P(1090, 350)],
  P2E: [P(1090, 350), P(1150, 290)],

  // Crossovers ("\" in the west, "/" in the east) --------------------------------
  XW: [P(610, 190), P(710, 290)],
  XE: [P(1230, 290), P(1330, 190)],

  // Branch ---------------------------------------------------------------------
  BRM3: [P(-200, 440), P(-120, 440)],
  BRM2: [P(-120, 440), P(-40, 440)],
  BRM1: [P(-40, 440), P(40, 440)],
  BR1: [P(40, 440), P(120, 440)],
  BR2: [P(120, 440), P(220, 440)],
  LA1: [P(220, 440), P(300, 440)],
  LA2: [P(300, 440), P(370, 440)],
  LA3: [P(370, 440), P(520, 290)], // joins the DOWN main at DJ
  LB1: [P(220, 440), P(340, 320)],
  LBX: [P(340, 320), P(400, 260)], // diamond, branch side
  LB2: [P(400, 260), P(470, 190)], // joins the UP main at UJ
};

/** Section labels default to 15 units below the midpoint; these are the exceptions. */
const sectionLabelOffsets: Record<string, readonly [number, number]> = {
  // DOWN main labels sit above the line (signals stand below it)
  DN1: [0, -9],
  DN2: [0, -9],
  DN3: [0, -9],
  DN4: [0, -9],
  DN5: [0, -9],
  DN6: [0, -9],
  DN7: [0, -9],
  DN8: [0, -9],
  DN9: [0, -9],
  DN10: [0, -9],
  DN11: [0, -9],
  DX: [-12, -9],
  // platform 1 label above its loop, platform 2 label below
  P1: [0, -10],
  P1W: [-14, -2],
  P1E: [14, -2],
  P2W: [-14, 12],
  P2E: [14, 12],
  // diagonals
  XW: [-14, 4],
  XE: [14, 4],
  LA3: [14, 8],
  LB1: [-14, -4],
  LBX: [28, -6],
  LB2: [-15, -2],
};

const pointLabelOffsets: Record<string, readonly [number, number]> = {
  UJ: [0, -20],
  WXU: [0, -20],
  PW1: [-4, 22],
  PE1: [4, 22],
  EXU: [0, -20],
  BJ: [0, 22],
  DJ: [0, 22],
  WXD: [0, 22],
  PW2: [-6, -20],
  PE2: [6, -20],
  EXD: [0, 22],
};

export const ashcombeLayout: LayoutDef = {
  width: 1600,
  marginLeft: 220,
  marginRight: 150,
  height: 540,
  sections,
  platforms: {
    PLAT1: { x: 872, y: 136, width: 206, height: 15 },
    PLAT2: { x: 872, y: 331, width: 206, height: 15 },
  },
  sectionLabelOffsets,
  pointLabelOffsets,
  labels: [
    { text: 'ASHCOMBE JUNCTION', x: 975, y: 62, anchor: 'middle', size: 'xl' },
    { text: 'PLATFORM 1', x: 975, y: 147, anchor: 'middle', size: 'sm' },
    { text: 'PLATFORM 2', x: 975, y: 342, anchor: 'middle', size: 'sm' },

    { text: 'WESTFORD', x: -116, y: 232, anchor: 'start', size: 'lg' },
    { text: 'DOWN boundary', x: -116, y: 248, anchor: 'start', size: 'sm' },
    { text: 'NORTHBRIDGE', x: 1696, y: 232, anchor: 'end', size: 'lg' },
    { text: 'UP boundary', x: 1696, y: 248, anchor: 'end', size: 'sm' },
    { text: 'MEREFIELD', x: -196, y: 512, anchor: 'start', size: 'lg' },
    { text: 'BRANCH boundary', x: -196, y: 528, anchor: 'start', size: 'sm' },

    { text: 'UP MAIN  →', x: 48, y: 166, anchor: 'start', size: 'sm' },
    { text: '←  DOWN MAIN', x: 48, y: 322, anchor: 'start', size: 'sm' },
    { text: 'BRANCH', x: 48, y: 422, anchor: 'start', size: 'sm' },
  ],
};
