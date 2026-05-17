import { createRequire } from "module";
const require = createRequire(import.meta.url);
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["@libsql/client", "libsql", "better-sqlite3"],
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.resolve.alias = {
        ...config.resolve.alias,
        libsql: path.resolve(__dirname, "lib/libsql-stub.js"),
      };
    }
    return config;
  },
};
export default nextConfig;
