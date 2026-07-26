import { AskChat } from "@/components/ask/AskChat";

export const metadata = {
  title: "Ask — Robinhood Chain AI explorer",
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
