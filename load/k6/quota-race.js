// Overspend check under contention: many VUs race for a small shared allowance.
// Expected: the account ends at EXACTLY its allowance (never above), and account usage == sum of user usage.
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { consume, getJson, provisionAccount, uuid } from './lib.js';

const VUS = Number(__ENV.VUS || 100);
const ALLOWANCE = Number(__ENV.ALLOWANCE || 1000);
const USERS = 10;

const accepted = new Counter('race_accepted');
const rejected = new Counter('race_rejected');

export const options = {
  setupTimeout: '60s',
  scenarios: { race: { executor: 'shared-iterations', vus: VUS, iterations: ALLOWANCE * 3, maxDuration: '120s' } },
  thresholds: { http_req_failed: ['rate==0'], checks: ['rate==1.0'] },
};

export function setup() {
  return provisionAccount(
    `k6-race-${Date.now()}`,
    { monthlyAllowance: ALLOWANCE, maxUnitsPerRequest: 10 },
    { monthlyAllowance: ALLOWANCE, maxUnitsPerRequest: 10 },
    USERS,
  );
}

export default function (acct) {
  const res = consume(acct.apiKey, acct.users[__ITER % USERS], 1, uuid());
  check(res, { 'status 200': (r) => r.status === 200 });
  if (res.status === 200) (res.json().accepted ? accepted : rejected).add(1);
}

export function teardown(acct) {
  const account = getJson(acct.apiKey, '/v1/usage').account;
  let users = 0;
  for (const u of acct.users) users += getJson(acct.apiKey, `/v1/users/${u}/usage`).user.consumed;
  console.log(`allowance=${ALLOWANCE} account_consumed=${account.consumed} users_sum=${users} remaining=${account.remaining}`);
  check(null, {
    'account consumed exactly the allowance (no overspend)': () => account.consumed === ALLOWANCE,
    'account usage == sum(user usage)': () => account.consumed === users,
  });
}
