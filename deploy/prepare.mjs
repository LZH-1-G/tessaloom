import { mkdirSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";

// Local preparation only. Refuses existing directories; never rotates existing secrets.
const destination = process.argv[2];
if (!destination || !path.isAbsolute(destination))
  throw new Error("Provide a NEW absolute private directory");
mkdirSync(destination, { mode: 0o700 });
for (const name of [
  "postgres_password",
  "migrator_password",
  "app_password",
  "session_secret",
  "share_token_pepper",
])
  writeFileSync(
    path.join(destination, name),
    randomBytes(32).toString("hex") + "\n",
    { mode: 0o600, flag: "wx" },
  );
for (const name of ["qloo_key", "anthropic_key"])
  writeFileSync(path.join(destination, name), "", { mode: 0o600, flag: "wx" });
const openssl = (...args) =>
  execFileSync("openssl", args, { cwd: destination, stdio: "ignore" });
openssl(
  "req",
  "-x509",
  "-newkey",
  "rsa:3072",
  "-nodes",
  "-keyout",
  "db-ca.key",
  "-out",
  "db-ca.crt",
  "-days",
  "365",
  "-subj",
  "/CN=Tessaloom private database CA",
);
openssl(
  "req",
  "-newkey",
  "rsa:3072",
  "-nodes",
  "-keyout",
  "db.key",
  "-out",
  "db.csr",
  "-subj",
  "/CN=postgres",
);
writeFileSync(
  path.join(destination, "db.ext"),
  "subjectAltName=DNS:postgres\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n",
);
openssl(
  "x509",
  "-req",
  "-in",
  "db.csr",
  "-CA",
  "db-ca.crt",
  "-CAkey",
  "db-ca.key",
  "-CAcreateserial",
  "-out",
  "db.crt",
  "-days",
  "90",
  "-extfile",
  "db.ext",
);
for (const name of ["db-ca.key", "db.key"])
  chmodSync(path.join(destination, name), 0o600);
for (const name of ["db-ca.crt", "db.crt"])
  chmodSync(path.join(destination, name), 0o644);
for (const name of ["db.csr", "db.ext", "db-ca.srl"])
  unlinkSync(path.join(destination, name));
console.log(
  "Local credentials and database TLS files prepared; provider keys are empty. Database certificate expires in 90 days.",
);
