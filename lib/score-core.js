import { computeCoactivityScoreFromRows } from "./score-math.js";

/**

 * Core v1 co-activity score (same logic as CLI score-window).

 *

 * @param {import("better-sqlite3").Database} db

 * @param {string} scope

 * @param {number} windowMinutes

 * @param {number} lastHours

 */

export function computeCoactivityScore(db, scope, windowMinutes, lastHours) {

  const cutoff = Math.floor(Date.now() / 1000) - lastHours * 3600;



  const rows = db

    .prepare(

      `

      SELECT fee_payer, block_time, programs_json, event_type

      FROM events

      WHERE scope_address = ?

        AND block_time IS NOT NULL

        AND block_time >= ?

        AND fee_payer IS NOT NULL

    `,

    )

    .all(scope, cutoff);



  return computeCoactivityScoreFromRows(rows, scope, windowMinutes, lastHours);

}



export { computeCoactivityScoreFromRows } from "./score-math.js";

