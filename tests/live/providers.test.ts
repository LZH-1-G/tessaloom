import { execFile } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  GeminiProvider,
  LlmGateway,
  checkGeminiModel,
  geminiPrices,
} from "../../packages/llm-gateway/src";
import { qlooChildEnv } from "../../packages/qloo-adapter/src/transports/env";

const run = promisify(execFile);
// A receipt is claimed before calls, outside the repository. Reusing it refuses another run.
// It contains only approval/counter metadata; never keys, prompts or provider envelopes.
async function claimReceipt(provider: string) {
  const file = process.env.LIVE_VALIDATION_RECEIPT;
  if (!file || !path.isAbsolute(file))
    throw new Error("An absolute private LIVE_VALIDATION_RECEIPT is required");
  await writeFile(
    file,
    JSON.stringify({
      provider,
      startedAt: new Date().toISOString(),
      status: "started; outcome unknown until test completes",
    }) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return file;
}

it.skipIf(process.env.LIVE_VALIDATION_PROVIDER !== "gemini")(
  "opt-in Gemini contract: one metadata GET and one synthetic generation, zero retries",
  async () => {
    // Exactly one tier. Paid: explicit billing approval for this one call and a current
    // pricing review; the call costs well under one US cent at published rates.
    const paid = process.env.GEMINI_PAID_TIER_APPROVED === "on";
    if (
      paid === (process.env.GEMINI_FREE_TIER_CONFIRMED === "on") ||
      (!paid && process.env.GEMINI_DATA_SHARING_APPROVED !== "on") ||
      (paid && !process.env.GEMINI_PRICING_VERIFIED_AT)
    )
      throw new Error(
        "Confirm exactly one tier: Free with quota and synthetic-input sharing, or approved Paid with a pricing review",
      );
    const apiKey = process.env.GEMINI_API_KEY;
    const model = process.env.LLM_MODEL;
    if (!apiKey || !model)
      throw new Error("Private Gemini key and account-verified model required");
    const receipt = await claimReceipt("gemini");
    try {
      const metadata = await checkGeminiModel({ apiKey, model });
      const provider = new GeminiProvider({
        apiKey,
        model,
        ...(paid
          ? {
              paidTierApproved: true,
              pricingVerifiedAt: process.env.GEMINI_PRICING_VERIFIED_AT,
            }
          : { freeTierConfirmed: true, dataSharingApproved: true }),
        maxRequests: 1,
      });
      // This standalone probe has no DB/run; its one-call reservation is explicit and local.
      // Application experiments always use the DB SpendGuard; this probe is not an E2E run.
      let reserved = false;
      const gateway = new LlmGateway({
        provider,
        primaryModel: model,
        prices: () => geminiPrices(),
        maxRepairs: 0,
        maxOutputTokensCeiling: 256,
        spendGuard: {
          reserve: async () => {
            if (reserved)
              return {
                ok: false as const,
                code: "CAP",
                message: "One generation only",
              };
            reserved = true;
            return { ok: true as const, reservationId: "local-contract-probe" };
          },
          settle: async () => {},
        },
      });
      const result = await gateway.generate({
        role: "R1",
        promptId: "r1.intent",
        input: {
          synthetic: true,
          task: "Return the JSON object {answer: ok}. This is locally invented test input with no Qloo data.",
        },
        schema: z.object({ answer: z.literal("ok") }),
        effort: "low",
        maxOutputTokens: 256,
        ctx: {
          inputOrigin: "synthetic",
          projectId: "local-contract-probe",
          remainingCalls: 1,
          remainingOutputTokens: 256,
        },
      });
      await writeFile(
        receipt,
        JSON.stringify({
          provider: "gemini",
          billingTier: paid ? "paid" : "free",
          metadata,
          ok: result.ok,
          attempts: result.attempts,
          usage: result.usage,
          estimatedCostUsd: result.costUsd,
          modelId: result.modelId,
          inputOrigin: "SYNTHETIC_LOCAL",
          actualBilledCost: "not verified against provider billing",
        }) + "\n",
        { mode: 0o600 },
      );
      expect(result.ok, result.ok ? "" : result.reason).toBe(true);
    } catch {
      throw new Error(
        "Gemini live contract failed; do not retry without reviewing the receipt and quota",
      );
    }
  },
);

it.skipIf(process.env.LIVE_VALIDATION_PROVIDER !== "qloo")(
  "opt-in Qloo calibration: at most three HTTP GETs, zero retries, no raw retention",
  async () => {
    if (
      process.env.QLOO_QUOTA_CONFIRMED !== "on" ||
      process.env.QLOO_CALIBRATION_HTTP_CAP !== "3"
    )
      throw new Error(
        "Actual event quota and permission for three HTTP requests must be confirmed first",
      );
    const executable = process.env.QLOO_CALIBRATION_BIN;
    if (!executable || !path.isAbsolute(executable))
      throw new Error("Absolute path to audited Qloo Harness required");
    const bin = await realpath(executable);
    const pkg = JSON.parse(
      await readFile(
        path.resolve(path.dirname(bin), "../package.json"),
        "utf8",
      ),
    );
    expect({ name: pkg.name, version: pkg.version }).toEqual({
      name: "@qloo/qloo-harness",
      version: "0.1.26",
    });
    const receipt = await claimReceipt("qloo");
    const summaries: {
      query: string;
      count: number;
      fields: string[];
      types: string[];
    }[] = [];
    let reservedHttpSlots = 0;
    try {
      // No workflow fan-out: each CLI child is limited at fetch to one search GET.
      for (const [query, type] of [
        ["Agatha Christie", "book"],
        ["Lisbon", "locality"],
        ["Murder on the Orient Express", "book"],
      ]) {
        reservedHttpSlots++;
        const { stdout } = await run(
          process.execPath,
          [
            "--import",
            path.resolve("scripts/qloo-calibration-guard.mjs"),
            bin,
            "api",
            "search",
            "--query",
            query!,
            "--type",
            type!,
            "--take",
            "2",
            "--json",
          ],
          {
            env: {
              ...qlooChildEnv(process.env),
              HOME: homedir(),
              QLOO_BASE_URL: "https://hackathon.api.qloo.com",
              QLOO_TRUSTED_BASE_URL: "https://hackathon.api.qloo.com",
              TESSALOOM_CALIBRATION_CHILD: "1",
            },
            timeout: 20_000,
            maxBuffer: 2 * 1024 * 1024,
          },
        );
        const data: unknown = JSON.parse(stdout);
        if (!Array.isArray(data)) throw new Error();
        summaries.push({
          query: query!,
          count: data.length,
          fields: [
            ...new Set(data.flatMap((item) => Object.keys(item))),
          ].sort(),
          types: [
            ...new Set(
              data.flatMap((item) =>
                Array.isArray(item.types)
                  ? item.types.filter(
                      (t: unknown): t is string =>
                        typeof t === "string" && /^urn:entity:[a-z_]+$/.test(t),
                    )
                  : [],
              ),
            ),
          ] as string[],
        });
      }
      await writeFile(
        receipt,
        JSON.stringify({
          provider: "qloo",
          status: "completed",
          reservedHttpSlots,
          maxHttpRequests: 3,
          summaries,
          rawRetention: false,
        }) + "\n",
        { mode: 0o600 },
      );
    } catch {
      await writeFile(
        receipt,
        JSON.stringify({
          provider: "qloo",
          status: "failed; stopped without retry",
          reservedHttpSlots,
          maxHttpRequests: reservedHttpSlots,
          rawRetention: false,
        }) + "\n",
        { mode: 0o600 },
      );
      throw new Error(
        "Qloo calibration failed; raw output suppressed; no automatic retry",
      );
    }
  },
);
