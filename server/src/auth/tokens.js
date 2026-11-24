import crypto from 'node:crypto';
import { config } from '../config/index.js';

// Raw tokens go to the user (cookie / email link). Only a keyed hash is stored, so a database leak can't be replayed.
export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = (token) => crypto.createHmac('sha256', config.sessionSecret).update(String(token)).digest('hex');
