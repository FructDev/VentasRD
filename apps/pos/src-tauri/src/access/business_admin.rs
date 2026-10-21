use super::*;
impl AccessState {
    pub(super) fn administration(&self, action: &'static str, operation:Option<String>, payload:Value)->Result<Value,AccessError>{
        self.deny_archive()?;
        if let Some(op)=&operation {id(op)?;}
        let context=self.sales_local(|_,ctx,g,high,opens|{team::authorize(&g,high,opens)?;Ok(ctx)})?;
        let n=self.sales_network()?;
        if n.selected.catalogue_context()!=context{return Err(error("ACCESS_CONTEXT_CHANGED"));}
        let result=Self::sales_rpc(&n,"native_business_admin_v1",json!({"p_context":context,"p_action":action,"p_operation_id":operation,"p_payload":payload}));
        self.sales_current(&n)?;
        result.map_err(|(status,_,_)|error(match status{401=>"ACCESS_LOGIN_REQUIRED",403=>"PERMISSION_DENIED",404=>"ADMIN_MIGRATION_REQUIRED",400|409|422=>"ADMIN_REMOTE_CONFLICT",_=>"ADMIN_REMOTE_UNAVAILABLE"}))
    }
}
