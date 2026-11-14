/**
 * 浏览器端加密工具
 * 明文与密钥只在浏览器内处理，服务端拿到的永远只是密文
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64Url(bytes) {
  let bin = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64Url(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomB64(len) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return toB64Url(bytes);
}

async function aesEncrypt(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(text));
  return { ct: toB64Url(ct), iv: toB64Url(iv) };
}

async function aesDecrypt(key, ivB64, ctB64) {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64Url(ivB64) },
    key,
    fromB64Url(ctB64)
  );
  return dec.decode(plain);
}

/* ---------- 链接模式：随机密钥放在 URL # 后面，不会发到服务器 ---------- */

export async function encryptWithLink(text) {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
  const { ct, iv } = await aesEncrypt(key, text);
  return {
    payload: { ct, iv, mode: "link" },
    fragment: { m: "link", k: toB64Url(keyBytes) },
  };
}

export async function decryptWithLink(ctB64, ivB64, keyB64) {
  const key = await crypto.subtle.importKey(
    "raw",
    fromB64Url(keyB64),
    "AES-GCM",
    false,
    ["decrypt"]
  );
  return aesDecrypt(key, ivB64, ctB64);
}

/* ---------- 口令模式：用 PBKDF2 从口令派生密钥，盐也放在 # 后面 ---------- */

async function deriveKey(passphrase, saltBytes) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: 200000,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptWithPass(text, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(passphrase, salt);
  const { ct, iv } = await aesEncrypt(key, text);
  return {
    payload: { ct, iv, mode: "pass" },
    fragment: { m: "pass", s: toB64Url(salt) },
  };
}

export async function decryptWithPass(ctB64, ivB64, saltB64, passphrase) {
  const key = await deriveKey(passphrase, fromB64Url(saltB64));
  return aesDecrypt(key, ivB64, ctB64);
}
