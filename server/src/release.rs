use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Deserialize)]
struct Release {
    version: String,
    android_version_code: u64,
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

pub fn android_code() -> u64 {
    serde_json::from_str::<Release>(include_str!("../../release.json"))
        .unwrap()
        .android_version_code
}
