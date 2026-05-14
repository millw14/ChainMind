/**
 * Well-known Solana program ids ChainMind uses for coarse event typing.
 * Extend as your scope focuses on specific venues.
 */
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** Sentinel `transfers.mint` / `edges.mint` for System Program lamport transfers (not an SPL mint). */
export const NATIVE_SOL_TRANSFER = "native_sol";

/** Routers / DEXs — presence implies swap_eligible (heuristic, not ground truth). */
export const SWAP_PROGRAM_HINTS = new Set([
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", // Jupiter v6
  "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB", // Jupiter v4
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium v4 AMM
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", // Orca Whirlpool
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", // Raydium CLMM
  "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXgcdBphkKGtKP", // Raydium swap
  "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY", // Phoenix
]);
