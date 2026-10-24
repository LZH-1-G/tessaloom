/** One-shot isolated worker; never imported by an application entrypoint. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import {
  createDb,
  sql,
  getRun,
  revokeDemoGrant,
  reserveLlmSpend,
} from "../../packages/db/src";
import {
  createLlmGateway,
  createSpendGuard,
  createDbLlmRecorder,
  spendLimitsForProvider,
  type LlmSettings,
} from "../../apps/worker/src/llm";
import { createScriptedDemoProvider } from "../../apps/worker/src/scripted-llm";
import {
  DeepSeekProvider,
  LlmGateway,
  deepseekUsdPrices,
} from "../../packages/llm-gateway/src";
import {
  generationCase,
  critiqueCase,
  QUALITY_PLAN,
} from "../fixtures/deepseek-quality";
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const packet = JSON.parse((await lines.next()).value!);
const emit = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + "\n");
const approval = { usdPerCny: 0.2, verifiedAt: packet.verifiedAt as string };
assert.equal(process.getuid?.(), 10002);
assert(process.env.DEEPSEEK_API_KEY);
assert.equal(packet.mode === "offline" || packet.mode === "live", true);
const settings: LlmSettings = {
  LLM_PROVIDER: "deepseek",
  LLM_MODEL: QUALITY_PLAN.model,
  LLM_FALLBACK_MODEL: QUALITY_PLAN.model,
  LLM_MODE: "standard",
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  DEEPSEEK_LIVE_APPROVED: "on",
  DEEPSEEK_MAX_REQUESTS: 2,
  DEEPSEEK_BUDGET_CNY: 2,
  DEEPSEEK_USD_PER_CNY: 0.2,
  DEEPSEEK_PRICING_VERIFIED_AT: approval.verifiedAt,
  QLOO_MODE: "synthetic",
};
const handle = createDb(packet.databaseUrl, {
  max: 2,
  applicationName: "deepseek-bounded-quality-worker",
});
let requests = 0;
const observations: Record<string, unknown>[] = [];
try {
  deepseekUsdPrices(approval);
  assert.throws(() => deepseekUsdPrices({ ...approval, usdPerCny: NaN }));
  assert.throws(() =>
    deepseekUsdPrices({
      ...approval,
      verifiedAt: new Date(Date.now() - 86400001).toISOString(),
    }),
  );
  const limits = spendLimitsForProvider(settings, {
    access: "invite",
    globalDailyUsd: 0.4,
    workspaceDailyUsd: 0.4,
    experimentUsd: 0.4,
  });
  assert.deepEqual(limits, {
    access: "invite",
    globalDailyUsd: 0.4,
    workspaceDailyUsd: 0.4,
    experimentUsd: 0.4,
  });
  assert.equal(
    spendLimitsForProvider({ ...settings, DEEPSEEK_USD_PER_CNY: NaN }, limits)
      .access,
    "off",
  );
  const run = await getRun(handle.db, packet.runId);
  assert.equal((run.budget as { maxLlmCalls: number }).maxLlmCalls, 2);
  assert.equal(
    (run.budget as { maxLlmOutputTokens: number }).maxLlmOutputTokens,
    16384,
  );
  assert.equal(
    (run.budget as { maxEstimatedCostUsd: number }).maxEstimatedCostUsd,
    0.4,
  );
  const denied = await reserveLlmSpend(handle, {
    runId: packet.runId,
    model: QUALITY_PLAN.model,
    upperBoundUsd: 0.081101,
    maxOutputTokens: 8192,
    limits: { ...limits, access: "off" },
  });
  assert.equal(denied.ok, false);
  const absent = await handle.db.execute<{ n: string }>(
    sql`SELECT count(*) AS n FROM llm_spend_reservations WHERE run_id=${packet.runId}`,
  );
  assert.equal(Number(absent.rows[0]!.n), 0);
  const baseline = new LlmGateway({
    provider: createScriptedDemoProvider(),
    primaryModel: "scripted-demo",
    allowUnpricedModels: true,
  });
  const baselineFirst = await baseline.generate({
    ...generationCase,
    ctx: { projectId: packet.projectId },
  });
  const baselineSecond = await baseline.generate({
    ...critiqueCase,
    ctx: { projectId: packet.projectId },
  });
  assert(baselineFirst.ok && baselineSecond.ok);
  const baselineValues = [baselineFirst.value, baselineSecond.value];
  const transport: typeof fetch = async (url, init) => {
    assert.equal(String(url), "https://api.deepseek.com/responses");
    assert.equal(init?.method, "POST");
    assert.equal(init.redirect, "error");
    assert(requests < 2);
    const body = String(init.body),
      bytes = Buffer.byteLength(body),
      hash = createHash("sha256").update(body).digest("hex");
    const parsed = JSON.parse(body);
    assert(bytes <= 16384);
    assert.equal(parsed.model, QUALITY_PLAN.model);
    assert.equal(parsed.max_output_tokens, 8192);
    assert.equal(parsed.stream, false);
    assert.equal(parsed.text.format.type, "json_schema");
    assert.equal(parsed.reasoning.effort, "low");
    assert.equal(parsed.tools, undefined);
    if (packet.mode === "live") assert.equal(hash, packet.bodyHashes[requests]);
    const attempt = ++requests;
    const observation: Record<string, unknown> = {
      attempt,
      requestBytes: bytes,
      requestHash: hash,
      startedAt: new Date().toISOString(),
    };
    observations.push(observation);
    emit({ event: "dispatch", ...observation, mode: packet.mode });
    if (packet.mode === "offline")
      return new Response(
        JSON.stringify({
          model: QUALITY_PLAN.model,
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify(baselineValues[attempt - 1]),
                },
              ],
            },
          ],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            total_tokens: 150,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 10 },
          },
        }),
      );
    const response = await fetch(url, init);
    observation.httpStatus = response.status;
    // Capture only documented numerical usage fields, never raw reasoning or HTTP errors.
    const raw = await response.clone().text();
    assert(Buffer.byteLength(raw) <= 2 * 1024 * 1024);
    try {
      const json = JSON.parse(raw);
      const usage = json.usage;
      observation.providerReportedCostCny =
        typeof usage?.cost_cny === "number" && Number.isFinite(usage.cost_cny)
          ? usage.cost_cny
          : null;
      observation.providerReportedModel =
        typeof json.model === "string" ? json.model.slice(0, 80) : null;
      observation.providerUsage = usage
        ? {
            inputTokens: usage.input_tokens,
            cachedInputTokens: usage.input_tokens_details?.cached_tokens,
            outputTokens: usage.output_tokens,
            reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
            totalTokens: usage.total_tokens,
          }
        : null;
    } catch {
      observation.usageUnavailable = true;
    }
    return response;
  };
  const provider = new DeepSeekProvider({
    apiKey: process.env.DEEPSEEK_API_KEY!,
    liveApproved: true,
    priceApproval: approval,
    maxRequests: 2,
    budgetCny: 2,
    maxInputBytes: 16384,
    maxOutputTokens: 8192,
    timeoutMs: 60000,
    fetch: transport,
  });
  const gateway = createLlmGateway(
    settings,
    createDbLlmRecorder(handle.db),
    provider,
    createSpendGuard(handle, limits),
  );
  assert(gateway);
  emit({
    event: "ready",
    workerKeyLoaded: true,
    workerUid: process.getuid?.(),
    workerPid: process.pid,
    pricingAndLedgerChecked: true,
    mode: packet.mode,
  });
  assert.equal(
    (await lines.next()).value,
    "EXECUTE_TWO_APPROVED_SYNTHETIC_CASES",
  );
  const ctx = {
    projectId: packet.projectId,
    runId: packet.runId,
    inputOrigin: "synthetic" as const,
    remainingUsd: 0.4,
    remainingCalls: 2,
    remainingOutputTokens: 16384,
  };
  const first = await gateway.generate({ ...generationCase, ctx });
  emit({
    event: "result",
    case: "R3-generation",
    result: first,
    observation: observations[0] ?? null,
  });
  if (first.ok) {
    const second = await gateway.generate({
      ...critiqueCase,
      ctx: {
        ...ctx,
        remainingUsd: 0.4 - first.costUsd,
        remainingCalls: 1,
        remainingOutputTokens: 16384 - first.usage.outputTokens,
      },
    });
    emit({
      event: "result",
      case: "R4-critique",
      result: second,
      observation: observations[1] ?? null,
    });
  }
  const ledger = await handle.db.execute(
    sql`SELECT model, status, reserved_micros, actual_micros FROM llm_spend_reservations WHERE run_id=${packet.runId} ORDER BY created_at,id`,
  );
  emit({
    event: "complete",
    requests,
    ledger: ledger.rows,
    scriptedBaseline: baselineValues,
    mode: packet.mode,
  });
} catch {
  emit({ event: "trial_stopped", requests, detailsSuppressed: true });
  process.exitCode = 1;
} finally {
  await revokeDemoGrant(handle.db, packet.grantId);
  await handle.db.execute(
    sql`UPDATE agent_runs SET state='CANCELLED',cancel_requested_at=now() WHERE id=${packet.runId}`,
  );
  await handle.close();
  process.exit();
}
