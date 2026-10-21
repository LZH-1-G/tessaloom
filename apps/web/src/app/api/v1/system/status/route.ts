import { getSystemStatus } from "../../../../../server/api";
import { services } from "../../../../../server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return getSystemStatus(services());
}
