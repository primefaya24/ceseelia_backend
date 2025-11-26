import {
    CloudFrontClient,
    CreateDistributionCommand,
    DeleteDistributionCommand,
    GetDistributionConfigCommand,
    UpdateDistributionCommand,
    CreateInvalidationCommand,
    GetDistributionConfigCommandOutput,
    UpdateDistributionCommandInput,
    DeleteDistributionCommandInput,
    CreateDistributionCommandInput,
    CreateInvalidationCommandInput, GetDistributionConfigCommandInput, DistributionConfig
} from "@aws-sdk/client-cloudfront";
import { ulid } from "ulid";
import {appConstants} from "../../../constants";
import {STAGE} from "../../../config";

// AWS CloudFront client
const cloudfrontClient: CloudFrontClient = new CloudFrontClient({
    region: appConstants.DEFAULT_REGION,
});

/**
 * Get CloudFront distribution config
 */
export async function getCfDistributionConfig(
    distributionId: string
): Promise<GetDistributionConfigCommandOutput> {
    try {
        const params: GetDistributionConfigCommandInput = {
            Id: distributionId
        };
        const command: GetDistributionConfigCommand = new GetDistributionConfigCommand(params);
        return await cloudfrontClient.send(command);
    } catch (e) {
        console.error("In getCfDistributionConfig", e);
        throw new Error("Could not get CloudFront distribution configs");
    }
}

/**
 * Create a new CloudFront distribution
 */
export async function createCfDistribution(
    websiteId: string,
    alternateDomain: string,
    rootPath: string = "",
    defaultRootObject: string = "index.html",
    errorPathObject: string = "/error/index.html"
): Promise<any> {
    try {
        const callerReferenceId: string = ulid();
        const targetOriginId: string = ulid();

        const params: CreateDistributionCommandInput = {
            DistributionConfig: {
                CallerReference: callerReferenceId,
                Comment: `Web Distribution for website: ${websiteId}`,
                DefaultCacheBehavior: {
                    TargetOriginId: targetOriginId,
                    ViewerProtocolPolicy: "redirect-to-https",
                    AllowedMethods: {
                        Items: ["GET", "HEAD"],
                        Quantity: 2,
                        CachedMethods: {
                            Items: ["GET", "HEAD"],
                            Quantity: 2
                        }
                    },
                    CachePolicyId: appConstants.CF_HOSTING_CACHE_POLICY_ID
                },
                Enabled: true,
                Origins: {
                    Items: [
                        {
                            Id: targetOriginId,
                            DomainName: `primesync-networking-${STAGE}.s3.us-east-1.amazonaws.com`,
                            OriginPath: rootPath.length > 0 ? `/${rootPath}` : "",
                            S3OriginConfig: {
                                OriginAccessIdentity: ""
                            },
                            OriginAccessControlId: ""
                        }
                    ],
                    Quantity: 1
                },
                Aliases: {
                    Items: [alternateDomain],
                    Quantity: 1
                },
                CustomErrorResponses: {
                    Quantity: 2,
                    Items: [
                        {
                            ErrorCode: 400,
                            ErrorCachingMinTTL: 300,
                            ResponseCode: "200",
                            ResponsePagePath: errorPathObject
                        },
                        {
                            ErrorCode: 403,
                            ErrorCachingMinTTL: 300,
                            ResponseCode: "200",
                            ResponsePagePath: errorPathObject
                        }
                    ]
                },
                DefaultRootObject: defaultRootObject,
                IsIPV6Enabled: true,
                PriceClass: "PriceClass_100",
                ViewerCertificate: {
                    ACMCertificateArn: appConstants.CF_HOSTING_VIEWER_CERTIFICATE,
                    SSLSupportMethod: "sni-only"
                }
            }
        };

        const command: CreateDistributionCommand = new CreateDistributionCommand(params);
        return await cloudfrontClient.send(command);
    } catch (e) {
        console.error("In createCfDistribution", e);
        throw new Error("Could not create CloudFront distribution");
    }
}

/**
 * Disable a CloudFront distribution
 */
export async function disableCfDistribution(distributionId: string): Promise<void> {
    try {
        const currentDistributionConfig: GetDistributionConfigCommandOutput = await getCfDistributionConfig(distributionId);
        const etag: string = currentDistributionConfig.ETag as string;
        const config: DistributionConfig = currentDistributionConfig.DistributionConfig!;
        config.Enabled = false;

        const disableParams: UpdateDistributionCommandInput = {
            Id: distributionId,
            IfMatch: etag,
            DistributionConfig: config
        };

        const disableCommand: UpdateDistributionCommand = new UpdateDistributionCommand(disableParams);
        await cloudfrontClient.send(disableCommand);
    } catch (e) {
        console.error("In disableCfDistribution", e);
        throw new Error("Could not disable CloudFront distribution");
    }
}

/**
 * Delete a CloudFront distribution
 */
export async function deleteCfDistribution(distributionId: string): Promise<void> {
    try {
        const currentDistributionConfig: GetDistributionConfigCommandOutput = await getCfDistributionConfig(distributionId);
        const etag: string = currentDistributionConfig.ETag as string;

        const deleteParams: DeleteDistributionCommandInput = {
            Id: distributionId,
            IfMatch: etag
        };

        const deleteCommand: DeleteDistributionCommand = new DeleteDistributionCommand(deleteParams);
        await cloudfrontClient.send(deleteCommand);
    } catch (e) {
        console.error("In deleteCfDistribution", e);
        throw new Error("Could not delete CloudFront distribution");
    }
}

/**
 * Update the alternate domain (CNAME) of a distribution
 */
export async function updateCfDistributionAlternateDomain(
    distributionId: string,
    alternateDomain: string
): Promise<void> {
    try {
        const currentDistributionConfig: GetDistributionConfigCommandOutput = await getCfDistributionConfig(distributionId);
        const etag: string = currentDistributionConfig.ETag as string;
        const config: DistributionConfig = currentDistributionConfig.DistributionConfig!;
        config.Aliases = {
            Items: [alternateDomain],
            Quantity: 1
        };

        const params: UpdateDistributionCommandInput = {
            Id: distributionId,
            IfMatch: etag,
            DistributionConfig: config
        };

        const command: UpdateDistributionCommand = new UpdateDistributionCommand(params);
        await cloudfrontClient.send(command);
    } catch (e) {
        console.error("In updateCfDistributionAlternateDomain", e);
        throw new Error("Could not update CloudFront distribution alternate domain");
    }
}

/**
 * Invalidate a CloudFront distribution cache
 */
export async function invalidateCFDistribution(distributionId: string): Promise<void> {
    try {
        const input: CreateInvalidationCommandInput = {
            DistributionId: distributionId,
            InvalidationBatch: {
                Paths: {
                    Quantity: 1,
                    Items: ["/*"]
                },
                CallerReference: ulid()
            }
        };

        const command: CreateInvalidationCommand = new CreateInvalidationCommand(input);
        await cloudfrontClient.send(command);
    } catch (e) {
        console.error("In invalidateCFDistribution", e);
        throw new Error("Could not invalidate CloudFront distribution");
    }
}
