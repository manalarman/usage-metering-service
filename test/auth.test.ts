import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashApiKey } from '../src/apiKeys';
import { ADMIN_TOKEN } from './env';
import { createTestContext } from './helpers';

const ctx = createTestContext();
afterAll(() => ctx.close());

describe('account provisioning', () => {
  it('requires the admin token', async () => {
    const missing = await ctx.http().post('/v1/admin/accounts').send({ name: 'x' });
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe('invalid_admin_token');
    const wrong = await ctx.http().post('/v1/admin/accounts').set('x-admin-token', 'nope').send({ name: 'x' });
    expect(wrong.status).toBe(401);
  });

  it('creates an account on the default Starter plan and returns an API key once', async () => {
    const res = await ctx.http().post('/v1/admin/accounts').set('x-admin-token', ADMIN_TOKEN).send({ name: 'Acme' });
    expect(res.status).toBe(201);
    expect(res.body.account).toMatchObject({ name: 'Acme', plan: { code: 'starter', scope: 'account', predefined: true } });
    expect(res.body.apiKey.key).toMatch(/^umk_[A-Za-z0-9_-]{43}$/);

    const me = await ctx.as(res.body.apiKey.key).get('/v1/account').expect(200);
    expect(me.body.id).toBe(res.body.account.id);
  });

  it('accepts an explicit account plan and rejects a user-scoped plan', async () => {
    const pro = await ctx.http().post('/v1/admin/accounts').set('x-admin-token', ADMIN_TOKEN).send({ name: 'P', planId: 'pro' });
    expect(pro.status).toBe(201);
    expect(pro.body.account.plan.code).toBe('pro');
    const bad = await ctx.http().post('/v1/admin/accounts').set('x-admin-token', ADMIN_TOKEN).send({ name: 'B', planId: 'basic' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('plan_scope_mismatch');
  });

  it('stores only a SHA-256 hash of the key, never the plaintext', async () => {
    const { accountId, apiKey } = await ctx.provision();
    const { rows } = await ctx.pool.query('SELECT * FROM api_keys WHERE account_id = $1', [accountId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].key_hash).toBe(hashApiKey(apiKey));
    expect(JSON.stringify(rows[0])).not.toContain(apiKey);
    expect(apiKey.startsWith(rows[0].key_prefix)).toBe(true);
    expect(rows[0].key_prefix.length).toBeLessThan(apiKey.length / 3);
  });

  it('generates distinct keys', async () => {
    const keys = await Promise.all([1, 2, 3, 4, 5].map(() => ctx.provision()));
    expect(new Set(keys.map((k) => k.apiKey)).size).toBe(5);
  });
});

describe('API key authentication', () => {
  it('rejects requests without a key', async () => {
    for (const path of ['/v1/account', '/v1/plans', '/v1/usage', '/v1/requests']) {
      const res = await ctx.http().get(path);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('missing_api_key');
    }
    const consume = await ctx.http().post('/v1/consume').send({ userId: 'a', units: 1, requestId: 'r' });
    expect(consume.status).toBe(401);
  });

  it('rejects invalid keys', async () => {
    const { apiKey } = await ctx.provision();
    for (const key of ['garbage', `${apiKey}x`, apiKey.slice(0, -1), apiKey.toUpperCase()]) {
      const res = await ctx.http().get('/v1/account').set('x-api-key', key);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('invalid_api_key');
    }
  });

  it('supports issuing additional keys and revoking keys', async () => {
    const { apiKey } = await ctx.provision();
    const api = ctx.as(apiKey);
    const second = await api.post('/v1/api-keys').expect(201);
    await ctx.as(second.body.key).get('/v1/account').expect(200);

    const list = await api.get('/v1/api-keys').expect(200);
    expect(list.body.data).toHaveLength(2);
    expect(JSON.stringify(list.body)).not.toContain(second.body.key);

    await api.del(`/v1/api-keys/${second.body.id}`).expect(204);
    const revoked = await ctx.as(second.body.key).get('/v1/account');
    expect(revoked.status).toBe(401);
    await api.get('/v1/account').expect(200);
  });

  it('returns structured errors for malformed JSON and unknown routes', async () => {
    const { apiKey } = await ctx.provision();
    const bad = await ctx.http().post('/v1/consume').set('x-api-key', apiKey).set('content-type', 'application/json').send('{"oops');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_json');
    const missing = await ctx.as(apiKey).get('/v1/nope');
    expect(missing.status).toBe(404);
  });
});
