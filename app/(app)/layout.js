import { ConsoleHeader } from "@/components/console/ConsoleHeader";

export const metadata = {
  // A TEMPLATE, matching the marketing group, because this group has child pages and a
  // bare string is not inherited as one. Without it app/(app)/research/[id] shipped its
  // title verbatim — a shared deep-investigation link read "Deep investigation" in the tab
  // and in every link preview, naming neither the product nor the chain. That page is the
  // one most likely to be sent to somebody who has never heard of either.
  title: {
    default: "Robinhood Chain — AI explorer",
    template: "%s · ChainMind",
  },
  description:
    "Ask anything about Robinhood Chain — wallets, tokens, transactions and tokenized equities read live: supply, holders, concentration, deployer, verification, and what they mean.",
};

export default function AppShellLayout({ children }) {
  return (
    <div className="cm-scanlines min-h-screen bg-cm-bg">
      <ConsoleHeader />
      {children}
    </div>
  );
}
