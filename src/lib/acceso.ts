// src/lib/acceso.ts
// Única fuente de verdad para el control de acceso por rol.
// La usan TopBar (mostrar/ocultar navegación), AuthProvider (redirección)
// y PinGuard (cuándo pedir PIN).
import type { RolUsuario } from '@/store/useConfigStore';

export const ACCESOS: Record<RolUsuario, string[]> = {
    admin:    ['/', '/historial', '/inventario', '/clientes', '/gastos', '/dashboard', '/reportes', '/configuracion', '/admin', '/reparaciones', '/garantias', '/apartados'],
    vendedor: ['/', '/historial', '/clientes', '/dashboard', '/reparaciones', '/garantias', '/apartados'],
    cajero:   ['/'],
};

/** ¿Puede este rol acceder a esta ruta? (incluye sub-rutas, ej: /inventario/importar) */
export function puedeAcceder(rol: RolUsuario, pathname: string): boolean {
    const rutas = ACCESOS[rol] ?? ACCESOS.cajero;
    return rutas.some(r =>
        r === '/' ? pathname === '/' : (pathname === r || pathname.startsWith(r + '/'))
    );
}
