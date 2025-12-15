import { Request, Response, NextFunction } from 'express';
import express from 'express';
import {IN_DEV} from "./config";
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

    if (IN_DEV && (host === 'localhost' || host === '192.0.0.2')) {
        if (path.startsWith('/api/v1')) {
            return apiV1Router(req, res, next);
        }
    }

    if (host === 'api.ceseelia.com') {
        return apiV1Router(req, res, next);
    }

    res.status(404).send('Domain not recognized');
}
