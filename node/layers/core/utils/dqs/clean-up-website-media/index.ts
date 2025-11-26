import {deleteS3Keys} from "../../../../aws/s3";
import {getWebsiteDataVersions} from "../../../../aws/dynamodb/dynamo-entities/website/admin";
import {appConstants} from "../../../../../constants";
import {DB_TABLE_NAME, S3_STORAGE_BUCKET_NAME} from "../../../../../config";
import {dynamoWriteManyItems} from "../../../../aws/dynamodb/dynamo-batch-ops";

export async function cleanUpWebsiteMedia(websiteId: string): Promise<void> {
    try {
        // Fetch recent data versions
        const allWebsiteDataVersions: any[] = await getWebsiteDataVersions(websiteId);

        // List current website media
        const currentMediaKeys = [];
        for (let allWebsiteDataVersion of allWebsiteDataVersions) {
            if (allWebsiteDataVersion?.websiteData?.photoGallery?.imageUris?.length > 0) {
                for (let imageUri of allWebsiteDataVersion.websiteData.photoGallery.imageUris) {
                    currentMediaKeys.push(imageUri);
                }
            }
        }

        // Fetch actual media keys listed under website
        const actualMediaKeys = allWebsiteDataVersions.length > 0 ? allWebsiteDataVersions[0].websiteData.photoGallery.imageUris : [];

        // Generate media deletion key list
        const deletionMediaKeys = currentMediaKeys.filter(element => !actualMediaKeys.includes(element));
        const uniqueDeletionMediaKeys = [...new Set(deletionMediaKeys)];


        // Delete irrelevant media
        if (uniqueDeletionMediaKeys.length > 0) {
            await deleteS3Keys(S3_STORAGE_BUCKET_NAME, uniqueDeletionMediaKeys);
        }

        // Delete previous website data versions
        let websiteDataVersionItemsToDelete = [];
        for (let i = 1; i < allWebsiteDataVersions.length; i++) {
            websiteDataVersionItemsToDelete.push({
                DeleteRequest: {
                    Key: {
                        "pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + allWebsiteDataVersions[i].websiteId,
                        "sk": appConstants.DYNAMO_ENTITY_DATA + "#" + allWebsiteDataVersions[i].websiteDataCreatedAt,
                    },
                }
            });
        }
        if (websiteDataVersionItemsToDelete.length > 0) {
            await dynamoWriteManyItems(DB_TABLE_NAME, websiteDataVersionItemsToDelete);
        }
    }
    catch (err) {
        console.error("In dqs: cleanUpWebsiteMedia", err);
    }
}