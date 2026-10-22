import {
  getBlueprintRevisions,
  postBlueprintRevision,
} from "../../../../../../server/blueprints";
import { services } from "../../../../../../server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ blueprintId: string }> };

export async function GET(req: Request, { params }: Params) {
  return getBlueprintRevisions(services(), req, await params);
}

export async function POST(req: Request, { params }: Params) {
  return postBlueprintRevision(services(), req, await params);
}
