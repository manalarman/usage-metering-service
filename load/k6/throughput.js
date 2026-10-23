// Throughput / latency of POST /v1/consume under concurrency.
//   scenario multi_account : load spread over ACCOUNTS accounts (realistic multi-tenant traffic)
//   scenario single_account: every VU hits ONE account (worst case: all requests serialise on one account row lock)
// ~5% of iterations retry an earlier request id (idempotent replay path).
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { consume, getJson, provisionAccount, uuid } from './lib.js';

const VUS = Number(__ENV.VUS || 50);
const DURATION = __ENV.DURATION || '30s';
const ACCOUNTS = Number(__ENV.ACCOUNTS || 10);
const USERS_PER_ACCOUNT = Number(__ENV.USERS_PER_ACCOUNT || 20);

const accepted = new Counter('consume_accepted');
const rejected = new Counter('consume_rejected');
const replayed = new Counter('consume_replayed');

export const options = {
  setupTimeout: '120s',
  scenarios: {
    multi_account: { executor: 'constant-vus', vus: VUS, duration: DURATION, env: { MODE: 'multi' } },
    single_account: { executor: 'constant-vus', vus: VUS, duration: DURATION, env: { MODE: 'single' }, startTime: `${parseInt(DURATION, 10) + 5}s` },
  },
  thresholds: {
    'http_req_failed{scenario:multi_account}': ['rate<0.01'],
    'http_req_failed{scenario:single_account}': ['rate<0.01'],
    'http_req_duration{scenario:multi_account}': ['p(95)<500'],
    'http_req_duration{scenario:single_account}': ['p(95)<1000'],
    checks: ['rate==1.0'],
  },
};

const big = { monthlyAllowance: 1000000000, maxUnitsPerRequest: 100 };

export function setup() {
  const accounts = [];
  for (let a = 0; a < ACCOUNTS; a++) accounts.push(provisionAccount(`k6-tp-${Date.now()}-${a}`, big, big, USERS_PER_ACCOUNT));
  return { accounts };
}

const recent = [];

export default function (data) {
  const accts = data.accounts;
  const acct = __ENV.MODE === 'single' ? accts[0] : accts[(__VU + __ITER) % accts.length];
  let userId = acct.users[Math.floor(Math.random() * acct.users.length)];
  let units = 1 + Math.floor(Math.random() * 10);
  let requestId = uuid();
  let apiKey = acct.apiKey;
  if (recent.length && Math.random() < 0.05) {
    ({ apiKey, userId, units, requestId } = recent[Math.floor(Math.random() * recent.length)]);
  }
  const res = consume(apiKey, userId, units, requestId, { name: 'consume' });
  const ok = check(res, { 'status 200': (r) => r.status === 200 });
  if (!ok) return;
  const body = res.json();
  if (body.replayed) replayed.add(1);
  else if (body.accepted) accepted.add(1);
  else rejected.add(1);
  recent.push({ apiKey, userId, units, requestId });
  if (recent.length > 50) recent.shift();
}

export function teardown(data) {
  // Invariant: account usage == sum of its users' usage, for every account touched.
  for (const acct of data.accounts) {
    const account = getJson(acct.apiKey, '/v1/usage').account.consumed;
    let users = 0;
    for (const u of acct.users) users += getJson(acct.apiKey, `/v1/users/${u}/usage`).user.consumed;
    check(null, { 'account usage == sum(user usage)': () => account === users });
    console.log(`account ${acct.accountId}: account=${account} users_sum=${users}`);
  }
}
