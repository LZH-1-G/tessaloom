import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

const moduleUrl = new URL("../../scripts/smoke-poll.mjs", import.meta.url).href;
// A real ESM child is essential: Vitest's own handles mask Node exit 13.
function child(source) {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import { until, hasStatus, failureSummary } from ${JSON.stringify(moduleUrl)};
    ${source}
  `,
    ],
    { encoding: "utf8", timeout: 3_000 },
  );
}

it("keeps an otherwise handle-free probe alive through its unreferenced abort and retries sequentially", () => {
  const result = child(`
    let attempts = 0;
    let active = 0;
    await until(async () => {
      assert.equal(++active, 1);
      try {
        if (++attempts === 2) return true;
        await new Promise((_, reject) => {
          const signal = AbortSignal.timeout(30);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        return false;
      } finally { active--; }
    }, { label: 'startup', timeoutMs: 1_000, intervalMs: 10 });
    assert.equal(attempts, 2);
    console.log('ready');
  `);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("ready");
  expect(result.stderr).not.toContain("unsettled top-level await");
});

it("bounds a never-settling probe, aborts it, and reaches failure cleanup instead of exit 13", () => {
  const result = child(`
    let signal;
    try {
      await until((context) => {
        signal = context.signal;
        return new Promise(() => {}); // Deliberately ignores abort.
      }, { label: 'application startup', timeoutMs: 60 });
      assert.fail('unexpected success');
    } catch (error) {
      assert.equal(error.name, 'SmokeTimeoutError');
      assert.equal(error.attempts, 1);
      assert.equal(error.lastOutcome, 'pending');
      assert(error.elapsedMs >= 50 && error.elapsedMs < 2_000);
      console.log(JSON.stringify(error));
      process.exitCode = 1;
    } finally {
      assert(signal.aborted);
      console.log('cleanup reached');
    }
  `);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(1);
  expect(result.stdout).toContain('"label":"application startup"');
  expect(result.stdout).toContain("cleanup reached");
  expect(result.stderr).not.toContain("unsettled top-level await");
});

it("releases the deadline timer immediately on success", () => {
  const result = child(`
    let signal;
    await until((context) => { signal = context.signal; return true; },
      { label: 'ready', timeoutMs: 60_000 });
    assert(signal.aborted);
  `);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0); // A leaked 60s timer hits the 3s parent timeout.
});

it("does not treat repeated false results as readiness", () => {
  const result = child(`
    await assert.rejects(until(() => false,
      { label: 'not ready', timeoutMs: 60, intervalMs: 10 }), error => {
      assert.equal(error.name, 'SmokeTimeoutError');
      assert.equal(error.lastOutcome, 'false');
      assert(error.attempts >= 2);
      return true;
    });
  `);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});

it("reports safe error codes without subprocess arguments, output or credentials", () => {
  const result = child(`
    const failure = Object.assign(new Error('Bearer private-probe-token'), {
      code: 'ECONNREFUSED', stdout: 'private-probe-token',
      stderr: 'private-probe-token', spawnargs: ['private-probe-token'],
    });
    await assert.rejects(until(() => { throw failure; },
      { label: 'startup', timeoutMs: 60, intervalMs: 10 }), error => {
      assert.deepEqual(error.lastFailure, { name: 'Error', code: 'ECONNREFUSED' });
      console.log(JSON.stringify(error));
      return true;
    });
  `);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("ECONNREFUSED");
  expect(result.stdout + result.stderr).not.toContain("private-probe-token");
});

it("bounds a stalled real HTTP response and releases its socket on deadline", () => {
  const result = child(`
    const { createServer } = await import('node:http');
    const server = createServer(() => {});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port;
    try {
      await assert.rejects(until(({signal}) => hasStatus(url, 200, signal),
        { label: 'HTTP stall', timeoutMs: 100 }), { name: 'SmokeTimeoutError' });
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  `);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});

it("requires the exact HTTP readiness status after transient unavailability", () => {
  const result = child(`
    const { createServer } = await import('node:http');
    let requests = 0;
    const server = createServer((_, response) => {
      response.writeHead(++requests === 1 ? 503 : 200);
      response.end('fixture-only response');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port;
    try {
      await until(({signal}) => hasStatus(url, 200, signal),
        { label: 'HTTP readiness', timeoutMs: 1_000, intervalMs: 10 });
      assert.equal(requests, 2);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  `);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});

it("bounds synchronous subprocess probes by the remaining deadline", () => {
  const result = child(`
    const { execFileSync } = await import('node:child_process');
    await assert.rejects(until(({remainingMs}) => {
      execFileSync(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        timeout: remainingMs(), killSignal: 'SIGKILL', stdio: 'ignore',
      });
      return true;
    }, { label: 'subprocess', timeoutMs: 80 }), { name: 'SmokeTimeoutError' });
  `);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});
