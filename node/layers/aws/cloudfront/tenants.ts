import {
  CloudFrontClient,
  CreateDistributionTenantCommand,
  DeleteDistributionTenantCommand,
  GetDistributionTenantCommand,
  GetManagedCertificateDetailsCommand,
  UpdateDistributionTenantCommand,
} from "@aws-sdk/client-cloudfront";
import { ACMClient, DeleteCertificateCommand } from "@aws-sdk/client-acm";
import { CUSTOM_DOMAIN_CONNECTION_GROUP_ID, CUSTOM_DOMAIN_DISTRIBUTION_ID } from "../../../config";

/*
 * CloudFront distribution tenants for stores' own domains (9.8 phase 2), on the multi-tenant
 * distribution from the CloudFormation stack. CloudFront and ACM are global services in
 * us-east-1. The server's role may only touch tenants of that distribution
 * (CloudFormation `CustomDomainServerPolicy`).
 */

const cloudfront = new CloudFrontClient({ region: "us-east-1" });
const acm = new ACMClient({ region: "us-east-1" });

export class DomainInUseError extends Error {
  constructor() {
    super("CloudFront already serves this domain elsewhere.");
    this.name = "DomainInUseError";
  }
}

/** A tenant for `host`, with a certificate CloudFront requests and validates over HTTP. */
export async function createTenant(name: string, host: string): Promise<{ tenantId: string }> {
  try {
    const r = await cloudfront.send(
      new CreateDistributionTenantCommand({
        DistributionId: CUSTOM_DOMAIN_DISTRIBUTION_ID,
        Name: name,
        Domains: [{ Domain: host }],
        ...(CUSTOM_DOMAIN_CONNECTION_GROUP_ID ? { ConnectionGroupId: CUSTOM_DOMAIN_CONNECTION_GROUP_ID } : {}),
        Enabled: true,
        ManagedCertificateRequest: {
          ValidationTokenHost: "cloudfront",
          PrimaryDomainName: host,
          CertificateTransparencyLoggingPreference: "enabled",
        },
      })
    );
    const id = r.DistributionTenant?.Id;
    if (!id) throw new Error("CloudFront returned no tenant id");
    return { tenantId: id };
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === "CNAMEAlreadyExists" || name === "InvalidAssociation") throw new DomainInUseError();
    throw e;
  }
}

export interface TenantState {
  exists: boolean;
  enabled: boolean;
  /** "Deployed" once CloudFront has applied the last change. */
  deployed: boolean;
  domainActive: boolean;
  etag: string;
}

export async function getTenant(tenantId: string): Promise<TenantState> {
  try {
    const r = await cloudfront.send(new GetDistributionTenantCommand({ Identifier: tenantId }));
    const t = r.DistributionTenant;
    return {
      exists: !!t,
      enabled: t?.Enabled === true,
      deployed: t?.Status === "Deployed",
      domainActive: (t?.Domains ?? []).some((d) => d.Status === "active"),
      etag: r.ETag ?? "",
    };
  } catch (e) {
    if ((e as { name?: string })?.name === "EntityNotFound") {
      return { exists: false, enabled: false, deployed: true, domainActive: false, etag: "" };
    }
    throw e;
  }
}

/** The tenant's managed certificate: CloudFront's status and its ARN once requested. */
export async function getTenantCertificate(tenantId: string): Promise<{ status: string | undefined; arn: string | null }> {
  try {
    const r = await cloudfront.send(new GetManagedCertificateDetailsCommand({ Identifier: tenantId }));
    const d = r.ManagedCertificateDetails;
    return { status: d?.CertificateStatus, arn: d?.CertificateArn ?? null };
  } catch (e) {
    if ((e as { name?: string })?.name === "EntityNotFound") return { status: undefined, arn: null };
    throw e;
  }
}

export async function setTenantEnabled(tenantId: string, etag: string, enabled: boolean): Promise<void> {
  await cloudfront.send(new UpdateDistributionTenantCommand({ Id: tenantId, IfMatch: etag, Enabled: enabled }));
}

export async function deleteTenant(tenantId: string, etag: string): Promise<void> {
  await cloudfront.send(new DeleteDistributionTenantCommand({ Id: tenantId, IfMatch: etag }));
}

/** Delete an ACM certificate no tenant uses any more. False while it's still in use (try later). */
export async function deleteCertificate(arn: string): Promise<boolean> {
  try {
    await acm.send(new DeleteCertificateCommand({ CertificateArn: arn }));
    return true;
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === "ResourceNotFoundException") return true;
    if (name === "ResourceInUseException") return false;
    throw e;
  }
}
