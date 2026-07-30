import { OAuth2Client } from 'google-auth-library';
export declare function isAuthenticated(account: string): Promise<boolean>;
export declare function getOAuth2Client(account: string): Promise<OAuth2Client>;
export declare function authenticate(account: string): Promise<{
    success: boolean;
    message: string;
}>;
export declare function listAccounts(): Promise<string[]>;
