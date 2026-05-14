/** Default per-request `focus` line for POST /api/groq-brief (dashboard + cron). See `lib/groq-brief-prompts.js` for prompt layering. */
export const GROQ_BRIEF_USER_FOCUS =
  "Every claim must tie to a field in Evidence (address, feePayer, or signature).";