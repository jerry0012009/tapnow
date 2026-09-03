const sensitiveKeyPattern =
  /token|authorization|cookie|password|secret|credential|session|phone|email/i;

export function redactValue(value) {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [
        key,
        sensitiveKeyPattern.test(key) ? "[REDACTED]" : redactValue(entryValue),
      ]),
    );
  }
  return value;
}

export function redactText(text) {
  try {
    return JSON.stringify(redactValue(JSON.parse(text)), null, 2);
  } catch {
    return text
      .replaceAll(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
      .replaceAll(
        /([?&](?:token|code|key|secret|ticket)=)[^&\s]+/gi,
        "$1[REDACTED]",
      );
  }
}

export function redactHeaders(headers) {
  const sensitiveHeaders = new Set([
    "authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "x-auth-token",
  ]);
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      sensitiveHeaders.has(key.toLowerCase()) ? "[REDACTED]" : value,
    ]),
  );
}
