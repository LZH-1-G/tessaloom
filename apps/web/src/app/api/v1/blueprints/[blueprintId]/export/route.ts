import { getBlueprintExport } from "../../../../../../server/blueprints";
import { services } from "../../../../../../server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ blueprintId: string }> };

export async function GET(req: Request, { params }: Params) {
  return getBlueprintExport(services(), req, await params);
}
