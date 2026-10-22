import { getSamples } from "../../../../server/blueprints";
import { services } from "../../../../server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return getSamples(services(), req);
}
