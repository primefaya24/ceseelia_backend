# Ceseelia Backend — Progress Tracker

_Last reviewed: 2026-11-08 (full codebase read-through)_

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

| Area | Status | Notes |
|---|---|---|
| Foundations (config, token verification, CORS, tests, lint) | ✅ Done | Stage 0, 2026-11-02 |
| Store create / settings / images | ✅ Works | Admin-only for now (S.0) until store membership (1.3) |
| Categories & items CRUD | ✅ Works | Item counts are wrong; deleting a category orphans its items |
| Public storefront data | ⚠️ Partial | Leaks admin settings and inactive items |
| Store delete | ❌ Stub | Returns 200 and does nothing |
| Users / registration | ❌ Broken | No user record is ever created, so `get-my-profile` fails for new sign-ups |
| Store membership (user ↔ store) | ❌ Missing | |
| Merchant / customer APIs | ❌ Missing | Only template stubs exist |
| Cart, checkout, orders, payments | ❌ Not started | Stripe webhook returns 501 |
| Admin stats, join requests, tickets | ❌ Not started | |
| Production readiness (logging, rate limits, CI, IaC) | ❌ Not started | |

**Health check (2026-11-08):** `npm test` 27/27 passing · `npm run typecheck` clean ·
`npm run lint` 0 errors, 109 warnings · `npm audit --omit=dev` reports **high** advisories
(axios, body-parser, brace-expansion, fast-xml-parser, @smithy/*), all fixable.

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
- [ ] 🔴 **S.1 Revoke the hard-coded Google Maps API key** in `layers/core/utils/index.ts`
      (`getLatLngTimezoneData`). It is in git history, so treat it as public: revoke or restrict it
      in Google Cloud, then delete the function (nothing calls it).
- [ ] 🔴 **S.2 Rotate the old password** that used to be in `node/README.md`. It's still in git
      history (manual step, carried over from Stage 0).
- [ ] 🟠 **S.3 Patch dependencies:** `npm audit fix`, re-run tests. Remove unused deps
      (`axios`, `jwt-decode`, `mustache-express`, `nodemailer`, `https`, `cookie-parser` if
      unused). Fewer deps means less attack surface.

### S.B — Request validation & data integrity
- [ ] 🟠 **S.4 ID validation helper.** Add `isUlid(id)` and use it in `pureRequestParams` for every
      `storeId`, `storeCategoryId`/`categoryId` and `storeItemId`/`itemId`, in both path params and
      body. Right now those values are put straight into DynamoDB keys and S3 prefixes
      (`store/${storeId}/…`) with no checks.
- [ ] 🟠 **S.5 No more blind upserts.**
  - [ ] a. `updateStoreSettings`: add `ConditionExpression: attribute_exists(pk)`. Without it,
        a PUT with a made-up `storeId` creates a junk `SETTINGS` row.
  - [ ] b. `updateStoreCategory` / `updateStoreItem`: on `isUpdate=false`, ignore any
        client-supplied id and use `attribute_not_exists`. On `isUpdate=true`, require the id and
        use `attribute_exists`. Today `isUpdate=false` plus an existing id silently overwrites a record.
  - [ ] c. Check that the store exists (its `SETTINGS` row) before creating a category or item.
  - [ ] d. Tests for each case.
- [ ] 🟠 **S.6 Run S3 cleanup only after the DB write succeeds**, in `category/create` and
      `inventory/create-item`. They currently delete "unused" images before the write. The same bug
      was fixed for update-settings in Stage 0.
- [ ] 🟠 **S.7 Fix the batch helper so it reports failures.** `dynamoWriteManyItems` uses
      `Promise.allSettled` and never throws, so `createStore` (and `registerUser`) return success even
      when the write failed or items were left unprocessed. Throw when a batch is rejected or
      `unprocessed > 0`. Also, `dynamGetManyItems` only returns the first batch's results.
- [ ] 🟠 **S.8 Paginate `getStoreInventoryData`.** Queries stop at 1 MB, so a large store silently
      loses categories and items. Loop on `LastEvaluatedKey`, as `getAllStores` already does.
- [ ] 🟡 **S.9 Tighten the validators** (`layers/core/interfaces/store`):
  - [ ] a. Max lengths on every string (names, descriptions, slogan, hashtags, labels, options).
  - [ ] b. Numbers: price ≥ 0, stock is an integer ≥ -1, item/category discount 0–100, priority
        is one of `PRIORITY_*`.
  - [ ] c. Array caps: images per item (e.g. ≤ 10), hashtags, custom params, options, promo images,
        currencies.
  - [ ] d. Image URIs must start with the right store prefix (`store/<storeId>/images/logo/`,
        `…/item/<itemId>/images/`, and so on). Today a merchant can point at another store's files.
  - [ ] e. Social links must be empty or `https?://` URLs. Email must look like an email.
        WhatsApp must be digits.
  - [ ] f. Exactly one `currencyIsDefault`, and currency codes are ISO-4217 from an allow-list.
  - [ ] g. `customize`: validate the t0 shape (colors are hex, URIs as in d) and cap its
        serialized size. Today it's an unchecked `any`.
  - [ ] h. `storeParamOptions` must be non-empty strings.
- [ ] 🟡 **S.10 Validate `userPreferredLocale`** in `get-my-profile/:locale` against an allow-list
      before writing it.
- [ ] 🟡 **S.11 Make `delete-user` consistent.** It deletes the Cognito user but leaves the DB
      records (that code is commented out). Either disable the route until 1.1/1.2 or finish it:
      delete the DB rows and memberships, refuse while the user is the only member of a live store,
      then delete from Cognito last.

### S.C — Hardening
- [ ] 🟡 **S.12 Move identity off `req.body`.** The wrapper writes `cognito_id`, `is_user_admin`
      and `cognito_token` into the client-controlled body. On a public (`withAuth=false`) route a
      client could send `is_user_admin: true` itself. Put identity in `res.locals.auth`, remove
      `cognito_token` (nothing reads it, and it could end up in logs), and update the routes.
- [ ] 🟡 **S.13 Make the client IP trustworthy.** Change `app.set('trust proxy', true)` to `1`
      (one nginx hop), and have `getClientIp` use `req.ip` instead of the raw `cf-connecting-ip` /
      `x-forwarded-for` headers, which clients can spoof. Rate limiting (9.2) depends on this.
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
- [ ] a. Decide: Cognito **Post Confirmation Lambda** (recommended, always runs) or
      `POST /user/register` called by the webapp after the first sign-in.
- [ ] b. Implement it. Read email and `email_verified` from the **verified token / Cognito event**,
      never from the request body.
- [ ] c. `registerUser` links a new Cognito identity to an existing user just because the email
      matches. Only link when `email_verified === true`, or an unverified federated identity could
      take over an account.
- [ ] d. Fallback: `get-my-profile` creates the record on first call if it's missing.
- [ ] e. Return a clear `404 PROFILE_NOT_FOUND` instead of a generic 500 when there's still no
      record. (WA 1.1)
- [ ] f. Tests.

### 1.2 Membership data model
- [ ] a. Write `STORE#<storeId>` / `MEMBER#<userId>` (`StoreMember`) and the reverse
      `USER#<userId>` / `STORE#<storeId>` (store id, name, slug, role), in one transaction.
- [ ] b. Entity helpers: `addStoreMember`, `removeStoreMember`, `listStoreMembers(storeId)`,
      `listUserStores(userId)`, `getMembership(storeId, userId)`.
- [ ] c. `get-my-profile` returns `stores: [{storeId, storeName, storeSlug, role}]` (replaces
      `userStoreIds`). (WA 1.2)
- [ ] d. Tests.

### 1.3 Store access check (replaces S.0)
- [ ] a. `assertStoreAccess(req, storeId, role?)`. Admin bypasses it; otherwise it reads
      `getMembership` and returns 403 if there's none.
- [ ] b. Apply it to **every** `/store/**` route (settings, uploads, categories, items, get-data),
      then remove `STORE_ROUTES_ADMIN_ONLY` (S.0) from `layers/core/http` and the routes
      (`create` and `delete` stay admin-only). Update `tests/store-access.test.ts`.
- [ ] c. Route-matrix test: no token → 401 · non-member → 403 · member → 200 · admin → 200.

### 1.4 Admin member management
- [ ] a. `GET /admin/get-store-members/:storeId`
- [ ] b. `POST /admin/assign-store-member` (by email; if there's no account, store a pending invite
      and email it via SES)
- [ ] c. Turn a pending invite into a membership on registration (1.1)
- [ ] d. `DELETE /admin/remove-store-member/:storeId/:userId`
- [ ] e. Tests. (WA 1.4)

### 1.5 Merchant overview
- [ ] Replace the `/merchant/path` stub with `GET /merchant/get-overview-data`: the merchant's
      stores plus headline counters from `StoreOverview`. (WA 1.2)

### 1.6 Admin-only store settings
- [ ] a. `PUT /admin/update-store-admin-settings` (`salesCommission` ≥ 0, `isStoreLive`).
- [ ] b. Keep `admin` out of the merchant `update-settings` (already ignored) and the merchant
      `get-data` response. (WA 1.5)

### 1.7 Store delete (admin)
- [ ] a. Query and batch-delete every `STORE#<id>` item (settings, categories, items, members,
      and later orders).
- [ ] b. Delete the `APP_STORE` overview row, the reverse `USER#…/STORE#…` rows and the slug
      reservation (1.8).
- [ ] c. `deleteS3FilesPrefixed('store/<id>/')`.
- [ ] d. Make it idempotent (safe to retry) and admin-only. Tests. (WA 1.4)

### 1.8 Slugs
- [ ] a. Slug format rule (lowercase `a-z0-9-`, 3–40 chars, reserved words blocked).
- [ ] b. Reserve `SLUG#<slug>` → storeId with a conditional put, in a transaction with
      create / `update-store-info`. Release the old slug on rename. Return 409 on conflict.
- [ ] c. `GET /store/public/resolve-slug/:slug`. (WA 3.1)

---

## 4. Stage 2 — Inventory hardening

- [ ] 🟠 **2.1 Correct category item counts.** Stop resetting `storeCategoryItemCount` to 0 on
      every category save. Use an atomic `ADD` on item create, delete and category moves (in a
      transaction with the item write). One-off script to recompute existing counts. (WA 2.1)
- [ ] 🟠 **2.2 Category delete rule.** Reject with 409 when the category still has items (enforced
      server-side; today only the UI checks). Document the rule. (WA 2.1)
- [ ] 🟡 **2.3 Upload limits:**
  - [ ] a. Validate `imageType` and cap counts (≤ 10 total) on promo and item upload routes.
        Today `pngCount=100000` mints 100k URLs.
  - [ ] b. Switch to **presigned POST** with `content-length-range` (e.g. ≤ 5 MB) and a fixed
        `Content-Type`. A presigned PUT can't cap file size.
  - [ ] c. Item upload: check the item belongs to the store (or is being created).
  - [ ] d. S3 lifecycle rule to expire uploads that never get referenced. (WA 2.3)
- [ ] 🟠 **2.4 Public data endpoint:**
  - [ ] a. Strip `settings.admin` and any other private fields. Commission is currently public.
  - [ ] b. Return only active items in active categories.
  - [ ] c. 404 when the store doesn't exist. 404/410 (`STORE_UNAVAILABLE`) when
        `isStoreLive === false`.
  - [ ] d. Tests. (WA 3.1)
- [ ] 🟡 **2.5 Price model.** Decide on integer minor units per currency (fixed per-currency price
      vs. conversion), add `storeItemPrices` if per-currency, migrate existing items. (WA 2.4)
- [ ] 🟡 **2.6 Stock rules:** `-1` = unlimited, `≥ 0` = tracked. Document it and validate it
      (S.9b). Stock goes down on paid orders in 5.5. (WA 2.5)

---

## 5. Stage 3 — Public storefront API

- [ ] 3.1 `GET /store/public/storefront/:slug` → settings, categories and active items (wraps 1.8
      and 2.4). (WA 3.1)
- [ ] 3.2 Cache headers (`Cache-Control`, `ETag`) on public endpoints, and CloudFront in front of
      the API's public paths and the storage bucket.
- [ ] 3.3 `GET /store/public/item/:storeId/:itemId` for deep links. (WA 3.5)
- [ ] 3.4 `POST /customer/contact-store`: validate input, rate-limit (needs 9.2 / S.13), bot check
      (honeypot or captcha), SES to the store's email with the customer email as reply-to (never as
      the From address). (WA 3.3)

---

## 6. Stage 4 — Cart & pricing service

- [ ] 4.1 A pure pricing function `priceLines(store, lines, currency)`: item, category and store
      discounts, custom-param validation, stock checks. Heavy unit tests.
- [ ] 4.2 Tax and delivery settings: extend `StoreSettings.general` (`taxRate`, pickup/delivery
      flags, delivery fee/zones), `initStoreSettings` and the validators. (WA 4.4)
- [ ] 4.3 `POST /customer/quote` (public, rate-limited) returns validated lines, totals and errors
      per line. (WA 4.3)

---

## 7. Stage 5 — Checkout, orders & payments

- [ ] 5.1 Decision: **Stripe Connect Express** (recommended). Record it in `CLAUDE.md`.
- [ ] 5.2 Merchant onboarding:
  - [ ] a. `POST /store/payments/create-connect-account-link`
  - [ ] b. `GET /store/payments/status/:storeId`
  - [ ] c. Save `stripeAccountId` in the admin block. (WA 5.4)
- [ ] 5.3 Order model: `StoreOrderStatus` enum replaces the boolean
      (`PENDING_PAYMENT → PAID → PREPARING → READY/SHIPPED → COMPLETED`, `CANCELLED`, `REFUNDED`).
- [ ] 5.4 `POST /customer/create-order`:
  - [ ] a. Re-quote with 4.1. Never trust client prices.
  - [ ] b. Write `ORDER#<ts>#<id>` as `PENDING_PAYMENT`.
  - [ ] c. Create a Checkout Session with the connected account and `application_fee_amount`,
        plus an idempotency key.
  - [ ] d. Return the URL and an order-status token. (WA 5.2)
- [ ] 5.5 Webhook rewrite:
  - [ ] a. Verify the signature with the platform secret, keeping the raw body.
  - [ ] b. Respond 2xx fast. Store processed event ids for idempotency.
  - [ ] c. Handle `checkout.session.completed`, `expired` and `payment_intent.payment_failed`.
- [ ] 5.6 On paid:
  - [ ] a. Mark the order `PAID`.
  - [ ] b. Conditional stock decrement. If stock ran out, flag the order for refund.
  - [ ] c. Bump the overview counters.
  - [ ] d. Write `APP / ORDER#ts#STORE#id` for admin graphs.
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
- [ ] 6.6 `GET /customer/order-status/:orderId?token=…` (signed, expiring token). (WA 5.3)
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
- [ ] 8.2 Merchant join requests:
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
| 2026-11-08 | S.0 done: all authenticated `/store/**` routes are admin-only; 27 route-access tests added. |
| 2026-11-08 | File created from a full code review. Added Stage S (security and bug fixes) and broke stages 1–9 into sub-tasks. |
| 2026-11-02 | Stage 0 completed (see `CLAUDE.md`). |
