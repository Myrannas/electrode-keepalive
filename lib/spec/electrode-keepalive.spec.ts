"use strict";

import {ElectrodeKeepAlive} from "../electrode-keepalive";
import * as sa from "superagent";
import {assert, sandbox, SinonSandbox} from "sinon";
import {expect} from "chai";
import * as http from 'http';
import * as https from 'https';
import * as dns from 'dns';

describe("electrode-keepalive", () => {
    let sinon: SinonSandbox;
    beforeEach(() => {
        sinon = sandbox.create();
        ElectrodeKeepAlive.clearDnsCache();
    });

    afterEach(() => {
        sinon.restore();
    });

    it("should expose the underlying agent", () => {
        const keepAlive = new ElectrodeKeepAlive({} as any, {} as any);
        expect(keepAlive.agent).to.exist;
    });

    it("agent should fetch requests", () => {
        const keepAlive = new ElectrodeKeepAlive(new http.Agent(), {} as any);
        const httpAgent = keepAlive.agent;

        const request = sa.get("www.google.com");
        request.agent(httpAgent);

        return request;
    });

    it("should provide a preLookup function", () => {
        const keepAlive = new ElectrodeKeepAlive({} as any, {} as any);
        expect(keepAlive.preLookup).to.be.a("function");
    });

    it("should lookup hosts and populate dnsCache", async () => {
        const keepAlive = new ElectrodeKeepAlive({} as any, {} as any);

        const ip = await keepAlive.preLookup("www.google.com");
        expect(ip).to.exist;
        expect(keepAlive.getName({host: "www.google.com"})).to.contain(ip);
    });

    const testKeepAlive = async (useHttps: boolean) => {
        const Agent = useHttps ? https.Agent : http.Agent;
        const keepAlive = new ElectrodeKeepAlive(new Agent({
            keepAlive: true,
            keepAliveMsecs: 30000, // socket send keep alive ping every 30 secs
            maxSockets: 100,
            maxFreeSockets: 10
        }), {} as any);

        expect(ElectrodeKeepAlive.DNS_CACHE).to.be.empty;
        const host = "www.google.com";

        await keepAlive.preLookup(host);
        await sa.get((useHttps ? 'https://' : 'http://') + host).agent(keepAlive.agent);
        const agent = keepAlive.agent;
        const name = keepAlive.getName({host, port: useHttps ? 443 : 80});
        const free = (agent as any).freeSockets[name];
        expect(Array.isArray(free)).to.equal(true);
    };

    it("should load with https", () => {
        return testKeepAlive(true);
    });

    it("should load with http", () => {
        return testKeepAlive(false);
    });

    it("should return cached dns entry", () => {
        const expiry = 5000;
        const keepAlive = new ElectrodeKeepAlive({} as any, {} as any, expiry);

        ElectrodeKeepAlive.DNS_CACHE.set('foo', {ip: "bar", expiry: Date.now() + expiry, refreshing: false});
        expect((keepAlive.agent as any).getName({host: "foo"})).to.equal("bar::");
    });

    it("should resolve dns when entry doesn't exist", () => {
        const keepAlive = new ElectrodeKeepAlive({} as any, {} as any);
        keepAlive.preLookup = sinon.stub().returns(Promise.resolve());

        const name = (keepAlive.agent as any).getName({host: "foo2"});
        expect(name).to.equal("foo2::");
        assert.calledWith(keepAlive.preLookup as any, "foo2");
    });

    describe('prelookup', () => {
        it('should return one of the resolved ip addresses', async () => {
            const keepAlive = new ElectrodeKeepAlive({} as any, {} as any);

            sinon.stub(dns, 'resolve4').callsArgOnWith(1, null, null, [
                '192.168.0.1'
            ]);

            expect(await keepAlive.preLookup('http://example.com')).to.equal('192.168.0.1');
        });

        it('should result in a failed promise if resolution failed', async () => {
            const keepAlive = new ElectrodeKeepAlive({} as any, {} as any);

            sinon.stub(dns, 'resolve4').callsArgOnWith(1, null, new Error('Oh no!'));

            try {
                await keepAlive.preLookup('http://example.com');
            } catch (ex) {
                expect(ex).to.be.instanceOf(Error);
            }
        });

        it('should not start a request if one is already in progress', async () => {
            const keepAlive = new ElectrodeKeepAlive({} as any, {} as any);
            ElectrodeKeepAlive.DNS_CACHE.set('http://example.com', {
                ip: '192.168.0.1',
                refreshing: true,
                expiry: Date.now()
            });

            const resolve4 = sinon.stub(dns, 'resolve4');
            await keepAlive.preLookup('http://example.com');
            assert.notCalled(resolve4);
        });

        it('should mark a DNS entry as refreshing while in progress', async () => {
            const keepAlive = new ElectrodeKeepAlive({} as any, {} as any);
            ElectrodeKeepAlive.DNS_CACHE.set('http://example.com', {
                ip: '192.168.0.1',
                refreshing: false,
                expiry: Date.now()
            });

            const resolve4 = sinon.stub(dns, 'resolve4');
            const lookup = keepAlive.preLookup('http://example.com');
            expect(ElectrodeKeepAlive.DNS_CACHE.get('http://example.com')!.refreshing).to.equal(true);
            resolve4.args[0][1](null, ['192.168.0.2']);
            expect(await lookup).to.equal('192.168.0.2');
            expect(ElectrodeKeepAlive.DNS_CACHE.get('http://example.com')!.ip).to.equal('192.168.0.2');
            expect(ElectrodeKeepAlive.DNS_CACHE.get('http://example.com')!.refreshing).to.equal(false);
            expect(ElectrodeKeepAlive.DNS_CACHE.get('http://example.com')!.expiry).to.be.greaterThan(Date.now());
        });

        it('should mark a DNS entry as refreshed if failed', async () => {
            const keepAlive = new ElectrodeKeepAlive({} as any, {} as any);
            ElectrodeKeepAlive.DNS_CACHE.set('http://example.com', {
                ip: '192.168.0.1',
                refreshing: false,
                expiry: Date.now()
            });

            const resolve4 = sinon.stub(dns, 'resolve4');
            const lookup = keepAlive.preLookup('http://example.com');
            expect(ElectrodeKeepAlive.DNS_CACHE.get('http://example.com')!.refreshing).to.equal(true);
            resolve4.args[0][1](new Error(':('), ['192.168.0.2']);
            try {
                await lookup;
            } catch (ex) {
                expect(ElectrodeKeepAlive.DNS_CACHE.get('http://example.com')!.ip).to.equal('192.168.0.1');
                expect(ElectrodeKeepAlive.DNS_CACHE.get('http://example.com')!.refreshing).to.equal(false);
                expect(ex).to.be.instanceOf(Error);
            }
        });
    });
});
