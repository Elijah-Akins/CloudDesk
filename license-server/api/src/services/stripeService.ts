import Stripe from 'stripe';
import { Types } from 'mongoose';
import { stripe, getPriceId, getPlanForPriceId } from '../config/stripe';
import { env } from '../config/environment';
import { Customer } from '../models/Customer';
import { Subscription, ISubscription } from '../models/Subscription';
import { License } from '../models/License';
import { AuditLog } from '../models/AuditLog';
import { NotFoundError, ValidationError } from '../utils/errors';
import { ERROR_CODES, LICENSE_STATUS, SUBSCRIPTION_STATUS, BillingCycle } from '../config/constants';
import { createLicense, suspendLicense, reactivateLicense } from './licenseService';
import { updateStripeCustomerId } from './customerService';
import { sendLicenseKeyEmail, sendPaymentFailedEmail } from './emailService';
import { logger } from '../utils/logger';

/**
 * Create a Stripe checkout session for subscription
 */
export async function createCheckoutSession(
  customerId: string,
  tier: 'team' | 'enterprise',
  billingCycle: BillingCycle
): Promise<string> {
  const customer = await Customer.findById(customerId);
  if (!customer) {
    throw new NotFoundError('Customer not found', ERROR_CODES.CUSTOMER_NOT_FOUND);
  }

  // Get or create Stripe customer
  let stripeCustomerId = customer.stripeCustomerId;

  if (!stripeCustomerId) {
    const stripeCustomer = await stripe.customers.create({
      email: customer.email,
      name: `${customer.firstName} ${customer.lastName}`,
      metadata: {
        customerId: customer._id.toString(),
        organizationName: customer.organizationName,
      },
    });
    stripeCustomerId = stripeCustomer.id;
    await updateStripeCustomerId(customerId, stripeCustomerId);
  }

  // Get price ID
  const priceId = getPriceId(tier, billingCycle);

  if (!priceId) {
    throw new ValidationError(`Price not configured for ${tier} ${billingCycle}`);
  }

  // Create checkout session
  const session = await stripe.checkout.sessions.create({
    customer: stripeCustomerId,
    mode: 'subscription',
    line_items: [
      {
        price: priceId,
        quantity: 1,
      },
    ],
    success_url: `${env.PORTAL_URL}/dashboard?checkout=success`,
    cancel_url: `${env.PORTAL_URL}/pricing?checkout=canceled`,
    metadata: {
      customerId: customer._id.toString(),
      tier,
      billingCycle,
    },
    subscription_data: {
      metadata: {
        customerId: customer._id.toString(),
        tier,
        billingCycle,
      },
    },
  });

  logger.info(`Checkout session created for customer ${customerId}, tier ${tier}`);

  return session.url!;
}

/**
 * Create a Stripe billing portal session
 */
export async function createPortalSession(customerId: string): Promise<string> {
  const customer = await Customer.findById(customerId);
  if (!customer) {
    throw new NotFoundError('Customer not found', ERROR_CODES.CUSTOMER_NOT_FOUND);
  }

  if (!customer.stripeCustomerId) {
    throw new ValidationError('No billing account found. Please subscribe first.');
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: customer.stripeCustomerId,
    return_url: `${env.PORTAL_URL}/dashboard`,
  });

  return session.url;
}

/**
 * Get current subscription for customer
 */
export async function getCurrentSubscription(customerId: string): Promise<ISubscription | null> {
  return Subscription.findOne({
    customerId: new Types.ObjectId(customerId),
    status: { $in: [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.TRIALING, SUBSCRIPTION_STATUS.PAST_DUE] },
  }).sort({ createdAt: -1 });
}

/**
 * Verify a Stripe webhook signature and parse the event
 * Throws ValidationError if the signature is invalid
 */
export function constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event {
  try {
    return stripe.webhooks.constructEvent(
      rawBody,
      signature,
      env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    logger.error('Webhook signature verification failed:', err);
    throw new ValidationError('Invalid webhook signature');
  }
}

/**
 * Handle a verified Stripe webhook event
 * Throws if processing fails, so the webhook responds with an error and Stripe
 * retries the event; handlers must therefore be idempotent.
 */
export async function handleWebhookEvent(event: Stripe.Event): Promise<void> {
  logger.info(`Stripe webhook received: ${event.type}`);

  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutComplete(event.data.object as Stripe.Checkout.Session);
      break;

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
      break;

    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
      break;

    case 'invoice.payment_failed':
      await handlePaymentFailed(event.data.object as Stripe.Invoice);
      break;

    case 'invoice.payment_succeeded':
      await handlePaymentSucceeded(event.data.object as Stripe.Invoice);
      break;

    default:
      logger.debug(`Unhandled webhook event: ${event.type}`);
  }
}

/**
 * Handle checkout session completed
 */
async function handleCheckoutComplete(session: Stripe.Checkout.Session): Promise<void> {
  const { customerId, tier, billingCycle } = session.metadata || {};

  if (!customerId || !tier || !session.subscription) {
    logger.error('Checkout session missing metadata', session.id);
    return;
  }

  // Fetch full subscription details
  const stripeSubscription = await stripe.subscriptions.retrieve(
    session.subscription as string
  );

  // Check if subscription already exists (duplicate or retried event)
  let subscription = await Subscription.findOne({
    stripeSubscriptionId: stripeSubscription.id,
  });

  if (subscription) {
    const existingLicense = await License.findOne({ subscriptionId: subscription._id });
    if (existingLicense) {
      logger.info(`Subscription already exists: ${stripeSubscription.id}`);
      return;
    }
    // An earlier attempt created the subscription but failed before issuing
    // the license; finish the job so the customer still gets a key
    logger.warn(`Subscription ${stripeSubscription.id} has no license, issuing one now`);
  } else {
    // Create subscription record
    subscription = await Subscription.create({
      customerId: new Types.ObjectId(customerId),
      stripeSubscriptionId: stripeSubscription.id,
      stripeCustomerId: session.customer as string,
      tier: tier as 'team' | 'enterprise',
      status: SUBSCRIPTION_STATUS.ACTIVE,
      currentPeriodStart: new Date(stripeSubscription.current_period_start * 1000),
      currentPeriodEnd: new Date(stripeSubscription.current_period_end * 1000),
      metadata: {
        priceId: stripeSubscription.items.data[0]?.price.id || '',
        productId: stripeSubscription.items.data[0]?.price.product as string || '',
        billingCycle: billingCycle as BillingCycle,
      },
    });

    // Audit log
    await AuditLog.create({
      entityType: 'subscription',
      entityId: subscription._id,
      action: 'subscription.created',
      actorType: 'stripe',
      details: { tier, stripeSubscriptionId: stripeSubscription.id },
    });
  }

  // Generate license key (for the subscription's current tier)
  const { license, key } = await createLicense({
    customerId,
    tier: subscription.tier,
    subscriptionId: subscription._id.toString(),
  });

  // Send license key email
  const customer = await Customer.findById(customerId);
  if (customer) {
    await sendLicenseKeyEmail(customer.email, customer.firstName, key, subscription.tier);
  }

  logger.info(`Subscription created: ${subscription._id}, license: ${license._id}`);
}

/**
 * Handle subscription updated
 */
async function handleSubscriptionUpdated(stripeSubscription: Stripe.Subscription): Promise<void> {
  const subscription = await Subscription.findOne({
    stripeSubscriptionId: stripeSubscription.id,
  });

  if (!subscription) {
    logger.warn(`Subscription not found: ${stripeSubscription.id}`);
    return;
  }

  // Update subscription
  subscription.status = stripeSubscription.status as ISubscription['status'];
  subscription.currentPeriodStart = new Date(stripeSubscription.current_period_start * 1000);
  subscription.currentPeriodEnd = new Date(stripeSubscription.current_period_end * 1000);
  subscription.cancelAtPeriodEnd = stripeSubscription.cancel_at_period_end;

  if (stripeSubscription.canceled_at) {
    subscription.canceledAt = new Date(stripeSubscription.canceled_at * 1000);
  }

  // Plan changes (e.g. via the billing portal) switch the subscription's price
  const price = stripeSubscription.items.data[0]?.price;
  const plan = price ? getPlanForPriceId(price.id) : null;
  if (price && plan) {
    subscription.tier = plan.tier;
    subscription.metadata.priceId = price.id;
    subscription.metadata.productId =
      typeof price.product === 'string' ? price.product : price.product.id;
    subscription.metadata.billingCycle = plan.billingCycle;
  } else if (price) {
    logger.warn(`Unknown price ${price.id} on subscription ${stripeSubscription.id}, tier unchanged`);
  }

  await subscription.save();

  const license = await License.findOne({ subscriptionId: subscription._id });
  if (license) {
    license.tier = subscription.tier;

    if (stripeSubscription.cancel_at_period_end) {
      // Subscription will cancel: license expires at the end of the period
      license.expiresAt = subscription.currentPeriodEnd;
    } else if (
      subscription.isActive() ||
      subscription.status === SUBSCRIPTION_STATUS.PAST_DUE
    ) {
      // Not (or no longer) scheduled to cancel, e.g. the customer undid a
      // cancellation: drop the expiry set when it was scheduled
      license.expiresAt = undefined;
      if (license.status === LICENSE_STATUS.EXPIRED && subscription.isActive()) {
        license.status = LICENSE_STATUS.ACTIVE;
      }
    }

    await license.save();
  }

  logger.info(`Subscription updated: ${subscription._id}, tier: ${subscription.tier}, status: ${subscription.status}`);
}

/**
 * Handle subscription deleted (canceled)
 */
async function handleSubscriptionDeleted(stripeSubscription: Stripe.Subscription): Promise<void> {
  const subscription = await Subscription.findOne({
    stripeSubscriptionId: stripeSubscription.id,
  });

  if (!subscription) {
    logger.warn(`Subscription not found for deletion: ${stripeSubscription.id}`);
    return;
  }

  subscription.status = SUBSCRIPTION_STATUS.CANCELED;
  subscription.canceledAt = new Date();
  await subscription.save();

  // Expire the license
  await License.updateOne(
    { subscriptionId: subscription._id },
    {
      $set: {
        status: LICENSE_STATUS.EXPIRED,
        expiresAt: new Date(),
      },
    }
  );

  // Audit log
  await AuditLog.create({
    entityType: 'subscription',
    entityId: subscription._id,
    action: 'subscription.canceled',
    actorType: 'stripe',
  });

  logger.info(`Subscription canceled: ${subscription._id}`);
}

/**
 * Handle payment failed
 */
async function handlePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  if (!invoice.subscription) return;

  const subscription = await Subscription.findOne({
    stripeSubscriptionId: invoice.subscription as string,
  });

  if (!subscription) {
    logger.warn(`Subscription not found for failed payment: ${invoice.subscription}`);
    return;
  }

  subscription.status = SUBSCRIPTION_STATUS.PAST_DUE;
  await subscription.save();

  // Suspend the license
  const license = await License.findOne({ subscriptionId: subscription._id });
  if (license) {
    await suspendLicense(license._id.toString(), 'Payment failed');
  }

  // Send notification
  const customer = await Customer.findById(subscription.customerId);
  if (customer) {
    await sendPaymentFailedEmail(customer.email, customer.firstName);
  }

  logger.info(`Payment failed for subscription: ${subscription._id}`);
}

/**
 * Handle payment succeeded (reactivate if was past due)
 */
async function handlePaymentSucceeded(invoice: Stripe.Invoice): Promise<void> {
  if (!invoice.subscription) return;

  const subscription = await Subscription.findOne({
    stripeSubscriptionId: invoice.subscription as string,
  });

  if (!subscription || subscription.status !== SUBSCRIPTION_STATUS.PAST_DUE) {
    return;
  }

  subscription.status = SUBSCRIPTION_STATUS.ACTIVE;
  await subscription.save();

  // Reactivate the license
  const license = await License.findOne({ subscriptionId: subscription._id });
  if (license && license.status === LICENSE_STATUS.SUSPENDED) {
    await reactivateLicense(license._id.toString());
  }

  logger.info(`Payment succeeded, subscription reactivated: ${subscription._id}`);
}
