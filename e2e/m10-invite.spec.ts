import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import {
  createProject,
  expectAccessible,
  expect,
  test,
  TYPED_BRIEF,
} from "./helpers";

// Real HTTP, database, worker and browser. Only the external providers are scripted.
test("invite access denies anonymous work, rejects inactive codes and enforces a redeemed grant", async ({
  page,
  baseURL,
}, info) => {
  const url =
    process.env.E2E_DATABASE_URL ??
    "postgresql://tessaloom:local-development-only@127.0.0.1:5432/tessaloom_e2e_invite";
  const target = new URL(url);
  if (
    !["127.0.0.1", "localhost"].includes(target.hostname) ||
    !target.pathname.startsWith("/tessaloom_e2e")
  )
    throw new Error("Invite tests require a local E2E database");
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  const grants = ["valid", "expired", "revoked"].map((kind) => ({
    id: randomUUID(),
    kind,
    code: `e2e-${info.project.name}-${kind}-${randomUUID()}`,
  }));
  try {
    for (const g of grants) {
      const hash = createHash("sha256")
        .update(`demo-access:${g.code}playwright-placeholder-pepper-32-bytes`)
        .digest("hex");
      await db.query(
        `INSERT INTO demo_access_grants
        (id, label, code_hash, expires_at, revoked_at, max_runs, max_llm_usd_micros)
        VALUES ($1,$2,$3,now() + $4::interval,$5,1,1000000)`,
        [
          g.id,
          g.kind,
          hash,
          g.kind === "expired" ? "-1 day" : "1 day",
          g.kind === "revoked" ? new Date() : null,
        ],
      );
    }
    await createProject(page, `Invite ${info.project.name}`);
    const projectId = /projects\/([^/]+)/.exec(page.url())![1]!;
    const csrf = (await page.context().cookies()).find(
      (c) => c.name === "tl_csrf",
    )!.value;
    const headers = { origin: baseURL!, "x-tessaloom-csrf": csrf };
    const post = (path: string, data: unknown) =>
      page.request.post(path, { data, headers });
    const briefResponse = await post(`/api/v1/projects/${projectId}/briefs`, {
      title: TYPED_BRIEF.title,
      challenge: TYPED_BRIEF.challenge,
      interests: TYPED_BRIEF.interests.map(([text, domainHint]) => ({
        text,
        domainHint,
      })),
      venue: { type: "cafe", capacity: 40 },
      goals: ["Attract new weekday visitors"],
    });
    expect(briefResponse.status()).toBe(201);
    const brief = await briefResponse.json();
    let n = 0;
    const start = () =>
      post(`/api/v1/projects/${projectId}/experiments`, {
        briefVersionId: brief.id,
        mode: "live",
        variables: { collisionTension: 0.2 + n++ / 10 },
      });
    const denied = await start();
    expect(denied.status()).toBe(403);
    expect((await denied.json()).error.code).toBe("RUN_ACCESS_REQUIRED");
    await page.goto("/");
    const notice = page.getByTestId("run-access");
    for (const code of [
      "invalid-code-e2e-attempt",
      grants[1]!.code,
      grants[2]!.code,
    ]) {
      await notice.getByLabel("Access code").fill(code);
      const response = page.waitForResponse(
        (r) =>
          r.url().endsWith("/workspace/access") &&
          r.request().method() === "POST",
      );
      await notice.getByRole("button", { name: "Unlock AI runs" }).click();
      expect((await response).status()).toBe(400);
      await expect(notice.getByRole("alert")).toHaveText(
        "This access code is not valid or no longer active.",
      );
    }
    await notice.getByLabel("Access code").fill(grants[0]!.code);
    await notice.getByRole("button", { name: "Unlock AI runs" }).click();
    await expect(notice).toContainText("Demo access active (valid)");
    expect((await start()).status()).toBe(202);
    const limited = await start();
    expect(limited.status()).toBe(429);
    expect((await limited.json()).error.code).toBe("RUN_LIMIT");
    await db.query(
      "UPDATE demo_access_grants SET revoked_at = now() WHERE id = $1",
      [grants[0]!.id],
    );
    expect((await start()).status()).toBe(403);
    expect(
      (
        await post("/api/v1/workspace/access", { code: grants[0]!.code })
      ).status(),
    ).toBe(400);
    expect(
      (await page.request.get(`/api/v1/projects/${projectId}`)).status(),
    ).toBe(200);
    await expectAccessible(page);
  } finally {
    await db.end();
  }
});
