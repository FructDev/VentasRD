-- Stock en vivo entre cajas: publica los INSERT de movimientos_stock por
-- Supabase Realtime (websocket). La caja del taller se entera AL INSTANTE de
-- que la caja de ventas vendió un repuesto — incluso con la pestaña en
-- segundo plano, donde el sync por intervalo está pausado.
-- RLS aplica igual en Realtime: cada negocio solo recibe sus movimientos.
do $$
begin
    alter publication supabase_realtime add table movimientos_stock;
exception
    when duplicate_object then
        raise notice 'movimientos_stock ya estaba en la publicacion';
end $$;
