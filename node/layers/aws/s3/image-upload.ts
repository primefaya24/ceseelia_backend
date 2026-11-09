// Image uploads (progress.md 2.3). Every image upload goes through here:
// - only png / jpg (jpeg is the same thing);
// - a presigned POST, so S3 itself enforces the size (≤ 5 MB), the content type and the key;
// - each upload is tagged `ceseelia-upload=pending`. A bucket lifecycle rule (in
//   ../ceseelia_cloudformation) deletes pending objects after a day, so uploads that never get
//   saved don't pile up. Saving an entity calls `markImagesKept` on the images it references
//   *before* the database write, so an image that's in use is never left pending.
import { IMAGE_CACHE_CONTROL } from "../../core/http/cache";
import { DeleteObjectTaggingCommand, S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import * as ULID from "ulid";
import { appConstants } from "../../../constants";
import { S3_STORAGE_BUCKET_NAME } from "../../../config";

const s3Client = new S3Client({ region: appConstants.DEFAULT_REGION });

export const IMAGE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_UPLOAD_EXPIRY_SECONDS = 15 * 60;
export const UPLOAD_PENDING_TAG_KEY = "ceseelia-upload";
export const UPLOAD_PENDING_TAG_VALUE = "pending";
const PENDING_TAGGING = `<Tagging><TagSet><Tag><Key>${UPLOAD_PENDING_TAG_KEY}</Key><Value>${UPLOAD_PENDING_TAG_VALUE}</Value></Tag></TagSet></Tagging>`;

export type ImageType = "png" | "jpg";
const CONTENT_TYPE: Record<ImageType, string> = { png: "image/png", jpg: "image/jpeg" };

/* `png`, `jpg` or `jpeg` (any case) → the stored type; anything else → null. */
export function parseImageType(raw: unknown): ImageType | null {
  if (typeof raw !== "string") return null;
  const t = raw.toLowerCase();
  if (t === "png") return "png";
  if (t === "jpg" || t === "jpeg") return "jpg";
  return null;
}

/* A path count: digits only, 0–99. Anything else → null. */
export function parseUploadCount(raw: unknown): number | null {
  return typeof raw === "string" && /^\d{1,2}$/.test(raw) ? Number(raw) : null;
}

/* What the client posts: `url` with `fields` (then the file, as `file`, last). `key` is saved. */
export interface ImageUpload {
  key: string;
  url: string;
  fields: Record<string, string>;
}

/* One upload slot under `folder` (which ends with `/`). */
export async function createImageUpload(folder: string, type: ImageType): Promise<ImageUpload> {
  const key = `${folder}${ULID.ulid()}.${type}`;
  const contentType = CONTENT_TYPE[type];
  const { url, fields } = await createPresignedPost(s3Client, {
    Bucket: S3_STORAGE_BUCKET_NAME,
    Key: key,
    Conditions: [
      ["content-length-range", 1, IMAGE_UPLOAD_MAX_BYTES],
      ["eq", "$Content-Type", contentType],
      ["eq", "$tagging", PENDING_TAGGING],
      ["eq", "$Cache-Control", IMAGE_CACHE_CONTROL],
    ],
    // Cache-Control (3.2): keys are unique per upload, so browsers and CDNs may keep it a year
    Fields: { "Content-Type": contentType, tagging: PENDING_TAGGING, "Cache-Control": IMAGE_CACHE_CONTROL },
    Expires: IMAGE_UPLOAD_EXPIRY_SECONDS,
  });
  return { key, url, fields };
}

/* Several slots, grouped by type, in the shape the webapp already reads. */
export async function createImageUploads(
  folder: string,
  pngCount: number,
  jpgCount: number
): Promise<{ png: ImageUpload[]; jpg: ImageUpload[] }> {
  const [png, jpg] = await Promise.all([
    Promise.all(Array.from({ length: pngCount }, () => createImageUpload(folder, "png"))),
    Promise.all(Array.from({ length: jpgCount }, () => createImageUpload(folder, "jpg"))),
  ]);
  return { png, jpg };
}

/*
 * Clear the pending tag on images an entity is about to reference, so the lifecycle rule keeps
 * them. Call it before the database write: if the write then fails, the image is just a kept
 * orphan (the folder cleanup removes it on the next save). Keys outside `store/` and blanks are
 * ignored; a key with no object (an old or already-cleared one) is fine. Any other error throws,
 * so the save fails instead of saving a reference to an image that will be deleted.
 */
export async function markImagesKept(keys: Array<string | null | undefined>): Promise<void> {
  const unique = [...new Set(keys.filter((k): k is string => typeof k === "string" && k.startsWith("store/")))];
  await Promise.all(
    unique.map(async (Key) => {
      try {
        await s3Client.send(new DeleteObjectTaggingCommand({ Bucket: S3_STORAGE_BUCKET_NAME, Key }));
      } catch (e) {
        const name = (e as { name?: string })?.name;
        if (name === "NoSuchKey" || name === "NotFound") return;
        throw e;
      }
    })
  );
}
