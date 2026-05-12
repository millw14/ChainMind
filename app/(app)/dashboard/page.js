import Link from "next/link";
import { Dashboard } from "@/components/Dashboard";

export const metadata = {
  title: "Solana dashboard",
};

export default function SolanaDashboardPage() {
  return (
    <>
      <div className="border-b border-cm-border-subtle px-4 pb-6 pt-5 sm:px-6 sm:pt-6">
        <div className="mx-auto max-w-5xl">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h1 className="text-xl font-semibold tracking-tight text-cm-text sm:text-2xl">Solana dashboard</h1>
            <Link href="/docs" className="text-xs font-medium text-cm-muted hover:text-cm-text">
              Setup / Docs →
            </Link>
          </div>
        <p className="mt-2 max-w-2xl text-xs leading-relaxed text-cm-muted sm:text-sm">
          See whether Solana activity around a token or wallet is bunching up in time—load recent transactions, review
          synced events, and run a coordination score from one focus. First-time setup lives in{" "}
          <Link href="/docs" className="font-medium text-cm-text underline-offset-2 hover:underline">
            Docs
          </Link>
          .
        </p>
        </div>
      </div>
      <Dashboard />
    </>
  );
}
