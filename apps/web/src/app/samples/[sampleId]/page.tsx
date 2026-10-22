import type { Metadata } from "next";
import { SharedView } from "@/components/share/shared-view";

// Read-only demo sample (M10-A): stored data only; viewing never starts a run or an AI call.
export const metadata: Metadata = {
  title: "Demo sample",
  referrer: "no-referrer",
};

export default async function Page({
  params,
}: {
  params: Promise<{ sampleId: string }>;
}) {
  const { sampleId } = await params;
  return <SharedView sampleId={sampleId} />;
}
