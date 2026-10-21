import { postConfirmation } from "../../../../../../server/api";
import { services } from "../../../../../../server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  return postConfirmation(services(), req, await params);
}
