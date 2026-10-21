import type { Metadata } from "next";
import { Dashboard } from "@/components/dashboard";

export const metadata: Metadata = { title: "Studio" };

export default function Home() {
  return <Dashboard />;
}
