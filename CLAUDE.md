# CLAUDE.md — Ceseelia Backend

Ceseelia is a multi-tenant ecommerce platform: an **admin** creates stores, **merchants** manage
a store's inventory and storefront, and **customers** browse a public storefront and (eventually)
order and pay. This repo is the REST API. The Angular frontend lives in
`../ceseelia_webapp` (see its `CLAUDE.md`). Both files share the same stage numbering — work on a
stage usually touches both repos.

---

## 1. Stack & layout

- Node 20, TypeScript (CommonJS, `strict`), Express 5
- AWS: DynamoDB (single table), Cognito (auth), S3 (images via presigned URLs), SES (email),
  Secrets Manager, Route53; Stripe SDK installed but not wired up
- Deployed as Docker containers on EC2: `node` (port 3100) behind `nginx` (TLS via certbot)

```
ceseelia_backend/
├── docker-compose.yml, nginx/nginx.conf      # prod runtime (node + nginx + certbot)
├── *.sh / *.ps1                              # EC2 ops scripts (certs, swap, scp image, reboot)
└── node/
    ├── index.ts           # Express bootstrap, Stripe webhook route, DQS queue
    ├── middleware.ts      # host-based router + request logger (only allowed hosts reach the API)
    ├── config/index.ts    # STAGE, Cognito pool ids, table/bucket names  (STAGE is hard-coded!)
    ├── constants/index.ts # appConstants (entity names, HTTP codes, limits, etc.)
    ├── api/v1/<area>/<route>/index.ts   # one file per endpoint
    └── layers/
        ├── core/http      # validateAndExecuteHttpApiRoute (auth + validation wrapper)
        ├── core/interfaces/store   # StoreOverview, StoreSettings, StoreCategory, StoreItem, StoreOrder…
        ├── core/utils     # misc helpers, S3 cleanup, geo-IP currency, PDF invoice, DQS
        ├── aws/dynamodb/dynamo-entities/{store,admin,user}   # data access
        ├── aws/{cognito,s3,ses,sqs,route53,secret-manager}
        └── stripe         # generateStripeCheckoutLink (legacy, from a previous project)
```

Note: much of `layers/` (user entity, cognito, stripe, pdf, ses templates, DQS stripe handler,
`websiteId` naming) was carried over from earlier projects (DinersXpress / PrimeFaya). Treat it as
a toolbox — reuse, but verify before relying on it.

## 2. Commands

```bash
cd node
npm install
npm run dev     # tsc --watch + nodemon dist/index.js  (http://0.0.0.0:3100)
npm run build   # tsc -> dist/
npm start       # node dist/index.js
```

Deploy: build locally, build the Docker image from `node/` (it copies the prebuilt `dist/`), ship
with `scp-docker-image.sh`, then `docker compose up -d` on the server. There are no tests and no CI.

## 3. Conventions (follow these when adding endpoints)

Every endpoint is its own folder exporting `module.exports = function (router) {...}` and is
registered with `require('./x/index')(router)` in the parent router's `index.ts`.

```ts
router.post('/create', (req, res) => {
  validateAndExecuteHttpApiRoute(req, res, pureRequestParams, validRequestParams, executeRouteCore,
    /* withAuth */ true, /* adminOnly */ false);
});
// pureRequestParams  -> type checks only   (400 "Bad request parameters")
// validRequestParams -> value checks       (400 "Invalid request parameters")
// executeRouteCore   -> try/catch, 500 on error, log only IN_DEV
```

- Auth: `Authorization: <Cognito access token>` header. The wrapper attaches `req.body.cognito_id`,
  `cognito_groups`, `is_user_admin` (Cognito group `Admins`).
- DynamoDB single table `ceseelia_<stage>` with `pk`/`sk`:
  | Entity | pk | sk |
  |---|---|---|
  | Store overview (admin list) | `APP_STORE` | `STORE#<storeId>#OVERVIEW` |
  | Store settings | `STORE#<storeId>` | `SETTINGS` |
  | Category | `STORE#<storeId>` | `CATEGORY#<categoryId>` |
  | Item | `STORE#<storeId>` | `ITEM#<itemId>` |
  | User profile | `USER#<uuid>` | `PROFILE#INFO`, `PROFILE#COGNITO_DATA#<cognitoId>` |
  | (planned) Order | `STORE#<storeId>` | `ORDER#<createdAt>#<orderId>` (see `StoreOrder` interface) |
  GSIs used by user code: `CognitoIdentifierGSI`, `UserEmailGSI`.
- S3 keys: `store/<storeId>/images/{logo,header,promo}/<ulid>.<ext>`,
  `store/<storeId>/category/<categoryId>/…`, `store/<storeId>/item/<itemId>/…`. Uploads use
  presigned PUT URLs; on save, `cleanUpS3Folder(prefix, keepUris)` deletes orphaned files.
- IDs are ULIDs. Field names are prefixed (`storeItem…`, `storeCategory…`). Note the existing
  typo `storeCategoriy…` (Id, Priority, Hashtags) — it is persisted data, keep it consistent
  unless doing a deliberate migration.
- When you change a shared interface in `layers/core/interfaces/store`, mirror it in
  `ceseelia_webapp/src/app/core/interfaces/core/store.interface.ts`.

## 4. What is implemented

| Area | Endpoint | Status |
|---|---|---|
| Store | `POST /store/create` (admin) | ✅ creates overview + default settings |
| Store | `DELETE /store/delete/:storeId` | ❌ stub — does nothing |
| Store | `PUT /store/update-settings` | ✅ saves settings, cleans logo/header/promo S3 leaks (`admin` block **not** persisted) |
| Store | `GET /store/get-logo-upload-url/:storeId/:imageType` | ✅ |
| Store | `GET /store/get-header-strip-image-upload-url/:storeId/:imageType` | ✅ |
| Store | `GET /store/get-promo-image-upload-urls/:storeId/:pngCount/:jpgCount` | ✅ |
| Category | `POST /store/category/create` (create + update via `isUpdate`) | ✅ |
| Category | `DELETE /store/category/delete/:storeId/:storeCategoryId` | ✅ (items in it are not handled) |
| Category | `GET /store/category/get-banner-upload-url/:storeId/:categoryId/:imageType` | ✅ |
| Inventory | `POST /store/inventory/create-item` (create + update) | ✅ |
| Inventory | `DELETE /store/inventory/delete-item/:storeId/:storeItemId` | ✅ |
| Inventory | `GET /store/inventory/get-data/:storeId` (auth) | ✅ categories + items + settings |
| Inventory | `GET /store/inventory/get-data-public/:storeId` (no auth) | ✅ + geo-IP default currency |
| Inventory | `GET /store/inventory/get-item-image-upload-urls/...` | ✅ |
| Admin | `GET /admin/get-all-stores`, `GET /admin/get-overview-data` | ✅ (overview only fills `allStores`; stats are empty objects) |
| Admin | `POST /admin/update-store-info` (name/slug) | ✅ |
| User | `GET /user/get-my-profile[/:locale]`, `PUT /user/update-profile`, `PUT /user/update-fcm-token`, `DELETE /user/delete-user` | ⚠️ depend on a user record that nothing in this repo creates |
| Merchant | `GET /merchant/path` | ❌ template stub |
| Customer | — | ❌ empty router |
| Payments | `POST /api/v1/website/listen-to-stripe-event/:websiteId` | ❌ handler body commented out; request never gets a response |

Infra helpers ready to reuse: SES `sendEmail` + templates, PDF invoice generator (`pdfkit`),
Secrets Manager CRUD, Route53 subdomain records, S3 helpers, Stripe checkout link helper, the
in-process DQS queue.

## 5. Known issues & risks (fix early — mostly Stage 0)

1. **No store-level authorization.** Any signed-in user can read/modify/delete any store's
   settings, categories, items and images by passing its `storeId`. There is no user↔store link.
2. **User records are never created.** `registerUser` exists but no route or Cognito trigger calls
   it, so `get-my-profile` fails for new sign-ups. `userStoreIds` (used by the frontend) is never
   written.
3. **Secrets in the repo.** `node/README.md` contains a real email + password in a shell snippet —
   remove it and rotate that password. Cognito ids and the admin email are hard-coded in
   `config`/`constants`.
4. **Stage is hard-coded** (`STAGE = STAGE_DEV` in `config/index.ts`); prod builds point at dev
   resources unless edited by hand. `ORIGIN`, `COGNITO_AUTH_DOMAIN`, `S3_*_ORIGIN` still reference
   `awsfire.com`; `nginx.conf` still serves `api.dinersxpress.com`, while `middleware.ts` only
   accepts `api.ceseelia.northernhoop.com` and the webapp prod config calls
   `https://api.ceseelia.com/v1` (no `/api` prefix). These three must agree.
5. `update-settings` does not `await updateStoreSettings(...)` (errors are swallowed, response sent
   before write) and `isStoreSettingsPure/Valid` always return `true`. `extractStoreHeaderStripImageUri`
   throws if `customize.header` is missing (default settings have `customize: {}`).
6. `updateStoreSettings` ignores `storeSettings.admin`, so the admin's commission/“store live”
   toggles in the UI never save.
7. `updateStoreCategory` resets `storeCategoryItemCount` to 0 on every save; item counts are never
   maintained.
8. Deleting a category leaves its items orphaned; deleting a store is unimplemented.
9. `validRequestParams` returns `true` on several routes (no checks on ids, counts, image types for
   promo/item uploads — counts are unbounded).
10. `cors({ origin: true, credentials: true })` reflects any origin.
11. `getClientIp` returns a hard-coded Australian IP in dev (intentional for testing currency).
12. No tests, no lint, no structured logging, `dist/` is committed in the history.

---

## 6. Roadmap — stages & steps

Each step should be small enough for one PR. "WA" = matching work in `ceseelia_webapp`.

### Stage 0 — Foundations, config & security
0.1 Remove credentials from `node/README.md`; rotate the password; add `.env.example`.
0.2 Move `STAGE`, Cognito ids, table/bucket names, allowed hosts, CORS origins into env vars
    (`process.env`), with a dev default. Fail fast on missing prod vars.
0.3 Align domains: choose the API host (e.g. `api.ceseelia.com`) and path prefix (`/api/v1`);
    update `middleware.ts`, `nginx/nginx.conf`, cert scripts, and WA `config.prod.json`.
    Replace leftover `awsfire.com` / `dinersxpress` references.
0.4 Restrict CORS to the webapp origins from env.
0.5 Fix `update-settings`: `await` the write, implement `isStoreSettingsPure/Valid`, guard
    `customize` access in the extract helpers.
0.6 Add ESLint + Prettier, a `npm run typecheck`, and Vitest/Jest with supertest; first tests for
    `validateAndExecuteHttpApiRoute` and the store entity (DynamoDB mocked).
0.7 Stop tracking `node/dist` (already in `.gitignore`; `git rm -r --cached node/dist`).

### Stage 1 — Users, merchants & store ownership
1.1 User registration: add a Cognito **Post Confirmation** trigger (Lambda) *or* a
    `POST /user/register` called after first sign-in that runs `registerUser`. Make
    `get-my-profile` create-on-first-call as a fallback.
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
1.8 Slug uniqueness: reserve `SLUG#<slug>` → storeId on create/update (conditional put), and add
    `GET /store/public/resolve-slug/:slug` for the storefront.

### Stage 2 — Inventory hardening
2.1 Maintain `storeCategoryItemCount` (atomic `ADD` on item create/move/delete); stop resetting it
    on category update.
2.2 Category delete: block if it has items, or move items to "uncategorized" (pick one; document it).
2.3 Validate upload endpoints: allowed image types, max counts (e.g. ≤ 10), file-size limits via
    presigned POST conditions.
2.4 Public data endpoint: return only `storeItemIsActive` items in active categories, strip admin
    settings and any private fields, and 404 when `isStoreLive === false` or store not found.
2.5 Price model: store prices as integer minor units (cents) per base currency; decide how
    multi-currency works (fixed per-currency prices vs. conversion). Add `storeItemPrices` map if
    per-currency. (WA mirrors.)
2.6 Stock semantics: `-1` = unlimited vs. tracked; decrement on paid order (Stage 5).

### Stage 3 — Public storefront API
3.1 `GET /store/public/storefront/:slug` → settings + categories + active items (wraps 2.4/1.8).
3.2 Cache headers / CloudFront in front of public endpoints and the storage bucket.
3.3 `GET /store/public/item/:storeId/:itemId` for deep-linked item pages (WA item sheet / share).
3.4 Public "contact store" → `POST /customer/contact-store` (SES to store email, rate-limited).

### Stage 4 — Cart & pricing service
4.1 Cart is client-side (localStorage per store). Server owns pricing:
    `POST /customer/quote` takes `{storeId, currency, lines:[{itemId, qty, params}]}` and returns
    validated lines, unit prices, item/category/store discounts, subtotal, delivery, tax, total,
    and errors (out of stock, inactive item, invalid mandatory params).
4.2 Single shared pricing function used by both `quote` and order creation (unit-tested).
4.3 Tax & delivery configuration in store settings (`general.taxRate`, pickup/delivery options,
    delivery fee/zones) — extend `StoreSettings` + `initStoreSettings` + validators.

### Stage 5 — Checkout, orders & payments
5.1 Payment provider decision: **Stripe Connect (Express accounts)** is recommended — it fits
    the platform `salesCommission` via `application_fee_amount`, and merchants never hand us their
    secret keys. (The legacy code stores per-merchant Stripe keys in Secrets Manager; avoid that.)
5.2 Merchant onboarding: `POST /store/payments/create-connect-account-link`,
    `GET /store/payments/status/:storeId`; save `stripeAccountId` in store settings (admin block).
5.3 `POST /customer/create-order`: re-quote (4.2), write `ORDER#…` with status `PENDING_PAYMENT`,
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
- Every new `/store/**` route must call the store-access check once Stage 1.3 lands.
- Never commit credentials; read config from env.
- When changing a response shape, update the WA interface and the calling component in the same
  change set and mention it in the summary.
- Update the tables in §4/§5 and tick roadmap steps here when you finish them.
