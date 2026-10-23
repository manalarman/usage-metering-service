import { z } from 'zod';
import { MONTH_PATTERN } from '../time';

/** Upper bound for any unit quantity; keeps sums far below Number.MAX_SAFE_INTEGER. */
export const MAX_UNITS = 1_000_000_000_000;

const units = z.number().int().positive().max(MAX_UNITS);
const name = z.string().trim().min(1).max(100);
const identifier = z.string().min(1).max(200);
const planRef = z.string().min(1).max(100);
const scope = z.enum(['account', 'user']);
const month = z.string().regex(MONTH_PATTERN, 'must be a UTC month formatted YYYY-MM');
const limit = z.coerce.number().int().min(1).max(200).default(50);

export const createAccountBody = z.strictObject({
  name: z.string().trim().min(1).max(200),
  planId: planRef.optional(),
});

export const assignPlanBody = z.strictObject({ planId: planRef });

export const createPlanBody = z.strictObject({
  name,
  scope,
  monthlyAllowance: z.number().int().min(0).max(MAX_UNITS),
  maxUnitsPerRequest: units,
});

export const updatePlanBody = z
  .strictObject({
    name: name.optional(),
    monthlyAllowance: z.number().int().min(0).max(MAX_UNITS).optional(),
    maxUnitsPerRequest: units.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'at least one field must be provided');

export const listPlansQuery = z.object({ scope: scope.optional() });

export const createUserBody = z.strictObject({
  userId: identifier,
  planId: planRef.optional(),
});

export const listUsersQuery = z.object({ limit, cursor: identifier.optional() });

export const consumeBody = z.strictObject({
  userId: identifier,
  units,
  requestId: identifier,
});

export const usageQuery = z.object({ month: month.optional() });

export const usageHistoryQuery = z.object({ userId: identifier.optional() });

export const listRequestsQuery = z.object({
  limit,
  cursor: z.string().regex(/^\d{1,18}$/, 'invalid cursor').optional(),
  userId: identifier.optional(),
  decision: z.enum(['accepted', 'rejected']).optional(),
  month: month.optional(),
});
