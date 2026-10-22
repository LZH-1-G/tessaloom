import { postRecompose } from "../../../../../../../../server/blueprints";
import { services } from "../../../../../../../../server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ blueprintId: string; sectionKind: string }> };

export async function POST(req: Request, { params }: Params) {
  return postRecompose(services(), req, await params);
}
