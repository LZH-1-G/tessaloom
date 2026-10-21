import { getWorkspace } from "../../../../server/api";
import { services } from "../../../../server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return getWorkspace(services(), req);
}
