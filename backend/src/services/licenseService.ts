/**
 * License Service
 *
 * Validates the deployment's LICENSE_KEY against the CloudDesk license server
 * (POST {LICENSE_SERVER_URL}/api/licenses/validate), which issues keys through
 * Stripe checkout and is the only party that can vouch for them: keys carry no
 * offline-verifiable signature.
 *
 * - No key configured: Community tier.
 * - Key accepted: the tier, limits and features the license server reports.
 * - Key rejected (unknown, revoked, suspended, expired): Community tier.
 * - License server unreachable: keep the last successful validation for a grace
 *   period, then fall back to Community until it's reachable again.
 *
 * Validation runs at startup and then periodically; limit checks read the
 * in-memory result synchronously.
 */

import crypto from 'crypto';
import os from 'os';
import { env } from '../config/environment';
import { logger } from '../utils/logger';
import { LicenseState, LICENSE_STATE_ID } from '../models/LicenseState';

// License tiers and their features
export type LicenseTier = 'community' | 'team' | 'enterprise';

export interface LicenseInfo {
  tier: LicenseTier;
  valid: boolean;
  expiresAt: Date | null;
  maxUsers: number;
  maxInstances: number;
  maxConcurrentSessions: number;
  features: {
    sso: boolean;
    auditLogs: boolean;
    customBranding: boolean;
    prioritySupport: boolean;
    apiAccess: boolean;
    multiTenant: boolean;
  };
  organization?: string;
  email?: string;
}

// Community (free) tier limits
const COMMUNITY_LICENSE: LicenseInfo = {
  tier: 'community',
  valid: true,
  expiresAt: null,
  maxUsers: 5,
  maxInstances: 10,
  maxConcurrentSessions: 3,
  features: {
    sso: false,
    auditLogs: false,
    customBranding: false,
    prioritySupport: false,
    apiAccess: true,
    multiTenant: false,
  },
};

const TIERS: readonly LicenseTier[] = ['community', 'team', 'enterprise'];

/** How often a configured key is re-validated */
const REVALIDATE_INTERVAL_MS = 12 * 60 * 60 * 1000;
/** How long a previous successful validation is trusted while the license server is unreachable */
const OFFLINE_GRACE_PERIOD_MS = 14 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;

/** What the license server's validate endpoint returns in `data` */
export interface LicenseValidation {
  valid: boolean;
  tier: string;
  expiresAt: string | null;
  limits: {
    maxUsers: number;
    maxInstances: number;
    maxConcurrentSessions: number;
  };
  features?: Partial<LicenseInfo['features']>;
  organization?: string;
  validatedAt?: string;
}

export interface StoredLicenseState {
  instanceId: string;
  keyHash?: string;
  validation?: LicenseValidation;
  validatedAt?: Date;
}

export interface LicenseStateStore {
  load(): Promise<StoredLicenseState | null>;
  save(state: StoredLicenseState): Promise<void>;
}

export interface LicenseServiceConfig {
  licenseKey: () => string;
  serverUrl: () => string;
  store: LicenseStateStore;
  now?: () => number;
}

/** The license server looked at the key and said no (as opposed to being unreachable) */
export class LicenseRejectedError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'LicenseRejectedError';
  }
}

const mongoLicenseStateStore: LicenseStateStore = {
  async load() {
    const doc = await LicenseState.findById(LICENSE_STATE_ID).lean();
    if (!doc) return null;
    return {
      instanceId: doc.instanceId,
      keyHash: doc.keyHash,
      validation: doc.validation as unknown as LicenseValidation | undefined,
      validatedAt: doc.validatedAt,
    };
  },
  async save(state) {
    await LicenseState.updateOne(
      { _id: LICENSE_STATE_ID },
      { $set: { ...state, validation: state.validation as unknown as Record<string, unknown> | undefined } },
      { upsert: true }
    );
  },
};

const hashKey = (key: string): string => crypto.createHash('sha256').update(key).digest('hex');

const toLimit = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

export class LicenseService {
  private current: LicenseInfo = { ...COMMUNITY_LICENSE };
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly config: LicenseServiceConfig) {
    this.now = config.now ?? Date.now;
  }

  /**
   * Validate the configured key and schedule periodic re-validation. Call once
   * the database is connected. Never throws: licensing problems degrade to the
   * Community tier instead of stopping the server.
   */
  async initialize(): Promise<void> {
    await this.refresh();

    if (this.config.licenseKey().trim() && !this.timer) {
      this.timer = setInterval(() => {
        void this.refresh();
      }, REVALIDATE_INTERVAL_MS);
      this.timer.unref();
    }
  }

  /**
   * Stop periodic re-validation
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Re-validate the configured key now
   */
  async refresh(): Promise<LicenseInfo> {
    const key = this.config.licenseKey().trim();
    if (!key) {
      this.current = { ...COMMUNITY_LICENSE };
      logger.info('No license key configured, using the Community tier');
      return this.current;
    }

    let state: StoredLicenseState;
    try {
      state = (await this.config.store.load()) ?? { instanceId: crypto.randomUUID() };
    } catch (error) {
      logger.error('Could not load stored license state:', error);
      state = { instanceId: crypto.randomUUID() };
    }

    const keyHash = hashKey(key);

    try {
      const validation = await this.requestValidation(key, state.instanceId);
      this.current = this.fromValidation(validation);
      await this.saveState({ instanceId: state.instanceId, keyHash, validation, validatedAt: new Date(this.now()) });
      logger.info('License validated', { tier: this.current.tier, expiresAt: this.current.expiresAt });
    } catch (error) {
      if (error instanceof LicenseRejectedError) {
        this.current = { ...COMMUNITY_LICENSE, valid: false };
        await this.saveState({ instanceId: state.instanceId });
        logger.warn('License key rejected by the license server, using the Community tier', {
          code: error.code,
          reason: error.message,
        });
        return this.current;
      }

      const cachedAt = state.validatedAt ? new Date(state.validatedAt).getTime() : 0;
      const cacheUsable =
        state.keyHash === keyHash && state.validation && this.now() - cachedAt < OFFLINE_GRACE_PERIOD_MS;

      if (cacheUsable && state.validation) {
        this.current = this.fromValidation(state.validation);
        logger.warn('License server unreachable, using the last successful validation', {
          validatedAt: state.validatedAt,
          error: error instanceof Error ? error.message : String(error),
        });
      } else {
        this.current = { ...COMMUNITY_LICENSE, valid: false };
        logger.error('Could not validate the license key, using the Community tier until the license server is reachable', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return this.current;
  }

  private async requestValidation(licenseKey: string, instanceId: string): Promise<LicenseValidation> {
    const url = `${this.config.serverUrl().replace(/\/+$/, '')}/api/licenses/validate`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey, instanceId, hostname: os.hostname() }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const body = (await response.json().catch(() => null)) as {
      success?: boolean;
      data?: LicenseValidation;
      error?: { message?: string; code?: string };
    } | null;

    if (response.ok && body?.success && body.data?.valid) {
      return body.data;
    }

    // 4xx (other than rate limiting) with an error code is a verdict on the key itself
    if (response.status >= 400 && response.status < 500 && response.status !== 429 && body?.error?.code) {
      throw new LicenseRejectedError(body.error.message || 'License key rejected', body.error.code);
    }

    throw new Error(`License server responded with HTTP ${response.status}`);
  }

  private fromValidation(validation: LicenseValidation): LicenseInfo {
    const tier = TIERS.includes(validation.tier as LicenseTier) ? (validation.tier as LicenseTier) : 'community';
    const expiresAt = validation.expiresAt ? new Date(validation.expiresAt) : null;

    if (expiresAt && expiresAt.getTime() < this.now()) {
      return { ...COMMUNITY_LICENSE, valid: false, organization: validation.organization };
    }

    return {
      tier,
      valid: true,
      expiresAt,
      maxUsers: toLimit(validation.limits?.maxUsers, COMMUNITY_LICENSE.maxUsers),
      maxInstances: toLimit(validation.limits?.maxInstances, COMMUNITY_LICENSE.maxInstances),
      maxConcurrentSessions: toLimit(
        validation.limits?.maxConcurrentSessions,
        COMMUNITY_LICENSE.maxConcurrentSessions
      ),
      features: { ...COMMUNITY_LICENSE.features, ...validation.features },
      organization: validation.organization,
    };
  }

  private async saveState(state: StoredLicenseState): Promise<void> {
    try {
      await this.config.store.save(state);
    } catch (error) {
      logger.error('Could not store license state:', error);
    }
  }

  /**
   * Get current license info
   */
  getLicense(): LicenseInfo {
    return this.current;
  }

  /**
   * Check if a specific feature is enabled
   */
  hasFeature(feature: keyof LicenseInfo['features']): boolean {
    return this.current.features[feature];
  }

  /**
   * Check if user count is within limits
   */
  canAddUser(currentUserCount: number): boolean {
    const { maxUsers } = this.current;
    return maxUsers === -1 || currentUserCount < maxUsers;
  }

  /**
   * Check if instance count is within limits
   */
  canAddInstance(currentInstanceCount: number): boolean {
    const { maxInstances } = this.current;
    return maxInstances === -1 || currentInstanceCount < maxInstances;
  }

  /**
   * Check if session count is within limits
   */
  canStartSession(currentSessionCount: number): boolean {
    const { maxConcurrentSessions } = this.current;
    return maxConcurrentSessions === -1 || currentSessionCount < maxConcurrentSessions;
  }

  /**
   * Get license summary for admin dashboard
   */
  getLicenseSummary(): {
    tier: LicenseTier;
    valid: boolean;
    expiresAt: string | null;
    organization: string | null;
    limits: {
      users: string;
      instances: string;
      sessions: string;
    };
    features: string[];
  } {
    const license = this.current;

    const formatLimit = (limit: number) => limit === -1 ? 'Unlimited' : limit.toString();

    const enabledFeatures = Object.entries(license.features)
      .filter(([, enabled]) => enabled)
      .map(([feature]) => feature);

    return {
      tier: license.tier,
      valid: license.valid,
      expiresAt: license.expiresAt?.toISOString() || null,
      organization: license.organization || null,
      limits: {
        users: formatLimit(license.maxUsers),
        instances: formatLimit(license.maxInstances),
        sessions: formatLimit(license.maxConcurrentSessions),
      },
      features: enabledFeatures,
    };
  }
}

// Export singleton instance
export const licenseService = new LicenseService({
  licenseKey: () => env.LICENSE_KEY,
  serverUrl: () => env.LICENSE_SERVER_URL,
  store: mongoLicenseStateStore,
});

export default licenseService;
