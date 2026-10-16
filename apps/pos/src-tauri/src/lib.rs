#![forbid(unsafe_code)]
#[cfg(all(windows, feature = "qa-spike"))]
mod access;
pub mod platform;
#[cfg(all(windows, feature = "qa-spike"))]
mod qa;

fn allowed_navigation(url: &tauri::Url, development: bool) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    match (url.scheme(), url.host_str(), url.port()) {
        ("tauri", Some("localhost"), None) => true,
        ("http" | "https", Some("tauri.localhost"), None) => true,
        ("http", Some("127.0.0.1"), Some(1420)) => development,
        _ => false,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Sólo enlace al core: NO abrir/crear DB sin aprovisionamiento/llave OS.
    assert!(!ventard_core::domain::sale_quote::CALCULATION_VERSION.is_empty());
    let builder = tauri::Builder::default().setup(|app| {
        #[cfg(all(windows, feature = "qa-spike"))]
        {
            use tauri::Manager;
            let root = if cfg!(debug_assertions) {
                std::env::var("VENTARD_QA_FIXTURE_ROOT")
                    .ok()
                    .map(|s| qa::fixture_root(&s))
                    .transpose()
                    .map_err(|_| "QA_PATH_INVALID")?
            } else {
                None
            };
            let root = root.unwrap_or(app.path().app_data_dir()?.join("synthetic-spike-v1"));
            app.manage(std::sync::Arc::new(qa::QaState::new(root)));
            let access_root = if cfg!(debug_assertions) {
                std::env::var("VENTARD_QA_FIXTURE_ROOT")
                    .ok()
                    .map(|p| qa::fixture_root(&p).map(|p| p.join("native-access")))
                    .transpose()
                    .map_err(|_| "QA_PATH_INVALID")?
            } else {
                None
            };
            app.manage(std::sync::Arc::new(
                access::AccessState::new(
                    access_root.unwrap_or(app.path().app_data_dir()?.join("staging-access-v1")),
                )
                .with_bundled_config(
                    app.path()
                        .resource_dir()?
                        .join("public-staging-config.json"),
                ),
            ));
        }
        let config = app
            .config()
            .app
            .windows
            .first()
            .ok_or("NATIVE_WINDOW_CONFIG_MISSING")?;
        let development = cfg!(debug_assertions) && !cfg!(feature = "custom-protocol");
        // Harness debug sin abrir ventanas al usuario; no altera permisos.
        let smoke = cfg!(debug_assertions) && std::env::var_os("VENTARD_QA_SHELL_SMOKE").is_some();
        let window = tauri::WebviewWindowBuilder::from_config(app, config)?
            .visible(!smoke)
            .on_navigation(move |url| allowed_navigation(url, development))
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .on_document_title_changed(|_, title| {
                // Señal fija del spike, no volcar títulos/URLs/datos libres.
                if title == "VentaRD nativo" {
                    println!("NATIVE_UI_READY");
                }
            });
        // CDP sólo para harness QA DEBUG opt-in; nunca habilitado al abrir
        // normalmente ni en release. Se acepta exclusivamente loopback.
        #[cfg(all(windows, feature = "qa-spike", debug_assertions))]
        let window = if let Ok(port) = std::env::var("VENTARD_QA_CDP_PORT") {
            let port = port
                .parse::<u16>()
                .ok()
                .filter(|p| *p >= 1024)
                .ok_or("QA_PORT_INVALID")?;
            // Perfil WebView aislado por proceso de harness; no compartir CDP
            // con otro proceso/user-data del usuario. SQLite permanece estable.
            let fixture =
                std::env::var("VENTARD_QA_FIXTURE_ROOT").map_err(|_| "QA_FIXTURE_REQUIRED")?;
            let vault = qa::fixture_root(&fixture).map_err(|_| "QA_PATH_INVALID")?;
            let profile = vault
                .parent()
                .ok_or("QA_PATH_INVALID")?
                .join(format!("webview-{port}"));
            window
                .data_directory(profile)
                .additional_browser_args(&format!(
                    "--remote-debugging-port={port} --remote-debugging-address=127.0.0.1"
                ))
        } else {
            window
        };
        window.build()?;
        Ok(())
    });
    #[cfg(all(windows, feature = "qa-spike"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        qa::qa_read,
        qa::qa_create,
        qa::qa_sell,
        qa::qa_result,
        qa::qa_quote,
        qa::qa_sale_abandon,
        qa::qa_sale_ticket,
        qa::qa_history_read,
        qa::qa_product_save,
        qa::qa_stock_adjust,
        qa::qa_cart_save,
        qa::qa_cart_action,
        access::native_access_status,
        access::native_access_login,
        access::native_access_provision,
        access::native_access_pin,
        access::native_access_lock,
        access::native_catalogue_download,
        access::native_catalogue_read,
        access::native_cart_read,
        access::native_cart_save,
        access::native_cart_action,
        access::native_catalogue_quote,
        access::native_cash_read,
        access::native_history_read,
        access::native_history_ticket,
        access::native_fiscal_read,
        access::native_fiscal_prepare,
        access::sales::native_sales,
        access::backup::native_backup
    ]);
    builder
        .run(tauri::generate_context!())
        .expect("NATIVE_SHELL_START_FAILED");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn packaged_navigation_accepts_only_native_origin() {
        for value in [
            "tauri://localhost/index.html#/catalogo",
            "http://tauri.localhost/#/estado",
            "https://tauri.localhost/",
        ] {
            assert!(allowed_navigation(
                &tauri::Url::parse(value).unwrap(),
                false
            ));
        }
    }
    #[test]
    fn external_urls_and_privileged_schemes_are_denied() {
        for value in [
            "https://ventard.vercel.app/",
            "http://tauri.localhost.evil.test/",
            "https://user:pass@tauri.localhost/",
            "http://tauri.localhost:9999/",
            "tauri://evil/",
            "javascript:alert(1)",
            "data:text/html,probe",
            "file:///C:/probe",
        ] {
            assert!(!allowed_navigation(
                &tauri::Url::parse(value).unwrap(),
                true
            ));
        }
    }
    #[test]
    fn dev_only_vite_origin_is_not_accepted_in_packaged_mode() {
        let url = tauri::Url::parse("http://127.0.0.1:1420/#/catalogo").unwrap();
        assert!(allowed_navigation(&url, true));
        assert!(!allowed_navigation(&url, false));
        assert!(!allowed_navigation(
            &tauri::Url::parse("http://127.0.0.1:3001/").unwrap(),
            true
        ));
    }
}
