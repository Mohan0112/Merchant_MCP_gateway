import { ToolError, type ToolHandler } from '@urumi/mcp-kit';
import { describe, expect, it } from 'vitest';
import type { RatesSource, RateTable } from './rates';
import { buildTools } from './tools';

const fakeRates: RatesSource = {
  async getRates(base): Promise<RateTable> {
    if (base === 'INR')
      return { base, date: '2026-10-14', rates: { USD: 0.012, EUR: 0.0103 }, source: 'fake' };
    if (base === 'USD')
      return { base, date: '2026-10-14', rates: { INR: 83.3, EUR: 0.86 }, source: 'fake' };
    throw new Error('unknown base');
  },
};

const tools = Object.fromEntries(buildTools(fakeRates).map((tool) => [tool.name, tool])) as Record<
  string,
  ToolHandler
>;
const run = (name: string, input: unknown) => {
  const tool = tools[name]!;
  return tool.execute(tool.inputSchema.parse(input) as never) as Promise<Record<string, unknown>>;
};

describe('fx tools', () => {
  it('converts an amount and rounds to two decimals', async () => {
    const result = await run('convert_currency', { amount: 1749, from: 'inr', to: 'usd' });
    expect(result).toMatchObject({
      from: 'INR',
      to: 'USD',
      rate: 0.012,
      result: 20.99,
      source: 'fake',
    });
  });

  it('returns rate 1 for the same currency', async () => {
    const result = await run('get_exchange_rate', { from: 'INR', to: 'INR' });
    expect(result.rate).toBe(1);
  });

  it('reports unknown currencies as tool errors', async () => {
    await expect(
      run('convert_currency', { amount: 1, from: 'INR', to: 'XYZ' }),
    ).rejects.toBeInstanceOf(ToolError);
    await expect(run('convert_currency', { amount: 1, from: 'ABC', to: 'USD' })).rejects.toThrow(
      /Unknown currency code 'ABC'/,
    );
  });

  it('rejects malformed codes at the schema level', () => {
    expect(() =>
      tools.convert_currency!.inputSchema.parse({ amount: 1, from: 'RUPEE', to: 'USD' }),
    ).toThrow();
  });

  it('lists currency codes sorted', async () => {
    const result = await run('list_currencies', {});
    expect(result.currencies).toEqual(['EUR', 'INR']);
  });
});
