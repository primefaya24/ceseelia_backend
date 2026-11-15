import { Router } from "express";
import { validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { pushPublicKey } from "../../../../../layers/notifications/web-push";

/* GET /user/push/config (L.5; see ../shared.ts for all four push routes). */
export default function registerRoute(router: Router): void {
  router.get("/push/config", (req, res) => {
    validateAndExecuteHttpApiRoute(req, res, () => true, () => true, async (_req, res) => {
      res.set("Cache-Control", "no-store");
      res.send({ publicKey: await pushPublicKey() });
    });
  });
}
