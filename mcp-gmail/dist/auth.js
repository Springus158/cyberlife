// Cyber Life-backed auth: accounts, OAuth credentials and tokens come from
// the Cyber Life state file. Add accounts in Cyber Life (Settings → Gmail)
// and tick "Claude MCP" per account — no separate authentication here.
import { google } from 'googleapis';
import * as fs from 'fs/promises';
import * as path from 'path';
const STATE_PATH = path.join(process.env.HOME || '', '.cyberlife', 'state.json');
async function readGmailSettings() {
    const raw = await fs.readFile(STATE_PATH, 'utf-8');
    const state = JSON.parse(raw);
    const gmail = state.gmail || {};
    return {
        accounts: gmail.accounts || [],
        clientId: gmail.clientId || '',
        clientSecret: gmail.clientSecret || '',
    };
}
async function resolveAccount(account) {
    let settings;
    try {
        settings = await readGmailSettings();
    }
    catch {
        return null;
    }
    const enabled = settings.accounts.filter(a => a.mcpEnabled && a.tokenJson);
    const acc = enabled.find(a => a.email === account) ||
        (account === 'default'
            ? enabled[0]
            : enabled.find(a => a.email.toLowerCase().includes(account.toLowerCase())));
    if (!acc)
        return null;
    return {
        acc,
        clientId: acc.clientId || settings.clientId,
        clientSecret: acc.clientSecret || settings.clientSecret,
    };
}
export async function isAuthenticated(account) {
    return (await resolveAccount(account)) !== null;
}
export async function getOAuth2Client(account) {
    const resolved = await resolveAccount(account);
    if (!resolved) {
        throw new Error(`Account "${account}" is not enabled for MCP. In Cyber Life open Settings → Gmail, connect the account and tick "Claude MCP".`);
    }
    const oauth2Client = new google.auth.OAuth2(resolved.clientId, resolved.clientSecret, 'http://127.0.0.1/oauth/callback');
    // Token stored by Cyber Life (Go oauth2.Token JSON) → google-auth-library shape
    const token = JSON.parse(resolved.acc.tokenJson);
    oauth2Client.setCredentials({
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        token_type: token.token_type || 'Bearer',
        expiry_date: token.expiry ? Date.parse(token.expiry) : undefined,
    });
    return oauth2Client;
}
export async function authenticate(account) {
    const accounts = await listAccounts();
    return {
        success: false,
        message: `Accounts are managed by Cyber Life — open Settings → Gmail, connect "${account}" ` +
            `and tick "Claude MCP" for it. Currently enabled: ${accounts.length > 0 ? accounts.join(', ') : '(none)'}`,
    };
}
export async function listAccounts() {
    try {
        const settings = await readGmailSettings();
        return settings.accounts.filter(a => a.mcpEnabled && a.tokenJson).map(a => a.email);
    }
    catch {
        return [];
    }
}
