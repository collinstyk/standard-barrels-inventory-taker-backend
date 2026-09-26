import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { createInitialAdministrator, runAdminBootstrap, type AdminBootstrapConfiguration } from "../../scripts/bootstrapAdmin";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { clearDisposableDatabase, createIntegrationHarness, type IntegrationHarness } from "./harness";
import { createPublicStaff } from "../../services/auth";

const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)("V1-F5 administrator bootstrap on disposable PostgreSQL", () => {
  let h: IntegrationHarness;
  beforeAll(async () => {
    h = createIntegrationHarness();
    await clearDisposableDatabase(h);
  }, 60_000);
  afterEach(async () => clearDisposableDatabase(h));
  afterAll(async () => h?.client.$disconnect());

  function configuration(email = "admin@example.com", password = "private-admin-password"): AdminBootstrapConfiguration {
    return { databaseUrl: h.target.connectionString, name: "Initial Admin", email, password };
  }

  it("creates exactly one ADMIN, stores only a matching bcrypt hash, disconnects, and creates no business data", async () => {
    const password = "private-admin-password";
    const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: h.target.connectionString }) });
    const disconnect = vi.spyOn(client, "$disconnect");
    const log = vi.fn();
    const result = await runAdminBootstrap({
      DATABASE_URL: h.target.connectionString,
      ADMIN_BOOTSTRAP_ENABLED: "true",
      ADMIN_BOOTSTRAP_NAME: " Initial Admin ",
      ADMIN_BOOTSTRAP_EMAIL: " ADMIN@Example.COM ",
      ADMIN_BOOTSTRAP_PASSWORD: password,
    }, async () => client, log);
    expect(result).toMatchObject({ role: "ADMIN", email: "admin@example.com" });
    expect(disconnect).toHaveBeenCalledOnce();
    const stored = await h.client.user.findUniqueOrThrow({ where: { email: "admin@example.com" } });
    expect(stored.password).not.toBe(password);
    expect(await bcrypt.compare(password, stored.password)).toBe(true);
    expect(log.mock.calls.flat().join(" ")).not.toContain(password);
    expect(await h.client.user.count({ where: { role: "ADMIN" } })).toBe(1);
    expect(await h.client.category.count()).toBe(0);
    expect(await h.client.product.count()).toBe(0);
    expect(await h.client.warehouse.count()).toBe(0);
    expect(await h.client.purchaseOrder.count()).toBe(0);
    expect(await h.client.saleOrder.count()).toBe(0);
    expect(await h.client.inventoryPosting.count()).toBe(0);
  });

  it("refuses without mutation when an administrator already exists", async () => {
    await createInitialAdministrator(h.client, configuration());
    await expect(createInitialAdministrator(h.client, configuration("second@example.com"))).rejects.toThrow(/already exists/u);
    expect(await h.client.user.count()).toBe(1);
  });

  it("refuses without mutation when the normalized email belongs to another user", async () => {
    await h.client.user.create({ data: { name: "Staff", email: "used@example.com", password: "hash", role: "STAFF" } });
    await expect(createInitialAdministrator(h.client, configuration("used@example.com"))).rejects.toThrow(/email is already in use/u);
    expect(await h.client.user.count()).toBe(1);
    expect(await h.client.user.count({ where: { role: "ADMIN" } })).toBe(0);
  });

  it("serializes concurrent attempts so exactly one administrator is created", async () => {
    const suffix = randomUUID();
    const outcomes = await Promise.allSettled([
      createInitialAdministrator(h.client, configuration(`first-${suffix}@example.com`)),
      createInitialAdministrator(h.client, configuration(`second-${suffix}@example.com`)),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(await h.client.user.count({ where: { role: "ADMIN" } })).toBe(1);
  });

  it("public staff creation cannot persist a caller-supplied privileged role", async () => {
    const user = await createPublicStaff(h.client, {
      name: "Public User",
      email: " PUBLIC@Example.COM ",
      password: "public-password",
      role: "ADMIN",
    } as Parameters<typeof createPublicStaff>[1] & { role: "ADMIN" });
    expect(user).toMatchObject({ email: "public@example.com", role: "STAFF" });
    expect(await h.client.user.count({ where: { role: "ADMIN" } })).toBe(0);
  });
});
