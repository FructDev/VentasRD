import type { InventoryScope } from './inventory/contract';

export function syncStorageKey(prefix: string, entity: string, scope: InventoryScope): string {
    return `${prefix}${scope.negocioId}:${scope.sucursalId ?? 'GLOBAL'}:${entity}`;
}
