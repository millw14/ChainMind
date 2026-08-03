import { AskChat } from "@/components/ask/AskChat";

export const metadata = {
  // Short, because the (app) layout now appends "· ChainMind". The old standalone
  // string would render "Ask — Robinhood Chain AI explorer · ChainMind", which says the
  // product name twice and truncates in a tab.
  title: "Ask",
  description:
    "Ask about a ticker, a ranking, two stocks side by side, or any 0x address on Robinhood Chain. Answers stream in, grounded in live chain data.",
};

/**
 * `/ask` — the conversation the landing overlay opens, full-bleed.
 *
 * Deliberately thin. Everything a reader sees is components/ask/Conversation.jsx,
 * the one conversation UI both surfaces mount, so the overlay's "open full page"
 * link leads to the same experience rather than to a second, stiffer one.
 */
export default function AskPage() {
  return <AskChat />;
}
