# Edge WAF and rate limiting

The application has its own persistent account rate controls, but they are not
a replacement for an Internet-facing WAF. Caddy's standard build does not ship
with a request-rate-limit handler. Do not add an unreviewed Caddy plugin just
to satisfy this requirement.

[`cloudflare-rate-limits.tf.example`](cloudflare-rate-limits.tf.example) is an
optional, current Rulesets-API/Terraform example for a Cloudflare-proxied zone.
It blocks excessive POST traffic before it reaches Caddy and Waitress. Use an
equivalent managed edge/WAF control if Cloudflare is not the chosen provider.

## Before applying an edge policy

1. Make sure the public DNS record is actually proxied through the selected
   edge provider. A DNS-only record bypasses the WAF entirely.
2. Review existing `http_ratelimit` rulesets and import/merge them in the
   private infrastructure state. Do not overwrite another team's zone ruleset.
3. Store the provider token only in the CI/deployment secret store and use the
   minimum `Zone WAF Write` permission. Keep Terraform state in encrypted,
   access-controlled remote storage.
4. Start the listed rules in a monitored/preview mode if the provider supports
   it, then tune them using closed-beta traffic. Per-IP controls can affect
   users behind a shared mobile network, school, clinic, or NAT gateway.
5. Keep application-level controls enabled even after the edge policy is live.
   Edge controls reduce abuse; the application remains responsible for account
   security and authorization.

## CDN forwarding warning

The shipped `Caddyfile.example` deliberately clears incoming forwarding headers
and rebuilds them from the direct peer. That is correct for a direct
client-to-Caddy deployment and prevents header spoofing. If a CDN is placed in
front of Caddy, the direct peer becomes the CDN, so application-level IP limits
will otherwise see CDN addresses instead of users.

Do **not** simply trust every `X-Forwarded-For` header. Before preserving a
CDN's client IP, restrict origin ingress to the provider's published CIDRs,
configure Caddy `trusted_proxies` with those reviewed CIDRs and
`trusted_proxies_strict`, and remove/replace the manual `header_up` forwarding
overrides only after a security review. Retest login rate limiting from two
different clients and test that a direct origin request cannot spoof a client
IP. Dynamic CDN-IP Caddy modules are non-standard dependencies and need normal
supply-chain review.

## Minimum edge policy

- Managed WAF rules enabled and reviewed for false positives.
- Bot/DDoS protection appropriate to the provider plan.
- Rate controls for sign-in, MFA, registration/security email, image uploads,
  feedback, and unexpected spikes across all endpoints.
- Origin firewall allows only the edge provider and approved administrative
  networks; port 8080 stays loopback-only.
- Edge/WAF logs are access-controlled, time-limited, and configured not to
  capture request bodies, token-bearing paths, credentials, raw health images,
  or exact locations.
