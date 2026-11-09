import { Request, Response, NextFunction } from 'express';
import express from 'express';
import os from 'os';
import { ALLOWED_API_HOSTS, IN_DEV } from "./config";
import apiRouter from "./api/v1";

const apiV1Router = express.Router();
apiV1Router.use('/api/v1', apiRouter);

export function domainRouterWithLogger(req: Request, res: Response, next: NextFunction): void | Promise<void> {
    const now = new Date();
    const datetime = now.toLocaleDateString('en-CA', { timeZone: 'America/Edmonton' }) + ' ' +
        now.toLocaleTimeString('en-CA', { hour12: false, timeZone: 'America/Edmonton' });
    const ip = req.ip || 'unknown'; // see TRUST_PROXY_HOPS; raw X-Forwarded-For can be spoofed
    const path = req.path;
    const host: string = req.hostname.toLowerCase();

    console.warn(`[${datetime}] IP: ${ip} | Host: ${host} | Path: ${path}`);

    if (isAllowedApiHost(host)) {
        return apiV1Router(req, res, next);
    }

    res.status(404).send('Domain not recognized');
}

export function isAllowedApiHost(host: string): boolean {
    if (ALLOWED_API_HOSTS.includes(host)) {
        return true;
    }
    // In dev, accept localhost and any of this machine's own IPs (LAN IP can change via DHCP)
    return IN_DEV && (host === 'localhost' || localHostIps().includes(host));
}

function localHostIps(): string[] {
    return Object.values(os.networkInterfaces())
        .flat()
        .filter((iface) => iface !== undefined && iface.family === 'IPv4')
        .map((iface) => iface!.address);
}
