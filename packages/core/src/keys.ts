import { canonicalize } from "./jcs";
import { sha256Hex } from "./sha256";
import { ExperimentDefinition } from "./schemas/experiment";

/** sha256 hex of the RFC 8785 canonical JSON of `value`. */
export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

export const contentHash = canonicalHash;

/**
 * Deterministic experiment key (AGENT_WORKFLOW §14.1). Seeds are order-normalized so that
 * equivalent definitions always share one key; the definition is validated first.
 */
export function experimentKey(definition: ExperimentDefinition): string {
  const parsed = ExperimentDefinition.parse(definition);
  const seeds = [...parsed.seeds].sort((a, b) =>
    canonicalize([a.qlooId, a.kind, a.role]) <
    canonicalize([b.qlooId, b.kind, b.role])
      ? -1
      : 1,
  );
  const tagConstraints = [...parsed.variables.tagConstraints].sort();
  const targetDomains = [...parsed.variables.targetDomains].sort();
  return canonicalHash({
    ...parsed,
    seeds,
    variables: { ...parsed.variables, tagConstraints, targetDomains },
  });
}

/** Cache identity of one harness call (API_CONTRACTS §6.5). */
export function requestHash(input: {
  workflow: string;
  args: unknown;
  harnessVersion: string;
}): string {
  return canonicalHash({
    workflow: input.workflow,
    args: input.args,
    harnessVersion: input.harnessVersion,
  });
}
