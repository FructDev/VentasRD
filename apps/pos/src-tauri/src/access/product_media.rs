//! Download only original public product references read from the scoped vault.
//! No renderer URL, bearer token or third-party redirects. Cache is disposable.
use super::*;
use ventard_core::{application::product_media as media, domain::canonical::sha256_hex};
fn thumbnail_url(source: &str) -> Option<reqwest::Url> {
    let mut url = reqwest::Url::parse(source).ok()?;
    if url.scheme() != "https"
        || url.host_str() != Some("res.cloudinary.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let (base, image) = url.path().split_once("/image/upload/")?;
    if base.is_empty()
        || image.is_empty()
        || base.trim_matches('/').contains('/')
        || !image.contains("ventard/productos/")
    {
        return None;
    }
    // Cloudinary URL contract: https://cloudinary.com/documentation/transformation_reference
    let path = format!("{base}/image/upload/c_limit,w_160,h_160/f_png/{image}");
    url.set_path(&path);
    Some(url)
}
impl AccessState {
    pub(super) fn product_photos(&self, ids: Vec<String>) -> Result<Value, AccessError> {
        if ids.len() > 12 {
            return Err(error("ACCESS_REQUEST_INVALID"));
        }
        let n = self.sales_network()?;
        let ctx = n.selected.catalogue_context();
        let x = ctx.clone();
        let jobs = n
            .writer
            .call(move |c| media::requests(c, &x, &ids))
            .map_err(|e|error(e.code()))?;
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(3))
            .build()
            .map_err(|_| error("ACCESS_NETWORK_UNAVAILABLE"))?;
        let mut rows = vec![];
        for job in jobs {
            let id = job["id"]
                .as_str()
                .ok_or(error("ACCESS_RESPONSE_INVALID"))?
                .to_owned();
            let source = job["source"]
                .as_str()
                .ok_or(error("ACCESS_RESPONSE_INVALID"))?
                .to_owned();
            let version = sha256_hex(source.as_bytes());
            let data = thumbnail_url(&source).and_then(|url| {
                let r = client.get(url).header("accept", "image/png").send().ok()?;
                if r.status().as_u16() != 200 || r.content_length().is_some_and(|n| n > 98304) {
                    return None;
                }
                let mut bytes = vec![];
                r.take(98305).read_to_end(&mut bytes).ok()?;
                if bytes.len() > 98304 {
                    return None;
                }
                let data = format!(
                    "data:image/png;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                );
                media::validate(&data).ok()?;
                Some(data)
            });
            self.sales_current(&n)?;
            if let Some(data) = data {
                let x = ctx.clone();
                let pid = id.clone();
                let image = data.clone();
                let saved = n
                    .writer
                    .call(move |c| media::save(c, &x, &pid, &source, &image))
                    .map_err(|e|error(e.code()))?;
                if saved {
                    rows.push(json!({"id":id,"version":version,"data":data}));
                }
            }
        }
        self.sales_current(&n)?;
        Ok(json!({"rows":rows}))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn original_cloudinary_photos_are_bounded_without_redirect_or_auth_targets() {
        let source =
            "https://res.cloudinary.com/demo/image/upload/v1/ventard/productos/owned-qa.jpg";
        assert_eq!(thumbnail_url(source).unwrap().as_str(),"https://res.cloudinary.com/demo/image/upload/c_limit,w_160,h_160/f_png/v1/ventard/productos/owned-qa.jpg");
        for source in [
            "http://res.cloudinary.com/demo/image/upload/ventard/productos/qa.jpg",
            "https://res.cloudinary.com.invalid/demo/image/upload/ventard/productos/qa.jpg",
            "https://secret@res.cloudinary.com/demo/image/upload/ventard/productos/qa.jpg",
            "https://127.0.0.1/image/upload/ventard/productos/qa.jpg",
            "https://res.cloudinary.com/demo/image/upload/other.jpg",
            "https://res.cloudinary.com/demo/image/upload/ventard/productos/qa.jpg?token=forbidden",
        ] {
            assert!(thumbnail_url(source).is_none());
        }
    }
}

