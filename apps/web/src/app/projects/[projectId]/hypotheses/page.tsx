import type { Metadata } from "next";
import { HypothesisLab } from "@/components/hypothesis-lab";

export const metadata: Metadata = { title: "Hypothesis lab" };

export default function Page() {
  return <HypothesisLab />;
}
