use std::fs;
use std::path::PathBuf;

fn main() {
    napi_build::setup();
    println!("cargo:rerun-if-env-changed=PAYLOAD_SIGNING_PUBLIC_KEY");
    println!("cargo:rerun-if-env-changed=PAYLOAD_SIGNING_KID");

    let default_key = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAYjJZS30CWy6rppdjVPVqiHGts267sf0CLNlvgyTJKZU=\n-----END PUBLIC KEY-----";
    let public_key = std::env::var("PAYLOAD_SIGNING_PUBLIC_KEY")
        .unwrap_or_else(|_| default_key.to_string())
        .replace("\\n", "\n");
    if !public_key.contains("-----BEGIN PUBLIC KEY-----") {
        panic!("PAYLOAD_SIGNING_PUBLIC_KEY deve ser PEM no build nativo.");
    }
    let kid = std::env::var("PAYLOAD_SIGNING_KID")
        .unwrap_or_else(|_| "payload-45d0ae62f25498b8".to_string());
    let generated = format!(
        "const PAYLOAD_SIGNING_PUBLIC_KEY_PEM: &str = {:?};\nconst PAYLOAD_SIGNING_KID: &str = {:?};\n",
        public_key,
        kid
    );
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    fs::write(out.join("payload_trust.rs"), generated).expect("write payload trust");
}
