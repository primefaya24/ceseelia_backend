import { CUSTOM_DOMAIN_TARGET } from "../../../config";

/*
 * Stores' own domains (9.8 phase 2): the rules, without I/O.
 *
 * A store (paid plan, store ADMIN) sets one subdomain of a domain it owns, `shop.theirbrand.com`.
 * The merchant adds a CNAME to CUSTOM_DOMAIN_TARGET (`domains.ceseelia.com`); once our DNS
 * check sees it, the API creates a CloudFront distribution tenant for the name with a
 * certificate CloudFront requests and renews (HTTP validation), and the domain goes live.
 *
 *   PENDING_DNS  → waiting for the CNAME (checked every minute, for 7 days)
 *   PENDING_CERT → tenant created, certificate being issued (up to 72 hours)
 *   ACTIVE       → serving; links, previews and CORS use it
 *   DISABLED     → the plan ended: the tenant is off; back on with a plan, removed after 30 days
 *   FAILED       → DNS never pointed here, or the certificate failed; "Try again" restarts
 *
 * Requiring the CNAME before creating anything means only someone who controls the domain's DNS
 * can claim it, and no certificate request hangs on a name that doesn't point at us.
 */

export type CustomDomainStatus = "PENDING_DNS" | "PENDING_CERT" | "ACTIVE" | "DISABLED" | "FAILED";

/** Why a domain is waiting, failed or off (the webapp words them). */
export type CustomDomainReason =
  | "DNS_NOT_FOUND" // no CNAME seen yet
  | "DNS_WRONG_TARGET" // a CNAME, to somewhere else
  | "IN_USE" // CloudFront already serves the name elsewhere
  | "DNS_TIMEOUT" // 7 days without the CNAME
  | "CERT_FAILED" // the certificate couldn't be issued
  | "CERT_TIMEOUT" // 72 hours without a certificate
  | "PLAN_ENDED"; // DISABLED until the store has a plan again

export const DNS_WAIT_MS = 7 * 24 * 3600_000;
export const CERT_WAIT_MS = 72 * 3600_000;
export const DISABLED_KEEP_MS = 30 * 24 * 3600_000;

export type HostError = "INVALID" | "APEX" | "OURS";

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Names that are never a store's: ours, and the clouds a CNAME could point into. */
const NOT_ALLOWED_SUFFIXES = ["ceseelia.com", "cloudfront.net", "amazonaws.com", "localhost"];

/** `https://Shop.Example.com/` → `shop.example.com` (what people paste), or "" when it isn't a host. */
export function normalizeHost(input: string): string {
  let h = input.trim().toLowerCase();
  h = h.replace(/^[a-z]+:\/\//, "");
  h = h.split(/[/?#]/)[0];
  h = h.replace(/:\d+$/, "").replace(/\.$/, "");
  return h;
}

/**
 * A host a store can use, or why not. It must be a subdomain (at least three labels:
 * `shop.example.com`); a bare domain can't hold a CNAME, so the DNS check would never pass
 * anyway (`example.co.uk` has three labels and fails there instead).
 */
export function hostError(host: string): HostError | null {
  if (!host || host.length > 253) return "INVALID";
  const labels = host.split(".");
  if (labels.some((l) => !LABEL.test(l))) return "INVALID";
  if (/^\d+$/.test(labels[labels.length - 1])) return "INVALID"; // an IP address
  if (NOT_ALLOWED_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) return "OURS";
  if (labels.length < 3) return "APEX";
  return null;
}

/** Does a CNAME answer point at us? (trailing dots and case don't matter) */
export function pointsAtUs(cnames: string[], target: string = CUSTOM_DOMAIN_TARGET): boolean {
  const t = target.toLowerCase().replace(/\.$/, "");
  return !!t && cnames.some((c) => c.toLowerCase().replace(/\.$/, "") === t);
}

/** A CloudFront tenant name for a store's domain: unique, and readable in the console. */
export function tenantName(stage: string, storeId: string, now: number): string {
  return `cs-${stage}-${storeId.toLowerCase()}-${now.toString(36)}`;
}

export type CertificateState = "PENDING" | "ISSUED" | "FAILED";

/** CloudFront's managed certificate status, in our three states. */
export function certificateState(status: string | undefined): CertificateState {
  if (status === "issued") return "ISSUED";
  if (status === "failed" || status === "validation-timed-out" || status === "expired" || status === "revoked") return "FAILED";
  return "PENDING";
}
