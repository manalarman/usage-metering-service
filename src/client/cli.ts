#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { ApiRequestError, UsageClient } from './api';
import { runDemo } from './demo';

const USAGE = `Usage Metering CLI

Environment: API_URL (default http://localhost:3000), API_KEY (account commands), ADMIN_TOKEN (demo, provision)

Commands:
  demo                                  Run the end-to-end demo (provisions a fresh account)
  provision <name> [planId]             Create an account and print its API key (needs ADMIN_TOKEN)
  account                               Show the account and its plan
  plans [account|user]                  List predefined + custom plans
  create-plan <account|user> <name> <monthlyAllowance> <maxUnitsPerRequest>
  update-plan <planId> <monthlyAllowance> [maxUnitsPerRequest]
  set-account-plan <planId>
  add-user <userId> [planId]
  set-user-plan <userId> <planId>
  consume <userId> <units> [requestId]  (requestId defaults to a random UUID)
  usage [userId] [YYYY-MM]
  history [userId] [limit] [cursor]
`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  const apiUrl = process.env.API_URL ?? 'http://localhost:3000';
  const client = new UsageClient(apiUrl, process.env.API_KEY, process.env.ADMIN_TOKEN);
  const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));
  const need = (n: number) => {
    if (args.length < n) throw new Error(`"${cmd}" needs ${n} argument(s)\n\n${USAGE}`);
  };

  switch (cmd) {
    case 'demo': {
      const report = await runDemo({ apiUrl, adminToken: process.env.ADMIN_TOKEN ?? '', log: console.log });
      return report.ok ? 0 : 1;
    }
    case 'provision':
      need(1);
      print(await client.provisionAccount(args[0], args[1]));
      return 0;
    case 'account':
      print(await client.getAccount());
      return 0;
    case 'plans':
      print(await client.listPlans(args[0] as 'account' | 'user' | undefined));
      return 0;
    case 'create-plan':
      need(4);
      print(
        await client.createPlan({
          scope: args[0] as 'account' | 'user',
          name: args[1],
          monthlyAllowance: Number(args[2]),
          maxUnitsPerRequest: Number(args[3]),
        }),
      );
      return 0;
    case 'update-plan':
      need(2);
      print(
        await client.updatePlan(args[0], {
          monthlyAllowance: Number(args[1]),
          ...(args[2] ? { maxUnitsPerRequest: Number(args[2]) } : {}),
        }),
      );
      return 0;
    case 'set-account-plan':
      need(1);
      print(await client.setAccountPlan(args[0]));
      return 0;
    case 'add-user':
      need(1);
      print(await client.createUser(args[0], args[1]));
      return 0;
    case 'set-user-plan':
      need(2);
      print(await client.setUserPlan(args[0], args[1]));
      return 0;
    case 'consume': {
      need(2);
      const r = await client.consume(args[0], Number(args[1]), args[2] ?? randomUUID());
      print(r);
      return r.accepted ? 0 : 2;
    }
    case 'usage':
      print(args[0] ? await client.userUsage(args[0], args[1]) : await client.accountUsage());
      return 0;
    case 'history':
      print(await client.history({ userId: args[0] || undefined, limit: args[1] ? Number(args[1]) : undefined, cursor: args[2] }));
      return 0;
    default:
      console.log(USAGE);
      return cmd ? 1 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof ApiRequestError) console.error(`API error ${err.status}:`, JSON.stringify(err.body, null, 2));
    else console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
