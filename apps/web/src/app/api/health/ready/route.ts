import { checkDatabase } from "../../../../lib/readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // M0 checks connectivity only. Worker heartbeat readiness is introduced in M4.
  const db = await checkDatabase(process.env.DATABASE_URL ?? "");
  return Response.json(
    { db },
    { status: db ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
