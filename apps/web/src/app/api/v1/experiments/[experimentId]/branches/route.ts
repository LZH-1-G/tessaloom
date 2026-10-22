import { getBranches, postBranch } from "../../../../../../server/api";
import { services } from "../../../../../../server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ experimentId: string }> };

export async function GET(req: Request, { params }: Params) {
  return getBranches(services(), req, await params);
}

export async function POST(req: Request, { params }: Params) {
  return postBranch(services(), req, await params);
}
