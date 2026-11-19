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
  Secrets Manager, Route53; Stripe (Connect + Billing, `layers/payments`)
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
├── iam/                                      # CeseeliaServerRole policy (prod server, least privilege)
└── node/
    ├── index.ts           # starts the server, the sweeps and graceful shutdown
    ├── app.ts             # createApp(): request logger, helmet, /healthz, CORS, Stripe webhooks, rate + body limits, host routing
    ├── middleware.ts      # host-based router (only ALLOWED_API_HOSTS reach the API)
    ├── tests/             # vitest specs
    ├── config/index.ts    # env-driven config (STAGE, hosts, CORS, Cognito, table/bucket)
    ├── constants/index.ts # appConstants (entity names, HTTP codes, limits, etc.); input-limits.ts, slug.ts
    ├── scripts/           # one-off maintenance scripts (slug backfill, category item recount, item price migration, Free plan migration)
    ├── api/v1/<area>/<route>/index.ts   # one file per endpoint
    └── layers/
        ├── core/http      # validateAndExecuteHttpApiRoute (auth + validation wrapper); api-limits (9.2), rate-limit (per route)
        ├── core/logger    # pino `log` / `logFor(area)`, request ids, redaction (9.1)
        ├── core/interfaces/store   # StoreOverview, StoreSettings, StoreCategory, StoreItem, StoreOrder…
        ├── core/utils     # misc helpers, S3 cleanup, geo-IP currency, DQS
        ├── aws/dynamodb/dynamo-entities/{store,admin,user,membership,slug}   # data access
        ├── aws/dynamodb/{dynamo-batch-ops,dynamo-query}   # batch read/write with retries; paged queries
        ├── aws/{cognito,s3,ses,sqs,route53,secret-manager}
        ├── payments       # Stripe: Connect, checkout, webhooks, refunds, Billing
        └── notifications  # order emails, templates, receipt PDF
```

Note: some of `layers/` (user entity, cognito, ses templates, DQS stripe handler,
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

The dev site (https://dev.ceseelia.com) calls the backend on your own machine at
`http://localhost:3100`: run `npm run dev` and open dev.ceseelia.com in a browser on the same machine
(Chrome asks once to let it reach this device; `allowPrivateNetwork` answers its preflight in dev).

Full local testing: `npm run kickstart` in the webapp (`tools/kickstart.sh`) runs this backend with
`WEBAPP_URL=http://<ip-with-dashes>.sslip.io:4200`, `STORE_URL_TEMPLATE=http://{slug}.<ip-with-dashes>.sslip.io:4200`
(this machine's wifi address, so phones on the same wifi can be shoppers; the webapp calls the API at
`http://<wifi-ip>:3100`, which `isAllowedApiHost` accepts in dev; `KICKSTART_LAN=0` keeps it to
`http://localhost:4200` / `http://{slug}.localhost:4200`) and
`STRIPE_LISTEN_SECRET` (the `stripe listen` signing secret; in dev it replaces both webhook secrets,
and prod refuses to start with it set), plus `stripe listen` forwarding the events in
`scripts/stripe-webhooks.mjs` (the same list `setup-stripe-account.mjs` gives the real endpoints).

Config comes from env vars (see `node/.env.example`): `STAGE` (dev|prod), `ALLOWED_API_HOSTS`,
`CORS_ORIGINS` (required in prod), `WEBAPP_URL` (links in emails), `STORE_URL_TEMPLATE` (store
addresses, 9.8), plus optional overrides for
table/bucket/Cognito ids. The
server refuses to start in prod if required vars are missing.

Deploy (since 2026-11-16): **pushing `prod_v1.0.0` deploys prod** (`.github/workflows/deploy-prod.yml`:
the CI checks, then the image goes to ECR `ceseelia-node` tagged with the commit, and SSM Run
Command runs `deploy-image.sh` on the server: pull, start, wait for `/healthz`, roll back to the
previous image if unhealthy). AWS access is GitHub OIDC → `CeseeliaGithubDeployBackendProd`
(`iam/github-deploy-backend-*.json`); no secrets in GitHub. Compose runs `${NODE_IMAGE}` from
the project's `./.env` (written by the deploy). By hand: `./scp-fs.sh build` then
`./node-update.sh` on the server (builds locally, sets `NODE_IMAGE=ceseelia-node`). Compose loads
`node/.env` into the container (`STAGE=prod` there); the API's logs go to CloudWatch
`/ceseelia/prod/api` (awslogs driver). CI (`.github/workflows/ci.yml`, 9.4) runs lint, typecheck,
tests, `npm audit` and the image build on every push and PR; it doesn't deploy.

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
- Logging (9.1): `import { log } from ".../layers/core/logger"`, never `console` in app code.
  `log.error({ err: e }, "In <area>/<route>")` for errors (the serializer drops payloads);
  log ids (storeId, orderId, Stripe ids), never names, emails, addresses or tokens.
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
  | Store's own domain (9.8 phase 2) | `STORE#<storeId>` | `DOMAIN` (host, status, tenant, certificate; `dynamo-entities/domain`) |
  | Domain reservation | `DOMAIN#<host>` | `DOMAIN` (`storeId`; one store per host) |
  | Domains list (sweep) | `APP_DOMAIN` | `STORE#<storeId>` (`host`, `status`) |
  | Tenant clean-up queue | `APP_DOMAIN_CLEANUP` | `<tenantId>` (`certificateArn`; removed domains' CloudFront tenants) |
  | Invite by email (reverse) | `INVITE#<email>` | `STORE#<storeId>` (found and claimed on that user's first `get-my-profile`) |
  | Order (5.3) | `STORE#<storeId>` | `ORDER#<createdAt>#<orderId>` (`StoreOrder`; written with its pointer by create-order) |
  | Order pointer | `ORDER#<orderId>` | `ORDER` (`storeId`, `orderSk`: find an order by id; never changes) |
  | Order code counter (UX-B) | `STORE#<storeId>` | `ORDER_CODE` (`prefix`, `n`: the store's last order number; first order 1001; `dynamo-entities/order-code`) |
  | Order code prefix (UX-B) | `ORDER_CODE_PREFIX#<prefix>` | `STORE` (`storeId`; one store per prefix, reserved at the store's first order, never freed, so `PB-1001` is unique on the platform) |
  | Sale (admin graphs) | `APP` | `ORDER#<paidAt>#STORE#<storeId>#<orderId>` (`currency`, `totalMinor`, `platformFeeMinor`; written when paid, 5.6d) |
  | Processed Stripe event | `STRIPE_EVENT#<eventId>` | `EVENT` (`type`, `processedAt`, `expiresAt`; Connect webhook, 5.5b) |
  | Item check due (L.2) | `APP_ITEM_CHECK` | `STORE#<storeId>#ITEM#<itemId>` (`dueAt`; written by create-item, removed by the item sweep) |
  | Hidden item (admin queue, L.2) | `APP_ITEM_REVIEW` | `STORE#<storeId>#ITEM#<itemId>` (`storeName`, `itemName`, `imageUri`, `reasons`, `flaggedAt`; with the item's `storeItemReview` FLAGGED) |
  | Order alert (L.5) | `STORE#<storeId>` | `ORDER_ALERT#<at, 13 digits>#<orderId>` (`orderCode`, `totalMinor`, `currency`, `orderType`, `paidAt`, `ttl` a week; written when first paid, read by `GET /store/orders/new`) |
  | Push subscription (L.5) | `USER#<userId>` | `PUSH#<sha256(endpoint), 32 hex>` (`endpoint`, `p256dh`, `auth`, `createdAt`; ≤ 10 per user) |
  | Customer (L.7) | `STORE#<storeId>` | `CUSTOMER#<sha256(email), 32 hex>` (`email`, `name`, `phone`, `orders`, `spent_<CUR>` net of refunds, `firstOrderAt`, `lastOrderAt`, `lastOrderId`, `lastOrderCode`) |
  | Customer's order marker (L.7) | `STORE#<storeId>` | `CUSTOMER_ORDER#<orderId>` (`customerId`, `currency`, `refundedMinor`: what's been counted; only `recordCustomerOrder` writes both) |
  | Review (L.7) | `STORE#<storeId>` | `REVIEW#<createdAt, 13>#<orderId>` (`rating`, `comment`, `authorName`, `items`, `status` PUBLISHED/REMOVED, `reply`, `report`), `REVIEW_FOR#<orderId>` (`reviewSk`, one per order), `REVIEW_STATS` (`count`, `sum`, `r1`–`r5`) |
  | Rewards (L.7) | `STORE#<storeId>` | `REWARDS#<customerId>` (`email`, `balance`, `earned`, `redeemed`), `REWARDS_EARN#<orderId>` (`customerId`, `points`, `rate`), `REWARDS_CODE#<customerId>` (`hash`, `salt`, `attempts`, `expiresAt`, `ttl`), `REWARDS_SESSION#<sha256(token)>` (`customerId`, `email`, `expiresAt`, `ttl`), `REWARDS_LIMIT#<customerId>#<kind>#<window>` (`count`, `ttl`); orders carry `storeOrderRewards` |
  | Support ticket (L.8) | `APP_TICKET` | `TICKET#<ticketId>` (`userId`, `userEmail`, `userName`, `storeId`, `subject`, `category`, `status` OPEN/ANSWERED/CLOSED, `messageCount`, `preview`); pointer `USER#<userId> / TICKET#<ticketId>`; messages `TICKET#<ticketId> / MSG#<13-digit at>#<ulid>` (`from` USER/ADMIN, `authorName`, `body`) |
  | Reported review (admin queue, L.7) | `APP_REVIEW_REPORT` | `STORE#<storeId>#REVIEW#<orderId>` (open reports only) |
  | Conversation (L.10) | `STORE#<storeId>` | `CONVO#<id>` (id = the order's id for an order's conversation, else a new ULID for a Contact us inquiry; `kind`, customer name/email, `status` OPEN/BLOCKED, unread counts both ways, `customerTokenHashes` for inquiries, `actSk`, `report`), `CONVO_ACT#<13 lastAt>#<id>` (inbox order), `CONVO_UNREAD#<id>` (unread by the store), `CONVO_MSG#<id>#<13 at>#<ulid>` (`from` CUSTOMER/STORE, `body`, `images`, `byUserId`) |
  | Store message email due (L.10) | `APP_CONVO_NOTIFY` | `<13 dueAt>#STORE#<storeId>#<id>` (30 min after the first unread shopper message; the minute sweep emails the store if still unread) |
  | Reported conversation (admin queue, L.10) | `APP_CONVO_REPORT` | `STORE#<storeId>#CONVO#<id>` |
  | Pending order (sweeper list) | `APP_PENDING_ORDER` | `ORDER#<createdAt>#<orderId>` (`storeId`, `orderId`, `orderSk`; written by create-order with the order, removed by the 5.7 sweeper once settled) |
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
| Admin | `GET /admin/get-all-stores?q=&filter=&limit=&cursor=` (→ `{ stores, next, total, counts }`, L.9; `filter` all / in-review / items / past-due / live / draft / suspended and `counts` per filter, UX-D), `GET /admin/get-overview-data?tz=`, `GET /admin/queue-counts` (menu badges, L.9) | ✅ overview `{ stats, allStores }` (L.8 / 8.1, `layers/core/admin-stats`) |
| Admin commission (L.8 / 8.4) | `GET /admin/commission-report?month=&tz=[&reconcile=1][&format=csv]` | ✅ per store per month from each order's fee; optional check against Stripe's application fees |
| Support (L.8 / 8.3) | `/user/support/tickets` (GET, POST), `/user/support/tickets/:id` (GET), `…/reply`, `…/close` (POST); `/admin/support/tickets` (GET), `/admin/support/tickets/:id` (GET), `…/reply`, `…/close` (POST, admins) | ✅ own tickets only (404 otherwise), limits per user, emails carry no message text |
| Admin | `POST /admin/update-store-info` (name/slug; 409 if the slug is taken) | ✅ also sets the storefront name (`storeInfo.storeName`) in the same transaction (P.11) |
| Store | `POST /store/update-info` `{storeId, storeName, storeSlug}` (store ADMINs, P.11) | ✅ same as the admin rename; old slug freed at once; 409 `SLUG_TAKEN`, 404 `STORE_NOT_FOUND`, 10/store/hour → 429. `update-settings` copies a non-empty `storeInfo.storeName` to the overview row |
| Admin (P.8) | `GET /admin/get-review-queue`, `POST /admin/review-store` `{storeId, decision: APPROVE\|REJECT, message?}`, `PUT /admin/set-store-plan` `{storeId, plan}` | ✅ approve → DRAFT approved (next Go Live skips the check, goes to checkout); reject → DRAFT with the reason; conditional on IN_REVIEW (409 `STATUS_CHANGED`). Set plan `SPARK\|NOVA\|LUMINA\|NONE` = a plan with no subscription (`planSetByAdmin`, no checkout at Go Live), NONE takes it away (a live store → DRAFT), 409 `HAS_SUBSCRIPTION`. `get-all-stores` adds status / plan / billing per store |
| Public | `GET /store/public/resolve-slug/:slug` → `{storeId}` (404 if unknown) | ✅ |
| Store addresses (9.8 phase 1) | `layers/core/store-url` (`storeUrl`, `slugFromStoreOrigin`), env `STORE_URL_TEMPLATE` | ✅ prod: every store at `https://<slug>.ceseelia.com`; shopper links (Stripe return, order emails, previews) use it, CORS allows it; dev: `WEBAPP_URL/s/<slug>`. Custom domains = phase 2 (progress 9.8) |
| Custom domains (9.8 phase 2) | `layers/custom-domains` (sweep, steps), `layers/core/custom-domain` (rules), `layers/aws/cloudfront/tenants`, `api/v1/store/domain`, env `CUSTOM_DOMAIN_DISTRIBUTION_ID` / `CUSTOM_DOMAIN_CONNECTION_GROUP_ID` / `CUSTOM_DOMAIN_TARGET` | Coded 2026-11-16, prod after the CloudFormation deploy (§0 G4–G5). A store on a plan CNAMEs `shop.theirbrand.com` → `domains.ceseelia.com`; the API makes a CloudFront tenant with a managed certificate; live domains win in `storeUrl` and pass CORS. Off without the env |
| Link previews (L.9 / WA 3.6) | `GET /store/public/preview/:slug[/:itemId]` → HTML with Open Graph / Twitter tags | ✅ only for link-preview bots (the webapp's CloudFront function sends them); name, slogan, logo, or a live store's visible item; unknown / suspended → plain Ceseelia, 404; `public, max-age=300` |
| Public | `GET /store/public/storefront/:slug` → `{storeId, settings, categories, items}` (no auth) | ✅ same body as `get-data-public` (`sendPublicStorefront`); 400 bad slug, 404 `STORE_NOT_FOUND` / `STORE_UNAVAILABLE` (3.1); `Cache-Control: private, no-cache` (3.2; revalidated by ETag every time since QA Q.21) |
| Public | `GET /store/public/item/:storeId/:itemId` → `{storeId, item, category, currencies}` (no auth) | ✅ storefront rules; 404 `ITEM_NOT_FOUND` for missing or hidden (3.3) |
| Customer | `POST /customer/quote` `{storeId, currency, fulfilment?, lines:[{itemId, quantity, params?}], postalCode?}` (no auth) | ✅ always 200 with `priceLines`' quote (per-line errors, delivery, tax parts in `taxLines`, `ok`); Canadian tax by province when `taxMode: CANADA` (`layers/core/tax/canada.ts`, 4.4); a delivery's province is an estimate from geo-IP, else the store's (`taxRegion.estimated`, QA Q.23), or from `postalCode` (checkout, WA 5.1: the same tax create-order charges); 400 malformed / > 50 lines; 60/IP/min → 429 (4.3, 4.2) |
| Customer | `POST /customer/contact-store` `{storeId, name, email, message, website}` (no auth) | ✅ SES to the store, customer as Reply-To; honeypot; 5/IP/10 min + 30/store/h → 429; 409 `CONTACT_UNAVAILABLE` (3.4) |
| Admin | `GET /admin/get-store-members/:storeId` | ✅ `{members, invites}` |
| Admin | `GET /admin/get-store-admin-settings/:storeId` (+ `plan`, `planCommissions`), `PUT /admin/update-store-admin-settings` `{storeId, commissionSource, commissionMode, commissionPercentBps, salesCommissions, suspended}` (`suspended` replaced `isStoreLive` in P.2) (`PLAN`/`CUSTOM` P.6; `FIXED`/`PERCENT`, basis points 0–3,000, cents for every currency; 5.1a/5.1b) | ✅ the only way to read/write the `admin` block; `get-data` returns it to platform admins only, `get-data-public` never. The fee is `platformFeeForStore(admin, plan, quote)`: the plan's default unless `commissionSource` is CUSTOM |
| Admin | `POST /admin/assign-store-member` `{storeId, email, role?}` | ✅ existing account → member now (`ADDED`); no account → pending invite + SES email (`INVITED`, `emailSent`); 409 `ALREADY_MEMBER`; 409 `ALREADY_IN_A_STORE` (one store per account, P.11: the account belongs to another store, or the email is invited to one) |
| Admin | `DELETE /admin/remove-store-member/:storeId/:userId`, `DELETE /admin/cancel-store-invite/:storeId/:email` | ✅ 404 `NOT_A_MEMBER` / `NOT_INVITED` |
| User | `GET /user/get-my-profile[/:locale]` | ✅ profile + `stores` (memberships); creates missing user rows from the user pool; 404 `PROFILE_NOT_FOUND`, 403 `ACCOUNT_DEACTIVATED` |
| User | `PUT /user/update-profile` `{userFirstName, userLastName}` (trimmed, 1–50 chars), `PUT /user/update-fcm-token` | ✅ |
| User | `DELETE /user/delete-user` `{ confirm: "DELETE" }` | ✅ L.9: not admins, not the only member of a store; memberships, tickets, Cognito logins, then USER# rows; 3 an hour |
| Merchant | `POST /merchant/create-store` `{storeName, storeSlug}` (any signed-in user, P.3) | ✅ draft with no plan (`NONE`) + the caller as ADMIN in one transaction; 404 `PROFILE_NOT_FOUND`, 403 `ACCOUNT_DEACTIVATED`, 409 `SLUG_TAKEN` / `ALREADY_IN_A_STORE` (one store per account, any role, P.11; replaced the 5-draft cap), 5/account/hour → 429 |
| Merchant | `GET /merchant/path` | ❌ template stub (unused; per-store numbers are `/store/overview`) |
| Store customers (L.7 / 7.1) | `GET /store/customers/list/:storeId` (store members) | ✅ `{customers: StoreCustomer[], partial}`: everyone with a paid order, most recent first, ≤ 5,000; built by `recordCustomerOrder` on paid and on refund sync |
| Reviews (L.7 / 7.5) | `GET`/`POST /customer/review` (`X-Order-Token`), `GET /store/public/reviews/:storeId`, `GET /store/reviews/list/:storeId`, `PUT /store/reviews/reply`, `POST /store/reviews/report` (members), `GET /admin/get-review-reports`, `POST /admin/decide-review-report` | ✅ verified buyers only (the order's token), one per order, live at once; members reply and report (once), never edit or remove; admins KEEP / REMOVE; stats move with what's published |
| Rewards (L.7 / 7.2–7.4) | `POST /customer/rewards/request-code`, `POST /customer/rewards/verify`, `GET /customer/rewards/account/:storeId` and `POST /customer/rewards/sign-out` (`X-Rewards-Token`); `redeemRewards` on `/customer/quote` and `/customer/create-order` | ✅ 6-digit code: hashed, 10 min, single use, 5 guesses (counted before comparing); per-email limits in the table, per-IP in memory; same answer with or without points; points spent in the order's transaction, earned once when paid, refunds follow |
| Store overview (L.6) | `GET /store/overview/:storeId?tz=<IANA>` (store members) | ✅ `StoreOverviewStats` (`layers/core/store-stats`): today / last 7 / previous 7 (orders, sales net of refunds, average, per currency), 7 days, 30-day best sellers; paid orders on their paid day in `tz` (else UTC); ≤ 3,000 newest orders (`partial`); 30 s cache |
| Customer (5.4) | `POST /customer/create-order` `{storeId, currency, fulfilment, lines, expectedTotalMinor, customer:{name,email,phone?}, address?, note?}` (no auth, guest) | ✅ re-quotes (delivery taxed on its postal code), Checkout Session on the store's connected account (direct charge, `application_fee_amount` from the copied commission, never `automatic_tax`), saves the order `PENDING_PAYMENT` + pointer → `{orderId, orderCode, checkoutUrl, statusToken, totalMinor, currency}`; 409 `PRICE_CHANGED` / `CART_INVALID` (with `quote`) / `PAYMENTS_UNAVAILABLE` / `DELIVERY_COUNTRY` / `BELOW_MINIMUM`; 404 store errors; 503/502; 10/IP/10 min |
| Payments (5.2) | `POST /store/payments/create-connect-account-link` `{storeId, country?}` → `{url, expiresAt}` (store admins); `GET /store/payments/status/:storeId` (members) | ✅ Standard account created once per store (`country` CA/US/AU required the first time; idempotency key), fresh onboarding link per call returning to `/store/storefront/:storeId?payments=return\|refresh`; status reads Stripe, refreshes the cached flags, forgets a disconnected account. 503 `PAYMENTS_NOT_CONFIGURED`, 502 `STRIPE_ERROR`. `payments` lives in its own SETTINGS attribute; public responses get only `paymentsEnabled` |
| Go Live (P.4) | `GET /store/go-live/checklist/:storeId` (members), `POST /store/go-live` `{storeId, plan}` (store ADMINs), `GET /store/public/plans` (no auth) | ✅ checklist steps STORE_NAME / ITEMS / FULFILMENT / PAYMENTS (Stripe live), plans in the billing currency; Go Live re-checks everything, then `runSmartStoreValidation` (L.2 AI check: 90 s deadline, fails closed to IN_REVIEW, 5/store/day → 429 `RATE_LIMITED`, admin email) → a Billing `checkoutUrl` (P.5; the webhook takes it live), LIVE only on a plan an admin gave, or IN_REVIEW (admin-only `review`); plan must be one of `STORE_PLANS`; 409 `PLAN_NOT_AVAILABLE` while `PAID_PLANS_ENABLED` is off |
| Billing (P.5) | `GET /store/billing/status/:storeId` (members), `POST /store/billing/portal` `{storeId}` (the payer only; switch plans, card, cancel), webhook `POST /api/v1/billing/stripe-webhook` | ✅ Stripe Billing on the platform account with `automatic_tax`; Go Live returns `checkoutUrl` and the webhook takes it live; every event re-syncs the subscription from Stripe (`layers/payments/subscription-sync`, rules in `layers/core/billing`); cancelled → at the period's end, failed payment → 7 days' grace, then the plan ENDS: a live store goes back to DRAFT (`pausedReason: PLAN_ENDED`); hourly grace sweep; plans behind `PAID_PLANS_ENABLED`. No separate upgrade checkout (removed with the Free plan, P.10) |
| Payments (5.5) | `POST /api/v1/payments/stripe-connect-webhook` (Stripe, Connect events) | ✅ raw body before `express.json()`, signed with `webhookSecret`; only the order's own account and session/PaymentIntent touch it; session completed (paid) / async succeeded → `markOrderPaid` (one transaction: PAID, tracked stock by item or variant row, `storeOrderCount` +1, `APP / ORDER#…` sale; out of stock → PAID + `storeOrderStockShortfall`); expired / async failed → CANCELLED; `charge.refunded` / `charge.refund.updated` / `refund.*` → the order's refunds re-read from Stripe (`syncOrderRefunds`, 6.4b: failed refunds stop counting, `storeOrderFailedRefunds`); `charge.dispute.*` onto the order; `account.updated` → payments flags; event ids in `STRIPE_EVENT#<id>` |
| Store orders (6.1) | `GET /store/orders/list/:storeId?status=&from=&to=&cursor=&limit=` (store members) | ✅ newest first, `MerchantOrderSummary` rows, default all but PENDING_PAYMENT, cursor = last sort key |
| Store orders (6.2) | `GET /store/orders/get/:storeId/:orderId` (store members) | ✅ `MerchantOrderView` (no token hash); other store's = 404 `ORDER_NOT_FOUND` |
| Store orders (6.3) | `PUT /store/orders/update-status` `{storeId, orderId, status, fromStatus}` (store members) | ✅ forward only (`nextOrderStatuses`), conditional on `fromStatus`, `storeOrderStatusHistory`; 409 `INVALID_TRANSITION` / `STATUS_CHANGED` {order}; cancelling a paid order = refund (6.4) |
| Store orders (6.4) | `POST /store/orders/refund` `{storeId, orderId, amountMinor, refundedMinor, reason?}` (store ADMINs) | ✅ part or full refund on the connected account (`layers/payments/order-refund.ts`; platform keeps its fee), only from the refunded total seen (409 `REFUND_CHANGED`), idempotent on it; then the order's refunds are synced from Stripe (`syncOrderRefunds`), all of it → REFUNDED, each refund in `storeOrderRefunds`; 409 `NOT_REFUNDABLE` / `AMOUNT_TOO_LARGE` / `ORDER_DISPUTED` / `INSUFFICIENT_BALANCE` {order}; 503 / 502. Stock isn't put back |
| Emails (6.5) | `layers/notifications/order-emails.ts` (templates in `order-email-templates.ts`) | ✅ best effort, never throws: receipt with a PDF (`receipt-pdf.ts`) on first PAID (webhook / sweeper), new-order alert to every member and the store's contact email (`storeInfo.emailOrderAlerts`, default on), pickup READY / delivery SHIPPED, each refund rise (`syncOrderRefunds`), review decisions to store ADMINs; shopper emails are "<Store> via Ceseelia", Reply-To the store, with a per-email `#t=` order link (`storeOrderLinkTokenHashes`, accepted by order-status); the store's `storeInfo.taxNumber` on receipts |
| Background (5.7) | `sweepLostOrders` every 10 min (`index.ts`) | ✅ orders listed under `APP_PENDING_ORDER` whose checkout ended: asks Stripe (session, then PaymentIntent) → PAID (missed webhook) / CANCELLED `PAYMENT_EXPIRED` or `PAYMENT_FAILED` / kept while a delayed payment is processing |
| AI store check (L.2) | `layers/core/store-validation/`; `GET /admin/get-item-review-queue`, `POST /admin/review-item` `{storeId, itemId, decision: APPROVE\|REJECT}` | ✅ rule checks + Claude Opus 5.5 (all item text, ≤ 50 photos by risk, 150 items a request); live stores: create-item queues a check, `sweepItemChecks` every minute (fingerprint skips stock-only saves), flagged items (`storeItemReview` FLAGGED/REJECTED) are hidden from public data and quotes and emailed to `ADMIN_ALERT_EMAIL`; merchants get the status, not the reasons; 409 `REVIEW_CHANGED`. Eval: `scripts/store-check-eval` |
| Store orders (L.5) | `GET /store/orders/new/:storeId?since=<ms>` (store members) | ✅ `{orders: OrderAlert[], now}`: alerts written after `since` (cut to a day), newest first, ≤ 20; no `since` = `{orders: [], now}` |
| Web push (L.5 / 6.7) | `GET /user/push/config`, `POST /user/push/subscribe` `{endpoint, keys}`, `POST /user/push/unsubscribe` `{endpoint}`, `POST /user/push/test` (signed-in) | ✅ VAPID keys in the stage secret (`scripts/setup-vapid.mjs`); endpoints must be a known push service (400 `PUSH_ENDPOINT_NOT_ALLOWED`); 503 `PUSH_NOT_CONFIGURED`; members' browsers get a push per new paid order (`layers/notifications/order-alerts.ts`, `web-push.ts`) |
| Messages (L.10) | Store (members): `GET /store/messages/list/:storeId?filter=all\|unread&cursor=`, `GET …/unread/:storeId`, `GET …/thread/:storeId/:conversationId?before=\|after=`, `POST …/send`, `POST …/read`, `GET …/image-upload-urls/:storeId/:conversationId/:png/:jpg`, `POST …/report`. Shopper (`X-Conversation-Token`): `POST /customer/messages/start` (Contact us), `GET /customer/messages/thread/:storeId/:conversationId`, `POST …/send`, `POST …/read`, `GET …/image-upload-urls/…`. Admins: `GET /admin/get-message-reports`, `POST /admin/decide-message-report` | ✅ async chat store ↔ shopper (`layers/aws/dynamodb/dynamo-entities/conversation`, `layers/core/messages`, `layers/notifications/message-notify.ts`): one conversation per order (shopper's order token) plus inquiries from Contact us (own token, emailed link); text ≤ 2,000 and ≤ 4 photos (`store/<id>/messages/<conversationId>/`); paginated inbox (20) and messages (30, `older` cursor, `after` polls); push to members on a shopper message, store email if unread 30 min (`storeInfo.emailMessageAlerts`, default on), shopper email on a reply (once until read); no message text in emails; report → admin DISMISS / BLOCK. `contact-store` (email) kept but the webapp no longer uses it |
| Customer (6.6) | `GET /customer/order-status/:orderId` + header `X-Order-Token` (no auth) | ✅ the checkout's token or an emailed one (6.5); the shopper's view (no Stripe ids, fee, commission); wrong token = unknown = 404 `ORDER_NOT_FOUND`; 60/IP/min |

Infra helpers ready to reuse: SES `sendEmail` / `sendEmailWithAttachments` (sender names made
header-safe by `senderName`) + templates, Secrets Manager CRUD, Route53 subdomain records, S3
helpers, the in-process DQS queue. `GET /healthz` (no auth, any host) for Docker and nginx.

## 5. Known issues & risks

Open:
1. Adding an existing account to a store (1.4) sends no email; only invites to new emails do.
2. The store check costs two reads per request (user id by Cognito id, then the membership).
   Fine for now; cache or put the user id in a token claim if it shows up in latency.
3. The password that used to be in `node/README.md` is still in **git history** — make sure it has
   been rotated (S.2).
4. Rewards redemption method has two spellings: the backend default is `POINTS_TO_*`, the webapp
   saves `REWARDS_REDEMPTION_*`. The validator accepts both. → unify in Stage 7.3
5. ~~`certbot-renew.sh` paths~~ fixed 2026-11-14 (S.17); the cron line on the server needs
   `/bin/bash` in front (owner).
6. `getClientIp` returns a hard-coded Australian IP in dev (intentional for testing currency), so
   in dev a Canada delivery's tax estimate always falls back to the store's province.
7. 109 → 78 legacy lint warnings; CI only fails on errors until 9.7 clears them.

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
  SPARK (25 CAD/AUD, 19 USD a month; commission 1.95 CAD/AUD, 1.45 USD), NOVA (49 CAD/AUD,
  39 USD; commission 0.95 CAD/AUD, 0.75 USD), LUMINA (79 CAD/AUD, 65 USD; no Ceseelia
  commission; Stage Q, 2026-11-17). All unlimited, all with custom domains. No trials. Only
  `layers/core/plans` holds the numbers (`STORE_PLANS` is cheapest first; `planRank`). Only a store with a plan is LIVE; going live and subscribing are one step.
- Anyone signed in can create a store (DRAFT, plan `NONE`) and build it; its members preview it,
  shoppers see "Coming soon"; only LIVE stores take orders.
  `admin.isStoreLive` becomes `admin.suspended` (admin suspension is separate from DRAFT/LIVE).
- Go Live re-checks the checklist on the server and calls **`runSmartStoreValidation(storeId)`**
  (AI fraud check of the store's items, built in L.2): a flagged store goes to IN_REVIEW and the
  admin queue instead of LIVE.
- Subscriptions use Stripe **Billing on the platform account** (not Connect), with Stripe Tax on
  for Ceseelia's own GST/HST. Merchants switch plans in the portal (up: now, prorated; down: at the period's end). Cancel → live until
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
      `charge.refunded` / `charge.dispute.*` onto the order; our own refund route
      (`/store/orders/refund`, progress 6.4) refunds on the connected account.
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
    **Secrets** live in ONE AWS Secrets Manager secret per stage (`APP_SECRET_ID`, default
    `ceseelia/<STAGE>`, flat keys `stripeSecretKey`, `stripeWebhookSecret`,
    `stripeBillingWebhookSecret`, `anthropicApiKey`; `layers/aws/secret-manager/app-secrets.ts`),
    read once; never in `.env` or git. The prod server runs as `CeseeliaServerRole` (`iam/`). Dev refuses a live key; prod refuses
    to start without a usable key (`checkStripeConfig` in `index.ts`).
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
