import { PrismaClient } from '@prisma/client';

// Patrón Singleton para evitar agotar las conexiones de PostgreSQL en modo desarrollo
const globalForPrisma = global as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: ['query'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

// =============================================================================
// PARCHE VULN-07: Prisma Extension Multi-Tenant — inyecta tenantId automáticamente
// en findMany, findFirst, findUnique, update, updateMany, delete, deleteMany, count.
// Uso: const db = forTenant(req.user.tenantId); db.contact.findMany() ← ya filtrado.
// =============================================================================

// Modelos que tienen la columna tenantId directamente
const TENANT_MODELS = ['contact', 'tag', 'user'] as const;

export function forTenant(tenantId: string) {
  return prisma.$extends({
    query: {
      $allOperations({ model, operation, args, query }) {
        if (!model) return query(args);

        const m = model.toLowerCase();
        if (!TENANT_MODELS.includes(m as any)) return query(args);

        // Operaciones de lectura y escritura que aceptan `where`
        const opsWithWhere = [
          'findFirst', 'findMany', 'findUnique', 'findFirstOrThrow', 'findUniqueOrThrow',
          'update', 'updateMany', 'delete', 'deleteMany', 'count', 'aggregate', 'groupBy'
        ];

        if (opsWithWhere.includes(operation)) {
          args.where = { ...args.where, tenantId };
        }

        // Operaciones de creación: forzar el tenantId en data
        if (operation === 'create' && args.data) {
          args.data.tenantId = tenantId;
        }
        if (operation === 'createMany' && args.data) {
          if (Array.isArray(args.data)) {
            args.data = args.data.map((d: any) => ({ ...d, tenantId }));
          } else {
            args.data.tenantId = tenantId;
          }
        }

        return query(args);
      },
    },
  });
}
