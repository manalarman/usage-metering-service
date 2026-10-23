/** Minimal typed HTTP client for the Usage Metering API (Node 20+ global fetch). */

export interface Quota {
  planId: string;
  planName: string;
  monthlyAllowance: number;
  maxUnitsPerRequest: number;
  consumed: number;
  remaining: number;
}

export interface Violation {
  scope: 'account' | 'user';
  rule: 'max_units_per_request' | 'monthly_allowance';
  limit: number;
  requested: number;
  consumed?: number;
  remaining?: number;
  message: string;
}

export interface ConsumeResponse {
  requestId: string;
  userId: string;
  units: number;
  accepted: boolean;
  decision: 'accepted' | 'rejected';
  blockedBy: Violation | null;
  violations: Violation[];
  month: string;
  processedAt: string;
  account: Quota;
  user: Quota;
  replayed: boolean;
}

export interface Plan {
  id: string;
  code: string | null;
  name: string;
  scope: 'account' | 'user';
  predefined: boolean;
  monthlyAllowance: number;
  maxUnitsPerRequest: number;
  version: number;
}

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`HTTP ${status}: ${JSON.stringify(body)}`);
  }
}

export class UsageClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
    private readonly adminToken?: string,
  ) {}

  withApiKey(apiKey: string): UsageClient {
    return new UsageClient(this.baseUrl, apiKey, this.adminToken);
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    if (this.adminToken && path.startsWith('/v1/admin/')) headers['x-admin-token'] = this.adminToken;
    const res = await fetch(new URL(path, this.baseUrl), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new ApiRequestError(res.status, parsed);
    return parsed as T;
  }

  provisionAccount(name: string, planId?: string) {
    return this.request<{ account: { id: string; name: string; plan: Plan }; apiKey: { id: string; key: string } }>(
      'POST',
      '/v1/admin/accounts',
      { name, ...(planId ? { planId } : {}) },
    );
  }

  getAccount() {
    return this.request<{ id: string; name: string; plan: Plan }>('GET', '/v1/account');
  }
  setAccountPlan(planId: string) {
    return this.request<{ id: string; plan: Plan }>('PUT', '/v1/account/plan', { planId });
  }
  listPlans(scope?: 'account' | 'user') {
    return this.request<{ data: Plan[] }>('GET', `/v1/plans${scope ? `?scope=${scope}` : ''}`);
  }
  createPlan(input: { name: string; scope: 'account' | 'user'; monthlyAllowance: number; maxUnitsPerRequest: number }) {
    return this.request<Plan>('POST', '/v1/plans', input);
  }
  updatePlan(planId: string, patch: { name?: string; monthlyAllowance?: number; maxUnitsPerRequest?: number }) {
    return this.request<Plan>('PATCH', `/v1/plans/${encodeURIComponent(planId)}`, patch);
  }
  createUser(userId: string, planId?: string) {
    return this.request<{ userId: string; plan: Plan }>('POST', '/v1/users', { userId, ...(planId ? { planId } : {}) });
  }
  setUserPlan(userId: string, planId: string) {
    return this.request<{ userId: string; plan: Plan }>('PUT', `/v1/users/${encodeURIComponent(userId)}/plan`, { planId });
  }
  consume(userId: string, units: number, requestId: string) {
    return this.request<ConsumeResponse>('POST', '/v1/consume', { userId, units, requestId });
  }
  accountUsage(month?: string) {
    return this.request<{ month: string; account: { consumed: number; remaining: number; plan: Plan } }>(
      'GET',
      `/v1/usage${month ? `?month=${month}` : ''}`,
    );
  }
  userUsage(userId: string, month?: string) {
    return this.request<{
      month: string;
      user: { userId: string; consumed: number; remaining: number; plan: Plan };
      account: { consumed: number; remaining: number; plan: Plan };
    }>('GET', `/v1/users/${encodeURIComponent(userId)}/usage${month ? `?month=${month}` : ''}`);
  }
  history(params: { limit?: number; cursor?: string; userId?: string } = {}) {
    const qs = new URLSearchParams(
      Object.entries(params)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)] as [string, string]),
    );
    return this.request<{ data: ConsumeResponse[]; nextCursor: string | null }>('GET', `/v1/requests?${qs}`);
  }
}
