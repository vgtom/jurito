import { useAuth } from "wasp/client/auth";
import { useNavigate } from "react-router-dom";
import type { ReactNode } from "react";

import { routes } from "wasp/client/router";

type Props = {
  children: ReactNode;
  /**
   * When true, non-admin users on FREE plan see an upgrade overlay (click → billing).
   * Admins always see children.
   */
  gated: boolean;
  /** Defaults to pricing (where users can upgrade). */
  billingPath?: string;
};

/**
 * Wraps premium UI (e.g. upload, signing). When `gated` is true and the user is on FREE
 * (and not admin), shows a dimmed overlay that navigates to the billing/pricing page.
 */
export function PremiumFeature({
  children,
  gated,
  billingPath = routes.PricingPageRoute.to,
}: Props) {
  const { data: user } = useAuth();
  const navigate = useNavigate();

  if (!user) {
    return null;
  }

  const hasPremiumAccess = user.isAdmin || user.plan === "PRO";

  if (!gated || hasPremiumAccess) {
    return <>{children}</>;
  }

  return (
    <div
      className="relative rounded-md"
      role="button"
      tabIndex={0}
      onClick={() => navigate(billingPath)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          navigate(billingPath);
        }
      }}
    >
      <div className="pointer-events-none opacity-50">{children}</div>
      <div className="bg-background/70 absolute inset-0 flex cursor-pointer items-center justify-center rounded-md border border-dashed border-primary/40 p-3">
        <span className="text-primary text-center text-sm font-medium">
          Upgrade to Pro →
        </span>
      </div>
    </div>
  );
}
