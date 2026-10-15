import { defineTool, ToolError, type ToolHandler } from '@urumi/mcp-kit';
import * as z from 'zod';
import type { RatesSource, RateTable } from './rates';

const Currency = z
  .string()
  .regex(/^[A-Za-z]{3}$/, 'Use a 3-letter ISO 4217 code such as INR or USD')
  .transform((code) => code.toUpperCase())
  .describe('3-letter ISO 4217 currency code, e.g. INR, USD, EUR');

function rateBetween(table: RateTable, to: string): number {
  const rate = table.rates[to];
  if (rate === undefined) throw new ToolError(`Unknown currency code '${to}'.`);
  return rate;
}

async function ratesFor(rates: RatesSource, base: string): Promise<RateTable> {
  try {
    return await rates.getRates(base);
  } catch {
    throw new ToolError(`Unknown currency code '${base}' or no rates available for it.`);
  }
}

export function buildTools(rates: RatesSource): ToolHandler[] {
  const convert = defineTool({
    name: 'convert_currency',
    title: 'Convert currency',
    description:
      'Convert an amount from one currency to another using the latest daily reference rates.',
    inputSchema: z.object({
      amount: z.number().nonnegative().describe('Amount in the source currency'),
      from: Currency,
      to: Currency,
    }),
    outputSchema: z.object({
      amount: z.number(),
      from: z.string(),
      to: z.string(),
      rate: z.number(),
      result: z.number(),
      date: z.string(),
      source: z.string(),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    execute: async ({ amount, from, to }) => {
      const table = await ratesFor(rates, from);
      const rate = from === to ? 1 : rateBetween(table, to);
      return {
        amount,
        from,
        to,
        rate,
        result: Math.round(amount * rate * 100) / 100,
        date: table.date,
        source: table.source,
      };
    },
  });

  const exchangeRate = defineTool({
    name: 'get_exchange_rate',
    title: 'Get exchange rate',
    description: 'Get the latest daily exchange rate between two currencies (1 FROM = rate TO).',
    inputSchema: z.object({ from: Currency, to: Currency }),
    outputSchema: z.object({
      from: z.string(),
      to: z.string(),
      rate: z.number(),
      date: z.string(),
      source: z.string(),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    execute: async ({ from, to }) => {
      const table = await ratesFor(rates, from);
      return {
        from,
        to,
        rate: from === to ? 1 : rateBetween(table, to),
        date: table.date,
        source: table.source,
      };
    },
  });

  const listCurrencies = defineTool({
    name: 'list_currencies',
    title: 'List currencies',
    description: 'List the 3-letter currency codes that can be converted.',
    inputSchema: z.object({}),
    outputSchema: z.object({ currencies: z.array(z.string()), source: z.string() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    execute: async () => {
      const table = await ratesFor(rates, 'USD');
      return { currencies: Object.keys(table.rates).sort(), source: table.source };
    },
  });

  return [convert, exchangeRate, listCurrencies] as ToolHandler[];
}
