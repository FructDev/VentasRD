<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Cambios de esquema (Supabase)

Todo cambio de esquema va en una migración versionada en `supabase/migrations/` (crear con `npx supabase migration new <nombre>`), commiteada junto al código que la usa. Escribir SQL idempotente (`if not exists`). NO entregar ALTERs sueltos para el SQL Editor. Ver `supabase/README.md`.
