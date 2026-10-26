// Estimates what tokens cost. No source reports cost, so the hub works it out from a price table:
// Anthropic's first-party API prices as of October 2026, overridable with `prices` in the config.
// It's an estimate. A subscription isn't billed per token, and prices change.

import * as z from 'zod';

/** US dollars per million tokens. Cache writes default to 1.25× input for 5 minutes and 2× for an hour. */
export const Price = z.strictObject({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite5m: z.number().nonnegative().optional(),
  cacheWrite1h: z.number().nonnegative().optional(),
  /** Fast mode's price multiple, for models that offer it. */
  fast: z.number().positive().optional(),
  /** A second rate card for prompts longer than `above` tokens. */
  long: z.strictObject({ above: z.number().int().positive(), input: z.number().nonnegative(), output: z.number().nonnegative(), cacheRead: z.number().nonnegative() }).optional(),
});
export type Price = z.infer<typeof Price>;

export const DEFAULT_PRICES: Record<string, Price> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, fast: 2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, fast: 2 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, long: { above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05 } },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
};

const WEB_SEARCH_USD = 0.01;

export interface MessageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  webSearches?: number;
  fast?: boolean;
}

export type CostOf = (model: string | undefined, tokens: MessageTokens) => number | undefined;

/** Returns a function that prices one model response, or `undefined` for a model it has no price for. */
export function makeCostOf(overrides: Record<string, Price> = {}): CostOf {
  const prices = { ...DEFAULT_PRICES, ...overrides };
  // Longest name first, so `claude-opus-5-5` wins over `claude-opus-5`, and dated IDs match their family.
  const names = Object.keys(prices).sort((a, b) => b.length - a.length);
  return (model, t) => {
    const id = model?.replace(/\[[^\]]*\]$/, ''); // `claude-opus-5-5[1m]` is the 1M-context window, priced the same
    const name = id && names.find((n) => id === n || id.startsWith(`${n}-`));
    const price = name ? prices[name] : undefined;
    if (!price) return undefined;
    if (t.fast && !price.fast) return undefined;
    const prompt = t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
    const card = price.long && prompt > price.long.above ? price.long : price;
    const write5m = price.cacheWrite5m ?? card.input * 1.25;
    const write1h = price.cacheWrite1h ?? card.input * 2;
    const tokens = t.input * card.input + t.output * card.output + t.cacheRead * card.cacheRead + t.cacheWrite5m * write5m + t.cacheWrite1h * write1h;
    return (tokens / 1_000_000) * (t.fast ? (price.fast ?? 1) : 1) + (t.webSearches ?? 0) * WEB_SEARCH_USD;
  };
}
