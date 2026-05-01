import { Hono } from 'hono';
import verifyCarrierHandler from '../../api/carriers/verify';
import { runNodeHandler } from '../lib/node-handler';

const app = new Hono();

app.all('/verify', runNodeHandler(verifyCarrierHandler));

export default app;
