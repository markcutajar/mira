import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { daylightAt, halloween, miraStar, seasonOf, sunHours } from '../web/sky/daylight.ts';

// Local times, as the island reads the clock of the machine it runs on.
const at = (month: number, day: number, hour: number, minute = 0) => new Date(2026, month - 1, day, hour, minute);

describe('day, night and the seasons on the island (decision 62)', () => {
  it('lights the island by day and shades it blue at night', () => {
    assert.deepEqual(daylightAt(at(7, 15, 13)), { tint: [1, 1, 1], night: 0, asleep: false });
    const night = daylightAt(at(7, 15, 3));
    assert.equal(night.night, 1);
    assert.ok(night.tint[2] > night.tint[0], 'night is blue');
  });

  it('turns warm towards sunset and fades into night after it', () => {
    const { set } = sunHours(at(10, 31, 12));
    const hour = (h: number) => at(10, 31, Math.floor(h), Math.round((h % 1) * 60));
    const golden = daylightAt(hour(set - 0.6));
    assert.deepEqual([golden.night, golden.tint[0] > golden.tint[2]], [0, true]);
    const dusk = daylightAt(hour(set + 0.8));
    assert.ok(dusk.night > 0.45 && dusk.night < 1);
    assert.equal(daylightAt(hour(set + 1.5)).night, 1);
  });

  it('has longer days in June than in December', () => {
    const june = sunHours(at(6, 21, 12));
    const december = sunHours(at(12, 21, 12));
    assert.ok(june.set - june.rise > 14.5);
    assert.ok(december.set - december.rise < 9.5);
  });

  it('sends mirlings to bed at ten and gets them up at half past six', () => {
    assert.deepEqual([at(7, 15, 21, 59), at(7, 15, 22), at(7, 15, 6, 29), at(7, 15, 6, 30)].map((d) => daylightAt(d).asleep), [false, true, true, false]);
  });

  it('knows the season by the month, and when the jack-o\'-lanterns come out', () => {
    assert.deepEqual([1, 3, 5, 6, 8, 9, 11, 12].map((m) => seasonOf(at(m, 10, 12))), ['winter', 'spring', 'spring', 'summer', 'summer', 'autumn', 'autumn', 'winter']);
    assert.deepEqual([[10, 21], [10, 22], [10, 31], [11, 1], [11, 2]].map(([m, d]) => halloween(at(m as number, d as number, 12))), [false, true, true, true, false]);
  });

  it('brightens and fades Mira the star every 332 days, rising faster than it fades', () => {
    const peak = miraStar(new Date(Date.UTC(2026, 0, 20)));
    assert.ok(peak.brightness > 0.99);
    assert.ok(miraStar(new Date(Date.UTC(2026, 0, 20) + 332 * 86_400_000)).brightness > 0.99);
    const faintest = miraStar(new Date(Date.UTC(2026, 0, 20) + 0.62 * 332 * 86_400_000));
    assert.ok(faintest.brightness < 0.16);
    const fading = miraStar(new Date(Date.UTC(2026, 0, 20) + 100 * 86_400_000));
    assert.deepEqual([fading.rising, fading.days], [false, 100]);
    const rising = miraStar(new Date(Date.UTC(2026, 0, 20) + 300 * 86_400_000));
    assert.deepEqual([rising.rising, rising.days], [true, 32]);
  });
});
