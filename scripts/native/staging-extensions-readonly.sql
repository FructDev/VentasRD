select jsonb_build_object(
 'migrations',(select jsonb_agg(version order by version) from supabase_migrations.schema_migrations),
 'members',(select jsonb_agg(jsonb_build_object('tenant',negocio_id,'actor',user_id,'role',rol)) from public.usuarios_negocio where negocio_id in ('96000000-0000-4000-8000-000000000001','96000000-0000-4000-8000-000000000002')),
 'owners',(select jsonb_agg(jsonb_build_object('tenant',id,'actor',"dueño_id")) from public.negocios where id in ('96000000-0000-4000-8000-000000000001','96000000-0000-4000-8000-000000000002')),
 'modes',(select jsonb_agg(to_jsonb(m)) from public.native_sales_mode_v1 m where negocio_id in ('96000000-0000-4000-8000-000000000001','96000000-0000-4000-8000-000000000002')),
 'installs',(select jsonb_agg(jsonb_build_object('tenant',negocio_id,'installation',installation_id,'device',device_id,'scope',scope_kind,'branch',sucursal_id,'epoch',writer_epoch,'status',status)) from public.native_installations_v1 where negocio_id in ('96000000-0000-4000-8000-000000000001','96000000-0000-4000-8000-000000000002'))
) as qa_state;
