import {
  getShareLinks,
  postShareLink,
} from "../../../../../../server/blueprints";
import { services } from "../../../../../../server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(req: Request, { params }: Params) {
  return getShareLinks(services(), req, await params);
}

export async function POST(req: Request, { params }: Params) {
  return postShareLink(services(), req, await params);
}
