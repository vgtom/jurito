import { UserPlan } from "@prisma/client";

import { PaymentPlanId } from "../../payment/plans";

/**
 * Maps a paid OpenSaaS subscription (Hobby or Pro) to app {@link UserPlan.PRO}.
 * Credit-only purchases do not use this — leave `plan` unchanged on the user.
 */
export function userPlanForActiveSubscription(
  planId: PaymentPlanId,
): UserPlan {
  if (planId === PaymentPlanId.Pro || planId === PaymentPlanId.Hobby) {
    return UserPlan.PRO;
  }
  return UserPlan.FREE;
}
