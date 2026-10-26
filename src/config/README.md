# config

**Phase 0 (built).** Typed environment config validated with Zod.

```ts
import { loadConfigFromProcess, describeConfig } from './config/index.js';

const config = loadConfigFromProcess(); // reads .env if present; real env vars win
logger.info({ config: describeConfig(config) }, 'starting'); // passwords masked
```

- Errors name the variable and the rule, never the value.
- Empty strings count as unset.
- Production requires `rediss://` and a Postgres `sslmode` of `require` or stricter.
- Add a variable in `env.ts` and `.env.example` together; a test fails if they drift.
