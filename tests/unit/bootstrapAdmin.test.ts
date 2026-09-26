import { describe, expect, it, vi } from "vitest";
import { parseAdminBootstrapConfiguration, runAdminBootstrap } from "../../scripts/bootstrapAdmin";

const valid = {
  DATABASE_URL: "postgresql://bootstrap_user:private@localhost:5432/barrels_test",
  ADMIN_BOOTSTRAP_ENABLED: "true",
  ADMIN_BOOTSTRAP_NAME: "  Initial Administrator  ",
  ADMIN_BOOTSTRAP_EMAIL: "  ADMIN@Example.COM ",
  ADMIN_BOOTSTRAP_PASSWORD: "  private password  ",
};

describe("V1-F5 administrator bootstrap input", () => {
  it.each([
    [{ ...valid, ADMIN_BOOTSTRAP_ENABLED: "false" }],
    [{ ...valid, ADMIN_BOOTSTRAP_NAME: undefined }],
    [{ ...valid, ADMIN_BOOTSTRAP_EMAIL: undefined }],
    [{ ...valid, ADMIN_BOOTSTRAP_PASSWORD: undefined }],
    [{ ...valid, ADMIN_BOOTSTRAP_EMAIL: "invalid" }],
    [{ ...valid, ADMIN_BOOTSTRAP_PASSWORD: "too-short" }],
  ])("rejects invalid input before creating a client", async (environment) => {
    const factory = vi.fn();
    await expect(runAdminBootstrap(environment, factory)).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
  });

  it("normalizes only safe fields and preserves password text", () => {
    expect(parseAdminBootstrapConfiguration(valid)).toMatchObject({
      name: "Initial Administrator",
      email: "admin@example.com",
      password: "  private password  ",
    });
  });

  it("never includes the password in validation errors", () => {
    const password = "private-value-that-must-not-print";
    expect(() => parseAdminBootstrapConfiguration({ ...valid, ADMIN_BOOTSTRAP_EMAIL: "bad", ADMIN_BOOTSTRAP_PASSWORD: password }))
      .toThrowError(expect.not.objectContaining({ message: expect.stringContaining(password) }));
  });
});
