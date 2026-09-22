# Kit comercial de VentaRD

Kit listo para promocionar VentaRD sin depender de visitas presenciales.

## Objetivo

Convertir publicaciones de Instagram, Facebook, TikTok y estados de WhatsApp en conversaciones calificadas por WhatsApp, demostraciones remotas y pruebas acompañadas.

## Mensaje central

> VentaRD organiza las ventas, el inventario, la caja y los clientes de tu negocio. Para tiendas de celulares también controla reparaciones, garantías por IMEI y apartados.

El modo sin internet es un diferenciador importante, pero no debe ser la única explicación del producto.

## Archivos

- `estrategia.md`: posicionamiento, oferta, embudo y rutina semanal.
- `calendario-30-dias.md`: doce publicaciones organizadas por semana.
- `guiones-videos.md`: doce guiones completos con tomas, voz y CTA.
- `copys-publicaciones.md`: textos listos para copiar y publicar.
- `whatsapp-ventas.md`: respuestas rápidas, calificación y seguimiento.
- `demo-remota.md`: estructura de la demostración grabada y llamada en vivo.
- `negocios-generales.md`: campaña, guiones y copys para ferreterías, tiendas,
  repuestos y otros comercios, sin reemplazar la línea de celulares.
- `generar-artes.mjs`: genera posts, historias y el folleto PDF.
- `salida/`: PNG y PDF listos para publicar o enviar. Los archivos que empiezan
  por `general-` pertenecen a la campaña para negocios generales.

## Embudo recomendado

```text
Reel/carrusel/estado
        ↓
Mensaje “DEMO” por WhatsApp
        ↓
5 preguntas de calificación
        ↓
Video grabado de 3 minutos
        ↓
Demo remota de 15 minutos
        ↓
Prueba configurada y acompañada
        ↓
Activación de pago
```

## Cómo generar nuevamente los artes

Desde la raíz del proyecto:

```bash
node marketing/kit-ventas/generar-artes.mjs
```

Antes de publicar, cambia en `generar-artes.mjs`:

- `WHATSAPP`: número comercial.
- `MARCA_URL`: dominio o usuario social.
- Testimonio de ejemplo por una cita autorizada de un cliente real.

## Rutina sostenible

- Sábado, 2 horas: grabar tres videos y programar publicaciones.
- Martes en la noche: demostraciones remotas.
- Diez minutos diarios: responder y etiquetar conversaciones de WhatsApp.
- Una vez al mes: grabar un testimonio o caso real.

## Regla de publicación

Cada pieza debe tener un solo problema, una sola demostración y una sola llamada a la acción. No enumerar todas las funciones en cada publicación.
