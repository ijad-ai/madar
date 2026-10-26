# config

**Phase 0, extended in Phase 1.** Typed environment config validated with Zod. Every variable is documented in `.env.example`.

```ts
import { loadConfigFromProcess, requireRole, describeConfig } from './config/index.js';

const config = loadConfigFromProcess(); // reads .env if present; real env vars win
requireRole(config, 'worker'); // lists every missing variable this role needs
logger.info({ config: describeConfig(config) }, 'starting'); // secrets show as set or unset
```

- Errors name the variable and the rule, never the value.
- Empty strings count as unset.
- Production requires `rediss://` and a Postgres `sslmode` of `require` or stricter, and refuses `SLACK_API_URL`.
- Add a variable in `env.ts` and `.env.example` together; a test fails if they drift.
