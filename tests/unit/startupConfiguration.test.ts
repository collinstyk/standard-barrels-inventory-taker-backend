import { describe, expect, it } from "vitest";
import { parseStartupConfiguration } from "../../config/environment";

const valid = {
  DATABASE_URL: "postgresql://app_user:private_password@localhost:5432/barrels",
  JWT_SECRET: "a-secure-random-secret-that-is-over-32-characters",
  NODE_ENV: "test",
};

describe("V1-F5 startup configuration", () => {
  it.each([
    [{ ...valid, DATABASE_URL: undefined }, /DATABASE_URL/u],
    [{ ...valid, DATABASE_URL: "mysql://localhost/database" }, /PostgreSQL/u],
    [{ ...valid, JWT_SECRET: undefined }, /JWT_SECRET/u],
    [{ ...valid, JWT_SECRET: "short" }, /32/u],
    [{ ...valid, JWT_SECRET: "secret" }, /32|placeholder/u],
    [{ ...valid, JWT_SECRET: "replace-with-a-random-secret-at-least-32-characters" }, /placeholder/u],
    [{ ...valid, PORT: "0" }, /PORT/u],
    [{ ...valid, PORT: "5000.5" }, /PORT/u],
    [{ ...valid, BUSINESS_TIME_ZONE: "Not/A_Timezone" }, /BUSINESS_TIME_ZONE/u],
  ])("rejects invalid startup configuration", (environment, message) => {
    expect(() => parseStartupConfiguration(environment)).toThrow(message);
  });

  it("applies safe defaults and accepts a sufficiently long secret", () => {
    expect(parseStartupConfiguration(valid)).toMatchObject({
      port: 5000,
      jwtExpiresIn: "1d",
      businessTimeZone: "Africa/Lagos",
      publicSignupEnabled: false,
    });
  });

  it.each([undefined, "false", "1", "yes", "on", "anything"])("does not enable signup for %s", (value) => {
    expect(parseStartupConfiguration({ ...valid, PUBLIC_SIGNUP_ENABLED: value }).publicSignupEnabled).toBe(false);
  });

  it("enables signup only for explicit true", () => {
    expect(parseStartupConfiguration({ ...valid, PUBLIC_SIGNUP_ENABLED: " true " }).publicSignupEnabled).toBe(true);
  });

  it("requires Inventory V2 in production", () => {
    expect(() => parseStartupConfiguration({ ...valid, NODE_ENV: "production", INVENTORY_V2_ENABLED: "false" })).toThrow(/INVENTORY_V2_ENABLED/u);
    expect(parseStartupConfiguration({ ...valid, NODE_ENV: "production", INVENTORY_V2_ENABLED: "true" }).inventoryV2Enabled).toBe(true);
  });

  it("does not place credentials or secrets in validation errors", () => {
    const credential = "do-not-expose-this-password";
    const secret = "do-not-expose-this-jwt-secret-value-123456";
    for (const environment of [
      { ...valid, DATABASE_URL: `not-a-url:${credential}` },
      { ...valid, JWT_SECRET: secret, PORT: "invalid" },
    ]) {
      try { parseStartupConfiguration(environment); } catch (error) {
        expect(String(error)).not.toContain(credential);
        expect(String(error)).not.toContain(secret);
      }
    }
  });
});
