// Web push keys (progress.md L.5): makes a VAPID key pair and adds it to the stage secret as
// `vapidPublicKey` / `vapidPrivateKey`, keeping every other key in the secret as it is.
//
//   node scripts/setup-vapid.mjs                                 # dry run: says what it would do
//   node scripts/setup-vapid.mjs --write                         # ceseelia/dev
//   APP_SECRET_ID=ceseelia/prod node scripts/setup-vapid.mjs --write
//
// Does nothing if the secret already has both keys: a new pair would cut off every browser that
// turned notifications on (their subscriptions are tied to the public key). The private key is
// never printed. Restart the API afterwards (it reads the secret once).
import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import webpush from "web-push";

const WRITE = process.argv.includes("--write");
const SECRET_ID = process.env.APP_SECRET_ID || "ceseelia/dev";
const sm = new SecretsManagerClient({ region: process.env.AWS_REGION || "us-east-1" });

const current = JSON.parse((await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ID }))).SecretString || "{}");
if (current.vapidPublicKey && current.vapidPrivateKey) {
  console.log(`${SECRET_ID} already has VAPID keys (public ${current.vapidPublicKey.slice(0, 12)}…). Nothing to do.`);
  process.exit(0);
}

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
if (!WRITE) {
  console.log(`Dry run: would add vapidPublicKey and vapidPrivateKey to ${SECRET_ID}. Add --write to do it.`);
  process.exit(0);
}
await sm.send(
  new PutSecretValueCommand({
    SecretId: SECRET_ID,
    SecretString: JSON.stringify({ ...current, vapidPublicKey: publicKey, vapidPrivateKey: privateKey }),
  })
);
console.log(`Added VAPID keys to ${SECRET_ID} (public ${publicKey.slice(0, 12)}…). Restart the API to use them.`);
