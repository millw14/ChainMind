import { getTursoClient, tursoFetchRecentCases } from "@/lib/turso.js";
import { CasesExplorer } from "@/components/cases/CasesExplorer.jsx";

export const runtime = "nodejs";
export const metadata = { title: "Investigations · ChainMind" };

export default async function CasesPage() {
  const client = getTursoClient();
  const cases = client ? await tursoFetchRecentCases(client, 50).catch(() => []) : [];

  return <CasesExplorer cases={cases} />;
}
