import {MustacheTemplateData, SessionData} from "../../interfaces/view-routes";
import {
    generateBootstrapContent,
    generateFooterContent,
    generateHeadContent,
    generateNavbarContent
} from "../../woo/dynamoHtml";
import {attachCookie} from "../../utils";
import {appConstants} from "../../../../constants";
import {IN_DEV} from "../../../../config";
import {updateUserSession} from "../../../aws/dynamodb/dynamo-entities/user/woo";

/*
* Authenticated http API
*/
export async function validateAndExecuteHttpApiRouteWoo(
    req: any,
    res: any,
    pureRequestParams: any,
    validRequestParams: any,
    executeRouteCore: any,
    withAuth: boolean = true,
    adminOnly: boolean = false,
    ) {
    // Ensure request params are pure
    if (pureRequestParams(req)) {
        // Ensure request params are valid
        if (validRequestParams(req)) {
            if (withAuth) {
                const sessionData: SessionData | null = await updateUserSession(req.cookies?.SessionData);
                if (sessionData) {
                    attachCookie(res, sessionData.sessionId, sessionData.sessionRememberMe);
                    if (adminOnly) {
                        if (sessionData.sessionIsUserAdmin) {
                            executeRouteCore(req, res);
                        } else {
                            res.status(appConstants.HTTP_STATUS_CODE_FORBIDDEN).send({message: appConstants.HTTP_ERROR_MSG_ACCESS_RESTRICTED});
                        }
                    } else {
                        executeRouteCore(req, res);
                    }
                } else {
                    res.status(appConstants.HTTP_STATUS_CODE_FORBIDDEN).send({message: appConstants.HTTP_ERROR_MSG_FORBIDDEN_ACCESS});
                }
            } else {
                executeRouteCore(req, res);
            }
        } else {
            res.status(appConstants.HTTP_STATUS_CODE_BAD_REQUEST).send({message: appConstants.HTTP_ERROR_MSG_INVALID_REQUEST_PARAMS});
        }
    } else {
        res.status(appConstants.HTTP_STATUS_CODE_BAD_REQUEST).send({message: appConstants.HTTP_ERROR_MSG_BAD_REQUEST_PARAMS});
    }
}

/*
* Authenticated http routes
*/
export async function validateAndExecuteHttpRouteWoo(
    req: any,
    res: any,
    fetchPageData: any,
    processUserInteractionWithPage: any,
    routeViewPath: string,
    adminOnly: boolean = false,
    ) {
    const forbiddenAccessErrorRoute = "error/forbidden-access/index";
    const generalErrorRoute = "error/general/index";
    try {
        // Update session data, if applicable
        const sessionData: SessionData | null = await updateUserSession(req.cookies?.SessionData);
        const templateInput: MustacheTemplateData = {} as MustacheTemplateData;
        templateInput.htmlHeadContent = generateHeadContent();
        templateInput.htmlNavbarContent = generateNavbarContent(false, "", "", "/forum", "/blog", "/news", 'blue');
        templateInput.htmlFooterContent = generateFooterContent();
        templateInput.htmlBootstrapContent = generateBootstrapContent();
        templateInput.loggedIn = sessionData !== null;

        // Fetch page data
        await fetchPageData(templateInput);

        // If logged in, populate template data
        if (sessionData) {
            templateInput.htmlNavbarContent = generateNavbarContent(true, sessionData.sessionUserName, sessionData.sessionUserAvatarUri,
                "/forum", "/blog", "/news", 'blue');
            if (adminOnly) {
                if (!sessionData.sessionIsUserAdmin) {
                    res.render(forbiddenAccessErrorRoute, templateInput);
                    return;
                }
            }

            // Populate user name data
            templateInput.userName = sessionData.sessionUserName;
            templateInput.isUserNameAvailable = sessionData.sessionUserName.length > 0;

            // If applicable, process user's interaction with page data
            await processUserInteractionWithPage(templateInput);

            // Cookie
            attachCookie(res, sessionData.sessionId, sessionData.sessionRememberMe);
        }

        // Not logged in
        else {
            // Route belongs to admin only
            if (adminOnly) {
                res.render(forbiddenAccessErrorRoute, templateInput);
                return;
            }
        }

        // Render page
        res.render(routeViewPath, templateInput);
    } catch (e) {
        if (IN_DEV) {
            console.error(e);
        }
        res.render(generalErrorRoute, {});
    }
}