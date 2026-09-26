export interface SafeTestDatabaseTarget {
  connectionString: string;
  host: string;
  database: string;
  schema: string | null;
  displayName: string;
}

interface DatabaseIdentity {
  protocol: string;
  host: string;
  port: string;
  database: string;
}

function parseDatabaseUrl(value: string, variableName: string): { url: URL; identity: DatabaseIdentity } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variableName} must be a valid PostgreSQL URL.`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${variableName} must use PostgreSQL.`);
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  if (!database) throw new Error(`${variableName} must identify a database.`);
  return {
    url,
    identity: {
      protocol: "postgresql:",
      host: url.hostname.toLowerCase(),
      port: url.port || "5432",
      database,
    },
  };
}

export function validateTestDatabaseUrl(
  testDatabaseUrl = process.env.TEST_DATABASE_URL,
  applicationDatabaseUrl = process.env.DATABASE_URL,
): SafeTestDatabaseTarget {
  if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required for PostgreSQL integration tests.");
  const { url, identity } = parseDatabaseUrl(testDatabaseUrl, "TEST_DATABASE_URL");
  const { database } = identity;
  const schema = url.searchParams.get("schema");
  if (applicationDatabaseUrl) {
    const application = parseDatabaseUrl(applicationDatabaseUrl, "DATABASE_URL");
    const sameDatabase = application.identity.protocol === identity.protocol
      && application.identity.host === identity.host
      && application.identity.port === identity.port
      && application.identity.database === identity.database;
    if (sameDatabase) {
      throw new Error("TEST_DATABASE_URL must identify a completely different database from DATABASE_URL.");
    }
  }
  const databaseMarker = database.toLowerCase();
  if (!databaseMarker.includes("test")) {
    throw new Error("The integration database name must contain the marker 'test'.");
  }
  if (/(?:^|[^a-z])prod(?:uction)?(?:[^a-z]|$)/u.test(databaseMarker)) {
    throw new Error("Production-marked databases are forbidden for integration tests.");
  }

  return {
    connectionString: testDatabaseUrl,
    host: identity.host,
    database,
    schema,
    displayName: `${url.hostname}/${database}${schema ? `?schema=${schema}` : ""}`,
  };
}
