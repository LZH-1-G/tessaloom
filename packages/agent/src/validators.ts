import type {
  BlueprintContent,
  ClaimParams,
  ClaimTestKind,
  CritiqueReport,
  HypothesisBatch,
  HypothesisDraft,
  HypothesisRevision,
} from "@tessaloom/core";

/**
 * AGENT_WORKFLOW §13.2 output validators. They are pure functions over a parsed (schema-valid)
 * output plus the experiment's known IDs, and they are injected into the LLM gateway as
 * semantic validators (ADR-022). The gateway turns their issues into one repair attempt.
 */
export interface ValidationIssue {
  code: string;
  path?: string;
  message: string;
}

export type Validator<T> = (value: T) => ValidationIssue[];

export function combine<T>(...validators: Validator<T>[]): Validator<T> {
  return (value) => validators.flatMap((v) => v(value));
}

// ---------------------------------------------------------------------------
// Entity grounding + claim params (R3)

export interface GroundingContext {
  /** cultural_entities UUIDs (entities and tags) available to this experiment's pool. */
  entityIds: ReadonlySet<string>;
  /** Subset of entityIds that are tags. */
  tagIds?: ReadonlySet<string>;
  /** Domain per entity UUID (for MOMENTUM/book and cross-domain checks). */
  domainOf?: ReadonlyMap<string, string>;
  maxClaimsPerHypothesis?: number;
}

const REQUIRED_PARAMS: Record<
  ClaimTestKind,
  (p: ClaimParams) => string | null
> = {
  CROSS_DOMAIN_AFFINITY: (p) =>
    p.targetDomain ? null : "targetDomain is required",
  SHORTLIST_FIT: (p) =>
    (p.optionEntityIds?.length ?? 0) < 2
      ? "optionEntityIds needs 2-10 options"
      : !p.targetEntityId
        ? "targetEntityId (the claimed best fit) is required"
        : !p.optionEntityIds!.includes(p.targetEntityId)
          ? "targetEntityId must be one of optionEntityIds"
          : null,
  AUDIENCE_BRIDGE: (p) =>
    (p.compareEntityIds?.length ?? 0) < 1
      ? "compareEntityIds (group B) is required"
      : null,
  TAG_RESONANCE: (p) =>
    p.signalEntityIds.length !== 1
      ? "exactly one signal entity is required"
      : (p.tagEntityIds?.length ?? 0) < 1
        ? "tagEntityIds (the theme) is required"
        : null,
  LOCATION_FIT: (p) =>
    p.signalEntityIds.length !== 1
      ? "exactly one anchor entity is required"
      : null,
  MOMENTUM: () => null,
  AUDIENCE_PROFILE: (p) =>
    p.signalEntityIds.length !== 1 ? "exactly one entity is required" : null,
};

function paramIds(p: ClaimParams): string[] {
  return [
    ...p.signalEntityIds,
    ...(p.targetEntityId ? [p.targetEntityId] : []),
    ...(p.tagEntityIds ?? []),
    ...(p.optionEntityIds ?? []),
    ...(p.compareEntityIds ?? []),
  ];
}

export function validateHypothesisDraft(
  h: HypothesisDraft,
  ctx: GroundingContext,
  path: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const elementIds = h.elementRefs.map((r) => r.entityId);
  if (new Set(elementIds).size !== elementIds.length)
    issues.push({
      code: "DUPLICATE_ELEMENT",
      path: `${path}.elementRefs`,
      message: "Each element may appear once",
    });
  h.elementRefs.forEach((ref, i) => {
    if (!ctx.entityIds.has(ref.entityId))
      issues.push({
        code: "UNGROUNDED_ENTITY",
        path: `${path}.elementRefs.${i}.entityId`,
        message: `Entity ${ref.entityId} is not in the collision pool; use only pool UUIDs or move the idea to creativeElements`,
      });
  });
  if (
    ctx.maxClaimsPerHypothesis !== undefined &&
    h.claims.length > ctx.maxClaimsPerHypothesis
  )
    issues.push({
      code: "TOO_MANY_CLAIMS",
      path: `${path}.claims`,
      message: `At most ${ctx.maxClaimsPerHypothesis} claims`,
    });
  const claimIds = new Set<string>();
  h.claims.forEach((c, i) => {
    const cpath = `${path}.claims.${i}`;
    if (claimIds.has(c.tempId))
      issues.push({
        code: "DUPLICATE_CLAIM_ID",
        path: cpath,
        message: "Claim tempIds must be unique",
      });
    claimIds.add(c.tempId);
    for (const id of paramIds(c.params)) {
      if (!ctx.entityIds.has(id))
        issues.push({
          code: "UNGROUNDED_PARAM",
          path: `${cpath}.params`,
          message: `Param entity ${id} is not in the collision pool`,
        });
    }
    if (ctx.tagIds) {
      for (const id of c.params.tagEntityIds ?? [])
        if (ctx.entityIds.has(id) && !ctx.tagIds.has(id))
          issues.push({
            code: "NOT_A_TAG",
            path: `${cpath}.params.tagEntityIds`,
            message: `${id} is an entity, not a tag`,
          });
    }
    const missing = REQUIRED_PARAMS[c.testKind](c.params);
    if (missing)
      issues.push({
        code: "CLAIM_PARAMS",
        path: `${cpath}.params`,
        message: `${c.testKind}: ${missing}`,
      });
    if (c.testKind === "MOMENTUM" && ctx.domainOf) {
      const domains = new Set(
        c.params.signalEntityIds.map((id) => ctx.domainOf!.get(id)),
      );
      if (domains.size > 1)
        issues.push({
          code: "CLAIM_PARAMS",
          path: `${cpath}.params`,
          message: "MOMENTUM: all entities must share one domain",
        });
    }
  });
  return issues;
}

export function hypothesisBatchValidator(
  ctx: GroundingContext,
): Validator<HypothesisBatch> {
  return (batch) => {
    const issues = batch.hypotheses.flatMap((h, i) =>
      validateHypothesisDraft(h, ctx, `hypotheses.${i}`),
    );
    const tempIds = batch.hypotheses.map((h) => h.tempId);
    if (new Set(tempIds).size !== tempIds.length)
      issues.push({
        code: "DUPLICATE_HYPOTHESIS_ID",
        path: "hypotheses",
        message: "Hypothesis tempIds must be unique",
      });
    return issues;
  };
}

export function hypothesisRevisionValidator(
  ctx: GroundingContext & { hypothesisIds: ReadonlySet<string> },
): Validator<HypothesisRevision> {
  return (rev) => {
    const issues: ValidationIssue[] = [];
    rev.refined.forEach((h, i) => {
      issues.push(...validateHypothesisDraft(h, ctx, `refined.${i}`));
      if (!ctx.hypothesisIds.has(h.revisionOfId))
        issues.push({
          code: "UNKNOWN_HYPOTHESIS",
          path: `refined.${i}.revisionOfId`,
          message: `Unknown hypothesis ${h.revisionOfId}`,
        });
    });
    rev.spawned.forEach((h, i) =>
      issues.push(...validateHypothesisDraft(h, ctx, `spawned.${i}`)),
    );
    rev.retiredIds.forEach((id, i) => {
      if (!ctx.hypothesisIds.has(id))
        issues.push({
          code: "UNKNOWN_HYPOTHESIS",
          path: `retiredIds.${i}`,
          message: `Unknown hypothesis ${id}`,
        });
    });
    const touched = [
      ...rev.refined.map((h) => h.revisionOfId),
      ...rev.retiredIds,
    ];
    if (new Set(touched).size !== touched.length)
      issues.push({
        code: "CONFLICTING_REVISION",
        message: "A hypothesis cannot be refined and retired, or refined twice",
      });
    return issues;
  };
}

// ---------------------------------------------------------------------------
// Citation + stance integrity (R4 critique)

export interface CritiqueContext {
  hypothesisIds: ReadonlySet<string>;
  /** Evidence IDs per hypothesis in this experiment. */
  evidenceByHypothesis: ReadonlyMap<string, ReadonlySet<string>>;
}

export function critiqueValidator(
  ctx: CritiqueContext,
): Validator<CritiqueReport> {
  return (report) => {
    const issues: ValidationIssue[] = [];
    const seen = new Set<string>();
    report.perHypothesis.forEach((h, i) => {
      const path = `perHypothesis.${i}`;
      if (!ctx.hypothesisIds.has(h.hypothesisId)) {
        issues.push({
          code: "UNKNOWN_HYPOTHESIS",
          path,
          message: `Unknown hypothesis ${h.hypothesisId}`,
        });
        return;
      }
      if (seen.has(h.hypothesisId))
        issues.push({
          code: "DUPLICATE_HYPOTHESIS",
          path,
          message: "One entry per hypothesis",
        });
      seen.add(h.hypothesisId);
      const known =
        ctx.evidenceByHypothesis.get(h.hypothesisId) ?? new Set<string>();
      h.citedEvidenceIds.forEach((id, j) => {
        if (!known.has(id))
          issues.push({
            code: "UNKNOWN_CITATION",
            path: `${path}.citedEvidenceIds.${j}`,
            message: `Evidence ${id} does not belong to this hypothesis`,
          });
      });
      if ((h.confidenceNote || h.downgrade) && h.citedEvidenceIds.length === 0)
        issues.push({
          code: "MISSING_CITATION",
          path,
          message:
            "A confidence note or downgrade must cite at least one evidence ID",
        });
    });
    return issues;
  };
}

// ---------------------------------------------------------------------------
// Numeric fidelity (R5 narrative, R6 blueprint)

const PLACEHOLDER = /\{\{metric:[A-Za-z0-9_.-]+\}\}/g;
const NUMBER = /(?<![A-Za-z0-9_])-?\d+(?:[.,]\d+)*%?/g;

/** Every number in prose must be a provided value; computed numbers must use `{{metric:ID}}`. */
export function numericFidelityIssues(
  text: string,
  allowed: ReadonlySet<string>,
  path: string,
): ValidationIssue[] {
  const stripped = text.replace(PLACEHOLDER, " ");
  const issues: ValidationIssue[] = [];
  for (const match of stripped.matchAll(NUMBER)) {
    const raw = match[0].replace(/%$/, "");
    if (!allowed.has(raw) && !allowed.has(match[0]))
      issues.push({
        code: "UNGROUNDED_NUMBER",
        path,
        message: `Number "${match[0]}" is not a provided metric or evidence value; use a {{metric:ID}} placeholder`,
      });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Provenance labels (blueprint display text)

export function blueprintProvenanceValidator(
  evidenceIds: ReadonlySet<string>,
): Validator<BlueprintContent> {
  return (bp) => {
    const issues: ValidationIssue[] = [];
    bp.sections.forEach((s, i) =>
      s.blocks.forEach((b, j) => {
        const path = `sections.${i}.blocks.${j}`;
        if (
          b.provenance === "DEVELOPMENT_FIXTURE" ||
          b.provenance === "USER_PROVIDED"
        )
          issues.push({
            code: "PROVENANCE_LABEL",
            path,
            message: `${b.provenance} cannot be produced by the model`,
          });
        if (
          (b.provenance === "QLOO_SOURCED" || b.provenance === "APP_DERIVED") &&
          b.evidenceIds.length === 0
        )
          issues.push({
            code: "MISSING_CITATION",
            path,
            message: `${b.provenance} blocks must cite evidence`,
          });
        b.evidenceIds.forEach((id) => {
          if (!evidenceIds.has(id))
            issues.push({
              code: "UNKNOWN_CITATION",
              path,
              message: `Unknown evidence ${id}`,
            });
        });
      }),
    );
    return issues;
  };
}

// ---------------------------------------------------------------------------
// Safe use (all outputs)

const SENSITIVE_TERMS = [
  String.raw`race|racial|ethnic\w*|black|white|asian|latin[oax]|hispanic`,
  String.raw`religio\w*|muslims?|christians?|jewish|jews|hindus?|buddhists?|atheists?`,
  String.raw`gay|lesbian|bisexual|transgender|queer|lgbt\w*|sexual orientation`,
  String.raw`disab\w*|pregnan\w*|health|ill(?:ness)?|medical`,
  String.raw`political\w*|democrats?|republicans?|liberals?|conservatives?|immigra\w*`,
].join("|");

/** Patterns from the kit's SAFE_USE guidance: no individual inference, sensitive traits, eligibility, or causation. */
const SAFE_USE_RULES: { code: string; pattern: RegExp; message: string }[] = [
  {
    // Themes chosen by the user (a queer-cinema night) are fine; inferring or targeting
    // an audience's sensitive traits is not.
    code: "SENSITIVE_TRAIT",
    pattern: new RegExp(
      String.raw`(?:\b(?:audiences?|visitors|customers|fans|people|users|guests)\b[^.]{0,40}\b(?:are|is|tend to be|skew|likely)\b[^.]{0,30}|\b(?:target(?:ing)?|exclud\w*|filter(?:ing)? out|screen(?:ing)? out)\b[^.]{0,30})\b(?:${SENSITIVE_TERMS})\b`,
      "i",
    ),
    message: "Do not infer or target sensitive traits of an audience",
  },
  {
    code: "ELIGIBILITY",
    pattern:
      /\b(credit ?score|creditworth\w*|eligib\w* for (?:a )?(?:loan|credit|housing|employment|insurance|a job)|hiring decision|insurab\w*)\b/i,
    message: "Do not make high-impact eligibility judgements",
  },
  {
    code: "INDIVIDUAL_INFERENCE",
    pattern:
      /\b(?:(?:this|each|every|a|any) (?:specific )?(?:person|individual|customer|visitor|user) (?:is|will|would)(?: likely| probably)? (?:be|buy|attend|visit|like|love|enjoy)|probability (?:that|of) (?:a|an|each|this) (?:person|individual|customer)|\d+% (?:chance|likely) (?:that|of))\b/i,
    message:
      "Affinity is an aggregate signal; do not phrase it as an individual's behavior or probability",
  },
  {
    code: "CAUSATION",
    pattern:
      /\b(?:affinity|audience overlap|qloo data) (?:proves|causes|guarantees)\b|\bwill (?:definitely|certainly|guarantee(?:d)? to) (?:attract|sell|draw)\b/i,
    message: "Do not phrase affinity as causation or a guarantee",
  },
];

function collectStrings(
  value: unknown,
  path: string,
  out: { path: string; text: string }[],
): void {
  if (typeof value === "string") out.push({ path, text: value });
  else if (Array.isArray(value))
    value.forEach((v, i) =>
      collectStrings(v, path ? `${path}.${i}` : String(i), out),
    );
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value))
      collectStrings(v, path ? `${path}.${k}` : k, out);
}

export const safeUseValidator: Validator<unknown> = (value) => {
  const strings: { path: string; text: string }[] = [];
  collectStrings(value, "", strings);
  const issues: ValidationIssue[] = [];
  for (const { path, text } of strings)
    for (const rule of SAFE_USE_RULES)
      if (rule.pattern.test(text))
        issues.push({
          code: `SAFE_USE_${rule.code}`,
          path,
          message: rule.message,
        });
  return issues;
};
