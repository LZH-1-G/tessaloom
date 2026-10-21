import { checkReadiness } from "../../../../lib/readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const readiness = await checkReadiness(process.env.DATABASE_URL ?? "");
  return Response.json(readiness, {
    status: readiness.db && readiness.worker ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
