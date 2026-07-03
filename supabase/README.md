# Migraciones de base de datos

El esquema de Supabase se versiona aquí. **Nunca más correr ALTERs sueltos
en el SQL Editor**: cada cambio de esquema es un archivo en `migrations/`
que viaja en el mismo commit que el código que lo usa.

## Configuración inicial (una sola vez por máquina)

```bash
npx supabase login                    # abre el navegador para autorizar
npx supabase link --project-ref XXX  # XXX = ref del proyecto (Dashboard → Settings → General)
```

## Aplicar migraciones pendientes al proyecto

```bash
npx supabase db push
```

Muestra qué migraciones faltan y las aplica en orden. Todas las migraciones
de este repo son **idempotentes** (`if not exists` / `drop policy if exists`),
así que es seguro aplicarlas aunque parte del cambio ya se hubiera corrido
a mano en el pasado.

## Crear una migración nueva

```bash
npx supabase migration new nombre_del_cambio
```

Crea `migrations/<timestamp>_nombre_del_cambio.sql`; escribir ahí el SQL
(idempotente siempre que sea posible) y commitearlo junto al código.

## Regla de oro

El deploy de Vercel **nunca** debe adelantarse a la base de datos:
antes de hacer push de código que usa columnas/tablas nuevas, correr
`npx supabase db push`.

> Los scripts históricos en `scripts/sql/` quedan como referencia; lo que
> estaba pendiente de ellos ya está recogido en las migraciones 20260703*.
