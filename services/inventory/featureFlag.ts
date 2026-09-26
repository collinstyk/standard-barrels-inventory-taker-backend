export function isInventoryV2Enabled(value = process.env.INVENTORY_V2_ENABLED): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return false;
}
