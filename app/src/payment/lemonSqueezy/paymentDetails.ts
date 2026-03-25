import { PrismaClient, type UserPlan } from "@prisma/client";
import type { SubscriptionStatus } from "../plans";
import { PaymentPlanId } from "../plans";

export const updateUserLemonSqueezyPaymentDetails = async (
  {
    lemonSqueezyId,
    userId,
    subscriptionPlan,
    subscriptionStatus,
    datePaid,
    numOfCreditsPurchased,
    lemonSqueezyCustomerPortalUrl,
    plan,
  }: {
    lemonSqueezyId: string;
    userId: string;
    subscriptionPlan?: PaymentPlanId;
    subscriptionStatus?: SubscriptionStatus;
    numOfCreditsPurchased?: number;
    lemonSqueezyCustomerPortalUrl?: string;
    datePaid?: Date;
    /** When set, updates `User.plan` (e.g. PRO after successful subscription payment). */
    plan?: UserPlan;
  },
  prismaUserDelegate: PrismaClient["user"],
) => {
  return prismaUserDelegate.update({
    where: {
      id: userId,
    },
    data: {
      paymentProcessorUserId: lemonSqueezyId,
      lemonSqueezyCustomerPortalUrl,
      subscriptionPlan,
      subscriptionStatus,
      datePaid,
      credits:
        numOfCreditsPurchased !== undefined
          ? { increment: numOfCreditsPurchased }
          : undefined,
      ...(plan !== undefined ? { plan } : {}),
    },
  });
};
