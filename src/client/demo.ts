import { randomUUID } from 'node:crypto';
import { ConsumeResponse, UsageClient } from './api';

export interface DemoStep {
  title: string;
  expected: { accepted: boolean; scope?: 'account' | 'user'; rule?: string; replayed?: boolean };
  result: ConsumeResponse;
  matched: boolean;
}

export interface DemoReport {
  accountId: string;
  steps: DemoStep[];
  finalUsage: { account: number; alice: number; bob: number };
  ok: boolean;
}

/**
 * End-to-end scenario: one account, two users on different plans, sharing an account allowance.
 *
 *   Account plan "Team Shared" (custom): 1000 units / month, max 500 per request
 *   alice: Basic   (predefined)          1000 units / month, max 100 per request
 *   bob:   Premium (predefined)         20000 units / month, max 1000 per request
 *
 * Plan changes are made through the API at runtime; the decisions change without any client code change.
 */
export async function runDemo(opts: { apiUrl: string; adminToken: string; log?: (line: string) => void }): Promise<DemoReport> {
  const log = opts.log ?? (() => undefined);
  const runId = randomUUID().slice(0, 8);
  const admin = new UsageClient(opts.apiUrl, undefined, opts.adminToken);

  log(`== Usage Metering demo (run ${runId}) against ${opts.apiUrl}`);
  const { account, apiKey } = await admin.provisionAccount(`demo-${runId}`);
  const api = admin.withApiKey(apiKey.key);
  log(`Provisioned account ${account.id} (API key ${apiKey.key.slice(0, 12)}…, shown once at creation)`);

  const teamPlan = await api.createPlan({ name: 'Team Shared', scope: 'account', monthlyAllowance: 1000, maxUnitsPerRequest: 500 });
  await api.setAccountPlan(teamPlan.id);
  log(`Account plan: custom "${teamPlan.name}" (${teamPlan.monthlyAllowance}/month, max ${teamPlan.maxUnitsPerRequest}/request)`);
  const alice = await api.createUser('alice', 'basic');
  const bob = await api.createUser('bob', 'premium');
  for (const u of [alice, bob]) {
    log(`User ${u.userId}: ${u.plan.name} plan (${u.plan.monthlyAllowance}/month, max ${u.plan.maxUnitsPerRequest}/request)`);
  }

  const steps: DemoStep[] = [];
  const step = async (title: string, userId: string, units: number, expected: DemoStep['expected'], requestId = `${runId}-${steps.length + 1}`) => {
    const result = await api.consume(userId, units, requestId);
    const matched =
      result.accepted === expected.accepted &&
      (expected.scope === undefined || result.blockedBy?.scope === expected.scope) &&
      (expected.rule === undefined || result.blockedBy?.rule === expected.rule) &&
      (expected.replayed === undefined || result.replayed === expected.replayed);
    steps.push({ title, expected, result, matched });
    log('');
    log(`${steps.length}. ${title}`);
    log(`   POST /v1/consume {userId: "${userId}", units: ${units}, requestId: "${requestId}"}`);
    log(`   -> ${result.decision.toUpperCase()}${result.replayed ? ' (replayed from stored outcome)' : ''}${matched ? '' : '   !! UNEXPECTED'}`);
    if (result.blockedBy) log(`   reason: [${result.blockedBy.scope} / ${result.blockedBy.rule}] ${result.blockedBy.message}`);
    log(`   remaining: user ${userId} ${result.user.remaining}/${result.user.monthlyAllowance} (${result.user.planName}), account ${result.account.remaining}/${result.account.monthlyAllowance} (${result.account.planName})`);
    return result;
  };

  await step('alice consumes 80 units', 'alice', 80, { accepted: true });
  await step('alice requests 150 units: exceeds her Basic per-request cap', 'alice', 150, { accepted: false, scope: 'user', rule: 'max_units_per_request' });
  await step('bob consumes 400 units', 'bob', 400, { accepted: true });
  await step('bob consumes 400 units', 'bob', 400, { accepted: true });
  await step('bob requests 400 more: bob has plenty left, but the SHARED account allowance does not', 'bob', 400, {
    accepted: false,
    scope: 'account',
    rule: 'monthly_allowance',
  });
  await step('retry of step 1 with the same requestId: original outcome, nothing consumed again', 'alice', 80, { accepted: true, replayed: true }, `${runId}-1`);

  log('');
  log('-- Plan update: PATCH /v1/plans/:id raises "Team Shared" to 5000 units/month (applies to new requests)');
  await api.updatePlan(teamPlan.id, { monthlyAllowance: 5000 });
  await step('bob requests 400 again (same input as step 5, new requestId): now accepted', 'bob', 400, { accepted: true });

  log('');
  log('-- Plan switch: PUT /v1/users/alice/plan -> Premium (her existing usage is preserved)');
  await api.setUserPlan('alice', 'premium');
  await step('alice requests 150 again: accepted under Premium (max 1000/request)', 'alice', 150, { accepted: true });

  const [aliceUsage, bobUsage, accountUsage] = await Promise.all([api.userUsage('alice'), api.userUsage('bob'), api.accountUsage()]);
  const finalUsage = { account: accountUsage.account.consumed, alice: aliceUsage.user.consumed, bob: bobUsage.user.consumed };
  log('');
  log(`== Final usage for ${accountUsage.month} (UTC)`);
  log(`   alice:   ${finalUsage.alice} consumed, ${aliceUsage.user.remaining} remaining (${aliceUsage.user.plan.name})`);
  log(`   bob:     ${finalUsage.bob} consumed, ${bobUsage.user.remaining} remaining (${bobUsage.user.plan.name})`);
  log(`   account: ${finalUsage.account} consumed, ${accountUsage.account.remaining} remaining (${accountUsage.account.plan.name})`);
  const sumMatches = finalUsage.account === finalUsage.alice + finalUsage.bob;
  log(`   account usage == alice + bob: ${sumMatches}`);

  const ok = steps.every((s) => s.matched) && sumMatches;
  log('');
  log(ok ? 'DEMO OK: every decision matched expectations' : 'DEMO FAILED: see UNEXPECTED markers above');
  return { accountId: account.id, steps, finalUsage, ok };
}
