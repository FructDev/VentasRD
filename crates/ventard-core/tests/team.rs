#![cfg(feature="encrypted-storage")]
use serde_json::json;
#[test]
#[ignore="requires the explicit isolated PostgreSQL team fixture"]
fn team_postgres_receipt_roundtrip_remains_private_and_survives_encrypted_reopen(){
 let file=std::env::var("VENTARD_TEAM_FIXTURE_OUTPUT").expect("isolated synthetic fixture path");let fixture:serde_json::Value=serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
 let request=&fixture["request"];let ctx:CatalogueContext=serde_json::from_value(request["context"].clone()).unwrap();let input:team::Input=serde_json::from_value(json!({"operationId":request["operationId"],"command":request["command"]})).unwrap();
 let root=std::env::temp_dir().join(format!("ventard-team-roundtrip-owned-{}",uuid::Uuid::new_v4()));std::fs::create_dir(&root).unwrap();let key=CipherKey::new([0x76;32]);let mut vault=VaultWriter::create_encrypted(&root,&key).unwrap();let c=vault.connection();
 let wire=team::prepare(c,&ctx,input).unwrap();assert_eq!(wire.hash,fixture["receipt"]["requestHash"].as_str().unwrap());
 let mut forged=fixture["receipt"].clone();forged["member"]["role"]=json!("admin");assert!(team::finish(c,&ctx,&wire,&forged).is_err());assert!(team::local(c,&ctx).unwrap()["lastReceipt"].is_null());
 team::finish(c,&ctx,&wire,&fixture["receipt"]).unwrap();team::finish(c,&ctx,&wire,&fixture["receipt"]).unwrap();assert!(team::pending(c,&ctx).unwrap().is_none());
 drop(vault);let mut vault=VaultWriter::open_encrypted(&root,&key).unwrap();assert_eq!(team::local(vault.connection(),&ctx).unwrap()["lastReceipt"],fixture["receipt"]);drop(vault);std::fs::remove_dir_all(root).unwrap();
}
use ventard_core::storage::{team,cipher::CipherKey,writer::VaultWriter,catalogue_preview::CatalogueContext};
fn id(n:u32)->String{format!("96600000-0000-4000-8000-{n:012}")}
#[test]
fn team_request_survives_encrypted_reopen_and_never_changes_grants_sales_or_roles(){
 let root=std::env::temp_dir().join(format!("ventard-team-owned-{}",uuid::Uuid::new_v4()));std::fs::create_dir(&root).unwrap();let key=CipherKey::new([0x75;32]);
 let ctx=CatalogueContext{tenant_id:id(1),actor_id:id(2),installation_id:id(3),device_id:id(4),writer_epoch:"1".into(),scope_type:"GLOBAL".into(),branch_id:None};
 let input:team::Input=serde_json::from_value(json!({"operationId":id(5),"command":{"kind":"INVITE","name":"Ana QA","email":"ana@example.test","role":"vendedor"}})).unwrap();
 let mut vault=VaultWriter::create_encrypted(&root,&key).unwrap();let wire=team::prepare(vault.connection(),&ctx,input.clone()).unwrap();let original=wire.request.clone();
 let duplicate=team::prepare(vault.connection(),&ctx,input.clone()).unwrap();assert_eq!(duplicate.request,wire.request);
 let mut other=input.clone();other.operation_id=id(6);assert!(team::prepare(vault.connection(),&ctx,other).is_err());
 drop(vault);let mut vault=VaultWriter::open_encrypted(&root,&key).unwrap();let c=vault.connection();let pending=team::pending(c,&ctx).unwrap().unwrap();assert_eq!(pending.operation_id,id(5));let w=team::prepare(c,&ctx,pending).unwrap();assert_eq!(w.request,original);
 let mut another=ctx.clone();another.actor_id=id(7);assert!(team::pending(c,&another).unwrap().is_none());assert!(team::prepare(c,&another,input).is_err());
 let receipt=json!({"version":"ventard.team.receipt.1","status":"CANCELLED","operationId":id(5),"tenantId":id(1),"actorId":id(2),"requestHash":w.hash,"member":null,"invitePath":null});let mut bad=receipt.clone();bad["actorId"]=json!(id(7));assert!(team::finish(c,&ctx,&w,&bad).is_err());assert!(team::pending(c,&ctx).unwrap().is_some());
 team::finish(c,&ctx,&w,&receipt).unwrap();team::finish(c,&ctx,&w,&receipt).unwrap();assert!(team::pending(c,&ctx).unwrap().is_none());
 for table in ["operation_journal","outbox","payments","inventory_movements","offline_grants","native_access_grant_cache_v1"]{assert_eq!(c.query_row(&format!("SELECT count(*) FROM {table}"),[],|r|r.get::<_,i64>(0)).unwrap(),0)}
 drop(vault);std::fs::remove_dir_all(root).unwrap();
}
