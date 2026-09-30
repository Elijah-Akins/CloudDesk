import { Request, Response, NextFunction } from 'express';
import Stripe from 'stripe';
import * as stripeService from '../services/stripeService';
import { logger } from '../utils/logger';

/**
 * Handle Stripe webhook
 *
 * Responds 400 for an invalid signature and 500 when processing fails, so
 * Stripe retries the event instead of treating it as delivered.
 */
export async function handleStripeWebhook(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  const signature = req.headers['stripe-signature'] as string;
  const rawBody = (req as Request & { rawBody: Buffer }).rawBody;

  let event: Stripe.Event;
  try {
    event = stripeService.constructWebhookEvent(rawBody, signature);
  } catch {
    // Already logged by the service
    res.status(400).json({ received: false, error: 'Invalid webhook signature' });
    return;
  }

  try {
    await stripeService.handleWebhookEvent(event);
    res.json({ received: true });
  } catch (error) {
    logger.error(`Webhook processing failed for ${event.type} (${event.id}):`, error);
    res.status(500).json({ received: false, error: 'Webhook processing failed' });
  }
}
