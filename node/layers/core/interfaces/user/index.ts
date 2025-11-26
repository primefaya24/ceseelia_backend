export interface UserProfileInfoRecord {
    pk: string;
    sk: string;
    userPlan: string;
    userEmailAddress: string;
    userAvatarUri: string;
    userFirstName: string;
    userLastName: string;
    userPreferredLocale: string;
    isProfileComplete: boolean;
    userCreatedAt: number;
}

export interface UserProfileCognitoDataRecord {
    pk: string;
    sk: string;
    userSocialProviderName: string;
    userSocialProviderType: string;
    userSocialProviderUserId: string;
    userEmail: string;
    userCognitoId: string;
    userDeactivated: boolean;
}

export interface UserProfileNotificationsSettings {
    pk: string;
    sk: string;
    userFcmToken: string;
}


export interface UserNameAndAvatar {
    userName: string;
    userAvatarUri: string;
}