// Offline only: no provider module is imported; Docker network is unconditionally disabled.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";

const privateDir = path.join(homedir(), ".config/tessaloom");
const privateFile = path.join(privateDir, "deepseek.env");
const dirStat = lstatSync(privateDir);
const fileStat = lstatSync(privateFile);
assert(dirStat.isDirectory() && !dirStat.isSymbolicLink());
assert(fileStat.isFile() && !fileStat.isSymbolicLink());
assert.equal(dirStat.mode & 0o777, 0o700);
assert.equal(fileStat.mode & 0o777, 0o600);
assert.equal(fileStat.uid, process.getuid());
const credential = process.argv.includes("--sentinel")
  ? "offline-isolation-test-sentinel"
  : parseEnv(readFileSync(privateFile, "utf8")).DEEPSEEK_API_KEY;
assert(Boolean(credential), "Named credential missing");
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20_000,
  }).trim();
// Never forward the credential to a remote Docker daemon through an environment override.
assert(
  !process.env.DOCKER_HOST,
  "Docker host override is not allowed for this local probe",
);
const endpoint = docker(
  "context",
  "inspect",
  "--format",
  "{{.Endpoints.docker.Host}}",
);
assert(
  endpoint.startsWith("unix://"),
  "A local Docker Unix socket is required",
);
const imageId = docker(
  "image",
  "inspect",
  "tessaloom:live-provider-validation",
  "--format",
  "{{.Id}}",
);
assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
const workerCode = `
const fs = require('node:fs');
const loaded = Boolean(process.env.DEEPSEEK_API_KEY);
process.stdout.write(JSON.stringify({workerKeyLoaded:loaded,workerUid:process.getuid(),workerPid:process.pid,liveDisabled:process.env.DEEPSEEK_LIVE_APPROVED==='off'})+'\\n');
if (!loaded) process.exit(1);
setInterval(()=>{},1000);
`;
const bootstrap = `
(async()=>{
 const fs=require('node:fs'); const {spawn}=require('node:child_process');
 const {buildChildEnv}=await import('/app/scripts/start.mjs');
 let raw=''; for await(const chunk of process.stdin) { raw+=chunk; if(raw.includes('\\n')) break; }
 const key=JSON.parse(raw).DEEPSEEK_API_KEY; raw='';
 if(typeof key!=='string'||!key) process.exit(2);
 const secret='/run/worker-private/deepseek.env';
 fs.chmodSync('/run/worker-private',0o700);
 fs.chownSync('/run/worker-private',10002,10002);
 fs.writeFileSync(secret,'DEEPSEEK_API_KEY='+JSON.stringify(key)+'\\n',{mode:0o600});
 fs.chownSync(secret,10002,10002);
 const child=spawn(process.execPath,['--env-file='+secret,'-e',${JSON.stringify(workerCode)}],{uid:10002,gid:10002,env:buildChildEnv('worker',{APP_ENV:'test',QLOO_MODE:'synthetic',RUN_ACCESS:'off',DEEPSEEK_LIVE_APPROVED:'off'}),stdio:['ignore','pipe','ignore']});
 child.stdout.pipe(process.stdout);
 child.on('exit',code=>process.exit(code??1));
})().catch(error=>{process.stdout.write(JSON.stringify({bootstrapFailed:true,errorCode:error.code??'UNKNOWN',errorName:error.name})+'\\n');process.exit(3);});
`;
let container;
let attached;
let stage = "create";
try {
  container = docker(
    "create",
    "--network",
    "none",
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
    "256m",
    "--cpus",
    "1",
    "--restart",
    "no",
    "--tmpfs",
    "/run/worker-private:rw,noexec,nosuid,size=64k,mode=0700",
    "-i",
    imageId,
    "node",
    "-e",
    bootstrap,
  );
  stage = "start";
  attached = spawn("docker", ["start", "-ai", container], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const state = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error("Offline worker startup timed out")),
      15000,
    );
    attached.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Offline worker startup failed"));
    });
    attached.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.length > 2000) {
        clearTimeout(timer);
        reject(new Error("Unexpected offline probe output"));
        return;
      }
      if (output.includes("\n")) {
        clearTimeout(timer);
        try {
          const status = JSON.parse(output.split("\n")[0]);
          if (status.bootstrapFailed)
            stage = "bootstrap-" + status.errorName + "-" + status.errorCode;
          resolve(status);
        } catch {
          reject(new Error("Invalid offline probe status"));
        }
      }
    });
    attached.stdin.end(JSON.stringify({ DEEPSEEK_API_KEY: credential }) + "\n");
  });
  if (!state.bootstrapFailed) stage = "worker-status";
  assert.equal(state.workerKeyLoaded, true);
  assert.equal(state.workerUid, 10002);
  assert.equal(state.liveDisabled, true);
  assert(Number.isSafeInteger(state.workerPid) && state.workerPid > 0);
  stage = "web-probe";
  const web = JSON.parse(
    docker(
      "exec",
      "--user",
      "10001:10001",
      container,
      "node",
      "-e",
      `
    const fs=require('node:fs');
    function denied(p){try{fs.readFileSync(p);return false;}catch(e){return ['EACCES','EPERM'].includes(e.code);}}
    const status={webUid:process.getuid(),webCredentialAbsent:!process.env.DEEPSEEK_API_KEY,
      secretFileDenied:denied('/run/worker-private/deepseek.env'),workerEnvironmentDenied:denied('/proc/${state.workerPid}/environ'),
      hostPrivateDirectoryAbsent:!fs.existsSync(${JSON.stringify(`${homedir()}/.config/tessaloom`)})};
    console.log(JSON.stringify(status));
  `,
    ),
  );
  assert.equal(web.webUid, 10001);
  for (const key of [
    "webCredentialAbsent",
    "secretFileDenied",
    "workerEnvironmentDenied",
    "hostPrivateDirectoryAbsent",
  ])
    assert.equal(web[key], true);
  stage = "container-config";
  const info = JSON.parse(docker("inspect", container))[0];
  assert.equal(info.HostConfig.NetworkMode, "none");
  assert.equal(info.HostConfig.ReadonlyRootfs, true);
  assert.equal(info.HostConfig.RestartPolicy.Name, "no");
  assert.equal(Object.keys(info.HostConfig.PortBindings ?? {}).length, 0);
  assert.equal((info.HostConfig.Binds ?? []).length, 0);
  assert(
    !(info.Config.Env ?? []).some((v) => v.startsWith("DEEPSEEK_API_KEY=")),
  );
  assert(!docker("logs", container).includes(credential));
  console.log(
    JSON.stringify({
      event: "deepseek_offline_isolation_passed",
      imageId,
      workerKeyLoaded: true,
      workerUid: 10002,
      webUid: 10001,
      webCredentialAbsent: true,
      secretFileDenied: true,
      workerEnvironmentDenied: true,
      hostMountsAbsent: true,
      network: "none",
      publishedPorts: 0,
      restart: "no",
      credentialAbsentFromDockerConfig: true,
      credentialAbsentFromLogs: true,
      paidCalls: 0,
    }),
  );
} catch {
  // Never surface child-process error objects, stdout or stderr: they may contain private data.
  console.error(
    `DeepSeek offline isolation verification failed at ${stage}; details suppressed.`,
  );
  process.exitCode = 1;
} finally {
  if (container) {
    try {
      docker("rm", "-f", container);
    } catch {
      process.exitCode = 1;
    }
  }
  attached?.kill();
}
