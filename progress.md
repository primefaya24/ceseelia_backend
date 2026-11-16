# Ceseelia Backend — Progress Tracker

_Last reviewed: 2026-11-08 (full codebase read-through) · Last updated: 2026-11-15_

This file tracks **what's left to do**. Design notes and conventions are in `CLAUDE.md`. The
webapp has a matching file at `../ceseelia_webapp/progress.md`.

**How to use this file**

- Work top to bottom. Each task is ordered so it only depends on tasks above it.
- Tick a box when the task is merged: `- [ ]` → `- [x]`. Mark work in progress with `- [~]`.
- Task IDs (`S.3`, `1.2.b`, …) match `CLAUDE.md` §6 stages where possible. `S.*` is the new
  security/bug-fix stage that comes before Stage 1.
- **WA x.y** = the matching webapp task. It usually ships in the same change set.
- Priority tags: 🔴 critical (security or data loss) · 🟠 high (broken feature / real risk) ·
  🟡 medium · ⚪ low / cleanup.

---

## 0. Launch to-do: owner steps and Claude's (updated 2026-11-15)

The steps left before launch. Each says who does it: the owner (dashboards, pasting secrets,
real purchases, pushing to GitHub, decisions) or Claude (anything its shell can reach: AWS CLI,
the prod server over SSH, the Stripe API with the stored key). Secrets never go through chat.
The same list is in both repos' `progress.md`; tick it in both. In order: each phase needs the
one before it. Details stay where they're linked.

_A1–B3, B5–B9, C1, D2, D4 and E1 done 2026-11-15 (C2 mostly); `tools/deploy-s3.sh dev` run by Claude (dev.ceseelia.com
serves the app; API calls fail until a dev API exists). `https://api.ceseelia.com` is live (Stripe test mode). **C3 done 2026-11-16; paid plans on (D3). Next: C4 (Spark checkout).** Store subdomains (9.8 phase 1) are coded and tested: G1 (owner push) then G2 (Claude deploys)._

**A. Now (nothing blocks these)**
- [x] A1. **Push** every repo from your own shell: backend and webapp
      `dev_v1.0.0_customer_store_front`; CloudFormation `dev_v1.0.0_l4_backups_alarms` and
      `dev_v1.0.0_l9_webapp_cloudfront`.
- [x] A2. **S.2 Rotate the old password** that was in the backend's `node/README.md` (still in git
      history).
- [x] A3. **Delete the old secret** `ceseelia/dev/stripe` (no longer read):
      `aws secretsmanager delete-secret --secret-id ceseelia/dev/stripe --recovery-window-in-days 30`.
- [x] A4. **platform.claude.com billing**, then create an API key there and paste it in the AWS
      console as `anthropicApiKey` in `ceseelia/dev`. Then tell Claude: it runs the 60-store eval
      (≈ $1) and shows you the results. Until the key is in, every Go Live goes to review.
      (If billing can't be fixed: pick Claude Platform on AWS or Bedrock, backend §1 "The AI
      check's key".)

**B. AWS infrastructure (dev first, then prod)**
- [x] B1. GitHub › CloudFormation repo › Settings › Secrets and variables › Actions › Variables:
      add `ALARM_EMAIL`.
- [x] B2. Merge `dev_v1.0.0_l4_backups_alarms` into `dev_v1.0.0` and push (CI deploys dev:
      backups, alarms, logs). Click the SNS confirmation email.
- [x] B3. Webapp hosting (L.9): run `sam validate --lint` (cfn-lint couldn't run in Claude's
      shell), preview a change set on `ceseelia-dev`, then merge
      `dev_v1.0.0_l9_webapp_cloudfront` into `dev_v1.0.0` and push. _Done 2026-11-15:
      `https://dev.ceseelia.com` answers through CloudFront (S3 "Access Denied" while the bucket
      is empty, as expected). To check the whole chain, upload the app with
      `tools/deploy-s3.sh dev`: pages load, but anything needing the API fails until a dev API
      exists (`dev.api.ceseelia.com`; the dev config points at a LAN address)._
- [x] B4. When dev looks right, merge `dev_v1.0.0` into `prod_v1.0.0` and push (prod is also
      behind on the 2026-11-09 upload-expiry rule). _Done 2026-11-15: `ceseelia-prod`
      UPDATE_COMPLETE, `app.ceseelia.com` answers (empty bucket until D4)._
- [x] B5. **Launch the prod API server** (EC2) with the **`CeseeliaServerRole`** instance
      profile, point `api.ceseelia.com` at it (Route53 A record), run `generate-cert.sh`. Tell
      Claude the host so it can fix the `ssh`/`scp` deploy scripts (they still point at
      dinersxpress-0). _Done by Claude 2026-11-15: `ceseelia-0` (i-0533c778bf9ef2411, t3.micro,
      Amazon Linux 2023), Elastic IP 184.192.215.17, `api.ceseelia.com` A record, security group
      `ceseelia-api` (80/443 public, SSH only from the owner's IP 75.159.129.50: update it if
      that changes). Key: `~/Documents/pem/ceseelia-0.pem`. First boot (`ec2-user-data.sh`):
      Docker + Compose v2.40.3 + Buildx, 1 GB swap, cron, daily security updates. Certificate
      issued (renews by cron). Deploy scripts read `server.conf`._
- [x] B6. After prod's stack is deployed, update the server role from the file (adds the prod log
      group and `cognito-idp:AdminDeleteUser` for account delete):
      `aws iam put-role-policy --role-name CeseeliaServerRole --policy-name ceseelia-server-prod --policy-document file://iam/ceseelia-server-policy.json`
      (from `ceseelia_backend/`). _Done by Claude 2026-11-15._
- [x] B7. Prod server environment: `APP_SECRET_ID=ceseelia/prod`,
      `CORS_ORIGINS=https://app.ceseelia.com` (required; the API won't start without it),
      `ADMIN_ALERT_EMAIL` (where review, ticket and hidden-item alerts go). Leave
      `PAID_PLANS_ENABLED` off until D3. _Done by Claude 2026-11-15 (`node/.env` on the server;
      `ADMIN_ALERT_EMAIL` left at its default, the admin contact address)._
- [x] B9. **Stripe secret key into `ceseelia/prod`** (AWS console › Secrets Manager ›
      `ceseelia/prod` › `stripeSecretKey`): the **test** key (`sk_test_…`) for phase C, swapped
      for the live one in D1. The API won't start without it (it's built and stopped on the
      server now). Then tell Claude: it starts the API and checks `https://api.ceseelia.com`. _Done 2026-11-15: test key in;
      API started by Claude, healthy (HTTPS valid, HTTP → HTTPS, CORS from the app, bare-IP
      HTTPS refused)._
- [x] B8. **Web push keys:** `node scripts/setup-vapid.mjs --write` (dev), then
      `APP_SECRET_ID=ceseelia/prod node scripts/setup-vapid.mjs --write`; restart the API.
      _Checked by Claude 2026-11-15: both secrets already have their keys. The prod API reads
      them when it first starts (B5)._

**C. Stripe in test mode**
- [x] C1. **Connect webhook** (backend 5.5 "Setup"): endpoint
      `https://api.ceseelia.com/api/v1/payments/stripe-connect-webhook`, "Events on Connected
      accounts", the events listed there; its signing secret into the stage's secret as
      `stripeWebhookSecret`. _Done by Claude 2026-11-15 through the Stripe API (test mode):
      `we_1UcEEvGS7poxugeoEGr30Pl1`, Connect, the 13 events, API version `2025-08-27.basil`
      (the SDK's); secret stored without being shown. Unsigned calls get 400._
- [x] C2. **Billing setup** (backend P.5 "Setup" 1–5): prices script, Stripe Tax (origin address,
      GST/HST, SaaS tax code), billing webhook (`stripeBillingWebhookSecret`), Smart Retries →
      mark unpaid, customer portal.
      _Done by Claude 2026-11-15 (test mode): prices (Spark and Nova × CAD/AUD/USD; the script
      was broken since P.10 and is fixed), SaaS tax code `txcd_10103001` on both products,
      billing webhook `we_1UcEEvGS7poxugeojsIaBa0a` (9 events, secret stored), default customer
      portal (cards, invoices, cancel at period end, switch Spark ↔ Nova). **Left for you, in the
      Stripe dashboard (test mode):** Stripe Tax on + origin address + GST/HST registration
      (Settings › Tax); Billing › Revenue recovery › Smart Retries on, "if all retries fail" →
      mark the subscription unpaid._
      _Owner part done 2026-11-15 (test mode): head office Alberta; test registration Canada
      GST/HST (live mode: the real number, RT0001, also as the invoice tax ID); Smart Retries 8
      times in 2 weeks, all retries failed → subscription **unpaid** (the merchant can still pay
      the open invoice in the portal and keep the plan), invoice left overdue. Claude checked:
      25 CAD Spark → AB 5% GST, ON 13% HST, QC and BC GST only (no QST/PST registration; F3
      asks the accountant which provinces need one)._
- [x] C3. **L.0 first real test order:** checkout → paid (receipt, PDF, alerts) → Store › Orders →
      ready / on its way emails → refund part → refund the rest. _Done 2026-11-16 on
      `pressed-by-pmerch-1.ceseelia.com` (Spark given by an admin): AB GST 5% on goods + delivery,
      receipt with PDF, alerts, shipped and refund emails all arrived; partial then full refund →
      REFUNDED; a second order Completed; a review shows on the storefront; a custom 3.95 CAD
      commission taken as the application fee. Fixes found on the way: Go Live sheet wording
      with no plan open (WA fa9575d), admin list counters (BE 5bb43eb)._
- [x] C4. **A Spark checkout** (Go Live → Stripe Checkout → live) and a plan switch in the portal.
      Paid plans are on (D3, 2026-11-16): the owner runs the checkout. _Done 2026-11-16: the test
      store went live on Spark through Checkout (Paying) and Spark → Nova in the portal works
      (proration set the same day, see changelog)._

**D. Going live**
- [ ] D1. Repeat C1 and C2 in **live mode**; live keys and both webhook secrets into
      `ceseelia/prod` (AWS console).
      Then run `node/scripts/setup-billing-portal.mjs --write` against live mode (plan switches:
      upgrades charged at once, downgrades at the period's end).
- [x] D2. `anthropicApiKey` in `ceseelia/prod`, once you've reviewed the eval (A4). _Done
      2026-11-15 (Claude checked: present, a valid key format; value never read out). Eval on
      dev: 60 of 60 right, no legitimate store flagged, no sketchy store missed, ≈ $0.34._
- [x] D3. `PAID_PLANS_ENABLED=true` on the prod server; restart. _Done by Claude 2026-11-16
      (SSM: added to the server's `node/.env`, node recreated, healthy; `/store/public/plans`
      shows both available). Still Stripe test mode until D1. The automatic deploy never touches
      `node/.env`._
- [x] D4. Deploy the webapp: `tools/deploy-s3.sh prod` (from `ceseelia_webapp/`). _Done by Claude
      2026-11-15 (early, so C3 can run on prod in test mode; run it again after any webapp change).
      `app.ceseelia.com` serves the app with the prod config; link previews reach the API._
- [ ] D5. Smoke test on prod: sign up, create a store, Go Live, a real order; paste a store link
      in WhatsApp or Slack and check the preview (name, slogan, logo).

**F. Claude, before launch (code)**
- [x] F1. Webapp Content-Security-Policy on CloudFront (WA S.14: Amplify keeps tokens in
      `localStorage`, so XSS matters). Claude writes and tests it; the owner merges the
      CloudFormation branch (dev, then prod).
      _Claude part done 2026-11-16: CloudFormation branch `dev_v1.0.0_csp`
      (`WebappSecurityHeadersPolicy`: the managed security headers plus the CSP, on the webapp
      and custom-domain distributions). Tested in headless Chrome against the prod build: no
      violations on sign-in, a real storefront with images, checkout; a broken policy is caught.
      The webapp build no longer inlines critical CSS (its `onload` handler would be blocked);
      that build is on prod, so the CSP can go live. **Owner:** merge `dev_v1.0.0_csp` into
      `dev_v1.0.0`, push, then into `prod_v1.0.0`, push; then Claude rechecks prod._
      _Live on prod 2026-11-16 (owner pushed; stack UPDATE_COMPLETE 07:42 UTC). Claude checked in headless Chrome against prod: no violations on sign-in, sign-up, a storefront on its subdomain and on `/s/`, checkout, legal; images load; the custom-domain distribution has the same policy; bot previews still work; dev has it too._
- [ ] F2. Legal pages: privacy policy and terms (WA 9.1), linked from the storefront footer and
      sign-up. Claude drafts; **the owner reviews the text** (and ideally a lawyer).
      _Claude part done 2026-11-16 (webapp dev, not on prod): Terms of Service, Privacy Policy
      and End User Agreement at `/legal/…` (Primefaya Computer Services, Alberta law,
      support@ceseelia.com; processors AWS, Stripe, Anthropic, Google Fonts, push services);
      a legal header linking the three; sign-up needs a consent checkbox; the storefront footer
      links Terms and Privacy. **Owner:** review the text (business name, contact email, the
      7-year order retention, the CAD 100 liability floor), then Claude pushes it to prod._
- [x] F3. Owner: an accountant to confirm the delivery-tax simplification (backend 4.2
      follow-up: delivery taxed like the goods), and which provinces' PST/QST Ceseelia must
      collect on its subscriptions, from what sales level (BC, SK, MB, QC).
      _Done by the owner 2026-11-16._
- [x] F4. Owner: push every commit Claude made (both repos are ahead of GitHub). _Done 2026-11-16;
      Claude now pushes dev itself and asks before every prod push._

**G. Store subdomains (9.8 phase 1, code done 2026-11-15; deploy in this order)**
- [x] G1. Owner: merge CloudFormation `dev_v1.0.0_store_subdomains` into `dev_v1.0.0` and push
      (dev: no change but the router function's code), then into `prod_v1.0.0` and push (prod:
      `*.ceseelia.com` alias on the webapp distribution + wildcard A/AAAA records). Check the
      stack reaches UPDATE_COMPLETE. Explicit records (api, app, dev, *.storage, mail) keep
      working: DNS and CloudFront prefer the exact name.
- [x] G2. Claude, right after G1: deploy the backend (`scp-fs.sh build` + restart; the prod default
      `STORE_URL_TEMPLATE=https://{slug}.ceseelia.com` needs no `.env` change) and the webapp
      (`tools/deploy-s3.sh prod`), then check `https://<slug>.ceseelia.com` opens the store,
      `app.ceseelia.com/s/<slug>` still works, an app page on a store address goes to the app,
      CORS answers a store origin, and a bot on `/` gets the preview. Not before G1: the new
      Stripe return URLs and email links point at store subdomains.
      _Done 2026-11-16: backend and webapp deployed; a store address serves the store ("Store
      not found" for an unknown slug, canonical set), app pages there and `admin.ceseelia.com`
      open sign-in on the app, CORS 204 for a store origin and none for `admin.` or other
      domains, bots get the preview, api / app / dev / storage unchanged._
- [x] G3. Owner: decide when phase 2 (custom domains, `shop.<their domain>`) starts. _Decided
      2026-11-16: now, before launch; Spark and Nova; subdomains only; merchants CNAME to one
      fixed name, `domains.ceseelia.com`; the address bar stays on their domain. Code done the
      same day (9.8 phase 2)._
- [x] G4. Owner: merge CloudFormation `dev_v1.0.0_custom_domains` into `dev_v1.0.0` and push
      (dev: no change but the bucket policy's condition), then into `prod_v1.0.0` and push
      (prod: the multi-tenant `CustomDomainDistribution`, its connection group, router
      function, `domains.ceseelia.com` CNAME + `_cf-challenge` TXT, and the server's
      `CustomDomainServerPolicy`). Check the stack reaches UPDATE_COMPLETE. _Done 2026-11-16
      (first prod attempt failed on CAPABILITY_NAMED_IAM; the policy's fixed name was dropped)._
- [ ] G5. Claude, right after G4. _Mostly done 2026-11-16: env set on the server (backup
      `node/.env.bak-customdomains`), backend and webapp on prod, `domains.ceseelia.com` →
      `dytlp5vmoldm8.cloudfront.net` plus the TXT, the sweep running ("live list loaded"), the
      server role may call the tenant API, public lookup 404s an unknown host, `/store/domain`
      needs sign-in. **Left:** a real domain end to end (needs a subdomain the owner controls)._
      The steps: put the stack outputs `CustomDomainDistributionId` and
      `CustomDomainConnectionGroupId` into the prod server's `node/.env` as
      `CUSTOM_DOMAIN_DISTRIBUTION_ID` / `CUSTOM_DOMAIN_CONNECTION_GROUP_ID` (the feature is off
      without them: the card says "coming soon"), push backend and webapp to prod, check
      `domains.ceseelia.com` resolves to the routing endpoint, the card works, and a test
      domain goes PENDING_DNS → PENDING_CERT → ACTIVE and opens the store.

**H. Automatic prod deploys (done by Claude 2026-11-16; owner decisions: on every push, prod only)**
- [x] H1. Claude: GitHub OIDC login in AWS (no secrets in GitHub), roles
      `CeseeliaGithubDeployBackendProd` (push to ECR `ceseelia-node`, run commands on the API
      instance) and `CeseeliaGithubDeployWebappProd` (the prod webapp bucket, its invalidations,
      the stack's outputs), each usable only from its repo's `prod_v1.0.0`. ECR `ceseelia-node`
      (scan on push, tags immutable, last 10 images kept, untagged leftovers gone after a day).
      SSM Run Command on the API server (`CeseeliaServerRole`: ECR pull, SSM agent).
      Workflows: backend `deploy-prod.yml` (the CI checks, image → ECR, SSM →
      `deploy-image.sh`: pull, start, wait for /healthz, **automatic rollback** if unhealthy, the
      job then fails); webapp `deploy-prod.yml` (lint, tests, `tools/deploy-s3.sh prod`).
      Tested on prod by hand: a deploy (≈ 40 s) and a crashing image (rolled back in ≈ 40 s).
- [x] H2. Owner: push `dev_v1.0.0` in both repos, then create and push `prod_v1.0.0` in each
      (`git switch -c prod_v1.0.0 && git push -u origin prod_v1.0.0`; neither repo has it yet).
      That push is the first automatic deploy: watch it in the repo's Actions tab. From then on,
      merging into `prod_v1.0.0` and pushing deploys. A change that needs both repos (an API
      change the webapp uses): merge and push the backend first. _Done 2026-11-16: first
      automatic deploys succeeded (backend `5a3a5d6`, webapp `d5d659a`)._

**E. Optional, any time**
- [x] E1. The two storage distributions (`dev.storage` / `prod.storage`, made by hand) use
      `PriceClass_All`; `PriceClass_200` costs less and still covers North America, Europe and
      Asia. _Done by Claude 2026-11-15 (both now `PriceClass_200`)._

_Already done by the owner: the old Google Cloud API key revoked (S.1b, 2026-11-08), rewards
`normalize-rewards-method.mjs --write` on dev and prod (2026-11-15), Stage P QA (2026-11-13)._

## 1. Where things stand

> **🚀 Launch checklist (owner, 2026-11-14): EVERY item below must be done before launch.**
> Nothing here is optional or "after launch". Work order agreed 2026-11-14: L.1 is the owner's
> (2026-11-15); Claude works on L.2–L.9 in the order shown. **L.2–L.8 are done, L.9 is done
> except custom domains (after launch). What's left is the owner's §0 list (C2–D5) and the
> "Still open" list at the end of this section.** (2026-11-15)
> - [x] **L.0 Owner: the first real test order** (= §0 C3, done 2026-11-16) in Stripe test mode (Connect webhook first,
>       with the refund events, BE 5.5 "Setup"): checkout → paid (receipt + PDF, alerts) →
>       Store › Orders → steps (ready / on its way emails) → refund part → refund the rest.
> - [ ] **L.1 Owner: Stripe and secrets** (= §0 C2, C4, D1, D3; S.2 done). Stripe Billing setup (P.5 "Setup") and a Spark
>       checkout test; `PAID_PLANS_ENABLED=true` in prod; live Stripe keys and webhook secrets
>       in `ceseelia/prod` (one secret per stage, see the note below); S.2 password rotation.
> - [x] **L.2 The AI store check** in `runSmartStoreValidation` (P.4c). Code done 2026-11-15;
>       **switching it on waits for the API key and the eval.** Owner decisions 2026-11-14:
>       - The AI **never rejects**: it passes a store or sends it to the admin review queue with
>         evidence per item. Merchants never see the reasons. Go Live attempts are rate-limited.
>       - Checks: Stripe's prohibited and restricted businesses (verify against Stripe's current
>         list when building), scam signs (payment outside Stripe, too-good prices,
>         impersonation, phantom products, resold digital goods), store/items mismatch.
>       - **Restricted categories** (alcohol, vapes/tobacco, CBD/kratom, supplements with health
>         claims, knives/hunting gear...) are **banned unless the owner approves** the store.
>       - **Live stores:** item changes are re-checked in the background (a few minutes after
>         the last edit, changed items only). A flagged item is **hidden until approved**, the
>         rest keeps selling, and the owner gets an **email alert**.
>       - **Go Live waits** up to 90 s ("Checking your store…"); slower → IN_REVIEW.
>       - **Big stores:** every item's text is checked (text is cheap; chunked in parallel if
>         very large). Images are capped at 50, chosen by risk first (rule-check hits, branded or
>         high-priced items), then random. A pure random 50 of 500 would miss a few bad items
>         most of the time.
>       - Claude API (`@anthropic-ai/sdk`, Claude Opus 5.5, structured output, server-side
>         refusal fallback). Key: `anthropicApiKey` in `ceseelia/<stage>` (see the secrets
>         note below).
>       - Before switching on: an eval set of ~60 made-up stores (half legitimate and tricky,
>         half sketchy), results shown to the owner first.
>       - **Built 2026-11-15** (BE `b186878` + WA): `layers/core/store-validation/` (rules,
>         image pick, `ai.ts`, `item-check.ts`); Go Live 90 s deadline, failures named
>         (`VALIDATION_TIMEOUT` / `_NOT_CONFIGURED` / `_UNAVAILABLE`), 5 checks a store a day
>         (429 `RATE_LIMITED`), admin email (`ADMIN_ALERT_EMAIL`); live items queued on save
>         (`APP_ITEM_CHECK`, 3 min), swept every minute, flagged → hidden (storefront and
>         checkout) + `APP_ITEM_REVIEW` queue + email; admin "Hidden items" on /admin/stores
>         (show again / keep hidden); merchants see "Hidden: under review" / "Hidden by
>         Ceseelia". **Switched on 2026-11-15:** `anthropicApiKey` is in `ceseelia/dev` and
>         `ceseelia/prod`; the eval (`scripts/store-check-eval/run.mjs`, text only) got 60 of 60
>         right (0 of 30 legitimate flagged, 0 of 30 sketchy missed), ≈ $0.34, slowest 6.5 s.
> - [x] **L.3 Security hardening, S.14–S.17** (done 2026-11-14): helmet and nginx headers (HSTS,
>       `server_tokens off`), a hardened Docker image (`npm ci --omit=dev`, non-root), legacy
>       DinersXpress / PrimeFaya code removed, and **`certbot-renew.sh` fixed** (wrong
>       `primedine` paths, not executable, renewed certs never loaded).
> - [x] **L.4 Production basics, Stage 9:** structured logs with no PII (9.1), rate limits and
>       body limits (9.2), a health check and graceful shutdown (9.3), CI (9.4), infrastructure
>       as code (9.5), backups (DynamoDB PITR), lifecycle rules and alarms (9.6). **Code done
>       2026-11-15.** Owner steps to make it live:
>       1. Push the backend (CI runs on the push) and the webapp as usual.
>       2. CloudFormation: set the repo variable `ALARM_EMAIL` (GitHub › Settings › Secrets and
>          variables › Actions › Variables), merge `dev_v1.0.0_l4_backups_alarms` into
>          `dev_v1.0.0` and push (deploys dev), check it, then the same into `prod_v1.0.0`
>          (prod is also behind dev by the 2026-11-09 upload-expiry rule). Click the SNS
>          confirmation email.
>       3. After prod deploys: `aws iam put-role-policy --role-name CeseeliaServerRole
>          --policy-name ceseelia-server-prod --policy-document file://iam/ceseelia-server-policy.json`
>          (adds writing to `/ceseelia/prod/api`).
> - [x] **L.5 WA 6.4 new-order notifications** in the dashboard (a toast and a sound; web push,
>       BE 6.7). **Code done 2026-11-15.** When an order is first paid, `notifyOrderPaid` also
>       writes an alert row and sends web push (VAPID, no Firebase) to every member's browsers
>       that turned it on; the dashboard polls `GET /store/orders/new/:storeId` (20 s on screen,
>       60 s hidden) for the bell (badge, recent orders → the order drawer), a toast, a chime and
>       an instant Orders reload. **Owner, to switch push on:** `node scripts/setup-vapid.mjs
>       --write` (dev), then `APP_SECRET_ID=ceseelia/prod node scripts/setup-vapid.mjs --write`,
>       and restart the API. Until then the bell says push is "coming soon"; toast and sound work
>       without it. Not tried in a real browser yet (needs a signed-in session and the keys).
> - [x] **L.6 Store Overview:** WA 6.5 with BE 1.5 merchant stats (today's orders, revenue,
>       best sellers). **Done 2026-11-15:** Store › Overview (first in the store sidebar) from
>       `GET /store/overview/:storeId?tz=`: orders / sales today and over the last 7 days (with
>       the change against the 7 before), average order, an orders-per-day chart (with a table
>       view) and the 30-day best sellers. Paid orders only, on the day they were paid, in the
>       browser's time zone; refunds come off sales; currencies never added together. Checked
>       read-only on Northern Hoop (no paid orders yet, so zeros). One-store merchants still
>       land on Orders; say if Overview should be the home page instead.
> - [x] **L.7 Stage 7:** Store › Customers (7.1), unified rewards and earn/redeem (7.3, 7.4),
>       reviews (7.5). 7.2 (optional customer accounts) included. **7.1 Customers and 7.5 reviews done
>       2026-11-15.** Owner's decisions (2026-11-15): reviews only from verified buyers, live at
>       once, merchants reply and report but never edit or remove, the platform admin keeps or
>       removes reported ones; rewards prove the shopper with an emailed code (also the light
>       7.2 accounts); commission is on the price after a rewards discount. **7.2 (light), 7.3 and
>       7.4 rewards done 2026-11-15** (backend and webapp); owner step: run
>       `scripts/normalize-rewards-method.mjs --write` on dev and prod (one dev store found).
> - [x] **L.8 Stage 8 admin console:** real admin overview stats (8.1), support tickets (8.3),
>       commission reporting (8.4). (8.2 join requests stay superseded by P.3.) **Done
>       2026-11-15** (backend and webapp); checked read-only on dev (6 draft stores, 7 merchants,
>       no orders or tickets yet).
> - [~] **L.9 The rest:** CloudFront in front of the storefront and the bucket (3.2b), WA 3.6
>       SEO / link previews, account delete (BE `delete-user`, WA 1.6d), custom domains
>       (P.9 / 9.8), the admin menu's review-queue badge, paging Admin › Stores.
>       **Done 2026-11-15:** menu badges (`GET /admin/queue-counts`), paging Admin › Stores
>       (`get-all-stores?q=&limit=&cursor=`), account delete (`delete-user`, WA 1.6d), webapp
>       hosting on S3 + CloudFront (3.2b, deployed to dev and prod 2026-11-15; prod app uploaded)
>       and link previews (WA 3.6, `/store/public/preview`). **Later:** 9.8 custom
>       domains (after launch; listed as "coming soon").
>
> - [x] **L.10 Messages (owner, 2026-11-16: before launch):** an async chat between a store and
>       its shoppers on Ceseelia, not email. One conversation per order (the shopper opens it from
>       the order page with the order's token; either side can write first) and inquiries from the
>       storefront's Contact us (the shopper gets a private link by email). Text and up to 4
>       photos per message; the inbox and each conversation are paginated; unread both ways;
>       Store › Messages with a menu badge, push on new messages, an email to the store after 30
>       minutes unread (Settings, default on) and to the shopper on a reply (once until read).
>       Messages stay with their order, or with the store for an inquiry, until the store is
>       deleted. Stores report a conversation; admins dismiss or block it.
>       **Backend done 2026-11-16** (routes, 57 tests). **Webapp:** Store › Messages, the order
>       page's Messages, Contact us as a conversation, the shopper's `/messages/:id` page, the
>       order drawer's "Message customer", the Settings switch, Admin reported conversations
>       (**done 2026-11-16**; on prod and tested by the owner 2026-11-16: works).

> **Prod as of 2026-11-15 (replaces the 2026-11-14 notes on secrets, the server and the AI key).**
> - **API:** `https://api.ceseelia.com` on `ceseelia-0` (i-0533c778bf9ef2411, t3.micro, Amazon
>   Linux 2023, Elastic IP 184.192.215.17, instance profile `CeseeliaServerRole`, security group
>   `ceseelia-api`: 80/443 public, SSH only from the owner's IP). Key
>   `~/Documents/pem/ceseelia-0.pem`. `server.conf` holds host/key/folder for the deploy scripts;
>   deploy = `./scp-fs.sh build`, then `./ssh-server.sh 'cd ~/ceseelia && ./node-update.sh'`.
>   First boot: `ec2-user-data.sh`; app setup: `system-init.sh` (certificate, containers, cron).
> - **Webapp:** `https://app.ceseelia.com` (S3 + CloudFront), `tools/deploy-s3.sh prod` in the webapp.
> - **Secrets (`ceseelia/prod`):** Stripe **test** key and both test webhook secrets,
>   `anthropicApiKey`, VAPID keys. Live Stripe values come in D1.
> - **Stripe test mode (platform account):** Connect webhook `we_1UcEEvGS7poxugeoEGr30Pl1`,
>   Billing webhook `we_1UcEEvGS7poxugeojsIaBa0a` (API version `2025-08-27.basil`), Spark/Nova
>   prices, SaaS tax code, default customer portal. `PAID_PLANS_ENABLED` is off on prod.
> - **AI store check:** on in dev and prod (eval 60/60).
> - **When D1 comes:** a restricted live key (`rk_live_…`) can be IP-allowlisted to
>   184.192.215.17 (5.2e).

> **Still open after launch prep (2026-11-15).** Owner: §0 C2 (Stripe Tax, Smart Retries),
> C3, C4, D1, D3, D5; an accountant to confirm the delivery-tax simplification (4.2 follow-up).
> Claude, before launch: the webapp's Content-Security-Policy (WA S.14, CloudFront) and legal
> pages (WA 9.1; owner reviews the text). After launch or optional: lint warnings (9.7),
> custom domains (9.8), the link-before-verify fix before any social sign-in (1.1c), and the
> webapp's Stage 9 list. 8.2 join requests stay superseded by P.3.

> **2026-11-13: no Free plan any more (P.10).** Only Spark and Nova. A new store is a draft with
> no plan (`plan: "NONE"`), visible to its members only; going live and subscribing are one step
> (Go Live → Stripe Checkout → the webhook takes it live). Merchants switch Spark ↔ Nova in the
> billing portal; when a plan ends (cancelled at the period's end, or a failed payment after the
> 7 days' grace) the store goes back to a DRAFT with `pausedReason: "PLAN_ENDED"`. P.7 (Free
> order limit) is dropped. `scripts/migrate-free-plan.mjs --write` was run on dev (2026-11-13:
> the 4 dev stores are now drafts with no plan).
>
> **Earlier notes (2026-11-12, kept for the rules; the list above is current):** Stages S, 0–4 and **Stage P (P.1–P.6, P.8, P.10, P.11)** are done in both
> repos, plus 5.1 (Stripe Connect Standard, commission rules) and 5.2 (merchant onboarding).
> Latest commits: see `git log` (P.8 is the last one). **Next steps, in order:**
> 0. ~~Owner's Stage P QA in the UI~~ done 2026-11-13 (`../ceseelia_webapp/progress.md` §1b,
>    all passed, paid plans included; P.11 came out of it).
> 1. **Stage 5 checkout.** 5.3–5.6 are **done 2026-11-13** (order model, create-order, the
>    Connect webhook, on-paid stock/counters) plus 6.6 order-status. Next: **WA 5.1 checkout
>    page and 5.2 return page**; the owner adds the Connect webhook in Stripe (5.5 "Setup").
>    5.7 sweeper is a fallback for missed `expired` events. Rules already decided:
>    re-quote on the server with the delivery postal code; refuse unless the store is LIVE, not
>    suspended and `paymentsEnabled`; fee = `platformFeeForStore(admin, lifecycle.plan, quote)`
>    and save `commissionInEffect(...)` on the order (P.6); direct charge on the connected
>    account with `application_fee_amount`; **never `automatic_tax`** on shopper checkout;
>    online payment only (no pay at pickup). The Connect webhook uses `webhookSecret`, the
>    platform Billing one (`/api/v1/billing/stripe-webhook`) uses `billingWebhookSecret`.
> 2. ~~P.7 Free order limit~~ dropped with the Free plan (P.10, 2026-11-13).
> 3. **Owner TODOs (not code):** build the AI check in `runSmartStoreValidation`
>    (`layers/core/store-validation`, still a stub that passes every store); do the Stripe
>    Billing setup listed under P.5 "Setup" (prices script, Stripe Tax, webhook, retries,
>    portal) and test a Spark checkout end to end in test mode; set `PAID_PLANS_ENABLED=true`
>    in prod once that works; S.2 password rotation.
> 4. Later: merchant emails on review decisions (Stage 8 / 6.3), admin menu badge for the
>    review queue, paging Admin › Stores (it reads every SETTINGS row), P.9 custom domains (9.8),
>    BE 1.5 merchant stats (after orders exist), S.14–S.17 before going live.
> Dev test data: store Northern Hoop `01M6DTXGVMGDBPQ6Y70JT4R9G1`; `shukybadeer+m1@gmail.com` is
> its MERCHANT; `shukybadeer+ms1@gmail.com` is the non-member tester; admin is
> `shukybadeer@gmail.com`.

| Area | Status | Notes |
|---|---|---|
| Foundations (config, token verification, CORS, tests, lint) | ✅ Done | Stage 0, 2026-11-02 |
| Security & bug fixes (Stage S) | ✅ Done | S.0–S.17 done (S.2 by the owner, 2026-11-15) |
| Users / registration | ✅ Works | CloudFormation `OnUserRegister` Lambda creates users; `get-my-profile` fills in missing rows (1.1) |
| Store membership + access | ✅ Works | Members/invites (1.2, 1.4); every `/store/**` route checks membership, admins bypass (1.3) |
| Store create / settings / images | ✅ Works | Admin-only settings via `/admin/*-store-admin-settings` (1.6) |
| Store delete | ✅ Works | Whole store incl. members, invites, slug, S3; retry-safe (1.7, 1.8) |
| Slugs | ✅ Works | Format rule, unique via `SLUG#<slug>` reservations (409 on clash), public `resolve-slug` (1.8) |
| Categories & items CRUD | ✅ Works | Item counts kept by item writes (2.1); a category with items can't be deleted (409, 2.2) |
| Public storefront data | ✅ Works | Only active items in active categories; 404 `STORE_NOT_FOUND` / `STORE_UNAVAILABLE` (2.4); no admin block (1.6) |
| Merchant / customer APIs | ✅ Works | Store overview stats (1.5), customers, rewards, reviews (Stage 7) |
| Cart, checkout, orders, payments | ✅ Works | Stages 4–6; first real test order is §0 C3 |
| Admin stats, join requests, tickets | ✅ Works | Stage 8 (join requests superseded by P.3) |
| Production readiness (logging, rate limits, CI, IaC) | ✅ Done | Stage 9 except 9.7 (lint warnings); 9.8 store subdomains live, custom domains coded 2026-11-16 (deploy §0 G4–G5); prod live 2026-11-15 |

**Health check (2026-11-15):** `npm test` 1176/1176 passing · `npm run typecheck` clean ·
`npm run lint` 0 errors, 68 warnings · `npm audit --omit=dev` 0 vulnerabilities.

---

## 2. Stage S — Security & bug fixes (do these first)

These came out of the code review. They don't need the membership model, so they can ship now.
S.0 is a temporary lockdown that closes the worst hole until Stage 1.3 replaces it.

### S.A — Stop the bleeding
- [x] 🔴 **S.0 Interim lockdown of `/store/**`.** _Done 2026-11-08: flag
      `STORE_ROUTES_ADMIN_ONLY` in `layers/core/http`, tests in `tests/store-access.test.ts`._ Today any signed-in Cognito user (anyone can
      sign up) can read, overwrite and delete any store's settings, categories, items and S3
      images by passing its `storeId`. Until 1.3 lands, set `adminOnly = true` on every
      authenticated `/store/**` route: create, delete, update-settings, all upload-URL routes,
      category create/delete, item create/delete and `inventory/get-data`. Merchants can't reach
      their stores yet anyway (no membership), so nothing legitimate breaks. Add a test that a
      non-admin gets 403.
- [x] 🔴 **S.1 Revoke the hard-coded Google Maps API key** in `layers/core/utils/index.ts`
      (`getLatLngTimezoneData`). It is in git history, so treat it as public: revoke or restrict it
      in Google Cloud, then delete the function (nothing calls it).
  - [x] a. Code removed 2026-11-08 (`getLatLngTimezoneData` and its only helper
        `sendHttpsRequest`). No other copy of the key exists in either repo.
  - [x] b. **Manual:** revoke (or restrict) the key in Google Cloud Console → APIs & Services →
        Credentials. It stays readable in git history, so it must be revoked, not just deleted.
        _Done by the owner (confirmed 2026-11-08)._
- [x] 🔴 **S.2 Rotate the old password** that used to be in `node/README.md`. It's still in git
      history (manual step, carried over from Stage 0). _Done by the owner 2026-11-15._
- [x] 🟠 **S.3 Patch dependencies:** `npm audit fix`, re-run tests. Remove unused deps
      (`axios`, `jwt-decode`, `mustache-express`, `nodemailer`, `https`, `cookie-parser` if
      unused). Fewer deps means less attack surface.
  - _Done 2026-11-08, tested by hand. Removed `axios`, `cookie-parser` (+ types),
    `https`, `mustache-express`, `nodemailer` (and the unused Diner's Xpress
    `sendWooInvoiceEmail` + template that was its only user). `npm audit fix`, then
    `geoip-lite` 1 → 2 (fixes the high `ip-address` advisory; needs Node ≥ 24), so the Docker
    image moves from `node:20-alpine` (end of life) to `node:24-alpine`. Audit: 53 (3 critical,
    10 high) → 10 moderate, all `minimatch` in dev tooling (eslint, typescript-eslint, nodemon).
    `jwt-decode` stays: the legacy Cognito helpers in S.16a still use it; drop it with them._

### S.B — Request validation & data integrity
- [x] 🟠 **S.4 ID validation helper.** Add `isUlid(id)` and use it in `pureRequestParams` for every
      `storeId`, `storeCategoryId`/`categoryId` and `storeItemId`/`itemId`, in both path params and
      body. Right now those values are put straight into DynamoDB keys and S3 prefixes
      (`store/${storeId}/…`) with no checks.
  - _Done 2026-11-08, tested by hand. `isUlid` / `isUlidOrEmpty` in `layers/core/utils`,
    applied on all 14 routes that take an ID (path and body), including the public
    `get-data-public` and `admin/update-store-info`. Creates (`isUpdate=false`) may still omit
    `categoryId` / `storeItemId`; updates must send a valid one. Tests in `tests/ids.test.ts`.
    `vitest.config.mts` now gives tests fake AWS credentials and a dead endpoint, so a test can
    never write to the real dev table._
- [x] 🟠 **S.5 No more blind upserts.**
  - _Done 2026-11-08, tested by hand. Shared `writeStoreChild` in the store entity:
    create = new ULID in a transaction that checks the store's `SETTINGS` row
    (`attribute_exists`) and the new row (`attribute_not_exists`); update = `attribute_exists`.
    Missing records throw `StoreRecordNotFoundError`, which the routes map to **404** ("Store /
    Category / Item not found"). Tests in `tests/store-writes.test.ts`. **Webapp change (same
    task):** the category and item forms used to send `isUpdate: false` with the existing ID
    when editing; they now send a single update for edits and only create for new records._
  - [x] a. `updateStoreSettings`: add `ConditionExpression: attribute_exists(pk)`. Without it,
        a PUT with a made-up `storeId` creates a junk `SETTINGS` row.
  - [x] b. `updateStoreCategory` / `updateStoreItem`: on `isUpdate=false`, ignore any
        client-supplied id and use `attribute_not_exists`. On `isUpdate=true`, require the id and
        use `attribute_exists`. Today `isUpdate=false` plus an existing id silently overwrites a record.
  - [x] c. Check that the store exists (its `SETTINGS` row) before creating a category or item.
  - [x] d. Tests for each case.
- [x] 🟠 **S.6 Run S3 cleanup only after the DB write succeeds**, in `category/create` and
      `inventory/create-item`. They currently delete "unused" images before the write. The same bug
      was fixed for update-settings in Stage 0.
  - _Done 2026-11-08, tested by hand. Both routes now write first and clean up after.
    Tests in `tests/store-writes.test.ts` check that a failed update deletes nothing and a
    successful one lists and deletes only after the write._
- [x] 🟠 **S.7 Fix the batch helper so it reports failures.** `dynamoWriteManyItems` uses
      `Promise.allSettled` and never throws, so `createStore` (and `registerUser`) return success even
      when the write failed or items were left unprocessed. Throw when a batch is rejected or
      `unprocessed > 0`. Also, `dynamGetManyItems` only returns the first batch's results.
  - _Done 2026-11-08, tested by hand. Rewrote `dynamo-batch-ops`: unprocessed writes and
    keys are retried with backoff, then a `DynamoBatchError` is thrown; a rejected batch throws
    too. Reads use batches of 100 and return items from every batch. Inputs are no longer
    mutated. `createStore` / `registerUser` already pass errors on, so a failed write is now a
    500 instead of a false success. Batches aren't atomic: ones written before a failure stay.
    Tests in `tests/dynamo-batch.test.ts`._
- [x] 🟠 **S.8 Paginate `getStoreInventoryData`.** Queries stop at 1 MB, so a large store silently
      loses categories and items. Loop on `LastEvaluatedKey`, as `getAllStores` already does.
  - _Done 2026-11-08, tested by hand. New `queryAllWithPrefix` in the store entity
    follows `LastEvaluatedKey`; categories and items both use it. Tests in
    `tests/store-inventory.test.ts`._
- [x] 🟡 **S.9 Tighten the validators** (`layers/core/interfaces/store`):
  - _Done 2026-11-08, tested by hand. Limits in `node/constants/input-limits.ts` (same
    lengths/ranges as WA S.15, plus list caps: 10 images/item, 30 hashtags, 10 params, 30
    options, 10 promo images, 3 currencies; `customize` ≤ 20,000 chars). Format helpers in
    `layers/core/utils/validation.ts`. Stock allows `-1` (unlimited, for 2.6). Image keys must be
    `<this store's folder><ULID>.png|jpg|jpeg`; a new category/item can't reference images yet.
    Store name/slug lengths also checked in `store/create` and `admin/update-store-info` (slug
    format waits for 1.8). Real dev data passes. Tests in `tests/store-validators.test.ts`.
    **Webapp changes (same task):** blank parameter options are dropped before saving, and the
    default currency can only move (never be switched off; deleting it passes it on)._
  - _Use the same limits as the webapp (WA S.15, 2026-11-08):
    `ceseelia_webapp/src/app/core/constants/input-limits.constants.ts` for lengths and ranges,
    `…/core/functions/input-validation.functions.ts` for URL / email / phone formats. Note the
    webapp accepts phone and WhatsApp as digits with optional `+`, spaces, `-`, `()` (7–15
    digits), and stock as an integer ≥ 0 (no `-1`)._
  - [x] a. Max lengths on every string (names, descriptions, slogan, hashtags, labels, options).
  - [x] b. Numbers: price ≥ 0 (since 2.5: whole cents per currency), stock is an integer ≥ -1, item/category discount 0–100, priority
        is one of `PRIORITY_*`.
  - [x] c. Array caps: images per item (e.g. ≤ 10), hashtags, custom params, options, promo images,
        currencies.
  - [x] d. Image URIs must start with the right store prefix (`store/<storeId>/images/logo/`,
        `…/item/<itemId>/images/`, and so on). Today a merchant can point at another store's files.
  - [x] e. Social links must be empty or `https?://` URLs. Email must look like an email.
        WhatsApp must be digits.
  - [x] f. Exactly one `currencyIsDefault`, and currency codes are ISO-4217 from an allow-list.
  - [x] g. `customize`: validate the t0 shape (colors are hex, URIs as in d) and cap its
        serialized size. Today it's an unchecked `any`.
  - [x] h. `storeParamOptions` must be non-empty strings.
- [x] 🟡 **S.10 Validate `userPreferredLocale`** in `get-my-profile/:locale` against an allow-list
      before writing it.
  - _Done 2026-11-08, tested by hand. `appConstants.SUPPORTED_LOCALES` (`en`, `id`);
    anything else is a 400 and isn't saved. Tests in `tests/user-routes.test.ts`._
- [x] 🟡 **S.11 Make `delete-user` consistent.** It deletes the Cognito user but leaves the DB
      records (that code is commented out). Either disable the route until 1.1/1.2 or finish it:
      delete the DB rows and memberships, refuse while the user is the only member of a live store,
      then delete from Cognito last.
  - _Done 2026-11-08, tested by hand. **Disabled for now:** returns 501 and deletes
    nothing (the webapp never calls it). **Re-enable after 1.2** with the full delete described
    above._
  - _**Built 2026-11-15 (L.9).** `DELETE /user/delete-user` `{ confirm: "DELETE" }`: refuses
    admins (403 `ADMIN_ACCOUNT`) and the only member of a store (409 `ONLY_MEMBER`); leaves the
    store, deletes the user's tickets and messages, then every Cognito login, then every USER#
    row (logins first so a failure can be retried; a login already gone counts as done). 3 tries
    an hour. Orders, reviews and rewards stay with the store. **Owner:** `iam/` now allows
    `cognito-idp:AdminDeleteUser`; update `CeseeliaServerRole` from the file._

### S.C — Hardening
- [x] 🟡 **S.12 Move identity off `req.body`.** The wrapper writes `cognito_id`, `is_user_admin`
      and `cognito_token` into the client-controlled body. On a public (`withAuth=false`) route a
      client could send `is_user_admin: true` itself. Put identity in `res.locals.auth`, remove
      `cognito_token` (nothing reads it, and it could end up in logs), and update the routes.
  - _Done 2026-11-08, tested by hand. Identity is in `res.locals.auth`
    (`{cognitoId, groups, isAdmin}`), read with `getAuth(res)`, which throws on a public route. The
    token isn't stored. The old keys are stripped from every request body. Updated
    `get-my-profile`, `update-profile`, `update-fcm-token` and the admin gate. Tests in
    `tests/http.test.ts`._
- [x] 🟡 **S.13 Make the client IP trustworthy.** Change `app.set('trust proxy', true)` to `1`
      (one nginx hop), and have `getClientIp` use `req.ip` instead of the raw `cf-connecting-ip` /
      `x-forwarded-for` headers, which clients can spoof. Rate limiting (9.2) depends on this.
  - _Done 2026-11-08, tested by hand. `trust proxy` is `TRUST_PROXY_HOPS` (env, default
    1 = nginx). `getClientIp` and the request logger use `req.ip`; `cf-connecting-ip` is no longer
    read (no Cloudflare in front). **When CloudFront goes in front (3.2), set
    `TRUST_PROXY_HOPS=2`.** Tests in `tests/client-ip.test.ts`._
- [x] 🟡 **S.14 Security headers** (2026-11-14): `helmet` 8.1.0 in `app.ts` (HSTS, nosniff,
      frame options; `Cross-Origin-Resource-Policy: cross-origin` so the webapp can read the
      API). nginx: `server_tokens off`, TLS 1.2/1.3 only, session tickets off, client timeouts,
      an HTTPS default server that refuses unknown names (`ssl_reject_handshake`). HSTS comes
      from helmet only, so it isn't sent twice. Images pinned: `nginx:1.30.6-alpine`,
      `certbot/certbot:v5.10.0` (compose and both cert scripts). Checked with `nginx -t` in the
      pinned image.
- [x] 🟡 **S.15 Harden the Docker image** (2026-11-14): `npm ci --omit=dev --ignore-scripts`,
      `NODE_ENV=production`, runs as `node` (not root), `HEALTHCHECK` on `/healthz`; nginx
      starts once node is healthy. Built and run locally: user `node`, no dev tools, healthy,
      SIGTERM → "closed cleanly", exit 0. `npm audit --omit=dev`: 0 vulnerabilities.
- [x] ⚪ **S.16 Legacy code removed** (2026-11-14), not just quarantined:
  - [x] a. `cognito.signIn` and `processAuthCode` deleted (and `decodeJwtToken`,
        `isUserAdminByDecodedToken`, `attachCookie`; the `jwt-decode` package is gone).
  - [x] b. `layers/stripe` (DinersXpress checkout) deleted; `layers/payments` is the only Stripe code.
  - [x] c. PrimeFaya constants (buckets, PayPal links, logo URLs), `getPaymentLink`,
        `getAndroidEnterpriseServiceAccount` and the PrimeFaya PDF (`layers/core/utils/pdf`)
        deleted; receipts use `layers/notifications/receipt-pdf.ts`.
  - [x] d. Duplicate `intervalInMs` check in `registerTimer` removed.
- [x] ⚪ **S.17 Ops scripts** (2026-11-14): `certbot-renew.sh` rewritten. It works from the
      folder it's in (no `primedine` paths), the cron line runs it with `/bin/bash` (the
      "Permission denied" seen on primehost-0 is the same bug in another project's copy), and nginx is reloaded
      from the host when a certificate renews (the old `--deploy-hook` ran `docker compose`
      inside the certbot container, so a renewed cert was never loaded). Every `*.sh` is
      executable in git. `generate-cert.sh`: runs from its own folder, `CERT_EMAIL` (default
      support@ceseelia.com), reloads nginx instead of restarting node. `system-init.sh` takes
      `PROJECT_DIR`.
      Ceseelia's server doesn't exist yet; `system-init.sh` installs the right cron line on it.
      Add a confirmation prompt to `docker-close-all.sh`, which removes every container and image
      on the host.

---

## 3. Stage 1 — Users, merchants & store ownership 🔴

Closes the cross-tenant access hole for good, and replaces S.0.

### 1.1 User registration
_Registration already exists in `../ceseelia_cloudformation`: the `OnUserRegister` Cognito
**PostConfirmation** Lambda (deployed in dev, attached to pool `us-east-1_8P3eUW341`) writes
`PROFILE#INFO`, `PROFILE#COGNITO_DATA#<sub>` and `PROFILE#NOTIFICATION_SETTINGS`. Checked
2026-11-08: table, GSI, entity and attribute names, pool/client IDs and the `Admins` group all
match the backend and webapp._
- [x] a. Decide: Cognito **Post Confirmation Lambda** (the CloudFormation project).
- [x] b. Implement it. The Lambda reads email from the Cognito event (verified by Cognito), never
      a request body.
- [ ] c. The Lambda links a new Cognito identity to an existing user just because the email
      matches. Only link when `email_verified === true`, or an unverified federated identity could
      take over an account. **Not exploitable today** (no social/federated providers are
      configured); fix it in `ceseelia_cloudformation` before adding social sign-in.
- [x] d. Fallback: `get-my-profile` creates the record on first call if it's missing. Needed:
      the Lambda logs and swallows every error, and its batch helper has the pre-S.7 bug, so a
      failed write leaves a Cognito user with no DB rows. Write **exactly the Lambda's rows and
      attributes** (the backend's own unused `registerUser` also adds `userPlan`; align or replace
      it).
- [x] e. Return a clear `404 PROFILE_NOT_FOUND` instead of a generic 500 when there's still no
      record. (WA 1.1)
- [x] f. Tests.
  - _d–f done 2026-11-08, tested by hand. `get-my-profile`: if no `COGNITO_DATA` row
    exists, read the user's attributes from the pool (`AdminGetUser` by `sub`) and, only when
    `email_verified` is true, write the Lambda's three rows in one transaction
    (`createUserRecordsFromCognito`; links to an existing user with the same verified email).
    Otherwise 404 `{code: "PROFILE_NOT_FOUND"}`; a deactivated account is 403
    `ACCOUNT_DEACTIVATED`; other `/user` routes map the same errors. Removed the backend's unused,
    drifted `registerUser`. Tests in `tests/user-registration.test.ts`. **Prod needs the EC2 role
    to allow `cognito-idp:AdminGetUser`** on the pool._

### 1.2 Membership data model
- [x] a. Write `STORE#<storeId>` / `MEMBER#<userId>` (`StoreMember`) and the reverse
      `USER#<userId>` / `STORE#<storeId>` (store id, name, slug, role), in one transaction.
- [x] b. Entity helpers: `addStoreMember`, `removeStoreMember`, `listStoreMembers(storeId)`,
      `listUserStores(userId)`, `getMembership(storeId, userId)`.
- [x] c. `get-my-profile` returns `stores: [{storeId, storeName, storeSlug, role}]` (replaces
      `userStoreIds`). (WA 1.2)
- [x] d. Tests.
  - _Done 2026-11-08, tested by hand. `layers/aws/dynamodb/dynamo-entities/membership`.
    Roles are the existing `ADMIN` / `MERCHANT`. **Change from the plan:** the reverse row holds
    only `storeId` + role; names/slugs/emails are read from the store overview and user profile
    when listing, so a rename never leaves stale copies. Paged query helper moved to
    `layers/aws/dynamodb/dynamo-query`. WA `UserProfile.stores` replaces the unused
    `userStoreIds`. Tests in `tests/membership.test.ts`._

### 1.3 Store access check (replaces S.0)
- [x] a. `assertStoreAccess(req, storeId, role?)`. Admin bypasses it; otherwise it reads
      `getMembership` and returns 403 if there's none.
- [x] b. Apply it to **every** `/store/**` route (settings, uploads, categories, items, get-data),
      then remove `STORE_ROUTES_ADMIN_ONLY` (S.0) from `layers/core/http` and the routes
      (`create` and `delete` stay admin-only). Update `tests/store-access.test.ts`.
- [x] c. Route-matrix test: no token → 401 · non-member → 403 · member → 200 · admin → 200.
  - _Done 2026-11-08, tested by hand. The wrapper's 7th argument is now `access`:
    `false`, `true` (admins only) or `storeMember((req) => …storeId, role?)`. The check runs right
    after sign-in, before param validation, so non-members get 403 `STORE_ACCESS_DENIED` without
    seeing validation errors; a malformed store id is 400. Deactivated users get 403
    `ACCOUNT_DEACTIVATED`. `STORE_ROUTES_ADMIN_ONLY` is gone; `create` and `delete` stay
    admin-only. Dev test data: `shukybadeer+m1@gmail.com` is a `MERCHANT` of Northern Hoop._

### 1.4 Admin member management
- [x] a. `GET /admin/get-store-members/:storeId`
- [x] b. `POST /admin/assign-store-member` (by email; if there's no account, store a pending invite
      and email it via SES)
- [x] c. Turn a pending invite into a membership on registration (1.1)
- [x] d. `DELETE /admin/remove-store-member/:storeId/:userId`
- [x] e. Tests. (WA 1.4)
  - _Done 2026-11-09, tested by hand through WA 1.4 (invite → sign-up → lands on the store). Invites are two rows (`STORE#…/INVITE#<email>` and
    `INVITE#<email>/STORE#…`); re-inviting replaces the invite, so it doubles as "resend". c is
    done in `get-my-profile` (owner's choice; the CloudFormation Lambda is untouched): every
    pending invite for the profile's verified email becomes a membership, one transaction per
    store; a failure there never blocks sign-in. Also added `DELETE
    /admin/cancel-store-invite/:storeId/:email` (needed by the WA 1.4 UI) and `WEBAPP_URL`
    config for the email link (`/auth/sign-up?email=…`, so the webapp prefills the address).
    Adding an existing account sends no email. Tests in
    `tests/admin-members.test.ts` and `tests/membership.test.ts`; also run against the dev table._

### 1.5 Merchant overview
- [x] Replace the `/merchant/path` stub with `GET /merchant/get-overview-data`: the merchant's
      stores plus headline counters from `StoreOverview`. (WA 1.2)
  - _Done differently 2026-11-15 (L.6): one store per account since P.11, so the numbers are
    per store: `GET /store/overview/:storeId?tz=` (members; `layers/core/store-stats`, orders
    via `listStatsOrders`, ≤ 3,000 newest, `partial` beyond; kept 30 s per store and zone).
    Today / last 7 / the 7 before (orders, sales net of refunds, average order, per currency),
    7 days in a row, 30-day best sellers (units, top 5). The `/merchant/path` stub is unused
    and left as is. Tests in `tests/store-stats.test.ts`._

### 1.6 Admin-only store settings
- [x] a. `PUT /admin/update-store-admin-settings` (`salesCommission` ≥ 0, `isStoreLive`).
- [x] b. Keep `admin` out of the merchant `update-settings` (already ignored) and the merchant
      `get-data` response. (WA 1.5)
  - _Done 2026-11-09, tested by hand. Also `GET /admin/get-store-admin-settings/:storeId`
    (the admin UI needs the current values; defaults for stores saved without the block).
    `withoutAdminSettings` strips the block from merchant `get-data` **and from
    `get-data-public`, which was sending the platform commission to anyone**. Tests in
    `tests/admin-store-settings.test.ts`._

### 1.7 Store delete (admin)
- [x] a. Query and batch-delete every `STORE#<id>` item (settings, categories, items, members,
      and later orders).
- [x] b. Delete the `APP_STORE` overview row, the reverse `USER#…/STORE#…` rows and the slug
      reservation (1.8).
- [x] c. `deleteS3FilesPrefixed('store/<id>/')`.
- [x] d. Make it idempotent (safe to retry) and admin-only. Tests. (WA 1.4)
  - _Done 2026-11-09. `deleteStore` in the store entity; order is
    SETTINGS (stops new writes) → partition + `USER#…/STORE#id` + `INVITE#…/STORE#id` → S3
    `store/<id>/` → overview last, so a failed delete stays in the admin list and can be run
    again. The slug reservation in b doesn't exist yet (1.8 must add it to the delete).
    `deleteS3Files` now sends at most 1000 keys per request and throws on per-object errors
    (it used to fail over 1000 and ignore partial failures). Tested on a throwaway dev store
    (member, invite, S3 file): everything gone, Northern Hoop untouched._

### 1.8 Slugs
- [x] a. Slug format rule (lowercase `a-z0-9-`, 3–40 chars, reserved words blocked).
- [x] b. Reserve `SLUG#<slug>` → storeId with a conditional put, in a transaction with
      create / `update-store-info`. Release the old slug on rename. Return 409 on conflict.
- [x] c. `GET /store/public/resolve-slug/:slug`. (WA 3.1)
  - _Done 2026-11-09, tested by hand. Rule in `constants/slug.ts` (`isValidSlug`, `RESERVED_SLUGS`; the webapp
    mirrors it in `slug.constants.ts`). Reservation row: pk `SLUG#<slug>`, sk `STORE`,
    `storeId`; helpers in `dynamo-entities/slug`. `createStore` is now one transaction (overview +
    settings + slug, instead of a batch). `updateStoreInfo` reads the overview, then in one
    transaction updates it (only if the slug is unchanged since the read, else retries up to 3×),
    reserves the new slug (free or already ours) and releases the old one if we hold it; 409
    `{message: "That slug is already taken."}`, 404 for a missing store. `deleteStore` frees the
    slug (only while ours) just before the overview row. `resolve-slug` is public, lowercases the
    slug, returns `{storeId}` or 404, and doesn't check `isStoreLive` (2.4). Tests in
    `tests/store-slugs.test.ts`. Existing stores: `node scripts/backfill-slug-reservations.mjs`
    (dry run; `--write` applies; run `npm run build` first). **Run it on prod with
    `DB_TABLE_NAME=ceseelia_prod` when prod exists.** Backfilled on dev (Northern Hoop →
    `northern-hoop`) and `resolve-slug` checked live against dev. Admin › Stores create/rename/
    delete tested by hand._

---

## 4. Stage 2 — Inventory hardening

- [x] 🟠 **2.1 Correct category item counts.** Stop resetting `storeCategoryItemCount` to 0 on
      every category save. Use an atomic `ADD` on item create, delete and category moves (in a
      transaction with the item write). One-off script to recompute existing counts. (WA 2.1)
  - _Done 2026-11-09, tested by hand. Category saves no longer write the count (a new category starts at 0).
    Item create: one transaction (store exists, new row, `ADD +1` to its category only if the
    category exists, else 404 `Category not found`). Item update: reads the item's category, then
    one transaction guarded on that category (retries up to 3× if it moved meanwhile); a move
    adds +1 to the new category and -1 to the old one (skipped if the old one is already gone).
    Item delete: one transaction with -1 to its category; the route now deletes the item
    **before** its S3 images (a failed delete used to leave the item without images). Tests in
    `tests/category-counts.test.ts`. Existing data: `node scripts/recompute-category-item-counts.mjs`
    (dry run; `--write` applies; lists orphaned items). Dev fixed (Hoodies 0 → 1). **Run it on
    prod when prod exists.**_
- [x] 🟠 **2.2 Category delete rule.** Reject with 409 when the category still has items (enforced
      server-side; today only the UI checks). Document the rule. (WA 2.1)
  - _Done 2026-11-09, tested by hand. **Rule: a category can only be deleted when it has no items** (move or
    delete them first; no "uncategorized" bucket). The check is the delete's own condition on
    `storeCategoryItemCount` (≤ 0, kept by 2.1), so it can't race an item being added. 409
    `{code: "CATEGORY_NOT_EMPTY", message, itemCount}`; deleting a category that's already gone
    is a 200. The route deletes the row **before** its banner image. Tests in
    `tests/category-delete.test.ts`; checked live on dev with a throwaway row (refused at 2,
    deleted at 0, raw `{N}` count in the error handled)._
- [x] 🟡 **2.3 Upload limits:**
  - [x] a. Validate `imageType` and cap counts (≤ 10 total) on promo and item upload routes.
        Today `pngCount=100000` mints 100k URLs.
  - [x] b. Switch to **presigned POST** with `content-length-range` (e.g. ≤ 5 MB) and a fixed
        `Content-Type`. A presigned PUT can't cap file size.
  - [x] c. Item upload: check the item belongs to the store (or is being created).
  - [x] d. S3 lifecycle rule to expire uploads that never get referenced. (WA 2.3)
  - _Done 2026-11-09. All five upload routes go through `layers/aws/s3/image-upload.ts`:
    png / jpg / jpeg only (400 otherwise); promo and item counts are digits only and 1–10 in
    total (`MAX_COUNT`); each slot is a presigned POST `{key, url, fields}` (15 min) whose policy
    pins the key, `Content-Type` (`image/png` / `image/jpeg`; jpg used to be signed as the
    invalid `image/jpg`), 1 B–5 MB and a `ceseelia-upload=pending` tag. Item and category banner
    slots 404 unless that record exists in the store (both are created before their images).
    The bucket (`ceseelia_cloudformation`, deployed to dev) allows POST and expires `pending`
    objects after 1 day; update-settings, category save and item save clear the tag on the
    images they reference (`markImagesKept`) **before** the DB write and fail the save if they
    can't. Older images have no tag and are never expired. The webapp posts the form
    (`uploadImage`). Tests in `tests/image-upload.test.ts`; checked live on the dev bucket
    (1 KB upload → tagged; 6 MB → `EntityTooLarge`; tag cleared on keep; CORS preflight POST
    allowed). **Prod: the EC2 role needs `s3:DeleteObjectTagging` on the bucket.**_
- [x] 🟠 **2.4 Public data endpoint:**
  - [x] a. Strip `settings.admin` and any other private fields. Commission is currently public.
  - [x] b. Return only active items in active categories.
  - [x] c. 404 when the store doesn't exist. 404/410 (`STORE_UNAVAILABLE`) when
        `isStoreLive === false`.
  - [x] d. Tests. (WA 3.1)
  - _Done 2026-11-09, tested by hand. `getPublicStoreInventoryData` reads SETTINGS first: none → 404
    `{code: "STORE_NOT_FOUND"}`; `admin.isStoreLive === false` → 404 `{code: "STORE_UNAVAILABLE"}`
    (404, not 410: a suspension can be lifted); settings without an admin block count as live.
    Neither case queries the store's rows. `toPublicInventory` keeps only categories and items
    with `…IsActive === true` (items of a missing or inactive category are dropped), sets each
    category's count to the items returned (so hidden items don't show in counts) and strips
    `admin` (a, already done in 1.6). Tests in `tests/public-storefront.test.ts`; checked live
    on dev (Northern Hoop 200, unknown id 404). The webapp already shows "Store unavailable" on
    any error; WA 3.1b can use the codes for better wording._
- [x] 🟡 **2.5 Price model.** Decide on integer minor units per currency (fixed per-currency price
      vs. conversion), add `storeItemPrices` if per-currency, migrate existing items. (WA 2.4)
  - _Done 2026-11-09, tested by hand. **Decision: fixed per-currency prices, no
    conversion** (owner's choice): exact prices, no rates service, Stripe charges what's shown.
    `storeItemPrices: { USD: 6500, CAD: 8900 }` (whole cents) replaces `storeItemPrice` (decimal).
    Valid: 1–3 entries, codes from `CURRENCY_CODES`, integers 0–100,000,000
    (`NUMBER_RANGE.priceMinor`). A key for a currency the store doesn't offer is allowed (prices
    survive turning a currency off and on). Item writes `SET storeItemPrices … REMOVE
    storeItemPrice`. The public data keeps only the store's offered currencies and leaves out an
    item priced in none of them. `scripts/migrate-item-prices.mjs` moves old prices under the
    store's default currency (dry run by default, `--write`; run on dev: Pink Slay 65 → `{USD:
    6500}`; run on prod when it exists). Orders (`StoreOrderItem.price`) and reward amounts are
    untouched until Stages 4–5. The webapp bridge came with it: its one price box edits the default
    currency's price; WA 2.6 adds a box per currency._
- [x] 🟡 **2.6 Stock rules:** `-1` = unlimited, `≥ 0` = tracked. Document it and validate it
      (S.9b). Stock goes down on paid orders in 5.5. (WA 2.5)
  - _Done 2026-11-09, tested by hand. The rule lives in `constants/input-limits.ts`
    (`STOCK_UNLIMITED = -1`): unlimited never runs out or goes down; a tracked count is a whole
    number 0–1,000,000, 0 = sold out. Validation was already in place since S.9b (integer,
    −1…1,000,000; categories have no stock, so there was nothing to add there).
    `isUnlimitedStock` / `hasStockFor(stock, qty)` in `interfaces/store` are the one check the
    quote (4.1) and paid-order decrement (5.5) will call. The webapp storefront grid hid
    anything with stock ≤ 0, unlimited included; it now uses `isInStock` (WA side)._
- [x] 🟠 **2.7 Stock and price per option combination (variants).** (WA 2.9)
  - _Done 2026-11-11. Rules in `layers/core/variants` (mirrored in WA
    `core/functions/variant.functions.ts`). A single-choice param with options is a variant param
    (always required); an item with any has `storeItemVariants`: one row per combination of their
    options (`storeVariantOptions` by param label, `storeVariantStock` -1 or a count,
    `storeVariantPrices` per currency, `storeVariantIsActive` = sold or not made). Multiple-choice
    params are add-ons: no stock or price of their own. Items with no variant params keep one
    stock and one price per currency. `create-item` runs `withVariantTotals` before validating:
    labels trimmed, variant params made required, rows put in combination order, and for a
    variant item `storeItemStock` (sum of sold rows, -1 if any is unlimited) and `storeItemPrices`
    (lowest sold price per currency) worked out from the rows, never taken from the client.
    Validation: unique param labels and options, ≤ 100 combinations (`MAX_COUNT.itemVariants`),
    exactly one row per combination, at least one sold, every sold row priced, stock in range.
    Public data drops rows that aren't sold and cuts row prices to offered currencies; an item
    with variant params but no full table (saved before 2.7: dev data only) is hidden until the
    merchant fills it in. The quote uses the picked combination's price and stock (lines of one
    combination share it; add-ons don't split it), with a new line error `OPTION_UNAVAILABLE`.
    Tests: `tests/variants.test.ts`; pricing/quote/validator tests updated._

---

## 5. Stage 3 — Public storefront API

- [x] 3.1 `GET /store/public/storefront/:slug` → settings, categories and active items (wraps 1.8
      and 2.4). (WA 3.1)
  - _Done 2026-11-09, tested by hand. Returns `{ storeId, settings, categories, items }`:
    the slug is lowercased and looked up (1.8), then the same response as `get-data-public`,
    which now shares `sendPublicStorefront` in `layers/core/http/public-storefront.ts` (both
    include `storeId`). 400 for an invalid slug (no lookup); 404 `STORE_NOT_FOUND` for an unknown
    slug or a slug whose store is gone; 404 `STORE_UNAVAILABLE` when suspended. Fixed on the way:
    the shopper's geo currency was made the default even when the store didn't offer it, leaving
    no default (no prices shown); `withShopperCurrency` now keeps the store's default then.
    Tests in `tests/public-storefront-slug.test.ts`; checked live on dev (`northern-hoop` and
    `Northern-Hoop` 200, unknown 404, `a` 400)._
- [x] 3.2 Cache headers (`Cache-Control`, `ETag`) on public endpoints, and CloudFront in front of
      the API's public paths and the storage bucket.
  - [x] a. Headers. _Done 2026-11-09, tested by hand. `layers/core/http/cache.ts`:
        storefront (both routes) and item → `private, no-cache` (was `max-age=30` until QA Q.21, 2026-11-11; the body varies by shopper:
        geo-IP default currency, so a shared cache must not keep one copy); slug lookup →
        `public, max-age=300`; every public error and contact-store → `no-store`. Express's weak
        ETag + 304 already worked (now tested; checked live). Uploaded images get
        `public, max-age=31536000, immutable`, pinned in the presigned POST (keys are unique per
        upload; the webapp sends the slot's fields as is)._
  - [x] b. CloudFront (infra, `ceseelia_cloudformation`) for the storage bucket and the slug
        lookup. _2026-11-15 (L.9): the storage bucket already had CloudFront (made by hand,
        `<stage>.storage.ceseelia.com`); the webapp now gets its own (S3 + OAC, a CloudFront
        function for app routes and link previews) in the template. The API stays behind nginx:
        its storefront answers differ per shopper (geo currency), see below._ The storefront and item responses can only be shared-cached once the shopper's
        currency default is keyed (e.g. `CloudFront-Viewer-Country`) or moved to the client.
- [x] 3.3 `GET /store/public/item/:storeId/:itemId` for deep links. (WA 3.5)
  - _Done 2026-11-09, tested by hand. `{ storeId, item, category, currencies }` via
    `getPublicStoreItem` (three key reads, no inventory scan) with the storefront's rules
    (`toPublicInventory`: live store, active category and item, prices cut to offered currencies)
    and the shopper's currency as default if offered. 404 `ITEM_NOT_FOUND` for a missing or hidden
    item (they look the same on purpose); the store's 404s; 400 for malformed ids. Checked live
    (Pink Slay 200, unknown item 404)._
- [x] 3.4 `POST /customer/contact-store`: validate input, rate-limit (needs 9.2 / S.13), bot check
      (honeypot or captcha), SES to the store's email with the customer email as reply-to (never as
      the From address). (WA 3.3)
  - _Done 2026-11-09, tested by hand. Body `{ storeId, name, email,
    message, website }`: name ≤ 50, email ≤ 254, message ≤ 2000 (`MAX_LENGTH.contactMessage`), no
    control characters (newlines/tabs only in the message), so nothing can reach the subject or
    headers. Sent to `storeInfo.emailaddress` from `Ceseelia <support@ceseelia.com>` with
    `ReplyToAddresses: [customer]` (`sendEmail` gained a `replyTo` argument); all user text is
    HTML-escaped (`escapeHtml` moved to `utils/validation.ts`). Honeypot `website`: same 200, nothing
    sent. Rate limits in memory (`layers/core/http/rate-limit.ts`): 5/IP/10 min (honeypot hits
    count too), 30/store/hour → 429 `RATE_LIMITED` + `Retry-After`. 409 `CONTACT_UNAVAILABLE` with
    no store email; 500 `SEND_FAILED` if SES fails; the store's 404s. With more than one API
    instance the limits need a shared store (9.2). SES has production access (checked
    2026-11-14), so any address gets mail._

---

## 6. Stage 4 — Cart & pricing service

- [x] 4.1 A pure pricing function `priceLines(store, lines, currency)`: item, category and store
      discounts, custom-param validation, stock checks. Heavy unit tests.
  - _Done 2026-11-09, tested by hand (unit tests; nothing calls it until 4.3). `layers/core/pricing`.
    **Discounts: the biggest of item, category and store wins; they never stack** (the user's
    decision, 2026-11-09; the storefront badge shows the same). Ties go to the most specific
    (item, then category); percents are clamped to 0–100. A line's discount is worked out on
    the whole line and rounded half up to a cent (integer maths, decimals like 12.5% are
    exact). Line errors, each counting for nothing while the other lines are still priced:
    `ITEM_NOT_FOUND` (unknown, hidden item, or hidden/missing category), `NOT_SOLD_IN_CURRENCY`,
    `INVALID_QUANTITY` (whole 1–99, `MAX_QUANTITY_PER_LINE`), `OUT_OF_STOCK`,
    `INSUFFICIENT_STOCK` (with `available`; lines of one item share its stock in line order),
    `MISSING_PARAM` / `INVALID_PARAM` (with `param`: unknown param or option, two picks on a
    single choice, a repeated pick, a param given twice). A currency the store doesn't offer
    fails the whole quote (`CURRENCY_NOT_OFFERED`). Picks come back in the item's order. `ok`
    only when there are lines and all are fine. Totals: subtotal, discount, total (tax and
    delivery are 4.2)._
- [x] 4.2 Tax and delivery settings: extend `StoreSettings.general` (`taxRate`, pickup/delivery
      flags, delivery fee/zones), `initStoreSettings` and the validators. (WA 4.4)
  - _Done 2026-11-09, tested by hand. `general` gains optional `taxPercent` (0–30,
    decimals allowed), `pricesIncludeTax`, `pickupEnabled`, `deliveryEnabled` and `deliveryFees`
    (a flat fee per currency in minor units, like item prices; 0 = free). Optional so settings
    saved before 4.2 still pass; read them through `fulfilmentSettings` (defaults: no tax,
    pickup on, delivery off). Validation: tax in range, pickup or delivery on, fees whole and in
    range for known currencies, and with delivery on a fee for every offered currency.
    `priceLines` and the quote now return `fulfilmentOptions`, `fulfilment` (the body's
    `fulfilment: "PICKUP" | "DELIVERY"`, else the first option), `deliveryMinor`, `taxPercent`,
    `pricesIncludeTax`, `taxMinor`; `error: FULFILMENT_UNAVAILABLE` (lines still priced) when the
    chosen method isn't offered. Tax is on goods after discount plus delivery, rounded half up
    once; when prices include tax it's the part inside (amount × r / (100 + r)) and adds
    nothing. Delivery is charged only when some line can be bought. Delivery zones and
    free-delivery thresholds are not done (a later step if merchants need them). Checked live:
    the dev store (saved before 4.2) quotes as pickup with no tax._
- [x] 4.3 `POST /customer/quote` (public, rate-limited) returns validated lines, totals and errors
      per line. (WA 4.3)
  - _Done 2026-11-09, tested by hand. Body `{storeId, currency, lines: [{itemId,
    quantity, params?: [{label, values}]}]}`; runs `priceLines` (4.1) on the store's public data
    (`getPublicStoreInventoryData`), so hidden items and categories and currencies the store
    doesn't offer are never priced. Always 200 with the quote (line problems in `lines[i].error`,
    `error: CURRENCY_NOT_OFFERED`, `ok`); the currency is upper-cased. 400 for a malformed body:
    over 50 lines (`MAX_COUNT.cartLines`), over 10 params or 30 values, labels/values over 40
    characters, wrong types. The store's 404s; `Cache-Control: no-store`; 60 per IP per minute →
    429 `RATE_LIMITED` + `Retry-After` (in memory, like contact-store). Checked live on dev
    (2 × Pink Slay = 13000, unknown item → `ITEM_NOT_FOUND`). No tax or delivery yet (4.2)._
- [x] 4.4 Canadian sales tax by province (WA 4.6). Owner's decision 2026-11-09: tax isn't
      left to a payment processor (Stripe, Square and PayPal are all planned); Canada is done in
      the platform, other countries later via the processor active at checkout.
  - _Done 2026-11-09. `layers/core/tax/canada.ts` (pure): provinces, rates as of 2025-04-01
    (HST ON 13, NS 14, NB/NL/PE 15; GST 5; PST BC 7, SK 6; RST MB 7; QST QC 9.975), Canada Post
    postal code check (`normalizePostalCode`) and first letter → province. `general.taxMode`
    (`FLAT` default | `CANADA`) and `general.canadaTax` (`homeProvince`, `gstRegistered`,
    `provincialRegistrations` in BC/MB/QC/SK only); Canada mode refuses `pricesIncludeTax`.
    `priceLines` takes `postalCode`: pickup is taxed in the home province, delivery in the postal
    code's; each part is its own percent of goods-after-discount + delivery, rounded half up on its
    own; no GST/HST unless registered (small supplier), PST/RST/QST only where registered. Quote
    adds `taxLines` and `taxRegion`; a Canada delivery without a valid code gets 0 tax and
    `error: POSTAL_CODE_REQUIRED` / `INVALID_POSTAL_CODE` (`ok: false`), unless the store charges
    no tax at all. `percentOf` now works in thousandths of a percent with BigInt (QST, big carts).
    The quote route takes `postalCode` (string ≤ 10, else 400); it's never stored or logged (the
    request log has only IP/host/path). Rates come only from the server._
  - [ ] **Follow-ups:** (re-quote done in 5.4a; the accountant check is the owner's) order creation (5.4) must re-quote with the **delivery address's** postal
    code, not one typed in the cart; have an accountant confirm the rules (delivery charges are
    taxed like the goods here, which is a simplification for some provinces); update
    `CA_TAX_RATES` + `CA_TAX_RATES_AS_OF` when a rate changes; non-Canadian delivery in Canada mode
    isn't supported (the postal code must be Canadian) until overseas tax via the processor.

---

## 6a. Stage P — Plans, self-serve stores & Go Live (before 5.3)

Decided with the owner 2026-11-12. Done before the rest of Stage 5, because Go Live and the plan
decide whether checkout is on and what the platform fee is. Two assumptions (flagged, owner can
change): **(A1)** a subscription is billed in the currency of the store's Stripe account country
(CA → CAD, US → USD, AU → AUD); **(A2)** stores that exist before P.2 are read as LIVE on FREE
(superseded by P.10: they're read as DRAFT with no plan).

**Plans (per store). Since 2026-11-13 (P.10) there is no FREE plan:** every live store pays for
Spark or Nova; a store without a plan is a draft.

| Plan | Monthly (CAD / AUD / USD) | Commission per order (CAD / AUD / USD) | Orders | Custom domain |
|---|---|---|---|---|
| ~~FREE~~ (dropped 2026-11-13) | none | 2.95 / 2.95 / 2.45 | 30 paid orders per calendar month | No |
| SPARK | 25 / 25 / 19 | 1.95 / 1.95 / 1.45 | Unlimited | Yes (9.8 phase 2) |
| NOVA | 49 / 49 / 39 | none | Unlimited | Yes (9.8 phase 2) |

No free trials. Payments are **online only** (owner, 2026-11-12): no "pay at pickup"; every order,
pickup or delivery, goes through Stripe Checkout (5.4).

- [x] P.1 Plan catalogue in one place (`layers/core/plans`): `FREE | SPARK | NOVA`, monthly price
      per currency in cents, default commission per currency in cents (FIXED mode), monthly order
      limit (FREE 30, else none), `customDomain` flag. Stripe Products/Prices on the platform
      account found by lookup key (`ceseelia_spark_cad`, …), never by ids in code.
      Done 2026-11-12: `PLANS` (frozen), `getPlan` (unknown = FREE, never a paid plan),
      `isPaidPlan`, `planPriceLookupKey`, `orderLimitWarningAt` (24 of 30), and the grace /
      draft-cap constants. No route serves it yet: P.4 adds it for the webapp's plan picker.
- [x] P.2 Store lifecycle on SETTINGS: `status: DRAFT | IN_REVIEW | LIVE` and `plan` (+ subscription
      fields). Admin suspension stays separate: rename `admin.isStoreLive` to `admin.suspended`
      (read the old field in `normalizeAdminSettings`). Public storefront: DRAFT / IN_REVIEW →
      shoppers get "Coming soon" (no items, `checkoutEnabled: false`); store members get the full
      data as a preview. Checkout needs LIVE + not suspended + `paymentsEnabled`. Migration per A2.
      Done 2026-11-12:
  - `lifecycle` `{status, plan, statusChangedAt?, firstLiveAt?}` is its own SETTINGS attribute
    (merchant update-settings and the admin form can't write it; tested). New stores
    (`initStoreSettings`, so `POST /store/create` too) are FREE drafts. `normalizeStoreLifecycle`:
    none saved = LIVE on FREE (A2, no migration script needed); unknown status = DRAFT; unknown
    plan = FREE. Members' get-data includes it; public responses get only `storeStatus`.
  - `admin.suspended` replaces `isStoreLive` (old `false` read as suspended). The admin PUT
    takes `suspended` and refuses a body with only `isStoreLive`.
  - Public storefront of a DRAFT / IN_REVIEW store: 200, `no-store`, `settings.storeStatus`, only
    name / slogan / logo / look / currencies (`comingSoonSettings`: no contact details, links or
    pickup address, `paymentsEnabled: false`), no categories or items (never read). Item links,
    quotes and Contact us: 404 `STORE_NOT_LIVE`. Suspension wins over draft (`STORE_UNAVAILABLE`).
  - The subscription fields come with P.5; `checkoutEnabled` is left to 5.4 (create-order
    refuses unless LIVE, not suspended, under the limit and `paymentsEnabled`).
  - Tests: `tests/plans-lifecycle.test.ts`; public-route tests start from
    `tests/fixtures.ts` `liveStoreSettings()`.
  - **Dev note:** stores created from now on are drafts with Coming soon until Go Live (P.4)
    exists; stores created before (Northern Hoop) stay live.
- [x] P.3 Self-serve store creation: `POST /merchant/create-store` `{storeName, slug}` for any
      signed-in user with a verified email. Creates the store (DRAFT, FREE), its slug reservation
      and an ADMIN membership in one go (reuse 1.2 / 1.8). Cap drafts per account (5) and
      rate-limit, against abuse. Supersedes 8.2's join-request approval (no admin step before
      building; the check happens at Go Live).
      Done 2026-11-12: `POST /merchant/create-store` `{storeName, storeSlug}` (any signed-in
      user) → `{storeId, storeName, storeSlug, status: "DRAFT", plan: "FREE"}`. `createStore`
      takes an optional owner and writes overview + SETTINGS (`lifecycle.createdByUserId`) + slug +
      the owner's PROFILE#INFO check + both ADMIN membership rows in **one transaction**
      (`newStoreMembershipItems`). An account with user rows has a confirmed email (the sign-up
      Lambda runs after confirmation), so that's the "verified" check: else 404
      `PROFILE_NOT_FOUND`; deactivated 403. Cap: `countDraftStoresAdministeredBy` ≥ 5 → 409
      `DRAFT_LIMIT_REACHED` (a read, not atomic; the 5-per-account-per-hour rate limit, 429
      `RATE_LIMITED`, bounds the race). 409 `SLUG_TAKEN`. Body fields beyond name and slug are
      ignored (no picking status, plan or owner). Tests: `tests/merchant-create-store.test.ts`.
- [x] P.4 Go Live (a and b done 2026-11-12; c, the AI check, done 2026-11-15 as L.2):
  - [x] a. `GET /store/go-live/checklist/:storeId` (members): name set, ≥ 1 active item with a
        price, pickup or delivery on, Stripe `chargesEnabled` (5.2), plan chosen, and for FREE
        no other live FREE store owned by the same account. Each with ok / what's missing.
        Done: `goLiveChecklist` (`layers/core/go-live`, pure; steps STORE_NAME, ITEMS (what
        shoppers would see: `toPublicInventory` non-empty), FULFILMENT (delivery, or pickup **with
        an address**), PAYMENTS (Stripe `charges_enabled` read live via `readStoreStripeAccount`,
        shared with payments/status)). Response adds `canGoLive`, `suspended`, `billingCurrency`
        (A1: CA/US/AU → CAD/USD/AUD) and `plans` priced in it, with `available` /
        `unavailableReason` (`FREE_PLAN_IN_USE` via `findLiveFreeStoreAdministeredBy`;
        `PLAN_NOT_AVAILABLE` for SPARK/NOVA while `PAID_PLANS_AVAILABLE` is false, until P.5).
        Also `GET /store/public/plans` (the catalogue, no auth, `public, max-age=300`). New stores
        now start with `storeInfo.storeName` = their name.
  - [x] b. `POST /store/go-live` `{storeId, plan}` (store ADMIN): re-checks the list on the
        server; FREE goes straight to validation; SPARK / NOVA return a Billing Checkout URL and
        go live from the webhook (P.5) once the subscription is active.
        Done for FREE: order of checks 409 `STORE_SUSPENDED` → `ALREADY_LIVE` / `IN_REVIEW` →
        `PLAN_NOT_AVAILABLE` (paid, until P.5) → `CHECKLIST_INCOMPLETE {steps}` (Stripe live) →
        `FREE_PLAN_IN_USE` (not for platform admins) → `runSmartStoreValidation` → write.
        `setStoreStatusFromDraft` is conditional on `lifecycle.status = DRAFT` (409
        `STATUS_CHANGED`), sets `firstLiveAt` the first time, and keeps IN_REVIEW's reasons in
        the SETTINGS row's own `review` attribute (admins only; members' and public data drop
        it). A validation that throws fails closed (IN_REVIEW, `VALIDATION_UNAVAILABLE`).
        **P.5 still to do here:** the SPARK / NOVA branch (Billing Checkout URL).
  - [x] c. **`runSmartStoreValidation({storeId, data})`** in `layers/core/store-validation`
        (stub in place and called by Go Live, 2026-11-12; result `{ok: true} | {ok: false, reasons}`): called on
        every Go Live (and plan re-activation) before the store becomes LIVE. Purpose: use AI
        to go through the store's items, names, descriptions and images and make sure nothing
        sketchy is going on (fraud, prohibited goods, scams) on Ceseelia.
        **TODO (owner, 2026-11-12): body left empty for now, returns `{ ok: true }` for every
        store. Come back to it and build the AI check.** When it's built and flags a store:
        status `IN_REVIEW` (not LIVE), the merchant sees "We're reviewing your store", and the
        store goes into an admin review queue (approve → LIVE, reject with a reason → DRAFT).
        (Go Live's IN_REVIEW write and the merchant's message are done; the admin queue is done
        in P.8. **The AI check itself is still the owner's TODO.**)
        Later, also worth deciding: re-run it when a live store adds or changes items.
- [x] P.5 Subscriptions (done 2026-11-12; Stripe setup below is the owner's) (Stripe **Billing on the platform account**, separate from Connect): a
      Stripe Customer per user account, a Subscription per store (metadata `storeId`). Billing
      Checkout (`mode: subscription`) for SPARK / NOVA; Customer Portal for card changes,
      upgrades, downgrades and cancelling. **Stripe Tax is on here** (`automatic_tax` for
      Ceseelia's own GST/HST on the subscription): the opposite of the shopper-checkout rule in
      5.4c, which still never enables it. A platform webhook endpoint (its own signing secret)
      handles `checkout.session.completed`, `customer.subscription.*`, `invoice.paid`,
      `invoice.payment_failed`, idempotent like 5.5.
  - [x] Failed payment: Stripe's automatic retries, then **7 days' grace**, then the store drops
        to FREE (not offline). Cancel: SPARK / NOVA until the period ends, then FREE. If the
        account already has a live FREE store, the store that dropped pauses (back to DRAFT,
        merchant told why). Custom domain goes when the plan does.
  - Done:
    - **Rules** (`layers/core/billing`, pure): active / trialing / past_due = the paid plan
      (past_due = Stripe still retrying); unpaid, paused, or canceled with reason
      `payment_failed` = 7 days' grace (its end fixed once started), then FREE; canceled for
      any other reason = FREE; incomplete(_expired) = nothing. FREE while the payer has
      another live FREE store = DRAFT with `lifecycle.pausedReason: "FREE_PLAN_IN_USE"`
      (cleared when it goes live again). A paid draft goes LIVE (checkout runs the checklist
      and validation first). One subscription per store: a second paid one is cancelled, an
      older one's late events are ignored (`mayReplace`).
    - **Sync** (`layers/payments/subscription-sync`): every event re-reads the subscription
      from Stripe, so duplicates and out-of-order events give the same result (no event-id
      table needed); writes are conditional on the lifecycle and subscription it read
      (3 tries). The plan comes from the price's lookup key, so plan changes in the portal
      follow. A subscription whose store was deleted is cancelled.
    - **Data**: SETTINGS `subscription` (`StoreSubscription`, no card data) and
      `billingCheckout` (the open checkout, reused by a second click, expired when another
      plan is picked); `USER#id / BILLING#<CUR>` = the account's Stripe Customer per currency
      (a customer holds one currency); `APP_BILLING_GRACE / STORE#id` = stores in grace, for
      the hourly sweep (`index.ts`, `BILLING_GRACE_SWEEP_INTERVAL`). Members' and public data
      never include `subscription` / `billingCheckout`.
    - **Routes**: `POST /store/go-live` paid → `{status: "DRAFT", plan, checkoutUrl}` (flagged
      → IN_REVIEW, no card taken; 409 `ALREADY_SUBSCRIBED`; 503 `BILLING_NOT_CONFIGURED`);
      `POST /store/billing/checkout` (LIVE FREE store upgrading; store ADMINs);
      `POST /store/billing/portal` (only the payer, 403 `NOT_PAYER`); `GET
      /store/billing/status/:storeId` (members; no Stripe ids). Webhook `POST
      /api/v1/billing/stripe-webhook` (raw body, `billingWebhookSecret`; Connect events
      ignored; 500 on failure so Stripe retries). Checkout: `automatic_tax`, billing address
      required, tax ID collection, returns to `/store/storefront/:id?billing=success|cancel`.
      Store delete cancels the subscription first (502 and nothing deleted if Stripe fails).
    - The price must match PLANS exactly (amount, currency, monthly) or nothing is charged.
  - **Setup (owner, per Stripe mode; test first):**
    1. `npm run build && node scripts/setup-billing-prices.mjs --write` (products + 6 prices).
    2. Stripe Tax: turn it on, set the origin address and register for GST/HST (and any other
       registrations); set the products' tax code (SaaS) in the dashboard.
    3. Webhook endpoint `https://api.ceseelia.com/api/v1/billing/stripe-webhook` (platform,
       not Connect) with `checkout.session.completed`, `checkout.session.expired`,
       `customer.subscription.created|updated|deleted|paused|resumed`, `invoice.paid`,
       `invoice.payment_failed`; put its signing secret in the Stripe secret as
       `stripeBillingWebhookSecret`.
    4. Billing › Revenue recovery: Smart Retries on; "if all retries fail" → **mark the
       subscription unpaid** (or cancel: both start the grace).
    5. Customer portal: allow card updates, invoice history, cancelling (at period end), and
       switching between the Spark / Nova prices of the same currency.
    6. Prod: `PAID_PLANS_ENABLED=true` (dev is on by default).
  - Assumptions (§6a): **A3** the payer is the user who clicks Go live / Upgrade, and only they
    can open the portal; **A4** validation runs when the checkout starts, not again when it's
    paid; **A5** the grace sweep runs in the API process (one server today; with several,
    each would sweep, which is safe because the sync is conditional).
  - For P.8 (done in P.8): approving a paid request sends the store back to DRAFT, approved,
    so its next Go Live skips the check and goes to checkout; rejecting cancels a paying
    subscription first.
- [x] P.6 Fee from the plan: `platformFeeMinor` uses the store's **admin override** if one is set
      (the 5.1b mode / percentage / amounts, kept for negotiated deals), else the plan's default
      (NOVA = 0). Add `admin.commissionSource: PLAN | CUSTOM` (missing = PLAN) so a store follows
      its plan unless an admin sets a custom commission. 5.4c still copies what was used onto
      the order.
      Done 2026-11-12: `admin.commissionSource` (normalized: anything but CUSTOM = PLAN, so
      stores saved before P.6 follow their plan; their old custom fields are kept, unused).
      **5.4c must call `platformFeeForStore(admin, lifecycle.plan, quote)`** (never
      `platformFeeMinor` directly) and save `commissionInEffect(admin, plan)` on the order; a
      later fee is `feeFromCommission(copy, quote)`. PLAN = the plan's fixed fee per order in
      the order's currency (FREE 2.95 / 2.45, SPARK 1.95 / 1.45, NOVA 0), capped at the total;
      CUSTOM overrides on every plan, NOVA included. The admin routes take and return
      `commissionSource` (required on PUT; the custom fields are saved either way); GET adds
      `plan` and `planCommissions`. Note: the Go Live sheet and Plan & billing show the plan's
      default fee, even for a store with a CUSTOM deal.
- [-] P.7 **Dropped 2026-11-13 with the Free plan (P.10).** Was: FREE order limit: count paid orders per store per calendar month (UTC), bumped in 5.6.
      Warn the merchant at 24 (80%). At 30, **7 days' grace** (orders still go through), then new
      checkouts pause until they upgrade or the month turns. Checked only in `create-order`
      (5.4), so a shopper already in Stripe Checkout is never stopped.
- [x] P.8 Admin: plan, status and subscription on Admin › Stores; admins can set the plan or a
      custom commission; the review queue from P.4c (with Stage 8).
      Done 2026-11-12:
      - `GET /admin/get-all-stores` adds `status`, `plan`, `suspended`, `planSetByAdmin` and a
        `subscription` summary (no Stripe ids) per store, from its SETTINGS row (reads every row
        in full: page it when the store count grows).
      - **Review queue**: Go Live's IN_REVIEW write also puts `APP_REVIEW / STORE#id`
        (`storeId`, reasons, requested plan, when, who) in the same transaction; `GET
        /admin/get-review-queue` lists it oldest first with the store's name and slug. `POST
        /admin/review-store {storeId, decision, message?}`: APPROVE on Free → LIVE (unless the
        owner meanwhile has another live Free store: then DRAFT, approved); APPROVE on a paid
        plan → DRAFT with `lifecycle.reviewApprovedAt` (next Go Live skips the check and goes
        to checkout); REJECT (message 1–500) → DRAFT with `lifecycle.reviewRejection`. One
        write, conditional on IN_REVIEW (409 `STATUS_CHANGED` when another admin decided first;
        409 `NOT_IN_REVIEW`). Going live clears the approval and the rejection. The store delete
        removes its queue (and grace) rows.
      - **Plan by hand**: `PUT /admin/set-store-plan {storeId, plan}` sets `lifecycle.plan` with
        `planSetByAdmin` (Free clears it); 409 `HAS_SUBSCRIPTION` while a subscription pays (or
        is in grace); conditional on the lifecycle and subscription read. Go Live on that plan
        needs no checkout (and works with `PAID_PLANS_ENABLED` off); billing changing the plan
        clears the mark. Status is never set by hand (suspend is the admin's switch).
      - Checklist adds `reviewRejection`, `reviewApproved` and `giftedPlan`; the admin settings
        GET adds `planSetByAdmin` and `paysForPlan`.
      - Not done: emails to the merchant on a decision (Stage 8 / 6.3 notifications); the
        merchant sees it in the Go Live sheet.
- [ ] P.9 Custom domains: listed on SPARK / NOVA as "coming soon" at launch; built in 9.8
      (phase 1, store subdomains, done 2026-11-15; phase 2 planned there).
- [x] P.10 **No Free plan** (owner, 2026-11-13): only SPARK and NOVA; going live and subscribing
      go hand in hand; merchants switch freely between the two; a cancelled plan ends at the
      period's end and the store is no longer live. Done 2026-11-13 (supersedes the FREE parts
      of P.1–P.8 above):
      - `STORE_PLANS = ["SPARK", "NOVA"]`; `lifecycle.plan` is `StorePlanOrNone` (`"NONE"` =
        no plan). `normalizeStoreLifecycle`: no lifecycle, an unknown plan or the old FREE →
        NONE; **LIVE with no plan → DRAFT** (`pausedReason: "PLAN_ENDED"`), so nothing is live
        without a plan. `monthlyOrderLimit`, `getPlan`, `isPaidPlan`, `orderLimitWarningAt` and
        the FREE order-limit constants are gone; `findLiveFreeStoreAdministeredBy` too.
      - New stores (`create-store`, admin `store/create`) are DRAFT / NONE.
      - `POST /store/go-live {storeId, plan: SPARK|NOVA}` (FREE → 400): after the checklist and
        `runSmartStoreValidation`, always a Billing `checkoutUrl` (store stays DRAFT until the
        webhook), except a plan an admin gave → LIVE at once. Flagged → IN_REVIEW with the plan
        asked for in `review.requestedPlan`; the lifecycle keeps NONE (nothing paid yet).
      - Billing (`layers/core/billing`): `FREE` effect renamed `ENDED`: a LIVE store → DRAFT,
        NONE, `PLAN_ENDED`; never removes a plan an admin gave after the subscription ended.
        Spark ↔ Nova in the portal just changes the plan (as before).
      - `POST /store/billing/checkout` (live FREE → paid upgrade) **removed**: a plan is picked
        at Go Live; changes happen in the portal.
      - Review: APPROVE → always DRAFT approved (next Go Live skips the check, then checkout, or
        live on a gifted plan). Admin `set-store-plan` takes `SPARK | NOVA | NONE`; NONE on a
        live store → DRAFT (`PLAN_ENDED`); answers `{status, plan, planSetByAdmin}`.
      - Fee: `commissionInEffect` on NONE (or anything unknown) uses SPARK's fee, never 0 (a store
        without a plan takes no orders anyway). Admin settings GET: `planCommissions: null` on NONE.
      - `scripts/migrate-free-plan.mjs` rewrites stored lifecycles to the new shape (dry run by
        default; `--write`). Needed because conditional writes compare the stored plan/status.
- [x] P.11 **One store per account; store admins rename their store** (owner, 2026-11-13, from
      Stage P QA). Done 2026-11-13:
      - One store per account, any role: `POST /merchant/create-store` → 409 `ALREADY_IN_A_STORE`
        when the caller has a USER#/STORE# row (replaces P.3's 5-draft cap;
        `MAX_DRAFT_STORES_PER_ACCOUNT` / `countDraftStoresAdministeredBy` removed). A second store
        needs a second account. `addStoreMember` refuses a user in another store and
        `inviteStoreMember` an email invited to another store (`MembershipError`
        `ALREADY_IN_A_STORE`, 409 on `/admin/assign-store-member`); `claimStoreInvites` claims
        one invite at most and removes the rest. Read-then-write, like the old cap (rate limits
        keep a same-instant double rare). Accounts that already had several stores keep them.
      - `POST /store/update-info` `{storeId, storeName, storeSlug}` for the store's ADMINs (and
        platform admins): reuses `updateStoreInfo`, which now also sets SETTINGS
        `storeInfo.storeName` in the same transaction (one name everywhere). 409 `SLUG_TAKEN`,
        404 `STORE_NOT_FOUND`, 10 saves per store per hour (429). The old slug is released at
        once (owner): old links and QR codes stop working, anyone may take it.
      - `/store/update-settings` copies a non-empty `storeInfo.storeName` to the overview row
        after saving (best effort), so Profile / Overview / Admin › Stores follow the storefront.

---

## 7. Stage 5 — Checkout, orders & payments

- [x] 5.1 Decision (2026-11-11): **Stripe Connect, Standard accounts**, direct charges. Recorded
      in `CLAUDE.md` with what Standard means (merchant of record, Connect webhook endpoint,
      refunds and disputes in the merchant's own dashboard).

  > **Platform commission (decided 2026-11-11):** a fixed amount per order in each currency,
  > taken from the **merchant** through `application_fee_amount`. It is never shown to or charged
  > to the shopper: no "handling fee" line in the cart, quote or checkout (drip pricing: Canada's
  > Competition Act, Australian Consumer Law, California SB 478). A merchant who wants to pass it
  > on raises their prices. The platform's own GST/HST on its fee is charged to the merchant (B2B).
  - [x] a. `admin.salesCommissions`: cents for every currency (`{ USD, CAD, AUD }`, default 125),
        validated by `isSalesCommissionsValid` (0–100,000 each). `normalizeAdminSettings` fills
        defaults and reads a flat pre-5.1a `salesCommission` (major units) as that amount in
        every currency; `get-data` returns the normalized block to admins.
        `platformFeeMinor` gives 5.4c's fee, capped at the order total.
        The webapp's Admin settings form has a box per currency.
  - [x] b. **Percentage commission (2026-11-12, owner):** `admin.commissionMode` (`FIXED` |
        `PERCENT`, missing or unknown = `FIXED`) and `admin.commissionPercentBps` (whole basis
        points 0–3,000, missing or bad = 0). `PERCENT` takes that share of the items after
        discounts, **without tax and delivery** (`commissionBaseMinor`: tax-inclusive prices
        have their tax taken out, half up), rounded half up, and at least `salesCommissions`
        in the currency (the minimum per order, 0 = none). `platformFeeMinor(admin, quote)` now
        takes the quote (`FeeQuote`: currency, subtotal, discount, tax-inclusive flag and rate,
        total) and is still capped at the total. The admin PUT requires both new fields and
        writes only the four known fields. Tests: validation, old blocks, rounding, minimum,
        cap, included tax, large orders. WA 5.0b is the form.
- [x] 5.2 Merchant onboarding (Standard account, then an `account_onboarding` Account Link).
      New accounts only, no OAuth linking of existing accounts (owner, 2026-11-11).
  - [x] a. `POST /store/payments/create-connect-account-link` `{storeId, country?}` (store
        admins): creates the account once (`country` CA/US/AU, required until one exists;
        idempotency key `store-<id>-account-<disconnectedAt>-<country>`; a race keeps the first
        saved), then a fresh link per call. Returns to `/store/storefront/:storeId?payments=…`.
  - [x] b. `GET /store/payments/status/:storeId` (members): live from Stripe; refreshes the
        cached flags; a disconnected account is forgotten (`disconnected: true`). Returns
        `canManage` (platform admin or store ADMIN), `requirementsDue` (currently_due ∪ past_due),
        `pastDue`, `pendingVerification` and `deadline` (current, else future requirements).
        Seen in the sandbox: charges on while payouts are paused for a past-due ID, then on hold
        while Stripe checks it.
  - [x] c. Saved in the SETTINGS row's own `payments` attribute (the admin form replaces the
        whole admin block, so not there). Members' get-data and public responses drop it; public
        settings get `paymentsEnabled` (= `chargesEnabled`). (WA 5.4)
  - [x] d. Keys in AWS Secrets Manager (now `ceseelia/dev`, key `stripeSecretKey`; sandbox "Ceseelia sandbox");
        `layers/payments/stripe.ts`. Smoke-tested against the sandbox (create, link, delete).
  - [ ] f. Local dev: set `WEBAPP_URL` in `node/.env` to the address the webapp is opened at
        (e.g. `http://192.168.1.107:4200`), or Stripe's return links go to `localhost:4200`.
  - [ ] e. Prod: put a **restricted** live key (`rk_live_…`, IP-allowlisted to the server's
        Elastic IP 184.192.215.17) in `ceseelia/prod` → `stripeSecretKey` (owner, §0 D1; the
        test key is there until then). The secret and the server role's read
        access exist (2026-11-14, `CeseeliaServerRole`).
- [x] 5.3 Order model (done 2026-11-13): `StoreOrderStatus` enum replaces the boolean
      (`PENDING_PAYMENT → PAID → PREPARING → READY/SHIPPED → COMPLETED`, `CANCELLED`, `REFUNDED`;
      `storeOrderCancelReason` PAYMENT_EXPIRED / PAYMENT_FAILED / OUT_OF_STOCK / MERCHANT).
      `STORE#id / ORDER#<createdAt>#<orderId>` plus a pointer `ORDER#<orderId> / ORDER`
      `{storeId, orderSk}` (`dynamo-entities/order`: `createOrderRecords`, `getOrderById`).
      **Guest checkout** (owner, 2026-11-13): customer name / email / phone, address only for
      delivery (CA / US / AU; CA only for a Canada-taxed store), typed on **our** checkout form
      (owner) so the server's quote is final before Stripe. A random status token is returned
      once; the order keeps its SHA-256. 6-character order code for people.
- [x] 5.4 `POST /customer/create-order` (done 2026-11-13; details in the route's header). The
      client sends `expectedTotalMinor` (the total it showed): a different server total is 409
      `PRICE_CHANGED` with the new quote. Also 409 `CART_INVALID {quote}`, `PAYMENTS_UNAVAILABLE`,
      `DELIVERY_COUNTRY`, `BELOW_MINIMUM` (Stripe's 0.50); 10/IP/10 min. The session is created
      first (idempotency key per order id) and the order saved with its id; a failed save
      expires the session. `layers/payments/order-checkout.ts` builds the session: one line per
      order line (its total, quantity 1), delivery, each tax part; tested to sum to the quote.
  - [x] a. Re-quote with 4.1. Never trust client prices. Tax a delivery on the **delivery
        address's postal code** (`priceLines(..., { postalCode })`), never the cart's geo-IP
        estimate (QA Q.23); pickup uses the store's province.
  - [x] b. Write `ORDER#<ts>#<id>` as `PENDING_PAYMENT`. Pickup orders too: payments are online
        only (no pay at pickup). Refuse unless the store is LIVE, not suspended and
        `paymentsEnabled` (P.7's order limit was dropped with the Free plan).
  - [x] c. Create the Checkout Session **on the connected account** (direct charge) with
        `payment_intent_data.application_fee_amount = platformFeeMinor(admin, quote)` with the
        **server's** re-quote from 5.4a, and copy `commissionMode`, `commissionPercentBps`, the
        minimum/fixed amount and the fee onto the order (5.1b), so later admin changes don't
        touch it and 8.4 can report it (from the
        merchant's share; the shopper's total is the quote's total), plus an idempotency key.
        **Tax:** charge exactly the quote's tax as its own line (or amounts), and **never** set
        `automatic_tax: { enabled: true }`. Merchants may opt in to Stripe Tax during onboarding
        (it's offered there); turning it on in the session would add Stripe's tax on top of ours
        (double tax) and bill the merchant Stripe Tax fees. Add a test that the session params
        have no `automatic_tax` / `tax_id_collection` and that the session total equals the
        quote total.
  - [x] d. Return the URL and an order-status token. (WA 5.2)
- [x] 5.5 Webhook rewrite (done 2026-11-13; `layers/payments/order-webhook.ts`):
  - [x] a. A **Connect** webhook endpoint `POST /api/v1/payments/stripe-connect-webhook`
        (replaces the old 501 stub `/website/listen-to-stripe-event/:websiteId`), raw body,
        verified with `webhookSecret`. An event only touches an order from the order's own
        account (`event.account`) and its own session / PaymentIntent.
  - [x] b. 2xx unless handling failed (500 → Stripe retries); 503 without the secret. Processed
        event ids in `STRIPE_EVENT#<id> / EVENT` (`expiresAt` for a TTL if the table gets one).
        Every change is conditional anyway, so repeats are harmless.
  - [x] c. `checkout.session.completed` (paid) and `async_payment_succeeded` → PAID;
        `expired` → CANCELLED `PAYMENT_EXPIRED`; `async_payment_failed` → CANCELLED
        `PAYMENT_FAILED`. `payment_intent.payment_failed` changes nothing on purpose: Checkout
        lets the shopper try another card until the session expires.
  - [x] d. `charge.refunded` → `storeOrderRefundedMinor`, a full refund → REFUNDED (paid
        orders only); `charge.dispute.*` → `storeOrderDispute`; `account.updated` → the store's
        cached payments flags (account metadata `storeId`, only while the store uses it).
  - **Setup (owner, Stripe dashboard, test mode first):** Developers → Webhooks → Add endpoint
    `https://api.ceseelia.com/api/v1/payments/stripe-connect-webhook`, **"Events on Connected
    accounts"**, events: `checkout.session.completed`, `checkout.session.expired`,
    `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
    `charge.refunded`, `charge.refund.updated`, `refund.created`, `refund.updated`,
    `refund.failed` (6.4b), `charge.dispute.created`, `charge.dispute.updated`,
    `charge.dispute.closed`, `account.updated`. Put its signing secret in the Stripe secret as
    `webhookSecret`. Locally: `stripe listen --forward-connect-to
    localhost:3100/api/v1/payments/stripe-connect-webhook` and use the printed secret.
- [x] 5.6 On paid (done 2026-11-13; `markOrderPaid` in `dynamo-entities/order`), all in one
      transaction conditional on the order still being PENDING_PAYMENT:
  - [x] a. Mark the order `PAID` with the PaymentIntent id and `storeOrderPaidAt`.
  - [x] b. Conditional stock decrement, one update per item (`stockUpdates`): tracked item stock,
        or each picked variant row (by index, conditioned on its options and stock) plus the
        item's total. Unlimited stock is untouched. If stock ran out (or an item / row is gone),
        the order is still PAID, flagged `storeOrderStockShortfall`, with no stock change: the
        merchant refunds (6.4) or restocks.
  - [x] c. `storeOrderCount` +1 on the overview row (completed / cancelled counts come with 6.3).
  - [x] d. `APP / ORDER#<paidAt>#STORE#<storeId>#<orderId>` {currency, totalMinor,
        platformFeeMinor} for admin graphs (8.1) and fee reporting (8.4).
- [x] 5.7 Lost-order sweeper (done 2026-11-14; `layers/payments/order-sweep.ts`, registered in
      `index.ts` every `SERVER_WATCH_CHECK_FOR_LOST_ORDERS_INTERVAL`, 10 min).
      create-order now also writes `APP_PENDING_ORDER / ORDER#<createdAt>#<orderId>`
      `{storeId, orderId, orderSk}` in the same transaction. Once the checkout should have
      ended (30 min lifetime + 15 min margin), the sweeper asks Stripe, on the store's account,
      what happened:
      - order gone, or already settled → the row is dropped;
      - session expired, or missing → CANCELLED `PAYMENT_EXPIRED`;
      - session still open → it's expired first, then cancelled;
      - session complete and paid → `markOrderPaid` (stock, counters, sale), logged as a missed
        webhook;
      - complete but unpaid (a bank debit on its way) → it checks the PaymentIntent: succeeded
        → PAID; canceled or needs a new method → CANCELLED `PAYMENT_FAILED`; still processing →
        the row is kept.
      It makes the same conditional writes as the webhook, so the two can't clash. Up to 200
      orders per run; a row whose check fails stays for the next run. It runs on one server,
      like the grace sweep (fine with more, since it's idempotent).
      `scripts/backfill-pending-orders.mjs` lists older pending orders. The dev dry run found
      none, so it wasn't run.

---

## 8. Stage 6 — Order management & notifications

- [x] 6.1 `GET /store/orders/list/:storeId?status=&from=&to=&cursor=&limit=` (done 2026-11-13;
      any store member): newest first; `status` comma-separated, default every status but
      PENDING_PAYMENT; `from`/`to` on the sort key; filtered pages read up to 5 times to fill
      `limit` (≤ 100, default 25); `next` = the sort key of the last row. Rows are
      `MerchantOrderSummary`. (WA 6.1)
- [x] 6.2 `GET /store/orders/get/:storeId/:orderId` (done 2026-11-13): `MerchantOrderView` (all
      but the token hash); another store's order = 404 `ORDER_NOT_FOUND`. (WA 6.2)
- [x] 6.3 `PUT /store/orders/update-status` `{storeId, orderId, status, fromStatus}` (done
      2026-11-13): forward only (`nextOrderStatuses`: Paid → Preparing → Ready → Shipped for
      deliveries → Completed, skips allowed), only from `fromStatus` (conditional write), appends
      `storeOrderStatusHistory` `{status, at, by}`. 409 `INVALID_TRANSITION` / `STATUS_CHANGED`
      with the current order. No cancel: a paid order is cancelled by refunding (6.4). No
      completed/cancelled counters yet (nothing reads them; add with 8.1). (WA 6.2)
- [x] 6.4 `POST /store/orders/refund` `{storeId, orderId, amountMinor, refundedMinor, reason?}`
      (done 2026-11-14; store ADMINs and platform admins, never MERCHANT members, since money
      moves). It refunds part or all of a paid order on the connected account (direct charge),
      and only from the refunded total the merchant saw (409 `REFUND_CHANGED`). The idempotency
      key is `ceseelia-refund-<orderId>-<refundedMinor>-<amountMinor>`, so a double click makes
      one refund. Afterwards the charge's `amount_refunded` from Stripe goes on the order, and
      `recordOrderRefund` now only raises the total, so a late webhook can't lower it. Refunding
      the remainder makes the order REFUNDED. Each refund is kept in `storeOrderRefunds`
      `{refundId, amountMinor, status, reason, at, by}`. 409s: `NOT_REFUNDABLE`,
      `AMOUNT_TOO_LARGE`, `ORDER_DISPUTED` (open or lost dispute), `INSUFFICIENT_BALANCE`;
      503 / 502 for Stripe being unavailable or refusing. (WA 6.3)
      **Owner decisions (2026-11-14):**
      - a. ✅ Ceseelia keeps its fee on every refund (`REFUND_APPLICATION_FEE = false` in
           `layers/payments/order-refund.ts`), the same as a refund in Stripe's dashboard.
      - b. ✅ Stock is never put back automatically; the merchant adjusts it by hand in
           Inventory. WA reminds them in the refund form, the confirm dialog and the toast,
           and with a note linking to Inventory on any order with a refund.
      - c. ✅ Only store ADMINs (and platform admins) can refund; MERCHANT staff can't.
- [x] 6.4b Refunds synced from Stripe (done 2026-11-14). Every refund event
      (`charge.refunded`, `charge.refund.updated`, `refund.created`, `refund.updated`,
      `refund.failed`), and our refund route afterwards, calls `syncOrderRefunds`
      (`layers/payments/refund-sync.ts`). It lists the payment's refunds on the connected
      account and writes what `orderRefundState` (`layers/core/refunds`) works out:
      - The refunded total counts succeeded, pending and requires_action refunds, but not
        failed or canceled ones.
      - Refunding all of it → REFUNDED. If a refund then fails, the order goes back to the
        merchant's last step (or PAID).
      - Each `storeOrderRefunds` entry gets its current status, and failed or canceled refunds
        go in `storeOrderFailedRefunds` `{refundId, amountMinor, status, reason, at}`, so WA
        can warn the merchant.
      The write is conditional on `storeOrderUpdatedAt` (it retries up to 3 times), and the
      event's own snapshot is never trusted, so late or out-of-order events are harmless. This
      replaced `recordOrderRefund` and its "only goes up" rule.
- [x] 6.5 Emails (done 2026-11-14, HTML only; `layers/notifications/`, with the templates in
      `order-email-templates.ts` as pure functions and the sending in `order-emails.ts`).
      - **Shopper**, "<Store> via Ceseelia", with the store's email as Reply-To:
        - a receipt when the order is first paid (webhook or 5.7 sweeper; a repeat event,
          `ALREADY`, sends nothing). It has the lines, saving, delivery, each tax line and the
          total, never the platform fee.
        - "ready for pickup" (pickup → READY) and "on its way" (delivery → SHIPPED); other steps
          send nothing.
        - an email for each rise in the refunded total, whether from our route or the dashboard
          (only the `syncOrderRefunds` write that saw the rise sends it). Failed refunds send
          nothing.
      - **Store:** a new-order alert to every member's account email (ADMIN and MERCHANT, each
        address once), linking to `/store/orders/<storeId>?order=<id>`, with the out-of-stock
        flag.
      - **Review decision** (P.8): an approval or rejection (with the admin's message) to the
        store's ADMIN members.
      - **Order links:** each shopper email has its own token, `…/order/<id>#t=<token>`. Only
        its hash is kept, in `storeOrderLinkTokenHashes` (appended atomically, never returned),
        and order-status (6.6) accepts it as well as the checkout token. The fragment never
        reaches a server or its logs; WA saves the token and strips it from the address bar.
      - **Store** also: the contact email gets the alert too, unless turned off (see c below).
      - Everything is best effort: it never throws and logs what failed. Routes answer first and
        send afterwards. Sender names are header-safe and MIME-encoded when they aren't ASCII.
      **Owner decisions (2026-11-14), all done:**
      - a. ✅ **PDF receipt** attached to the receipt email (`layers/notifications/receipt-pdf.ts`,
           pdfkit; sent as a raw MIME email by `sendEmailWithAttachments`). It shows the seller
           (the store, its email, pickup address and tax number), "Billed to", "Deliver to" or
           pickup, the lines with savings, the totals and tax lines, and the note. It never
           shows the platform fee. Built-in Helvetica only prints Western European text, so
           other characters print as "?" (a Unicode font can come later). If the PDF fails,
           the email still goes, without it.
      - b. ✅ **Tax registration number:** `storeInfo.taxNumber` (optional; letters, digits,
           spaces, dots, dashes; ≤ 30), in Settings › Store info, printed on the receipt email
           and PDF as "GST/HST no." (CAD), "ABN" (AUD) or "Tax ID" (USD).
      - c. ✅ **New-order alerts** go to every member **and** the store's contact email, each
           address once. Settings › Store info has a switch, `storeInfo.emailOrderAlerts`
           (missing = on, never in public responses), that turns the contact-email copy off.
      - d. ✅ **SES is in production** (checked 2026-11-14: `ProductionAccessEnabled`, 50,000 a
           day, `ceseelia.com` verified with DKIM), so any address gets mail.
- [x] 6.6 `GET /customer/order-status/:orderId` (done 2026-11-13, early, for WA 5.2's return
      page): the status token in header `X-Order-Token` (not the URL); a wrong token = unknown
      order = 404 `ORDER_NOT_FOUND`; shopper view only (no Stripe ids, fee, commission, hash);
      60/IP/min. Tokens don't expire (they're the shopper's receipt links); 6.5 adds one token per
      order email (`storeOrderLinkTokenHashes`).
- [x] 6.7 Optional FCM push to the merchant. (WA 6.4)
  - _Done 2026-11-15 as standard **Web Push with VAPID** (`web-push` 3.6.7; no Firebase, so no
    new vendor; the legacy `update-fcm-token` stays for the old mobile app). Keys
    `vapidPublicKey` / `vapidPrivateKey` in the stage secret (`scripts/setup-vapid.mjs`, never
    prints the private key, refuses to replace an existing pair). Subscriptions `USER#<id> /
    PUSH#<sha256(endpoint)>` (≤ 10 per user, oldest dropped). Routes: `GET /user/push/config`,
    `POST /user/push/subscribe` (20/user/h), `/unsubscribe`, `/test` (5/user/10 min). **The
    server POSTs to the browser's endpoint, so only the real push services are accepted**
    (FCM, Mozilla, Apple, Windows; https, no port or credentials), on save and again on send.
    404/410 from the push service deletes the subscription. Payload: store name, order code,
    total, pickup/delivery, the order's dashboard link; no shopper details.
    **New-order alerts:** `STORE#<id> / ORDER_ALERT#<at>#<orderId>` (ids, code, total; `ttl` a
    week), written by `alertNewOrder` from `notifyOrderPaid` (first PAID only; best effort, the
    payment transaction is untouched). `GET /store/orders/new/:storeId?since=` (members): no
    `since` = just `now` (a fresh dashboard announces nothing old), else rows after it (cut to a
    day), newest first, ≤ 20. Also fixed: processed Stripe event rows set `expiresAt` but the
    table's TTL attribute is `ttl`, so they never expired; they now set both. Tests in
    `tests/order-alerts.test.ts`._

---

## 9. Stage 7 — Customers, rewards & reviews

- [x] 7.1 Customer records per store, built from orders, plus `GET /store/customers/list/:storeId`.
      (WA 7.1)
  - _Done 2026-11-15 (L.7). `STORE#<id> / CUSTOMER#<sha256(email) 32 hex>` (email, name,
    phone from the newest order, `orders`, `spent_<CUR>` net of refunds, first/last order) and a
    per-order marker `CUSTOMER_ORDER#<orderId>` (`customerId`, `currency`, `refundedMinor`).
    `recordCustomerOrder(order)` is the only writer and idempotent (marker + counters in one
    conditional transaction; a refund applies only the change, both ways; a lost race re-reads):
    called from `notifyOrderPaid` (best effort) and after `syncOrderRefunds` writes. List: every
    customer (≤ 5,000, `partial`), most recent first. `scripts/backfill-customers.mjs` (dry run
    by default) for orders paid before this; dev and prod have none, so not run. Tests in
    `tests/customers.test.ts`._
- [x] 7.2 Optional customer accounts: the light version (owner 2026-11-15): a shopper proves
      their email with a 6-digit code per store, no password and no Cognito. Full accounts stay
      out of scope.
  - _Done 2026-11-15 with 7.4 (`/customer/rewards/*`)._
- [x] 7.3 Unify the rewards redemption constant: `POINTS_TO_MONEY` / `POINTS_TO_DISCOUNT`.
  - _Done 2026-11-15. `layers/core/rewards` `normalizeRedemptionMethod` reads the old
    `REWARDS_REDEMPTION_*`; `updateStoreSettings` always saves the new spelling; the validator
    still accepts both (an open tab of the older webapp mustn't fail to save).
    `scripts/normalize-rewards-method.mjs` (dry run by default) rewrote nothing yet: 1 dev store
    to change; owner runs `--write` for dev and prod._
- [x] 7.4 Rewards: earn on paid orders, redeem inside the quote. (WA 7.2)
  - _Done 2026-11-15. Rules in `layers/core/rewards`, data in `dynamo-entities/rewards`:
    - Earn: `pointsPerDollarSpent` × whole units of the items paid for (after all discounts and
      the reward; no delivery or tax), rounded down, at the rate when paid, once per order
      (`REWARDS_EARN#<orderId>` marker, from `notifyOrderPaid`). Refunds take back the same share
      (`refund-sync`); the balance can go below 0 when spent points are refunded.
    - Spend: one reward per order, off the items before tax (`priceLines` `rewards`, Quote
      `rewardsMinor`), so commission (`commissionBaseMinor`) and tax are on the price after it;
      Stripe lines carry it spread to the cent (`allocate`). Create-order needs a live session
      for that store, the checkout email = the rewards email, and the balance; the points are
      taken in the order's own transaction (conditional `balance >= cost`), so two tabs can't
      spend them twice (→ 409 REWARDS_BALANCE, the Stripe session is closed). Given back with
      the cancel itself when never paid (`cancelPendingOrder`, once), or on a full refund
      (`returnRewardsSpend`, once).
    - Identity (owner: "someone can't try all combinations of a 6-digit number"): codes from
      `crypto.randomInt`, kept salted and hashed, 10 min, single use, 5 guesses each, counted by
      a conditional update before comparing (parallel guesses can't get more), a new code
      replaces the old. Requests: 3 / 15 min and 10 / day per email (in the table, so a restart
      doesn't reset them), 5 / 10 min and 20 / day per IP, 200 / h per store. Guesses: 20 / 10
      min per IP. So at most ~50 guesses a day per email out of 1,000,000. The answer and the
      work are the same whether or not the email has points; only an email with points is sent
      the code (no spam to strangers), and the email has no link. Sessions: 32 random bytes,
      kept hashed, 30 days, per store; sign-out deletes them.
    - Shown: `rewardsMinor` on the shopper's order view, the emails and the PDF receipt.
    Tests: `tests/rewards.test.ts` (an in-memory table that applies the conditions: brute
    force, parallel guesses, expiry, single use, limits, earn/refund/return exactly once) and
    redemption cases in `tests/create-order.test.ts`._
- [x] 7.5 Reviews: `POST /customer/review` (completed orders only, token-gated), moderation,
      `GET /store/reviews/list/:storeId`. (WA 7.3)
  - _Done 2026-11-15 (L.7), owner's rules. `layers/aws/dynamodb/dynamo-entities/review`:
    `REVIEW#<createdAt>#<orderId>`, `REVIEW_FOR#<orderId>` (one per order, conditional),
    `REVIEW_STATS` (count, sum, r1–r5), queue `APP_REVIEW_REPORT`; what's published and the
    stats always move in one transaction. Buyer: `GET`/`POST /customer/review` with the
    order's token (checkout or email; wrong = 404), once the order is READY / SHIPPED /
    COMPLETED or 14 days after payment, never cancelled or refunded; rating 1–5, comment ≤ 2,000
    (plain text, control and bidi characters stripped); shown as first name + last initial and
    what they bought; 10/IP/10 min. Public `GET /store/public/reviews/:storeId` (published,
    summary on page 1). Store: `list` (removed ones too, report state, not who reported), `PUT
    reply` (set / replace / remove), `POST report` (OFFENSIVE / PERSONAL_INFO / SPAM / OTHER +
    note; once per review; emails ADMIN_ALERT_EMAIL). Admin: `get-review-reports`,
    `decide-review-report` KEEP (can't be reported again) / REMOVE (hidden, out of the
    rating). There is no edit or delete route. Ready/shipped emails now mention reviewing.
    Tests in `tests/reviews.test.ts`._

---

## 10. Stage 8 — Admin console & support

- [x] 8.1 Fill in the real admin overview (`quickStats`, `salesActivity`, store counts). Today
      they're empty objects. (WA 8.1)
  - _Done 2026-11-15. `GET /admin/get-overview-data?tz=` → `{ stats, allStores }`
    (`layers/core/admin-stats`, same definitions as Store Overview): stores by status, merchants
    (people in at least one store), plans, past-due subscriptions, last 30 days vs the 30 before
    (paid orders, net sales, commission: the fee is kept on refunds), 30-day chart, top 5 stores,
    to-do counts (stores and items to review, reported reviews, open tickets). Reads 60 days of
    orders per store (≤ 3,000 each, `partial`), 8 stores at a time, cached 60 s. The made-up
    counters (Profit, Expenses, Requests, Conversions) are gone: nothing measures them. Fine at
    today's size; past a few hundred stores this wants a daily stats row written on payment._
- [ ] 8.2 Merchant join requests (**superseded by P.3**, 2026-11-12: anyone can create a store;
      checks happen at Go Live. Keep only if the owner still wants an application form):
  - [ ] a. Public `POST /merchant/join-request` (rate-limited, bot check)
  - [ ] b. Admin list, approve and deny
  - [ ] c. Approval creates the store and membership (1.4)
  - [ ] d. Fix the `joinRequestt…` field typo before the first write. (WA 8.2)
- [x] 8.3 Support tickets: merchant create/list/reply, admin list/reply/close, SES notices. (WA 8.3)
  - _Done 2026-11-15. `dynamo-entities/support-ticket` (`APP_TICKET / TICKET#id`, a pointer
    under the user, messages under `TICKET#id`). Any signed-in user: `/user/support/tickets`
    (list, create with subject / topic / message / optional store they belong to, read, reply,
    close); someone else's ticket is a 404. 5 new a day, 10 open, 30 replies an hour, 100
    messages a ticket, 4,000 characters, text cleaned like reviews. Admins: `/admin/support/
    tickets` (list ≤ 1,000, read, reply signed "Ceseelia support", close). Status OPEN → ANSWERED
    → CLOSED; a user's reply reopens. Emails: the team (ADMIN_ALERT_EMAIL) on a new ticket or
    reply, the user when we reply: subject and a link only, never the message._
- [x] 8.4 Commission reporting per store, from Stripe application fees. (WA 8.4)
  - _Done 2026-11-15. `GET /admin/commission-report?month=YYYY-MM&tz=[&reconcile=1][&format=csv]`
    (`layers/core/commission`): per store for the month, orders, sales, refunds and the fee saved
    on each order (exactly the `application_fee_amount`), per currency, with totals; cached 60 s.
    `reconcile=1` lists Stripe's application fees for the month and marks each store matches or
    not, plus fees on accounts no store uses. CSV with formula-safe cells. Subscription revenue
    isn't in it (that's Stripe Billing on the platform account)._

---

## 11. Stage 9 — Production readiness

- [x] 9.1 Structured logging (pino) with request ids, and no PII or tokens in logs. Replace the
      `console.warn` request logger and the `console.error(e)` calls in routes.
  - _Done 2026-11-15. `layers/core/logger` (pino 10.4.0): JSON lines on stdout, pretty in a dev
    terminal (`pino-pretty`, dev dependency; `LOG_PRETTY=false` turns it off), `LOG_LEVEL`
    (default info in prod, debug in dev, silent in tests). `requestLogger` is first in `app.ts`:
    a request id (nginx's `$request_id` via `X-Request-Id` if well formed, else a UUID; echoed
    back) on **every** line logged during the request (AsyncLocalStorage), and one line per
    request: method, full path with emails masked (the invite routes have one in the URL), status,
    ms, IP cut to /24 (IPv6 /48). Never the query string or headers. Redacted keys anywhere in the
    first three levels (email, name, phone, address, postal code, tokens, secrets, authorization).
    Errors go through `errSerializer`: type, message (emails masked), stack, code, Stripe type and
    request id, AWS status and request id, cause; **never** the payloads AWS and Stripe attach.
    All ~100 `console.*` calls in app code replaced (scripts keep `console`). **Route 500s used to
    be logged in dev only; they are now logged in every stage.** "Auth failed" is a one-line warn.
    Tests in `tests/logger.test.ts`._
- [x] 9.2 `express-rate-limit` on public and auth-sensitive routes (needs S.13). Lower the JSON
      body limit per route where 1 MB isn't needed.
  - _Done 2026-11-15. `layers/core/http/api-limits.ts` (express-rate-limit 8.7.4, in memory, new
    counters per `createApp()`): 300/IP/min over `/api/v1`, 120/IP/min on the public storefront
    reads (`store/public/*`, `get-data-public`); 429 `RATE_LIMITED` + `Retry-After` and draft-8
    `RateLimit` headers, after CORS so the webapp can read it. The per-route limits (quote,
    create-order, order-status, contact-store, create-store, update-info, Go Live) stay. Stripe
    webhooks and `/healthz` are never limited. JSON bodies 100 KB (was 1 MB), 256 KB for
    `create-item` and `update-settings`; 413 `BODY_TOO_LARGE` / 400 `INVALID_JSON` as JSON, and a
    final error handler (logged, plain 500). nginx: `client_max_body_size` 1m (was 2m), passes
    `X-Request-Id`, and **`/api/v1/store/go-live` gets `proxy_read_timeout 120s`** (60 s would
    cut off Go Live's 90 s AI check with a 504). Tests in `tests/api-limits.test.ts`._
- [x] 9.3 (2026-11-14) `GET /healthz` (before host routing; 503 while shutting down, `no-store`),
      graceful shutdown in `index.ts` (SIGTERM/SIGINT: stop the sweeps, stop taking
      connections, 10 s for in-flight requests), Docker `HEALTHCHECK`, nginx waits for healthy.
- [x] 9.4 CI (GitHub Actions): lint, typecheck, test, `npm audit --omit=dev`, build image.
  - _Done 2026-11-15. `.github/workflows/ci.yml` on every push to `main` / `dev_**` / `prod_**`
    and every PR: Node 24, `npm ci`, lint (errors fail; warnings until 9.7), typecheck, test,
    `npm audit --omit=dev --audit-level=high`, build; then the Docker image is built from that
    `dist/` and started until `/healthz` answers. No secrets: the tests mock AWS and Stripe
    (checked with no AWS credentials at all) and the image starts without them. Nothing is
    pushed or deployed._
- [x] 9.5 IaC (CDK/Terraform): table and GSIs, buckets (private, CloudFront OAC, CORS), Cognito
      plus triggers, IAM least-privilege instance role.
  - _Done 2026-11-15 in `../ceseelia_cloudformation` (AWS SAM, already there; not CDK/Terraform).
    The table, GSIs, bucket, Cognito and the sign-up trigger were in it; added: the trigger's
    `DynamoDBCrudPolicy` on its own table (was `AmazonDynamoDBFullAccess`), `nodejs22.x` (18.x is
    past end of support; 24.x dropped callback handlers), a `cfn-lint` gate before every deploy.
    **Still by hand, on purpose:** `CeseeliaServerRole` (policy in `iam/`), the `Admins` group,
    the secrets, the SES identity and the zone (adding them fails on "already exists" unless
    imported). CloudFront + OAC is L.9 (3.2b)._
- [x] 9.6 DynamoDB PITR backups, S3 versioning/lifecycle, CloudWatch alarms.
  - _Done 2026-11-15 (CloudFormation branch `dev_v1.0.0_l4_backups_alarms`; live once merged and
    pushed). **PITR was off on both tables, prod included**, with no deletion protection: now
    PITR + deletion protection + `Retain`. Buckets versioned (old versions gone after 30 days).
    User pool deletion protection + `Retain`. Log group `/ceseelia/<stage>/api` (30 days) fed by
    Docker's `awslogs` driver (`docker-compose.yml`; the default json-file log had no size cap,
    nginx's is now 3 × 10 MB) and an error metric (`level >= 50`). Alarms to SNS
    `ceseelia-alarms-<stage>`: API errors ≥ 5 / 5 min, DynamoDB throttles and system errors,
    sign-up trigger errors, SES bounce > 3% / complaint > 0.05% (prod). `iam/` policy gains
    `ApiLogsProd` (write to that log group only). Previewed as a change set on `ceseelia-dev`
    (not executed): no replacements. **Owner:** see L.4._
- [ ] 9.7 Bring lint warnings (68 on 2026-11-15) down to zero, then make warnings fail CI.
- [ ] 9.8 Store addresses: every store at its own subdomain (phase 1, ✅), then custom domains
      (phase 2, code done 2026-11-16, deploy §0 G4–G5). Owner decisions 2026-11-15: `<slug>.ceseelia.com` for every store
      (the slug's uniqueness is the DB's); a custom domain is always the store's own and always a
      subdomain (`shop.` suggested); `app.ceseelia.com/s/<slug>` keeps working; a changed slug
      frees the old address at once (a clear warning before saving).
  - [x] **Phase 1, store subdomains** (done 2026-11-15; deploy = §0 G1–G2).
    - Backend: `STORE_URL_TEMPLATE` (prod default `https://{slug}.ceseelia.com`, dev empty =
      `WEBAPP_URL/s/<slug>`), `layers/core/store-url` (`storeUrl`, `slugFromStoreOrigin`).
      Shopper links use it: Stripe Checkout success / cancel, order emails' `#t=` links, link
      previews' `og:url`. Merchant links (billing, onboarding, admin alerts) stay on the app.
      CORS also allows any origin matching the template whose slug is valid (`buildCorsOptions`).
      20 more reserved slugs (subdomain and infrastructure names: `shop`, `storage`, `prod`,
      `mail` hosts, `domains`, …), mirrored in the webapp. `tests/store-url.test.ts`.
    - Webapp: config `storeUrlTemplate`; `core/routing/store-host` (host detection, a
      `UrlSerializer` that routes `/x` as `/s/<slug>/x` on a store address and shows it
      without the prefix, guards sending app pages to the app and another store's `/s/` path to
      that store). Share, the go-live sheet and the canonical tag use the store address. The
      order page moves an old link (renamed store) to the store's current address, token in
      `#t=`. Store-link editor: shows `https://<slug>.ceseelia.com`, a warning box while the
      slug differs, and a confirm.
    - CloudFormation (prod): `*.ceseelia.com` alias (the wildcard certificate covers it) and
      wildcard A/AAAA; the router function gives bots the preview for `/` on a store address.
    - On a slug change nothing else needs updating: the slug transaction already moves the
      reservation and the overview; emails and Stripe returns build links when sent; Stripe
      accounts carry only `storeId`; one wildcard record covers every store; cached previews
      expire within 5 minutes. Old order links still open (order page redirect).
  - [x] **Phase 2, custom domains** (code done 2026-11-16; deploy = §0 G4–G5; P.9, Spark and
    Nova). Owner decisions 2026-11-16: now; both paid plans; subdomains only; one fixed CNAME
    target, so a slug rename never touches the merchant's DNS; the address bar stays on their
    domain (no redirect).
    - **CloudFront (CloudFormation, prod only):** a separate multi-tenant distribution
      (`ConnectionMode: tenant-only`, same bucket, origins, caching and headers as the webapp)
      on a connection group; `domains.ceseelia.com` is a plain CNAME to the group's routing
      endpoint plus the `_cf-challenge` TXT. One distribution tenant per store domain, with a
      CloudFront-managed certificate (HTTP validation: no DNS work for us or the merchant
      beyond the one CNAME). Price: 10 tenants free, then a $20 a month bundle up to 200, then
      $0.10 each; certificates free.
    - **Records** (`dynamo-entities/domain`): `STORE#<id>/DOMAIN` (host, status, reason,
      `dnsSeen`, tenant, certificate ARN, timestamps), `DOMAIN#<host>/DOMAIN` (`storeId`, unique
      like slugs), `APP_DOMAIN/STORE#<id>` (the sweep's list), `APP_DOMAIN_CLEANUP/<tenantId>`.
      Saves are conditional on `updatedAt`, so a remove or a retry in between wins.
    - **States** (`layers/core/custom-domain`, `layers/custom-domains`): PENDING_DNS (the CNAME
      must resolve to `domains.ceseelia.com` before anything is created: that proves control of
      the domain; 7 days, then FAILED) → PENDING_CERT (tenant created; 72 hours, then FAILED and
      the tenant cleaned up) → ACTIVE. The plan ends: ACTIVE → DISABLED (tenant off, back on with
      a plan, removed after 30 days); one still being set up is dropped. FAILED → "Try again".
      Removed tenants: disable, wait for Deployed, delete, then the ACM certificate (a few
      sweeps). Sweep every minute (`CUSTOM_DOMAIN_SWEEP_INTERVAL`); setup and "Check now" run a
      step at once.
    - **API:** `GET /store/domain/:storeId` (members), `POST /store/domain/set | check | remove`
      (store ADMIN; set needs a plan, 402 PLAN_REQUIRED; 409 DOMAIN_TAKEN / STORE_HAS_DOMAIN;
      400 APEX_DOMAIN / OUR_DOMAIN / INVALID_DOMAIN; 503 DOMAINS_UNAVAILABLE without the env).
      Public: `GET /store/public/domain/:host` → `{slug}` (live only), and
      `/store/public/preview-domain/:host[/:itemId]` for bots (the custom distribution's router
      function). The storefront answer carries `ownDomain` when live.
    - **Links and CORS:** an in-memory list of live domains (refreshed every minute, after each
      change and after a slug rename): `storeUrl` prefers the store's own domain (Stripe
      returns, order emails, previews), CORS allows `https://<live host>`. Store deletion removes
      the rows and queues the tenant.
    - **Env:** `CUSTOM_DOMAIN_DISTRIBUTION_ID`, `CUSTOM_DOMAIN_CONNECTION_GROUP_ID` (stack
      outputs), `CUSTOM_DOMAIN_TARGET` (prod default `domains.ceseelia.com`). Off when empty.
    - **Webapp:** `StoreHostService` asks `/store/public/domain/<host>` at start-up on any other
      host, then acts as on `<slug>.ceseelia.com`; canonical and Share use a live own domain.
      Store front › Info › "Your own domain": enter it, the CNAME to add (copy buttons, a
      Cloudflare "DNS only" note), live status (polled every 15 s while pending), Check now /
      Try again, Remove.
    - Tests: `tests/custom-domains.test.ts` (rules, every state step, clean-up, routes, links,
      CORS) and the access matrix.
    - **Not done / later:** apex domains (merchants redirect `example.com → shop.example.com` at
      their registrar); Cloudflare-proxied CNAMEs don't show as CNAME (the card says DNS only);
      Domain Connect (one-click DNS).

---

## 12. Changelog

| Date | Change |
|---|---|
| 2026-11-16 | 9.8 phase 2 custom domains coded: CloudFront multi-tenant tenants per store domain (`layers/aws/cloudfront/tenants`), domain records + sweep (`dynamo-entities/domain`, `layers/custom-domains`), `/store/domain/*` and public `domain` / `preview-domain` routes, `storeUrl` / CORS / storefront `ownDomain` use live domains, store deletion cleans up. §0 G3 decided, G4–G5 added (deploy). Tests 1269. |
| 2026-11-16 | §0 G1–G2 done (store subdomains live on prod). §0 H: automatic prod deploys: `.github/workflows/deploy-prod.yml` (CI checks via `workflow_call`, image → ECR `ceseelia-node`, SSM → `deploy-image.sh` with health check and rollback), GitHub OIDC role `CeseeliaGithubDeployBackendProd` (`iam/github-deploy-backend-*.json`), server role gains ECR pull + SSM agent; compose's node image is `${NODE_IMAGE}` from `./.env`. Tested on prod (deploy and rollback). |
| 2026-11-16 | QA (C3): the admin store list's Completions, Cancelled and Last order were never updated (always 0 / NA). Now `markOrderPaid` sets the last-order time, Completed adds to Completions (`bumpStoreOrderCounter`), and a full refund adds to Cancelled (back off if a failed refund undoes it). Existing prod store backfilled by hand. |
| 2026-11-16 | §0 C3 done (first test order on prod, all emails received); D3 done: `PAID_PLANS_ENABLED=true` on the prod server (test mode). Next: C4. |
| 2026-11-16 | §0 C4 done (Spark checkout and portal plan switch tested by the owner); F3 done (owner, accountant). |
| 2026-11-16 | Stripe portal (test mode) set by Claude with `scripts/setup-billing-portal.mjs`: upgrades invoice the difference at once (`always_invoice`), downgrades wait for the period's end. Was `create_prorations` (difference on the next invoice). |
| 2026-11-16 | L.10 on prod (backend and webapp); owner tested it end to end. Webapp: the empty Admin › Merchants page removed. |
| 2026-11-16 | L.10 messages (backend): store ↔ shopper async chat per order and from Contact us (inquiries with an emailed private link); text + up to 4 photos; paginated inbox and messages; unread both ways; push on shopper messages, store email after 30 min unread (setting, default on), shopper email per unread reply; reports → admin dismiss/block. 57 new tests. |
| 2026-11-15 | 9.8 phase 1: store subdomains `https://<slug>.ceseelia.com` (`STORE_URL_TEMPLATE`, `layers/core/store-url`): Stripe return URLs, order email links and link previews use them; CORS allows them; 20 more reserved slugs. Phase 2 (custom domains) planned under 9.8. §0 G added (deploy order). Tests 1176. |
| 2026-11-14 | Secrets: one per stage (`ceseelia/dev`, `ceseelia/prod`, `APP_SECRET_ID`, flat keys incl. `anthropicApiKey`); Stripe reads it (checked against the Stripe sandbox). `CeseeliaServerRole` + instance profile for the future prod server (`iam/`). The API isn't deployed yet; the certbot error in `~/tasks.md` is primehost-0's (another project). |
| 2026-11-14 | L.3 done: S.14 helmet + nginx hardening + pinned images; S.15 non-root image with `npm ci --omit=dev` and HEALTHCHECK; S.16 legacy auth/PayPal/PrimeFaya/DinersXpress code deleted; S.17 certbot renewal fixed (paths, executable bit, nginx reload from the host). 9.3 `/healthz` + graceful shutdown. Server step: `crontab -e`, make the line `0 2,14 * * * /bin/bash <project>/certbot-renew.sh >> <project>/certbot-renew.log 2>&1`. |
| 2026-11-14 | Launch checklist L.0–L.9 added at the top of §1 (owner: everything in it must be done before launch). |
| 2026-11-14 | 6.5 owner decisions done: PDF receipt attached (pdfkit, raw MIME `sendEmailWithAttachments`), `storeInfo.taxNumber` on receipts, new-order alerts also to the store's contact email (`storeInfo.emailOrderAlerts`, default on, never public). SES checked: production access on. |
| 2026-11-14 | 6.5 done: order emails (receipt, new-order alert to members, ready / on its way, refunds, review decisions) in `layers/notifications`; per-email order links (`storeOrderLinkTokenHashes`, accepted by order-status); header-safe sender names. Owner questions under 6.5. |
| 2026-11-14 | 5.7 done: lost-order sweeper (`sweepLostOrders`, every 10 min) over the new `APP_PENDING_ORDER` rows written by create-order; asks Stripe and marks PAID (missed webhook) or CANCELLED, keeps delayed payments; `scripts/backfill-pending-orders.mjs` (dev: nothing to list). |
| 2026-11-14 | 6.4b done: refunds synced from Stripe's live list on every refund event and after our route (`syncOrderRefunds`, `orderRefundState`); failed / canceled refunds stop counting, REFUNDED goes back to the last step, `storeOrderFailedRefunds`. New Connect events: `charge.refund.updated`, `refund.created/updated/failed`. Owner: only store ADMINs refund. |
| 2026-11-14 | 6.4 owner decisions: keep the platform fee on refunds; no automatic restock (WA reminds the merchant to adjust stock in Inventory). |
| 2026-11-14 | 6.4 done: `POST /store/orders/refund` (store ADMINs; part or full refund on the connected account, conditional on the refunded total seen, idempotency key from it; `storeOrderRefunds`; 409 `NOT_REFUNDABLE` / `REFUND_CHANGED` / `AMOUNT_TOO_LARGE` / `ORDER_DISPUTED` / `INSUFFICIENT_BALANCE`). `recordOrderRefund` now only raises the total. Owner questions under 6.4. "Start here" refreshed. |
| 2026-11-13 | 6.1–6.3 done: `/store/orders/list`, `/get`, `/update-status` (members; forward-only steps with history, conditional on the status seen); `MerchantOrderView` / `MerchantOrderSummary`, `nextOrderStatuses`. |
| 2026-11-13 | `POST /customer/quote` takes an optional delivery `postalCode` (WA 5.1 checkout), so the total shown is taxed exactly as create-order will; the cart still sends none and gets the geo-IP estimate (QA Q.23). |
| 2026-11-13 | 5.5 + 5.6 done: Connect webhook `/api/v1/payments/stripe-connect-webhook` (signature, account/session checks, event ids; paid / expired / async failed / refunds / disputes / account.updated), `markOrderPaid` (one transaction: PAID, stock by item or variant row, order count, APP sale record; shortfall → paid and flagged). 6.6 `GET /customer/order-status/:orderId` (token header). Old 501 stub removed. |
| 2026-11-13 | 5.3 + 5.4 done: order model (status enum, pointer row, guest customer, status token hash), `POST /customer/create-order` (re-quote with the delivery postal code, `PRICE_CHANGED` guard, direct-charge Checkout Session with `application_fee_amount`, no `automatic_tax`, session total = quote total). Owner: guest checkout, address on our form. Next: 5.5 Connect webhook. |
| 2026-11-13 | Stage P QA done by the owner (WA §1b): everything passed, paid plans included. Next: 5.3 / 5.4 checkout. |
| 2026-11-13 | P.11 (owner, from Stage P QA): one store per account in any role (`ALREADY_IN_A_STORE` on create-store, assign member, invite; 5-draft cap removed); `POST /store/update-info` lets store admins change name and link (old slug freed at once); settings save keeps the overview name in step with the storefront name. |
| 2026-11-13 | P.10: Free plan dropped (owner). Only Spark / Nova; new stores are DRAFT with plan NONE; Go Live = checkout; a plan that ends (cancel at period end, payment lost after grace, admin removal) sends a live store back to DRAFT (`PLAN_ENDED`). `/store/billing/checkout` removed, P.7 dropped, migration script `scripts/migrate-free-plan.mjs` added and run on dev (4 stores → DRAFT / NONE). |
| 2026-11-12 | "Pick up here" refreshed for the next session: Stage 5 checkout (5.3–5.4) next, then P.7; owner TODOs listed (AI check, Stripe Billing setup). |
| 2026-11-12 | P.8 done: admin store list with status / plan / billing, review queue (`APP_REVIEW`, get-review-queue, review-store approve/reject), set-store-plan (gift a plan, no checkout needed at Go Live); store delete cleans the admin-list rows. |
| 2026-11-12 | P.6 done: `admin.commissionSource` PLAN / CUSTOM (missing = PLAN); `platformFeeForStore`, `commissionInEffect`, `feeFromCommission` (5.4c must use them); admin settings routes take/return the source, GET adds the plan and its default fee. |
| 2026-11-12 | P.5 done: Stripe Billing subscriptions (Go Live paid → Checkout, `/store/billing/{status,checkout,portal}`, webhook `/api/v1/billing/stripe-webhook`, sync from Stripe with grace + hourly sweep, one subscription per store, store delete cancels it), `PAID_PLANS_ENABLED`, `scripts/setup-billing-prices.mjs`; owner's Stripe setup listed under P.5. |
| 2026-11-12 | P.4a/b done: `GET /store/go-live/checklist/:storeId`, `POST /store/go-live` (FREE; paid plans 409 `PLAN_NOT_AVAILABLE` until P.5), `GET /store/public/plans`; `runSmartStoreValidation` stub called on Go Live (**AI check still TODO**), fail-closed to IN_REVIEW with admin-only `review`; `readStoreStripeAccount` shared with payments/status. |
| 2026-11-12 | P.3 done: `POST /merchant/create-store` (self-serve FREE draft, caller becomes ADMIN in the same transaction; 5-draft cap, 5/hour, 409 `SLUG_TAKEN` / `DRAFT_LIMIT_REACHED`). 8.2 join requests marked superseded. |
| 2026-11-12 | P.1 + P.2 done: plan catalogue (`layers/core/plans`); `lifecycle` (DRAFT / IN_REVIEW / LIVE + plan) on SETTINGS, old stores read as LIVE on FREE; `admin.isStoreLive` → `admin.suspended`; not-live storefront is a "Coming soon" body, item/quote/contact 404 `STORE_NOT_LIVE`. |
| 2026-11-12 | Stage P planned (§6a) with the owner: plans per store (FREE / SPARK $25 CAD·AUD, $19 USD / NOVA $49 CAD·AUD, $39 USD), one live FREE store per account, plan commissions, FREE 30 orders/month with 7 days' grace, self-serve store creation, Go Live with `runSmartStoreValidation` (AI fraud check, **TODO: empty stub for now**), Stripe Billing on the platform account, admin commission override kept. Payments online only: no pay at pickup. |
| 2026-11-12 | 5.1b done: percentage commission. `admin.commissionMode` (`FIXED`/`PERCENT`) and `commissionPercentBps` (0–3,000); PERCENT = share of items after discounts, no tax or delivery, half up, at least the per-currency `salesCommissions`; `platformFeeMinor(admin, quote)`; 5.4c must snapshot the commission onto the order. Settles the open "percentage vs fixed" question: admins pick per store. |
| 2026-11-11 | 5.2b: payments status adds `canManage`, `pastDue`, `pendingVerification`, `deadline`; `requirementsDue` counts currently_due ∪ past_due once (from the sandbox onboarding test). |
| 2026-11-11 | Note for 5.4c (from the sandbox onboarding test): never enable Stripe `automatic_tax` in checkout; Ceseelia charges the quote's tax. Merchants can opt in to Stripe Tax during onboarding, so enabling it would double-tax shoppers. |
| 2026-11-11 | 5.2 done: `create-connect-account-link` and `status` under `/store/payments`; Standard accounts in CA/US/AU; `payments` attribute on SETTINGS (private; public gets `paymentsEnabled`); Stripe keys read from Secrets Manager (`STRIPE_SECRET_ID`), live key refused in dev, prod won't start without one. Sandbox smoke test passed. |
| 2026-11-11 | 5.1 decided: Stripe Connect **Standard** (direct charges, Connect webhook endpoint). 5.1a done: `admin.salesCommission` (flat, no currency) is now `admin.salesCommissions` (cents per currency, default 125 each); old values are converted when read (`normalizeAdminSettings`); `platformFeeMinor` for 5.4c. Next: 5.2. |
| 2026-11-11 | QA done for now; next is Stage 5. Decided: the platform commission is taken from the merchant (`application_fee_amount`) and never shown to shoppers (5.1 note); commission model (percentage vs fixed) still open. |
| 2026-11-11 | QA Q.23 (webapp): `POST /customer/quote` no longer takes `postalCode`. A Canada delivery is taxed for the province the shopper's IP is in (`resolveCaProvinceFromGeo`), else the store's, and `taxRegion.estimated` is true; `POSTAL_CODE_REQUIRED` is gone. `priceLines` still takes `postalCode` (it wins, `estimated: false`) for checkout. **Stage 5 must tax the order on its delivery address, not on the estimate.** |
| 2026-11-11 | QA Q.21 (webapp): storefront and item responses are `private, no-cache` (was `max-age=30`), so an open storefront's quiet reload sees a disabled item or new discount at once (304 when nothing changed). |
| 2026-11-11 | 2.7 done: stock and price per option combination (`storeItemVariants`); item stock/prices worked out from the rows on save; public data and the quote use the picked combination (`OPTION_UNAVAILABLE`). |
| 2026-11-15 | §0: B4 done (prod stack deployed with backups, alarms and webapp hosting). |
| 2026-11-15 | §0: B8 and D2 checked done; AI store check eval 60/60 on dev (≈ $0.34); dev webapp deployed to dev.ceseelia.com. |
| 2026-11-15 | §0: owner finished A1–A4, B1, B2 (push, password, old secret, Claude API key in `ceseelia/dev`, ALARM_EMAIL, L.4 merged to dev). |
| 2026-11-15 | §0 Owner to-do added: every manual step in one ordered list (same in both repos). |
| 2026-11-15 | L.9: link previews (`GET /store/public/preview/:slug[/:itemId]`, Open Graph HTML for bots); webapp S3 + CloudFront in the CloudFormation template (branch `dev_v1.0.0_l9_webapp_cloudfront`, not deployed); `iam/` AdminDeleteUser. |
| 2026-11-15 | L.9 (part): admin menu badges (`/admin/queue-counts`); `get-all-stores` pages, searches and reads only the page's SETTINGS fields; account delete (`delete-user`) with only-member and admin guards. |
| 2026-11-15 | L.8: real admin overview (stores, merchants, 30-day orders / sales / commission, chart, top stores, to-do counts); support tickets for users and admins with email notices (no message text in email); monthly commission report per store with a Stripe check and CSV. |
| 2026-11-15 | L.7 / 7.2–7.4: rewards: emailed 6-digit code (hashed, 5 guesses, per-email limits in the table, per-IP limits), 30-day per-store sessions; earn once per paid order, refunds take back their share; one reward per order off the items before tax (commission on the price after it), spent in the order's own transaction, given back once if never paid or fully refunded; one spelling for the redemption method plus a migration script. |
| 2026-11-15 | L.7 / 7.5: verified-buyer reviews (live at once), store replies and reports, admin keep/remove; public reviews + rating. |
| 2026-11-15 | L.7 / 7.1: customer records from paid orders (exactly once, refunds both ways) + `GET /store/customers/list/:storeId`; backfill script. |
| 2026-11-15 | L.6 / 1.5: `GET /store/overview/:storeId?tz=` (Store Overview numbers in the merchant's time zone; `layers/core/store-stats`). |
| 2026-11-15 | L.5 / 6.7: new-order alert rows + `GET /store/orders/new/:storeId` for the dashboard; Web Push (VAPID) to members' browsers with an allow-list of push services; `/user/push/*`; `scripts/setup-vapid.mjs`; Stripe event rows get the table's `ttl`. |
| 2026-11-15 | L.4 9.4–9.6: backend CI (lint, typecheck, test, audit, build, image + /healthz); CloudFormation: PITR + deletion protection on the table (was off in prod), versioned buckets, pool deletion protection, `Retain`s, trigger on nodejs22.x with least privilege, API log group + error metric, SNS alarms (API errors, DynamoDB, sign-up trigger, SES reputation), cfn-lint before deploy; compose ships API logs to CloudWatch and caps nginx's. |
| 2026-11-15 | L.4 9.1 + 9.2: pino logs (request ids, PII redacted, safe error serializer, route 500s logged in prod too), per-IP API limits (300/min, public reads 120/min), JSON body 100 KB (256 KB for item/settings saves), JSON 413/400; nginx passes `X-Request-Id`, 1 MB body cap, Go Live 120 s timeout (was cut off at 60 s). |
| 2026-11-15 | L.2 AI store check (code): rule checks + Claude Opus 5.5 over all item text and ≤ 50 photos picked by risk; Go Live 90 s deadline, fails closed to review, 5/store/day, admin email; live stores' new or changed items checked in the background, flagged ones hidden and queued for admins (`get-item-review-queue`, `review-item`); eval set of 60 stores in `scripts/store-check-eval`. Needs `anthropicApiKey` and an eval run before launch. |
| 2026-11-09 | QA Q.16 (WA): `storeInfo.showEmail` / `showPhone` (optional, missing = shown). When false, `toPublicSettings` blanks that detail in every public response (storefront and item link); `contactFormAvailable` (public only, worked out from the stored email, never saved) keeps Contact us offered; contact-store still emails the real address. |
| 2026-11-09 | 4.4 done: Canadian sales tax by province (`taxMode: CANADA`): pickup in the store's province, delivery by the shopper's postal code; GST/HST/PST/RST/QST lines in the quote. |
| 2026-11-09 | 4.2 done: tax rate (added or included), pickup/delivery with a flat fee per currency, in settings and in the quote. |
| 2026-11-09 | 4.3 done: `POST /customer/quote` (public, 60/IP/min, ≤ 50 lines) prices a cart with `priceLines` on the store's public data. |
| 2026-11-09 | 4.1 done: pure `priceLines` (biggest discount wins, per-line half-up rounding, param/stock/currency checks with per-line errors). |
| 2026-11-09 | 3.2a/3.3/3.4 done: cache headers (+ immutable images), `GET /store/public/item/:storeId/:itemId`, `POST /customer/contact-store` (honeypot, rate limits, Reply-To). |
| 2026-11-09 | 3.1 done: `GET /store/public/storefront/:slug` (slug lookup + public data, with `storeId`); the shopper's currency is the default only if the store offers it. |
| 2026-11-09 | 2.6 done: stock rule named (`STOCK_UNLIMITED = -1`, 0 = sold out) with `hasStockFor` for 4.1/5.5; webapp storefront no longer hides unlimited items. |
| 2026-11-09 | 2.5 done: item prices are `storeItemPrices` (whole cents per currency, set by the merchant, no conversion); public data shows only offered currencies; migration script run on dev. |
| 2026-11-09 | 2.4 done: public storefront data shows only active items in active categories (counts match), 404 `STORE_NOT_FOUND` / `STORE_UNAVAILABLE` for unknown or suspended stores. |
| 2026-11-09 | 2.3 done: image uploads are presigned POSTs (png/jpg, ≤ 5 MB, 1–10 per request, item/category must exist), tagged pending until saved; bucket allows POST and expires unsaved uploads after a day. |
| 2026-11-09 | 2.2 done: category delete refused with 409 `CATEGORY_NOT_EMPTY` while it has items (conditional delete on the count); banner deleted after the row. |
| 2026-11-09 | 2.1 done: category item counts kept by item create/move/delete transactions (no more reset on save); delete-item removes the row before its images; recount script (dev fixed). |
| 2026-11-09 | WA 1.6 support: `update-profile` trims names and caps them at 50 (`MAX_LENGTH.personName`, same in the webapp). |
| 2026-11-09 | 1.8 done: slug format rule, `SLUG#<slug>` reservations (create/rename in one transaction, 409 on clash, freed on delete), public `resolve-slug`, backfill script (dev backfilled). |
| 2026-11-09 | §1 status table and health check refreshed; "Pick up here" note added (next: BE 1.8, WA 1.6). |
| 2026-11-09 | 1.7 done: `DELETE /store/delete/:storeId` deletes the whole store, retry-safe; S3 batch delete fixed (1000-key limit, partial failures). |
| 2026-11-09 | 1.6 done: admin-only store settings routes; `admin` block hidden from merchants and the public storefront (it was public). |
| 2026-11-09 | 1.4 done: admin member routes (list, assign by email or invite, remove, cancel invite); invites claimed on first profile load. |
| 2026-11-08 | 1.3 done: store-member check on every `/store/**` route (admin bypass); S.0 lockdown removed. |
| 2026-11-08 | 1.2 done: membership rows (`STORE#…/MEMBER#…` + `USER#…/STORE#…`) and helpers; `get-my-profile` returns `stores`. |
| 2026-11-08 | 1.1d–f done: `get-my-profile` creates missing user rows from the user pool (verified email only); 404 `PROFILE_NOT_FOUND`, 403 `ACCOUNT_DEACTIVATED`. |
| 2026-11-08 | Registration found in `ceseelia_cloudformation` (PostConfirmation Lambda): 1.1a/b settled; S.1b (key revoked) confirmed by the owner. |
| 2026-11-08 | S.13 done: client IP from trusted proxy hops only (`TRUST_PROXY_HOPS`, default 1). |
| 2026-11-08 | S.12 done: identity moved to `res.locals.auth` / `getAuth(res)`; old identity keys stripped from bodies; token not kept. |
| 2026-11-08 | S.10 + S.11 done: profile locale allow-list (`en`, `id`); `delete-user` disabled (501) until after 1.2. |
| 2026-11-08 | S.9 done: lengths, ranges, list caps, own-store image keys, formats, currencies, customize checks (limits match WA S.15). |
| 2026-11-08 | S.8 done: `getStoreInventoryData` follows every page. |
| 2026-11-08 | S.7 done: batch helpers retry unprocessed items and throw on failure; reads return every batch. |
| 2026-11-08 | S.6 done: category/item image cleanup runs only after a successful write. |
| 2026-11-08 | S.5 done: no blind upserts (conditional writes, store-exists check on create, 404s). |
| 2026-11-08 | S.4 done: `isUlid` on every store/category/item ID; tests can't reach real AWS. |
| 2026-11-08 | S.3 done: unused deps removed, `npm audit fix`, `geoip-lite` 2, Docker image on Node 24 (53 → 10 moderate dev-only advisories). |
| 2026-11-08 | S.1a done: hard-coded Google Maps key and its unused helpers removed (revoking the key is still manual). |
| 2026-11-08 | S.0 done: all authenticated `/store/**` routes are admin-only; 27 route-access tests added. |
| 2026-11-08 | File created from a full code review. Added Stage S (security and bug fixes) and broke stages 1–9 into sub-tasks. |
| 2026-11-02 | Stage 0 completed (see `CLAUDE.md`). |
