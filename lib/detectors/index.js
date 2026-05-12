import { detectWashTrading } from "./wash-trading.js";
import { detectCoordinatedAccumulation } from "./coordinated-accumulation.js";
import { detectSybilPump } from "./sybil-pump.js";
import { detectFeePayerConcentration } from "./fee-payer-concentration.js";

export {
  clamp01,
  defaultSlotWindow,
  fundedRecipientsFromGraph,
  fundersFromGraph,
  parseAmountBigInt,
  shortenAmountLabel,
  scopeMaxSlot,
  FUNDING_EDGE_TYPES,
} from "./shared.js";

/** @typedef {import("./shared.js").DetectorEvidence} DetectorEvidence */
/** @typedef {import("./shared.js").DetectorResult} DetectorResult */

export { detectWashTrading, detectCoordinatedAccumulation, detectSybilPump, detectFeePayerConcentration };

export default {
  detectWashTrading,
  detectCoordinatedAccumulation,
  detectSybilPump,
  detectFeePayerConcentration,
};
