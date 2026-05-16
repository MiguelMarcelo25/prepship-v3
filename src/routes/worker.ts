import { Hono } from 'hono';
import {
  getApiRuntimeStatus,
  getPersistedWorkerStatus,
} from '../services/worker-status';

const app = new Hono();

app.get('/status', async (c) => {
  const worker = await getPersistedWorkerStatus();
  return c.json({
    api: getApiRuntimeStatus(),
    worker,
  });
});

export default app;
