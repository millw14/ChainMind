import { ReportView } from "@/components/research/ReportView";

export const metadata = {
  title: "Deep investigation",
  description:
    "A bounded investigation of one URL or contract: findings with sources, what was refused, what was not checked, and what it cost.",
  // A report about identifiable people and businesses has no business in a search index,
  // and it is only readable by the wallet that started it anyway.
  robots: { index: false, follow: false },
};

/**
 * `/research/<id>` — one investigation, followed live and then read.
 *
 * Deliberately thin, for the same reason `/ask` is: everything a reader sees is the
 * component, and everything the component shows was arranged by lib/research-view.js on
 * the server. The id is handed straight through — it is validated where it is used, in
 * lib/research-client.js and lib/research-job.js, which is also where ownership is
 * checked. Nothing on this page is visible to anyone who did not start the job.
 */
export default async function ResearchReportPage({ params }) {
  const { id } = await params;
  return <ReportView id={String(id ?? "")} />;
}
