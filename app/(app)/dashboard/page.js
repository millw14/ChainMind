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
            RPC health, address signatures, database counts (Turso), and v1 co-activity. Production: set{" "}
            <code className="rounded border border-cm-border bg-cm-elevated px-1 font-[family-name:var(--font-mono)] text-[11px] text-cm-subtle">
              SOLANA_RPC_URL
            </code>{" "}
            on the host; optional <code className="font-mono text-[11px] text-cm-subtle">TURSO_*</code> for cloud panels; optional{" "}
            <code className="font-mono text-[11px] text-cm-subtle">GROQ_API_KEY</code> for analyst briefs.
          </p>
        </div>
      </div>
      <Dashboard />
    </>
  );
}
