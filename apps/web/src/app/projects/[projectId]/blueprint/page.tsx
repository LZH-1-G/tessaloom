import type { Metadata } from "next";
import { Suspense } from "react";
import { BlueprintPage } from "@/components/blueprint/blueprint-page";
import { Skeleton } from "@/components/ui";

export const metadata: Metadata = { title: "Experience blueprint" };

export default function Page() {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <BlueprintPage />
    </Suspense>
  );
}
