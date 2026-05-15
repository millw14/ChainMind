import Link from "next/link";
import { Dashboard } from "@/components/Dashboard";
import { RecentCases } from "@/components/RecentCases";

export const metadata = {
  title: "Investigation console",
};

export default function SolanaDashboardPage() {
  return (
    <>
      <div className="border-b border-cm-border-subtle bg-cm-surface/40 px-4 py-5 sm:px-6">
        <div className="mx-auto max-w-[88rem]">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-cm-faint">Operations</p>
              <h1 className="mt-1 text-xl font-semibold tracking-tight text-cm-text sm:text-2xl">Investigation console</h1>
              <p className="mt-2 max-w-2xl text-xs leading-relaxed text-cm-muted sm:text-sm">
                One watch target drives signatures, coordination scoring, graph topology, and alerts — structured like an
                analyst workflow, not a settings screen.
              </p>
            </div>
            <Link href="/docs" className="font-mono text-xs font-medium text-cm-accent-bright hover:underline">
              Deploy ↓ Docs
            </Link>
          </div>
        </div>
      </div>
      <Dashboard />
      <div className="mx-auto max-w-[88rem] px-4 py-6">
        <RecentCases limit={10} />
      </div>
    </>
  );
}
