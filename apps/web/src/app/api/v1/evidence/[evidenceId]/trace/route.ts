import { getEvidenceTrace } from "../../../../../../server/api";
import { services } from "../../../../../../server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ evidenceId: string }> },
) {
  return getEvidenceTrace(services(), req, await params);
}
