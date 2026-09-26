import { z } from "zod";

export const cancelIssuedSaleSchema = z.object({
  reason: z.string().trim().min(3).max(1_000),
  custodyConfirmation: z.literal("GOODS_REMAIN_IN_BUSINESS_CUSTODY"),
}).strict();
