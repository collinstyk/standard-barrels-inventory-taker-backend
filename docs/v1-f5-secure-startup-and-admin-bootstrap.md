# V1-F5 secure startup and administrator bootstrap

The application validates its configuration before creating a Prisma client, connecting to PostgreSQL, or opening the HTTP port. `DATABASE_URL` must be a PostgreSQL URL. `JWT_SECRET` must contain at least 32 characters and must not be an obvious placeholder. `JWT_EXPIRES_IN` defaults to `1d`, `PORT` defaults to `5000`, and `BUSINESS_TIME_ZONE` defaults to `Africa/Lagos`.

Production startup requires `INVENTORY_V2_ENABLED=true`. Development and tests may explicitly keep Inventory V2 disabled.

Public STAFF signup is disabled by default. Set `PUBLIC_SIGNUP_ENABLED=true` intentionally to enable `POST /api/v1/auth/signup`. No other value enables it, and public signup cannot select a privileged role.

## Initial administrator

The bootstrap is never run automatically during startup or deployment. Supply the following private environment variables for one invocation:

```text
ADMIN_BOOTSTRAP_ENABLED=true
ADMIN_BOOTSTRAP_NAME=<administrator name>
ADMIN_BOOTSTRAP_EMAIL=<administrator email>
ADMIN_BOOTSTRAP_PASSWORD=<private password of 12 to 128 characters>
```

Then run:

```text
pnpm run bootstrap:admin
```

The command refuses to connect unless its inputs are valid. It uses a transaction-scoped PostgreSQL advisory lock and refuses if any administrator already exists or the normalized email is already used. After success, remove `ADMIN_BOOTSTRAP_PASSWORD` from the environment and set `ADMIN_BOOTSTRAP_ENABLED=false`. The administrator can use the existing login endpoint; the command does not issue a token.

`prisma/seed.ts` is intentionally disabled and performs no database work. It directs developers to the explicit bootstrap command instead.
