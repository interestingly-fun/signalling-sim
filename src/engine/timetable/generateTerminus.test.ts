import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildNetwork } from '../topology/network';
import { northbridgeDefinition } from '../topology/northbridge';
import { createSignallingContext } from '../signalling';
import { boundaryCorridor } from '../trains';
import { DIFFICULTY_IDS, DIFFICULTIES } from './difficulty';
import { generateTimetable } from './generate';
import { validateTimetable } from './validate';
import { concurrencyStats } from './concurrency';

const ctx = createSignallingContext(buildNetwork(northbridgeDefinition));

describe('northbridge timetables', () => {
  for (const d of DIFFICULTY_IDS) {
    it(`${d}: valid, both corridors, deterministic`, () => {
      const counts: number[] = [];
      for (const seed of [1, 2, 3, 4, 5, 6]) {
        const t0 = Date.now();
        const tt = generateTimetable(ctx, seed, { difficulty: d });
        assert.deepEqual(validateTimetable(ctx, tt, { countRange: [3, DIFFICULTIES[d].countRange[1]] }), []);
        const cors = new Set(tt.services.map((s) => boundaryCorridor(ctx.net, s.origin)));
        assert.ok(cors.has('AJ') && cors.has('BR'), 'both corridors');
        counts.push(tt.services.length);
        const mix = tt.services.map((s) => `${s.trainClass}>${s.ecs?.onward.trainClass}:${s.origin}:${s.ecs?.siding}:${s.ecs?.terminal?.inboundCall ? 'i' : ''}${s.ecs?.terminal?.outboundCall ? 'o' : ''}`).join(' ');
        console.log(d, seed, tt.services.length, 'max', concurrencyStats(tt.services).maxPresent, tt.usedFallback ? 'FALLBACK' : '', `${Date.now() - t0}ms`, tt.report?.reductionReasons[0] ?? '');
        if (seed === 1) console.log('  ', mix);
        const again = generateTimetable(ctx, seed, { difficulty: d });
        assert.deepEqual(again.services.map((s) => [s.headcode, s.entryS]), tt.services.map((s) => [s.headcode, s.entryS]));
      }
    });
  }
});
