import { getShared } from "../../../../../server/blueprints";
import { services } from "../../../../../server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ token: string }> };

export async function GET(req: Request, { params }: Params) {
  return getShared(services(), req, await params);
}
