"""Set APP_ENV and QLOO_MODE on the tessaloom service without printing any value.

Usage: python3 deploy/northflank-service-mode.py staging synthetic   # judge demo
       python3 deploy/northflank-service-mode.py production live     # closed production

Reads the service's OWN variables only (`--show this`; group and addon variables are never
copied), refuses if their names differ from the six expected, changes two values, writes the
body to a 0600 temporary file, applies it (this restarts the service) and deletes the file.
"""
import json, os, subprocess, sys, tempfile

app_env, qloo_mode = sys.argv[1], sys.argv[2]
assert (app_env, qloo_mode) in (("staging", "synthetic"), ("production", "live"))
EXPECTED = {"APP_ENV", "HOSTNAME", "NODE_ENV", "PORT", "QLOO_API_KEY", "QLOO_MODE"}
GET = ["northflank", "get", "service", "runtime-environment", "--project", "default",
       "--service", "tessaloom", "--show", "this", "-o", "json"]


def own_env():
    data = json.loads(subprocess.run(GET, capture_output=True, text=True, check=True).stdout)
    data = data.get("data", data)
    return data["runtimeEnvironment"], data.get("runtimeFiles") or {}


env, files = own_env()
if set(env) != EXPECTED or files:
    sys.exit(f"Refusing: unexpected service-level names {sorted(env)} / files {sorted(files)}")
before = {"APP_ENV": env["APP_ENV"], "QLOO_MODE": env["QLOO_MODE"]}
env["APP_ENV"], env["QLOO_MODE"] = app_env, qloo_mode
fd, path = tempfile.mkstemp(suffix=".json")
try:
    with os.fdopen(fd, "w") as f:
        json.dump({"runtimeEnvironment": env, "runtimeFiles": {}}, f)
    os.chmod(path, 0o600)
    out = subprocess.run(
        ["northflank", "update", "service", "runtime-environment", "--project", "default",
         "--service", "tessaloom", "--file", path, "--quiet", "-o", "json"],
        capture_output=True, text=True)
finally:
    os.unlink(path)
if out.returncode != 0:
    sys.exit(f"update failed (exit {out.returncode})")
after, _ = own_env()
print("before:", before)
print("after:", {"APP_ENV": after.get("APP_ENV"), "QLOO_MODE": after.get("QLOO_MODE")})
print("service-level names:", sorted(after))
