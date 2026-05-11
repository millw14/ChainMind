import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Load secrets and config. Precedence: .env.local overrides .env.
 */
export function loadEnv(cwd = process.cwd()) {
  const envPath = resolve(cwd, ".env");
  const localPath = resolve(cwd, ".env.local");
  dotenv.config({ path: envPath });
  if (existsSync(localPath)) {
    dotenv.config({ path: localPath, override: true });
  }
}
