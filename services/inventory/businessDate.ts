import { InvalidTimeZoneError } from "./errors";
import type { BusinessDate } from "./types";

export const DEFAULT_BUSINESS_TIME_ZONE = "Africa/Lagos";

export function resolveBusinessTimeZone(value = process.env.BUSINESS_TIME_ZONE): string {
  const timeZone = value?.trim() || DEFAULT_BUSINESS_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(0));
  } catch {
    throw new InvalidTimeZoneError(timeZone);
  }
  return timeZone;
}

export function getBusinessDate(now = new Date(), configuredTimeZone?: string): BusinessDate {
  const timeZone = resolveBusinessTimeZone(configuredTimeZone);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}` as BusinessDate;
}

export function toPostgresDate(date: Date): BusinessDate {
  return date.toISOString().slice(0, 10) as BusinessDate;
}

export function isExpiryEligible(expiryDate: Date | null, businessToday: BusinessDate): boolean {
  return expiryDate === null || toPostgresDate(expiryDate) >= businessToday;
}
