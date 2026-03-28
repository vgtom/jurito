import type { Request, Response } from "express";
import type { MiddlewareConfigFn } from "wasp/server";
import { HttpError } from "wasp/server";

import {
  finalizePartySigningByToken,
  lookupSigningInviteByToken,
  rejectSigningByToken,
} from "./operations";

export const signingApiMiddleware: MiddlewareConfigFn = (middlewareConfig) =>
  middlewareConfig;

/** Wasp passes `context` as the third argument to API handlers (entities injection). */
type SigningApiContext = {
  entities: {
    Document: unknown;
    DocumentParty: unknown;
  };
};

export async function getSigningInviteHttp(
  req: Request,
  res: Response,
  _context: SigningApiContext,
): Promise<void> {
  const token = req.params["token"];
  if (typeof token !== "string" || token.length < 16) {
    res.status(400).json({ message: "Invalid token." });
    return;
  }

  const invite = await lookupSigningInviteByToken(token);
  if (!invite) {
    res.status(404).json(null);
    return;
  }
  res.json(invite);
}

export async function rejectPartySigningHttp(
  req: Request,
  res: Response,
  _context: SigningApiContext,
): Promise<void> {
  const token = req.params["token"];
  if (typeof token !== "string" || token.length < 16) {
    res.status(400).json({ message: "Invalid token." });
    return;
  }

  try {
    const result = await rejectSigningByToken(token);
    res.json(result);
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ message: err.message });
      return;
    }
    throw err;
  }
}

export async function completePartySigningHttp(
  req: Request,
  res: Response,
  _context: SigningApiContext,
): Promise<void> {
  const token = req.params["token"];
  if (typeof token !== "string" || token.length < 16) {
    res.status(400).json({ message: "Invalid token." });
    return;
  }

  try {
    const body =
      req.body && typeof req.body === "object" ? req.body : undefined;
    const result = await finalizePartySigningByToken(token, body);
    res.json(result);
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ message: err.message });
      return;
    }
    throw err;
  }
}
