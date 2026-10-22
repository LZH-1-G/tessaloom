import { postComparison } from "../../../../server/api";
import { services } from "../../../../server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return postComparison(services(), req);
}
