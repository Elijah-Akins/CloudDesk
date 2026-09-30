import Stripe from 'stripe';
import { env } from './environment';

export const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16',
  typescript: true,
});

export const STRIPE_PRICES = {
  team: {
    monthly: env.STRIPE_TEAM_MONTHLY_PRICE_ID,
    yearly: env.STRIPE_TEAM_YEARLY_PRICE_ID,
  },
  enterprise: {
    monthly: env.STRIPE_ENTERPRISE_MONTHLY_PRICE_ID,
    yearly: env.STRIPE_ENTERPRISE_YEARLY_PRICE_ID,
  },
} as const;

export function getPriceId(tier: 'team' | 'enterprise', cycle: 'monthly' | 'yearly'): string {
  return STRIPE_PRICES[tier][cycle];
}

/**
 * Reverse of getPriceId: find the plan for a Stripe price ID
 * Returns null for prices that are not configured
 */
export function getPlanForPriceId(
  priceId: string
): { tier: 'team' | 'enterprise'; billingCycle: 'monthly' | 'yearly' } | null {
  for (const tier of ['team', 'enterprise'] as const) {
    for (const billingCycle of ['monthly', 'yearly'] as const) {
      if (priceId && STRIPE_PRICES[tier][billingCycle] === priceId) {
        return { tier, billingCycle };
      }
    }
  }
  return null;
}
