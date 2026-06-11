import qrcodeFactory from "qrcode-generator";

type PromptPaySettings = {
  promptPayId: string;
  merchantName: string;
  city: string;
};

type QrLogoOptions = {
  logoRatio?: number;
  logoSrc?: string;
};

const DEFAULT_LOGO_SRC = "Images/Logo.webp";
const MIN_LOGO_RATIO = 0.16;
const MAX_LOGO_RATIO = 0.2;

const roundMoney = (value: number) => Math.round(Number(value || 0) * 100) / 100;

const emvQrField = (id: string, value: string | number) => {
  const text = String(value ?? "");
  return id.padStart(2, "0") + String(text.length).padStart(2, "0") + text;
};

const cleanPromptPayId = (value: string) => String(value ?? "").replace(/\D/g, "");

const promptPayProxyField = (promptPayId: string) => {
  const id = cleanPromptPayId(promptPayId);

  if (/^0\d{9}$/.test(id)) {
    return emvQrField("01", "0066" + id.slice(1));
  }

  if (/^\d{13}$/.test(id)) {
    return emvQrField("02", id);
  }

  if (/^\d{15}$/.test(id)) {
    return emvQrField("03", id);
  }

  return emvQrField("02", id);
};

const promptPayCrc16 = (payload: string) => {
  let crc = 0xffff;

  for (let index = 0; index < payload.length; index += 1) {
    crc ^= payload.charCodeAt(index) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }

  return crc.toString(16).toUpperCase().padStart(4, "0");
};

export const buildPromptPayPayload = (
  amount: number,
  settings: PromptPaySettings
) => {
  const total = roundMoney(amount);
  const merchantInfo =
    emvQrField("00", "A000000677010111") +
    promptPayProxyField(settings.promptPayId);
  let payload =
    emvQrField("00", "01") +
    emvQrField("01", total > 0 ? "12" : "11") +
    emvQrField("29", merchantInfo) +
    emvQrField("53", "764");

  if (total > 0) {
    payload += emvQrField("54", total.toFixed(2));
  }

  payload +=
    emvQrField("58", "TH") +
    emvQrField("59", settings.merchantName.slice(0, 25)) +
    emvQrField("60", settings.city.slice(0, 15)) +
    "6304";

  return payload + promptPayCrc16(payload);
};

export const createQrDataUrl = (payload: string) => {
  const qr = qrcodeFactory(0, "H");
  qr.addData(payload);
  qr.make();
  return qr.createDataURL(8, 1);
};

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Unable to load image: ${src}`));
    image.src = src;
  });

const drawRoundedRect = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) => {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(
    x + width,
    y + height,
    x + width - safeRadius,
    y + height
  );
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
};

export const createQrDataUrlWithLogo = async (
  payload: string,
  options: QrLogoOptions = {}
) => {
  const fallbackQrUrl = createQrDataUrl(payload);

  if (typeof document === "undefined") {
    return fallbackQrUrl;
  }

  try {
    const [qrImage, logoImage] = await Promise.all([
      loadImage(fallbackQrUrl),
      loadImage(options.logoSrc || DEFAULT_LOGO_SRC)
    ]);
    const size = Math.max(qrImage.naturalWidth || qrImage.width, 240);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    if (!context) {
      return fallbackQrUrl;
    }

    canvas.width = size;
    canvas.height = size;
    context.drawImage(qrImage, 0, 0, size, size);

    const logoRatio = Math.min(
      Math.max(options.logoRatio ?? 0.18, MIN_LOGO_RATIO),
      MAX_LOGO_RATIO
    );
    const logoMaxSize = size * logoRatio;
    const logoScale = Math.min(
      logoMaxSize / (logoImage.naturalWidth || logoImage.width || logoMaxSize),
      logoMaxSize / (logoImage.naturalHeight || logoImage.height || logoMaxSize)
    );
    const logoWidth = (logoImage.naturalWidth || logoImage.width) * logoScale;
    const logoHeight = (logoImage.naturalHeight || logoImage.height) * logoScale;
    const logoX = (size - logoWidth) / 2;
    const logoY = (size - logoHeight) / 2;
    const padding = size * 0.028;
    const boxX = logoX - padding;
    const boxY = logoY - padding;
    const boxWidth = logoWidth + padding * 2;
    const boxHeight = logoHeight + padding * 2;

    context.fillStyle = "#ffffff";
    drawRoundedRect(context, boxX, boxY, boxWidth, boxHeight, size * 0.025);
    context.fill();
    context.drawImage(logoImage, logoX, logoY, logoWidth, logoHeight);

    return canvas.toDataURL("image/png");
  } catch {
    return fallbackQrUrl;
  }
};
