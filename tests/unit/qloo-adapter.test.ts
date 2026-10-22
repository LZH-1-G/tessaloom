import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CliTransport,
  FIXTURE_LABEL,
  FixtureTransport,
  LiveHarnessRouter,
  QlooAdapter,
  RecommendInput,
  TransportError,
  TrendsInput,
  buildCliArgs,
  checkQlooReadiness,
  fixturePath,
  normalizeComparison,
  normalizeRanked,
  normalizeSearch,
  normalizeTrends,
  parseEnvelope,
  resolvePointer,
  verifyPointer,
  type HarnessCall,
  type HarnessTransport,
  type RawHarnessResult,
} from "../../packages/qloo-adapter/src";

// Synthetic payloads that mirror V1-observed SHAPES only. Values are fictional.
const searchPayload = [
  {
    name: "Lisboa",
    entity_id: "LOC-1",
    types: ["urn:entity:locality"],
    popularity: 0.9,
    disambiguation: "Lisboa, Lisboa, Portugal",
    properties: { population: 1 },
  },
  {
    name: "Agatha Christie",
    entity_id: "AUTH-1",
    types: ["urn:entity:author"],
    popularity: 1,
    tags: [
      {
        name: "Mystery",
        tag_id: "urn:tag:genre:media:mystery",
        type: "urn:tag:genre:media",
        value: "urn:tag:genre:media:mystery",
      },
    ],
  },
];
const describeOk = {
  schema_version: "1.0-preview.1",
  operation: "describe",
  status: "ok",
  results: [
    {
      entity_id: "ED-MINOR",
      name: "Novel",
      popularity: 0.21,
      properties: { description: "d" },
    },
  ],
  result_count: 1,
  resolution: {
    outcomes: [
      {
        input: "Novel",
        status: "resolved",
        match: "exact",
        selected: {
          id: "ED-MINOR",
          name: "Novel",
          type: "urn:entity:book",
          popularity: 0.21,
          description: "minor edition",
        },
        alternatives: [
          {
            id: "ED-CANON",
            name: "Novel (Series, #10)",
            type: "urn:entity:book",
            popularity: 0.999,
            description: "canonical",
          },
          {
            id: "ED-COLL",
            name: "Novel and Other Stories",
            type: "urn:entity:book",
            popularity: 0.55,
          },
        ],
        provenance: {
          provider_id: "qloo_api",
          strategy: "exact_name_context_or_choice",
          endpoint: "/search",
          uses_model: false,
        },
      },
    ],
  },
  provenance: {
    source: "Qloo API",
    endpoint: "/entities",
    requests: [
      { method: "GET", path: "/entities", query: { entity_ids: "ED-MINOR" } },
    ],
  },
  execution: {
    transport: "direct",
    transport_name: "Qloo API",
    correlation_id: "corr-1",
    duration_ms: 10,
  },
};
const needsInput = {
  schema_version: "1.0-preview.1",
  operation: "describe",
  status: "needs_input",
  summary: "Choose the intended Qloo entity.",
  results: [],
  resolution: {
    issues: [
      {
        input: "Lisbon",
        kind: "ambiguous",
        input_kind: "entity",
        field: "entity",
        candidates: [
          {
            id: "L1",
            name: "Lisbon",
            type: "urn:entity:locality",
            popularity: 0.92,
          },
          {
            id: "L2",
            name: "Lisbon",
            type: "urn:entity:locality",
            popularity: 0.89,
          },
        ],
        provenance: {
          strategy: "exact_name_context_or_choice",
          endpoint: "/search",
        },
      },
    ],
  },
  execution: { transport: "direct", correlation_id: "corr-2", duration_ms: 5 },
};
const recommendOk = {
  schema_version: "1.0-preview.1",
  operation: "recommend",
  status: "ok",
  result_count: 2,
  results: [
    {
      entity_id: "M1",
      name: "Film One",
      type: "urn:entity",
      subtype: "urn:entity:movie",
      popularity: 0.8,
      affinity: 0.89,
      explainability: {
        "signal.interests.entities": [{ entity_id: "S", score: 1 }],
      },
      properties: { release_year: 2001 },
    },
    {
      entity_id: "M2",
      name: "Film Two",
      type: "urn:entity",
      subtype: "urn:entity:movie",
      popularity: 0.2,
    },
  ],
  provenance: {
    source: "Qloo API",
    endpoint: "/v2/insights",
    requests: [
      {
        method: "GET",
        path: "/v2/insights",
        query: { "filter.type": "urn:entity:movie" },
      },
    ],
  },
  execution: { transport: "direct", correlation_id: "corr-3", duration_ms: 7 },
};
const compareOk = {
  schema_version: "1.0-preview.1",
  operation: "compare_audiences",
  status: "ok",
  results: {
    tags: [],
    a: [
      {
        tag_id: "urn:tag:genre:media:fiction",
        name: "Fiction",
        type: "urn:tag",
        subtype: "urn:tag:genre:media",
        entity_id: "T1",
        popularity: 0.9,
        query: { count: "1" },
      },
    ],
    b: [
      {
        tag_id: "urn:tag:genre:music:pop",
        name: "Pop",
        subtype: "urn:tag:genre:music",
        query: { count: "2" },
      },
    ],
    matchEntities: [],
  },
  execution: { transport: "direct", correlation_id: "c", duration_ms: 1 },
};
const trendsOk = {
  schema_version: "1.0-preview.1",
  operation: "trends",
  status: "ok",
  result_count: 1,
  series: [
    {
      entity: { entityId: "M1", name: "Film One" },
      points: [
        {
          date: "2025-06-30",
          population_percentile: 0.35,
          population_rank: "213312",
          population_rank_velocity: 0,
          velocity_fold_change: 0,
          population_percent_delta: 0,
        },
      ],
    },
  ],
  execution: { transport: "direct", correlation_id: "c", duration_ms: 1 },
};
const errorObject = (code: string, retryable = false) => ({
  error: { code, layer: "qloo", retryable, recovery: "r" },
  operation: "trends",
  correlation_id: "corr-e",
});

const wf = (
  workflow: HarnessCall extends infer C
    ? C extends { kind: "workflow"; workflow: infer W }
      ? W
      : never
    : never,
  args: Record<string, unknown> = {},
): HarnessCall => ({ kind: "workflow", workflow, args });
const raw = (
  payload: unknown,
  exitCode: number | null = 0,
): RawHarnessResult => ({
  payload,
  exitCode,
  durationMs: 1,
  transport: "HARNESS_CLI",
});

describe("envelope parsing (V1-observed shapes)", () => {
  it("classifies search arrays", () => {
    expect(
      parseEnvelope(
        { kind: "search", args: { query: "x", take: 3 } },
        raw(searchPayload),
      ).summary,
    ).toEqual({
      status: "ok",
      shape: "search_array",
      resultCount: 2,
      errorCode: null,
      retryable: null,
    });
    expect(
      parseEnvelope({ kind: "search", args: { query: "x", take: 3 } }, raw([]))
        .summary.status,
    ).toBe("empty");
  });
  it("keeps the harness pick, every alternative, and resolution provenance", () => {
    const parsed = parseEnvelope(wf("describe"), raw(describeOk));
    expect(parsed.summary.shape).toBe("result_list");
    expect(parsed.correlationId).toBe("corr-1");
    expect(parsed.requests).toEqual([
      { method: "GET", path: "/entities", query: { entity_ids: "ED-MINOR" } },
    ]);
    expect(parsed.resolution?.harnessSelectedQlooId).toBe("ED-MINOR");
    expect(
      parsed.resolution?.entities.map((c) => [c.qlooId, c.source]),
    ).toEqual([
      ["ED-MINOR", "selected"],
      ["ED-CANON", "alternative"],
      ["ED-COLL", "alternative"],
    ]);
    expect(parsed.resolution?.provenance[0]).toMatchObject({
      strategy: "exact_name_context_or_choice",
      match: "exact",
      usesModel: false,
    });
  });
  it("maps needs_input to ambiguity candidates", () => {
    const parsed = parseEnvelope(wf("describe"), raw(needsInput));
    expect(parsed.summary.shape).toBe("needs_input");
    expect(parsed.summaryText).toBe("Choose the intended Qloo entity.");
    expect(parsed.resolution?.entities).toHaveLength(2);
    expect(
      parsed.resolution?.entities.every((c) => c.source === "issue_candidate"),
    ).toBe(true);
    expect(parsed.resolution?.provenance[0]?.issueKind).toBe("ambiguous");
  });
  it("classifies compare objects, series, and the bare error object", () => {
    expect(
      parseEnvelope(wf("compare_audiences"), raw(compareOk)).summary.shape,
    ).toBe("compare_object");
    expect(parseEnvelope(wf("trends"), raw(trendsOk)).summary).toMatchObject({
      shape: "series",
      resultCount: 1,
    });
    expect(
      parseEnvelope(wf("trends"), raw(errorObject("QLOO_CONTRACT"), 1)),
    ).toMatchObject({
      summary: {
        status: "error",
        shape: "error_object",
        errorCode: "QLOO_CONTRACT",
        retryable: false,
      },
      correlationId: "corr-e",
    });
    expect(
      parseEnvelope(wf("find_tags"), raw(errorObject("QLOO_AUTH"), 4)).error
        ?.code,
    ).toBe("QLOO_AUTH");
  });
  it("treats malformed output as UNKNOWN_ENVELOPE", () => {
    expect(parseEnvelope(wf("rank"), raw("text")).error?.code).toBe(
      "UNKNOWN_ENVELOPE",
    );
    expect(
      parseEnvelope(wf("rank"), raw({ status: "weird" })).error?.code,
    ).toBe("UNKNOWN_ENVELOPE");
  });
});

describe("normalizers (API_CONTRACTS §6.2)", () => {
  it("reads search types, disambiguation, tags, and legacy types", () => {
    const [loc, author] = normalizeSearch(searchPayload);
    expect(loc).toMatchObject({
      qlooId: "LOC-1",
      type: "urn:entity:locality",
      disambiguation: "Lisboa, Lisboa, Portugal",
      legacyType: false,
    });
    expect(author).toMatchObject({
      type: "urn:entity:author",
      legacyType: true,
      tags: [
        {
          tagId: "urn:tag:genre:media:mystery",
          name: "Mystery",
          type: "urn:tag:genre:media",
        },
      ],
    });
  });
  it("reads the category from subtype and records missing fields instead of defaulting", () => {
    const [one, two] = normalizeRanked(recommendOk);
    expect(one).toMatchObject({
      type: "urn:entity:movie",
      affinity: 0.89,
      missingFields: [],
    });
    expect(two?.affinity).toBeUndefined();
    expect(two?.missingFields).toEqual(["affinity"]);
  });
  it("returns comparison tag profiles without any similarity score", () => {
    const comparison = normalizeComparison(compareOk);
    expect(Object.keys(comparison).sort()).toEqual([
      "a",
      "b",
      "matchEntities",
      "shared",
    ]);
    expect(comparison.a[0]).toMatchObject({
      tagId: "urn:tag:genre:media:fiction",
      subtype: "urn:tag:genre:media",
      count: 1,
    });
    expect(comparison.shared).toEqual([]);
  });
  it("parses trend points and keeps the original string rank", () => {
    expect(normalizeTrends(trendsOk)[0]?.points[0]).toMatchObject({
      date: "2025-06-30",
      populationRank: 213312,
      populationRankRaw: "213312",
    });
  });
});

class FakeTransport implements HarnessTransport {
  readonly name: "HARNESS_CLI" | "FIXTURE";
  calls: HarnessCall[] = [];
  constructor(
    private readonly responses: (RawHarnessResult | Error)[],
    name: "HARNESS_CLI" | "FIXTURE" = "HARNESS_CLI",
  ) {
    this.name = name;
  }
  async call(call: HarnessCall): Promise<RawHarnessResult> {
    this.calls.push(call);
    const next = this.responses.shift() ?? raw(recommendOk);
    if (next instanceof Error) throw next;
    return { ...next, transport: this.name };
  }
}
const ctx = { projectId: "p", purpose: "test" };
const noSleep = async () => {};
const recommendInput = { targetType: "movie" as const, signals: ["S"] };

describe("adapter behavior", () => {
  it("answers known-unsupported combinations locally without quota or transport", async () => {
    const transport = new FakeTransport([]);
    const quota = { consume: vi.fn(async () => true) };
    const adapter = new QlooAdapter({
      transport,
      harnessVersion: "0.1.26",
      quota,
      sleep: noSleep,
    });
    const outcome = await adapter.trends(
      {
        entities: ["B"],
        entityType: "book",
        startDate: "2025-01-01",
        endDate: "2025-02-01",
      },
      ctx,
    );
    expect(outcome).toMatchObject({ kind: "UNSUPPORTED" });
    expect(transport.calls).toHaveLength(0);
    expect(quota.consume).not.toHaveBeenCalled();
  });
  it("refuses before calling Qloo when the quota guard is exhausted", async () => {
    const transport = new FakeTransport([]);
    const adapter = new QlooAdapter({
      transport,
      harnessVersion: "0.1.26",
      quota: { consume: async () => false },
      sleep: noSleep,
    });
    expect(await adapter.recommend(recommendInput, ctx)).toMatchObject({
      kind: "ERROR",
      code: "QUOTA_GUARD_ACTIVE",
    });
    expect(transport.calls).toHaveLength(0);
  });
  it("never charges fixture traffic to the shared live Qloo quota", async () => {
    const quota = { consume: vi.fn(async () => false) };
    const fixture = new FakeTransport([raw(recommendOk)], "FIXTURE");
    const adapter = new QlooAdapter({
      transport: fixture,
      harnessVersion: "fixture",
      quota,
      sleep: noSleep,
    });
    // Even with the live quota exhausted, fixture calls run and consume nothing.
    expect((await adapter.recommend(recommendInput, ctx)).kind).toBe("OK");
    expect(quota.consume).not.toHaveBeenCalled();
  });
  it("retries only retryable errors and reserves quota for every attempt", async () => {
    const quota = { consume: vi.fn(async () => true) };
    const retrying = new FakeTransport([
      raw(errorObject("UPSTREAM_5XX", true), 1),
      raw(recommendOk),
    ]);
    const adapter = new QlooAdapter({
      transport: retrying,
      harnessVersion: "0.1.26",
      quota,
      sleep: noSleep,
    });
    expect((await adapter.recommend(recommendInput, ctx)).kind).toBe("OK");
    expect(retrying.calls).toHaveLength(2);
    expect(quota.consume).toHaveBeenCalledTimes(2);

    const fatal = new FakeTransport([raw(errorObject("QLOO_AUTH"), 4)]);
    const outcome = await new QlooAdapter({
      transport: fatal,
      harnessVersion: "0.1.26",
      sleep: noSleep,
    }).recommend(recommendInput, ctx);
    expect(outcome).toMatchObject({
      kind: "ERROR",
      code: "QLOO_AUTH",
      retryable: false,
    });
    expect(fatal.calls).toHaveLength(1);
  });
  it("bounds transport retries and reports the final transport error", async () => {
    const timeouts = new FakeTransport(
      [0, 1, 2].map(() => new TransportError("TIMEOUT", "t", true)),
    );
    const outcome = await new QlooAdapter({
      transport: timeouts,
      harnessVersion: "0.1.26",
      sleep: noSleep,
      maxRetries: 2,
    }).recommend(recommendInput, ctx);
    expect(outcome).toMatchObject({ kind: "ERROR", code: "TIMEOUT" });
    expect(timeouts.calls).toHaveLength(3);
    const missing = new FakeTransport([
      new TransportError("HARNESS_NOT_FOUND", "n", false),
    ]);
    await new QlooAdapter({
      transport: missing,
      harnessVersion: "0.1.26",
      sleep: noSleep,
    }).recommend(recommendInput, ctx);
    expect(missing.calls).toHaveLength(1);
  });
  it("serves repeated calls from the in-memory cache, labelled CACHE with a source invocation", async () => {
    const transport = new FakeTransport([raw(recommendOk)]);
    const record = vi.fn(async () => ({
      toolInvocationId: `inv-${record.mock.calls.length}`,
      snapshotId: null,
    }));
    const adapter = new QlooAdapter({
      transport,
      harnessVersion: "0.1.26",
      recorder: { record },
      sleep: noSleep,
    });
    const first = await adapter.recommend(recommendInput, ctx);
    const second = await adapter.recommend(recommendInput, ctx);
    expect(transport.calls).toHaveLength(1);
    expect(first.kind === "OK" && first.provenance.dataOrigin).toBe("LIVE");
    expect(second.kind === "OK" && second.provenance.dataOrigin).toBe("CACHE");
    expect(record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        dataOrigin: "CACHE",
        cacheSourceInvocationId: "inv-1",
      }),
    );
    await adapter.recommend(recommendInput, {
      ...ctx,
      cachePolicy: "live-only",
    });
    expect(transport.calls).toHaveLength(2);
  });
  it("preserves harness provenance and the in-memory raw payload on success", async () => {
    const adapter = new QlooAdapter({
      transport: new FakeTransport([raw(describeOk)]),
      harnessVersion: "0.1.26",
      sleep: noSleep,
    });
    const outcome = await adapter.describeEntity(
      { entity: "Novel", type: "book" },
      ctx,
    );
    expect(outcome.kind).toBe("OK");
    if (outcome.kind !== "OK") return;
    expect(outcome.items[0]).toMatchObject({
      qlooId: "ED-MINOR",
      type: "urn:entity:book",
    });
    expect(outcome.resolution?.entities).toHaveLength(3);
    expect(outcome.provenance).toMatchObject({
      correlationId: "corr-1",
      endpoint: "/entities",
      dataOrigin: "LIVE",
      transport: "HARNESS_CLI",
    });
    expect(verifyPointer(outcome.raw, "/results/0/popularity", 0.21)).toBe(
      true,
    );
  });
  it("returns NEEDS_INPUT with all candidates for ambiguous names", async () => {
    const adapter = new QlooAdapter({
      transport: new FakeTransport([raw(needsInput)]),
      harnessVersion: "0.1.26",
      sleep: noSleep,
    });
    const outcome = await adapter.describeEntity(
      { entity: "Lisbon", type: "locality" },
      ctx,
    );
    expect(outcome).toMatchObject({
      kind: "NEEDS_INPUT",
      resolution: { entities: [{ qlooId: "L1" }, { qlooId: "L2" }] },
    });
  });
  it("limits concurrent harness calls to two", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow: HarnessTransport = {
      name: "HARNESS_CLI",
      async call() {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return raw(recommendOk);
      },
    };
    const adapter = new QlooAdapter({
      transport: slow,
      harnessVersion: "0.1.26",
      sleep: noSleep,
      rateLimitPerMin: 1000,
    });
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        adapter.recommend(
          { targetType: "movie", signals: [`S${n}`] },
          { ...ctx, cachePolicy: "live-only" },
        ),
      ),
    );
    expect(peak).toBe(2);
  });
  it("validates inputs against V1-observed bounds", () => {
    expect(
      RecommendInput.safeParse({
        targetType: "movie",
        signals: ["a"],
        limit: 21,
      }).success,
    ).toBe(false);
    expect(
      RecommendInput.safeParse({
        targetType: "movie",
        signals: Array.from({ length: 11 }, (_, i) => `s${i}`),
      }).success,
    ).toBe(false);
    expect(RecommendInput.safeParse({ targetType: "movie" }).success).toBe(
      false,
    );
    expect(
      RecommendInput.safeParse({ targetType: "video_game", signals: ["a"] })
        .success,
    ).toBe(false);
    expect(
      TrendsInput.safeParse({
        entities: ["1", "2", "3", "4", "5", "6"],
        entityType: "movie",
        startDate: "2025-01-01",
        endDate: "2025-02-01",
      }).success,
    ).toBe(false);
    expect(
      TrendsInput.safeParse({
        entities: ["1"],
        entityType: "movie",
        startDate: "2025-03-01",
        endDate: "2025-02-01",
      }).success,
    ).toBe(false);
  });
});

describe("live routing never falls back to fixtures", () => {
  it("uses the CLI when MCP is unavailable and always for search", async () => {
    const mcp = new FakeTransport([
      new TransportError("MCP_UNAVAILABLE", "down", true),
    ]);
    const cli = new FakeTransport([raw(recommendOk), raw(searchPayload)]);
    const router = new LiveHarnessRouter(mcp, cli);
    await router.call(wf("recommend", { target_type: "movie" }), {
      timeoutMs: 1000,
    });
    await router.call(
      { kind: "search", args: { query: "x", take: 2 } },
      { timeoutMs: 1000 },
    );
    expect(mcp.calls).toHaveLength(1);
    expect(cli.calls).toHaveLength(2);
  });
  it("propagates live failures instead of substituting data", async () => {
    const router = new LiveHarnessRouter(
      new FakeTransport([new TransportError("MCP_UNAVAILABLE", "down", true)]),
      new FakeTransport([
        new TransportError("HARNESS_NOT_FOUND", "gone", false),
      ]),
    );
    await expect(
      router.call(wf("recommend"), { timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "HARNESS_NOT_FOUND" });
  });
});

describe("CLI transport", () => {
  it("builds allowlisted argv without credentials", () => {
    expect(
      buildCliArgs({
        kind: "search",
        args: { query: "Lisbon", type: "locality", take: 4 },
      }),
    ).toEqual([
      "api",
      "search",
      "--query",
      "Lisbon",
      "--type",
      "locality",
      "--take",
      "4",
      "--json",
    ]);
    const exec = buildCliArgs(
      wf("find_tags", { query: "cozy mystery", limit: 5 }),
    );
    expect(exec).toEqual([
      "exec",
      "find_tags",
      "--input",
      '{"query":"cozy mystery","limit":5}',
    ]);
    expect(exec.join(" ")).not.toMatch(/api-key/);
    expect(() =>
      buildCliArgs({ kind: "workflow", workflow: "build" as never, args: {} }),
    ).toThrow();
  });
  it("parses stdout on non-zero exits and maps process failures", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tl-qloo-stub-"));
    const stub = path.join(dir, "qloo");
    await writeFile(
      stub,
      `#!/usr/bin/env node\nconst a=process.argv.slice(2);\nif(a[1]==="trends"){process.stdout.write(JSON.stringify({error:{code:"QLOO_CONTRACT",layer:"qloo",retryable:false,recovery:"r"},operation:"trends",correlation_id:"x"}));process.exit(1)}\nif(a[1]==="rank"){setTimeout(()=>{},5000);return}\nif(a[1]==="recommend"){process.stdout.write("not json");process.exit(0)}\nprocess.stdout.write(JSON.stringify({status:"ok",results:[]}));\n`,
    );
    await chmod(stub, 0o755);
    const cli = new CliTransport({ command: stub });
    await expect(
      cli.call(wf("trends", { entities: ["b"] }), { timeoutMs: 5000 }),
    ).resolves.toMatchObject({
      exitCode: 1,
      payload: { error: { code: "QLOO_CONTRACT" } },
    });
    await expect(
      cli.call(wf("rank"), { timeoutMs: 300 }),
    ).rejects.toMatchObject({ code: "TIMEOUT", retryable: true });
    await expect(
      cli.call(wf("recommend"), { timeoutMs: 5000 }),
    ).rejects.toMatchObject({ code: "INVALID_JSON" });
    await expect(
      new CliTransport({ command: path.join(dir, "missing") }).call(
        wf("find_tags"),
        { timeoutMs: 1000 },
      ),
    ).rejects.toMatchObject({ code: "HARNESS_NOT_FOUND" });
  });
});

describe("fixture transport (ADR-014)", () => {
  it("refuses production, unlabeled files, and unknown requests", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tl-fixtures-"));
    expect(() => new FixtureTransport(root, "production")).toThrow();
    const transport = new FixtureTransport(root, "test");
    const call = wf("find_tags", { query: "cozy mystery", limit: 5 });
    await expect(transport.call(call)).rejects.toMatchObject({
      code: "FIXTURE_MISSING",
    });
    await mkdir(path.dirname(fixturePath(root, call)), { recursive: true });
    await writeFile(
      fixturePath(root, call),
      JSON.stringify({ payload: { status: "ok", results: [] } }),
    );
    await expect(transport.call(call)).rejects.toMatchObject({
      code: "FIXTURE_MISSING",
    });
    await writeFile(
      fixturePath(root, call),
      JSON.stringify({
        _fixture: { synthetic: true, label: FIXTURE_LABEL },
        payload: { status: "ok", result_count: 0, results: [] },
      }),
    );
    const adapter = new QlooAdapter({
      transport,
      harnessVersion: "0.1.26",
      sleep: noSleep,
    });
    const outcome = await adapter.findTags(
      { query: "cozy mystery", limit: 5 },
      ctx,
    );
    expect(outcome.kind === "EMPTY" && outcome.provenance).toMatchObject({
      dataOrigin: "FIXTURE",
      transport: "FIXTURE",
    });
  });
});

describe("readiness (local, no Qloo call)", () => {
  async function stub(trustMessage: string, authStatus = "ok") {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tl-doctor-"));
    const file = path.join(dir, "qloo");
    const doctor = JSON.stringify({
      checks: [
        { id: "qloo-auth", status: authStatus, message: "m" },
        { id: "qloo-endpoint-trust", status: "ok", message: trustMessage },
      ],
    });
    await writeFile(
      file,
      `#!/usr/bin/env node\nif(process.argv[2]==="--version"){console.log("0.1.26")}else{console.log(${JSON.stringify(doctor)});process.exit(1)}\n`,
    );
    await chmod(file, 0o755);
    return file;
  }
  const expectedBaseUrl = "https://hackathon.api.qloo.com";
  it("is ready only for a configured credential and the trusted hackathon endpoint", async () => {
    expect(
      await checkQlooReadiness({
        expectedBaseUrl,
        command: await stub(
          "Qloo API endpoint is explicitly trusted via QLOO_TRUSTED_BASE_URL: https://hackathon.api.qloo.com/",
        ),
      }),
    ).toMatchObject({
      ready: true,
      harnessVersion: "0.1.26",
      endpoint: expectedBaseUrl,
    });
    expect(
      await checkQlooReadiness({
        expectedBaseUrl,
        command: await stub(
          "Qloo API endpoint is official: https://api.qloo.com/",
        ),
      }),
    ).toMatchObject({ ready: false, reason: "endpoint_not_trusted" });
    expect(
      await checkQlooReadiness({
        expectedBaseUrl,
        command: await stub(
          "Custom Qloo API endpoint https://hackathon.api.qloo.com/ is not trusted.",
        ),
      }),
    ).toMatchObject({ ready: false, reason: "endpoint_not_trusted" });
    expect(
      await checkQlooReadiness({
        expectedBaseUrl,
        command: await stub(
          "trusted https://hackathon.api.qloo.com/",
          "warning",
        ),
      }),
    ).toMatchObject({ ready: false, reason: "credential_missing" });
    expect(
      await checkQlooReadiness({
        expectedBaseUrl,
        command: "/nonexistent/qloo",
      }),
    ).toMatchObject({ ready: false, reason: "harness_unavailable" });
  });
});

describe("JSON pointers", () => {
  it("resolves RFC 6901 pointers including escapes", () => {
    const doc = { "a/b": { "m~n": [10, 20] } };
    expect(resolvePointer(doc, "/a~1b/m~0n/1")).toEqual({
      found: true,
      value: 20,
    });
    expect(resolvePointer(doc, "/a~1b/m~0n/2").found).toBe(false);
    expect(resolvePointer(doc, "/missing").found).toBe(false);
    expect(verifyPointer(doc, "/a~1b/m~0n/0", 10)).toBe(true);
    expect(verifyPointer(doc, "/a~1b/m~0n/0", 11)).toBe(false);
  });
});
