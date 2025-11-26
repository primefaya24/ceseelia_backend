export interface MustacheTemplateData {
    loggedIn: boolean;
    userName: string;
    isUserNameAvailable: boolean;
    htmlHeadContent: string;
    htmlBootstrapContent: string;
    htmlNavbarContent: string;
    htmlFooterContent: string;
}

export interface SessionData {
    sessionId: string;
    sessionUserId: string;
    sessionIsUserAdmin: boolean;
    sessionRememberMe: boolean;
    sessionUserName: string;
    sessionUserAvatarUri: string;
    sessionCreatedAt: string;
    sessionExpiryDate: number
}