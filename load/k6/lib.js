import http from 'k6/http';

export const BASE_URL = __ENV.API_URL || 'http://localhost:3000';
export const ADMIN_TOKEN = __ENV.ADMIN_TOKEN || 'dev-admin-token-change-me';

const json = (apiKey) => ({
  headers: { 'content-type': 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}) },
});

function must(res, status, what) {
  if (res.status !== status) throw new Error(`${what} failed: ${res.status} ${res.body}`);
  return res.json();
}

/** Provisions an account on a custom account plan with `userCount` users on a shared custom user plan. */
export function provisionAccount(name, accountLimits, userLimits, userCount) {
  const acct = must(
    http.post(`${BASE_URL}/v1/admin/accounts`, JSON.stringify({ name }), { headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN_TOKEN } }),
    201,
    'provision',
  );
  const key = acct.apiKey.key;
  const ap = must(http.post(`${BASE_URL}/v1/plans`, JSON.stringify({ name: 'load-account', scope: 'account', ...accountLimits }), json(key)), 201, 'account plan');
  must(http.put(`${BASE_URL}/v1/account/plan`, JSON.stringify({ planId: ap.id }), json(key)), 200, 'assign account plan');
  const up = must(http.post(`${BASE_URL}/v1/plans`, JSON.stringify({ name: 'load-user', scope: 'user', ...userLimits }), json(key)), 201, 'user plan');
  const users = [];
  for (let i = 0; i < userCount; i++) {
    const userId = `user-${i}`;
    must(http.post(`${BASE_URL}/v1/users`, JSON.stringify({ userId, planId: up.id }), json(key)), 201, 'user');
    users.push(userId);
  }
  return { apiKey: key, accountId: acct.account.id, users };
}

export function consume(apiKey, userId, units, requestId, tags) {
  return http.post(`${BASE_URL}/v1/consume`, JSON.stringify({ userId, units, requestId }), { ...json(apiKey), tags });
}

export function getJson(apiKey, path) {
  return http.get(`${BASE_URL}${path}`, json(apiKey)).json();
}

export function uuid() {
  // RFC4122-ish v4 using Math.random; uniqueness (not secrecy) is all a request id needs here.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
