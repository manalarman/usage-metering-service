import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UsageClient } from '../src/client/api';
import { runDemo } from '../src/client/demo';
import { ADMIN_TOKEN } from './env';
import { assertUsageInvariant, createTestContext } from './helpers';

const ctx = createTestContext();
let baseUrl: string;

beforeAll(async () => {
  baseUrl = await ctx.listen();
});
afterAll(() => ctx.close());

describe('example CLI client', () => {
  it('runs the end-to-end demo with the expected decisions', async () => {
    const lines: string[] = [];
    const report = await runDemo({ apiUrl: baseUrl, adminToken: ADMIN_TOKEN, log: (l) => lines.push(l) });

    expect(report.ok).toBe(true);
    expect(report.steps.map((s) => [s.result.decision, s.result.blockedBy?.scope ?? null, s.result.blockedBy?.rule ?? null, s.result.replayed])).toEqual([
      ['accepted', null, null, false],
      ['rejected', 'user', 'max_units_per_request', false],
      ['accepted', null, null, false],
      ['accepted', null, null, false],
      ['rejected', 'account', 'monthly_allowance', false],
      ['accepted', null, null, true],
      ['accepted', null, null, false], // after plan update
      ['accepted', null, null, false], // after plan switch
    ]);
    expect(report.finalUsage).toEqual({ alice: 230, bob: 1200, account: 1430 });
    await assertUsageInvariant(ctx.pool, report.accountId);

    const output = lines.join('\n');
    expect(output).toContain('reason: [user / max_units_per_request]');
    expect(output).toContain('reason: [account / monthly_allowance]');
    expect(output).toMatch(/remaining: user alice \d+\/\d+/);
    expect(output).toContain('DEMO OK');
  });

  it('surfaces API errors with status and body', async () => {
    const client = new UsageClient(baseUrl, 'umk_invalid');
    await expect(client.getAccount()).rejects.toMatchObject({ status: 401, body: { error: { code: 'invalid_api_key' } } });
  });
});
