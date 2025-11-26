// Imports
import {
    S3Client,
    GetObjectCommand,
    PutObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    DeleteObjectCommand,
    DeleteObjectsCommand,
    CopyObjectCommand,
    HeadObjectCommandOutput,
    PutObjectCommandInput,
    DeleteObjectsCommandInput,
    ObjectIdentifier
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {appConstants} from "../../../constants";
import {Readable} from "node:stream";

const s3Client = new S3Client({
    region: appConstants.DEFAULT_REGION,
});

export async function getObjectMetadata(bucket: string, key: string): Promise<HeadObjectCommandOutput> {
    const command = new HeadObjectCommand({ Bucket: bucket, Key: key });
    return await s3Client.send(command);
}

export async function putObject(bucket: string, key: string, contentType: string, content: Buffer | string): Promise<void> {
    const command: PutObjectCommandInput = {
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
        Body: content
    };
    await s3Client.send(new PutObjectCommand(command));
}

export async function getUploadSignedUrl(bucket: string, key: string, contentType: string): Promise<string> {
    const command = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType });
    return await getSignedUrl(s3Client, command, { expiresIn: appConstants.S3_UPLOAD_URL_EXPIRY_SECONDS });
}

export async function getDownloadSignedUrl(bucket: string, key: string): Promise<string> {
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    return await getSignedUrl(s3Client, command, { expiresIn: appConstants.S3_DOWNLOAD_URL_EXPIRY_SECONDS });
}

export async function objectExists(bucket: string, key: string): Promise<boolean> {
    try {
        await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
    } catch (e: any) {
        return e.name !== 'NotFound';
    }
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
    const chunks: any[] = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

export async function getObject(
    bucket: string,
    key: string,
    targetFileType: 'Buffer' | 'String' = 'Buffer'
): Promise<Buffer | string | any[]> {
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    const response = await s3Client.send(command);
    if (!response.Body) throw new Error("No response body");

    const stream = response.Body as Readable;
    const buffer = await streamToBuffer(stream);

    if (targetFileType === 'Buffer') return buffer;
    if (targetFileType === 'String') return buffer.toString();
    return [buffer];
}

export async function getObjectBuffer(bucket: string, key: string): Promise<Buffer> {
    return await getObject(bucket, key, 'Buffer') as Buffer;
}

export async function getObjectBase64(bucket: string, key: string): Promise<string> {
    const buffer = await getObject(bucket, key, 'Buffer') as Buffer;
    return buffer.toString('base64');
}

export async function listPrefixFiles(bucket: string, prefix: string): Promise<any[]> {
    let list: any[] = [];
    let continuationToken: string | undefined = undefined;
    do {
        const command = new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken });
        const response: any = await s3Client.send(command);
        if (response.Contents) list.push(...response.Contents);
        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
    return list;
}

export async function deleteObject(bucket: string, key: string): Promise<void> {
    await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export async function deleteS3Files(bucket: string, files: ObjectIdentifier[]): Promise<void> {
    const params: DeleteObjectsCommandInput = {
        Bucket: bucket,
        Delete: {
            Objects: files,
        },
    };
    await s3Client.send(new DeleteObjectsCommand(params));
}

export async function deleteS3Keys(bucket: string, keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const files: ObjectIdentifier[] = keys.map(key => ({ Key: key }));
    await deleteS3Files(bucket, files);
}

export async function deleteS3FilesPrefixed(bucket: string, prefix: string): Promise<void> {
    const objects = await listPrefixFiles(bucket, prefix);
    const files: ObjectIdentifier[] = objects.map(obj => ({ Key: obj.Key! }));
    if (files.length > 0) await deleteS3Files(bucket, files);
}

export async function deleteS3FilesPrefixedExcept(bucket: string, prefix: string, included: { imageKey: string }[] = []): Promise<void> {
    const objects = await listPrefixFiles(bucket, prefix);
    const includedKeys = included.map(i => i.imageKey);
    const filesToDelete: ObjectIdentifier[] = objects
        .filter(obj => !includedKeys.includes(obj.Key!))
        .map(obj => ({ Key: obj.Key! }));

    if (filesToDelete.length > 0) await deleteS3Files(bucket, filesToDelete);
}

export async function copyFiles(sourceBucket: string, sourcePrefix: string, destinationBucket: string, destinationPrefix: string): Promise<void> {
    const objects = await listPrefixFiles(sourceBucket, sourcePrefix);
    const copyPromises = objects.map(obj => {
        const sourceKey = obj.Key!;
        const destinationKey = destinationPrefix + sourceKey.substring(sourcePrefix.length);
        const command = new CopyObjectCommand({
            Bucket: destinationBucket,
            CopySource: `${sourceBucket}/${sourceKey}`,
            Key: destinationKey
        });
        return s3Client.send(command);
    });
    await Promise.allSettled(copyPromises);
}

export async function getAndroidEnterpriseServiceAccount(): Promise<Record<string, any>> {
    const content = await getObject(appConstants.SECRET_STORAGE_BUCKET!, "eem/service-account.json", 'String');
    return JSON.parse(content as string);
}
