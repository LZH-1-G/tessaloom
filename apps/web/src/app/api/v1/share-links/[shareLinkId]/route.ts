import { deleteShareLink } from "../../../../../server/blueprints";
import { services } from "../../../../../server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ shareLinkId: string }> };

export async function DELETE(req: Request, { params }: Params) {
  return deleteShareLink(services(), req, await params);
}
