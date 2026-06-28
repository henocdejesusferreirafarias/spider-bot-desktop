//! Nucleo nativo de licenciamento do Spider BOT.
//!
//! Move para codigo compilado (fora do app.asar, dificil de patchar em JS) as
//! duas operacoes sensiveis da Frente C:
//!   - `verify_license_token`: verificacao da assinatura EdDSA do JWT de licenca.
//!   - `compute_fingerprint`: derivacao do fingerprint atado a hardware.
//!
//! Paridade exata exigida:
//!   - `verify_license_token` espelha `verifyLicenseJwt` (apps/api/src/security/jwt.ts)
//!     e o `verifyToken` do desktop (apps/desktop/src/main/services/license-service.ts).
//!   - `compute_fingerprint` espelha byte-a-byte `createFingerprintHash` (Frente A)
//!     para que trocar JS -> nativo NAO altere o fingerprint nem invalide devices.

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::pkcs8::DecodePublicKey;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use hkdf::Hkdf;
use napi::{Error, Result};
use napi_derive::napi;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret};

const LICENSE_JWT_ACTIVE_KID: &str = "license-0d0d13d7b3991f2f";
const LICENSE_JWT_ACTIVE_PUBLIC_KEY_PEM: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAxpjShU/jAUHnpCmDNYaYFoJCx+9qzpaRdgyyQfVPEDE=\n-----END PUBLIC KEY-----";
include!(concat!(env!("OUT_DIR"), "/payload_trust.rs"));

/// Verifica a assinatura EdDSA (Ed25519) de um JWT de licenca e retorna o
/// payload (claims) como string JSON. Lanca erro se token malformado, algoritmo
/// invalido, assinatura invalida ou iss/aud incorretos.
#[napi]
pub fn verify_license_token(token: String) -> Result<String> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 || parts[0].is_empty() || parts[1].is_empty() || parts[2].is_empty() {
        return Err(Error::from_reason("Token de licenca malformado."));
    }

    // Cabecalho: exigir alg=EdDSA e typ=JWT.
    let header_bytes = URL_SAFE_NO_PAD
        .decode(parts[0])
        .map_err(|_| Error::from_reason("Cabecalho do token invalido."))?;
    let header: serde_json::Value = serde_json::from_slice(&header_bytes)
        .map_err(|_| Error::from_reason("Cabecalho do token invalido."))?;
    if header.get("alg").and_then(|v| v.as_str()) != Some("EdDSA")
        || header.get("typ").and_then(|v| v.as_str()) != Some("JWT")
        || header.get("kid").and_then(|v| v.as_str()) != Some(LICENSE_JWT_ACTIVE_KID)
    {
        return Err(Error::from_reason("Token de licenca usa algoritmo invalido."));
    }

    // Ancora de confianca compilada. O processo JavaScript nao pode substitui-la.
    let verifying_key = VerifyingKey::from_public_key_pem(LICENSE_JWT_ACTIVE_PUBLIC_KEY_PEM)
        .map_err(|_| Error::from_reason("Chave publica de licenca invalida."))?;

    // Assinatura sobre "header.payload" (bytes ASCII do signing input).
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(parts[2])
        .map_err(|_| Error::from_reason("Assinatura do token invalida."))?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| Error::from_reason("Assinatura do token invalida."))?;
    let signing_input = format!("{}.{}", parts[0], parts[1]);
    verifying_key
        .verify_strict(signing_input.as_bytes(), &signature)
        .map_err(|_| Error::from_reason("Assinatura da licenca invalida."))?;

    // Payload: validar emissor/audiencia e devolver o JSON cru para o TS.
    let payload_bytes = URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|_| Error::from_reason("Payload do token invalido."))?;
    let claims: serde_json::Value = serde_json::from_slice(&payload_bytes)
        .map_err(|_| Error::from_reason("Payload do token invalido."))?;
    if claims.get("iss").and_then(|v| v.as_str()) != Some("spider-bot-api")
        || claims.get("aud").and_then(|v| v.as_str()) != Some("spider-bot-desktop")
    {
        return Err(Error::from_reason("Token de licenca nao pertence ao Spider BOT."));
    }

    String::from_utf8(payload_bytes).map_err(|_| Error::from_reason("Payload do token invalido."))
}

/// Fingerprint do dispositivo atado a hardware. Retorna `None` quando nenhum
/// componente de hardware pode ser coletado (ex.: SO sem as ferramentas); nesse
/// caso o lado TS aplica o fallback por instalacao.
///
/// Paridade byte-a-byte com `createFingerprintHash` da Frente A:
///   hardware_id = sha256("spider-bot-hw-v2" + ":" + base)
///   fingerprint = "v2$" + sha256("spider-bot-device-v2" + ":" + hardware_id)
#[napi]
pub fn compute_fingerprint() -> Option<String> {
    let components = collect_hardware_components();
    if components.is_empty() {
        return None;
    }
    let base = components.join("|");
    let hardware_id = sha256_hex(&concat3(b"spider-bot-hw-v2", b":", base.as_bytes()));
    let device = sha256_hex(&concat3(
        b"spider-bot-device-v2",
        b":",
        hardware_id.as_bytes(),
    ));
    Some(format!("v2${}", device))
}

// ---------------------------------------------------------------------------
// Identidade criptografica do dispositivo. As seeds privadas sao aleatorias e
// persistidas apenas dentro de um blob DPAPI ligado ao usuario do Windows.

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceIdentitySecrets {
    version: u8,
    signing_seed: String,
    encryption_seed: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceIdentityPublic {
    version: u8,
    key_id: String,
    signing_public_key: String,
    encryption_public_key: String,
}

#[napi]
pub fn get_device_identity(storage_path: String) -> Result<String> {
    let secrets = load_or_create_device_identity(&storage_path)?;
    let signing = SigningKey::from_bytes(&decode_seed(&secrets.signing_seed)?);
    let encryption = StaticSecret::from(decode_seed(&secrets.encryption_seed)?);
    let signing_public = signing.verifying_key().to_bytes();
    let encryption_public = X25519PublicKey::from(&encryption);
    let public = DeviceIdentityPublic {
        version: secrets.version,
        key_id: format!("device-{}", &sha256_hex(&signing_public)[..16]),
        signing_public_key: URL_SAFE_NO_PAD.encode(signing_public),
        encryption_public_key: URL_SAFE_NO_PAD.encode(encryption_public.as_bytes()),
    };
    serde_json::to_string(&public)
        .map_err(|_| Error::from_reason("Falha ao serializar identidade do dispositivo."))
}

#[napi]
pub fn sign_device_proof(storage_path: String, purpose: String, fields_json: String) -> Result<String> {
    if purpose.is_empty() || purpose.len() > 80 {
        return Err(Error::from_reason("Proposito da prova de dispositivo invalido."));
    }
    let _: serde_json::Value = serde_json::from_str(&fields_json)
        .map_err(|_| Error::from_reason("Campos da prova de dispositivo invalidos."))?;
    let secrets = load_or_create_device_identity(&storage_path)?;
    let signing = SigningKey::from_bytes(&decode_seed(&secrets.signing_seed)?);
    let message = format!("spider-bot-device-proof-v1\n{}\n{}", purpose, fields_json);
    Ok(URL_SAFE_NO_PAD.encode(signing.sign(message.as_bytes()).to_bytes()))
}

/// Decifra um envelope de payload (Frente B) servido pelo servidor. Espelha
/// byte-a-byte o `sealPayload` (apps/api/src/security/payload-envelope.ts):
///   shared = X25519(device_priv, eph_pub)
///   key    = HKDF-SHA256(ikm=shared, salt=eph_pub||device_pub, info="spider-bot-payload-v1")
///   aad    = utf8(`${payloadId}:${version}`)
///   pt     = AES-256-GCM-open(key, nonce, ciphertext||tag, aad)
/// Retorna o texto em claro do payload. Lanca em erro/adulteracao/maquina errada.
#[napi]
pub fn decapsulate(storage_path: String, envelope_json: String) -> Result<String> {
    let env: serde_json::Value = serde_json::from_str(&envelope_json)
        .map_err(|_| Error::from_reason("Envelope de payload invalido."))?;

    if env.get("alg").and_then(|v| v.as_str()) != Some("x25519-hkdf-sha256-aes256gcm") {
        return Err(Error::from_reason("Algoritmo de envelope nao suportado."));
    }
    let payload_id = env
        .get("payloadId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| Error::from_reason("Envelope sem payloadId."))?;
    let version = env
        .get("version")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| Error::from_reason("Envelope sem version."))?;

    let eph_pub_raw = decode_b64(&env, "ephemeralPublicKey")?;
    let nonce_raw = decode_b64(&env, "nonce")?;
    let ciphertext = decode_b64(&env, "ciphertext")?;
    let tag = decode_b64(&env, "tag")?;

    if eph_pub_raw.len() != 32 || nonce_raw.len() != 12 {
        return Err(Error::from_reason("Campos do envelope com tamanho invalido."));
    }
    let eph_pub_bytes: [u8; 32] = eph_pub_raw
        .as_slice()
        .try_into()
        .map_err(|_| Error::from_reason("Chave efemera invalida."))?;

    let secrets = load_or_create_device_identity(&storage_path)?;
    let secret = StaticSecret::from(decode_seed(&secrets.encryption_seed)?);
    let device_pub = X25519PublicKey::from(&secret);
    let eph_pub = X25519PublicKey::from(eph_pub_bytes);
    let shared = secret.diffie_hellman(&eph_pub);

    let mut salt = Vec::with_capacity(64);
    salt.extend_from_slice(eph_pub.as_bytes());
    salt.extend_from_slice(device_pub.as_bytes());
    let hk = Hkdf::<Sha256>::new(Some(&salt), shared.as_bytes());
    let mut key = [0u8; 32];
    hk.expand(b"spider-bot-payload-v1", &mut key)
        .map_err(|_| Error::from_reason("Falha na derivacao da chave do payload."))?;

    let mut ct_and_tag = ciphertext;
    ct_and_tag.extend_from_slice(&tag);
    let aad = format!("{}:{}", payload_id, version);
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| Error::from_reason("Chave AES invalida."))?;
    let nonce = Nonce::from_slice(&nonce_raw);
    let plaintext = cipher
        .decrypt(nonce, Payload { msg: &ct_and_tag, aad: aad.as_bytes() })
        .map_err(|_| Error::from_reason("Falha ao decifrar o payload (chave/integridade)."))?;

    String::from_utf8(plaintext).map_err(|_| Error::from_reason("Payload decifrado nao e UTF-8."))
}

#[napi]
pub fn decapsulate_signed_payload(storage_path: String, envelope_json: String) -> Result<String> {
    let envelope: serde_json::Value = serde_json::from_str(&envelope_json)
        .map_err(|_| Error::from_reason("Envelope de payload invalido."))?;
    let envelope_payload_id = envelope
        .get("payloadId")
        .and_then(|value| value.as_str())
        .ok_or_else(|| Error::from_reason("Envelope sem payloadId."))?
        .to_string();
    let envelope_version = envelope
        .get("version")
        .and_then(|value| value.as_u64())
        .ok_or_else(|| Error::from_reason("Envelope sem version."))?;
    let plaintext = decapsulate(storage_path, envelope_json)?;
    let artifact: serde_json::Value = serde_json::from_str(&plaintext)
        .map_err(|_| Error::from_reason("Artefato de payload invalido."))?;
    let payload_id = artifact
        .get("payloadId")
        .and_then(|value| value.as_str())
        .ok_or_else(|| Error::from_reason("Artefato sem payloadId."))?;
    let version = artifact
        .get("version")
        .and_then(|value| value.as_u64())
        .ok_or_else(|| Error::from_reason("Artefato sem version."))?;
    let content = artifact
        .get("content")
        .and_then(|value| value.as_str())
        .ok_or_else(|| Error::from_reason("Artefato sem content."))?;
    let content_sha256 = artifact
        .get("contentSha256")
        .and_then(|value| value.as_str())
        .ok_or_else(|| Error::from_reason("Artefato sem contentSha256."))?;
    let signature_kid = artifact
        .get("signatureKid")
        .and_then(|value| value.as_str())
        .ok_or_else(|| Error::from_reason("Artefato sem signatureKid."))?;
    let signature_raw = artifact
        .get("signature")
        .and_then(|value| value.as_str())
        .ok_or_else(|| Error::from_reason("Artefato sem signature."))?;

    if payload_id != envelope_payload_id
        || version != envelope_version
        || sha256_hex(content.as_bytes()) != content_sha256
        || signature_kid != PAYLOAD_SIGNING_KID
    {
        return Err(Error::from_reason("Integridade do payload invalida."));
    }
    let verifying_key = VerifyingKey::from_public_key_pem(PAYLOAD_SIGNING_PUBLIC_KEY_PEM)
        .map_err(|_| Error::from_reason("Chave publica de payload invalida."))?;
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(signature_raw)
        .map_err(|_| Error::from_reason("Assinatura do payload invalida."))?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| Error::from_reason("Assinatura do payload invalida."))?;
    let message = format!(
        "spider-bot-payload-v1\n{}\n{}\n{}",
        payload_id, version, content_sha256
    );
    verifying_key
        .verify_strict(message.as_bytes(), &signature)
        .map_err(|_| Error::from_reason("Assinatura do payload invalida."))?;
    Ok(content.to_string())
}

fn decode_seed(value: &str) -> Result<[u8; 32]> {
    let raw = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| Error::from_reason("Seed da identidade invalida."))?;
    raw.as_slice()
        .try_into()
        .map_err(|_| Error::from_reason("Seed da identidade com tamanho invalido."))
}

fn load_or_create_device_identity(storage_path: &str) -> Result<DeviceIdentitySecrets> {
    let path = Path::new(storage_path);
    if path.exists() {
        let protected = std::fs::read(path)
            .map_err(|_| Error::from_reason("Falha ao ler identidade protegida do dispositivo."))?;
        let plaintext = dpapi_unprotect(&protected)?;
        return serde_json::from_slice(&plaintext)
            .map_err(|_| Error::from_reason("Identidade protegida do dispositivo invalida."));
    }

    let mut signing_seed = [0u8; 32];
    let mut encryption_seed = [0u8; 32];
    OsRng.fill_bytes(&mut signing_seed);
    OsRng.fill_bytes(&mut encryption_seed);
    let secrets = DeviceIdentitySecrets {
        version: 1,
        signing_seed: URL_SAFE_NO_PAD.encode(signing_seed),
        encryption_seed: URL_SAFE_NO_PAD.encode(encryption_seed),
    };
    let plaintext = serde_json::to_vec(&secrets)
        .map_err(|_| Error::from_reason("Falha ao serializar identidade do dispositivo."))?;
    let protected = dpapi_protect(&plaintext)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|_| Error::from_reason("Falha ao criar diretorio da identidade do dispositivo."))?;
    }
    std::fs::write(path, protected)
        .map_err(|_| Error::from_reason("Falha ao persistir identidade protegida do dispositivo."))?;
    Ok(secrets)
}

#[cfg(windows)]
fn dpapi_protect(plaintext: &[u8]) -> Result<Vec<u8>> {
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
    };
    use windows_sys::Win32::System::Memory::LocalFree;

    let mut input = CRYPT_INTEGER_BLOB {
        cbData: plaintext.len() as u32,
        pbData: plaintext.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    let ok = unsafe {
        CryptProtectData(
            &mut input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(Error::from_reason("DPAPI nao conseguiu proteger a identidade do dispositivo."));
    }
    let result = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData as isize) };
    Ok(result)
}

#[cfg(windows)]
fn dpapi_unprotect(ciphertext: &[u8]) -> Result<Vec<u8>> {
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
    };
    use windows_sys::Win32::System::Memory::LocalFree;

    let mut input = CRYPT_INTEGER_BLOB {
        cbData: ciphertext.len() as u32,
        pbData: ciphertext.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    let ok = unsafe {
        CryptUnprotectData(
            &mut input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(Error::from_reason("DPAPI nao conseguiu abrir a identidade do dispositivo."));
    }
    let result = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData as isize) };
    Ok(result)
}

#[cfg(not(windows))]
fn dpapi_protect(_plaintext: &[u8]) -> Result<Vec<u8>> {
    Err(Error::from_reason("Identidade DPAPI requer Windows."))
}

#[cfg(not(windows))]
fn dpapi_unprotect(_ciphertext: &[u8]) -> Result<Vec<u8>> {
    Err(Error::from_reason("Identidade DPAPI requer Windows."))
}

fn decode_b64(env: &serde_json::Value, field: &str) -> Result<Vec<u8>> {
    let value = env
        .get(field)
        .and_then(|v| v.as_str())
        .ok_or_else(|| Error::from_reason(format!("Envelope sem {}.", field)))?;
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| Error::from_reason(format!("Campo {} invalido (base64url).", field)))
}

fn concat3(a: &[u8], b: &[u8], c: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(a.len() + b.len() + c.len());
    v.extend_from_slice(a);
    v.extend_from_slice(b);
    v.extend_from_slice(c);
    v
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

#[cfg(windows)]
fn collect_hardware_components() -> Vec<String> {
    let mut parts = Vec::new();
    if let Some(guid) = read_machine_guid() {
        let g = guid.trim().to_lowercase();
        if !g.is_empty() {
            parts.push(format!("mg:{}", g));
        }
    }
    if let Some(uuid) = read_csproduct_uuid() {
        let u = uuid.trim().to_uppercase();
        if !u.is_empty()
            && !u.starts_with("00000000-")
            && u != "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"
        {
            parts.push(format!("csp:{}", u));
        }
    }
    parts
}

#[cfg(windows)]
fn read_machine_guid() -> Option<String> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};
    use winreg::RegKey;
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let key = hklm
        .open_subkey_with_flags("SOFTWARE\\Microsoft\\Cryptography", KEY_READ | KEY_WOW64_64KEY)
        .ok()?;
    key.get_value("MachineGuid").ok()
}

#[cfg(windows)]
fn read_csproduct_uuid() -> Option<String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(Get-CimInstance -ClassName Win32_ComputerSystemProduct).UUID",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

#[cfg(not(windows))]
fn collect_hardware_components() -> Vec<String> {
    Vec::new()
}
