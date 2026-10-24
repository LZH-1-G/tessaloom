/** Explicit one-shot authorization harness. No web server and no key in Docker metadata. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
const [mode, configFile, receiptFile, verifiedAt, proofFile] =
  process.argv.slice(2);
assert(["--offline", "--execute-authorized-two-calls"].includes(mode));
for (const p of [configFile, receiptFile])
  assert(p?.startsWith("/private/tmp/tessaloom-deepseek-"));
const live = mode === "--execute-authorized-two-calls";
const packet = JSON.parse(readFileSync(configFile, "utf8"));
packet.mode = live ? "live" : "offline";
packet.verifiedAt = verifiedAt;
assert(
  Date.now() - Date.parse(verifiedAt) >= 0 &&
    Date.now() - Date.parse(verifiedAt) < 3600000,
);
if (live) {
  assert(proofFile?.startsWith("/private/tmp/tessaloom-deepseek-"));
  const proof = readFileSync(proofFile, "utf8")
    .trim()
    .split("\n")
    .map((v) => JSON.parse(v));
  assert(proof.some((v) => v.event === "isolation_verified"));
  assert(
    proof.some(
      (v) => v.event === "complete" && v.requests === 2 && v.mode === "offline",
    ),
  );
  const results = proof.filter((v) => v.event === "result");
  assert.equal(results.length, 2);
  assert(results.every((v) => v.result.ok));
  packet.bodyHashes = proof
    .filter((v) => v.event === "dispatch")
    .map((v) => v.requestHash);
  assert.equal(packet.bodyHashes.length, 2);
}
let credential = "offline-isolation-test-sentinel";
if (live) {
  const dir = path.join(homedir(), ".config/tessaloom"),
    file = path.join(dir, "deepseek.env");
  const d = lstatSync(dir),
    f = lstatSync(file);
  assert(
    d.isDirectory() && !d.isSymbolicLink() && f.isFile() && !f.isSymbolicLink(),
  );
  assert.equal(d.mode & 0o777, 0o700);
  assert.equal(f.mode & 0o777, 0o600);
  assert.equal(f.uid, process.getuid());
  credential = parseEnv(readFileSync(file, "utf8")).DEEPSEEK_API_KEY;
  assert(credential);
}
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20000,
  }).trim();
assert(!process.env.DOCKER_HOST);
assert(
  docker(
    "context",
    "inspect",
    "--format",
    "{{.Endpoints.docker.Host}}",
  ).startsWith("unix://"),
);
const imageId = docker(
  "image",
  "inspect",
  "tessaloom:live-provider-validation",
  "--format",
  "{{.Id}}",
);
assert.equal(
  imageId,
  "sha256:27e84debd59a68d27b9cb284611595c0b325b842f453d4ec20ce6829d6901d8b",
);
const bundle = readFileSync(
  "/private/tmp/tessaloom-deepseek-trial-worker.mjs",
  "utf8",
);
const receipt = openSync(receiptFile, "wx", 0o600); // Never reuse this authorization after uncertainty/crash.
const record = (v) => {
  const line = JSON.stringify(v);
  assert(!line.includes(credential));
  writeSync(receipt, line + "\n");
  fsyncSync(receipt);
  console.log(line);
};
const bootstrap = `(async()=>{
 const fs=require('node:fs'),{spawn}=require('node:child_process'),{createInterface}=require('node:readline');
 const {buildChildEnv}=await import('/app/scripts/start.mjs');
 const lines=createInterface({input:process.stdin})[Symbol.asyncIterator]();
 const packet=JSON.parse((await lines.next()).value);
 fs.chmodSync('/run/worker-private',0o700);fs.chownSync('/run/worker-private',10002,10002);
 const secret='/run/worker-private/deepseek.env';fs.writeFileSync(secret,'DEEPSEEK_API_KEY='+JSON.stringify(packet.key)+'\\n',{mode:0o600});fs.chownSync(secret,10002,10002);
 fs.writeFileSync('/run/worker-code/trial.mjs',packet.bundle,{mode:0o644});
 const child=spawn(process.execPath,['--env-file='+secret,'/run/worker-code/trial.mjs'],{uid:10002,gid:10002,env:buildChildEnv('worker',{APP_ENV:'test',QLOO_MODE:'synthetic',RUN_ACCESS:'invite'}),stdio:['pipe','pipe','ignore']});
 child.stdout.pipe(process.stdout);child.on('exit',code=>process.exit(code??1));
 child.stdin.write(JSON.stringify(packet.config)+'\\n');
 const go=(await lines.next()).value; if(go!=='EXECUTE_TWO_APPROVED_SYNTHETIC_CASES')process.exit(2);
 child.stdin.end(go+'\\n');
})().catch(()=>{process.stdout.write(JSON.stringify({event:'bootstrap_failed'})+'\\n');process.exit(3);});`;
let container, attached, timer;
try {
  record({
    event: "authorization_claimed",
    live,
    model: "deepseek-v4-pro",
    maxRequests: 2,
    retries: 0,
    budgetCny: 2,
    verifiedAt,
    imageId,
  });
  container = docker(
    "create",
    "--network",
    "bridge",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "CHOWN",
    "--cap-add",
    "DAC_OVERRIDE",
    "--cap-add",
    "SETUID",
    "--cap-add",
    "SETGID",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "32",
    "--memory",
    "512m",
    "--cpus",
    "1",
    "--restart",
    "no",
    "--tmpfs",
    "/run/worker-private:rw,noexec,nosuid,size=64k,mode=0700",
    "--tmpfs",
    "/run/worker-code:rw,noexec,nosuid,size=16m,mode=0755",
    "-i",
    imageId,
    "node",
    "-e",
    bootstrap,
  );
  const info = JSON.parse(docker("inspect", container))[0];
  assert.equal(info.HostConfig.ReadonlyRootfs, true);
  assert.equal(info.HostConfig.RestartPolicy.Name, "no");
  assert.equal((info.HostConfig.Binds ?? []).length, 0);
  assert.equal(Object.keys(info.HostConfig.PortBindings ?? {}).length, 0);
  assert(!(info.Config.Env ?? []).some((v) => /API_KEY=/.test(v)));
  attached = spawn("docker", ["start", "-ai", container], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  let output = "",
    readyResolve,
    readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const finished = new Promise((resolve, reject) => {
    attached.once("error", () => reject(new Error("worker start failed")));
    attached.once("exit", (code) => {
      readyReject(new Error("worker exited before readiness"));
      resolve(code);
    });
  });
  attached.stdout.on("data", (chunk) => {
    output += chunk.toString();
    if (output.length > 1000000 || output.includes(credential)) {
      readyReject(new Error("unsafe output"));
      attached.kill();
      return;
    }
    let n;
    while ((n = output.indexOf("\n")) >= 0) {
      const line = output.slice(0, n);
      output = output.slice(n + 1);
      try {
        const event = JSON.parse(line);
        record(event);
        if (event.event === "ready") readyResolve(event);
      } catch {
        readyReject(new Error("invalid worker output"));
        attached.kill();
      }
    }
  });
  attached.stdin.write(
    JSON.stringify({ key: credential, bundle, config: packet }) + "\n",
  );
  timer = setTimeout(() => {
    readyReject(new Error("deadline"));
    attached.kill();
  }, 180000);
  const state = await ready;
  assert(state.workerKeyLoaded && state.pricingAndLedgerChecked);
  assert.equal(state.workerUid, 10002);
  assert(Number.isSafeInteger(state.workerPid));
  const web = JSON.parse(
    docker(
      "exec",
      "--user",
      "10001:10001",
      container,
      "node",
      "-e",
      `const fs=require('node:fs');function denied(p){try{fs.readFileSync(p);return false}catch(e){return ['EACCES','EPERM'].includes(e.code)}}console.log(JSON.stringify({keyAbsent:!process.env.DEEPSEEK_API_KEY,fileDenied:denied('/run/worker-private/deepseek.env'),procDenied:denied('/proc/${state.workerPid}/environ'),hostAbsent:!fs.existsSync('/Users/lzh/.config/tessaloom')}))`,
    ),
  );
  assert(Object.values(web).every((v) => v === true));
  assert(!docker("logs", container).includes(credential));
  record({
    event: "isolation_verified",
    ...web,
    workerUid: 10002,
    webUid: 10001,
    noPublishedPorts: true,
    noHostMounts: true,
  });
  attached.stdin.end("EXECUTE_TWO_APPROVED_SYNTHETIC_CASES\n");
  assert.equal(await finished, 0);
} catch {
  record({ event: "host_stopped", detailsSuppressed: true });
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  if (container) {
    try {
      docker("rm", "-f", container);
    } catch {
      process.exitCode = 1;
    }
  }
  attached?.kill();
  closeSync(receipt);
}
