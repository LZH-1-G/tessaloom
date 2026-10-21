import { getRun } from "../../../../../server/api";
import { services } from "../../../../../server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  return getRun(services(), req, await params);
}
