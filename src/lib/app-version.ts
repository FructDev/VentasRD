export const APP_BUILD_ID = process.env.NEXT_PUBLIC_VENTARD_BUILD_ID?.slice(0, 12) || 'local';

export function hasDeployUpdate(installed: string, available: string): boolean {
    const current = installed.trim();
    const next = available.trim();
    if (!current || !next || current === 'local' || next === 'local') return false;
    return current !== next;
}
