import { promises as dnsPromises } from "dns";
import { CUSTOM_DOMAIN_TARGET, CUSTOM_DOMAINS_ENABLED, STAGE } from "../../config";
import {
  CERT_WAIT_MS,
  CustomDomainReason,
  CustomDomainStatus,
  DISABLED_KEEP_MS,
  DNS_WAIT_MS,
  certificateState,
  pointsAtUs,
  tenantName,
} from "../core/custom-domain";
import { setLiveCustomDomains } from "../core/store-url";
import {
  StoreDomain,
  createStoreDomain,
  finishTenantCleanup,
  getStoreDomain,
  listDomainIndex,
  listTenantCleanups,
  queueTenantCleanup,
  removeStoreDomain,
  saveStoreDomain,
  setCleanupCertificate,
} from "../aws/dynamodb/dynamo-entities/domain";
import { getStoreAdminSettings } from "../aws/dynamodb/dynamo-entities/store";
import { getStoreOverviewRow } from "../aws/dynamodb/dynamo-entities/membership";
import {
  DomainInUseError,
  createTenant,
  deleteCertificate,
  deleteTenant,
  getTenant,
  getTenantCertificate,
  setTenantEnabled,
} from "../aws/cloudfront/tenants";
import { log } from "../core/logger";

/*
 * Stores' own domains (9.8 phase 2): the steps between the states in `layers/core/custom-domain`.
 * `advanceDomain` does one step for one domain (setup and "Check now" call it at once; the sweep
 * every minute); `sweepCustomDomains` also deletes removed domains' tenants and refreshes the
 * in-memory list of live domains that links and CORS use.
 */

/** The CNAME targets `host` has right now ([] when none, or DNS doesn't answer). */
export async function lookupCname(host: string): Promise<string[]> {
  const resolver = new dnsPromises.Resolver({ timeout: 3000, tries: 2 });
  try {
    return await resolver.resolveCname(host);
  } catch {
    return [];
  }
}

/** A store keeps its domain while it has a plan (any status but "no plan"). */
async function storeHasPlan(storeId: string): Promise<boolean> {
  const s = await getStoreAdminSettings(storeId);
  return !!s && s.lifecycle.plan !== "NONE";
}

const withState = (d: StoreDomain, now: number, patch: Partial<StoreDomain>): StoreDomain => ({ ...d, ...patch, updatedAt: Math.max(now, d.updatedAt + 1) });

/** Turn a domain's tenant off/on, returning false while CloudFront is still applying a change. */
async function setEnabled(tenantId: string, enabled: boolean): Promise<boolean> {
  const t = await getTenant(tenantId);
  if (!t.exists) return true;
  if (t.enabled === enabled) return true;
  await setTenantEnabled(tenantId, t.etag, enabled);
  return true;
}

export type AdvanceResult = { domain: StoreDomain | null; changed: boolean };

/**
 * One step for one domain. Returns the domain as saved (null when it was removed) and whether
 * anything changed. Saving is conditional on the record not having changed meanwhile.
 */
export async function advanceDomain(d: StoreDomain, now: number, deps = { lookupCname, storeHasPlan }): Promise<AdvanceResult> {
  const hasPlan = await deps.storeHasPlan(d.storeId);
  let next: StoreDomain = d;

  if (!hasPlan && (d.status === "PENDING_DNS" || d.status === "PENDING_CERT" || d.status === "ACTIVE")) {
    // The plan ended: a live domain goes off (kept 30 days); one still being set up is dropped.
    if (d.status === "ACTIVE" && d.tenantId) {
      await setEnabled(d.tenantId, false);
      next = withState(d, now, { status: "DISABLED", reason: "PLAN_ENDED", disabledAt: now, stepAt: now });
    } else {
      await removeStoreDomain(d, now);
      return { domain: null, changed: true };
    }
  } else if (d.status === "PENDING_DNS") {
    const seen = await deps.lookupCname(d.host);
    if (pointsAtUs(seen)) {
      try {
        const name = tenantName(STAGE, d.storeId, now);
        const { tenantId } = await createTenant(name, d.host);
        next = withState(d, now, { status: "PENDING_CERT", reason: null, dnsSeen: seen, tenantId, tenantName: name, stepAt: now, checkedAt: now });
      } catch (e) {
        if (!(e instanceof DomainInUseError)) throw e;
        next = withState(d, now, { reason: "IN_USE", dnsSeen: seen, checkedAt: now });
      }
    } else if (now - d.stepAt > DNS_WAIT_MS) {
      next = withState(d, now, { status: "FAILED", reason: "DNS_TIMEOUT", dnsSeen: seen, checkedAt: now });
    } else {
      const reason: CustomDomainReason = seen.length ? "DNS_WRONG_TARGET" : "DNS_NOT_FOUND";
      const same = reason === d.reason && seen.join() === d.dnsSeen.join();
      next = same ? d : withState(d, now, { reason, dnsSeen: seen, checkedAt: now });
    }
  } else if (d.status === "PENDING_CERT" && d.tenantId) {
    const [tenant, cert] = await Promise.all([getTenant(d.tenantId), getTenantCertificate(d.tenantId)]);
    const state = certificateState(cert.status);
    const arn = cert.arn ?? d.certificateArn;
    if (!tenant.exists || state === "FAILED" || now - d.stepAt > CERT_WAIT_MS) {
      if (tenant.exists) await queueTenantCleanup(d.tenantId, arn, now);
      next = withState(d, now, {
        status: "FAILED",
        reason: state === "FAILED" || !tenant.exists ? "CERT_FAILED" : "CERT_TIMEOUT",
        tenantId: null,
        tenantName: null,
        certificateArn: null,
        checkedAt: now,
      });
    } else if (state === "ISSUED" && tenant.domainActive) {
      next = withState(d, now, { status: "ACTIVE", reason: null, certificateArn: arn, activeAt: now, checkedAt: now });
    } else if (arn !== d.certificateArn) {
      next = withState(d, now, { certificateArn: arn, checkedAt: now });
    }
  } else if (d.status === "DISABLED") {
    if (hasPlan && d.tenantId) {
      await setEnabled(d.tenantId, true);
      next = withState(d, now, { status: "ACTIVE", reason: null, disabledAt: null, stepAt: now });
    } else if (now - (d.disabledAt ?? d.stepAt) > DISABLED_KEEP_MS) {
      await removeStoreDomain(d, now);
      return { domain: null, changed: true };
    }
  }

  if (next === d) return { domain: d, changed: false };
  const saved = await saveStoreDomain(d, next);
  if (!saved) {
    // Someone else changed it first (a remove, a retry): a tenant created here isn't theirs.
    if (next.tenantId && next.tenantId !== d.tenantId) await queueTenantCleanup(next.tenantId, null, now);
    return { domain: await getStoreDomain(d.storeId), changed: true };
  }
  return { domain: next, changed: true };
}

/** A new domain: saved, then checked at once (the merchant may have added the CNAME already). */
export async function startDomain(storeId: string, host: string, now = Date.now()): Promise<StoreDomain> {
  const d = await createStoreDomain(storeId, host, now);
  const r = await advanceDomain(d, now).catch((e) => {
    log.warn({ err: e, storeId }, "[domains] first check failed");
    return { domain: d, changed: false };
  });
  if (r.changed) await refreshLiveDomains().catch(() => {});
  return r.domain ?? d;
}

/** "Check now" / "Try again": a failed domain starts waiting for DNS again; then one step. */
export async function recheckDomain(d: StoreDomain, now = Date.now()): Promise<StoreDomain | null> {
  let current = d;
  if (d.status === "FAILED") {
    const restarted = withState(d, now, { status: "PENDING_DNS", reason: "DNS_NOT_FOUND", dnsSeen: [], stepAt: now });
    if (!(await saveStoreDomain(d, restarted))) return getStoreDomain(d.storeId);
    current = restarted;
  }
  const r = await advanceDomain(current, now);
  if (r.changed) await refreshLiveDomains().catch(() => {});
  return r.domain;
}

export async function removeDomain(d: StoreDomain, now = Date.now()): Promise<void> {
  await removeStoreDomain(d, now);
  await refreshLiveDomains().catch(() => {});
}

/** The live domains, as links and CORS see them (host → the store's current slug). */
export async function refreshLiveDomains(): Promise<number> {
  const live = (await listDomainIndex()).filter((r) => r.status === "ACTIVE");
  const rows = await Promise.all(
    live.map(async (r) => {
      const overview = await getStoreOverviewRow(r.storeId).catch(() => null);
      const slug = typeof overview?.storeSlug === "string" ? overview.storeSlug : "";
      return slug ? { host: r.host, slug } : null;
    })
  );
  const list = rows.filter((r): r is { host: string; slug: string } => r !== null);
  setLiveCustomDomains(list);
  return list.length;
}

/** Removed domains' tenants: disable, wait for CloudFront, delete; then the certificate. */
async function cleanUpTenants(now: number): Promise<number> {
  let done = 0;
  for (const c of await listTenantCleanups()) {
    try {
      const t = await getTenant(c.tenantId);
      if (t.exists) {
        if (!c.certificateArn) {
          const cert = await getTenantCertificate(c.tenantId);
          if (cert.arn) await setCleanupCertificate(c.tenantId, cert.arn);
          c.certificateArn = cert.arn;
        }
        if (t.enabled) await setTenantEnabled(c.tenantId, t.etag, false);
        else if (t.deployed) await deleteTenant(c.tenantId, t.etag);
        continue; // the next sweep sees the result
      }
      if (c.certificateArn && !(await deleteCertificate(c.certificateArn))) continue;
      await finishTenantCleanup(c.tenantId);
      done++;
    } catch (e) {
      log.warn({ err: e, tenantId: c.tenantId, ageMs: now - c.createdAt }, "[domains] tenant clean-up failed, will retry");
    }
  }
  return done;
}

/** Every minute: one step for each domain, the clean-ups, then the live list. */
export async function sweepCustomDomains(now = Date.now()): Promise<{ changed: number; failed: number; cleaned: number; live: number }> {
  if (!CUSTOM_DOMAINS_ENABLED) return { changed: 0, failed: 0, cleaned: 0, live: 0 };
  let changed = 0;
  let failed = 0;
  for (const row of await listDomainIndex()) {
    if (row.status === "FAILED") continue;
    try {
      const d = await getStoreDomain(row.storeId);
      if (!d) continue;
      const r = await advanceDomain(d, now);
      if (r.changed) {
        changed++;
        log.info({ storeId: d.storeId, host: d.host, from: d.status, to: r.domain?.status ?? "REMOVED" }, "[domains] status");
      }
    } catch (e) {
      failed++;
      log.warn({ err: e, storeId: row.storeId }, "[domains] step failed, will retry");
    }
  }
  const cleaned = await cleanUpTenants(now);
  const live = await refreshLiveDomains();
  return { changed, failed, cleaned, live };
}

/** What the store's settings screen shows. */
export function domainView(d: StoreDomain | null) {
  return {
    domain: d
      ? {
          host: d.host,
          status: d.status as CustomDomainStatus,
          reason: d.reason,
          dnsSeen: d.dnsSeen,
          createdAt: d.createdAt,
          checkedAt: d.checkedAt,
          activeAt: d.activeAt,
          disabledAt: d.disabledAt,
        }
      : null,
    target: CUSTOM_DOMAIN_TARGET,
    available: CUSTOM_DOMAINS_ENABLED,
  };
}
