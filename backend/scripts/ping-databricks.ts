// Run with: npm run check:databricks
// Sends one tiny prompt to your Databricks endpoint to prove the credentials work.
import { assertDatabricksConfig, config } from "../src/config";
import { callDatabricks } from "../src/databricks";

try {
  assertDatabricksConfig();
  console.log(`Calling endpoint "${config.databricksEndpoint}" at ${config.databricksHost} ...`);
  const reply = await callDatabricks([{ role: "user", content: "Reply with just the word OK." }]);
  console.log(`Success. Model replied: ${reply.trim().slice(0, 100)}`);
} catch (err) {
  console.error(`Failed: ${(err as Error).message}`);
  process.exit(1);
}
