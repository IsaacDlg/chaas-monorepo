import { Router } from 'express';
import { register, login } from '../controllers/authController';
import { authLimiter } from '../middlewares/rateLimiter';

const router = Router();

// PARCHE VULN-04: Rate limit agresivo en auth para evitar brute-force
router.post('/register', authLimiter, register);
router.post('/login', authLimiter, login);

export default router;
