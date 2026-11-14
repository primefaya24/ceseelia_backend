# CLAUDE.md — Ceseelia Backend

Ceseelia is a multi-tenant ecommerce platform: an **admin** creates stores, **merchants** manage
a store's inventory and storefront, and **customers** browse a public storefront and (eventually)
order and pay. This repo is the REST API. The Angular frontend lives in
`../ceseelia_webapp` (see its `CLAUDE.md`). Both files share the same stage numbering — work on a
stage usually touches both repos.

---

## 1. Stack & layout

- Node 24, TypeScript (CommonJS, `strict`), Express 5
- AWS: DynamoDB (single table), Cognito (auth), S3 (images via presigned URLs), SES (email),
  Secrets Manager, Route53; Stripe SDK installed but not wired up
- Deployed as Docker containers on EC2: `node` (port 3100) behind `nginx` (TLS via certbot)
- **Infrastructure lives in `../ceseelia_cloudformation`** (AWS SAM, stacks `ceseelia-dev` /
  `ceseelia-prod`): the Cognito user pool and client, the `ceseelia_<stage>` table and its GSIs
  (`CognitoIdentifierGSI` ALL, `UserEmailGSI` KEYS_ONLY), the `ceseelia-storage-<stage>` bucket,
  and the **`OnUserRegister` Cognito PostConfirmation Lambda, which creates every user's DB
  records** (`USER#<ulid>` with `PROFILE#INFO`, `PROFILE#COGNITO_DATA#<sub>`,
  `PROFILE#NOTIFICATION_SETTINGS`). The backend only reads and updates those rows; keep key
  names, attribute names and GSI names in step with that repo. The `Admins` Cognito group (used by
  `isUserAdmin`) isn't in the template; it was created by hand.

```
ceseelia_backend/
├── docker-compose.yml, nginx/nginx.conf      # prod runtime (node + nginx + certbot)
├── *.sh / *.ps1                              # EC2 ops scripts (certs, swap, scp image, reboot)
└── node/
    ├── index.ts           # starts the server (listen only)
    ├── app.ts             # createApp(): CORS, Stripe webhook stub, JSON body, host routing
    ├── middleware.ts      # host-based router + request logger (only ALLOWED_API_HOSTS reach the API)
    ├── tests/             # vitest specs
    ├── config/index.ts    # env-driven config (STAGE, hosts, CORS, Cognito, table/bucket)
    ├── constants/index.ts # appConstants (entity names, HTTP codes, limits, etc.); input-limits.ts, slug.ts
    ├── scripts/           # one-off maintenance scripts (slug backfill, category item recount, item price migration, Free plan migration)
    ├── api/v1/<area>/<route>/index.ts   # one file per endpoint
    └── layers/
        ├── core/http      # validateAndExecuteHttpApiRoute (auth + validation wrapper)
        ├── core/interfaces/store   # StoreOverview, StoreSettings, StoreCategory, StoreItem, StoreOrder…
        ├── core/utils     # misc helpers, S3 cleanup, geo-IP currency, PDF invoice, DQS
        ├── aws/dynamodb/dynamo-entities/{store,admin,user,membership,slug}   # data access
        ├── aws/dynamodb/{dynamo-batch-ops,dynamo-query}   # batch read/write with retries; paged queries
        ├── aws/{cognito,s3,ses,sqs,route53,secret-manager}
        └── stripe         # generateStripeCheckoutLink (legacy, from a previous project)
```

Note: much of `layers/` (user entity, cognito, stripe, pdf, ses templates, DQS stripe handler,
`websiteId` naming) was carried over from earlier projects (DinersXpress / PrimeFaya). Treat it as
a toolbox — reuse, but verify before relying on it.

## 2. Commands

```bash
cd node
cp .env.example .env   # first time only; never commit .env
npm install
npm run dev        # tsc --watch + nodemon dist/index.js  (http://0.0.0.0:3100)
npm run build      # tsc -> dist/
npm start          # node dist/index.js
npm test           # vitest (tests/*.test.ts, AWS mocked with aws-sdk-client-mock)
npm run lint       # eslint (0 errors required; legacy warnings tolerated)
npm run typecheck  # tsc --noEmit
```

Config comes from env vars (see `node/.env.example`): `STAGE` (dev|prod), `ALLOWED_API_HOSTS`,
`CORS_ORIGINS` (required in prod), `WEBAPP_URL` (links in emails), plus optional overrides for
table/bucket/Cognito ids. The
server refuses to start in prod if required vars are missing.

Deploy: build locally, build the Docker image from `node/` (it copies the prebuilt `dist/`), ship
with `scp-docker-image.sh`, then `docker compose up -d` on the server. Compose loads
`node/.env` into the container (`STAGE=prod` there). No CI yet (Stage 9.4).

## 3. Conventions (follow these when adding endpoints)

Every endpoint is its own folder exporting `export default function registerRoute(router)`; the
parent router's `index.ts` imports it and calls it (`route_create(storeRouter)`). Copy
`api/z_fresh_route/` as a template.

```ts
export default function registerRoute(router: Router): void {
  router.post('/create', (req, res) => {
    validateAndExecuteHttpApiRoute(req, res, pureRequestParams, validRequestParams, executeRouteCore,
      /* withAuth */ true, /* access */ storeMember((req) => req.body.storeId));
  });
}
// access: false = any signed-in user · true = admins only
//         storeMember(getStoreId, role?) = admins, or members of that store (min role optional)
// order: auth (401) -> access (403; 400 if the store id isn't a ULID) -> pureRequestParams (400)
//        -> validRequestParams (400) -> core
// After a store check, getAuth(res) also has `userId` and `storeRole` (not for admins).
// pureRequestParams  -> type checks only   ("Bad request parameters"); a throwing check = failed check
// validRequestParams -> value checks       ("Invalid request parameters")
// executeRouteCore   -> try/catch, 500 on error; the wrapper also catches anything that escapes
```

- Auth: `Authorization: Bearer <Cognito access token>` (bare token also accepted). The token's
  signature, issuer, expiry and `client_id` are always verified (dev included). The wrapper then
  puts the verified identity in `res.locals.auth`; routes read it with `getAuth(res)`
  (`{cognitoId, groups, isAdmin}`, admin = group `Admins`). Never read identity from `req.body`:
  the wrapper strips the old `cognito_id` / `is_user_admin` keys from every body.
- IDs in paths and bodies are checked with `isUlid`. Value limits live in
  `constants/input-limits.ts` (same numbers as the webapp's `input-limits.constants.ts`).
- The Express app is built in `app.ts` (`createApp()`, used by tests); `index.ts` only listens.
- Add a test in `node/tests/` for any new validator or wrapper behaviour.
- DynamoDB single table `ceseelia_<stage>` with `pk`/`sk`:
  | Entity | pk | sk |
  |---|---|---|
  | Store overview (admin list) | `APP_STORE` | `STORE#<storeId>#OVERVIEW` |
  | Store settings | `STORE#<storeId>` | `SETTINGS` (own attributes `payments` (5.2), `lifecycle` (P.2), `review` (P.4), `subscription` and `billingCheckout` (P.5): only their own code writes them) |
  | Billing customer | `USER#<userId>` | `BILLING#<CURRENCY>` (`stripeCustomerId`; P.5) |
  | Stores in payment grace | `APP_BILLING_GRACE` | `STORE#<storeId>` (`graceEndsAt`; the hourly sweep's list, P.5) |
  | Review queue | `APP_REVIEW` | `STORE#<storeId>` (one row per store IN_REVIEW, written with it by Go Live; removed by the decision, P.8) |
  | Category | `STORE#<storeId>` | `CATEGORY#<categoryId>` |
  | Item | `STORE#<storeId>` | `ITEM#<itemId>` |
  | User profile | `USER#<uuid>` | `PROFILE#INFO`, `PROFILE#COGNITO_DATA#<cognitoId>`, `PROFILE#NOTIFICATION_SETTINGS` (written by the CloudFormation sign-up Lambda) |
  | Store member | `STORE#<storeId>` | `MEMBER#<userId>` (role `ADMIN`/`MERCHANT`) |
  | User's store (reverse) | `USER#<userId>` | `STORE#<storeId>` (same role; written with the member row in one transaction) |
  | Store invite | `STORE#<storeId>` | `INVITE#<email>` (pending, for an email with no account) |
  | Slug reservation | `SLUG#<slug>` | `STORE` (`storeId`; written/freed only in the store create, rename and delete paths; format rule in `constants/slug.ts`) |
  | Invite by email (reverse) | `INVITE#<email>` | `STORE#<storeId>` (found and claimed on that user's first `get-my-profile`) |
  | (planned) Order | `STORE#<storeId>` | `ORDER#<createdAt>#<orderId>` (see `StoreOrder` interface) |
  GSIs used by user code: `CognitoIdentifierGSI`, `UserEmailGSI`.
- S3 keys: `store/<storeId>/images/{logo,header,promo}/<ulid>.<ext>`,
  `store/<storeId>/category/<categoryId>/…`, `store/<storeId>/item/<itemId>/…`. Uploads are
  presigned POSTs from `layers/aws/s3/image-upload.ts` (png/jpg, ≤ 5 MB, key and type pinned,
  tagged `ceseelia-upload=pending`; the bucket expires pending objects after a day). Any route
  that saves image keys must call `markImagesKept(keys)` **before** its DB write; after the
  write, `cleanUpS3Folder(prefix, keepUris)` deletes files the record no longer uses.
- IDs are ULIDs. Field names are prefixed (`storeItem…`, `storeCategory…`). Note the existing
  typo `storeCategoriy…` (Id, Priority, Hashtags) — it is persisted data, keep it consistent
  unless doing a deliberate migration.
- When you change a shared interface in `layers/core/interfaces/store`, mirror it in
  `ceseelia_webapp/src/app/core/interfaces/core/store.interface.ts`.

## 4. What is implemented

| Area | Endpoint | Status |
|---|---|---|
| Store | `POST /store/create` (admin) | ✅ creates overview + default settings + slug reservation in one transaction; 409 if the slug is taken |
| Store | `DELETE /store/delete/:storeId` (admin) | ✅ deletes SETTINGS first (blocks writes), then the `STORE#id` partition and the members'/invites' reverse rows, `store/<id>/` in S3, the slug reservation, and the overview last; safe to retry; 404 when nothing is left |
| Store | `PUT /store/update-settings` | ✅ validates, saves (awaited), then cleans logo/header/promo S3 leaks (never writes the `admin` block) |
| Store | `GET /store/get-logo-upload-url/:storeId/:imageType` | ✅ `{key, url, fields}` presigned POST (all upload routes: png/jpg/jpeg, ≤ 5 MB) |
| Store | `GET /store/get-header-strip-image-upload-url/:storeId/:imageType` | ✅ |
| Store | `GET /store/get-promo-image-upload-urls/:storeId/:pngCount/:jpgCount` | ✅ `{png: [...], jpg: [...]}`, 1–10 in total |
| Category | `POST /store/category/create` (create + update via `isUpdate`) | ✅ |
| Category | `DELETE /store/category/delete/:storeId/:storeCategoryId` | ✅ only when the category has no items, else 409 `CATEGORY_NOT_EMPTY` `{message, itemCount}`; then deletes its banner |
| Category | `GET /store/category/get-banner-upload-url/:storeId/:categoryId/:imageType` | ✅ 404 unless the category exists |
| Inventory | `POST /store/inventory/create-item` (create + update) | ✅ keeps `storeCategoryItemCount` in the same transaction (+1 on create, +1/−1 on a move); 404 if the category is missing; prices are `storeItemPrices` in whole cents per currency (2.5); variants (2.7): `storeItemVariants` = one row per combination of the single-choice params' options (stock, prices, sold), item stock/prices worked out from them by `withVariantTotals` (`layers/core/variants`) |
| Inventory | `DELETE /store/inventory/delete-item/:storeId/:storeItemId` | ✅ −1 on its category, then deletes its images |
| Inventory | `GET /store/inventory/get-data/:storeId` (auth) | ✅ categories + items + settings |
| Inventory | `GET /store/inventory/get-data-public/:storeId` (no auth) | ✅ active items in active categories only (counts match), no admin block, `storeId`, geo-IP default currency if the store offers it; 404 `STORE_NOT_FOUND` / `STORE_UNAVAILABLE` (suspended); a DRAFT / IN_REVIEW store is a 200 "Coming soon" body (`settings.storeStatus`, name and look only, no items; P.2), and its item links, quotes and Contact us are 404 `STORE_NOT_LIVE` |
| Inventory | `GET /store/inventory/get-item-image-upload-urls/:storeId/:itemId/:pngCount/:jpgCount` | ✅ 1–10 in total; 404 unless the item exists |
| Admin | `GET /admin/get-all-stores`, `GET /admin/get-overview-data` | ✅ (overview only fills `allStores`; stats are empty objects) |
| Admin | `POST /admin/update-store-info` (name/slug; 409 if the slug is taken) | ✅ |
| Admin (P.8) | `GET /admin/get-review-queue`, `POST /admin/review-store` `{storeId, decision: APPROVE\|REJECT, message?}`, `PUT /admin/set-store-plan` `{storeId, plan}` | ✅ approve → DRAFT approved (next Go Live skips the check, goes to checkout); reject → DRAFT with the reason; conditional on IN_REVIEW (409 `STATUS_CHANGED`). Set plan `SPARK\|NOVA\|NONE` = a plan with no subscription (`planSetByAdmin`, no checkout at Go Live), NONE takes it away (a live store → DRAFT), 409 `HAS_SUBSCRIPTION`. `get-all-stores` adds status / plan / billing per store |
| Public | `GET /store/public/resolve-slug/:slug` → `{storeId}` (404 if unknown) | ✅ |
| Public | `GET /store/public/storefront/:slug` → `{storeId, settings, categories, items}` (no auth) | ✅ same body as `get-data-public` (`sendPublicStorefront`); 400 bad slug, 404 `STORE_NOT_FOUND` / `STORE_UNAVAILABLE` (3.1); `Cache-Control: private, no-cache` (3.2; revalidated by ETag every time since QA Q.21) |
| Public | `GET /store/public/item/:storeId/:itemId` → `{storeId, item, category, currencies}` (no auth) | ✅ storefront rules; 404 `ITEM_NOT_FOUND` for missing or hidden (3.3) |
| Customer | `POST /customer/quote` `{storeId, currency, fulfilment?, lines:[{itemId, quantity, params?}]}` (no auth) | ✅ always 200 with `priceLines`' quote (per-line errors, delivery, tax parts in `taxLines`, `ok`); Canadian tax by province when `taxMode: CANADA` (`layers/core/tax/canada.ts`, 4.4); a delivery's province is an estimate from geo-IP, else the store's (`taxRegion.estimated`, QA Q.23); 400 malformed / > 50 lines; 60/IP/min → 429 (4.3, 4.2) |
| Customer | `POST /customer/contact-store` `{storeId, name, email, message, website}` (no auth) | ✅ SES to the store, customer as Reply-To; honeypot; 5/IP/10 min + 30/store/h → 429; 409 `CONTACT_UNAVAILABLE` (3.4) |
| Admin | `GET /admin/get-store-members/:storeId` | ✅ `{members, invites}` |
| Admin | `GET /admin/get-store-admin-settings/:storeId` (+ `plan`, `planCommissions`), `PUT /admin/update-store-admin-settings` `{storeId, commissionSource, commissionMode, commissionPercentBps, salesCommissions, suspended}` (`suspended` replaced `isStoreLive` in P.2) (`PLAN`/`CUSTOM` P.6; `FIXED`/`PERCENT`, basis points 0–3,000, cents for every currency; 5.1a/5.1b) | ✅ the only way to read/write the `admin` block; `get-data` returns it to platform admins only, `get-data-public` never. The fee is `platformFeeForStore(admin, plan, quote)`: the plan's default unless `commissionSource` is CUSTOM |
| Admin | `POST /admin/assign-store-member` `{storeId, email, role?}` | ✅ existing account → member now (`ADDED`); no account → pending invite + SES email (`INVITED`, `emailSent`); 409 `ALREADY_MEMBER` |
| Admin | `DELETE /admin/remove-store-member/:storeId/:userId`, `DELETE /admin/cancel-store-invite/:storeId/:email` | ✅ 404 `NOT_A_MEMBER` / `NOT_INVITED` |
| User | `GET /user/get-my-profile[/:locale]` | ✅ profile + `stores` (memberships); creates missing user rows from the user pool; 404 `PROFILE_NOT_FOUND`, 403 `ACCOUNT_DEACTIVATED` |
| User | `PUT /user/update-profile` `{userFirstName, userLastName}` (trimmed, 1–50 chars), `PUT /user/update-fcm-token` | ✅ |
| User | `DELETE /user/delete-user` | ⛔ disabled (501) until a full delete exists (after 1.2) |
| Merchant | `POST /merchant/create-store` `{storeName, storeSlug}` (any signed-in user, P.3) | ✅ draft with no plan (`NONE`) + the caller as ADMIN in one transaction; 404 `PROFILE_NOT_FOUND`, 403 `ACCOUNT_DEACTIVATED`, 409 `SLUG_TAKEN` / `DRAFT_LIMIT_REACHED` (5 drafts), 5/account/hour → 429 |
| Merchant | `GET /merchant/path` | ❌ template stub |
| Customer | — | ❌ empty router |
| Payments (5.2) | `POST /store/payments/create-connect-account-link` `{storeId, country?}` → `{url, expiresAt}` (store admins); `GET /store/payments/status/:storeId` (members) | ✅ Standard account created once per store (`country` CA/US/AU required the first time; idempotency key), fresh onboarding link per call returning to `/store/storefront/:storeId?payments=return\|refresh`; status reads Stripe, refreshes the cached flags, forgets a disconnected account. 503 `PAYMENTS_NOT_CONFIGURED`, 502 `STRIPE_ERROR`. `payments` lives in its own SETTINGS attribute; public responses get only `paymentsEnabled` |
| Go Live (P.4) | `GET /store/go-live/checklist/:storeId` (members), `POST /store/go-live` `{storeId, plan}` (store ADMINs), `GET /store/public/plans` (no auth) | ✅ checklist steps STORE_NAME / ITEMS / FULFILMENT / PAYMENTS (Stripe live), plans in the billing currency; Go Live re-checks everything, then `runSmartStoreValidation` (**TODO stub, passes all**) → a Billing `checkoutUrl` (P.5; the webhook takes it live), LIVE only on a plan an admin gave, or IN_REVIEW (admin-only `review`); plan must be SPARK / NOVA; 409 `PLAN_NOT_AVAILABLE` while `PAID_PLANS_ENABLED` is off |
| Billing (P.5) | `GET /store/billing/status/:storeId` (members), `POST /store/billing/portal` `{storeId}` (the payer only; Spark ↔ Nova, card, cancel), webhook `POST /api/v1/billing/stripe-webhook` | ✅ Stripe Billing on the platform account with `automatic_tax`; Go Live returns `checkoutUrl` and the webhook takes it live; every event re-syncs the subscription from Stripe (`layers/payments/subscription-sync`, rules in `layers/core/billing`); cancelled → at the period's end, failed payment → 7 days' grace, then the plan ENDS: a live store goes back to DRAFT (`pausedReason: PLAN_ENDED`); hourly grace sweep; plans behind `PAID_PLANS_ENABLED`. No separate upgrade checkout (removed with the Free plan, P.10) |
| Payments | `POST /api/v1/website/listen-to-stripe-event/:websiteId` | ❌ returns 501 until Stage 5 (registered before `express.json()` so the raw body is available) |

Infra helpers ready to reuse: SES `sendEmail` + templates, PDF invoice generator (`pdfkit`),
Secrets Manager CRUD, Route53 subdomain records, S3 helpers, Stripe checkout link helper, the
in-process DQS queue.

## 5. Known issues & risks

Open:
1. Adding an existing account to a store (1.4) sends no email; only invites to new emails do.
2. The store check costs two reads per request (user id by Cognito id, then the membership).
   Fine for now; cache or put the user id in a token claim if it shows up in latency.
3. The password that used to be in `node/README.md` is still in **git history** — make sure it has
   been rotated (S.2).
4. Rewards redemption method has two spellings: the backend default is `POINTS_TO_*`, the webapp
   saves `REWARDS_REDEMPTION_*`. The validator accepts both. → unify in Stage 7.3
5. `certbot-renew.sh` still uses `/home/ec2-user/primedine/...` paths; check them on the server.
6. `getClientIp` returns a hard-coded Australian IP in dev (intentional for testing currency), so
   in dev a Canada delivery's tax estimate always falls back to the store's province.
7. No structured logging, rate limiting or CI yet. → Stage 9

Fixed in Stage 0: hard-coded stage/config → env vars; domain mismatch (API host is
`api.ceseelia.com`, path `/api/v1`, in middleware, nginx, cert script and webapp);
**token signatures were not verified in dev (and the stage was hard-coded to dev)**; the identity
was read from an unverified decode; CORS reflected any origin; update-settings didn't await the
write or validate; the Stripe webhook hung; secrets were in the README; there were no tests or lint.

---

## 6. Roadmap — stages & steps

> **Task tracking lives in [`progress.md`](progress.md).** It is the source of truth for what's
> done and what's next (including the security/bug-fix Stage S that comes before Stage 1). This
> section keeps the design intent for each stage; tick boxes in `progress.md`, not here.

Each step should be small enough for one PR. "WA" = matching work in `ceseelia_webapp`.

### Stage 0 — Foundations, config & security ✅ (done 2026-11-02)
- [x] 0.1 Remove credentials from `node/README.md`; add `.env.example`. (Rotating the password
      is a manual step.)
- [x] 0.2 `STAGE`, Cognito ids, table/bucket names, allowed hosts, CORS origins come from env vars
      with dev defaults; startup fails in prod if required vars are missing.
- [x] 0.3 Domains aligned on `api.ceseelia.com` + `/api/v1` (middleware, nginx,
      `generate-cert.sh`, WA `config.prod.json`); `awsfire`/`dinersxpress` references removed
      from runtime config.
- [x] 0.4 CORS restricted to `CORS_ORIGINS` (dev with no list = any origin).
- [x] 0.5 `update-settings`: validators implemented, write awaited *before* S3 cleanup,
      `customize` access guarded. Also: the auth wrapper verifies tokens in every stage, catches
      errors, and returns 401/403 properly.
- [x] 0.6 ESLint + Prettier + `typecheck`, Vitest + supertest + aws-sdk-client-mock; tests for the
      wrapper, app/CORS/host routing, settings validators and the store entity. Routes moved
      from `require()` to ES imports so they're testable.
- [x] 0.7 `node/dist` was already untracked.

### Stage 1 — Users, merchants & store ownership
1.1 User registration: done by the `OnUserRegister` PostConfirmation Lambda in
    `../ceseelia_cloudformation`. Left for the backend: `get-my-profile` creates the same records
    on first call if they're missing (the Lambda logs and swallows write errors), and a clear 404
    `PROFILE_NOT_FOUND` otherwise.
1.2 Data model for membership: `STORE#<storeId>` / `MEMBER#<userId>` (`StoreMember`, already
    defined) plus reverse `USER#<userId>` / `STORE#<storeId>` so a user can list their stores.
    Return `userStoreIds` (or full store summaries) from `get-my-profile`.
1.3 Authorization helper `assertStoreAccess(req, storeId, role)` (admin bypass) and apply it to
    **every** `/store/**` route. Return 403 when not a member.
1.4 Admin: `POST /admin/assign-store-member` (by email; invite via SES if no account),
    `DELETE /admin/remove-store-member`, `GET /admin/get-store-members/:storeId`.
1.5 `GET /merchant/get-overview-data` → merchant's stores with headline stats (replace stub).
1.6 Persist the `admin` settings block via an admin-only `PUT /admin/update-store-admin-settings`
    (commission, isStoreLive); keep it out of the merchant `update-settings`.
1.7 Implement `DELETE /store/delete/:storeId` (admin): delete all `STORE#id` items, the
    `APP_STORE` overview, memberships and the `store/<id>/` S3 prefix (batch ops exist).
1.8 ✅ Slug uniqueness: reserve `SLUG#<slug>` → storeId on create/update (conditional put), and add
    `GET /store/public/resolve-slug/:slug` for the storefront.

### Stage 2 — Inventory hardening
2.1 Maintain `storeCategoryItemCount` (atomic `ADD` on item create/move/delete); stop resetting it
    on category update.
2.2 ✅ Category delete: blocked (409) while it has items — no "uncategorized" bucket.
2.3 ✅ Validate upload endpoints: allowed image types, max counts (≤ 10), file-size limits via
    presigned POST conditions; unsaved uploads expire (pending tag + lifecycle rule).
2.4 ✅ Public data endpoint: return only `storeItemIsActive` items in active categories, strip admin
    settings and any private fields, and 404 when `isStoreLive === false` or store not found.
2.5 ✅ Price model: `storeItemPrices` = whole cents per currency, each set by the merchant (no
    conversion); replaces `storeItemPrice`. `scripts/migrate-item-prices.mjs` moves old prices.
2.6 ✅ Stock semantics: `STOCK_UNLIMITED` (-1) vs. a tracked count (0 = sold out); `hasStockFor`
    is the check for quotes and the paid-order decrement (Stage 5).
2.7 ✅ Variants: single-choice params (always required) make `storeItemVariants`, a row per option
    combination with its own stock, price per currency and sold flag (≤ 100); multiple-choice
    params are add-ons with no stock or price. Public data hides unsold rows and items whose
    table isn't filled in; the quote prices and stocks by combination (`OPTION_UNAVAILABLE`).
    The paid-order decrement (5.6b) must decrement the combination's row.

### Stage 3 — Public storefront API
3.1 ✅ `GET /store/public/storefront/:slug` → storeId + settings + categories + active items (wraps 2.4/1.8).
3.2 ✅ (headers) Cache headers / CloudFront in front of public endpoints and the storage bucket
    (`layers/core/http/cache.ts`; CloudFront still to do).
3.3 ✅ `GET /store/public/item/:storeId/:itemId` for deep-linked item pages (WA item sheet / share).
3.4 ✅ Public "contact store" → `POST /customer/contact-store` (SES to store email, rate-limited).

### Stage 4 — Cart & pricing service
4.1 ✅ Cart is client-side (localStorage per store). Server owns pricing:
    `POST /customer/quote` takes `{storeId, currency, lines:[{itemId, qty, params}]}` and returns
    validated lines, unit prices, item/category/store discounts, subtotal, delivery, tax, total,
    and errors (out of stock, inactive item, invalid mandatory params).
4.2 ✅ Single shared pricing function used by both `quote` and order creation (unit-tested):
    `priceLines` in `layers/core/pricing`. Biggest of item/category/store discount wins (no
    stacking); line discount rounded half up per line. Tax and delivery settings (4.2) are
    optional on `general`: always read them through `fulfilmentSettings` (defaults for old
    settings).
4.3 ✅ Tax & delivery configuration in store settings (`general.taxRate`, pickup/delivery options,
    delivery fee/zones) — extend `StoreSettings` + `initStoreSettings` + validators.

### Stage P — Plans, self-serve stores & Go Live (before 5.3; decided 2026-11-12)
Full plan in `progress.md` §6a. Key rules:
- Plans are **per store**, and every plan is paid (**no Free plan since 2026-11-13, P.10**):
  SPARK (25 CAD/AUD, 19 USD a month; commission 1.95 CAD/AUD, 1.45 USD; unlimited), NOVA (49
  CAD/AUD, 39 USD a month; no commission; unlimited). Custom domains are "coming soon" until
  9.8. No trials. Only a store with a plan is LIVE; going live and subscribing are one step.
- Anyone signed in can create a store (DRAFT, plan `NONE`) and build it; its members preview it,
  shoppers see "Coming soon"; only LIVE stores take orders.
  `admin.isStoreLive` becomes `admin.suspended` (admin suspension is separate from DRAFT/LIVE).
- Go Live re-checks the checklist on the server and calls **`runSmartStoreValidation(storeId)`**
  (AI fraud check of the store's items). **It's an empty TODO stub that passes every store for
  now**; once built, a flagged store goes to IN_REVIEW and an admin queue instead of LIVE.
- Subscriptions use Stripe **Billing on the platform account** (not Connect), with Stripe Tax on
  for Ceseelia's own GST/HST. Merchants switch Spark ↔ Nova in the portal. Cancel → live until
  the period ends; failed payment → retries → 7 days' grace; then the plan ends and the store is
  a DRAFT again (not live) until it goes live on a plan.
- The platform fee is the store's admin override (5.1b) if set, else the plan's default.
- Payments are **online only**: no pay at pickup.

### Stage 5 — Checkout, orders & payments
5.1 ✅ Payment provider (decided 2026-11-11): **Stripe Connect with Standard accounts** (owner's
    choice over Express). Merchants never hand us their secret keys (the legacy code stores
    per-merchant keys in Secrets Manager; don't). What Standard means for the build:
    - Each merchant has a full Stripe account and dashboard and is the merchant of record: their
      name on statements, they pay Stripe's fees, and they own disputes and chargebacks.
    - Use **direct charges**: create the Checkout Session *on the connected account*
      (`stripeAccount: acct_…`) with `payment_intent_data.application_fee_amount`.
    - Events from those charges reach a **Connect** webhook endpoint (its own signing secret,
      `event.account` names the store's account), not the platform endpoint.
    - Merchants can refund or cancel in their own dashboard, so the webhook must sync
      `charge.refunded` / `charge.dispute.*` onto the order; our own refund route (6.2) refunds
      on the connected account.
    **Platform commission (decided 2026-11-11, percentage added 2026-11-12 as 5.1b):** set per
    store by platform admins, in one of two modes (`admin.commissionMode`, missing = `FIXED`):
    - `FIXED`: `admin.salesCommissions` per order in the order's currency (cents:
      `{ USD: 125, CAD: 125, AUD: 125 }`, default 1.25 each; flat pre-5.1a `salesCommission`
      values are read as that amount in every currency by `normalizeAdminSettings`).
    - `PERCENT`: `admin.commissionPercentBps` (basis points, 0–3,000 = 0–30%) of the **items
      after discounts, without delivery and without tax** (`commissionBaseMinor`; tax-inclusive
      prices have their tax taken out), rounded half up, and at least `salesCommissions` in that
      currency (the minimum per order, 0 = none).
    The fee is always worked out on the server by `platformFeeMinor(admin, quote)` from the
    stored admin block and the server's own re-quote; nothing the client sends feeds it. It is
    capped at the order total and never negative, and a bad stored mode or percentage is read as
    `FIXED` / 0. Only the admin routes write the block (merchants' update-settings never does),
    and the mode and percentage are copied onto each order when it's created (5.4), so a later
    change never alters an order in progress. It is taken from the **merchant** as
    `application_fee_amount` and never shown to or
    charged to the shopper: no "handling fee" line in the cart, quote or checkout. A mandatory
    per-order fee added after the price is shown is drip pricing (Canada's Competition Act,
    Australian Consumer Law, California SB 478). A merchant who wants to pass it on raises their
    prices. The platform's own GST/HST on its fee is charged to the merchant (B2B).
    **Tax is Ceseelia's, not Stripe's:** the Checkout Session charges exactly the quote's tax and
    never enables `automatic_tax`. Stripe's onboarding offers merchants Stripe Tax (and Radar
    upgrades); those are on the merchant's own account, and enabling `automatic_tax` would tax
    the shopper twice.
5.2 ✅ Merchant onboarding: `POST /store/payments/create-connect-account-link`,
    `GET /store/payments/status/:storeId`; `stripeAccountId` + cached flags in the SETTINGS
    row's own `payments` attribute (not the admin block, which the admin form replaces).
    **Stripe keys** live in AWS Secrets Manager (`STRIPE_SECRET_ID`, default
    `ceseelia/<STAGE>/stripe`, JSON `{secretKey, webhookSecret}`), read once by
    `layers/payments/stripe.ts`; never in `.env` or git. Dev refuses a live key; prod refuses
    to start without a usable key (`checkStripeConfig` in `index.ts`). The legacy `layers/stripe`
    is unused.
5.3 `POST /customer/create-order`: re-quote (4.2) with the delivery address's postal code
    (`priceLines(..., { postalCode })`; never the cart's geo-IP estimate, QA Q.23), write `ORDER#…` with status `PENDING_PAYMENT`,
    create a Stripe Checkout Session (connected account + application fee), return its URL.
    Also support a "pay on pickup" path if desired.
5.4 Webhook: rewrite `listen-to-stripe-event/:storeId` — verify signature with the platform
    webhook secret, always respond 2xx quickly, handle `checkout.session.completed` /
    `expired` / `payment_intent.payment_failed` idempotently (store processed event ids).
5.5 On paid: mark order `PAID`, decrement stock (conditional update), bump
    `storeOrderCount`/overview counters, write `APP` / `ORDER#ts#STORE#id` for admin sales graphs.
5.6 Order status lifecycle: `PENDING_PAYMENT → PAID → PREPARING → READY/SHIPPED → COMPLETED`,
    plus `CANCELLED/REFUNDED`. Replace the boolean `storeOrderStatus` in `StoreOrder`.
5.7 Lost/abandoned order sweeper (the `SERVER_WATCH_CHECK_FOR_LOST_ORDERS_INTERVAL` constant
    and `registerTimer` util already exist).

### Stage 6 — Order management & notifications
6.1 Merchant: `GET /store/orders/list/:storeId` (paginated, filter by status/date),
    `GET /store/orders/get/:storeId/:orderId`, `PUT /store/orders/update-status`.
6.2 Refunds: `POST /store/orders/refund` via Stripe (full/partial).
6.3 Emails (SES, reuse templates + `pdf` invoice): customer confirmation + receipt, merchant
    new-order alert, status-change emails.
6.4 Public order tracking: `GET /customer/order-status/:orderId?token=…` (signed token in email).
6.5 Optional push to merchant via FCM (`update-fcm-token` already exists).

### Stage 7 — Customers, rewards & reviews
7.1 Customer records per store (`STORE#id` / `CUSTOMER#email`) aggregated from orders;
    `GET /store/customers/list/:storeId`.
7.2 Optional customer accounts (Cognito, separate app client or pool) for order history.
7.3 Purchase rewards (settings already modelled): accrue points on paid orders, redeem in quote.
7.4 Reviews (WA has a hidden Reviews page): `POST /customer/review` (only for completed orders),
    moderation, `GET /store/reviews/list/:storeId`.

### Stage 8 — Admin console & support
8.1 Real admin overview: quick stats, sales activity (from `APP/ORDER#…` records), store counts.
8.2 Merchant join requests (`Merchant` interface exists): public `POST /merchant/join-request`,
    admin list/approve/deny → approval creates store + membership (1.4).
8.3 Support tickets: merchant `POST /merchant/support/create-ticket`, list/reply; admin
    list/reply/close; SES notifications.
8.4 Platform commission reporting per store (from Stripe application fees).

### Stage 9 — Production readiness
9.1 Structured logging (pino) with request ids; no PII in logs.
9.2 Rate limiting on public endpoints (`express-rate-limit`), body size limits, helmet.
9.3 Health check endpoint for nginx/docker; graceful shutdown.
9.4 CI (GitHub Actions): lint, typecheck, tests, build image.
9.5 IaC for DynamoDB table + GSIs, buckets, Cognito triggers (CDK/Terraform) so dev/prod match.
9.6 Backups (DynamoDB PITR), S3 lifecycle rules, alarms.
9.7 Optional: custom store domains via Route53 helpers already in `layers/aws/route53`.

## 7. Working agreements for Claude

- Keep the one-folder-per-endpoint pattern and `validateAndExecuteHttpApiRoute`; don't introduce
  a second framework.
- Every new `/store/**` route must pass `storeMember(…)` as `access` (or `true` if it's
  admin-only) and be added to the matrix in `tests/store-access.test.ts`.
- Never commit credentials; read config from env.
- When changing a response shape, update the WA interface and the calling component in the same
  change set and mention it in the summary.
- When you finish a task, tick it in `progress.md` (and add a changelog row), and update the
  tables in §4/§5 here if what's implemented or the known issues changed.
