import type { Metadata } from "next";
import { DiscoveryPage } from "@/components/discovery-page";

export const metadata: Metadata = { title: "Discovery canvas" };

export default function Page() {
  return <DiscoveryPage />;
}
