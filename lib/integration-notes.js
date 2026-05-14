/**
 * INTEGRATION NOTES
 * =================
 * Two things to add to your existing Dashboard.jsx.
 * Nothing in groq-brief/route.js needs to change.
 *
 * ─────────────────────────────────────────────
 * 1. Add WalletTable to Dashboard.jsx
 * ─────────────────────────────────────────────
 *
 * At the top of Dashboard.jsx, add:
 *
 *   import { useRef } from "react";
 *   import WalletTable from "@/components/dashboard/WalletTable";
 *
 * Add a ref near your other state:
 *
 *   const walletTableRef = useRef(null);
 *
 * Add the panel in your JSX — place it after the Scope graph panel,
 * before Activity density. It slots into the existing panel markup style:
 *
 *   <div className="panel-row" id="evidence">   // or whatever wrapper you use
 *     <div className="panel-label">Evidence</div>
 *     <h2>Wallet table</h2>
 *     <p className="panel-description">
 *       Ranked by coordination involvement · click a row for funding links
 *     </p>
 *     <WalletTable
 *       ref={walletTableRef}
 *       scope={watchTarget}       // your existing watch target state var
 *       lookback={lookbackHours}  // your existing lookback state var
 *     />
 *   </div>
 *
 *
 * ─────────────────────────────────────────────
 * 2. Merge wallet evidence into groq-brief POST
 * ─────────────────────────────────────────────
 *
 * groq-brief/route.js already spreads whatever object you POST as `data`
 * into the evidence payload via buildGroqUserEvidence(data). So you just
 * need to merge the wallet table data into the object you send.
 *
 * Find wherever Dashboard.jsx builds the groq-brief POST body (look for
 * the fetch to /api/groq-brief) and add walletEvidence:
 *
 *   // Before the POST:
 *   const walletEvidence = walletTableRef.current?.getRawEvidence();
 *
 *   // In your existing POST body:
 *   const groqData = {
 *     ...existingScorePayload,       // whatever you already send as `data`
 *     walletEvidence: walletEvidence ?? null,
 *   };
 *
 *   await fetch("/api/groq-brief", {
 *     method: "POST",
 *     headers: { "Content-Type": "application/json" },
 *     body: JSON.stringify({ data: groqData, focus, source }),
 *   });
 *
 * buildGroqUserEvidence will pass walletEvidence through into the Groq
 * prompt automatically — no changes needed to groq-brief/route.js,
 * groq-evidence.js, or groq-user-evidence.js.
 *
 * If you want Groq to specifically reason about the wallet table and
 * shared funders (cite tx sigs, name wallet pairs), add a note to
 * GROQ_BRIEF_SYSTEM_PROMPT in groq-brief-prompts.js:
 *
 *   "If walletEvidence is present in the snapshot, cite specific wallet
 *    addresses from walletEvidence.wallets and shared funders from
 *    walletEvidence.shared_funders in your reasoning. Reference funding
 *    tx signatures directly."
 *
 *
 * ─────────────────────────────────────────────
 * 3. Test the endpoint before wiring the UI
 * ─────────────────────────────────────────────
 *
 *   curl "http://localhost:3000/api/evidence?scope=<your_test_address>&lookback=24"
 *
 * Expected shape:
 *   {
 *     scope, generated_at, lookback_h,
 *     summary: { total_events, coordinated_events, total_wallets,
 *                flagged_wallets, shared_funder_clusters, edges_found },
 *     timeline: [...],
 *     wallets: [...],
 *     edges: [...],
 *     shared_funders: [...]
 *   }
 *
 * If you get { error: "Database unavailable" } — run the pipeline first:
 *   npm run ingest-events -- <address>
 */

export {};
