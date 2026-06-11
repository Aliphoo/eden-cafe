const encoder = new TextEncoder();

const bytesToHex = (bytes: Uint8Array) =>
  Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export const makeSecuritySalt = () => {
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
};

export const hashSecurityPin = async (pin: string, salt: string) => {
  const digest = await window.crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${salt}:${pin}`)
  );

  return bytesToHex(new Uint8Array(digest));
};

export const verifySecurityPin = async (
  pin: string,
  salt: string,
  expectedHash: string
) => {
  if (!pin || !salt || !expectedHash) {
    return false;
  }

  return hashSecurityPin(pin, salt).then((hash) => hash === expectedHash);
};

export const makeSalt = makeSecuritySalt;
export const hashPin = hashSecurityPin;
export const verifyPinHash = verifySecurityPin;
