/**
 * Northbridge Station: SCREEN LAYOUT (presentation only), after the reference drawing.
 *
 * Every polyline is keyed by a section ID from src/engine/topology/northbridge.ts and runs from end A to end B (west to east; the
 * diagonals say which way). The drawing is schematic and unrelated to the simulated lengths. validateLayout proves it agrees with the
 * logical network.
 *
 *   y = 167  AJ-up    (eastbound)        y = 395  BR slow east   (merges into the fast line at x = 550)
 *   y = 205  AJ-down  (westbound)        y = 432  BR fast east
 *   y = 300  platform 3 track            y = 470  BR fast west   (slow line diverges at x = 555)
 *   y = 338  platform 4 track            y = 508  BR slow west
 *
 * The AJ diagonal (from x = 1020) crosses the AJ-down line on a diamond; the BR diagonal (from x = 1070) crosses the BR fast line only
 * through the westbound connector. The two diagonals meet platforms 3 and 4 in a scissors with a diamond at (1247, 319).
 */

import type { LayoutDef, Pt } from './types';

const P = (x: number, y: number): Pt => [x, y];
const XT = 1322; // platform entrance (entry and departure signals)
const XE = 1600; // buffer stops

const sections: Record<string, readonly Pt[]> = {
  // AJ-up ----------------------------------------------------------------------
  AU4: [P(70, 167), P(160, 167)], AU3: [P(160, 167), P(250, 167)], AU2: [P(250, 167), P(430, 167)], AU1: [P(430, 167), P(636, 167)],
  AUP: [P(636, 167), P(910, 167)], AUB: [P(910, 167), P(998, 167)], AUC: [P(998, 167), P(1020, 167)], AUD: [P(1020, 167), P(1160, 167)],
  AUE: [P(1160, 167), P(1185, 167)], AUF: [P(1185, 167), P(XT, 167)],
  // AJ diagonal (A = north-west) and connector
  DGA: [P(1020, 167), P(1061, 195)], DGX: [P(1061, 195), P(1090, 215)], DGB: [P(1090, 215), P(1141, 249)], DGC: [P(1141, 249), P(1215, 300)],
  CAJ: [P(1135, 205), P(1141, 249)],
  // AJ-down ----------------------------------------------------------------------
  DW4: [P(70, 205), P(160, 205)], DW3: [P(160, 205), P(250, 205)], DW2: [P(250, 205), P(430, 205)], DW1: [P(430, 205), P(654, 205)],
  DWP: [P(654, 205), P(936, 205)], DWv: [P(936, 205), P(1060, 205)], DWX: [P(1060, 205), P(1092, 205)], DWz: [P(1092, 205), P(1110, 205)],
  DWy: [P(1110, 205), P(1135, 205)], DEw: [P(1135, 205), P(1240, 205)], DEz: [P(1240, 205), P(XT, 205)],
  XA: [P(1185, 167), P(1240, 205)], X1: [P(1110, 205), P(1160, 167)],
  // BR slow east / fast east -------------------------------------------------------
  BSA: [P(70, 395), P(160, 395)], BSB: [P(160, 395), P(372, 395)], BSC: [P(372, 395), P(466, 395)], BSD: [P(466, 395), P(550, 432)],
  FA3: [P(70, 432), P(160, 432)], FA2: [P(160, 432), P(372, 432)], FB: [P(372, 432), P(466, 432)], FC: [P(466, 432), P(550, 432)],
  FD: [P(550, 432), P(639, 432)], FP: [P(639, 432), P(915, 432)], FE: [P(915, 432), P(1049, 432)], FG: [P(1049, 432), P(1070, 432)],
  FH1: [P(1070, 432), P(1105, 432)], FHX: [P(1105, 432), P(1140, 432)], FH2: [P(1140, 432), P(1160, 432)],
  FJ: [P(1160, 432), P(1185, 432)], FK: [P(1185, 432), P(XT, 432)],
  // BR diagonal (A = south-west) and connector (A = south-west)
  BDA: [P(1070, 432), P(1135, 390)], BDB: [P(1135, 390), P(1215, 338)],
  CB1: [P(1105, 470), P(1116.4, 439.6)], CBX: [P(1116.4, 439.6), P(1121.8, 425.2)], CB2: [P(1121.8, 425.2), P(1135, 390)],
  // BR fast west / slow west -------------------------------------------------------
  GI: [P(70, 470), P(150, 470)], GH: [P(150, 470), P(240, 470)], GG: [P(240, 470), P(372, 470)], GF: [P(372, 470), P(555, 470)],
  GW0: [P(555, 470), P(573, 470)], GW1: [P(573, 470), P(656, 470)], GP: [P(656, 470), P(937, 470)], GA: [P(937, 470), P(1105, 470)],
  GC: [P(1105, 470), P(1135, 470)], GD: [P(1135, 470), P(1240, 470)], GE: [P(1240, 470), P(XT, 470)],
  SL5: [P(70, 508), P(150, 508)], SL4: [P(150, 508), P(240, 508)], SL3: [P(240, 508), P(372, 508)], SL2: [P(372, 508), P(465, 508)], SL1: [P(465, 508), P(555, 470)],
  XB: [P(1185, 432), P(1240, 470)], X2: [P(1135, 470), P(1160, 432)],
  // Terminus throat and scissors ------------------------------------------------------
  P3W: [P(1215, 300), P(1280, 300)], P4W: [P(1215, 338), P(1280, 338)], T3E: [P(1280, 300), P(XT, 300)], T4E: [P(1280, 338), P(XT, 338)],
  AXA: [P(1215, 300), P(1237, 313)], AXD: [P(1237, 313), P(1258, 325)], AXB: [P(1258, 325), P(1280, 338)],
  BXA: [P(1215, 338), P(1237, 325)], BXD: [P(1237, 325), P(1258, 313)], BXB: [P(1258, 313), P(1280, 300)],
  // Terminus platforms (A = throat, B = buffer stops) ------------------------------------
  PT1: [P(XT, 167), P(XE, 167)], PT2: [P(XT, 205), P(XE, 205)], PT3: [P(XT, 300), P(XE, 300)],
  PT4: [P(XT, 338), P(XE, 338)], PT5: [P(XT, 432), P(XE, 432)], PT6: [P(XT, 470), P(XE, 470)],
};

const pointLabelOffsets: Record<string, readonly [number, number]> = {
  JA1: [0, -16], X1U: [-18, -20], XAU: [18, -20], XAD: [0, 22],
  CAJD: [28, 30], X1D: [-20, 22], CAJP: [-38, 4], T3: [-4, -20],
  T3E: [6, -20], T4: [-4, 22], T4E: [6, 22], MGE: [-26, 30],
  BDP: [0, -16], CBP: [-24, -6], X2U: [-14, -36], XBU: [18, -20],
  XBD: [0, 22], X2D: [-42, 22], CBD: [26, 22], DVP: [14, -20],
};
const signalLabelOffsets: Record<string, readonly [number, number]> = {};

export const northbridgeLayout: LayoutDef = {
  width: 1700,
  height: 590,
  marginLeft: 0,
  marginRight: 0,
  marginTop: 0,
  sections,
  platforms: {
    NBW1: { x: 656, y: 150, width: 234, height: 13 },
    NBW2: { x: 674, y: 211, width: 242, height: 13 },
    NBW3: { x: 659, y: 415, width: 236, height: 13 },
    NBW4: { x: 676, y: 477, width: 241, height: 13 },
    T1: { x: 1337, y: 150, width: 250, height: 13 },
    T2: { x: 1337, y: 211, width: 250, height: 13 },
    T3: { x: 1337, y: 283, width: 250, height: 13 },
    T4: { x: 1337, y: 345, width: 250, height: 13 },
    T5: { x: 1337, y: 415, width: 250, height: 13 },
    T6: { x: 1337, y: 477, width: 250, height: 13 },
  },
  sectionLabelOffsets: {
  DW4: [0, -9], GI: [0, -9], SL5: [40, 15], DWX: [16, 6],
  DGX: [-16, -2], DGB: [16, -21], CB1: [-16, 0], DWy: [0, -9],
  DWz: [0, -9], GC: [0, -9], T4E: [18, 15], AXD: [-38, 15],
  BXD: [30, 15], BSA: [0, 11], FH1: [0, 7], FHX: [-12, 7],
  FH2: [0, 11], P4W: [0, 19], AXB: [-14, 10],
  },
  pointLabelOffsets,
  signalLabelOffsets,
  labels: [
    { text: 'NORTHBRIDGE', x: 1462, y: 90, anchor: 'middle', size: 'xl' },
    { text: 'NORTHBRIDGE-WEST', x: 780, y: 90, anchor: 'middle', size: 'lg' },
    { text: 'PLATFORM 1', x: 1462, y: 146, anchor: 'middle', size: 'sm' },
    { text: 'PLATFORM 2', x: 1462, y: 236, anchor: 'middle', size: 'sm' },
    { text: 'PLATFORM 3', x: 1462, y: 278, anchor: 'middle', size: 'sm' },
    { text: 'PLATFORM 4', x: 1462, y: 372, anchor: 'middle', size: 'sm' },
    { text: 'PLATFORM 5', x: 1462, y: 410, anchor: 'middle', size: 'sm' },
    { text: 'PLATFORM 6', x: 1462, y: 502, anchor: 'middle', size: 'sm' },
    { text: 'NBW PLATFORM 1', x: 773, y: 146, anchor: 'middle', size: 'sm' },
    { text: 'NBW PLATFORM 2', x: 795, y: 238, anchor: 'middle', size: 'sm' },
    { text: 'NBW PLATFORM 3', x: 777, y: 411, anchor: 'middle', size: 'sm' },
    { text: 'NBW PLATFORM 4', x: 797, y: 503, anchor: 'middle', size: 'sm' },
    { text: 'ASHCOMBE JUNCTION CORRIDOR (AJ)', x: 70, y: 100, anchor: 'start', size: 'lg' },
    { text: 'BARCHESTER CORRIDOR (BR) — FOUR TRACKS', x: 70, y: 338, anchor: 'start', size: 'lg' },
    { text: 'AJ UP  →', x: 70, y: 157, anchor: 'start', size: 'sm' },
    { text: '←  AJ DOWN', x: 70, y: 232, anchor: 'start', size: 'sm' },
    { text: 'BR SLOW  →', x: 70, y: 385, anchor: 'start', size: 'sm' },
    { text: 'BR FAST  →', x: 70, y: 423, anchor: 'start', size: 'sm' },
    { text: '←  BR FAST', x: 70, y: 497, anchor: 'start', size: 'sm' },
    { text: '←  BR SLOW', x: 70, y: 535, anchor: 'start', size: 'sm' },
    { text: 'To / from Ashcombe Junction', x: 70, y: 276, anchor: 'start', size: 'sm' },
    { text: 'To / from Barchester', x: 70, y: 560, anchor: 'start', size: 'sm' },
    { text: 'AJ ONLY', x: 1618, y: 171, anchor: 'start', size: 'sm' },
    { text: 'AJ ONLY', x: 1618, y: 209, anchor: 'start', size: 'sm' },
    { text: 'AJ or BR', x: 1618, y: 304, anchor: 'start', size: 'sm' },
    { text: 'AJ or BR', x: 1618, y: 342, anchor: 'start', size: 'sm' },
    { text: 'BR ONLY', x: 1618, y: 436, anchor: 'start', size: 'sm' },
    { text: 'BR ONLY', x: 1618, y: 474, anchor: 'start', size: 'sm' },
  ],
};
