import { putGraphLayout } from "../../../../../../server/api";
import { services } from "../../../../../../server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ experimentId: string }> },
) {
  return putGraphLayout(services(), req, await params);
}
