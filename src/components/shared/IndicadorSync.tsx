import { Cloud, CloudOff, AlertTriangle, CheckCircle2 } from 'lucide-react';
import React from 'react';
import { inventorySyncPresentation, type SyncPresentationEntity } from '@/lib/sync/inventory/presentation';

export type EstadoSyncEntity = SyncPresentationEntity;

interface Props {
    entity: EstadoSyncEntity;
    className?: string;
    showLabel?: boolean;
}

export function IndicadorSync({ entity, className = '', showLabel = true }: Props) {
    // Si no tiene la propiedad, asumimos que es viejo o no requiere sync
    if (entity.estado_sincronizacion === undefined) return null;

    const { kind, label } = inventorySyncPresentation(entity);

    let icon = <CheckCircle2 className="w-4 h-4 text-vr-green" />;
    let colorClass = 'text-vr-green';
    let bgClass = 'bg-vr-green/10 border-vr-green/20';

    if (kind !== 'CONFIRMED') {
        if (kind === 'ATTENTION') {
            icon = <AlertTriangle className="w-4 h-4 text-vr-red" />;
            colorClass = 'text-vr-red';
            bgClass = 'bg-vr-red/10 border-vr-red/20';
        } else if (kind === 'PENDING') {
            icon = <CloudOff className="w-4 h-4 text-vr-orange" />;
            colorClass = 'text-vr-orange';
            bgClass = 'bg-vr-orange/10 border-vr-orange/20';
        } else {
            // PENDING, u operaciones legacy
            icon = <Cloud className="w-4 h-4 text-vr-gray" />;
            colorClass = 'text-vr-gray';
            bgClass = 'bg-navy-3 border-navy-3';
        }
    }

    if (!showLabel) {
        return (
            <div title={label} className={`inline-flex items-center justify-center p-1 rounded-full border ${bgClass} ${className}`}>
                {icon}
            </div>
        );
    }

    return (
        <div className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium border ${bgClass} ${colorClass} ${className}`}>
            {icon}
            <span>{label}</span>
        </div>
    );
}
