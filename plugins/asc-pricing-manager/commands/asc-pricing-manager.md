---
description: Start a read-only App Store Connect regional pricing audit workflow.
---

# /asc-pricing-manager

Start ASC Pricing Manager for App Store Connect paid-app pricing audits.

## Arguments

- `env`: path to the pricing-capable App Store Connect env file (optional)
- `out`: path for the JSON audit artifact (optional; defaults to `/private/tmp`)
- `csv`: path for the CSV audit artifact (optional; defaults to `/private/tmp`)
- `as-of`: date used to evaluate active pricing rows (optional)

## Workflow

1. Use the `asc-pricing-manager` skill.
2. Read `skills/asc-pricing-manager/SKILL.md` before making App Store Connect requests.
3. Confirm the target app and pricing-capable credential env file.
4. Run `scripts/asc-audit-pricing.mjs`.
5. Review the generated summary and JSON/CSV artifacts before proposing any pricing changes.
6. Keep credentials and generated pricing audit artifacts out of commits unless the user explicitly wants them tracked.

## Guardrails

- Pricing audits are read-only; do not schedule or apply price changes from this command.
- Never print full `.env` files, `.p8` contents, JWTs, or full key IDs.
- Do not assume a Marketing-role metadata key can read pricing resources.
- If App Store Connect returns `403`, report it as a credential role/access issue and do not suggest Full Access as the default fix.
