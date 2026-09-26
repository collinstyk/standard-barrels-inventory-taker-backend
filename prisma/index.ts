import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import "dotenv/config";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

export const connectToDb = async () => {
  await prisma.$queryRaw`SELECT 1`;
  console.log("Successfully connected to the database.");
};

export const disconnectFromDb = async () => prisma.$disconnect();

export default prisma;
