import "dotenv/config";
import { runAdminBootstrap } from "./bootstrapAdmin";

void runAdminBootstrap().catch((e) => {
  console.log(e.message);
  
  console.error("Administrator bootstrap refused or failed safely.");
  process.exitCode = 1;
});
