import { Dashboard } from "@/components/Dashboard";

export default function ConsolePage() {
  return (
    <>
      <div className="border-b border-cm-border-subtle px-4 pb-8 pt-6 sm:px-6 sm:pt-8">
        <div className="mx-auto max-w-5xl">
          <h1 className="text-2xl font-bold tracking-tight text-cm-text sm:text-3xl">Console</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-cm-muted">
            Operational workspace: chain health, address activity, and co-activity scoring. Prefer a dedicated{" "}
            <code className="rounded bg-cm-elevated px-1 text-xs text-cm-subtle">SOLANA_RPC_URL</code> in production.
          </p>
        </div>
      </div>
      <Dashboard />
    </>
  );
}
