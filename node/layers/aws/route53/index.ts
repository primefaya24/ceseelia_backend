// Imports
import {
    ChangeResourceRecordSetsCommand,
    ChangeResourceRecordSetsCommandInput,
    ChangeResourceRecordSetsCommandOutput,
    Route53Client,
} from "@aws-sdk/client-route-53";
import {
    CheckDomainAvailabilityCommand,
    CheckDomainAvailabilityCommandOutput,
    RegisterDomainCommand,
    RegisterDomainCommandInput,
    RegisterDomainCommandOutput,
    Route53DomainsClient,
} from "@aws-sdk/client-route-53-domains";
import {appConstants} from "../../../constants";

// Clients
const route53Client: Route53Client = new Route53Client({
    region: appConstants.DEFAULT_REGION,
});
const route53Domains: Route53DomainsClient = new Route53DomainsClient({
    region: appConstants.DEFAULT_REGION,
});

/*
 * Check domain availability
 */
export async function checkDomainAvailability(domain: string): Promise<boolean> {
    const command: CheckDomainAvailabilityCommand = new CheckDomainAvailabilityCommand({
        DomainName: domain,
    });

    const data: CheckDomainAvailabilityCommandOutput = await route53Domains.send(command);
    return data.Availability === 'AVAILABLE';
}

/*
 * Register new domain
 */
export async function registerDomain(): Promise<RegisterDomainCommandOutput> {
    const params: RegisterDomainCommandInput = {
        AdminContact: {
            AddressLine1: 'STRING_VALUE',
            AddressLine2: 'STRING_VALUE',
            City: 'STRING_VALUE',
            ContactType: "PERSON",
            CountryCode: "US",
            Email: 'STRING_VALUE',
            Fax: 'STRING_VALUE',
            FirstName: 'STRING_VALUE',
            LastName: 'STRING_VALUE',
            OrganizationName: 'STRING_VALUE',
            PhoneNumber: 'STRING_VALUE',
            State: 'STRING_VALUE',
            ZipCode: 'STRING_VALUE',
        },
        DomainName: 'STRING_VALUE',
        DurationInYears: 1,
        RegistrantContact: {
            AddressLine1: 'STRING_VALUE',
            AddressLine2: 'STRING_VALUE',
            City: 'STRING_VALUE',
            ContactType: "PERSON",
            CountryCode: "US",
            Email: 'STRING_VALUE',
            Fax: 'STRING_VALUE',
            FirstName: 'STRING_VALUE',
            LastName: 'STRING_VALUE',
            OrganizationName: 'STRING_VALUE',
            PhoneNumber: 'STRING_VALUE',
            State: 'STRING_VALUE',
            ZipCode: 'STRING_VALUE',
        },
        TechContact: {
            AddressLine1: 'STRING_VALUE',
            AddressLine2: 'STRING_VALUE',
            City: 'STRING_VALUE',
            ContactType: "PERSON",
            CountryCode: "US",
            Email: 'STRING_VALUE',
            Fax: 'STRING_VALUE',
            FirstName: 'STRING_VALUE',
            LastName: 'STRING_VALUE',
            OrganizationName: 'STRING_VALUE',
            PhoneNumber: 'STRING_VALUE',
            State: 'STRING_VALUE',
            ZipCode: 'STRING_VALUE',
        },
        AutoRenew: true,
        PrivacyProtectAdminContact: true,
        PrivacyProtectRegistrantContact: true,
        PrivacyProtectTechContact: true,
    };

    const command: RegisterDomainCommand = new RegisterDomainCommand(params);
    return await route53Domains.send(command);
}

/*
 * Point domain to CloudFront distribution
 */
export async function createSubdomainRecord(
    websiteId: string,
    subdomain: string,
    cloudfrontDomain: string
): Promise<ChangeResourceRecordSetsCommandOutput> {
    const params: ChangeResourceRecordSetsCommandInput = {
        ChangeBatch: {
            Changes: [
                {
                    Action: "CREATE",
                    ResourceRecordSet: {
                        AliasTarget: {
                            DNSName: cloudfrontDomain,
                            EvaluateTargetHealth: false,
                            HostedZoneId: "Z2FDTNDATAQYW2", // CloudFront hosted zone ID
                        },
                        Name: subdomain,
                        Type: "A",
                    },
                },
            ],
            Comment: `Subdomain for websiteId: ${websiteId}`,
        },
        HostedZoneId: appConstants.ROUTE_53_APP_HOSTED_ZONE,
    };

    const command: ChangeResourceRecordSetsCommand = new ChangeResourceRecordSetsCommand(params);
    return await route53Client.send(command);
}

/*
 * Delete Route53 subdomain record
 */
export async function deleteSubdomainRecord(
    websiteId: string,
    subdomain: string,
    cloudfrontDomain: string
): Promise<ChangeResourceRecordSetsCommandOutput> {
    try {
        const params: ChangeResourceRecordSetsCommandInput = {
            ChangeBatch: {
                Changes: [
                    {
                        Action: "DELETE",
                        ResourceRecordSet: {
                            AliasTarget: {
                                DNSName: cloudfrontDomain,
                                EvaluateTargetHealth: false,
                                HostedZoneId: "Z2FDTNDATAQYW2", // CloudFront hosted zone ID
                            },
                            Name: subdomain,
                            Type: "A",
                        },
                    },
                ],
                Comment: `Deleting subdomain for websiteId: ${websiteId}`,
            },
            HostedZoneId: appConstants.ROUTE_53_APP_HOSTED_ZONE,
        };

        const command: ChangeResourceRecordSetsCommand = new ChangeResourceRecordSetsCommand(params);
        return await route53Client.send(command);
    } catch (error) {
        console.error("Error deleting subdomain record:", error);
        throw error;
    }
}
