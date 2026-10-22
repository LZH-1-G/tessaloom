import type { Metadata } from "next";
import { SharedView } from "@/components/share/shared-view";

// Read-only share view (UI_UX_SPEC §4.8): never indexed, never sends a referrer.
export const metadata: Metadata = {
  title: "Shared view",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function Page({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <SharedView token={token} />;
}
