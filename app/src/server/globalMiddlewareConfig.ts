import express from "express";
import type { MiddlewareConfigFn } from "wasp/server";

/**
 * Wasp's default `express.json()` uses a small body limit (~100kb), which triggers HTTP 413
 * for `createDocument` (base64 PDF payloads). Match the 20MB PDF cap in documents/operations (~27MB base64).
 */
const JSON_BODY_LIMIT = "32mb";

export const serverMiddlewareConfigFn: MiddlewareConfigFn = (
  middlewareConfig,
) => {
  middlewareConfig.delete("express.json");
  middlewareConfig.set(
    "express.json",
    express.json({ limit: JSON_BODY_LIMIT }),
  );
  return middlewareConfig;
};
