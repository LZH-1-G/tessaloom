import { postBlueprint } from "../../../../../../server/blueprints";
import { services } from "../../../../../../server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ experimentId: string }> };

export async function POST(req: Request, { params }: Params) {
  return postBlueprint(services(), req, await params);
}
