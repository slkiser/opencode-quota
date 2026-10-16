export interface AgyAuthorization {
    url: string;
    verifier: string;
    state: string;
}
interface AgyTokenExchangeSuccess {
    type: 'success';
    refresh: string;
    access: string;
    expires: number;
    email?: string;
}
interface AgyTokenExchangeFailure {
    type: 'failed';
    error: string;
}
export type AgyTokenExchangeResult = AgyTokenExchangeSuccess | AgyTokenExchangeFailure;
/**
 * Builds the Agy OAuth authorization URL with PKCE.
 */
export declare function authorizeAgy(): Promise<AgyAuthorization>;
/**
 * Exchanges the authorization code for Agy using a known PKCE verifier.
 */
export declare function exchangeAgyWithVerifier(code: string, verifier: string): Promise<AgyTokenExchangeResult>;
export {};
