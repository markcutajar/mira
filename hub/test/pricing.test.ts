import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { makeCostOf, type MessageTokens } from '../src/pricing.ts';

const tokens = (t: Partial<MessageTokens>): MessageTokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...t });
const close = (actual: number | undefined, expected: number) => assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);

describe('makeCostOf', () => {
  const costOf = makeCostOf();

  it('prices input, output, cache reads and both cache writes', () => {
    // Opus 5.5: $4 in, $20 out, $0.20 cache read, $5 5-minute write, $8 1-hour write, per million tokens.
    close(costOf('claude-opus-5-5', tokens({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 })), 4 + 20 + 0.2 + 5 + 8);
  });

  it('matches the longest model name, dated IDs and the 1M-context suffix', () => {
    close(costOf('claude-opus-5', tokens({ input: 1e6 })), 5);
    close(costOf('claude-haiku-4-5-20251001', tokens({ input: 1e6 })), 1);
    close(costOf('claude-opus-5-5[1m]', tokens({ input: 1e6 })), 4);
  });

  it('uses the long-prompt rate card above its threshold', () => {
    close(costOf('claude-haiku-5-5', tokens({ input: 50_000 })), 0.005);
    close(costOf('claude-haiku-5-5', tokens({ input: 200_000 })), 0.1);
  });

  it('prices fast mode only where the multiple is known, and web searches', () => {
    close(costOf('claude-opus-5-5', tokens({ output: 1e6, fast: true })), 40);
    assert.equal(costOf('claude-sonnet-5', tokens({ output: 1e6, fast: true })), undefined);
    close(costOf('claude-sonnet-5', tokens({ webSearches: 3 })), 0.03);
  });

  it('knows nothing about other models, unless the config adds them', () => {
    assert.equal(costOf('gpt-9', tokens({ input: 1e6 })), undefined);
    assert.equal(costOf(undefined, tokens({ input: 1e6 })), undefined);
    close(makeCostOf({ 'my-model': { input: 1, output: 2, cacheRead: 0.1 } })('my-model', tokens({ output: 1e6 })), 2);
  });
});
