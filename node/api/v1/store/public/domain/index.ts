import { Request, Response, Router } from "express";
import { validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { appConstants } from "../../../../../constants";
import { normalizeHost } from "../../../../../layers/core/custom-domain";
import { slugForCustomHost } from "../../../../../layers/core/store-url";

/*
 * GET /store/public/domain/:host → { slug } (public; 9.8 phase 2)
 * The webapp on a store's own domain (`shop.theirbrand.com`) asks which store it is, then acts
 * as on `<slug>.ceseelia.com`. Only live (ACTIVE) domains answer; 404 otherwise. Read from the
 * in-memory list the domain sweep keeps (refreshed every minute and after each change).
 */
export default function registerRoute(router: Router): void {
  router.get("/domain/:host", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (r) => typeof r.params.host === "string",
      (r) => String(r.params.host).length <= 253,
      async (r, s) => {
        const slug = slugForCustomHost(normalizeHost(String(r.params.host)));
        if (!slug) {
          s.set("Cache-Control", "no-store");
          s.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ code: "DOMAIN_NOT_FOUND", message: "No store uses this domain." });
          return;
        }
        s.set("Cache-Control", "public, max-age=60");
        s.send({ slug });
      },
      false
    );
  });
}
