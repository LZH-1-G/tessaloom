import type { Metadata } from "next";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui";
import { WhatIfLab } from "@/components/whatif/whatif-lab";

export const metadata: Metadata = { title: "What-if lab" };

export default function Page() {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <WhatIfLab />
    </Suspense>
  );
}
