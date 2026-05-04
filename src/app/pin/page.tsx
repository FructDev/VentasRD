'use client';

import { useState } from 'react';
import { useConfigStore } from '@/store/useConfigStore';
import { useRouter } from 'next/navigation';

export default function PinPage() {
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  const router = useRouter();
  const { pinAdmin, negocioNombre, setOfflineUnlock } = useConfigStore();

  const handlePin = (digit: string) => {
    const newPin = pin + digit;
    setPin(newPin);
    setError(false);

    if (newPin.length === 4) {
      if (newPin === pinAdmin) {
        setOfflineUnlock(true);
        router.push('/');
      } else {
        setError(true);
        setTimeout(() => setPin(''), 600);
      }
    }
  };

  const borrar = () => setPin(p => p.slice(0, -1));

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0D1B2E',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      fontFamily: 'sans-serif',
    }}>
      {/* Logo */}
      <div style={{
        width: 64, height: 64,
        background: '#D4A017',
        borderRadius: 16,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 28,
        marginBottom: 16,
      }}>
        🔐
      </div>

      <h1 style={{ color: '#fff', fontSize: 22, fontWeight: 800, marginBottom: 4 }}>
        {negocioNombre || 'VentaRD'}
      </h1>
      <p style={{ color: '#8899AA', fontSize: 14, marginBottom: 8 }}>
        Modo offline — ingresa tu PIN
      </p>

      {/* Indicador offline */}
      <div style={{
        background: 'rgba(212,160,23,0.1)',
        border: '1px solid rgba(212,160,23,0.3)',
        borderRadius: 20,
        padding: '4px 14px',
        color: '#D4A017',
        fontSize: 12,
        fontWeight: 600,
        marginBottom: 32,
      }}>
        📴 Sin conexión
      </div>

      {/* Puntos PIN */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 32 }}>
        {[0,1,2,3].map(i => (
          <div key={i} style={{
            width: 16, height: 16,
            borderRadius: '50%',
            background: error ? '#EF4444' : pin.length > i ? '#D4A017' : '#1E3352',
            border: `2px solid ${error ? '#EF4444' : pin.length > i ? '#D4A017' : '#264570'}`,
            transition: 'all 0.15s',
          }} />
        ))}
      </div>

      {/* Teclado numérico */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 72px)',
        gap: 12,
      }}>
        {[1,2,3,4,5,6,7,8,9].map(n => (
          <button
            key={n}
            onClick={() => handlePin(String(n))}
            style={{
              height: 72,
              borderRadius: 16,
              background: '#152438',
              border: '1px solid #264570',
              color: '#fff',
              fontSize: 24,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            {n}
          </button>
        ))}
        {/* Fila inferior: borrar, 0, enter */}
        <button
          onClick={borrar}
          style={{
            height: 72, borderRadius: 16,
            background: '#152438', border: '1px solid #264570',
            color: '#8899AA', fontSize: 18, cursor: 'pointer',
          }}
        >
          ←
        </button>
        <button
          onClick={() => handlePin('0')}
          style={{
            height: 72, borderRadius: 16,
            background: '#152438', border: '1px solid #264570',
            color: '#fff', fontSize: 24, fontWeight: 700, cursor: 'pointer',
          }}
        >
          0
        </button>
        <button
          onClick={() => {}}
          style={{
            height: 72, borderRadius: 16,
            background: '#D4A017', border: 'none',
            color: '#0D1B2E', fontSize: 20, cursor: 'pointer',
          }}
        >
          ✓
        </button>
      </div>

      {error && (
        <p style={{ color: '#EF4444', fontSize: 13, marginTop: 20, fontWeight: 600 }}>
          PIN incorrecto. Intenta de nuevo.
        </p>
      )}
    </div>
  );
}
