import { startExperiment } from "../../../../../../server/api";
import { services } from "../../../../../../server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  return startExperiment(services(), req, await params);
}
