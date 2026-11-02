import { Request, Response, NextFunction } from 'express';
import express from 'express';
import os from 'os';
import { IN_DEV } from "./config";
import apiRouter from "./api/v1";

const apiV1Router = express.Router();
apiV1Router.use('/api/v1', apiRouter);

export function domainRouterWithLogger(req: Request, res: Response, next: NextFunction): void | Promise<void> {
    const now = new Date();
    const datetime = now.toLocaleDateString('en-CA', { timeZone: 'America/Edmonton' }) + ' ' +
        now.toLocaleTimeString('en-CA', { hour12: false, timeZone: 'America/Edmonton' });
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const path = req.path;
    const host: string = req.hostname.toLowerCase();

    console.warn(`[${datetime}] IP: ${ip} | Host: ${host} | Path: ${path}`);

    // In dev, accept localhost and any of this machine's own IPs (LAN IP can change via DHCP)
    if (IN_DEV && (host === 'localhost' || localHostIps().includes(host))) {
        if (path.startsWith('/api/v1')) {
            return apiV1Router(req, res, next);
        }
    }

    if (host === 'api.ceseelia.northernhoop.com') {
        return apiV1Router(req, res, next);
    }

    res.status(404).send('Domain not recognized');
}

function localHostIps(): string[] {
    return Object.values(os.networkInterfaces())
        .flat()
        .filter((iface) => iface !== undefined && iface.family === 'IPv4')
        .map((iface) => iface!.address);
}
