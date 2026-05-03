'use client';

import { useConfigStore } from '@/store/useConfigStore';
import { useEffect, useState } from 'react';

export default function GlobalToast() {
    const { toast } = useConfigStore();
    const [isVisible, setIsVisible] = useState(false);

    useEffect(() => {
        if (toast) {
            setIsVisible(true);
        } else {
            setIsVisible(false);
        }
    }, [toast]);

    if (!toast && !isVisible) return null;

    const styles = {
        success: 'bg-vr-green/15 border-vr-green/30 text-vr-green',
        error: 'bg-vr-red/15 border-vr-red/30 text-vr-red',
        info: 'bg-gold/15 border-gold/30 text-gold',
    };

    const icons = {
        success: '✅',
        error: '🚨',
        info: '💡',
    };

    return (
        <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-[9999] transition-all duration-300 ${isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8 pointer-events-none'}`}>
            <div className={`${toast ? styles[toast.type] : styles.info} px-6 py-4 rounded-2xl shadow-2xl flex items-center gap-3 font-bold text-sm md:text-base border min-w-[300px] justify-center backdrop-blur-xl`}>
                <span className="text-xl">{toast ? icons[toast.type] : '💡'}</span>
                <span>{toast?.message}</span>
            </div>
        </div>
    );
}
