import type { InventoryRolloutMode, InventoryScope } from './contract';
const QA_TENANTS = new Set(['96000000-0000-4000-8000-000000000001', '96000000-0000-4000-8000-000000000002']);
export function inventoryReceiverMode(url: string | undefined, requested: string | undefined, scope: InventoryScope): InventoryRolloutMode {
    if (url !== 'https://blzzinivvzadqjbnpsre.supabase.co' || !QA_TENANTS.has(scope.negocioId)) return 'PAUSED';
    return requested === 'ACTIVE' || requested === 'SHADOW' ? requested : 'PAUSED';
}
