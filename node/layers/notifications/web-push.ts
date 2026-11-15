import webpush, { WebPushError } from "web-push";
import { readAppSecretString } from "../aws/secret-manager/app-secrets";
import {
  deletePushSubscription,
  listPushSubscriptions,
  PushSubscriptionRecord,
} from "../aws/dynamodb/dynamo-entities/push";
import { log } from "../core/logger";

/*
 * Web push (progress.md L.5 / BE 6.7): standard Web Push with VAPID, straight to the browsers'
 * push services (no Firebase). Keys are in the stage secret: `vapidPublicKey` and
 * `vapidPrivateKey` (`scripts/setup-vapid.mjs` makes and stores them). Without them push is
 * off: `pushPublicKey()` is null, the webapp hides the switch, and nothing is sent.
 *
 * The server POSTs to whatever endpoint a browser gave it, so only the real push services are
 * accepted (`isAllowedPushEndpoint`), on save and again on send: an endpoint can never point
 * the server at an internal address. Payloads are encrypted for the browser and hold no shopper
 * details (order code, total, store name).
 */
export interface PushPayload {
  title: string;
  body: string;
  /** Path in the webapp the notification opens. */
  url: string;
  /** Same tag = the newer notification replaces the older one. */
  tag?: string;
}

/* Host suffixes of the browsers' push services (Chrome/Edge/Opera via FCM, Firefox, Safari, Windows). */
const PUSH_HOSTS = [".googleapis.com", ".mozilla.com", ".push.apple.com", ".notify.windows.com"];
const PUSH_EXACT_HOSTS = ["fcm.googleapis.com", "web.push.apple.com"];

export function isAllowedPushEndpoint(raw: string): boolean {
  if (typeof raw !== "string" || raw.length > 1000) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_EXACT_HOSTS.includes(host) || PUSH_HOSTS.some((s) => host.endsWith(s));
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}
let keysPromise: Promise<VapidKeys | null> | null = null;

function vapidKeys(): Promise<VapidKeys | null> {
  if (!keysPromise) {
    keysPromise = readAppSecretString()
      .then((raw) => {
        let s: Record<string, unknown> = {};
        try {
          s = JSON.parse(raw ?? "{}");
        } catch {
          // not JSON: no keys
        }
        const publicKey = typeof s.vapidPublicKey === "string" ? s.vapidPublicKey.trim() : "";
        const privateKey = typeof s.vapidPrivateKey === "string" ? s.vapidPrivateKey.trim() : "";
        return publicKey && privateKey ? { publicKey, privateKey } : null;
      })
      .catch((e) => {
        keysPromise = null;
        throw e;
      });
  }
  return keysPromise;
}

/** Tests only. */
export function resetPushKeysForTests(keys?: VapidKeys | null): void {
  keysPromise = keys === undefined ? null : Promise.resolve(keys);
}

/** The key browsers subscribe with, or null while push isn't set up. */
export async function pushPublicKey(): Promise<string | null> {
  try {
    return (await vapidKeys())?.publicKey ?? null;
  } catch {
    return null;
  }
}

export const VAPID_SUBJECT = "mailto:support@ceseelia.com";

/* What sendNotification is called with; swapped in tests. */
let send: typeof webpush.sendNotification = (sub, payload, options) => webpush.sendNotification(sub, payload, options);
export function setPushSenderForTests(fn: typeof webpush.sendNotification | null): void {
  send = fn ?? ((sub, payload, options) => webpush.sendNotification(sub, payload, options));
}

/**
 * Sends `payload` to every browser `userId` turned push on in. Never throws; returns how many
 * were delivered. Subscriptions the push service says are gone (404/410) are deleted.
 */
export async function pushToUser(userId: string, payload: PushPayload): Promise<number> {
  try {
    const keys = await vapidKeys();
    if (!keys) return 0;
    const subs = await listPushSubscriptions(userId);
    const results = await Promise.all(subs.map((s) => pushOne(userId, s, payload, keys)));
    return results.filter(Boolean).length;
  } catch (e) {
    log.error({ err: e, userId }, "[push] couldn't send");
    return 0;
  }
}

async function pushOne(userId: string, s: PushSubscriptionRecord, payload: PushPayload, keys: VapidKeys): Promise<boolean> {
  if (!isAllowedPushEndpoint(s.endpoint)) {
    await deletePushSubscription(userId, s.endpoint).catch(() => undefined);
    return false;
  }
  try {
    await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), {
      vapidDetails: { subject: VAPID_SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey },
      TTL: 3600,
      urgency: "high",
      timeout: 10_000,
    });
    return true;
  } catch (e) {
    const status = (e as WebPushError)?.statusCode;
    if (status === 404 || status === 410) {
      await deletePushSubscription(userId, s.endpoint).catch(() => undefined);
      return false;
    }
    // The endpoint is never logged (it's the browser's address); the push service's status is.
    log.warn({ userId, status: status ?? null, host: new URL(s.endpoint).hostname }, "[push] not delivered");
    return false;
  }
}
