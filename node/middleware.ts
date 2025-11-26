import { Request, Response, NextFunction } from 'express';
import express from 'express';
import {IN_DEV} from "./config";
import apiRouter from "./api/v1";
import websiteRouter from "./api/v1/website";

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

    if (IN_DEV && (host === 'localhost' || host === '192.168.1.70')) {
        if (path.startsWith('/api/v1')) {
            return apiV1Router(req, res, next);
        } else {
            req.app.locals.subdomain = 'localdev';
            return websiteRouter(req, res, next);
        }
    }

    if (host === 'api.dinersxpress.com') {
        return apiV1Router(req, res, next);
    }

    const domain = '.dinersxpress.com';
    if (host.endsWith(domain)) {
        const subdomain = host.slice(0, -domain.length);
        const cleanSubdomain = subdomain.endsWith('.') ? subdomain.slice(0, -1) : subdomain;
        if (cleanSubdomain && cleanSubdomain !== 'www') {
            req.app.locals.subdomain = cleanSubdomain;
            return websiteRouter(req, res, next);
        }
    }

    res.status(404).send('Domain not recognized');
}
