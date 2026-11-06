import { promises as dns } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { isIP, BlockList } from 'node:net';
import { randomBytes, timingSafeEqual, createHmac, createHash } from 'node:crypto';
import { normalizeHostname } from './domains';
const tokenDigest = (value: string) => createHash('sha256').update(value).digest('hex');
const challengeSignature = (host: string, nonce: string, secret: string) => createHmac('sha256', secret).update(`cms-domain-v1:${host}:${nonce}`).digest('hex');
export interface CheckResult { ownership: boolean; dns: boolean; https: boolean; error?: string }

const specialV4 = new BlockList();
for (const [address, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) specialV4.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const specialV6 = new BlockList();
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) specialV6.addSubnet(address, prefix, 'ipv6');

// Accept only global unicast destinations. DNS is resolved once and the selected
// validated IP is pinned to the TLS socket; SNI and certificate checks use hostname.
export function publicAddress(ip: string): boolean {
    if (isIP(ip) === 4) return !specialV4.check(ip, 'ipv4');
    if (isIP(ip) !== 6) return false;
    // All special IPv6 ranges (including mapped IPv4, NAT64, ULA and link local)
    // lie outside 2000::/3; additionally exclude documentation and Teredo/6to4.
    return globalV6.check(ip, 'ipv6') && !specialV6.check(ip, 'ipv6');
}
function timeout<T>(action: Promise<T>, ms = 4000): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([action, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('DNS or HTTPS check timed out')), ms); })]).finally(() => clearTimeout(timer));
}
export function requestChallenge(hostname: string, address: string, nonce: string, tls: { ca?: string | Buffer; port?: number } = {}): Promise<string> {
    return new Promise((resolve, reject) => {
        const req = httpsRequest({ hostname, port: tls.port ?? 443, ca: tls.ca, servername: hostname, method: 'GET',
            path: `/.well-known/cms-domain-challenge?nonce=${nonce}`,
            lookup: ((_host: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) => options.all ? cb(null, [{ address, family: isIP(address) }]) : cb(null, address, isIP(address))) as never,
            agent: false, rejectUnauthorized: true, signal: AbortSignal.timeout(4000),
        }, (res) => {
            if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTPS challenge returned ${res.statusCode}; redirects are not accepted`)); return; }
            let body = '';
            res.on('data', (chunk) => { body += String(chunk); if (body.length > 256) req.destroy(new Error('Invalid challenge response')); });
            res.on('end', () => resolve(body)); res.on('error', reject);
        });
        req.on('error', reject); req.end();
    });
}
export interface CheckOptions {
    secret: string;
    /** Explicit isolated-test policy; production always uses publicAddress. */
    addressAllowed?: (address: string) => boolean;
    resolveTxt?: (hostname: string) => Promise<string[][]>;
    lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
    request?: (hostname: string, address: string, nonce: string) => Promise<string>;
}
export async function probeDomain(record: { hostname: string; verificationTokenHash?: string | null; platformOwned: boolean }, options: CheckOptions): Promise<CheckResult> {
    const hostname = normalizeHostname(record.hostname);
    if (!options.secret) throw new Error('Domain challenge secret is not configured');
    const result: CheckResult = { ownership: false, dns: false, https: false };
    const errors: string[] = [];
    if (record.platformOwned) result.ownership = true;
    else try {
        const values = await timeout((options.resolveTxt || dns.resolveTxt)(`_cms-verify.${hostname}`));
        result.ownership = values.some((parts) => tokenDigest(parts.join('')) === record.verificationTokenHash);
        if (!result.ownership) errors.push('TXT ownership record missing or incorrect');
    } catch { errors.push('TXT record lookup failed'); }
    try {
        const addresses = await timeout((options.lookup || ((host) => dns.lookup(host, { all: true })))(hostname));
        if (!addresses.length || addresses.some(({ address }) => !(options.addressAllowed || publicAddress)(address))) throw new Error('DNS must resolve exclusively to public addresses');
        result.dns = true;
        const nonce = randomBytes(24).toString('hex');
        const actual = await timeout((options.request || requestChallenge)(hostname, addresses[0].address, nonce));
        const expected = challengeSignature(hostname, nonce, options.secret);
        result.https = actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
        if (!result.https) errors.push('HTTPS challenge signature did not match the configured storefront');
    } catch (error) { errors.push((error as Error).message); }
    if (errors.length) result.error = errors.join('; ').slice(0, 500);
    return result;
}
