# Prisma + Express + Bun: Start to Production

A complete guide to building, testing, containerizing, and deploying a REST API with Bun, Express, Prisma, and PostgreSQL.

## 1. What You'll Build

A small users/posts API with:

- Bun as runtime, package manager, and test runner (TypeScript runs directly, no build step)
- Express 5 for HTTP
- Prisma 7 with the PostgreSQL driver adapter
- Zod for env and request validation
- Security middleware, structured logging, health checks, and graceful shutdown
- Docker, Docker Compose, and a GitHub Actions CI pipeline

## 2. Prerequisites

- Bun 1.2 or newer (`curl -fsSL https://bun.sh/install | bash`)
- Docker (for local Postgres and container builds)
- Basic TypeScript knowledge

Check your install:

```bash
bun --version
docker --version
```

## 3. Create the Project

```bash
mkdir my-api && cd my-api
bun init -y

# runtime dependencies
bun add express @prisma/client @prisma/adapter-pg pg dotenv zod helmet cors express-rate-limit pino pino-http

# dev dependencies
bun add -d prisma typescript @types/express @types/pg @types/node @types/cors
```

Set `tsconfig.json` to something Bun and Prisma are happy with:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["bun", "node"]
  },
  "include": ["src", "prisma.config.ts"]
}
```

Add `bun-types` if your editor can't find the Bun types:

```bash
bun add -d @types/bun
```

## 4. Start Postgres Locally

Create `docker-compose.dev.yml`:

```yaml
services:
  db:
    image: postgres:17
    ports: ["5432:5432"]
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: mydb
    volumes: [pgdata:/var/lib/postgresql/data]
volumes:
  pgdata:
```

```bash
docker compose -f docker-compose.dev.yml up -d
```

## 5. Set Up Prisma

```bash
bunx --bun prisma init --datasource-provider postgresql --output ../generated/prisma
```

This creates `prisma/schema.prisma`, `prisma.config.ts`, and `.env`. Set the connection string in `.env`:

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/mydb"
NODE_ENV="development"
PORT=3000
```

The generated `prisma.config.ts` should look like this (Prisma 7 reads the database URL here rather than from the schema):

```ts
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: env("DATABASE_URL") },
});
```

Define your models in `prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client"
  output   = "../generated/prisma"
}

datasource db {
  provider = "postgresql"
}

model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  name      String?
  posts     Post[]
  createdAt DateTime @default(now())
}

model Post {
  id        Int      @id @default(autoincrement())
  title     String
  content   String?
  published Boolean  @default(false)
  author    User     @relation(fields: [authorId], references: [id], onDelete: Cascade)
  authorId  Int
  createdAt DateTime @default(now())

  @@index([authorId])
}
```

Create the first migration. This also generates the client:

```bash
bunx --bun prisma migrate dev --name init
```

Commit the `prisma/migrations` folder. Add `generated/` and `.env` to `.gitignore`.

## 6. Project Structure

```
my-api/
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── src/
│   ├── config.ts
│   ├── lib/
│   │   └── prisma.ts
│   ├── middleware/
│   │   └── validate.ts
│   ├── routes/
│   │   └── users.ts
│   ├── app.ts
│   └── index.ts
├── tests/
│   └── users.test.ts
├── prisma.config.ts
├── Dockerfile
├── docker-compose.yml
└── package.json
```

## 7. Configuration

Validate environment variables at startup so a bad deploy fails immediately instead of at the first request.

`src/config.ts`:

```ts
import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url(),
  CORS_ORIGIN: z.string().default("*"),
  DB_POOL_MAX: z.coerce.number().default(10),
});

export const config = schema.parse(process.env);
```

## 8. Prisma Client

Prisma 7 requires a driver adapter. The adapter owns the connection pool, so set its size explicitly.

`src/lib/prisma.ts`:

```ts
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { config } from "../config";

const adapter = new PrismaPg({
  connectionString: config.DATABASE_URL,
  max: config.DB_POOL_MAX,
});

export const prisma = new PrismaClient({ adapter });
```

Size the pool so that `replicas × DB_POOL_MAX` stays below your database's connection limit.

## 9. Validation Middleware

`src/middleware/validate.ts`:

```ts
import type { RequestHandler } from "express";
import type { ZodType } from "zod";

export const validateBody =
  <T>(schema: ZodType<T>): RequestHandler =>
  (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({ error: "Invalid request", issues: result.error.issues });
      return;
    }
    req.body = result.data;
    next();
  };
```

## 10. Routes

`src/routes/users.ts`:

```ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { validateBody } from "../middleware/validate";

const createUser = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100).optional(),
});
const updateUser = createUser.partial();

const prismaCode = (e: unknown) => (e as { code?: string })?.code;

export const users = Router();

users.get("/", async (req, res) => {
  const take = Math.min(Number(req.query.take) || 20, 100);
  const skip = Number(req.query.skip) || 0;
  const data = await prisma.user.findMany({
    take,
    skip,
    orderBy: { id: "asc" },
  });
  res.json(data);
});

users.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });

  const user = await prisma.user.findUnique({
    where: { id },
    include: { posts: true },
  });
  if (!user) return res.status(404).json({ error: "Not found" });
  res.json(user);
});

users.post("/", validateBody(createUser), async (req, res) => {
  try {
    const user = await prisma.user.create({ data: req.body });
    res.status(201).json(user);
  } catch (e) {
    if (prismaCode(e) === "P2002") {
      return res.status(409).json({ error: "Email already exists" });
    }
    throw e;
  }
});

users.patch("/:id", validateBody(updateUser), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const user = await prisma.user.update({ where: { id }, data: req.body });
    res.json(user);
  } catch (e) {
    if (prismaCode(e) === "P2025") return res.status(404).json({ error: "Not found" });
    if (prismaCode(e) === "P2002") return res.status(409).json({ error: "Email already exists" });
    throw e;
  }
});

users.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    await prisma.user.delete({ where: { id } });
    res.status(204).end();
  } catch (e) {
    if (prismaCode(e) === "P2025") return res.status(404).json({ error: "Not found" });
    throw e;
  }
});
```

Express 5 forwards errors from async handlers to your error middleware automatically, so you don't need try/catch wrappers except where you want to map specific errors (like the Prisma codes above).

## 11. The App

Keep the app separate from the server so tests can import it without binding a port.

`src/app.ts`:

```ts
import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import pino from "pino";
import pinoHttp from "pino-http";
import { config } from "./config";
import { prisma } from "./lib/prisma";
import { users } from "./routes/users";

export const logger = pino({
  level: config.NODE_ENV === "production" ? "info" : "debug",
});

export const app = express();

app.set("trust proxy", 1); // we're behind a load balancer in production
app.disable("x-powered-by");
app.use(helmet());
app.use(cors({ origin: config.CORS_ORIGIN }));
app.use(pinoHttp({ logger }));
app.use(express.json({ limit: "100kb" }));
app.use(rateLimit({ windowMs: 60_000, limit: 100 }));

// Liveness: is the process up?
app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

// Readiness: can we reach the database?
app.get("/readyz", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ready" });
  } catch {
    res.status(503).json({ status: "db unavailable" });
  }
});

app.use("/users", users);

app.use((_req, res) => res.status(404).json({ error: "Not found" }));

const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  req.log.error(err);
  res.status(500).json({ error: "Internal server error" }); // never leak internals
};
app.use(errorHandler);
```

## 12. Entry Point and Graceful Shutdown

Orchestrators send SIGTERM before killing a container. Stop accepting connections, let in-flight requests finish, then close the database pool.

`src/index.ts`:

```ts
import { app, logger } from "./app";
import { config } from "./config";
import { prisma } from "./lib/prisma";

const server = app.listen(config.PORT, () =>
  logger.info(`Listening on :${config.PORT}`)
);

function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref(); // force exit if stuck
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
```

Add scripts to `package.json`:

```json
"scripts": {
  "dev": "bun --watch src/index.ts",
  "start": "bun src/index.ts",
  "test": "bun test",
  "typecheck": "tsc --noEmit",
  "db:migrate": "prisma migrate dev",
  "db:deploy": "prisma migrate deploy",
  "db:generate": "prisma generate"
}
```

Run it:

```bash
bun run dev
```

Try it:

```bash
curl -X POST localhost:3000/users \
  -H "Content-Type: application/json" \
  -d '{"email":"ada@example.com","name":"Ada"}'

curl localhost:3000/users
curl localhost:3000/readyz
```

## 13. Testing

Bun ships with a test runner, so no extra framework is needed. Tests hit a real database, which catches far more than mocks do. Use a separate database for tests so they never touch your dev data.

Create the test database once:

```bash
docker compose -f docker-compose.dev.yml exec db createdb -U postgres mydb_test
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/mydb_test" bunx --bun prisma migrate deploy
```

`tests/users.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";

let server: Server;
let base: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve); // port 0 = random free port
  });
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await prisma.user.deleteMany();
});

afterAll(async () => {
  server.close();
  await prisma.$disconnect();
});

const json = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("users", () => {
  test("creates and fetches a user", async () => {
    const created = await fetch(`${base}/users`, json({ email: "a@b.com", name: "Ada" }));
    expect(created.status).toBe(201);
    const user = await created.json();

    const fetched = await fetch(`${base}/users/${user.id}`);
    expect(fetched.status).toBe(200);
    expect((await fetched.json()).email).toBe("a@b.com");
  });

  test("rejects invalid email", async () => {
    const res = await fetch(`${base}/users`, json({ email: "nope" }));
    expect(res.status).toBe(400);
  });

  test("returns 409 on duplicate email", async () => {
    await fetch(`${base}/users`, json({ email: "a@b.com" }));
    const res = await fetch(`${base}/users`, json({ email: "a@b.com" }));
    expect(res.status).toBe(409);
  });

  test("returns 404 for missing user", async () => {
    const res = await fetch(`${base}/users/999999`);
    expect(res.status).toBe(404);
  });
});
```

Run against the test database:

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/mydb_test" bun test
```

Bun does not auto-load `.env` over an explicitly set variable, so passing `DATABASE_URL` inline like this takes priority.

## 14. Containerize

`Dockerfile`:

```dockerfile
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1 AS app
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Dummy URL only so prisma.config.ts can load during generate
RUN DATABASE_URL="postgresql://x:x@localhost:5432/x" bunx --bun prisma generate
USER bun
EXPOSE 3000
CMD ["bun", "src/index.ts"]
```

`.dockerignore`:

```
node_modules
.env
.git
generated
tests
```

The Prisma CLI stays in the image so the same image can run migrations. Bun executes TypeScript directly, so there is no compile step.

## 15. Run a Production-Like Stack Locally

`docker-compose.yml`:

```yaml
services:
  db:
    image: postgres:17
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: mydb
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      retries: 5

  migrate:
    build: .
    command: bunx --bun prisma migrate deploy
    environment:
      DATABASE_URL: postgresql://postgres:postgres@db:5432/mydb
    depends_on:
      db: { condition: service_healthy }

  api:
    build: .
    ports: ["3000:3000"]
    environment:
      NODE_ENV: production
      DATABASE_URL: postgresql://postgres:postgres@db:5432/mydb
    depends_on:
      migrate: { condition: service_completed_successfully }

volumes:
  pgdata:
```

```bash
docker compose up --build
```

The `migrate` service runs once and exits, and the `api` service only starts after it succeeds. This mirrors how production should work.

## 16. Migrations in Production

Two commands, two environments:

- `prisma migrate dev` is for local development. It can prompt, create migrations, and reset the database.
- `prisma migrate deploy` is for staging and production. It only applies migrations that already exist in your repo, and never resets anything.

Rules that keep deploys safe:

1. Run `migrate deploy` once per release, as a separate CI/CD step or one-off job, before the new version starts. Don't put it in the container `CMD` if you run multiple replicas, because they will race each other.
2. Make migrations backward-compatible so old and new code can run side by side during a rolling deploy. Add a column before the code uses it, and drop it in a later release.
3. Never edit a migration that has already been applied anywhere. Create a new one.
4. Back up the database before risky migrations (large table rewrites, column type changes).

## 17. Continuous Integration

`.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17
        env:
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: mydb_test
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s
          --health-retries 5
    env:
      DATABASE_URL: postgresql://postgres:postgres@localhost:5432/mydb_test
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bunx --bun prisma validate
      - run: bunx --bun prisma generate
      - run: bunx --bun prisma migrate deploy
      - run: bun run typecheck
      - run: bun test

  docker:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: docker build -t my-api:${{ github.sha }} .
```

From here, add a step that pushes the image to your registry (GHCR, ECR, Docker Hub) and triggers your platform's deploy. The exact step depends on where you host.

## 18. Deployment Notes

The app is a standard container with HTTP health endpoints, so it runs almost anywhere. The shape is the same on every platform:

1. Build and push the image.
2. Run `bunx --bun prisma migrate deploy` as a release command or one-off task using that image.
3. Roll out the new containers, with liveness on `/healthz` and readiness on `/readyz`.

Platform hints:

- **Fly.io, Railway, Render:** set the release/pre-deploy command to the migrate command, and set `DATABASE_URL` as a secret.
- **AWS ECS:** run migrations as a one-off task from the same task definition before updating the service.
- **Kubernetes:** run migrations as a Job or Helm pre-upgrade hook, and configure probes against the two health endpoints.
- **A single VPS:** `docker compose` with a reverse proxy such as Caddy or Nginx for TLS works fine at small scale.

## 19. Production Checklist

- Secrets come from your platform's secret manager and are never baked into the image
- `CORS_ORIGIN` is set to your real frontend origin, not `*`
- Managed Postgres with automated backups and a tested restore
- A connection pooler (such as PgBouncer) if you run many replicas or serverless instances
- `DB_POOL_MAX × replicas` is under the database connection limit
- Logs shipped from pino's JSON output to a log platform
- Error tracking (such as Sentry) and uptime monitoring on `/readyz`
- Rate limiting tuned to your traffic, with a shared store (such as Redis) if you run more than one replica
- Authentication and authorization added before exposing anything private
- CI blocks merges unless typecheck and tests pass

## 20. Troubleshooting

**`Cannot find module '../../generated/prisma/client'`** The client hasn't been generated. Run `bunx --bun prisma generate`, and make sure your Dockerfile runs it.

**`DATABASE_URL` is missing or invalid at startup** The Zod config check is doing its job. Confirm the variable is set in the environment where the process runs, and that it is a full URL.

**`prisma generate` fails in Docker build** `prisma.config.ts` reads `DATABASE_URL` while loading. Pass a dummy value for that one command, as shown in the Dockerfile.

**Too many connections** Lower `DB_POOL_MAX`, reduce replicas, or add a pooler. Remember that every replica holds its own pool.

**Migration drift or `P3009` errors** A previous migration failed partway. Inspect `_prisma_migrations`, fix the database state, and resolve it with `prisma migrate resolve`. Avoid doing this without a backup.

**Using SQLite instead of Postgres** Swap the adapter for `@prisma/adapter-libsql` (`PrismaLibSql`), since `better-sqlite3` doesn't work under Bun. Change the datasource provider to `sqlite` and update the connection URL.

## 21. Where to Go Next

- Add authentication (sessions or JWT) and per-route authorization
- Add a Post router following the same pattern as users
- Add OpenAPI docs generated from your Zod schemas
- Add background jobs and a queue if you need async work
- Read the Prisma docs on Prisma Config, driver adapters, and connection management
