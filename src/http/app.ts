import { timingSafeEqual } from 'node:crypto';
import express, { NextFunction, Request, Response } from 'express';
import { Pool } from 'pg';
import { ZodError } from 'zod';
import { ApiError } from '../errors';
import { MeteringService } from '../service';
import * as s from './schemas';

export const API_KEY_HEADER = 'x-api-key';
export const ADMIN_TOKEN_HEADER = 'x-admin-token';

export interface AppOptions {
  pool: Pool;
  adminToken: string;
  /** Injectable clock; tests use it to cross UTC month boundaries. */
  now?: () => Date;
  logRequests?: boolean;
}

/** Account id resolved from the API key; every authenticated handler is scoped to it. */
const accountOf = (res: Response): string => res.locals.accountId as string;

export function createApp(opts: AppOptions) {
  const svc = new MeteringService(opts.pool, opts.now);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  if (opts.logRequests) {
    app.use((req, res, next) => {
      const start = process.hrtime.bigint();
      res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms`);
      });
      next();
    });
  }

  app.get('/health', async (_req, res) => {
    await opts.pool.query('SELECT 1');
    res.json({ status: 'ok' });
  });

  // -------------------------------------------------------------- operator provisioning
  const requireAdmin = (req: Request, _res: Response, next: NextFunction) => {
    const supplied = req.header(ADMIN_TOKEN_HEADER) ?? '';
    if (!opts.adminToken) throw new ApiError(503, 'provisioning_disabled', 'ADMIN_TOKEN is not configured');
    if (!safeEqual(supplied, opts.adminToken)) throw new ApiError(401, 'invalid_admin_token', 'Missing or invalid admin token');
    next();
  };

  app.post('/v1/admin/accounts', requireAdmin, async (req, res) => {
    const body = s.createAccountBody.parse(req.body);
    res.status(201).json(await svc.createAccount(body.name, body.planId));
  });

  // -------------------------------------------------------------- authenticated API
  const v1 = express.Router();
  v1.use(async (req, res, next) => {
    const key = req.header(API_KEY_HEADER);
    if (!key) throw new ApiError(401, 'missing_api_key', `Missing ${API_KEY_HEADER} header`);
    const accountId = await svc.authenticate(key);
    if (!accountId) throw new ApiError(401, 'invalid_api_key', 'Invalid or revoked API key');
    res.locals.accountId = accountId;
    next();
  });

  v1.get('/account', async (_req, res) => {
    res.json(await svc.getAccount(accountOf(res)));
  });
  v1.put('/account/plan', async (req, res) => {
    res.json(await svc.setAccountPlan(accountOf(res), s.assignPlanBody.parse(req.body).planId));
  });

  v1.get('/api-keys', async (_req, res) => {
    res.json({ data: await svc.listApiKeys(accountOf(res)) });
  });
  v1.post('/api-keys', async (_req, res) => {
    res.status(201).json(await svc.createApiKey(accountOf(res)));
  });
  v1.delete('/api-keys/:keyId', async (req, res) => {
    await svc.revokeApiKey(accountOf(res), req.params.keyId as string);
    res.status(204).end();
  });

  v1.get('/plans', async (req, res) => {
    const q = s.listPlansQuery.parse(req.query);
    res.json({ data: await svc.listPlans(accountOf(res), q.scope) });
  });
  v1.post('/plans', async (req, res) => {
    res.status(201).json(await svc.createPlan(accountOf(res), s.createPlanBody.parse(req.body)));
  });
  v1.get('/plans/:planId', async (req, res) => {
    res.json(await svc.getPlan(accountOf(res), req.params.planId as string));
  });
  v1.patch('/plans/:planId', async (req, res) => {
    res.json(await svc.updatePlan(accountOf(res), req.params.planId as string, s.updatePlanBody.parse(req.body)));
  });

  v1.post('/users', async (req, res) => {
    const body = s.createUserBody.parse(req.body);
    res.status(201).json(await svc.createUser(accountOf(res), body.userId, body.planId));
  });
  v1.get('/users', async (req, res) => {
    const q = s.listUsersQuery.parse(req.query);
    res.json(await svc.listUsers(accountOf(res), q.limit, q.cursor));
  });
  v1.get('/users/:userId', async (req, res) => {
    res.json(await svc.getUser(accountOf(res), req.params.userId as string));
  });
  v1.put('/users/:userId/plan', async (req, res) => {
    const body = s.assignPlanBody.parse(req.body);
    res.json(await svc.setUserPlan(accountOf(res), req.params.userId as string, body.planId));
  });
  v1.get('/users/:userId/usage', async (req, res) => {
    const q = s.usageQuery.parse(req.query);
    res.json(await svc.getUserUsage(accountOf(res), req.params.userId as string, q.month));
  });

  v1.post('/consume', async (req, res) => {
    const { outcome, replayed } = await svc.consume(accountOf(res), s.consumeBody.parse(req.body));
    res.setHeader('Idempotent-Replayed', String(replayed));
    res.status(200).json({ ...outcome, replayed });
  });

  v1.get('/usage', async (req, res) => {
    const q = s.usageQuery.parse(req.query);
    res.json(await svc.getAccountUsage(accountOf(res), q.month));
  });
  v1.get('/usage/history', async (req, res) => {
    const q = s.usageHistoryQuery.parse(req.query);
    res.json(await svc.getUsageHistory(accountOf(res), q.userId));
  });

  v1.get('/requests', async (req, res) => {
    res.json(await svc.listRequests(accountOf(res), s.listRequestsQuery.parse(req.query)));
  });
  v1.get('/requests/:requestId', async (req, res) => {
    res.json(await svc.getRequest(accountOf(res), req.params.requestId as string));
  });

  app.use('/v1', v1);

  app.use((_req, _res) => {
    throw new ApiError(404, 'not_found', 'Route not found');
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    } else if (err instanceof ZodError) {
      res.status(400).json({
        error: {
          code: 'validation_error',
          message: 'Request validation failed',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
    } else if (isBodyParserError(err)) {
      res.status(400).json({ error: { code: 'invalid_json', message: 'Request body is not valid JSON' } });
    } else {
      console.error(err);
      res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } });
    }
  });

  return app;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function isBodyParserError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.parse.failed';
}
