# Ceseelia Backend — Progress Tracker

_Last reviewed: 2026-11-08 (full codebase read-through) · Last updated: 2026-11-13_

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

## 1. Where things stand

> **▶ Start the next session here (2026-11-11).** The owner's QA pass is done for now
> (`../ceseelia_webapp/progress.md` §1a: Q.1–Q.26 all fixed).
> Backend fixes from QA: Q.16 (hide email/phone), Q.21 (`private, no-cache`), Q.23 (Canadian
> delivery tax estimated from geo-IP, no postal code in the quote). **Stage 5 started:** 5.1 is
> decided (Stripe Connect **Standard**, direct charges; commission is a fixed amount per order in
> each currency, `admin.salesCommissions`) and 5.1a is done. 5.1b (2026-11-12) adds a per-store
> `PERCENT` mode (see §7). 5.2 (onboarding routes, keys in
> Secrets Manager) is done, and so is WA 5.4 (Payments card); onboarding was tested end to end
> in the Stripe sandbox. **Next: Stage P** (§6a, plans SPARK/NOVA (FREE dropped 2026-11-13, P.10), self-serve stores, Go
> Live with `runSmartStoreValidation`, a TODO stub for now), then 5.3. Payments are online only
> (no pay at pickup, owner 2026-11-12).
> Both repos are on `dev_v1.0.0_customer_store_front`, pushed to origin.

> **2026-11-13: no Free plan any more (P.10).** Only Spark and Nova. A new store is a draft with
> no plan (`plan: "NONE"`), visible to its members only; going live and subscribing are one step
> (Go Live → Stripe Checkout → the webhook takes it live). Merchants switch Spark ↔ Nova in the
> billing portal; when a plan ends (cancelled at the period's end, or a failed payment after the
> 7 days' grace) the store goes back to a DRAFT with `pausedReason: "PLAN_ENDED"`. P.7 (Free
> order limit) is dropped. `scripts/migrate-free-plan.mjs --write` was run on dev (2026-11-13:
> the 4 dev stores are now drafts with no plan).
>
> **Pick up here (2026-11-12):** Stages S, 0–4 and **Stage P (P.1–P.6, P.8, P.10, P.11)** are done in both
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
| Security & bug fixes (Stage S) | ✅ Mostly | S.0–S.13 done; S.2 manual; S.14–S.17 deferred to before launch |
| Users / registration | ✅ Works | CloudFormation `OnUserRegister` Lambda creates users; `get-my-profile` fills in missing rows (1.1) |
| Store membership + access | ✅ Works | Members/invites (1.2, 1.4); every `/store/**` route checks membership, admins bypass (1.3) |
| Store create / settings / images | ✅ Works | Admin-only settings via `/admin/*-store-admin-settings` (1.6) |
| Store delete | ✅ Works | Whole store incl. members, invites, slug, S3; retry-safe (1.7, 1.8) |
| Slugs | ✅ Works | Format rule, unique via `SLUG#<slug>` reservations (409 on clash), public `resolve-slug` (1.8) |
| Categories & items CRUD | ✅ Works | Item counts kept by item writes (2.1); a category with items can't be deleted (409, 2.2) |
| Public storefront data | ✅ Works | Only active items in active categories; 404 `STORE_NOT_FOUND` / `STORE_UNAVAILABLE` (2.4); no admin block (1.6) |
| Merchant / customer APIs | ❌ Missing | `/merchant/path` stub (1.5 deferred) |
| Cart, checkout, orders, payments | ❌ Not started | Stripe webhook returns 501 |
| Admin stats, join requests, tickets | ❌ Not started | |
| Production readiness (logging, rate limits, CI, IaC) | ❌ Not started | Prod EC2 role will need `cognito-idp:AdminGetUser`, `ses:SendEmail` and `s3:DeleteObjectTagging`; SES production access for contact-store; contact-store's in-memory rate limits need a shared store with >1 instance |

**Health check (2026-11-11):** `npm test` 622/622 passing · `npm run typecheck` clean ·
`npm run lint` 0 errors, 79 warnings · `npm audit --omit=dev` 0 vulnerabilities.

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
- [ ] 🔴 **S.2 Rotate the old password** that used to be in `node/README.md`. It's still in git
      history (manual step, carried over from Stage 0).
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
- [ ] 🟡 **S.14 Security headers:** add `helmet`. In nginx, add `server_tokens off`, HSTS,
      `ssl_protocols TLSv1.2 TLSv1.3`, and pin `nginx:<version>` in compose.
- [ ] 🟡 **S.15 Harden the Docker image:** `npm ci --omit=dev`, run as the non-root `node` user,
      and add a `HEALTHCHECK` once 9.3 exists.
- [ ] ⚪ **S.16 Quarantine legacy code** (from DinersXpress / PrimeFaya):
  - [ ] a. `cognito.signIn` passes the decoded token to `isUserAdmin` (wrong argument), and
        `processAuthCode` trusts an unverified decode. Delete both or fix them before any use.
  - [ ] b. `layers/stripe` hard-codes `order.dinersxpress.com` URLs and per-merchant secret keys.
        Mark it "do not use" until Stage 5 rewrites it.
  - [ ] c. Remove PrimeFaya constants (`secrets.primefaya.com`, PayPal links, logo URLs) and
        `getAndroidEnterpriseServiceAccount`.
  - [ ] d. Remove the duplicate `intervalInMs` check in `registerTimer`.
- [ ] ⚪ **S.17 Ops scripts:** fix the `certbot-renew.sh` paths (`/home/ec2-user/primedine/...`).
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
- [ ] Replace the `/merchant/path` stub with `GET /merchant/get-overview-data`: the merchant's
      stores plus headline counters from `StoreOverview`. (WA 1.2)

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
- [ ] 3.2 Cache headers (`Cache-Control`, `ETag`) on public endpoints, and CloudFront in front of
      the API's public paths and the storage bucket.
  - [x] a. Headers. _Done 2026-11-09, tested by hand. `layers/core/http/cache.ts`:
        storefront (both routes) and item → `private, no-cache` (was `max-age=30` until QA Q.21, 2026-11-11; the body varies by shopper:
        geo-IP default currency, so a shared cache must not keep one copy); slug lookup →
        `public, max-age=300`; every public error and contact-store → `no-store`. Express's weak
        ETag + 304 already worked (now tested; checked live). Uploaded images get
        `public, max-age=31536000, immutable`, pinned in the presigned POST (keys are unique per
        upload; the webapp sends the slot's fields as is)._
  - [ ] b. CloudFront (infra, `ceseelia_cloudformation`) for the storage bucket and the slug
        lookup. The storefront and item responses can only be shared-cached once the shopper's
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
    instance the limits need a shared store (9.2). SES sandbox: only verified recipients get
    mail until production access is granted._

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
  - [ ] **Follow-ups:** order creation (5.4) must re-quote with the **delivery address's** postal
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
| SPARK | 25 / 25 / 19 | 1.95 / 1.95 / 1.45 | Unlimited | Yes ("coming soon" until 9.8) |
| NOVA | 49 / 49 / 39 | none | Unlimited | Yes ("coming soon" until 9.8) |

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
- [ ] P.4 Go Live (a and b done 2026-11-12; c's AI check is still the owner's TODO):
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
  - [ ] c. **`runSmartStoreValidation({storeId, data})`** in `layers/core/store-validation`
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
       `billingWebhookSecret`.
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
- [ ] P.9 Custom domains: listed on SPARK / NOVA as "coming soon" at launch; built in 9.8.
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
  - [x] d. Keys in AWS Secrets Manager (`ceseelia/dev/stripe`, sandbox "Ceseelia sandbox");
        `layers/payments/stripe.ts`. Smoke-tested against the sandbox (create, link, delete).
  - [ ] f. Local dev: set `WEBAPP_URL` in `node/.env` to the address the webapp is opened at
        (e.g. `http://192.168.1.107:4200`), or Stripe's return links go to `localhost:4200`.
  - [ ] e. Prod: create `ceseelia/prod/stripe` with a **restricted** live key (`rk_live_…`,
        IP-allowlisted) and give the EC2 instance role `secretsmanager:GetSecretValue` on that
        secret only. Before launch (Stage 9).
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
    `charge.refunded`, `charge.dispute.created`, `charge.dispute.updated`,
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
- [ ] 5.7 Sweeper for abandoned `PENDING_PAYMENT` orders (`registerTimer` +
      `SERVER_WATCH_CHECK_FOR_LOST_ORDERS_INTERVAL`).

---

## 8. Stage 6 — Order management & notifications

- [ ] 6.1 `GET /store/orders/list/:storeId` (paginated, filter by status/date). (WA 6.1)
- [ ] 6.2 `GET /store/orders/get/:storeId/:orderId`. (WA 6.2)
- [ ] 6.3 `PUT /store/orders/update-status`, enforcing allowed transitions. (WA 6.2)
- [ ] 6.4 `POST /store/orders/refund` (full/partial, via Stripe). (WA 6.3)
- [ ] 6.5 Emails (SES + pdf invoice): customer confirmation/receipt, merchant new-order alert,
      status-change emails.
- [x] 6.6 `GET /customer/order-status/:orderId` (done 2026-11-13, early, for WA 5.2's return
      page): the status token in header `X-Order-Token` (not the URL); a wrong token = unknown
      order = 404 `ORDER_NOT_FOUND`; shopper view only (no Stripe ids, fee, commission, hash);
      60/IP/min. The token doesn't expire (it's the shopper's receipt link); revisit with 6.5.
- [ ] 6.7 Optional FCM push to the merchant. (WA 6.4)

---

## 9. Stage 7 — Customers, rewards & reviews

- [ ] 7.1 Customer records per store, built from orders, plus `GET /store/customers/list/:storeId`.
      (WA 7.1)
- [ ] 7.2 Optional customer accounts (a separate Cognito app client or pool).
- [ ] 7.3 Unify the rewards redemption constant (`POINTS_TO_*` vs `REWARDS_REDEMPTION_*`) with a
      data migration, then drop the dual acceptance in the validator.
- [ ] 7.4 Rewards: earn on paid orders, redeem inside the quote. (WA 7.2)
- [ ] 7.5 Reviews: `POST /customer/review` (completed orders only, token-gated), moderation,
      `GET /store/reviews/list/:storeId`. (WA 7.3)

---

## 10. Stage 8 — Admin console & support

- [ ] 8.1 Fill in the real admin overview (`quickStats`, `salesActivity`, store counts). Today
      they're empty objects. (WA 8.1)
- [ ] 8.2 Merchant join requests (**superseded by P.3**, 2026-11-12: anyone can create a store;
      checks happen at Go Live. Keep only if the owner still wants an application form):
  - [ ] a. Public `POST /merchant/join-request` (rate-limited, bot check)
  - [ ] b. Admin list, approve and deny
  - [ ] c. Approval creates the store and membership (1.4)
  - [ ] d. Fix the `joinRequestt…` field typo before the first write. (WA 8.2)
- [ ] 8.3 Support tickets: merchant create/list/reply, admin list/reply/close, SES notices. (WA 8.3)
- [ ] 8.4 Commission reporting per store, from Stripe application fees. (WA 8.4)

---

## 11. Stage 9 — Production readiness

- [ ] 9.1 Structured logging (pino) with request ids, and no PII or tokens in logs. Replace the
      `console.warn` request logger and the `console.error(e)` calls in routes.
- [ ] 9.2 `express-rate-limit` on public and auth-sensitive routes (needs S.13). Lower the JSON
      body limit per route where 1 MB isn't needed.
- [ ] 9.3 `GET /health` endpoint, graceful shutdown (SIGTERM), docker/nginx health checks.
- [ ] 9.4 CI (GitHub Actions): lint, typecheck, test, `npm audit --omit=dev`, build image.
- [ ] 9.5 IaC (CDK/Terraform): table and GSIs, buckets (private, CloudFront OAC, CORS), Cognito
      plus triggers, IAM least-privilege instance role.
- [ ] 9.6 DynamoDB PITR backups, S3 versioning/lifecycle, CloudWatch alarms.
- [ ] 9.7 Bring lint warnings (109) down to zero, then make warnings fail CI.
- [ ] 9.8 Optional: custom store domains via `layers/aws/route53`.

---

## 12. Changelog

| Date | Change |
|---|---|
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
