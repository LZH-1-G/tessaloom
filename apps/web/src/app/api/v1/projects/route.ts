import { getProjects, postProject } from "../../../../server/api";
import { services } from "../../../../server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return getProjects(services(), req);
}

export function POST(req: Request) {
  return postProject(services(), req);
}
