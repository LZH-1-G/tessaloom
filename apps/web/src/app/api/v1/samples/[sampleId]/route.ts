import { getSample } from "../../../../../server/blueprints";
import { services } from "../../../../../server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ sampleId: string }> },
) {
  return getSample(services(), req, await ctx.params);
}
