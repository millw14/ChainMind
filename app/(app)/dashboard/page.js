import Link from "next/link";
import { Dashboard } from "@/components/Dashboard";

export const metadata = {
  title: "Coordination investigation",
};

export default function SolanaDashboardPage() {
  return (
    <>
      <div className="border-b border-cm-border-subtle px-4 pb-6 pt-5 sm:px-6 sm:pt-6">
        <div className="mx-auto max-w-5xl">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h1 className="text-xl font-semibold tracking-tight text-cm-text sm:text-2xl">Coordination investigation</h1>
            <Link href="/docs" className="text-xs font-medium text-cm-muted hover:text-cm-text">
              Setup / Docs →
            </Link>
          </div>
        <p className="mt-2 max-w-2xl text-xs leading-relaxed text-cm-muted sm:text-sm">
          Investigate whether wallets around a token are moving in coordination—load recent flows, review synced events,
          and score time-bunched participation from one focus. First-time setup lives in{" "}
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
