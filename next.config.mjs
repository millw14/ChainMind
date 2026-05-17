/** @type {import('next').NextConfig} */
const nextConfig = {
  // Solana web3 and bigint in JSON — keep default node runtime on routes that need it
  serverExternalPackages: ["@libsql/client", "libsql", "better-sqlite3"],
};

export default nextConfig;
