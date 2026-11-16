import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { CloudFrontClient, GetDistributionTenantCommand, UpdateDistributionTenantCommand } from "@aws-sdk/client-cloudfront";
import { setTenantEnabled, useTenantCertificate } from "../layers/aws/cloudfront/tenants";

const cf = mockClient(CloudFrontClient);
const current = {
  ETag: "E9",
  DistributionTenant: {
    Id: "dt_1",
    DistributionId: "EDIST",
    ConnectionGroupId: "cg_1",
    Domains: [{ Domain: "shop.example.com", Status: "inactive" as const }],
    Customizations: { Certificate: { Arn: "arn:old" } },
    Enabled: true,
  },
};

describe("CloudFront tenant updates keep the tenant's configuration (9.8 phase 2)", () => {
  beforeEach(() => {
    cf.reset();
    cf.on(GetDistributionTenantCommand).resolves(current);
    cf.on(UpdateDistributionTenantCommand).resolves({});
  });

  it("switching the certificate sends domains, distribution and connection group too", async () => {
    await useTenantCertificate("dt_1", "arn:new");
    const input = cf.commandCalls(UpdateDistributionTenantCommand)[0].args[0].input;
    expect(input).toMatchObject({
      Id: "dt_1",
      IfMatch: "E9",
      DistributionId: "EDIST",
      ConnectionGroupId: "cg_1",
      Domains: [{ Domain: "shop.example.com" }],
      Customizations: { Certificate: { Arn: "arn:new" } },
      Enabled: true,
    });
  });

  it("turning a tenant off keeps its certificate and domains", async () => {
    await setTenantEnabled("dt_1", "ignored", false);
    const input = cf.commandCalls(UpdateDistributionTenantCommand)[0].args[0].input;
    expect(input).toMatchObject({
      Enabled: false,
      Domains: [{ Domain: "shop.example.com" }],
      Customizations: { Certificate: { Arn: "arn:old" } },
    });
  });
});
