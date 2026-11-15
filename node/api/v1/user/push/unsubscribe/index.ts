import { Router } from "express";
import { getAuth, validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { fetchUserUUID } from "../../../../../layers/aws/dynamodb/dynamo-entities/user";
import { deletePushSubscription } from "../../../../../layers/aws/dynamodb/dynamo-entities/push";
import { fail500 } from "../shared";

/* POST /user/push/unsubscribe (L.5; see ../shared.ts for all four push routes). */
export default function registerRoute(router: Router): void {
  router.post("/push/unsubscribe", (req, res) => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (req) => typeof req.body?.endpoint === "string",
      (req) => req.body.endpoint.length > 0 && req.body.endpoint.length <= 1000,
      async (req, res) => {
        try {
          const userId = await fetchUserUUID(getAuth(res).cognitoId);
          await deletePushSubscription(userId, req.body.endpoint);
          res.send({ ok: true });
        } catch (e) {
          fail500(res, "unsubscribe")(e);
        }
      }
    );
  });
}
