import { describe, expect, it } from "vitest";
import { validateTestDatabaseUrl } from "../../services/inventory/testDatabaseGuard";

describe("disposable PostgreSQL guard", () => {
  it("accepts an explicitly test-marked PostgreSQL database without exposing credentials", () => {
    const target = validateTestDatabaseUrl("postgresql://user:secret@localhost:5432/barrels_test", "postgresql://user:secret@localhost:5432/barrels");
    expect(target.displayName).toBe("localhost/barrels_test");
    expect(target.displayName).not.toContain("secret");
  });

  it.each([
    ["", undefined],
    ["postgresql://u:p@localhost/barrels", undefined],
    ["postgresql://u:p@localhost/barrels_test", "postgresql://u:p@localhost/barrels_test"],
    ["postgresql://u:p@localhost/barrels_production_test", undefined],
    ["mysql://u:p@localhost/barrels_test", undefined],
    ["postgresql://u:p@localhost/barrels_test", "not a database url"],
    ["postgresql://u:p@localhost/barrels?schema=integration_test", undefined],
  ])("rejects an unsafe target", (testUrl, appUrl) => {
    expect(() => validateTestDatabaseUrl(testUrl, appUrl)).toThrow();
  });

  it("rejects the same database when credentials differ", () => {
    expect(() => validateTestDatabaseUrl(
      "postgresql://test_user:test_password@LOCALHOST/barrels_test",
      "postgresql://app_user:app_password@localhost:5432/barrels_test",
    )).toThrow("completely different database");
  });

  it("rejects different schemas in the same database", () => {
    expect(() => validateTestDatabaseUrl(
      "postgresql://test_user@localhost/barrels_test?schema=isolated_test",
      "postgres://app_user@localhost:5432/barrels_test?schema=public",
    )).toThrow("completely different database");
  });
});
