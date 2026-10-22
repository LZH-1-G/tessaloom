import { getExperimentGraph } from "../../../../../../server/api";
import { services } from "../../../../../../server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ experimentId: string }> },
) {
  return getExperimentGraph(services(), req, await params);
}
