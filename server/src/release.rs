use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Deserialize)]
struct Release {
    version: String,
}

pub fn version() -> &'static str {
    static RELEASE: OnceLock<Release> = OnceLock::new();
    &RELEASE
        .get_or_init(|| {
            serde_json::from_str(include_str!("../../release.json"))
                .expect("Bundled release manifest must be valid JSON")
        })
        .version
}
