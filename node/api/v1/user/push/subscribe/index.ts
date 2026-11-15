import { Router } from "express";
import { getAuth, validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { fetchUserUUID } from "../../../../../layers/aws/dynamodb/dynamo-entities/user";
import { savePushSubscription } from "../../../../../layers/aws/dynamodb/dynamo-entities/push";
import { isAllowedPushEndpoint, pushPublicKey } from "../../../../../layers/notifications/web-push";
import { fail500, isKey, limited, subscribeLimit } from "../shared";

/* POST /user/push/subscribe (L.5; see ../shared.ts for all four push routes). */
export default function registerRoute(router: Router): void {
  router.post("/push/subscribe", (req, res) => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (req) => typeof req.body?.endpoint === "string" && typeof req.body?.keys === "object" && req.body.keys !== null,
      (req) => isKey(req.body.keys.p256dh, 80, 100) && isKey(req.body.keys.auth, 16, 32) && req.body.endpoint.length <= 1000,
      async (req, res) => {
        if (!isAllowedPushEndpoint(req.body.endpoint)) {
          res.status(400).send({ code: "PUSH_ENDPOINT_NOT_ALLOWED", message: "This browser's push service isn't supported." });
          return;
        }
        if (!(await pushPublicKey())) {
          res.status(503).send({ code: "PUSH_NOT_CONFIGURED", message: "Notifications aren't available yet." });
          return;
        }
        const { cognitoId } = getAuth(res);
        if (limited(res, subscribeLimit.take(cognitoId))) return;
        try {
          const userId = await fetchUserUUID(cognitoId);
          await savePushSubscription(userId, {
            endpoint: req.body.endpoint,
            p256dh: req.body.keys.p256dh,
            auth: req.body.keys.auth,
          });
          res.send({ ok: true });
        } catch (e) {
          fail500(res, "subscribe")(e);
        }
      }
    );
  });
}
