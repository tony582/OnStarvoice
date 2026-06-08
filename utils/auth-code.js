const ENCRYPTED_PREFIX = "enc:v1:";
const AUTH_CODE_KEY_SEED = "onstarvoice.auth.code.local.v1";
const AES_ALGORITHM = "AES-GCM";
const AES_IV_LENGTH = 12;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

let cachedKeyPromise = null;

export const AUTH_CODE_VIEW_MODE = {
  ENCRYPTED: "encrypted",
  PLAINTEXT: "plaintext",
};

export function normalizeAuthCodeInput(value) {
  return String(value ?? "").trim();
}

export function isEncryptedAuthCode(value) {
  return normalizeAuthCodeInput(value).startsWith(ENCRYPTED_PREFIX);
}

export async function encryptAuthCode(value) {
  const plainCode = normalizeAuthCodeInput(value);
  if (!plainCode) return "";
  if (isEncryptedAuthCode(plainCode)) return plainCode;

  const key = await getAuthCodeKey();
  const iv = crypto.getRandomValues(new Uint8Array(AES_IV_LENGTH));
  const cipherBuffer = await crypto.subtle.encrypt(
    {name: AES_ALGORITHM, iv},
    key,
    textEncoder.encode(plainCode),
  );

  const payload = new Uint8Array(iv.length + cipherBuffer.byteLength);
  payload.set(iv, 0);
  payload.set(new Uint8Array(cipherBuffer), iv.length);

  return `${ENCRYPTED_PREFIX}${bytesToBase64Url(payload)}`;
}

export async function decryptAuthCode(value) {
  const storedCode = normalizeAuthCodeInput(value);
  if (!storedCode) return "";
  if (!isEncryptedAuthCode(storedCode)) return storedCode;

  const payloadBase64Url = storedCode.slice(ENCRYPTED_PREFIX.length);
  const payloadBytes = base64UrlToBytes(payloadBase64Url);
  if (payloadBytes.byteLength <= AES_IV_LENGTH) {
    throw new Error("Encrypted auth code payload is invalid");
  }

  const iv = payloadBytes.slice(0, AES_IV_LENGTH);
  const ciphertext = payloadBytes.slice(AES_IV_LENGTH);
  const key = await getAuthCodeKey();

  const plainBuffer = await crypto.subtle.decrypt(
    {name: AES_ALGORITHM, iv},
    key,
    ciphertext,
  );

  return normalizeAuthCodeInput(textDecoder.decode(plainBuffer));
}

export async function ensureEncryptedAuthCode(value) {
  const normalized = normalizeAuthCodeInput(value);
  if (!normalized) return "";
  return isEncryptedAuthCode(normalized)
    ? normalized
    : await encryptAuthCode(normalized);
}

export async function ensurePlainAuthCode(value) {
  return await decryptAuthCode(value);
}

async function getAuthCodeKey() {
  if (cachedKeyPromise) return cachedKeyPromise;

  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto API is unavailable in current context");
  }

  cachedKeyPromise = (async () => {
    const seedHash = await crypto.subtle.digest(
      "SHA-256",
      textEncoder.encode(AUTH_CODE_KEY_SEED),
    );
    return await crypto.subtle.importKey(
      "raw",
      seedHash,
      {name: AES_ALGORITHM},
      false,
      ["encrypt", "decrypt"],
    );
  })();

  return cachedKeyPromise;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(base64Url) {
  const normalized = String(base64Url || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}
