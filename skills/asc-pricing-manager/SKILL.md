---
name: asc-pricing-manager
description: Audit and plan App Store Connect app pricing schedules, regional price points, manual and automatic prices, outlier territories, and read-only pricing recommendations. Use when inspecting current paid-app pricing, comparing regional App Store prices, preparing price optimization by country or region, or planning future scheduled price changes. Current workflow is read-only audit first; scheduled pricing changes require a reviewed dry run and separate explicit approval.
---

# Workflow

Use this skill for App Store Connect paid-app pricing. Keep it separate from marketing metadata
because pricing has a different API surface, credential role, and risk profile.

## Read-Only Pricing Audit

1. Confirm the target app and a pricing-capable App Store Connect credential env file.
   - Prefer a separate pricing env file outside the repo.
   - Do not assume a Marketing-role metadata key can read or manage pricing.
2. Run `scripts/asc-audit-pricing.mjs`.
   - The script only makes `GET` requests.
   - It writes JSON and CSV artifacts to `/private/tmp` by default.
   - Use explicit `--out` and `--csv` paths when the user wants stable filenames.
3. Review the generated summary, outliers, and recommendations before proposing any price changes.
4. Treat all customer prices as territory-local prices with the included currency. Do not describe a
   non-USD storefront price as USD.

```zsh
node scripts/asc-audit-pricing.mjs \
  --env ~/.appstoreconnect/my-app-pricing.env
```

```zsh
node scripts/asc-audit-pricing.mjs \
  --env ~/.appstoreconnect/my-app-pricing.env \
  --out /private/tmp/asc-pricing-audit.json \
  --csv /private/tmp/asc-pricing-audit.csv
```

## Output

The JSON artifact includes:

- current app price schedule ID
- base territory and currency
- normalized manual and automatic app price rows
- available app price points by territory
- active current prices by territory, preferring active manual prices over automatic prices
- grouped current territories by `currency customerPrice`
- a global benchmark tier derived from active territory price ladders
- upcoming and expired schedule rows
- active pricing outliers highlighted in the audit output
- read-only recommendations that map each outlier market onto the benchmark territory tier, with confidence and expected proceeds delta when available

The CSV artifact is a compact review table with territory, currency, source, customer price,
proceeds, benchmark price fields, suggested action, price point ID, start date, end date, active
status, and band.

## Safety Rules

- This skill is read-only until a separate scheduled-pricing workflow exists.
- Do not run or invent an apply step for pricing changes.
- Do not print full `.env` files, `.p8` contents, JWTs, or full key IDs.
- Keep pricing audit outputs out of commits unless the user explicitly asks to track them.
- If App Store Connect returns `403`, report it as a credential role/access issue and do not suggest
  Full Access as the default fix.

## Future Scope

Scheduled price updates should be implemented as a separate dry-run/apply workflow using
`POST /v1/appPriceSchedules` only after the read-only audit output is reviewed and a desired
regional pricing matrix is agreed.
