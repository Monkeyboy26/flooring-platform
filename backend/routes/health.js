import { Router } from 'express';

const router = Router();

const healthPayload = (req, res) => {
  res.json({
    status: 'ok',
    service: 'flooring-api',
    timestamp: new Date().toISOString()
  });
};

router.get('/health', healthPayload);
// Publicly reachable variant — nginx only proxies /api/* to the backend, so
// external health checks (CI/CD, uptime monitors) must use this path.
router.get('/api/health', healthPayload);

export default router;
