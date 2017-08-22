import * as dns from 'dns';
import * as http from 'http';
import * as https from 'https';

const FAMILY_FOUR = 4;
const FIVE_SECONDS_IN_MS = 5000;

export interface DnsCacheEntry {
    expiry: number;
    ip: string;
    refreshing: boolean;
}

let DNS_CACHE = new Map<string, DnsCacheEntry>();

export function randomItem<T>(items: T[]): T {
    const index = Math.floor(Math.random() * items.length);
    return items[index % items.length];
}

export interface Logger {
    warn(error: Error): void;
}

export class ElectrodeKeepAlive {
    constructor(readonly agent: http.Agent | https.Agent,
                readonly logger: Logger,
                readonly expiry: number = FIVE_SECONDS_IN_MS) {
        (this.agent as any).getName = (options: any) => this.getName(options);
    }

    getName(options: any): string {
        const entry = DNS_CACHE.get(options.host);
        let name = entry ? entry.ip : options.host;

        if (!entry || Date.now() > entry.expiry) {
            this.preLookup(options.host, options)
                .catch(exception => {
                    this.logger.warn(exception);
                });
        }

        name += ':';
        if (options.port) {
            name += options.port;
        }

        name += ':';
        if (options.localAddress) {
            name += options.localAddress;
        }

        // Pacify parallel/test-http-agent-getname by only appending
        // the ':' when options.family is set.
        if (options.family === FAMILY_FOUR) {
            name += `:${options.family}`;
        }

        return name;
    }

    async preLookup(host: string, options: any = {}): Promise<string> {
        let entry = DNS_CACHE.get(host);
        if (entry) {

            if (entry.refreshing) {
                return entry.ip;
            }

            entry.refreshing = true;
        }

        try {
            const addresses = await new Promise<string[]>((resolve, reject) => {
                dns.resolve4(host, (error, allAddresses) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve(allAddresses);
                    }
                });
            });

            const address = randomItem(addresses);
            DNS_CACHE.set(host, {
                expiry: Date.now() + this.expiry,
                ip: address,
                refreshing: false
            });

            return address;
        } finally {
            if (entry) {
                entry.refreshing = false;
            }
        }
    }

    static get DNS_CACHE(): Map<string, DnsCacheEntry> {
        return DNS_CACHE;
    }

    static clearDnsCache(): void {
        DNS_CACHE = new Map();
    }
}