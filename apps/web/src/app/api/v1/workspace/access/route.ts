import { getRunAccess, postRunAccess } from "../../../../../server/api";
import { services } from "../../../../../server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return getRunAccess(services(), req);
}

export function POST(req: Request) {
  return postRunAccess(services(), req);
}
