import { Suspense } from "react";
import BuildView from "@/components/BuildView";

export default function BuildPage() {
  return (
    <Suspense fallback={null}>
      <BuildView />
    </Suspense>
  );
}
