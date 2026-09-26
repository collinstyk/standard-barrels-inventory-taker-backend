import { describe, expect, it } from "vitest";
import { cancelIssuedSaleSchema } from "../../schemas/saleCancellationV2";

describe("issued-sale cancellation validation", () => {
  const valid = { reason: "Customer cancelled before dispatch", custodyConfirmation: "GOODS_REMAIN_IN_BUSINESS_CUSTODY" } as const;

  it("accepts only the explicit custody attestation", () => {
    expect(cancelIssuedSaleSchema.parse(valid)).toEqual(valid);
    expect(cancelIssuedSaleSchema.safeParse({ ...valid, custodyConfirmation: "yes" }).success).toBe(false);
  });

  it("rejects missing, blank, and unexpected fields", () => {
    expect(cancelIssuedSaleSchema.safeParse({ custodyConfirmation: valid.custodyConfirmation }).success).toBe(false);
    expect(cancelIssuedSaleSchema.safeParse({ ...valid, reason: "  " }).success).toBe(false);
    expect(cancelIssuedSaleSchema.safeParse({ ...valid, saleId: 1 }).success).toBe(false);
  });
});
