import {
    SecretsManagerClient,
    CreateSecretCommand,
    PutSecretValueCommand,
    GetSecretValueCommand,
    DeleteSecretCommand,
} from "@aws-sdk/client-secrets-manager";

const client = new SecretsManagerClient({
    region: process.env.AWS_REGION || "us-east-1",
});

/**
 * Create a new secret
*/
export async function kmsCreateSecret(secretId: string, secretObject: Record<string, any>) {
    try {
        const command = new CreateSecretCommand({
            Name: secretId,
            SecretString: JSON.stringify(secretObject),
        });
        return await client.send(command);
    } catch (error: any) {
        if (error.name === "ResourceExistsException") {
            throw new Error(`Secret with ID "${secretId}" already exists.`);
        }
        throw error;
    }
}

/**
 * Update (overwrite) an existing secret value
*/
export async function kmsUpdateSecret(secretId: string, secretObject: Record<string, any>) {
    try {
        const command = new PutSecretValueCommand({
            SecretId: secretId,
            SecretString: JSON.stringify(secretObject),
        });
        return await client.send(command);
    } catch (error) {
        throw error;
    }
}

/**
 * Fetch secret
*/
export async function kmsGetSecret(secretId: string): Promise<Record<string, any> | null> {
    try {
        const command = new GetSecretValueCommand({ SecretId: secretId });
        const response = await client.send(command);

        if (response.SecretString) {
            return JSON.parse(response.SecretString);
        }
        return null;
    } catch (error) {
        console.error("Secrets Manager can't find the specified secret.");
        return null;
    }
}

/**
 * Delete secret
*/
export async function kmsDeleteSecret(secretId: string, forceDelete = false) {
    try {
        const command = new DeleteSecretCommand({
            SecretId: secretId,
            ForceDeleteWithoutRecovery: forceDelete,
            RecoveryWindowInDays: forceDelete ? undefined : 7,
        });
        return await client.send(command);
    } catch (error) {
        throw error;
    }
}
