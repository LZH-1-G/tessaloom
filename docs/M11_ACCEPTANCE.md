# M11 deployment acceptance and remaining blockers

Reviewed 2026-10-24, Asia/Shanghai. **Local preparation is verified; public deployment and submission are NOT accepted.** No live Qloo/DeepSeek request, public tunnel, hosting purchase/provisioning, organizer message, push, merge, repository publication or submission occurred.

## Local evidence

See [verification record](M11_VERIFICATION.md) and [machine-readable evidence](evidence/m11/verification.json). Checkpoint identity is the commit containing these files (`git log -1 --format=fuller` after checkpoint); it is not a remote release.

- [x] Work began on `codex/m11-public-demo`, clean at main `492a652`; remote main was checked read-only and matched.
- [x] PR #14's six core check types were rechecked as successful; CodeQL was skipped for the private repository. These results do not apply to unpushed M11 changes.
- [x] All baseline application layers are retained, including DeepSeek, Qloo source-time/provenance handling and fixture guard.
- [x] Production secret-file denial under both actual child UIDs and provider-only worker environment verified, including DeepSeek.
- [x] Anonymous generation refused in off/invite modes; no runs or spending reservations created by denied requests. Production open mode rejected.
- [x] One-shot administrator service uses internal networking and only runtime DB credentials/pepper; bounded zero-budget grant create/list/revoke and spend query tested.
- [x] All eight migrations applied and rerun; verified DB TLS/plaintext rejection; runtime DDL denied.
- [x] Backup refuses overwrite, scratch restore refuses existing target, runtime read/write grants and DDL denial survive restore; revoked grant and zero-reservation state retained.
- [x] DB container recreation preserves project data; DB outage makes readiness fail and recovers; liveness remains separate.
- [x] Supervised worker crash/restart, container PID 1 restart progress and graceful shutdown verified locally.
- [x] Local HTTPS redirect, certificate verification, HSTS/CSP/Secure cookies, request size cap, forged-forwarding throttling and proxy log redaction passed.
- [x] Read-only HTTPS probe passes with the local CA, fails without trusted CA and on DB outage. Unit cases reject malformed/credential URLs, redirects, cached/false readiness, oversized output and stalled peers.
- [x] Local Mac tunnel-origin configuration tested with internal client; configured host port is loopback-only; production policy retained. No connector/public transport tested.
- [x] Cost safety regression and production fixture sample denial passed. No synthetic-to-real provenance exception was introduced.

## External deployment gates — all still pending

| Gate                          | Required acceptance evidence                                                                                                                                    | Status                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Account and exact price       | Oracle approved, free entitlement/capacity proven; or approved paid quote including tax/extras and actual VPS stock                                             | BLOCKED: Oracle pending; CX23 availability not established             |
| Correct architecture/build    | Accepted image for actual host, digest/archive checksum, clean build connectivity or explicitly accepted unchanged-base runtime update                          | ARM64 runtime update tested; clean rebuild stalled; AMD64 M11 untested |
| Genuine external hosting      | Approved external VM, DNS and public deployment; home tunnel not assumed compliant                                                                              | NOT DEPLOYED                                                           |
| Public HTTPS and reachability | Independent network/browser validation, public CA, HTTP redirect, IPv4/IPv6 firewall/direct-origin checks, only intended ports reachable                        | NOT RUN                                                                |
| Functional public demo        | Actual approved nonfixture Qloo content and useful judge journey, not an empty shell or fixture recording                                                       | BLOCKED                                                                |
| Qloo authorization            | Current quota, expiry through judging, allowed retained/public data and any DeepSeek transfer; approved bounded live calibration                                | UNKNOWN / no new calls authorized                                      |
| Safe judge generation         | Reviewed finite grant policy, global caps, account controls and terms compatibility; pricing review and real journey cost evidence                              | NOT ENABLED; paid work stays off                                       |
| Continuity                    | Host reboot and disk persistence; measured restore/RPO/RTO; off-host encrypted backup retrieval; certificate renewal; independent probe and tested owner alerts | LOCAL tests only                                                       |
| Browser and SSE               | Public Chromium/WebKit sample journey, secure sessions/CSRF, SSE progress/reconnect/cancel on the chosen route                                                  | Prior local CI exists; hosted tests unrun                              |
| Submission package            | Final English judge instructions, working URL, public repo/license detection, owner eligibility/registration, current rules and final secret scan               | Owner-controlled; no publication/submission                            |
| M11 remote checks             | Approved future push/PR and six core CI checks; CodeQL availability accurately recorded                                                                         | NOT RUN; no push authorized                                            |

## Next approval request

First approve the **hosting route and complete price quote**, or continue waiting for Oracle with an explicit deadline decision. For the paid fallback the published base is **US$7.09/month (or €5.99 in EUR billing), before tax and extras**, subject to CX23 stock; no purchase can be made from that estimate alone. Account registration/identity/payment decisions remain with the owner.

After an account/host is ready, public deployment needs its own approval for the concrete hostname, firewall and accepted image. Keep provider keys absent and generation closed until Qloo permissions, bounded live validation and judge access are separately approved. A hosting approval is not permission for paid inference, data transfer, public source release or Devpost submission.

Operational target: ready before **October 31, 2026, 11:45 Beijing time**; keep the conservative availability plan through November 30. [Current official terms and timing](M11_HOSTING.md) take precedence over older notes, without silently treating any compliance uncertainty as resolved.
