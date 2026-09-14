# Production observability and alerting

This service handles health-related data. Monitoring must detect failures while
minimising collection of personal data. Do not send image bodies, account
credentials, bearer-token URLs, exact locations, raw email addresses, model
outputs, or full request/response bodies to a monitoring vendor.

## Available signals

| Signal | Source | What it proves | Limitation |
| --- | --- | --- | --- |
| Public synthetic check | `Monitor-SmartSkinPublicEndpoint.ps1` | DNS/TLS/proxy/public route/security headers are reachable | Does not sign in, upload, verify SMTP, or assess model readiness |
| Reverse-proxy liveness | Caddy active upstream health | Waitress can answer `/healthz` | It is intentionally only a liveness check, not a database/storage/SMTP or clinical-model readiness check |
| Application readiness | Protected `/readyz` check | Database and private-storage availability for the configured release mode | Returns only `ready`/`not_ready`; diagnose through protected logs |
| Caddy metrics | `http://127.0.0.1:2019/metrics` | Gateway traffic, latency, status and upstream health | Loopback only; do not expose it publicly |
| Windows service status | Service manager / approved host agent | Caddy and SmartSkinAI service are running | Does not prove a user journey works |
| Retention job | Scheduled-task history plus `manage.py purge-expired-scans` exit code | Expired artifacts get a deletion attempt | Must alert when a daily run is missed or fails |
| Audit log review | Application `audit_logs` under controlled access | Security-sensitive application events | Audit records are not a substitute for central operational logs |

## Enable proxy telemetry safely

`deploy/Caddyfile.example` enables Caddy metrics and binds the administration
API to `127.0.0.1:2019`. Keep Windows Firewall configured so only the local
monitoring collector and approved administrators can reach it. Never map it
through Caddy, a load balancer, VPN split tunnel, or public port.

The example Caddy access log deliberately skips bearer-token and private-artifact
paths, strips cookies/authorization/referrer/user-agent, masks IP addresses, and
removes known sensitive query keys. Before routing logs to a SIEM, verify the
SIEM's collection agent does not add raw request URLs, headers, or bodies back
into a second log stream.

For a local Prometheus collector, begin with
[`prometheus.smartskin.example.yml`](prometheus.smartskin.example.yml). It must
run on the same host or through a separately authenticated private monitoring
network; it is not intended for an Internet-facing Prometheus instance.

## Alerts to wire before launch

Use the example alert rules as starting thresholds, then tune them during a
closed beta:

1. Synthetic HTTPS check fails twice consecutively, or latency breaches the
   agreed user-facing target.
2. `caddy_reverse_proxy_upstreams_healthy` is `0` for two minutes.
3. 5xx responses exceed 2% over five minutes, after excluding intentional
   probe paths.
4. Caddy process restarts unexpectedly, disk free space is below the agreed
   threshold, or protected log rotation fails.
5. The daily retention scheduler misses its deadline or exits non-zero.
6. Repeated account-login/MFA failures, unexpected MFA recovery, privilege
   change, bulk deletion, or password-reset events exceed a reviewed baseline.
7. Backup age exceeds the recovery objective, a restore check fails, or a
   restore test has not been evidenced on schedule.

Every alert needs an assigned owner, severity, escalation channel, and a
runbook. An email notification alone is not a monitored response process.

## Synthetic endpoint check

Run from a network independent of the service when possible. It does not send
health data and records no response body:

```powershell
.\deploy\Monitor-SmartSkinPublicEndpoint.ps1 `
  -PublicBaseUrl 'https://hucksmartskinai.com/healthz' `
  -HttpUrl 'http://hucksmartskinai.com/' `
  -ReportPath 'C:\ProgramData\SmartSkinAI\monitoring\public-2026-09-07.json'
```

Use `-RequireSessionCookieFlags` only on a route that is expected to set a
session cookie. Do not feed any URL containing a password reset token, email
verification token, account identifier, query parameter, or location to this
monitor.

## Health and readiness contract

- `/healthz` is public, fixed, session-free liveness and returns only
  `{"status":"ok"}` with `200`.
- `/readyz` returns only `ready` or `not_ready`; it checks database and private
  storage without exposing paths, secrets, model metadata, or health records.
  In a screening release it also remains not-ready while the model release
  gate is blocked. In public-information mode, no model is required.

Keep both outputs uncached. Caddy uses `/healthz` for active upstream health;
point an authenticated/private synthetic monitor at `/readyz` when dependency
readiness matters. Do not turn either endpoint into a model-performance or
clinical-status report.
