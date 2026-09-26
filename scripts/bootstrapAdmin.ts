import bcrypt from "bcryptjs";
import { Prisma, type PrismaClient } from "../generated/prisma/client";
import { isExplicitTrue, type Environment, validatePostgresDatabaseUrl } from "../config/environment";
import { z } from "zod";

const ADVISORY_LOCK_KEY = 1_742_025_001;

export class AdminBootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminBootstrapError";
  }
}

export interface AdminBootstrapConfiguration {
  databaseUrl: string;
  name: string;
  email: string;
  password: string;
}

const bootstrapInputSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(12).max(128),
}).strict();

export function parseAdminBootstrapConfiguration(env: Environment = process.env): AdminBootstrapConfiguration {
  if (!isExplicitTrue(env.ADMIN_BOOTSTRAP_ENABLED)) {
    throw new AdminBootstrapError("Administrator bootstrap is disabled.");
  }
  const parsed = bootstrapInputSchema.safeParse({
    name: env.ADMIN_BOOTSTRAP_NAME,
    email: env.ADMIN_BOOTSTRAP_EMAIL,
    password: env.ADMIN_BOOTSTRAP_PASSWORD,
  });
  if (!parsed.success) throw new AdminBootstrapError("Administrator bootstrap input is invalid.");
  let databaseUrl: string;
  try {
    databaseUrl = validatePostgresDatabaseUrl(env.DATABASE_URL);
  } catch {
    throw new AdminBootstrapError("Administrator bootstrap database configuration is invalid.");
  }
  return { databaseUrl, ...parsed.data };
}

export async function createInitialAdministrator(
  db: PrismaClient,
  configuration: AdminBootstrapConfiguration,
) {
  
  const passwordHash = await bcrypt.hash(configuration.password, 12);

  return db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      SELECT 1 AS "lockAcquired"
      FROM (SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})) AS bootstrap_lock
    `);

    const existingAdministrator = await tx.user.findFirst({ where: { role: "ADMIN" }, select: { id: true } });
    if (existingAdministrator) throw new AdminBootstrapError("An administrator already exists.");

    const existingEmail = await tx.user.findUnique({ where: { email: configuration.email }, select: { id: true } });
    if (existingEmail) throw new AdminBootstrapError("The administrator email is already in use.");

    return tx.user.create({
      data: {
        name: configuration.name,
        email: configuration.email,
        password: passwordHash,
        role: "ADMIN",
      },
      select: { id: true, name: true, email: true, role: true },
    });
  });
}

type BootstrapClientFactory = (databaseUrl: string) => Promise<PrismaClient>;
type SafeLogger = (message: string) => void;

async function defaultClientFactory(databaseUrl: string): Promise<PrismaClient> {
  const [{ PrismaClient }, { PrismaPg }] = await Promise.all([
    import("../generated/prisma/client"),
    import("@prisma/adapter-pg"),
  ]);
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}

export async function runAdminBootstrap(
  env: Environment = process.env,
  createClient: BootstrapClientFactory = defaultClientFactory,
  log: SafeLogger = console.log,
) {
  const configuration = parseAdminBootstrapConfiguration(env);
  const client = await createClient(configuration.databaseUrl);
  try {
    const administrator = await createInitialAdministrator(client, configuration);
    log(`Administrator created: ${administrator.id}`);
    log(`Name: ${administrator.name}`);
    log(`Email: ${administrator.email}`);
    log(`Role: ${administrator.role}`);
    log("Remove ADMIN_BOOTSTRAP_PASSWORD and set ADMIN_BOOTSTRAP_ENABLED=false now.");
    return administrator;
  } finally {
    await client.$disconnect();
  }
}
