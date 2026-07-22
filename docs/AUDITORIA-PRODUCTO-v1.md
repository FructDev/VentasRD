# VentaRD — Auditoría de Producto v1.0

**Fecha:** 19 de julio de 2026 · **Estado:** Producción activa · **Propietario:** FructDev

Este documento es el expediente maestro del producto: qué es, cómo funciona, dónde está y hacia dónde va. Se actualiza por versiones (v1.0, v1.1…) con cada hito relevante.

---

## 1. Resumen ejecutivo

**VentaRD** es un punto de venta (POS) SaaS **offline-first** para pequeños negocios de República Dominicana: colmados, tiendas de celulares, farmacias, boutiques. Su tesis central: *en RD se va la luz y se cae el internet, y el negocio no puede parar*. Todo funciona en el dispositivo (celular, tablet o PC) y se sincroniza con la nube cuando hay señal.

- **Modelo:** suscripción mensual/anual (Básico RD$900/mes · Pro RD$1,200/mes), prueba gratis sin tarjeta, cobro por transferencia vía WhatsApp/QR.
- **Distribución:** PWA instalable desde el navegador — sin App Store, sin técnicos.
- **Estado:** 50+ negocios activos, comunidad creciendo por boca a boca y referidos.
- **Diferenciadores:** offline real (no degradado), fiados como ciudadano de primera clase, precios y lenguaje diseñados para el comercio informal dominicano, y un asistente de insights que le dice al dueño cosas que no sabía de su negocio.

---

## 2. Historia y estado actual

### Origen
VentaRD nace de una observación directa del mercado dominicano: los POS internacionales (Square, Loyverse) asumen internet estable, cobran en dólares, ignoran el fiado y no hablan el idioma del colmadero. El fundador construyó un sistema que asume la realidad local: apagones, "apúntamelo ahí", el ticket por WhatsApp y la quincena.

### Hitos técnicos (cronología 2026)
| Período | Hito |
|---|---|
| Pre-junio | Núcleo: POS offline (Dexie/IndexedDB + Supabase), ventas, inventario, fiados, caja con cortes X/Z, NCF (DGII), multi-caja con stock atómico, roles de equipo |
| Junio | Plan Pro (3 fases): **Reparaciones** (orden, checklist, firma, estados, bitácora), **Garantías por IMEI**, **Apartados** (plan separe). Reportes 607 DGII. Impresión térmica ESC/POS directa |
| Julio (sem. 1) | Personalización por tienda (color, tipografía, logo), catálogo público con pedidos por WhatsApp, programa de referidos (+15 días ambos), recibos por WhatsApp con branding, instalación PWA con un toque |
| Julio (sem. 2) | **Profesionalización**: migraciones versionadas de BD, auth+validación zod en todas las APIs, rate limiting, 68 tests unitarios en CI, rama staging, términos/privacidad/centro de ayuda, panel de salud de negocios, cobro estructurado con registro de pagos |
| Julio (sem. 3) | **Crisis resueltas** (ver §11): fiados duplicados (doble-submit), sync envenenado (lotes → fila por fila), negocios duplicados (índice único), onboarding atascado. **Realtime** para stock en vivo entre cajas |
| Julio (sem. 4) | Asistente "Tu día" (10 reglas de insights), escáner de cámara, ventas en espera, cliente+ubicación en factura, QR de transferencia con página /pagar |

### Estado actual
- **Producción:** ventard.vercel.app (Vercel + Supabase). Deploy continuo desde `main`, rama `staging` disponible.
- **Calidad:** CI bloqueante (typecheck + 68 tests + build), Sentry, smoke tests E2E de flujos críticos (NCF concurrente, stock multi-caja, offline).
- **Defensa anti-evasión:** vencimiento local + gracia, marca de agua anti-reloj, contador de aperturas offline, firma de integridad del localStorage, detección de trials ciclados.

---

## 3. Visión a 3-5 años

**Misión:** que ningún negocio pequeño dominicano vuelva a perder una venta, un fiado o un peso por falta de sistema.

**La escalera:**

1. **Año 1 (ahora):** dominar el nicho "POS que no se cae" en RD. 100-300 negocios pagando. Boca a boca + referidos como motor. El Asistente como razón de indispensabilidad.
2. **Año 2:** *el sistema operativo del negocio informal*: cobros integrados (links de pago cuando el volumen lo justifique), asistente con IA narrativa y "pregúntale a tu negocio" (Plan Pro), facturación electrónica e-CF cuando la DGII la exija a pymes, verticales adicionales (farmacia, repuestos) sobre la base Pro. 500-1,000 negocios.
3. **Años 3-5:** expansión regional a mercados con el mismo dolor (Haití frontera, Centroamérica, Caribe hispano) donde "offline-first + fiado + WhatsApp" es igual de válido. Equipo pequeño (2-5 personas: soporte, ventas, dev). Evaluación de levantar capital **solo si** el crecimiento orgánico lo pide — el modelo es rentable por diseño (costos fijos ~US$45/mes hoy).

**Principio innegociable:** la facilidad de uso. Cada feature debe poder usarla un cajero nuevo en su primera venta. Lo que exija manual, no entra.

---

## 4. Módulos del producto

### Plan Básico (RD$900/mes · RD$9,000/año)
| Módulo | Capacidades |
|---|---|
| **POS / Ventas** | Búsqueda difusa, escáner de cámara y pistola, venta libre (F4), ventas en espera (pausar/retomar), descuentos % y monto, precios por nivel (menudeo/mayoreo/especial), NCF automático, cliente en factura (registrado o texto libre), pagos: efectivo/tarjeta/transferencia (con QR)/fiado/mixto |
| **Inventario** | CRUD con fotos (Cloudinary), importar/exportar Excel, edición inline de precio/stock, kardex por producto, combos con recetas, ubicación física, reorden inteligente, ganancia potencial |
| **Fiados** | Cargo automático al vender, límites de crédito, abonos, estado de cuenta por WhatsApp, lista "a quién cobrar hoy" |
| **Caja** | Apertura/cierre por turno, ingresos/egresos, corte X/Z impreso con hilo de dinero completo (ventas + reparaciones + apartados por método) |
| **Clientes** | Ficha 360 (compras, fiados, reparaciones, apartados), búsqueda/filtros/orden |
| **Reportes** | Dashboard en vivo, ganancia neta real (con gastos), reporte 607 DGII, exportes |
| **Gastos** | Registro por categoría, impacto en ganancia real |
| **Equipo** | Invitación por link, roles admin/vendedor/cajero con permisos duros |
| **Asistente "Tu día"** | 10 reglas locales: comparativas, stock por agotarse, fiados fríos, mejor día, quincena RD, margen semanal, lista de compras con inversión, anomalía del día, hora pico, estancados |
| **Extras** | Catálogo público por link con pedidos a WhatsApp, personalización de marca (color/tipografía/logo), impresión térmica 58/80mm directa, recibos por WhatsApp, Estado del Sistema (diagnóstico) |

### Plan Pro (RD$1,200/mes · RD$12,000/año) — todo lo anterior más:
| Módulo | Capacidades |
|---|---|
| **Reparaciones** | Orden con checklist de condición y firma, cotización→aprobación→estados→entrega, aviso al cliente por WhatsApp, pagos múltiples, repuestos desde inventario, despiece de abandonados, reingreso por garantía, bitácora auditada, ficha por equipo (historia por IMEI) |
| **Garantías** | Por número de serie/IMEI, plazo configurable, consulta instantánea |
| **Apartados** | Plan separe con abonos, reserva de seriales, contrato/recibos impresos, recordatorio WhatsApp |

### Roles y acceso
- **Admin/Dueño:** todo. **Vendedor:** POS, historial, clientes, resumen, reparaciones/garantías/apartados — sin inventario ni reportes ni ajustes. **Cajero:** solo POS. Enforcement en navegación, router y páginas.

---

## 5. Flujos de usuario clave

1. **Alta:** landing → registro (correo+clave, sin verificación por email, sin tarjeta) → onboarding de 3 campos → directo al POS (sucursal única auto-seleccionada). **< 2 minutos hasta la primera venta.**
2. **Venta:** buscar/escanear → carrito → (cliente opcional) → método de pago → cobrar → ticket (impreso/WhatsApp). Doble-submit imposible (candado global).
3. **Fiado:** método "Fiado" → elegir cliente → cargo automático → recordatorios y abonos desde Clientes.
4. **Reparación (Pro):** recepción con checklist+firma → cotización → aviso WhatsApp "listo" → entrega con pagos → garantía.
5. **Offline:** todo lo anterior sin internet; PIN al reabrir offline; sync automático al volver la señal; stock entre cajas por Realtime (~2s) con reconciliación de respaldo.
6. **Cobro del SaaS (operador):** vence trial → WhatsApp → QR de pago (/pagar) → transferencia → registro en superadmin (monto/método/plan) → acceso extendido; el dispositivo del cliente se entera al reconectar.

---

## 6. Arquitectura técnica

### Stack
- **Frontend:** Next.js 16 (App Router) + React 19 + TypeScript + Tailwind v4. PWA (service worker, instalable).
- **Datos locales:** Dexie (IndexedDB) — fuente de verdad operativa del dispositivo. Estado global: Zustand con persistencia firmada.
- **Nube:** Supabase (Postgres + Auth + Realtime + RLS). Imágenes: Cloudinary (upload firmado server-side).
- **Hosting:** Vercel (main → producción, staging → preview). **Observabilidad:** Sentry.

### El corazón: sincronización offline-first
- Worker cada 15s (pausado en segundo plano): **pull** incremental por `fecha_actualizacion` + **push** de pendientes (`estado_sincronizacion=0`) **fila por fila** (una fila rechazada jamás bloquea a las demás — lección de la crisis de fiados).
- **Stock multi-caja:** los cambios viajan como movimientos atómicos (RPC idempotente `aplicar_movimiento_stock`) — dos cajas nunca se pisan. Realtime (websocket) propaga entre cajas en ~2s incluso con pestaña minimizada; reconciliación completa cada 120s y al enfocar.
- **NCF:** secuencia centralizada en la nube con bloques reservados por caja — sin duplicados ni offline.
- Purga local diaria de datos viejos ya sincronizados (>90 días); la nube conserva todo.
- Las tablas espejo de la nube **no llevan FKs frágiles** (decisión deliberada: el dispositivo es la verdad; la integridad la garantizan app + RLS).

### Seguridad
- **RLS por negocio** en todas las tablas (`es_miembro_del_negocio`); un negocio jamás ve datos de otro.
- Rutas service-role con **autenticación + validación zod + rate limiting** (helper central `guardia.ts`).
- PIN admin hasheado (SHA-256), superadmin tras secreto de servidor.
- Anti-evasión de pago en 5 capas (vencimiento local, gracia, marca de agua de reloj, contador de aperturas offline, firma de integridad del storage).

### Calidad y proceso
- **Esquema versionado:** `supabase/migrations/` (SQL idempotente, commiteado con el código; regla dura: no ALTERs sueltos).
- **CI (GitHub Actions):** typecheck + 68 tests unitarios (dinero, NCF, carrito, asistente, firma) + build, bloqueantes. Smokes E2E con Playwright.
- Convenciones: candado anti doble-submit (`useCandado`) en todo formulario de creación; código y UX en español dominicano.

---

## 7. Modelo de negocio y licencias

- **Planes:** Básico RD$900/mes · Pro RD$1,200/mes · anuales con 2 meses gratis (9,000/12,000). Promo lanzamiento: primeros 10 a RD$600×2 meses.
- **Trial:** 30 días completos, sin tarjeta. **Referidos:** +15 días para ambos al completar onboarding el invitado (anti-abuso server-side).
- **Cobro:** manual asistido — WhatsApp + QR /pagar + registro estructurado en superadmin (monto/método/plan → `pagos_log` → facturación del mes visible). Automatización con pasarela: planificada para ~50+ pagantes.
- **Enforcement:** el acceso vence solo (incluso offline) con 5 días de gracia; los datos nunca se borran por vencimiento.
- **Costos fijos actuales:** Supabase Pro US$25 + Vercel hobby US$0 + Cloudinary free + dominio ≈ **US$25-45/mes**. Punto de equilibrio: **2 clientes**.

---

## 8. FODA

**Fortalezas**
- Offline-first *real* — el foso defensivo en un país con apagones; los competidores globales lo hacen degradado o no lo hacen.
- Ajuste cultural profundo: fiados, WhatsApp, NCF/607, quincena, lenguaje llano.
- Velocidad de iteración extrema (fundador + IA): features de usuario en horas, bugs críticos resueltos el mismo día.
- Costos casi cero → rentable desde el cliente #2; sin presión de inversionistas.
- Vertical Pro (celulares) con profundidad que un POS genérico no iguala.

**Debilidades**
- Bus factor = 1 (una sola persona en producto, dev, soporte y cobranza).
- Cobro manual — consumirá tiempo creciente hasta automatizarse.
- Dominio ventard.vercel.app (percepción); dominio propio pendiente.
- Deuda técnica conocida: sync en el hilo principal (Web Worker agendado), páginas monolíticas (inventario ~1,500 líneas), lint legacy (~30 `any`/impuros).
- Sin backups de configuración local del usuario (si borra datos del navegador con pendientes, los pierde).

**Oportunidades**
- e-CF (facturación electrónica DGII): cuando sea obligatoria para pymes, tener el módulo listo = ola de adopción forzada.
- Asistente con IA como feature Pro — titular de marketing y margen.
- Verticales nuevas sobre la base Pro (farmacia con vencimientos, repuestos con compatibilidad).
- Región: el mismo dolor existe en todo el Caribe/Centroamérica.

**Amenazas**
- Loyverse (gratis) como opción "suficiente" para colmados sin fiado intensivo.
- Alegra/Bsale bajando al segmento micro con presupuesto de marketing.
- Un cambio regulatorio de la DGII que exija certificaciones costosas.
- Dependencia de Supabase/Vercel (mitigada: Postgres estándar + Next portable; migrable con esfuerzo moderado).

---

## 9. Competencia

| Competidor | Qué es | Por qué VentaRD gana | Riesgo real |
|---|---|---|---|
| **Loyverse** | POS gratis internacional | Sin fiado real, offline limitado, sin NCF/607, inglés-céntrico, soporte lejano | Alto en precio (gratis); su "suficiente" frena upgrades |
| **Alegra** | Facturación/ERP LatAm | Orientado a contabilidad formal, curva de aprendizaje, precio US$, offline débil | Medio; fuerte en pymes formales |
| **Bsale / Defontana** | POS/ERP regional | Sobredimensionados y caros para el colmado | Bajo en el nicho |
| **Sistemas locales RD** (instalables de escritorio) | POS legacy con licencia única | Sin nube, sin móvil, sin actualizaciones, requieren técnico | Medio; inercia instalada |
| **La libreta + calculadora** | El competidor #1 real | Todo el pitch de VentaRD ataca esto | El verdadero rival: la costumbre |

**Posicionamiento:** "El POS dominicano que no se cae" — ni el más barato ni el más grande: el que entiende el negocio de aquí.

---

## 10. Métricas

### Instrumentado hoy (superadmin)
- Negocios: total / vigentes / por vencer / vencidos / sin activar.
- **Facturación del mes** (real, desde `pagos_log`) + comparativa con mes anterior + MRR estimado.
- **Salud por negocio:** última venta sincronizada, ventas 7d (🟢🟡🔴⚫) — radar de churn.
- Detalle por negocio: productos, ventas, clientes, empleados, total facturado histórico, historial de pagos.
- Alerta de trials ciclados (mismo dispositivo, múltiples cuentas).

### North Star propuesta
**Negocios que registraron ventas 5+ días en los últimos 7** ("negocios vivos") — mide valor real entregado, no vanidad.

### A instrumentar (siguiente fase)
- Embudo de activación: registro → onboarding → 1ª venta → 10ª venta → semana 2 (dónde se caen).
- Churn mensual de pagantes y su causa (precio/cierre del negocio/competencia).
- Conversión trial→pago y tiempo hasta el pago. LTV/CAC cuando exista inversión en adquisición.
- *(Los valores actuales de estas métricas los conoce el operador; este documento define QUÉ medir — completar con números en v1.1.)*

---

## 11. Registro de crisis resueltas (memoria institucional)

| Crisis | Causa raíz | Solución permanente |
|---|---|---|
| Fiados duplicados | Doble toque en COBRAR en equipos lentos | Candado por ref instantáneo, generalizado a TODO formulario (`useCandado`) |
| Deudas de fiado invisibles | Push en lote: una fila rechazada bloqueaba todos los cargos siguientes | Push fila por fila en todo el pipeline + eliminación de FKs frágiles + script de reparación de datos |
| "Cuentas duplicadas" / login en bucle | Eventos de auth concurrentes → auto-creación doble de negocio | Candado con cola + consultas tolerantes + **índice único en dueño_id** (imposible por diseño) |
| Onboarding atascado | Botón dependía de estado que podía no llegar; evento de login descartado | API resuelve por token; eventos encolados; API idempotente |
| Stock lento entre cajas | Sync pausado en pestañas en segundo plano | Supabase Realtime (~2s) + sync al enfocar |
| QR leído como teléfono | QR de texto con dígitos | QR = link a página /pagar |

**Lección transversal:** los bugs de dinero se erradican por *clase*, no por síntoma; y toda fila corrupta debe degradar sola, nunca en cadena.

---

## 12. Roadmap

**Corto plazo (1-2 meses)**
- [ ] Dominio propio (.do/.com.do) — compra pendiente del operador
- [ ] Fase 3 omnicanal: pedidos del catálogo → ventas en espera en el POS
- [ ] Web Worker del sync (agendado; en staging con flag de apagado)
- [ ] Cambio de rol de empleados existentes en Mi Equipo (si falta)
- [ ] Instrumentar embudo de activación

**Medio plazo (3-6 meses)**
- [ ] Asistente Nivel 3: IA narrativa + "pregúntale a tu negocio" (exclusivo Pro)
- [ ] Links de pago (Fygaro/Azul) con activación automática del acceso (~50 pagantes)
- [ ] Exportación completa de datos del negocio ("tus datos son tuyos")
- [ ] Descomposición de páginas monolíticas (oportunista)

**Largo plazo (6-18 meses)**
- [ ] e-CF DGII · Verticales (farmacia, repuestos) · API de WhatsApp para avisos automáticos · Primer colaborador (soporte/ventas) · Evaluación regional

---

*Documento generado desde el conocimiento directo del código y la operación. Próxima revisión: v1.1 al cerrar el trimestre, con métricas numéricas del embudo.*
