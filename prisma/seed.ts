export function explainDisabledSeed(): string {
  return "Database seeding is intentionally disabled. Use pnpm run bootstrap:admin for the one-time administrator bootstrap.";
}

const invokedPath = process.argv[1]?.replace(/\\/gu, "/");
const invokedDirectly = invokedPath?.endsWith("/prisma/seed.ts") || invokedPath?.endsWith("/prisma/seed.js");

if (invokedDirectly) {
  console.error(explainDisabledSeed());
  process.exitCode = 1;
}
