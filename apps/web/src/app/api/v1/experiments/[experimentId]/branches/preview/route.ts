import { previewBranch } from "../../../../../../../server/api";
import { services } from "../../../../../../../server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ experimentId: string }> },
) {
  return previewBranch(services(), req, await params);
}
