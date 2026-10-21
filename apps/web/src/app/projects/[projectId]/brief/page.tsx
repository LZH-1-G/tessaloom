import type { Metadata } from "next";
import { BriefPage } from "@/components/brief-page";

export const metadata: Metadata = { title: "Creative brief" };

export default function Page() {
  return <BriefPage />;
}
