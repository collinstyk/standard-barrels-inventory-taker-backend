import jwt, { type SignOptions } from "jsonwebtoken";
import { resolveBusinessTimeZone } from "../services/inventory/businessDate";
import { isInventoryV2Enabled } from "../services/inventory/featureFlag";

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export type Environment = Record<string, string | undefined>;

export interface StartupConfiguration {
  databaseUrl: string;
  jwtSecret: string;
  jwtExpiresIn: SignOptions["expiresIn"];
  port: number;
  businessTimeZone: string;
  inventoryV2Enabled: boolean;
  publicSignupEnabled: boolean;
  nodeEnv: string;
}

const PLACEHOLDER_SECRETS = new Set([
  "change-me",
  "changeme",
  "secret",
  "test-secret",
  "your-secret",
  "replace-me",
]);

export function isExplicitTrue(value: string | undefined): boolean {  
  return value?.trim().toLowerCase() === "true";
}

export function validatePostgresDatabaseUrl(value: string | undefined): string {
  if (!value?.trim()) throw new ConfigurationError("DATABASE_URL is required.");
  const normalized = value.trim();
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
      throw new ConfigurationError("DATABASE_URL must use PostgreSQL.");
    }
    if (!parsed.hostname || !parsed.pathname || parsed.pathname === "/") {
      throw new ConfigurationError("DATABASE_URL is not a valid PostgreSQL database target.");
    }
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError("DATABASE_URL is not a valid PostgreSQL URL.");
  }
  return normalized;
}

function parseJwtSecret(value: string | undefined): string {
  if (!value?.trim()) throw new ConfigurationError("JWT_SECRET is required.");
  if (value.trim().length < 32) throw new ConfigurationError("JWT_SECRET must contain at least 32 characters.");
  const normalized = value.trim().toLowerCase();
  if (PLACEHOLDER_SECRETS.has(normalized)
    || /^(?:replace|change|your|test)[-_ ]/u.test(normalized)) {
    throw new ConfigurationError("JWT_SECRET must not be a placeholder.");
  }
  return value;
}

function parseJwtExpiry(value: string | undefined): SignOptions["expiresIn"] {
  if (value === undefined) return "1d";
  if (!value.trim()) throw new ConfigurationError("JWT_EXPIRES_IN must not be empty.");
  try {
    jwt.sign({}, "x".repeat(32), { expiresIn: value as SignOptions["expiresIn"] });
  } catch {
    throw new ConfigurationError("JWT_EXPIRES_IN is malformed.");
  }
  return value as SignOptions["expiresIn"];
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 5000;
  if (!/^\d+$/u.test(value)) throw new ConfigurationError("PORT must be an integer from 1 through 65535.");
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigurationError("PORT must be an integer from 1 through 65535.");
  }
  return port;
}

export function parseStartupConfiguration(env: Environment = process.env): StartupConfiguration {
  const nodeEnv = env.NODE_ENV?.trim() || "development";
  const inventoryV2Enabled = isInventoryV2Enabled(env.INVENTORY_V2_ENABLED);
  if (nodeEnv === "production" && !inventoryV2Enabled) {
    throw new ConfigurationError("INVENTORY_V2_ENABLED=true is required in production.");
  }

  let businessTimeZone: string;
  try {
    businessTimeZone = resolveBusinessTimeZone(env.BUSINESS_TIME_ZONE);
  } catch {
    throw new ConfigurationError("BUSINESS_TIME_ZONE must be a valid IANA timezone.");
  }

  return {
    databaseUrl: validatePostgresDatabaseUrl(env.DATABASE_URL),
    jwtSecret: parseJwtSecret(env.JWT_SECRET),
    jwtExpiresIn: parseJwtExpiry(env.JWT_EXPIRES_IN),
    port: parsePort(env.PORT),
    businessTimeZone,
    inventoryV2Enabled,
    publicSignupEnabled: isExplicitTrue(env.PUBLIC_SIGNUP_ENABLED),
    nodeEnv,
  };
}

export function isPublicSignupEnabled(env: Environment = process.env): boolean {
  return isExplicitTrue(env.PUBLIC_SIGNUP_ENABLED);
}
