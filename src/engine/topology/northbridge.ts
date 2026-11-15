/**
 * Northbridge Station: logical network definition (fictional). PURE TOPOLOGY: no coordinates (see src/layout/northbridgeLayout.ts).
 *
 * Two independent corridors meet at a six-platform terminus:
 *   AJ  Ashcombe Junction <-> Northbridge : two lines (AJ-up eastbound, AJ-down westbound), through Northbridge-West platforms 1 and 2
 *   BR  Barchester        <-> Northbridge : FOUR lines: fast east, fast west and an outer slow line each way (the slow lines merge into
 *                                          / diverge from the fast lines west of Northbridge-West), platforms 3 and 4 on the fast lines.
 *
 * Terminus platforms T1..T6 (T1 northernmost): T1,T2 AJ only; T3,T4 AJ or BR; T5,T6 BR only. A train arrives at the platform's west
 * (throat) end, stops short of the buffers, dwells, changes ends and leaves again through the departure signal at the throat end.
 *
 * Section end convention: end A is the west end, end B the east end (westbound lines too); for the diagonal / crossover sections the notes say which.
 * Sim lengths are metres chosen for braking and speeds; they are unrelated to the drawn length.
 *
 * ADDITIONS to the reference drawing (needed so that terminating trains can leave again; connectivity of the drawing is unchanged):
 *   X1, X2          "/" crossovers (westbound) from the AJ-up / BR-fast-east platforms' approach lines to the AJ-down / BR-fast-west lines
 *   CAJ, CB*        westbound connectors from the AJ / BR diagonals (platforms 3 and 4) to the AJ-down / BR-fast-west lines
 *   departure signals NB31..NB36 at the throat end of each terminus platform.
 */

import type { EndId, NetworkDef, SectionDef, SectionEnd, TravelDir, LineKind, SignalDef } from './types';

const A = (section: string): SectionEnd => ({ section, end: 'A' as EndId });
const B = (section: string): SectionEnd => ({ section, end: 'B' as EndId });

const sec = (id: string, line: LineKind, lengthM: number, traffic: TravelDir, corridor: string | undefined, extra: Partial<Pick<SectionDef, 'platform' | 'crosses' | 'speedClass'>> = {}): SectionDef => ({
  id, name: id, line, lengthM, traffic, ...(corridor ? { corridor } : {}), ...extra,
});
const sig = (id: string, name: string, type: 'automatic' | 'manual', at: SectionEnd, description?: string): SignalDef => ({ id, name, type, at, ...(description ? { description } : {}) });
const link = (a: SectionEnd, b: SectionEnd) => ({ a, b });
const chain = (...pairs: [string, string][]) => pairs.map(([x, y]) => link(B(x), A(y)));

export const northbridgeDefinition: NetworkDef = {
  name: 'Northbridge Station',
  corridors: [
    { id: 'AJ', name: 'Ashcombe Junction corridor', location: 'Ashcombe Junction' },
    { id: 'BR', name: 'Barchester corridor', location: 'Barchester' },
  ],
  sections: [
    // ---- AJ-up (eastbound) ----
    sec('AU4', 'UP', 1400, 'AB', 'AJ'), sec('AU3', 'UP', 1300, 'AB', 'AJ'), sec('AU2', 'UP', 1200, 'AB', 'AJ'), sec('AU1', 'UP', 600, 'AB', 'AJ'),
    sec('AUP', 'UP', 300, 'AB', 'AJ', { platform: 'NBW1' }),
    sec('AUB', 'UP', 130, 'AB', 'AJ'), sec('AUC', 'UP', 60, 'AB', 'AJ'), sec('AUD', 'UP', 200, 'AB', 'AJ'),
    sec('AUE', 'LINK', 60, 'both', 'AJ'), sec('AUF', 'LINK', 220, 'both', 'AJ'),
    // ---- AJ diagonal to platforms 3/4 (A = north-west end) and the westbound connector ----
    sec('DGA', 'LINK', 120, 'AB', 'AJ'), sec('DGX', 'LINK', 40, 'AB', 'AJ', { crosses: ['DWX'] }), sec('DGB', 'LINK', 120, 'AB', 'AJ'), sec('DGC', 'LINK', 160, 'both', 'AJ'),
    sec('CAJ', 'LINK', 90, 'BA', 'AJ'),
    // ---- AJ-down (westbound) ----
    sec('DEz', 'LINK', 90, 'both', 'AJ'), sec('DEw', 'DOWN', 150, 'BA', 'AJ'), sec('DWy', 'DOWN', 50, 'BA', 'AJ'), sec('DWz', 'DOWN', 80, 'BA', 'AJ'),
    sec('DWX', 'DOWN', 40, 'BA', 'AJ', { crosses: ['DGX'] }), sec('DWv', 'DOWN', 200, 'BA', 'AJ'),
    sec('DWP', 'DOWN', 300, 'BA', 'AJ', { platform: 'NBW2' }),
    sec('DW1', 'DOWN', 600, 'BA', 'AJ'), sec('DW2', 'DOWN', 1200, 'BA', 'AJ'), sec('DW3', 'DOWN', 1300, 'BA', 'AJ'), sec('DW4', 'DOWN', 1400, 'BA', 'AJ'),
    sec('XA', 'CROSSOVER', 90, 'AB', 'AJ'), sec('X1', 'CROSSOVER', 90, 'BA', 'AJ'),
    // ---- BR slow east / fast east ----
    sec('BSA', 'UP', 1400, 'AB', 'BR', { speedClass: 'slow' }), sec('BSB', 'UP', 1300, 'AB', 'BR', { speedClass: 'slow' }), sec('BSC', 'UP', 150, 'AB', 'BR', { speedClass: 'slow' }),
    sec('BSD', 'CROSSOVER', 110, 'AB', 'BR', { speedClass: 'slow' }),
    sec('FA3', 'UP', 1400, 'AB', 'BR', { speedClass: 'fast' }), sec('FA2', 'UP', 1300, 'AB', 'BR', { speedClass: 'fast' }), sec('FB', 'UP', 150, 'AB', 'BR', { speedClass: 'fast' }),
    sec('FC', 'UP', 90, 'AB', 'BR', { speedClass: 'fast' }), sec('FD', 'UP', 600, 'AB', 'BR', { speedClass: 'fast' }),
    sec('FP', 'UP', 300, 'AB', 'BR', { platform: 'NBW3', speedClass: 'fast' }),
    sec('FE', 'UP', 130, 'AB', 'BR', { speedClass: 'fast' }), sec('FG', 'UP', 60, 'AB', 'BR', { speedClass: 'fast' }),
    sec('FH1', 'UP', 40, 'AB', 'BR', { speedClass: 'fast' }), sec('FHX', 'UP', 30, 'AB', 'BR', { crosses: ['CBX'], speedClass: 'fast' }), sec('FH2', 'UP', 120, 'AB', 'BR', { speedClass: 'fast' }),
    sec('FJ', 'LINK', 60, 'both', 'BR'), sec('FK', 'LINK', 220, 'both', 'BR'),
    // ---- BR diagonal to platforms 3/4 (A = south-west end) and the westbound connector ----
    sec('BDA', 'LINK', 160, 'AB', 'BR'), sec('BDB', 'LINK', 180, 'both', 'BR'),
    sec('CB2', 'LINK', 70, 'BA', 'BR'), sec('CBX', 'LINK', 30, 'BA', 'BR', { crosses: ['FHX'] }), sec('CB1', 'LINK', 70, 'BA', 'BR'),
    sec('XB', 'CROSSOVER', 90, 'AB', 'BR'), sec('X2', 'CROSSOVER', 90, 'BA', 'BR'),
    // ---- BR fast west / slow west ----
    sec('GE', 'LINK', 90, 'both', 'BR'), sec('GD', 'DOWN', 100, 'BA', 'BR', { speedClass: 'fast' }), sec('GC', 'DOWN', 90, 'BA', 'BR', { speedClass: 'fast' }),
    sec('GA', 'DOWN', 200, 'BA', 'BR', { speedClass: 'fast' }),
    sec('GP', 'DOWN', 300, 'BA', 'BR', { platform: 'NBW4', speedClass: 'fast' }),
    sec('GW1', 'DOWN', 130, 'BA', 'BR', { speedClass: 'fast' }), sec('GW0', 'DOWN', 60, 'BA', 'BR', { speedClass: 'fast' }),
    sec('GF', 'DOWN', 700, 'BA', 'BR', { speedClass: 'fast' }), sec('GG', 'DOWN', 1200, 'BA', 'BR', { speedClass: 'fast' }), sec('GH', 'DOWN', 1300, 'BA', 'BR', { speedClass: 'fast' }), sec('GI', 'DOWN', 1400, 'BA', 'BR', { speedClass: 'fast' }),
    sec('SL1', 'CROSSOVER', 110, 'BA', 'BR', { speedClass: 'slow' }), sec('SL2', 'DOWN', 160, 'BA', 'BR', { speedClass: 'slow' }),
    sec('SL3', 'DOWN', 1200, 'BA', 'BR', { speedClass: 'slow' }), sec('SL4', 'DOWN', 1300, 'BA', 'BR', { speedClass: 'slow' }), sec('SL5', 'DOWN', 1400, 'BA', 'BR', { speedClass: 'slow' }),
    // ---- Terminus throat (shared by both corridors for platforms 3 and 4) ----
    sec('P3W', 'LINK', 90, 'both', undefined), sec('P4W', 'LINK', 90, 'both', undefined),
    sec('T3E', 'LINK', 70, 'both', undefined), sec('T4E', 'LINK', 70, 'both', undefined),
    sec('AXA', 'LINK', 50, 'both', 'AJ'), sec('AXD', 'LINK', 30, 'both', 'AJ', { crosses: ['BXD'] }), sec('AXB', 'LINK', 50, 'both', 'AJ'),
    sec('BXA', 'LINK', 50, 'both', 'BR'), sec('BXD', 'LINK', 30, 'both', 'BR', { crosses: ['AXD'] }), sec('BXB', 'LINK', 50, 'both', 'BR'),
    // ---- Terminus platforms: A = throat end, B = buffer stops ----
    sec('PT1', 'PLATFORM', 280, 'both', 'AJ', { platform: 'T1' }), sec('PT2', 'PLATFORM', 300, 'both', 'AJ', { platform: 'T2' }),
    sec('PT3', 'PLATFORM', 320, 'both', undefined, { platform: 'T3' }), sec('PT4', 'PLATFORM', 320, 'both', undefined, { platform: 'T4' }),
    sec('PT5', 'PLATFORM', 300, 'both', 'BR', { platform: 'T5' }), sec('PT6', 'PLATFORM', 280, 'both', 'BR', { platform: 'T6' }),
  ],

  links: [
    // Lines are listed west to east: a section's B end joins the next section's A end.
    ...chain(['AU4', 'AU3'], ['AU3', 'AU2'], ['AU2', 'AU1'], ['AU1', 'AUP'], ['AUP', 'AUB'], ['AUB', 'AUC'], ['AUF', 'PT1']),
    ...chain(['DGA', 'DGX'], ['DGX', 'DGB']),
    ...chain(['DW4', 'DW3'], ['DW3', 'DW2'], ['DW2', 'DW1'], ['DW1', 'DWP'], ['DWP', 'DWv'], ['DWv', 'DWX'], ['DWX', 'DWz'], ['DEz', 'PT2']),
    ...chain(['BSA', 'BSB'], ['BSB', 'BSC'], ['BSC', 'BSD'], ['FA3', 'FA2'], ['FA2', 'FB'], ['FB', 'FC'], ['FD', 'FP'], ['FP', 'FE'], ['FE', 'FG']),
    ...chain(['FH1', 'FHX'], ['FHX', 'FH2'], ['FK', 'PT5'], ['GE', 'PT6'], ['BXA', 'BXD'], ['BXD', 'BXB'], ['AXA', 'AXD'], ['AXD', 'AXB'], ['T3E', 'PT3'], ['T4E', 'PT4']),
    // westbound BR line, west to east: GI GH GG GF [DVP] GW0 GW1 GP GA [CBD] GC [X2D] GD [XBD] GE
    ...chain(['GI', 'GH'], ['GH', 'GG'], ['GG', 'GF'], ['GW0', 'GW1'], ['GW1', 'GP'], ['GP', 'GA']),
    ...chain(['SL5', 'SL4'], ['SL4', 'SL3'], ['SL3', 'SL2'], ['SL2', 'SL1']),
    ...chain(['CB1', 'CBX'], ['CBX', 'CB2']),
  ],
  points: [
    { id: 'JA1', name: 'AJ-up / diagonal points', toe: B('AUC'), normal: A('AUD'), reverse: A('DGA') },
    { id: 'X1U', name: 'AJ platform 1 / westbound crossover (up side)', toe: A('AUE'), normal: B('AUD'), reverse: B('X1') },
    { id: 'XAU', name: 'AJ crossover to platform 2 (up side)', toe: B('AUE'), normal: A('AUF'), reverse: A('XA') },
    { id: 'XAD', name: 'AJ crossover to platform 2 (down side)', toe: A('DEz'), normal: B('DEw'), reverse: B('XA') },
    { id: 'CAJD', name: 'AJ-down / platform 3-4 connector', toe: B('DWy'), normal: A('DEw'), reverse: A('CAJ') },
    { id: 'X1D', name: 'AJ-down / westbound crossover (down side)', toe: B('DWz'), normal: A('DWy'), reverse: A('X1') },
    { id: 'CAJP', name: 'AJ diagonal connector points', toe: A('DGC'), normal: B('DGB'), reverse: B('CAJ') },
    { id: 'T3', name: 'Platform 3 west points (AJ)', toe: B('DGC'), normal: A('P3W'), reverse: A('AXA') },
    { id: 'T3E', name: 'Platform 3 east points (BR cross)', toe: A('T3E'), normal: B('P3W'), reverse: B('BXB') },
    { id: 'T4', name: 'Platform 4 west points (BR)', toe: B('BDB'), normal: A('P4W'), reverse: A('BXA') },
    { id: 'T4E', name: 'Platform 4 east points (AJ cross)', toe: A('T4E'), normal: B('P4W'), reverse: B('AXB') },
    { id: 'MGE', name: 'BR slow / fast merge', toe: A('FD'), normal: B('FC'), reverse: B('BSD') },
    { id: 'BDP', name: 'BR fast / diagonal points', toe: B('FG'), normal: A('FH1'), reverse: A('BDA') },
    { id: 'CBP', name: 'BR diagonal connector points', toe: A('BDB'), normal: B('BDA'), reverse: B('CB2') },
    { id: 'X2U', name: 'BR platform 5 / westbound crossover (fast east side)', toe: A('FJ'), normal: B('FH2'), reverse: B('X2') },
    { id: 'XBU', name: 'BR crossover to platform 6 (fast east side)', toe: B('FJ'), normal: A('FK'), reverse: A('XB') },
    { id: 'XBD', name: 'BR crossover to platform 6 (fast west side)', toe: A('GE'), normal: B('GD'), reverse: B('XB') },
    { id: 'X2D', name: 'BR fast west / westbound crossover', toe: B('GC'), normal: A('GD'), reverse: A('X2') },
    { id: 'CBD', name: 'BR fast west / platform 3-4 connector', toe: B('GA'), normal: A('GC'), reverse: A('CB1') },
    { id: 'DVP', name: 'BR fast / slow west diverge', toe: A('GW0'), normal: B('GF'), reverse: B('SL1') },
  ],
  junctions: [
    { id: 'AJ-THROAT', name: 'AJ approach to the terminus', points: ['JA1', 'X1U', 'XAU', 'XAD', 'CAJD', 'X1D'], sections: ['XA', 'X1'], crossings: [['DGX', 'DWX']] },
    { id: 'TERM-SCISSORS', name: 'Platform 3 / 4 scissors', points: ['CAJP', 'T3', 'T3E', 'T4', 'T4E', 'CBP'], sections: ['CAJ', 'AXA', 'AXD', 'AXB', 'BXA', 'BXD', 'BXB'], crossings: [['AXD', 'BXD']] },
    { id: 'BR-MERGE', name: 'BR slow / fast merge', points: ['MGE'], sections: ['BSD'] },
    { id: 'BR-THROAT', name: 'BR approach to the terminus', points: ['BDP', 'X2U', 'XBU', 'XBD', 'X2D', 'CBD'], sections: ['XB', 'X2', 'CB2', 'CBX', 'CB1'], crossings: [['FHX', 'CBX']] },
    { id: 'BR-DIVERGE', name: 'BR fast / slow diverge', points: ['DVP'], sections: ['SL1'] },
  ],
  signals: [
    // Automatic: Auto + three digits, outer approaches only (AJ-up 100-102, AJ-down 103-105, BR slow east 110-111, fast east 112-113, fast west 114-116, slow west 117-119).
    sig('AUa', 'NB100', 'automatic', B('AU4')), sig('AUb', 'NB101', 'automatic', B('AU3')), sig('AUc', 'NB102', 'automatic', B('AU2')),
    sig('ADa', 'NB103', 'automatic', A('DW1')), sig('ADb', 'NB104', 'automatic', A('DW2')), sig('ADc', 'NB105', 'automatic', A('DW3')),
    sig('BSa', 'NB110', 'automatic', B('BSA')), sig('BSb', 'NB111', 'automatic', B('BSB')),
    sig('BFa', 'NB112', 'automatic', B('FA3')), sig('BFb', 'NB113', 'automatic', B('FA2')),
    sig('BWa', 'NB114', 'automatic', A('GF')), sig('BWb', 'NB115', 'automatic', A('GG')), sig('BWc', 'NB116', 'automatic', A('GH')),
    sig('BXa', 'NB117', 'automatic', A('SL2')), sig('BXb', 'NB118', 'automatic', A('SL3')), sig('BXc', 'NB119', 'automatic', A('SL4')),
    // Manual: NB + two digits. 01-03 AJ-up, 04-05 AJ-down, 06-10 BR eastbound, 11-13 BR westbound.
    sig('N01', 'NB01', 'manual', B('AU1'), 'Northbridge-West platform 1 entry'),
    sig('N02', 'NB02', 'manual', B('AUP'), 'Northbridge-West platform 1 starter'),
    sig('N03', 'NB03', 'manual', B('AUB'), 'AJ-up, approaching the terminus'),
    sig('N04', 'NB04', 'manual', A('DWv'), 'Northbridge-West platform 2 entry (westbound)'),
    sig('N05', 'NB05', 'manual', A('DWP'), 'Northbridge-West platform 2 starter (westbound)'),
    sig('N06', 'NB06', 'manual', B('BSC'), 'BR slow line, merge into the fast line'),
    sig('N07', 'NB07', 'manual', B('FB'), 'BR fast line, merge with the slow line'),
    sig('N08', 'NB08', 'manual', B('FD'), 'Northbridge-West platform 3 entry'),
    sig('N09', 'NB09', 'manual', B('FP'), 'Northbridge-West platform 3 starter'),
    sig('N10', 'NB10', 'manual', B('FE'), 'BR fast east, approaching the terminus'),
    sig('N11', 'NB11', 'manual', A('GA'), 'Northbridge-West platform 4 entry (westbound)'),
    sig('N12', 'NB12', 'manual', A('GP'), 'Northbridge-West platform 4 starter (westbound)'),
    sig('N13', 'NB13', 'manual', A('GW1'), 'BR fast west, fast / slow diverge'),
    // Terminus: no entry signals. NB03 and NB10 set the route straight into a platform (route to its buffer stops). Departure signals 31-36.
    ...[1, 2, 3, 4, 5, 6].map((n) => sig(`D${n}`, `NB3${n}`, 'manual', A(`PT${n}`), `Northbridge platform ${n} departure`)),
  ],
  platforms: [
    { id: 'NBW1', name: 'Northbridge-West platform 1', section: 'AUP', access: ['AJ'] },
    { id: 'NBW2', name: 'Northbridge-West platform 2', section: 'DWP', access: ['AJ'] },
    { id: 'NBW3', name: 'Northbridge-West platform 3', section: 'FP', access: ['BR'] },
    { id: 'NBW4', name: 'Northbridge-West platform 4', section: 'GP', access: ['BR'] },
    { id: 'T1', name: 'Platform 1', section: 'PT1', access: ['AJ'] },
    { id: 'T2', name: 'Platform 2', section: 'PT2', access: ['AJ'] },
    { id: 'T3', name: 'Platform 3', section: 'PT3', access: ['AJ', 'BR'] },
    { id: 'T4', name: 'Platform 4', section: 'PT4', access: ['AJ', 'BR'] },
    { id: 'T5', name: 'Platform 5', section: 'PT5', access: ['BR'] },
    { id: 'T6', name: 'Platform 6', section: 'PT6', access: ['BR'] },
  ],
  boundaries: [
    { id: 'AJ-IN', name: 'Ashcombe Junction (in)', location: 'Ashcombe Junction', at: A('AU4'), entry: true, exit: false },
    { id: 'AJ-OUT', name: 'Ashcombe Junction (out)', location: 'Ashcombe Junction', at: A('DW4'), entry: false, exit: true },
    { id: 'BR-F-IN', name: 'Barchester fast (in)', location: 'Barchester', at: A('FA3'), entry: true, exit: false },
    { id: 'BR-S-IN', name: 'Barchester slow (in)', location: 'Barchester', at: A('BSA'), entry: true, exit: false },
    { id: 'BR-F-OUT', name: 'Barchester fast (out)', location: 'Barchester', at: A('GI'), entry: false, exit: true },
    { id: 'BR-S-OUT', name: 'Barchester slow (out)', location: 'Barchester', at: A('SL5'), entry: false, exit: true },
    ...[1, 2, 3, 4, 5, 6].map((n) => ({ id: `BUF${n}`, name: `Platform ${n} buffer stops`, location: 'Northbridge', at: B(`PT${n}`), entry: false, exit: false, buffer: true })),
  ],
  terminals: [1, 2, 3, 4, 5, 6].map((n) => ({ id: `TERM${n}`, name: `Platform ${n}`, platform: `T${n}`, section: `PT${n}`, departSignal: `D${n}`, buffer: `BUF${n}` })),
};
