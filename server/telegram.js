import crypto from "crypto";

function safeEqualHex(a, b) {
  try {
    const aa = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}

export function validateTelegramInitData(initData, botToken, maxAgeSeconds = 86400) {
  if (!initData || !botToken) throw new Error("Missing Telegram initData");

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const authDate = Number(params.get("auth_date"));

  if (!hash || !Number.isFinite(authDate)) throw new Error("Invalid Telegram initData");
  if (Math.floor(Date.now() / 1000) - authDate > maxAgeSeconds) {
    throw new Error("Telegram initData expired");
  }

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();

  const calculated = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (!safeEqualHex(calculated, hash)) throw new Error("Telegram signature invalid");

  const userRaw = params.get("user");
  if (!userRaw) throw new Error("Telegram user missing");

  return JSON.parse(userRaw);
}
