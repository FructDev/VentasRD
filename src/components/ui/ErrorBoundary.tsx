'use client';

import React from 'react';

interface Props {
    children: React.ReactNode;
    fallback?: React.ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo) {
        console.error('[ErrorBoundary] Error no capturado:', error, info.componentStack);
    }

    handleReset = () => {
        this.setState({ hasError: false, error: null });
        window.location.href = '/';
    };

    render() {
        if (this.state.hasError) {
            if (this.props.fallback) return this.props.fallback;

            return (
                <div
                    style={{
                        minHeight: '100vh',
                        background: '#0D1B2E',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: 24,
                        fontFamily: 'sans-serif',
                        textAlign: 'center',
                    }}
                >
                    <div
                        style={{
                            width: 64, height: 64,
                            background: 'rgba(239,68,68,0.15)',
                            border: '1px solid rgba(239,68,68,0.3)',
                            borderRadius: 16,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: 28,
                            marginBottom: 24,
                        }}
                    >
                        ⚠️
                    </div>

                    <h1 style={{ color: '#fff', fontSize: 22, fontWeight: 800, marginBottom: 8 }}>
                        Algo salió mal
                    </h1>
                    <p style={{ color: '#8899AA', fontSize: 14, marginBottom: 8, maxWidth: 360 }}>
                        Hubo un error inesperado. Tus datos están seguros — están guardados localmente.
                    </p>

                    {this.state.error && (
                        <code
                            style={{
                                display: 'block',
                                background: 'rgba(239,68,68,0.08)',
                                border: '1px solid rgba(239,68,68,0.2)',
                                borderRadius: 8,
                                padding: '8px 16px',
                                color: '#EF4444',
                                fontSize: 11,
                                maxWidth: 480,
                                wordBreak: 'break-all',
                                marginBottom: 32,
                            }}
                        >
                            {this.state.error.message}
                        </code>
                    )}

                    <button
                        onClick={this.handleReset}
                        style={{
                            background: '#D4A017',
                            color: '#0D1B2E',
                            border: 'none',
                            borderRadius: 12,
                            padding: '12px 28px',
                            fontSize: 15,
                            fontWeight: 800,
                            cursor: 'pointer',
                        }}
                    >
                        Volver al inicio
                    </button>
                </div>
            );
        }

        return this.props.children;
    }
}
