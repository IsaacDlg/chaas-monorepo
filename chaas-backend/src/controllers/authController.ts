import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { stripe } from '../lib/stripe';

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-change-in-prod';

export const register = async (req: Request, res: Response) => {
  try {
    const { email, password, name, tenantName } = req.body;

    // 1. Validar existencia
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ error: 'El email ya está registrado' });
    }

    // 2. Integración con Stripe: Crear Customer
    const stripeCustomer = await stripe.customers.create({ email, name: tenantName });

    // 3. Crear Tenant y User en una transacción atómica
    const passwordHash = await bcrypt.hash(password, 10);

    const result = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name: tenantName,
          stripe_customer_id: stripeCustomer.id,
          subscription_status: 'INACTIVE', // Debe pagar para activarlo
          plan_type: 'FREE'
        }
      });

      const user = await tx.user.create({
        data: {
          email,
          name,
          passwordHash,
          role: 'OWNER',
          tenantId: tenant.id
        }
      });

      return { tenant, user };
    });

    res.status(201).json({ success: true, message: 'Empresa, usuario y bot creados. Por favor inicie sesión.' });
  } catch (error) {
    console.error('[Auth] Error registrando:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

export const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const token = jwt.sign(
      { id: user.id, tenantId: user.tenantId, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.status(200).json({ token, tenantId: user.tenantId, role: user.role });
  } catch (error) {
    console.error('[Auth] Error en login:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};
