/**
 * Platform stopping positions (Phase 4).
 *
 * A platform is a track section (PlatformDef.section). The LOGICAL stopping
 * position is a distance along that section, measured in the direction the
 * train is travelling: the front stops `PLATFORM_END_MARGIN_M` short of the far
 * end of the platform section. Nothing here knows about the screen: the diagram
 * draws the train wherever its logical position maps to on the SVG.
 *
 *     enter end                                   far end (starter signal)
 *     |<------------------ platform section ------------------>|
 *                                  |<--- train --->|<- margin ->|
 *                                                  ^ front stops here
 *
 * Because it is measured from the far end in the direction of travel, a
 * bidirectional platform (Platform 2) has a stopping position for each
 * direction, with no special casing.
 *
 * FIT. The train must fit between the entry end and the stopping position:
 * length <= platform length - margin. A train that does not fit is refused.
 */

import { otherEnd, type Network } from '../topology/network';
import type { PlatformDef, SectionDef } from '../topology/types';

/** The front stops this far short of the platform's far end. */
export const PLATFORM_END_MARGIN_M = 10;

export function platformDef(net: Network, platformId: string): PlatformDef | undefined {
  return net.platforms.get(platformId);
}

export function platformSectionDef(net: Network, platformId: string): SectionDef | undefined {
  const p = net.platforms.get(platformId);
  return p ? net.sections.get(p.section) : undefined;
}

export type FitResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Does a train of this length fit at the platform's stopping position? */
export function platformFit(net: Network, platformId: string, lengthM: number): FitResult {
  const section = platformSectionDef(net, platformId);
  const platform = net.platforms.get(platformId);
  if (!section || !platform) return { ok: false, reason: `Unknown platform ${platformId}.` };
  const usable = section.lengthM - PLATFORM_END_MARGIN_M;
  if (lengthM > usable) {
    return { ok: false, reason: `${platform.name} is too short: the train is ${lengthM} m long and the platform has ${usable} m of usable length.` };
  }
  return { ok: true };
}

/** Logical stopping position for a train that entered the platform section through `enterEnd`. */
export function platformStopPosition(net: Network, platformId: string, enterEnd: 'A' | 'B'): { section: string; atEnd: 'A' | 'B'; distanceFromEntryM: number } | undefined {
  const section = platformSectionDef(net, platformId);
  if (!section) return undefined;
  return { section: section.id, atEnd: otherEnd(enterEnd), distanceFromEntryM: section.lengthM - PLATFORM_END_MARGIN_M };
}

/** Platforms a movement passes through (a platform is "on" a route when its section is). */
export function platformsOnSections(net: Network, sections: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of net.platforms.values()) if (sections.includes(p.section)) out.push(p.id);
  return out;
}
