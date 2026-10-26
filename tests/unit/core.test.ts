import { describe, expect, it } from "vitest";
import {
  BriefInput,
  CanonicalizationError,
  ConfirmationResponse,
  DEFAULT_BUDGETS,
  DEFAULT_SCORING_WEIGHTS,
  EvidenceFact,
  type ExperimentDefinition,
  ExperimentVariables,
  HypothesisDraft,
  ResolutionCandidates,
  ScoringWeights,
  VariableDelta,
  canonicalHash,
  canonicalize,
  experimentKey,
  isUuidV7,
  requestHash,
  sha256Hex,
  uuidv7,
  uuidv7Timestamp,
} from "../../packages/core/src";

describe("sha256 (FIPS 180-4 vectors)", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
  ])("hashes %j", (input, expected) => {
    expect(sha256Hex(input)).toBe(expected);
  });
  it("hashes a message longer than one block and multi-byte UTF-8", () => {
    expect(sha256Hex("a".repeat(1000))).toBe(
      "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3",
    );
    // Cross-checked with `printf 'é' | shasum -a 256` (UTF-8 bytes C3 A9).
    expect(sha256Hex("é")).toBe(
      "4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c",
    );
  });
});

describe("JCS canonicalization (RFC 8785)", () => {
  it("orders keys by UTF-16 code units and drops undefined members", () => {
    expect(
      canonicalize({ b: 1, a: [true, null], c: { z: "x", y: undefined } }),
    ).toBe('{"a":[true,null],"b":1,"c":{"z":"x"}}');
    // "€" (euro) sorts after "\r" and before "😀" by UTF-16 code unit.
    expect(canonicalize({ "😀": 1, "€": 2, "\r": 3 })).toBe(
      '{"\\r":3,"€":2,"😀":1}',
    );
  });
  it("serializes numbers with ECMAScript rules", () => {
    expect(canonicalize([1e21, 1e-7, 0.000001, -0, 0.1 + 0.2, 4.5])).toBe(
      "[1e+21,1e-7,0.000001,0,0.30000000000000004,4.5]",
    );
  });
  it.each([
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [() => 1],
    [new Date(0)],
    ["\ud800"],
    [10n],
  ])("rejects %s", (value) => {
    expect(() => canonicalize(value)).toThrow(CanonicalizationError);
  });
  it("is independent of object key insertion order", () => {
    expect(canonicalHash({ a: 1, b: { c: 2, d: 3 } })).toBe(
      canonicalHash({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });
});

describe("uuidv7", () => {
  it("produces RFC 9562 version-7 identifiers with the given timestamp", () => {
    const id = uuidv7(1_760_000_000_000);
    expect(isUuidV7(id)).toBe(true);
    expect(uuidv7Timestamp(id)).toBe(1_760_000_000_000);
  });
  it("is monotonic within one millisecond", () => {
    const ids = Array.from({ length: 500 }, () => uuidv7(1_760_000_000_001));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

const baseDefinition = (): ExperimentDefinition => ({
  schemaVersion: 1,
  briefContentHash: "a".repeat(64),
  seeds: [
    {
      qlooId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      kind: "entity",
      role: "seed",
    },
    {
      qlooId: "urn:tag:genre:media:cozy_mystery",
      kind: "tag",
      role: "tag_constraint",
    },
  ],
  variables: ExperimentVariables.parse({
    targetDomains: ["movie", "artist"],
    tagConstraints: ["b", "a"],
  }),
  scoringWeights: DEFAULT_SCORING_WEIGHTS,
  budgets: DEFAULT_BUDGETS.EXPLORATION,
  versions: {
    evaluationRuleset: "2026-10-21.v1",
    promptSet: "p1",
    qlooAdapter: "0.1.0",
    harness: "0.1.26",
    llmModel: "claude-opus-5-5",
  },
  parentExperimentKey: null,
  variableDelta: null,
});

describe("deterministic keys", () => {
  it("matches the frozen golden experiment key", () => {
    // Golden vector: changing canonicalization, hashing, or normalization must be deliberate.
    expect(experimentKey(baseDefinition())).toBe(GOLDEN_EXPERIMENT_DIGEST);
  });
  it("ignores seed, tag-constraint, and target-domain ordering", () => {
    const shuffled = baseDefinition();
    shuffled.seeds.reverse();
    shuffled.variables = {
      ...shuffled.variables,
      tagConstraints: ["a", "b"],
      targetDomains: ["artist", "movie"],
    };
    expect(experimentKey(shuffled)).toBe(experimentKey(baseDefinition()));
  });
  it("changes when any version, variable, or budget changes", () => {
    const key = experimentKey(baseDefinition());
    const model = baseDefinition();
    model.versions.llmModel = "claude-sonnet-5-5";
    const tension = baseDefinition();
    tension.variables.collisionTension = 0.8;
    const budget = baseDefinition();
    budget.budgets = DEFAULT_BUDGETS.COUNTERFACTUAL;
    expect(
      new Set([
        key,
        experimentKey(model),
        experimentKey(tension),
        experimentKey(budget),
      ]).size,
    ).toBe(4);
  });
  it("validates the definition", () => {
    expect(() =>
      experimentKey({ ...baseDefinition(), briefContentHash: "short" }),
    ).toThrow();
  });
  it("hashes requests independently of argument key order", () => {
    const a = requestHash({
      workflow: "qloo_recommend",
      args: { target_type: "movie", signals: ["x"] },
      harnessVersion: "0.1.26",
    });
    const b = requestHash({
      workflow: "qloo_recommend",
      args: { signals: ["x"], target_type: "movie" },
      harnessVersion: "0.1.26",
    });
    const c = requestHash({
      workflow: "qloo_recommend",
      args: { signals: ["x"], target_type: "movie" },
      harnessVersion: "0.1.27",
    });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

// Frozen literal, cross-checked by hashing the normalized canonical JSON with system `shasum`.
// Regenerate only with a recorded decision: it changes every stored experiment key.
const GOLDEN_EXPERIMENT_DIGEST =
  "21095469140adb54c77ccdb83cf10a27bdb60a4f150b241fd5b585a5132badf2";

describe("domain schemas", () => {
  const brief = {
    title: "Midnight Margins",
    challenge:
      "A late-evening reading event for people who rarely visit bookstores.",
    interests: [
      { text: "Japanese city pop" },
      { text: "Nordic noir", domainHint: "tv_show" },
    ],
    venue: { type: "bookstore", capacity: 60 },
  };
  it("accepts a valid brief and applies defaults", () => {
    const parsed = BriefInput.parse(brief);
    expect(parsed.goals).toEqual([]);
    expect(parsed.constraints).toEqual({});
    expect(BriefInput.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(
      parsed,
    );
  });
  it.each([
    { interests: [{ text: "only one" }] },
    { interests: [{ text: "Same" }, { text: "same" }] },
    { challenge: "too short" },
    { venue: { type: "bookstore", capacity: 0 } },
  ])("rejects invalid brief %j", (change) => {
    expect(BriefInput.safeParse({ ...brief, ...change }).success).toBe(false);
  });
  it("requires scoring weights to sum to 1 and deltas to change something", () => {
    expect(
      ScoringWeights.safeParse({ support: 0.5, novelty: 0.5, feasibility: 0.5 })
        .success,
    ).toBe(false);
    expect(VariableDelta.safeParse({}).success).toBe(false);
    expect(VariableDelta.safeParse({ collisionTension: 0.8 }).success).toBe(
      true,
    );
  });
  it("keeps every resolution candidate and alternative (V1 disambiguation)", () => {
    const parsed = ResolutionCandidates.parse({
      entities: [
        {
          qlooId: "A",
          name: "Murder on the Orient Express",
          type: "urn:entity:book",
          popularity: 0.21,
          source: "selected",
          rankInSource: 0,
        },
        {
          qlooId: "B",
          name: "Murder on the Orient Express (Hercule Poirot, #10)",
          type: "urn:entity:book",
          popularity: 0.999,
          source: "alternative",
          rankInSource: 0,
        },
        {
          qlooId: "C",
          name: "Agatha Christie",
          type: "urn:entity:author",
          legacyType: true,
          source: "issue_candidate",
          rankInSource: 0,
        },
        {
          qlooId: "D",
          name: "Lisboa",
          type: "urn:entity:locality",
          disambiguation: "Lisboa, Lisboa, Portugal",
          source: "search",
          rankInSource: 0,
        },
      ],
      harnessSelectedQlooId: "A",
      provenance: [
        {
          strategy: "exact_name_context_or_choice",
          endpoint: "/search",
          match: "exact",
        },
      ],
    });
    expect(parsed.entities).toHaveLength(4);
    expect(parsed.tags).toEqual([]);
    expect(parsed.entities[0]?.legacyType).toBe(false);
  });
  it("types every evidence fact with a measure and a verification flag", () => {
    expect(
      EvidenceFact.safeParse({
        statement: "B ranks 4 of 20",
        jsonPointer: "/results/3/affinity",
        value: 0.88,
        measure: "AUDIENCE_AFFINITY",
        verifiedAtIngest: true,
      }).success,
    ).toBe(true);
    expect(
      EvidenceFact.safeParse({
        statement: "x",
        jsonPointer: "results/3",
        value: 1,
        measure: "AUDIENCE_AFFINITY",
        verifiedAtIngest: true,
      }).success,
    ).toBe(false);
    expect(
      EvidenceFact.safeParse({
        statement: "x",
        jsonPointer: "/a",
        value: 1,
        measure: "CREATIVE_FIT",
        verifiedAtIngest: true,
      }).success,
    ).toBe(false);
  });
  it("bounds hypothesis drafts and validates confirmations", () => {
    const element = { entityId: uuidv7(), role: "anchor" };
    const draft = {
      tempId: "h1",
      title: "City-pop reading lounge",
      premise: "Readers of Japanese fiction meet city-pop listeners.",
      elementRefs: [
        element,
        { ...element, entityId: uuidv7(), role: "accent" },
      ],
      claims: [
        {
          tempId: "c1",
          statement: "Fans of X favor Y-type films.",
          testKind: "CROSS_DOMAIN_AFFINITY",
          params: {
            signalEntityIds: [element.entityId],
            targetDomain: "movie",
          },
        },
      ],
      experienceSketch: "A listening corner with curated paperbacks.",
    };
    expect(HypothesisDraft.safeParse(draft).success).toBe(true);
    // Claim params are a typed object (ADR-022): at least one signal entity UUID.
    expect(
      HypothesisDraft.safeParse({
        ...draft,
        claims: [{ ...draft.claims[0], params: {} }],
      }).success,
    ).toBe(false);
    expect(
      HypothesisDraft.safeParse({ ...draft, elementRefs: [element] }).success,
    ).toBe(false);
    expect(
      ConfirmationResponse.safeParse({
        kind: "ENTITIES",
        selections: [
          { interestIndex: 0, choice: { type: "candidate", qlooId: "B" } },
        ],
      }).success,
    ).toBe(true);
    expect(
      ConfirmationResponse.safeParse({
        kind: "HYPOTHESIS_SELECTION",
        selectedHypothesisIds: [uuidv7(), uuidv7(), uuidv7(), uuidv7()],
      }).success,
    ).toBe(false);
  });
});
