import { Router } from "express";
import { getAuth, validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { fetchUserUUID } from "../../../../../layers/aws/dynamodb/dynamo-entities/user";
import { pushToUser } from "../../../../../layers/notifications/web-push";
import { fail500, limited, testLimit } from "../shared";

/* POST /user/push/test (L.5; see ../shared.ts for all four push routes). */
export default function registerRoute(router: Router): void {
  router.post("/push/test", (req, res) => {
    validateAndExecuteHttpApiRoute(req, res, () => true, () => true, async (_req, res) => {
      const { cognitoId } = getAuth(res);
      if (limited(res, testLimit.take(cognitoId))) return;
      try {
        const userId = await fetchUserUUID(cognitoId);
        const delivered = await pushToUser(userId, {
          title: "Ceseelia",
          body: "Notifications are on. New orders will show up here.",
          url: "/merchant",
          tag: "test",
        });
        res.send({ delivered });
      } catch (e) {
        fail500(res, "test")(e);
      }
    });
  });
}
